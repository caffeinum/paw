/**
 * GitHub identity for paw agents (2026-11-24): the org a space's agents live in, and per-agent GitHub Apps
 * so an agent's `gh` and `git` act as `<slug>[bot]` instead of the operator. docs/notes/messaging.md#github-apps.
 *
 * The operator creates each App by hand (the steps are in the note) and registers it with
 * `paw github app set <agent> --app-id N --installation-id N --key <pem>`. paw then:
 *   - keeps the private key at `$PAW_HOME/secrets/github-apps/<agent>.pem` (0600) — never printed, never
 *     copied anywhere an agent can read it;
 *   - mints an installation token (RS256 JWT → `POST /app/installations/{id}/access_tokens`, 1h) on every keeper
 *     tick that finds it within {@link REMINT_AHEAD_MS} of expiry, and writes ONLY the token into the agent's
 *     token dir: `$PAW_HOME/github-apps/<agent>/` for a host agent, `<its VM home>/.paw-github/` for a sandboxed
 *     one (the home is already mounted at /root);
 *   - gives the agent a claude settings file (persona `claudeArgs: --settings <file>`) whose `env` points
 *     `gh` at a config dir holding the token (GH_CONFIG_DIR: gh reads hosts.yml on every run, so a re-minted
 *     token is picked up with no restart), points git's credential helper for github.com at the token file
 *     (earlier helpers reset, ssh remotes rewritten to https), and sets the commit author/committer to the bot.
 *
 * Machine config: `$PAW_HOME/github-config.json` = `{ org?, apps: { <agent>: AppConfig } }`.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "./lock.ts";
import { SANDBOX_HOME_MOUNT, sandboxHomeDir } from "./sandbox.ts";

const pawHomeDir = (): string => process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
export const configPath = (): string => join(pawHomeDir(), "github-config.json");
export const keyPathFor = (agent: string): string => join(pawHomeDir(), "secrets", "github-apps", `${agent}.pem`);

/** A token this close to expiry is re-minted (tokens live 60 minutes; the keeper ticks every 60s). */
export const REMINT_AHEAD_MS = 15 * 60_000;
const AGENT = /^[A-Za-z0-9_-]+$/;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const ID = /^[1-9]\d*$/;

export interface AppConfig {
  /** The space whose persona was wired (`claudeArgs: --settings …`). */
  space: string;
  appId: string;
  installationId: string;
  /** From `GET /app` at registration: the bot is `<slug>[bot]`. */
  slug: string;
  /** From `GET /users/<slug>[bot]`: the noreply email is `<botId>+<slug>[bot]@users.noreply.github.com`. */
  botId: number;
  /** Where the agent's token files live; "host" or "sandbox" (its VM home). */
  where: "host" | "sandbox";
}
export interface GithubConfig {
  org?: string;
  apps: Record<string, AppConfig>;
  /** `paw github forward on`: this machine runs `gh webhook forward` for `org`, in the mailbox of `space`. */
  forward?: { space: string };
}

export function readConfig(): GithubConfig {
  const p = configPath();
  if (!existsSync(p)) return { apps: {} };
  const c = JSON.parse(readFileSync(p, "utf8")) as Partial<GithubConfig>;
  if (typeof c.apps !== "object" || !c.apps || (c.org !== undefined && typeof c.org !== "string") || (c.forward !== undefined && typeof c.forward?.space !== "string"))
    throw new Error(`paw github: ${p} is not a {org?, apps, forward?} config — fix or remove it`);
  return c as GithubConfig;
}

export function updateConfig<T>(fn: (c: GithubConfig) => T): T {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  return withFileLock(`${p}.lock`, () => {
    const c = readConfig();
    const out = fn(c);
    atomicWrite(p, JSON.stringify(c, null, 2) + "\n", 0o644);
    return out;
  });
}

export function assertOrg(org: string): string {
  if (!ORG.test(org)) throw new Error(`paw github: "${org}" is not a GitHub organization name`);
  return org;
}

/** The org teams live in: `--org`, else the configured one, else a loud refusal. */
export function orgOrThrow(flag?: string): string {
  if (flag) return assertOrg(flag);
  const org = readConfig().org;
  if (!org) throw new Error("paw github: no organization set — `paw github org <org>` once (e.g. firegoat-ai), or pass --org");
  return org;
}

export const botLogin = (a: Pick<AppConfig, "slug">): string => `${a.slug}[bot]`;
export const botEmail = (a: Pick<AppConfig, "slug" | "botId">): string => `${a.botId}+${a.slug}[bot]@users.noreply.github.com`;

function atomicWrite(path: string, text: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------------------------------
// The key and the JWT

/** Read an App's private key; the error names the file, never its content. */
export function loadKey(path: string): KeyObject {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`paw github: can't read the App key ${path} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`paw github: ${path} is not a PEM private key (the .pem GitHub's "Generate a private key" downloads)`);
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error(`paw github: ${path} is a ${key.asymmetricKeyType} key — a GitHub App key is RSA`);
  return key;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The App's JWT (RS256, 9 minutes, backdated 60s for clock drift — GitHub's own recipe). */
export function appJwt(appId: string, key: KeyObject, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------------------------------
// HTTP (the App's own credentials: never the operator's gh login)

export type Http = (method: string, path: string, auth: string, body?: unknown) => Promise<unknown>;

export function apiBase(): string {
  return (process.env.PAW_GITHUB_API?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

/** fetch against the GitHub REST API; any non-2xx throws with GitHub's own message. */
export const githubHttp: Http = async (method, path, auth, body) => {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "paw",
      Authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}, not JSON`);
  }
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(json as { message?: string } | undefined)?.message ?? ""}`.trim());
  return json;
};

export interface Minted {
  token: string;
  expiresAt: string;
}

export async function mintToken(a: Pick<AppConfig, "appId" | "installationId">, key: KeyObject, http: Http = githubHttp): Promise<Minted> {
  const r = (await http("POST", `/app/installations/${a.installationId}/access_tokens`, appJwt(a.appId, key))) as { token?: string; expires_at?: string };
  if (!r?.token || !r.expires_at) throw new Error(`GitHub minted no token for installation ${a.installationId} (no token/expires_at in the answer)`);
  return { token: r.token, expiresAt: r.expires_at };
}

/** Who the App is (`GET /app`) and its bot user's id (`GET /users/<slug>[bot]`). */
export async function appIdentity(appId: string, installationId: string, key: KeyObject, http: Http = githubHttp): Promise<{ slug: string; botId: number; minted: Minted }> {
  const app = (await http("GET", "/app", appJwt(appId, key))) as { slug?: string; id?: number };
  if (!app?.slug) throw new Error("GitHub's GET /app answered without a slug");
  if (String(app.id) !== appId) throw new Error(`the key belongs to App ${app.id} (${app.slug}), not App ${appId}`);
  const minted = await mintToken({ appId, installationId }, key, http);
  const bot = (await http("GET", `/users/${encodeURIComponent(`${app.slug}[bot]`)}`, minted.token)) as { id?: number };
  if (typeof bot?.id !== "number") throw new Error(`GitHub has no user ${app.slug}[bot]`);
  return { slug: app.slug, botId: bot.id, minted };
}

// ---------------------------------------------------------------------------------------------------
// The agent's token dir

export interface TokenDir {
  /** On this machine. */
  host: string;
  /** As the agent sees it (the same for a host agent; under /root in its VM). */
  agent: string;
}

export function tokenDir(agent: string, where: AppConfig["where"]): TokenDir {
  if (where === "host") {
    const d = join(pawHomeDir(), "github-apps", agent);
    return { host: d, agent: d };
  }
  return { host: join(sandboxHomeDir(agent), ".paw-github"), agent: `${SANDBOX_HOME_MOUNT}/.paw-github` };
}

export const settingsFile = (d: TokenDir) => ({ host: join(d.host, "claude-settings.json"), agent: `${d.agent}/claude-settings.json` });

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The env a claude seat gets through `--settings`: static values pointing at files the keeper keeps fresh. */
export function agentEnv(a: Pick<AppConfig, "slug" | "botId">, d: TokenDir): Record<string, string> {
  const name = botLogin(a);
  const email = botEmail(a);
  const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$(cat ${shq(`${d.agent}/token`)})"; }; f`;
  const cfg: [string, string][] = [
    ["credential.https://github.com.helper", ""], // reset: the operator's keychain / gh helper must not answer first
    ["credential.https://github.com.helper", helper],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  return {
    GH_CONFIG_DIR: `${d.agent}/gh`,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_COUNT: String(cfg.length),
    ...Object.fromEntries(cfg.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
}

/** gh's own files: `version: "1"` marks the multi-account migration done, so gh never rewrites hosts.yml. */
function ghHosts(login: string, token: string): string {
  return `github.com:\n    users:\n        ${login}:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: ${login}\n`;
}

/** Write a freshly minted token (and the files built on it) into the agent's dir. Only the token goes in. */
export function writeToken(agent: string, a: AppConfig, m: Minted): TokenDir {
  const d = tokenDir(agent, a.where);
  if (a.where === "sandbox" && !existsSync(dirname(d.host)))
    throw new Error(`paw github: ${agent}'s sandbox home ${dirname(d.host)} does not exist yet — start it once (\`paw start ${agent}\`), then again`);
  mkdirSync(join(d.host, "gh"), { recursive: true, mode: 0o700 });
  chmodSync(d.host, 0o700);
  atomicWrite(join(d.host, "token"), `${m.token}\n`, 0o600);
  atomicWrite(join(d.host, "gh", "config.yml"), `version: "1"\ngit_protocol: https\n`, 0o600);
  atomicWrite(join(d.host, "gh", "hosts.yml"), ghHosts(botLogin(a), m.token), 0o600);
  atomicWrite(join(d.host, "token.json"), JSON.stringify({ expiresAt: m.expiresAt, login: botLogin(a) }) + "\n", 0o600);
  atomicWrite(settingsFile(d).host, JSON.stringify({ env: agentEnv(a, d) }, null, 2) + "\n", 0o600);
  return d;
}

/** When the token on disk expires (ms), or undefined (none yet / unreadable). */
export function tokenExpiry(agent: string, a: AppConfig): number | undefined {
  const f = join(tokenDir(agent, a.where).host, "token.json");
  if (!existsSync(f) || !existsSync(join(tokenDir(agent, a.where).host, "token"))) return undefined;
  const t = Date.parse((JSON.parse(readFileSync(f, "utf8")) as { expiresAt?: string }).expiresAt ?? "");
  return Number.isFinite(t) ? t : undefined;
}

/**
 * The keeper's step: every registered App whose token is missing or within {@link REMINT_AHEAD_MS} of expiry is
 * re-minted. Never throws; one line per failure (the caller says each once while unchanged).
 */
export async function refreshTokens(http: Http = githubHttp, now = Date.now()): Promise<{ minted: string[]; problems: string[] }> {
  const minted: string[] = [];
  const problems: string[] = [];
  let apps: Record<string, AppConfig>;
  try {
    apps = readConfig().apps;
  } catch (e) {
    return { minted, problems: [(e as Error).message] };
  }
  for (const [agent, a] of Object.entries(apps)) {
    try {
      const exp = tokenExpiry(agent, a);
      if (exp !== undefined && exp - now > REMINT_AHEAD_MS) continue;
      writeToken(agent, a, await mintToken(a, loadKey(keyPathFor(agent)), http));
      minted.push(agent);
    } catch (e) {
      problems.push(`app token for ${agent} (${a.slug}[bot]) NOT refreshed: ${(e as Error).message}`);
    }
  }
  return { minted, problems };
}

/**
 * Put the operator's downloaded key where paw keeps it (0600 in a 0700 dir). Returns the kept path. A key
 * already there is checked to be the same file content-wise only by parsing it; never printed.
 */
export function keepKey(agent: string, from: string): string {
  if (!AGENT.test(agent)) throw new Error(`paw github: "${agent}" is not an agent name`);
  const src = resolve(from);
  loadKey(src);
  const dst = keyPathFor(agent);
  mkdirSync(dirname(dirname(dst)), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dirname(dst)), 0o700);
  chmodSync(dirname(dst), 0o700);
  if (src !== dst) {
    copyFileSync(src, `${dst}.tmp`);
    chmodSync(`${dst}.tmp`, 0o600);
    renameSync(`${dst}.tmp`, dst);
  }
  chmodSync(dst, 0o600);
  if ((statSync(dst).mode & 0o077) !== 0) throw new Error(`paw github: couldn't make ${dst} private (0600)`);
  return dst;
}

/** `claudeArgs` with `--settings <file>` added; another `--settings` already there is refused, not replaced. */
export function withSettingsArg(args: string[], file: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = a === "--settings" ? args[i + 1] : a.startsWith("--settings=") ? a.slice("--settings=".length) : undefined;
    if (v === undefined) {
      out.push(a);
      continue;
    }
    if (v !== file) throw new Error(`paw github: its claudeArgs already pass --settings ${v} — claude reads one; merge that file's settings by hand or drop it`);
    if (a === "--settings") i++;
  }
  return [...out, "--settings", file];
}
