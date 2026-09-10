/**
 * `paw watch` — foreground live feed of the whole space until Ctrl-C, endpoint-native.
 *
 * A read-only `ep.tap` observer (the old alias re-dispatched cotal's `console --plain`; this is
 * paw's own): every message crossing the mesh prints as it arrives —
 *
 *   [channel] name: text          multicast
 *   dm name → name: text          unicast
 *   ask name → role: text         anycast
 *
 * Same observer shape as `paw inbox --watch`: registerPresence:false + consume:false (never in
 * the roster, never binds a durable consumer), parked until Ctrl-C. watchPresence:true so a DM's
 * bare `to` id resolves to a live peer's name. Under PAW_AUTH the tap is scoped to the chat
 * wildcard — an observer cred's sub.allow covers only chat (DMs/anycast stay confidential), and
 * the space-wide subscribe would be denied and kill the feed.
 */
import { CotalEndpoint, DEFAULT_SERVER, chatWildcard, registry, type Command, type CotalMessage } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { HUMAN_PEER } from "../names.js";
import { messageText as textOf } from "../feed.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), magenta: wrap("35"), red: wrap("31") };


/** One tapped message → one printed line, or undefined for non-message traffic (presence beats,
 *  control frames — the tap sees the whole space; only the three chat families render). */
export function renderTap(m: CotalMessage, nameFor: (id: string) => string): string | undefined {
  if (!Array.isArray(m.parts) || !m.from) return undefined;
  if (m.channel) return `${c.dim(`[${m.channel}]`)} ${c.bold(m.from.name)}: ${textOf(m)}`;
  if (m.to) return `${c.magenta("dm")} ${c.bold(m.from.name)} ${c.dim("→")} ${c.bold(nameFor(m.to))}: ${textOf(m)}`;
  if (m.toService) return `${c.magenta("ask")} ${c.bold(m.from.name)} ${c.dim("→")} ${m.toService}: ${textOf(m)}`;
  return undefined;
}

interface Args {
  space?: string;
  server?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else throw new Error(`paw: unknown argument "${a}" — watch takes [--space <s>] [--server <url>]`);
  }
  return out;
}

async function watch(argv: string[]): Promise<void> {
  const { space: spaceArg, server: serverArg } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  // Pure observer (mirrors src/inbox.ts's endpoint shape); watchPresence:true only to name DM
  // recipients — a unicast carries the sender's name but just the recipient's instance id.
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({ space, servers: server, creds, card, registerPresence: false, consume: false, watchPresence: true });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();

  // Learned id→name map: every tapped sender teaches us its name, so an offline recipient that
  // ever spoke still renders by name. Unknown → the raw short id (shown, never fabricated).
  const names = new Map<string, string>([[ep.card.id, "you"]]);
  const nameFor = (id: string): string => {
    const known = names.get(id) ?? ep.getRoster().find((p) => p.card.id === id)?.card.name;
    return known ?? id.slice(0, 8);
  };

  if (creds) console.log(c.dim("(authed mesh: tapping chat only — DMs/anycast are confidential to an observer cred)"));
  console.log(c.dim(`# tapping space "${space}" (Ctrl-C to stop)`));
  ep.tap(
    (_subject, m) => {
      // The space-wide tap also sees non-message frames (control replies are bare {ok,data} with
      // no `from`) — core doesn't try/catch the handler, so a throw here would kill the feed for
      // good. Guard the shape, and never let a render error abort the iterator.
      if (!m || typeof m !== "object") return;
      try {
        if (m.from?.id && m.from.name) names.set(m.from.id, m.from.name);
        const line = renderTap(m, nameFor);
        if (line) console.log(line);
      } catch (e) {
        console.error(c.red("! " + (e as Error).message));
      }
    },
    creds ? { subject: chatWildcard(space) } : undefined,
  );

  try {
    await new Promise<void>(() => {}); // park; Ctrl-C exits the process (same as `paw inbox --watch`)
  } finally {
    await ep.stop().catch(() => {});
  }
}

const watchCommand: Command = {
  kind: "command",
  name: "watch",
  group: "Mesh",
  summary: "live foreground feed of every mesh message until Ctrl-C — watch",
  usage: "watch [--space <s>] [--server <url>]   (read-only tap of the whole space; Ctrl-C to stop)",
  run: (a) => watch([...a.raw]),
};

registry.register(watchCommand);
