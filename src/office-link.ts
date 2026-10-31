/**
 * The per-space link to an agent-office (`paw office connect`) and the bridge's per-agent tokens.
 *
 *   $PAW_HOME/spaces/<space>/office.json         { space, url, office, joinKey, ownerKey?, viewKey?, ts }
 *   $PAW_HOME/spaces/<space>/office-agents.json  { office, agents: { <paw name>: { id, token, joinedAt, since? } }, lastHuman? }
 *
 * Both 0600, written atomically (tmp + rename), beside the space's other paw state so an isolated
 * PAW_HOME isolates them. Every key and agentToken is a BEARER secret: nothing here prints one, and
 * `describeLink` is the only rendering. The link is written by the CLI; the tokens file only by the
 * bridge (one writer each), and `paw office disconnect` removes both.
 *
 * Zero cotal imports: the CLI, the bridge and paw web all read it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OfficeLink {
  space: string;
  /** Origin of the agent-office deployment (`https://office.example.com`, `http://127.0.0.1:8790`). */
  url: string;
  /** The office id every key is prefixed with. */
  office: string;
  joinKey: string;
  ownerKey?: string;
  viewKey?: string;
  ts: string;
}

export interface BridgedAgent {
  /** The office's agent id (what `office_chat_send {to}` names). */
  id: string;
  token: string;
  joinedAt: number;
  /** Office chat to this agent already delivered as paw DMs, up to here (the office's clock, epoch ms).
   *  Absent until the first read, which then uses the office's own unread cursor. */
  since?: number;
}

export interface BridgeState {
  office: string;
  agents: Record<string, BridgedAgent>;
  /** The office human who last wrote to any paw agent — where an agent's reply to "you" goes. */
  lastHuman?: string;
}

const KEY_RE = /^([a-z0-9]{12})\.[A-Za-z0-9_-]{43}$/;

function stateRoot(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

export function officeLinkPath(space: string): string {
  return join(stateRoot(), "spaces", space, "office.json");
}

export function bridgeStatePath(space: string): string {
  return join(stateRoot(), "spaces", space, "office-agents.json");
}

/** The office id a key routes to. A malformed key throws — naming the flag, never echoing the key. */
export function officeOfKey(key: string, flag: string): string {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`paw: ${flag} is not an agent-office key (expected <officeId>.<secret>, as \`agent-office create\` prints)`);
  return m[1]!;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** An http(s) origin. Plain http only to loopback: the join key is a bearer secret and must not cross a network in clear. */
export function checkOfficeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`paw: --url "${raw}" is not a URL — expected the agent-office base URL, e.g. https://office.example.com`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`paw: --url must be http(s):// (got ${u.protocol})`);
  if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) throw new Error(`paw: --url ${u.origin} is plain http to a non-loopback host — use https (the join key is a bearer secret)`);
  if (u.username || u.password) throw new Error("paw: --url must not embed credentials — pass keys with --join-key/--owner-key");
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) throw new Error(`paw: --url must be the bare base URL (${u.origin}), not a page or API path`);
  return u.origin;
}

/** Build a link from CLI input: every key must route to the SAME office. */
export function makeLink(space: string, url: string, keys: { joinKey: string; ownerKey?: string; viewKey?: string }): OfficeLink {
  const origin = checkOfficeUrl(url);
  const office = officeOfKey(keys.joinKey, "--join-key");
  for (const [flag, key] of [["--owner-key", keys.ownerKey], ["--view-key", keys.viewKey]] as const) {
    if (key !== undefined && officeOfKey(key, flag) !== office) throw new Error(`paw: ${flag} belongs to a different office than --join-key`);
  }
  return {
    space,
    url: origin,
    office,
    joinKey: keys.joinKey,
    ...(keys.ownerKey ? { ownerKey: keys.ownerKey } : {}),
    ...(keys.viewKey ? { viewKey: keys.viewKey } : {}),
    ts: new Date().toISOString(),
  };
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function parseLink(space: string, path: string, raw: string): OfficeLink {
  let v: Partial<OfficeLink>;
  try {
    v = JSON.parse(raw) as Partial<OfficeLink>;
  } catch (e) {
    throw new Error(`paw: office link ${path} is not JSON (${(e as Error).message}) — \`paw office disconnect --space ${space}\` and connect again`);
  }
  if (typeof v !== "object" || v === null || v.space !== space || typeof v.url !== "string" || typeof v.office !== "string" || typeof v.joinKey !== "string" || typeof v.ts !== "string")
    throw new Error(`paw: office link ${path} is malformed (needs space="${space}", url, office, joinKey, ts) — \`paw office disconnect --space ${space}\` and connect again`);
  const link = makeLink(space, v.url, { joinKey: v.joinKey, ownerKey: v.ownerKey, viewKey: v.viewKey });
  if (link.office !== v.office) throw new Error(`paw: office link ${path} names office ${v.office} but its join key routes to ${link.office}`);
  return { ...link, ts: v.ts };
}

/** The space's office link, or undefined when none is connected. An unreadable link throws. */
export function readOfficeLink(space: string): OfficeLink | undefined {
  const path = officeLinkPath(space);
  if (!existsSync(path)) return undefined;
  return parseLink(space, path, readFileSync(path, "utf8"));
}

export function writeOfficeLink(link: OfficeLink): string {
  const path = officeLinkPath(link.space);
  writePrivate(path, link);
  return path;
}

/** Remove the link and the bridge tokens. Returns whether a link existed. */
export function removeOfficeLink(space: string): boolean {
  const path = officeLinkPath(space);
  const had = existsSync(path);
  rmSync(path, { force: true });
  rmSync(bridgeStatePath(space), { force: true });
  return had;
}

/** Bridge tokens for `office`. A file for another office (re-connected elsewhere) or none ⇒ a fresh state. */
export function readBridgeState(space: string, office: string): BridgeState {
  const path = bridgeStatePath(space);
  const fresh: BridgeState = { office, agents: {} };
  if (!existsSync(path)) return fresh;
  let v: Partial<BridgeState>;
  try {
    v = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeState>;
  } catch (e) {
    throw new Error(`paw: office bridge state ${path} is not JSON (${(e as Error).message}) — delete it; the bridge rejoins every agent`);
  }
  if (v.office !== office) return fresh;
  if (typeof v.agents !== "object" || v.agents === null || Object.values(v.agents).some((a) => typeof a?.id !== "string" || typeof a.token !== "string"))
    throw new Error(`paw: office bridge state ${path} is malformed — delete it; the bridge rejoins every agent`);
  return { office, agents: v.agents, ...(typeof v.lastHuman === "string" ? { lastHuman: v.lastHuman } : {}) };
}

export function writeBridgeState(space: string, state: BridgeState): void {
  writePrivate(bridgeStatePath(space), state);
}

/** What the viewer embed opens: the owner key (chat + edits) else the view key; none ⇒ undefined. */
export function viewerUrl(link: OfficeLink): string | undefined {
  const key = link.ownerKey ?? link.viewKey;
  return key ? `${link.url}/o/${link.office}#k=${encodeURIComponent(key)}` : undefined;
}

/** A link rendered for humans — keys reduced to which ones are stored, never their values. */
export function describeLink(link: OfficeLink): string {
  const keys = ["join", ...(link.ownerKey ? ["owner"] : []), ...(link.viewKey ? ["view"] : [])].join(", ");
  return `${link.url}/o/${link.office} (keys stored: ${keys}; since ${link.ts})`;
}

/** What paw web's ~office renders: the viewer to embed, or the exact command that would connect one. */
export type OfficeEmbed =
  | { space: string; connected: false; command: string; error?: string }
  | { space: string; connected: true; office: string; url: string; src?: string; readOnly: boolean; command?: string };

export function officeEmbed(space: string): OfficeEmbed {
  const command = `paw office connect --space ${space} --url <agent-office url> --join-key <joinKey> --owner-key <ownerKey>`;
  let link: OfficeLink | undefined;
  try {
    link = readOfficeLink(space);
  } catch (e) {
    return { space, connected: false, command, error: (e as Error).message };
  }
  if (!link) return { space, connected: false, command };
  const src = viewerUrl(link);
  return { space, connected: true, office: link.office, url: link.url, ...(src ? { src } : { command }), readOnly: !link.ownerKey };
}
