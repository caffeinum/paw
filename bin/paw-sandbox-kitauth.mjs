/**
 * A sandboxed kit agent's provider login (docs/notes/sandbox.md#kit-in-the-vm). Plain node ESM, no deps: the
 * launcher (./paw-sandbox-run.mjs) runs it in the manager's node, src/sandbox-kit.ts uses it for the CLI preflight.
 *
 * kit reads its bearer from FILES only and re-reads them on every call (kit auth/auth.go), so a renewed token
 * reaches a running seat only through a file — never an env var, which a live process can't be handed again.
 * The VM gets ONE provider's ACCESS token, never a refresh token and never the host's whole kit/codex/opencode
 * home: `<state>/kit-auth/auth.json` = `{"<provider>": {access, expires[, accountId]}}`, mounted read-only at
 * /paw/kit-auth, and the agent's `~/.kit/auth.json` (its KIT_HOME is /root/.kit) is a symlink to it. kit uses it
 * while it is valid; with no refresh token it can never rotate (and so log out) the host's login. The host
 * stays the one place that refreshes: the launcher runs the HOST kit (`kit models <p> --refresh`, which goes
 * through kit's own token source) when kit's own host login nears expiry, and re-mirrors the result.
 * A borrowed host login (codex's ~/.codex/auth.json, opencode's auth.json) is mirrored the same way and, as kit
 * itself does, never refreshed from here.
 *
 * The agent may log in for itself instead (`paw sandbox shell <n>#<s>` → `kit auth grok`): kit then replaces the
 * symlink with its own file, and paw leaves it alone from then on.
 *
 * Token values are never printed, logged, or put on an argv.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the mirror is mounted in the VM, and the agent's own kit store there (KIT_HOME=/root/.kit). */
export const KIT_AUTH_MOUNT = "/paw/kit-auth";
export const KIT_AUTH_VM_FILE = `${KIT_AUTH_MOUNT}/auth.json`;

/** kit's API provider names, from either spelling (kit auth.Canonical). */
export function kitApiProvider(name) {
  if (name === "codex" || name === "openai") return "openai";
  if (name === "grok" || name === "xai") return "xai";
  return undefined;
}
export function kitCliName(provider) {
  return { openai: "codex", xai: "grok" }[provider];
}

function jwtExpiryMs(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * The login the HOST kit would use for `provider` (`openai` | `xai`), in kit's own order: kit's store
 * (`$KIT_HOME|~/.kit/auth.json`, refreshable), else the borrowed codex / opencode file. `undefined` = none.
 * Throws on a store kit itself would refuse (unreadable JSON, group/other-readable).
 */
export function hostKitLogin(provider, env = process.env) {
  const home = env.HOME?.trim() || homedir();
  const store = join(env.KIT_HOME?.trim() || join(home, ".kit"), "auth.json");
  if (existsSync(store)) {
    if (statSync(store).mode & 0o077) throw new Error(`${store} is readable by others — chmod 600 it (kit refuses it too)`);
    let m;
    try {
      m = JSON.parse(readFileSync(store, "utf8"));
    } catch (e) {
      throw new Error(`${store} is not JSON (${e.message})`);
    }
    const t = m?.[provider];
    if (t?.access) return { access: t.access, expires: Number(t.expires) || 0, accountId: t.accountId, refreshable: !!t.refresh, origin: `kit's own login (${store})` };
  }
  if (provider === "openai") {
    const p = join(home, ".codex", "auth.json");
    if (!existsSync(p)) return undefined;
    const f = JSON.parse(readFileSync(p, "utf8"));
    if (f?.auth_mode !== "chatgpt" || !f.tokens?.access_token) return undefined;
    return { access: f.tokens.access_token, expires: jwtExpiryMs(f.tokens.access_token), accountId: f.tokens.account_id, refreshable: false, origin: `codex's login (${p})` };
  }
  if (provider === "xai") {
    const p = join(home, ".local", "share", "opencode", "auth.json");
    if (!existsSync(p)) return undefined;
    const x = JSON.parse(readFileSync(p, "utf8"))?.xai;
    if (x?.type !== "oauth" || !x.access) return undefined;
    return { access: x.access, expires: Number(x.expires) || 0, refreshable: false, origin: `opencode's login (${p})` };
  }
  throw new Error(`unknown kit provider "${provider}"`);
}

/** Write the mirror: ONE provider, access token + expiry (+ account id), no refresh token. 0600, atomic. */
export function writeKitAuthMirror(file, provider, login) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const entry = { access: login.access, expires: login.expires };
  if (login.accountId) entry.accountId = login.accountId;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ [provider]: entry })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** What the agent's own `~/.kit/auth.json` (host side: `<home>/.kit/auth.json`) is: `mirror` (paw's symlink),
 *  `own` (a file of its own — `kit auth` inside the VM), `absent`, or `other` (a symlink elsewhere). */
export function vmKitLogin(homeDir) {
  const f = join(homeDir, ".kit", "auth.json");
  let st;
  try {
    st = lstatSync(f);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return readlinkSync(f) === KIT_AUTH_VM_FILE ? "mirror" : "other";
  return st.isFile() ? "own" : "other";
}

/** The agent's own login names `provider` (read for the key only, never the value). */
export function vmOwnLoginHas(homeDir, provider) {
  try {
    return !!JSON.parse(readFileSync(join(homeDir, ".kit", "auth.json"), "utf8"))?.[provider]?.access;
  } catch {
    return false;
  }
}

/** Point the agent's `~/.kit/auth.json` at the mirror — only when it has no login file of its own. */
export function linkKitAuthMirror(homeDir) {
  const state = vmKitLogin(homeDir);
  if (state === "mirror" || state === "own") return state;
  if (state === "other") throw new Error(`${join(homeDir, ".kit", "auth.json")} is neither paw's mirror link nor a login file — remove it, or \`kit auth\` inside the VM`);
  mkdirSync(join(homeDir, ".kit"), { recursive: true, mode: 0o700 });
  symlinkSync(KIT_AUTH_VM_FILE, join(homeDir, ".kit", "auth.json"));
  return "mirror";
}

/** kit treats a token within 2 min of expiry as expired (kit auth/auth.go `margin`). */
const KIT_MARGIN_MS = 2 * 60_000;

/**
 * The launcher's side: mirror the host's login for `provider` into `mirror` now, and keep it fresh. When kit's OWN
 * host login (the only refreshable kind) is within `aheadMs` of expiry, run the HOST kit (`<hostBin> models <cli>
 * --refresh`: kit's own token source refreshes and saves it, exactly as a host kit agent would) — synchronously
 * before the first mirror, in the background after — and copy every change in. Never logs a token.
 * `die` for what makes the launch impossible (no login, a lapsed one nobody can refresh).
 */
export function startKitAuthMirror({ provider, mirror, hostBin, note, die, env = process.env }) {
  const cli = kitCliName(provider);
  if (!cli) die(`--kit-provider is openai|xai, not "${provider}"`);
  const num = (k, d) => (/^\d+$/.test(env[k] ?? "") ? Number(env[k]) : d);
  const pollMs = num("PAW_KIT_AUTH_POLL_MS", 5_000);
  const aheadMs = num("PAW_KIT_AUTH_AHEAD_MS", 10 * 60_000);
  const retryMs = num("PAW_KIT_AUTH_RETRY_MS", 2 * 60_000);
  const refreshArgv = ["models", cli, "--refresh"];
  const read = () => hostKitLogin(provider, env);
  let login;
  try {
    login = read();
  } catch (e) {
    die(`this machine's ${cli} login can't be read: ${e.message}`);
  }
  if (!login) die(`this machine has no ${cli} login to mirror into the sandbox — \`kit auth ${cli}\` on the host`);
  if (login.expires <= Date.now() + aheadMs && login.refreshable) {
    note(`kit auth: ${cli} login (${login.origin}) lapses soon — refreshing it on the host (${hostBin} ${refreshArgv.join(" ")})`);
    const r = spawnSync(hostBin, refreshArgv, { stdio: "ignore", timeout: 60_000, env });
    if (r.status !== 0) note(`kit auth: the host refresh failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`);
    login = read();
  }
  if (!login || login.expires <= Date.now() + KIT_MARGIN_MS)
    die(`this machine's ${cli} login (${login?.origin ?? "gone"}) has expired${login?.refreshable ? " and the host refresh did not renew it" : " — paw never refreshes another tool's login"}: \`kit auth ${cli}\` on the host`);
  writeKitAuthMirror(mirror, provider, login);
  note(`kit auth: ${cli} from ${login.origin}, expires ${new Date(login.expires).toISOString()} — mirrored (access token only)`);
  let seen = `${login.access.length}:${login.expires}:${login.access.slice(-12)}`;
  let lastTry = 0;
  let refreshing;
  let readErr = "";
  const timer = setInterval(() => {
    let cur;
    try {
      cur = read();
      readErr = "";
    } catch (e) {
      if (readErr !== e.message) note(`kit auth: can't read the host login (${e.message})`);
      readErr = e.message;
      return;
    }
    if (!cur) {
      if (readErr !== "gone") note(`kit auth: the host's ${cli} login is gone — the seat keeps the last mirrored token until it lapses`);
      readErr = "gone";
      return;
    }
    const key = `${cur.access.length}:${cur.expires}:${cur.access.slice(-12)}`;
    if (key !== seen) {
      try {
        writeKitAuthMirror(mirror, provider, cur);
        seen = key;
        note(`kit auth: ${cli} login renewed on the host — mirrored (expires ${new Date(cur.expires).toISOString()})`);
      } catch (e) {
        note(`kit auth: mirroring failed (${e.message})`);
      }
    }
    if (cur.refreshable && cur.expires <= Date.now() + aheadMs && !refreshing && Date.now() - lastTry >= retryMs) {
      lastTry = Date.now();
      note(`kit auth: ${cli} login lapses ${new Date(cur.expires).toISOString()} — refreshing it on the host`);
      refreshing = spawn(hostBin, refreshArgv, { stdio: "ignore", timeout: 60_000, env });
      refreshing.on("error", (e) => note(`kit auth: the host refresh failed (${e.message})`));
      refreshing.on("exit", (code, sig) => {
        if (code !== 0) note(`kit auth: the host refresh failed (${sig ?? `exit ${code}`})`);
        refreshing = undefined;
      });
    } else if (!cur.refreshable && cur.expires <= Date.now() + aheadMs && Date.now() - lastTry >= retryMs) {
      lastTry = Date.now();
      note(`kit auth: the ${cli} login borrowed from ${cur.origin} lapses ${new Date(cur.expires).toISOString()} and paw never refreshes another tool's login — run that tool, or \`kit auth ${cli}\` on the host`);
    }
  }, pollMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      refreshing?.kill("SIGTERM");
    },
  };
}
