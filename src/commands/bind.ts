/**
 * `paw bind [--peer telegram]` — mint a short-lived, one-time code that authorizes a NEW Telegram
 * chat onto the mesh. Replaces the insecure learn-first-chat bootstrap: instead of "first stranger to
 * text the bot wins", the operator (or an agent) mints a code OVER THE MESH and types it into the chat
 * they want to authorize as `/bind <code>`. The code is minted on the trusted side (the endpoint
 * bridge), so authorization rests on "you can produce a code minted on the mesh", never on "you can
 * talk to the bot".
 *
 * Wire contract (mirrored EXACTLY on the endpoint side — see endpoint-core/src/bind.ts):
 *   - MINT REQUEST: a peer sends the telegram endpoint a DM carrying a data part
 *       { kind:"data", data:{ proto:"ai.cotal.bind-request", v:1 } }
 *     which the endpoint INTERCEPTS before its forward-to-chats path (never relayed to Telegram).
 *   - MINT RESPONSE: the endpoint unicasts back a DM with a readable text line AND a data part
 *       { kind:"data", data:{ proto:"ai.cotal.bind-code", v:1, code:string, ttlSec:number } }.
 * This shares ONE path with an agent's `cotal_dm("telegram", <bind-request>)`.
 *
 * Reply-receipt without contending with the "you" durable inbox: this connects as a DISTINCT,
 * EPHEMERAL peer (its own random name + minted id, NOT HUMAN_PEER), so consume:true binds ITS OWN
 * short-lived DM durable — never `dm_<you>`, the single slot `paw inbox`/`paw chat` share. It
 * registers presence only so the endpoint can resolve + unicast the code back, then exits (the
 * ephemeral durable self-retires). Imports ONLY @cotal-ai/core.
 */
import { randomUUID } from "node:crypto";
import { CotalEndpoint, DEFAULT_SERVER, registry, type Command, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import { controlCreds, startResilient } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";

/** The reserved bind protocol — re-declared locally so this module imports only @cotal-ai/core (the
 *  wire is the contract, not a shared type). Kept byte-identical to endpoint-core/src/bind.ts. */
export const BIND_REQUEST_PROTO = "ai.cotal.bind-request";
export const BIND_CODE_PROTO = "ai.cotal.bind-code";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), cyan: wrap("36"), green: wrap("32"), red: wrap("31") };

/** The shape of a bind-code reply's data part (post-extraction). */
export interface BindCode {
  code: string;
  ttlSec: number;
}

/** Pull the bind code out of a reply message's data parts. Returns undefined for anything that isn't a
 *  well-formed `ai.cotal.bind-code` v1 part (so a stray DM never reads as a code). Never fabricates:
 *  a data part missing `code`/`ttlSec` is rejected, not defaulted. */
export function extractBindCode(m: CotalMessage): BindCode | undefined {
  for (const p of m.parts) {
    if (p.kind !== "data") continue;
    const d = p.data as { proto?: unknown; v?: unknown; code?: unknown; ttlSec?: unknown } | null;
    if (!d || d.proto !== BIND_CODE_PROTO || d.v !== 1) continue;
    if (typeof d.code !== "string" || !d.code) continue;
    if (typeof d.ttlSec !== "number" || !Number.isFinite(d.ttlSec)) continue;
    return { code: d.code, ttlSec: d.ttlSec };
  }
  return undefined;
}

/** The operator-facing output: the code + the ready-to-paste `/bind <code>` line to send in the chat
 *  being authorized. Pure (no I/O, no color) so it's unit-testable. */
export function formatBindOutput(bc: BindCode): string {
  return [
    `bind code: ${bc.code}   (valid ${bc.ttlSec}s, one-time)`,
    `→ in the Telegram chat you want to authorize, send:  /bind ${bc.code}`,
  ].join("\n");
}

interface Args {
  peer: string;
  space?: string;
  server?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { peer: "telegram" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--peer") out.peer = argv[++i];
    else if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else throw new Error(`paw: unknown argument "${a}" — bind [--peer <name>] [--space <s>] [--server <url>]`);
  }
  if (!out.peer) throw new Error("paw: --peer needs an endpoint peer name (default: telegram)");
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Presence arrives on a heartbeat, so poll briefly for the target endpoint peer to appear rather than
 *  racing an empty initial roster. Returns its wire id (unicast target), or undefined on timeout. */
async function waitForPeer(ep: CotalEndpoint, name: string, timeoutMs: number): Promise<string | undefined> {
  const want = name.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const peer = ep.getRoster().find((p) => p.card.name.toLowerCase() === want && p.status !== "offline");
    if (peer) return peer.card.id;
    if (Date.now() >= deadline) return undefined;
    await sleep(150);
  }
}

const RESOLVE_MS = 5000; // how long to wait for the telegram peer to show on the roster
const REPLY_MS = 10_000; // how long to wait for the minted code to come back

async function bind(argv: string[]): Promise<void> {
  const { peer, space: spaceArg, server: serverArg } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  // A DISTINCT, EPHEMERAL consuming peer — never HUMAN_PEER. Its own random name + minted id means
  // consume:true binds ITS OWN short-lived DM durable, so the reply-receipt never contends with the
  // single "you" inbox consumer (`paw inbox`/`paw chat`). registerPresence:true only so the endpoint
  // can resolve + unicast the code back; watchPresence:true to find the telegram peer on the roster.
  const creds = await controlCreds(space);
  const ephemeralId = randomUUID().replace(/-/g, ""); // NATS-safe (cotal 0.11 principal token), distinct per run
  const card = creds
    ? { name: "paw-bind", kind: "endpoint" as const }
    : { name: "paw-bind", kind: "endpoint" as const, id: ephemeralId };
  const ep = new CotalEndpoint({ space, servers: server, creds, card, channels: [], registerPresence: true, consume: true, watchPresence: true });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));

  // Latch the first bind-code reply from the target peer (set up BEFORE we send, so a fast reply isn't missed).
  let resolveReply!: (bc: BindCode) => void;
  const replyP = new Promise<BindCode>((res) => (resolveReply = res));
  ep.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
    d.ack();
    if (meta.kind !== "dm" || meta.historical) return;
    if (m.from.name.toLowerCase() !== peer.toLowerCase()) return;
    const bc = extractBindCode(m);
    if (bc) resolveReply(bc);
  });

  await startResilient(ep);
  try {
    const targetId = await waitForPeer(ep, peer, RESOLVE_MS);
    if (!targetId) {
      throw new Error(
        `paw: no "${peer}" endpoint peer present in space "${space}" — is the Telegram bridge running? (\`paw who\` to check; --peer <name> if it joins under another name)`,
      );
    }

    // Mint request: a DM carrying only the reserved bind-request data part. The endpoint intercepts it
    // before the forward-to-chats path, so it's never relayed to Telegram; the text is inert.
    await ep.unicast(targetId, "", { parts: [{ kind: "data", data: { proto: BIND_REQUEST_PROTO, v: 1 } }] });

    const bc = await Promise.race([replyP, sleep(REPLY_MS).then(() => undefined)]);
    if (!bc) {
      throw new Error(
        `paw: "${peer}" did not return a bind code within ${REPLY_MS / 1000}s — the bridge may be an old build without /bind support (mesh-minted codes need the bind interception).`,
      );
    }
    console.log(c.green("✓ minted a bind code"));
    console.log(formatBindOutput(bc));
  } finally {
    await ep.stop().catch(() => {});
  }
}

const bindCommand: Command = {
  kind: "command",
  name: "bind",
  group: "Mesh",
  summary: "mint a short-lived code to authorize a new Telegram chat — then send `/bind <code>` in that chat",
  usage: "bind [--peer <name>] [--space <s>] [--server <url>]   (default peer: telegram)",
  run: (a) => bind([...a.raw]),
};

registry.register(bindCommand);
