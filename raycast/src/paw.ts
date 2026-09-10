/**
 * The one place the extension talks to paw.
 *
 * It SHELLS OUT to the `paw` CLI rather than joining the mesh itself. That's deliberate: paw's peer
 * identity ("you") is a durable, single-consumer inbox, and a second process connecting under it would
 * contend with a live `paw chat`/`paw inbox` for the one durable slot cotal allows. Going through the
 * CLI means Raycast is just another reader of the same state — nothing to desync, nothing to starve.
 *
 * Raycast runs commands with a MINIMAL PATH (no shell rc, no nvm), so the paw launcher is invoked by
 * absolute path; the launcher itself already resolves bun/tsx absolutely, so it works from here.
 */
import { Clipboard, getPreferenceValues } from "@raycast/api";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** What Claude's Read tool can actually render — paw never promises a picture Read can't display. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

const run = promisify(execFile);

interface Prefs {
  pawPath?: string;
  space?: string;
}

/** `~/…` is what a human types in a preference field, but execFile does no tilde expansion. */
function expandTilde(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

/** The space this extension talks to — blank means paw's own default. Read-state is keyed on it. */
export function spaceKey(): string {
  return (getPreferenceValues<Prefs>().space ?? "").trim() || "default";
}

function config(): { bin: string; spaceArgs: string[] } {
  const prefs = getPreferenceValues<Prefs>();
  const bin = expandTilde((prefs.pawPath ?? "").trim() || `${homedir()}/.local/bin/paw`);
  const space = (prefs.space ?? "").trim();
  return { bin, spaceArgs: space ? ["--space", space] : [] };
}

/** The mesh state of one agent — exactly the row `paw status --json` emits, so the two cannot drift. */
export interface AgentRow {
  name: string;
  folder: string;
  /** idle | working | waiting | starting | offline */
  mesh: string;
  live: boolean;
  runtime?: string;
  pin?: string;
  sessionName?: string;
  durable: boolean;
  activeMs?: number;
  conflictPids: number[];
  inbox: { kind: string; queued?: number; unread?: number; detail?: string };
}

export interface StatusPayload {
  space: string;
  rows: AgentRow[];
  errors: string[];
}

export interface InboxMessage {
  from: string;
  text: string;
  ts: number;
  /** "in" = an agent messaged you, "out" = you messaged an agent. Present because we ask for both. */
  dir?: "in" | "out";
  /** Recipient of an OUTGOING message — the agent's name when paw could resolve it, else its raw id. */
  to?: string;
}

/**
 * Run a paw subcommand and parse its JSON.
 *
 * Errors are surfaced with paw's OWN stderr text, because that's where paw puts the actionable part
 * ("is the mesh up?", "manager isn't answering") — swallowing it for a generic "command failed" would
 * throw away the only useful signal.
 */
async function json<T>(args: string[], timeoutMs: number): Promise<T> {
  const { bin, spaceArgs } = config();
  let stdout: string;
  try {
    ({ stdout } = await run(bin, [...args, ...spaceArgs], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }));
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    if (err.code === "ENOENT") throw new Error(`paw not found at ${bin} — set the path in this extension's preferences`);
    throw new Error((err.stderr || "").trim() || err.message || "paw failed");
  }
  try {
    return JSON.parse(stdout) as T;
  } catch {
    // A non-JSON body means paw printed something we didn't expect — show it rather than a parse error.
    throw new Error(`paw returned unparseable output: ${stdout.slice(0, 300)}`);
  }
}

export async function fetchStatus(): Promise<StatusPayload> {
  return json<StatusPayload>(["status", "--json"], 20_000);
}

/**
 * Read the DM inbox WITHOUT advancing paw's shared "seen" cursor — polling from a GUI must never mark
 * things read out from under a terminal `paw inbox`/`paw chat`.
 *
 * The cursor comes back with the messages because it IS the read/unread line: anything newer is
 * unread. It's one marker shared by every paw surface, so reading in the terminal clears the badges
 * here, and vice versa — deliberately, since it's one inbox.
 */
export async function fetchInbox(limit = 200): Promise<{ cursor: number; messages: InboxMessage[] }> {
  // `--sent` widens the read to BOTH directions: a transcript of only the other side is half a
  // conversation, and reopening the chat would otherwise lose everything you had said.
  const p = await json<{ cursor: number; messages: InboxMessage[] }>(["inbox", "--json", "--sent", "--limit", String(limit)], 20_000);
  return { cursor: p.cursor ?? 0, messages: p.messages ?? [] };
}

/** Clear unread — the explicit verb, never a side effect of merely displaying messages. */
export async function markInboxRead(): Promise<void> {
  await json<unknown>(["inbox", "--json", "--mark-read"], 20_000);
}

/**
 * Fire-and-forget DM. paw spawns or wakes the agent if it isn't live, so this doubles as "start it".
 *
 * Attachments ride as EXTRA ARGV WORDS, which is `paw dm`'s existing contract: it peels absolute paths
 * out of the message words, stages them (copying out of ephemeral temp dirs so a reaped file can't
 * strand the agent) and rewrites them to `[Image #1]`. So the extension gets paw's whole attachment
 * pipeline for free and cannot drift from what the terminal does — no image bytes cross the mesh, just
 * a stable path the agent opens with Read.
 */
export async function sendDm(agent: string, text: string, attachments: string[] = []): Promise<void> {
  const { bin, spaceArgs } = config();
  try {
    await run(bin, ["dm", agent, text, ...attachments, ...spaceArgs], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error((err.stderr || "").trim() || err.message || "paw dm failed");
  }
}

/**
 * Pull an image off the clipboard and return an absolute path, or undefined if there isn't one.
 *
 * Two shapes, because macOS has two: a COPIED FILE puts a path on the pasteboard (Raycast surfaces it
 * as `file`), while a SCREENSHOT puts raw image DATA with no path at all. Raycast's API exposes no
 * image buffer, so the data case goes through osascript — the same thing terminals do internally when
 * a Cmd-V of image data has to become a file. Written under paw's own images dir, which is where paw
 * stages attachments anyway, so nothing lands in a temp dir that could be reaped mid-flight.
 */
export async function clipboardImagePath(): Promise<string | undefined> {
  const { file } = await Clipboard.read();
  if (file) {
    const path = file.startsWith("file://") ? fileURLToPath(file) : file;
    if (IMAGE_EXT.test(path) && existsSync(path)) return path;
  }
  const dir = join(homedir(), ".paw", "clipboard");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `clipboard-${Date.now()}.png`);
  // `the clipboard as «class PNGf»` throws when the pasteboard holds no image — that's the "nothing to
  // attach" signal, not an error worth surfacing.
  const script = `set f to (open for access POSIX file ${JSON.stringify(out)} with write permission)
try
  write (the clipboard as «class PNGf») to f
  close access f
on error e
  close access f
  error e
end try`;
  try {
    await run("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
  } catch {
    rmSync(out, { force: true });
    return undefined;
  }
  if (!existsSync(out) || statSync(out).size === 0) {
    rmSync(out, { force: true }); // a zero-byte file would be announced as an image the agent can't read
    return undefined;
  }
  return out;
}

/** Relative "last active", matching how `paw status` reads. */
export function ago(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** `/Users/me/x` → `~/x`, so a folder column stays readable at Raycast's width. */
export function tilde(p: string): string {
  const h = homedir();
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** The inbox-lag cell — `⚠ N unread` is the zombie detector: presence says idle but DMs aren't drained. */
export function inboxLabel(inbox: AgentRow["inbox"]): string | undefined {
  if (inbox.kind !== "lag") return undefined;
  const queued = inbox.queued ?? 0;
  const unread = inbox.unread ?? 0;
  if (queued + unread === 0) return undefined;
  return `${queued + unread} pending`;
}
