/**
 * `paw who` — the live roster, endpoint-native: who's present on the mesh right now and what
 * they're doing (the standalone twin of chat's `/who`). A pure observer: registerPresence:false +
 * consume:false, watchPresence:true so presence beats populate the roster; polls briefly for the
 * beats to settle (presence rides a heartbeat, so an instant read would race an empty roster).
 */
import { CotalEndpoint, DEFAULT_SERVER, registry, type Command, type Presence, type PresenceStatus } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { HUMAN_PEER } from "../names.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), yellow: wrap("33"), magenta: wrap("35"), red: wrap("31") };

/** How long to wait for presence beats before concluding the mesh is empty. */
const SETTLE_MS = 2000;

function statusBadge(status: PresenceStatus): string {
  if (status === "working") return c.yellow("● working");
  if (status === "waiting") return c.magenta("● waiting");
  if (status === "offline") return c.dim("○ offline");
  return c.dim("● idle");
}

/**
 * One row per NAME, not per presence record.
 *
 * The roster is keyed by mesh ID and every restart mints a new one, while `sweep()` marks a stale peer
 * `offline` in the in-memory map WITHOUT removing it. So a long-lived session accumulates one entry per
 * past incarnation: an agent restarted six times shows six `offline` rows and one live one (reported
 * 2026-08-13, from a `paw chat` that had been open all day). Nothing is leaked on the mesh — a fresh
 * connection sees only live peers — so this is a rendering problem and is fixed where it is rendered.
 *
 * The LIVE record wins; among equals the most recent does. An offline row survives only when there is
 * no live one for that name, because "this agent exists and is currently down" is worth saying — it is
 * only the dead PREDECESSORS of a running agent that are noise.
 */
export function dedupeRoster(peers: readonly Presence[]): Presence[] {
  const best = new Map<string, Presence>();
  for (const p of peers) {
    const prev = best.get(p.card.name);
    if (!prev) {
      best.set(p.card.name, p);
      continue;
    }
    const prevLive = prev.status !== "offline";
    const live = p.status !== "offline";
    if ((live && !prevLive) || (live === prevLive && (p.ts ?? 0) > (prev.ts ?? 0))) best.set(p.card.name, p);
  }
  return [...best.values()];
}

/** One roster row, chat's `/who` shape: `name/role ● status` (+ the beacon-held "you" marker). */
export function formatWho(p: Presence, humanId: string): string {
  const label = p.card.role ? `${p.card.name}/${p.card.role}` : p.card.name;
  const you = p.card.id === humanId ? c.dim(" (you)") : "";
  return `  ${c.bold(label)} ${statusBadge(p.status)}${you}`;
}

function parseArgs(argv: string[]): { space?: string; server?: string } {
  const out: { space?: string; server?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else throw new Error(`paw: unknown argument "${a}" — who takes [--space <s>] [--server <url>]`);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function who(argv: string[]): Promise<void> {
  const { space: spaceArg, server: serverArg } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  // Observer endpoint (mirrors src/dm.ts's creds/card shape): watchPresence:true is the point —
  // the roster is built from presence beats; we never register our own presence (the mailbox
  // beacon holds "you", and it shows up in the roster like any peer).
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({ space, servers: server, creds, card, channels: [], registerPresence: false, consume: false, watchPresence: true });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    // Presence arrives on a heartbeat — poll until the roster is non-empty or the settle window ends.
    const deadline = Date.now() + SETTLE_MS;
    let roster = ep.getRoster();
    while (roster.length === 0 && Date.now() < deadline) {
      await sleep(100);
      roster = ep.getRoster();
    }
    if (roster.length === 0) {
      console.log(c.dim(`(nobody present in space "${space}")`));
      return;
    }
    console.log(c.dim(`# ${roster.length} present in "${space}"`));
    const humanId = stableHumanId(space);
    for (const p of dedupeRoster(roster)) console.log(formatWho(p, humanId));
  } finally {
    await ep.stop().catch(() => {});
  }
}

const whoCommand: Command = {
  kind: "command",
  name: "who",
  group: "Mesh",
  summary: "who's present on the mesh right now (the standalone twin of chat's /who)",
  usage: "who [--space <s>] [--server <url>]",
  run: (a) => who([...a.raw]),
};

registry.register(whoCommand);
