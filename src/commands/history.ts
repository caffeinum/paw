/**
 * `paw history [channel] [--limit N]` — read the mesh's message backlog, endpoint-native.
 *
 * With a channel: that channel's chat backlog (`ep.channelHistory`). Without: the space's DM
 * backlog tail (`ep.dmHistory` — god-view; open mesh only, an authed non-admin cred's read is
 * denied so it comes back empty). Rendered `from → to: text` with timestamps, oldest first.
 *
 * PURE READER, same observer shape as `paw inbox`: registerPresence:false + consume:false — it
 * never binds a durable consumer, never appears in the roster, just reads the stream and exits.
 */
import { CotalEndpoint, DEFAULT_SERVER, assertValidChannel, registry, type Command, type CotalMessage } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { HUMAN_PEER } from "../names.js";
import { messageText as textOf } from "../feed.js";

/** How deep to read a backlog. cotal's channelHistory/dmHistory return the OLDEST N, so to surface
 *  the NEWEST we fetch up to this many and take the tail (same cap + reason as src/inbox.ts). */
const FETCH_CAP = 10_000;

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), red: wrap("31") };

/** Strip one leading `#` off a channel argument (`#general` and `general` are the same channel).
 *  Fails loud on an empty result — `paw history "#"` is a typo, not a channel. */
export function stripChannel(arg: string): string {
  const ch = arg.startsWith("#") ? arg.slice(1) : arg;
  if (!ch) throw new Error(`paw: "${arg}" is not a channel name`);
  return ch;
}

/** Compact absolute timestamp: `HH:MM` when the message is from today, `MM-DD HH:MM` otherwise —
 *  history is a backlog view, so relative "ago" tags would all collapse to noise. */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = new Date(now);
  const sameDay = d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** id→name map learned from the messages themselves (every sender carries its name in `from`);
 *  a DM's `to` is a bare instance id, so this is how recipients get named. */
export function idNames(msgs: CotalMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of msgs) names.set(m.from.id, m.from.name);
  return names;
}


/** `to` for the rendered line: `#channel` (multicast), a resolved peer name (unicast — falls back
 *  to the raw short id when the recipient never spoke, so nothing is fabricated), or `role`. */
function targetOf(m: CotalMessage, names: Map<string, string>): string {
  if (m.channel) return `#${m.channel}`;
  if (m.to) return names.get(m.to) ?? m.to.slice(0, 8);
  if (m.toService) return m.toService;
  throw new Error(`paw: message ${m.id} has no channel/to/toService — malformed backlog record`);
}

function render(m: CotalMessage, names: Map<string, string>): string {
  return `${c.dim(formatWhen(m.ts))} ${c.bold(m.from.name)} ${c.dim(`→ ${targetOf(m, names)}:`)} ${textOf(m)}`;
}

interface Args {
  channel?: string;
  limit: number;
  space?: string;
  server?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--limit" || a === "-n") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("paw: --limit needs a positive integer");
      out.limit = n;
    } else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — history [channel] [--limit N] [--space <s>]`);
    else if (a === "clear")
      // cotal's history verb was `history clear` (wipe retained backlog) — paw's history is a READER.
      // Don't silently reinterpret the old destructive verb as channel "#clear".
      throw new Error("paw: `history clear` is cotal's backlog wipe — run `paw cotal history clear --force` for that; paw's history only reads.");
    else if (out.channel !== undefined) throw new Error(`paw: history takes at most one channel — got "${out.channel}" and "${a}"`);
    else out.channel = stripChannel(a);
  }
  return out;
}

async function history(argv: string[]): Promise<void> {
  const { channel, limit, space: spaceArg, server: serverArg } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;
  if (channel) assertValidChannel(channel);

  // Observer endpoint, mirrored from src/inbox.ts: connect as the stable "you" (so a DM addressed
  // to you renders under your name), but pure reader — no presence, no durable consumer bind.
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({ space, servers: server, creds, card, registerPresence: false, consume: false, watchPresence: false });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    // Oldest-N semantics upstream (see FETCH_CAP): fetch deep, slice the newest `limit`, print
    // oldest-first so the terminal reads top-to-bottom like the conversation happened.
    const all = channel ? await ep.channelHistory(channel, { limit: FETCH_CAP }) : await ep.dmHistory({ limit: FETCH_CAP });
    const shown = all.slice(-limit);
    if (!shown.length) {
      if (channel) console.log(c.dim(`no messages on #${channel}`));
      else {
        console.log(c.dim("no DMs on record"));
        // dmHistory is god-view: a non-admin authed cred's consumer create is DENIED and cotal
        // swallows it into an empty read — say so instead of letting empty pass for true.
        if (creds) console.log(c.dim("(authed mesh: the DM backlog is admin-only — an empty read here may be a denied consumer, not an empty stream)"));
      }
      return;
    }
    const me = ep.card.id;
    const names = idNames(all);
    names.set(me, "you");
    const more = all.length > shown.length ? c.dim(` (of ${all.length}+)`) : "";
    console.log(c.dim(`# ${channel ? `#${channel}` : "DMs"} · last ${shown.length} message${shown.length === 1 ? "" : "s"}${more} · oldest first`));
    for (const m of shown) console.log(render(m, names));
  } finally {
    await ep.stop().catch(() => {});
  }
}

const historyCommand: Command = {
  kind: "command",
  name: "history",
  group: "Mesh",
  summary: "read the message backlog — history [channel] [--limit N] (a channel's chat, or the DM stream without one)",
  usage: "history [channel] [--limit N] [--space <s>]   (channel → that channel's backlog; no channel → the space's DM backlog; oldest first)",
  run: (a) => history([...a.raw]),
};

registry.register(historyCommand);
