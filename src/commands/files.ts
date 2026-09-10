/**
 * `paw files [--limit N] [--channel c] [--path-only] [--json]` — list the files endpoints have
 * shared onto the mesh, endpoint-native. A file-bridge endpoint (Telegram, etc.) announces each
 * inbound file on a dedicated `#files` channel: one multicast carrying a `data` part whose payload
 * is a FileEntry (name + ABSOLUTE local path + metadata). No bytes cross the mesh — only the path
 * rides in the message, so this reader NEVER hardcodes the endpoint's files dir; it just reads the
 * announcements and prints the paths for an agent (or you) to open with a Read tool.
 *
 * PURE READER, same observer shape as `paw history`: HUMAN_PEER card, registerPresence:false +
 * consume:false + watchPresence:false — it never binds a durable consumer, never appears in the
 * roster, just reads the channel backlog and exits.
 */
import { CotalEndpoint, DEFAULT_SERVER, assertValidChannel, registry, type Command, type CotalMessage } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { HUMAN_PEER } from "../names.js";
import { formatWhen } from "./history.js";
import { ago } from "../status.js";

/** How deep to read the channel backlog. cotal's channelHistory returns the OLDEST N, so to surface
 *  the NEWEST we fetch up to this many and take the tail (same cap + reason as src/history.ts). */
const FETCH_CAP = 10_000;

/** The default channel file-bridge endpoints announce inbound files on (a dedicated channel, NOT
 *  #general). Override with --channel. */
const DEFAULT_FILES_CHANNEL = "files";

// ── The wire contract (RE-DECLARED locally — paw imports ONLY @cotal-ai/core, never endpoint-core).
//    Both sides implement to this exactly; see the file-bridge endpoints. ──────────────────────────
/** The data-part discriminator that marks a mesh announcement as a shared file. */
const FILE_PART_PROTO = "ai.cotal.file";
/** The payload an announcement carries in its `data` part. `path` is ABSOLUTE + traversal-sanitized
 *  by the publishing endpoint; no bytes cross the mesh, only this metadata. */
interface FileEntry {
  v: 1;
  ts: number; // ms epoch
  name: string;
  path: string; // absolute, already traversal-sanitized
  size?: number;
  mime?: string;
  caption?: string;
  source: string; // provenance = the publishing endpoint's cfg.name
  chatId?: number;
}

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), red: wrap("31") };

/** Pull the FileEntry out of a mesh message, or undefined if it carries no `ai.cotal.file` data part.
 *  Pure + exported for tests — the sole place the wire discriminator is matched. */
export function extractFileEntry(m: CotalMessage): FileEntry | undefined {
  for (const p of m.parts ?? []) {
    if (p.kind === "data" && (p.data as { proto?: string } | undefined)?.proto === FILE_PART_PROTO) {
      return p.data as unknown as FileEntry;
    }
  }
  return undefined;
}

/** Human-readable byte size (`1.2 MB`, `840 KB`, `512 B`). "?" when the endpoint didn't report one —
 *  never a fabricated 0. Pure + exported for tests. */
export function formatSize(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Render one shared file for the human view: the headline line, the caption (if any), and a dim
 *  provenance/age line. `fromName` is the mesh sender's name (from the announcing message). Pure +
 *  exported for tests (entry-only callable). */
export function formatReceived(entry: FileEntry, fromName?: string, now: number = Date.now()): string {
  const head = `${c.dim(formatWhen(entry.ts, now))} ${c.bold(entry.name)} ${c.dim(`(${formatSize(entry.size)})`)} ${c.dim("·")} ${entry.path}`;
  const via = fromName && fromName !== entry.source ? `${entry.source}/${fromName}` : entry.source;
  const meta = c.dim(`  from ${via} · ${ago(entry.ts, now)} ago`);
  const lines = [head];
  if (entry.caption) lines.push(c.dim(`  “${entry.caption}”`));
  lines.push(meta);
  return lines.join("\n");
}

interface Args {
  channel?: string;
  limit: number;
  space?: string;
  server?: string;
  pathOnly: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 50, pathOnly: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--channel" || a === "-c") out.channel = argv[++i];
    else if (a === "--path-only" || a === "--paths") out.pathOnly = true;
    else if (a === "--json") out.json = true;
    else if (a === "--limit" || a === "-n") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("paw: --limit needs a positive integer");
      out.limit = n;
    } else throw new Error(`paw: unknown argument "${a}" — files [--limit N] [--channel c] [--path-only] [--json] [--space <s>]`);
  }
  return out;
}

async function files(argv: string[]): Promise<void> {
  const { channel: channelArg, limit, space: spaceArg, server: serverArg, pathOnly, json } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;
  const channel = channelArg ?? DEFAULT_FILES_CHANNEL;
  assertValidChannel(channel);

  if (pathOnly && json) throw new Error("paw: --path-only and --json are mutually exclusive");

  // Observer endpoint, mirrored from src/commands/history.ts: connect as the stable "you", but a pure
  // reader — no presence, no durable consumer bind, no roster watch.
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({ space, servers: server, creds, card, registerPresence: false, consume: false, watchPresence: false });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    const msgs = await ep.channelHistory(channel, { limit: FETCH_CAP });
    // Keep only the file announcements, pairing each FileEntry with its mesh sender's name.
    const shared = msgs
      .map((m) => ({ entry: extractFileEntry(m), from: m.from.name }))
      .filter((x): x is { entry: FileEntry; from: string } => x.entry !== undefined);
    const shown = shared.slice(-limit);

    if (json) {
      console.log(JSON.stringify(shown.map((x) => x.entry), null, 2));
      return;
    }
    if (pathOnly) {
      for (const x of shown) console.log(x.entry.path);
      return;
    }
    if (!shown.length) {
      console.log(c.dim(`no files shared on #${channel} yet`));
      return;
    }
    const more = shared.length > shown.length ? c.dim(` (of ${shared.length})`) : "";
    console.log(c.dim(`# #${channel} · last ${shown.length} file${shown.length === 1 ? "" : "s"}${more} · oldest first`));
    for (const x of shown) console.log(formatReceived(x.entry, x.from));
  } finally {
    await ep.stop().catch(() => {});
  }
}

const filesCommand: Command = {
  kind: "command",
  name: "files",
  group: "Mesh",
  summary: "list files endpoints have shared on #files (name · size · absolute path) — files [--limit N] [--channel c] [--path-only] [--json]",
  usage: "files [--limit N] [--channel c] [--path-only] [--json] [--space <s>]   (reads the #files channel; --path-only prints bare abs paths to pipe into Read/xargs)",
  run: (a) => files([...a.raw]),
};

registry.register(filesCommand);
