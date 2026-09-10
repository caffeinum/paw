/**
 * `paw inbox [--history] [--limit N]` — read the human peer's ("you") direct-message inbox without
 * opening the chat REPL. The READ half of the async loop: `paw dm @agent "task"`, walk away, then
 * `paw inbox` to collect the reply / PR link / clarifying question the agent sent back (the persistent
 * "you" mailbox beacon, src/mailbox.ts, keeps you reachable so the reply lands in your durable inbox).
 *
 * It is a PURE READER: it reads the DM stream directly (a throwaway, non-acking consumer) and NEVER
 * binds the durable inbox consumer — so it never contends with a live `paw chat` (cotal allows only one
 * active consumer on "you"'s durable inbox; a reader that bound it would starve chat, and chat would
 * starve it). "New since last time" is tracked by a LOCAL cursor file, not by acking.
 *
 *   - default  — messages newer than the local read-cursor, then advance the cursor. "What's new."
 *   - --history — the most recent N (default 50) to you, cursor untouched. "Show me the backlog."
 *   - --watch  — a live foreground tail (poll, like `log --follow`): print DMs as they arrive and
 *                advance the shared cursor past each. Ctrl-C to exit. Still a pure reader (no durable bind).
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { advanceCursor, readCursor } from "./cursor.js";
import { observerEndpoint, pollLoop, readConversation, type Entry } from "./feed.js";
import { resolveSpace } from "./lifecycle.js";
import { HUMAN_PEER } from "./names.js";
import { writeJson } from "./stdout.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), magenta: wrap("35"), red: wrap("31") };

/** A dim " (Nh ago)" suffix so a queued reply never reads as if it just arrived. "" if fresh. */
function agoTag(ts: number): string {
  const ms = Date.now() - ts;
  if (!Number.isFinite(ts) || ms < 60_000) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return c.dim(` (${m}m ago)`);
  const h = Math.floor(m / 60);
  if (h < 24) return c.dim(` (${h}h ago)`);
  return c.dim(` (${Math.floor(h / 24)}d ago)`);
}

function render(e: Entry): string {
  return `${c.magenta("(DM)")} ${c.bold(e.from)}${agoTag(e.ts)} ${c.dim("→ you:")} ${e.text}`;
}

function parseArgs(argv: string[]): { space?: string; server?: string; history: boolean; limit: number; watch: boolean; json: boolean; markRead: boolean; sent: boolean } {
  const out: { space?: string; server?: string; history: boolean; limit: number; watch: boolean; json: boolean; markRead: boolean; sent: boolean } = { history: false, limit: 50, watch: false, json: false, markRead: false, sent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--history" || a === "--all" || a === "-a") out.history = true;
    else if (a === "--watch" || a === "-w") out.watch = true;
    else if (a === "--json") out.json = true;
    else if (a === "--mark-read") out.markRead = true;
    else if (a === "--sent") out.sent = true;
    else if (a === "--limit" || a === "-n") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("paw: --limit needs a positive integer");
      out.limit = n;
    }
    else throw new Error(`paw: unknown argument "${a}" — inbox takes [--history] [--watch] [--json] [--mark-read] [--sent] [--limit N] [--space <s>]`);
  }
  return out;
}

const POLL_MS = 2000; // how often --watch re-reads the DM stream (mirrors `log --follow`'s polling)

/**
 * Live foreground tail: poll the pure-reader path (non-acking, no durable bind) and print DMs as they
 * arrive. Ctrl-C to exit.
 *
 * IT KEEPS ITS OWN HIGH-WATER MARK rather than gating on the shared read-cursor, and that distinction
 * is the whole behaviour. The cursor answers "what haven't I read?", which every surface shares — so a
 * `paw chat` open in another tab displays a DM, advances the cursor past it, and a cursor-gated tail
 * then has nothing left to show. It sits there silent while mail is visibly arriving next door. (Seen
 * live, reported as a bug, and it was one.)
 *
 * A tail answers a different question: "what is arriving while I watch?" That has to be true whether or
 * not something else also read it. So the first tick drains the unread backlog (cursor-gated, which is
 * the useful catch-up), and from then on it shows everything newer than what IT has already shown.
 * It still ADVANCES the shared cursor, because reading here really is reading.
 */
async function watchInbox(space: string, server: string): Promise<void> {
  const ep = await observerEndpoint(space, server);
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  console.log(c.dim(`# ${HUMAN_PEER} · watching for new DMs (Ctrl-C to stop)`));

  // Undefined until the first tick: the catch-up pass is cursor-gated, everything after is self-gated.
  let shown: number | undefined;
  const tick = async (): Promise<void> => {
    // LIMITATION inherited from cotal's oldest-N dmHistory (no tail API): if the backlog to "you"
    // exceeds FETCH_CAP the fetched window is all-old, so a DM past that horizon never surfaces here.
    // A real tail-read API / live ephemeral subscription is the proper fix.
    const all = await readConversation(ep);
    const since = shown ?? readCursor(space);
    for (const e of all.filter((x) => x.ts > since)) {
      console.log(render(e));
      advanceCursor(space, e.ts); // forward-only: reading here marks it read everywhere
    }
    // Move the mark even when nothing printed, so a message another surface consumed during the very
    // first tick can't replay on the second.
    shown = Math.max(since, ...all.map((e) => e.ts));
  };
  // pollLoop carries the re-entrancy guard: a tick that outlasts POLL_MS would otherwise re-read the
  // same pre-advance cursor and print the fresh DMs twice.
  const stop = pollLoop(tick, POLL_MS, (e) => console.error(c.red("! " + e.message)));
  try {
    await new Promise<void>(() => {}); // park; Ctrl-C exits the process
  } finally {
    stop();
    await ep.stop().catch(() => {});
  }
}

/** Open the shared observer, read the conversation through it, close. The fetch/shape/name-resolution
 *  all live in src/feed.ts now — this is only the connect-and-release wrapper the one-shot commands need. */
async function readInbox(space: string, server: string, withSent = false): Promise<Entry[]> {
  const ep = await observerEndpoint(space, server);
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    return await readConversation(ep, { withSent });
  } finally {
    await ep.stop().catch(() => {});
  }
}

async function inbox(argv: string[]): Promise<void> {
  const { space: spaceArg, server: serverArg, history, limit, watch, json, markRead, sent } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  // --watch is a live tail; --history is a one-shot backlog dump. They contradict each other — fail loud.
  if (watch && history) {
    throw new Error("paw: --watch and --history are mutually exclusive — --watch tails new DMs live, --history dumps the backlog once");
  }
  // --json is a one-shot machine read (the Raycast extension polls it). It NEVER advances the shared
  // cursor: a GUI polling every second would otherwise silently mark everything read out from under
  // `paw inbox`/`paw chat`, which share that one unread marker. Pair it with --limit to bound the read.
  if (watch && json) {
    throw new Error("paw: --watch and --json are mutually exclusive — --json is a one-shot read; poll it if you want a feed");
  }
  if (watch) return void (await watchInbox(space, server));

  const all = await readInbox(space, server, sent);

  // `--mark-read` is the EXPLICIT "I've seen these" verb, for a reader that displays without consuming
  // (a GUI). Every other read path either advances the cursor as a side effect of PRINTING (the default)
  // or deliberately never touches it (--history, --json); a surface that shows unread state needs a way
  // to clear it that isn't "print everything again". Forward-only, like every other writer.
  if (markRead) {
    const newest = all.length ? all[all.length - 1].ts : readCursor(space);
    const marked = all.filter((e) => e.ts > readCursor(space)).length; // count BEFORE the advance, or it's always 0
    advanceCursor(space, newest);
    if (json) writeJson({ space, cursor: readCursor(space), marked });
    else console.log(c.dim(`marked read up to ${new Date(newest).toLocaleString()}`));
    return;
  }

  if (json) {
    writeJson({ space, cursor: readCursor(space), messages: all.slice(-limit) }); // writeJson, NOT console.log — see src/stdout.ts
    return;
  }

  if (history) {
    const shown = all.slice(-limit);
    if (!shown.length) console.log(c.dim(`inbox empty — no DMs to "${HUMAN_PEER}" on record`));
    else {
      const more = all.length > shown.length ? c.dim(` (of ${all.length})`) : "";
      console.log(c.dim(`# ${HUMAN_PEER} · last ${shown.length} message${shown.length === 1 ? "" : "s"}${more} · history (read-only)`));
      for (const e of shown) console.log(render(e));
    }
    return;
  }

  // Default: everything newer than the shared "seen" cursor, then advance it (forward-only, so a live
  // chat advancing it concurrently isn't rewound). No mesh ack, no consumer bind.
  const cursor = readCursor(space);
  const fresh = all.filter((e) => e.ts > cursor);
  if (all.length) advanceCursor(space, all[all.length - 1].ts); // mark everything we just saw as read
  if (!fresh.length) {
    console.log(c.dim(`inbox empty — nothing new for "${HUMAN_PEER}" (try \`paw inbox --history\`)`));
    return;
  }
  console.log(c.dim(`# ${HUMAN_PEER} · ${fresh.length} new message${fresh.length === 1 ? "" : "s"}`));
  for (const e of fresh) console.log(render(e));
}

const inboxCommand: Command = {
  kind: "command",
  name: "inbox",
  group: "Mesh",
  summary: "read your DM inbox (new since last time; --history for the backlog; --watch to tail live; --json for tools; --mark-read to clear unread) — inbox [--history] [--watch] [--json] [--mark-read] [--limit N]",
  usage: "inbox [--history] [--watch] [--json] [--mark-read] [--limit N] [--space <s>]   (default: new since last read; --history: last N, read-only; --watch: live tail; --json: machine read, cursor untouched; --mark-read: clear unread)",
  run: (a) => inbox([...a.raw]),
};

registry.register(inboxCommand);
