/**
 * `paw msg <#channel|channel> <text…>` — one-shot broadcast to a channel, endpoint-native (the old
 * alias re-dispatched cotal's `send msg`; this is paw's own). Sends under the stable "you" identity
 * (same as `paw dm`) so agents see the human peer, not a throwaway sender. Joins nothing durable:
 * the endpoint carries `channels: [channel]` only for the send, registerPresence:false (the mailbox
 * beacon holds "you" present) and consume:false (never touches "you"'s durable inbox slot).
 */
import { CotalEndpoint, DEFAULT_SERVER, assertValidChannel, registry, type Command } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { HUMAN_PEER } from "../names.js";
import { stripChannel } from "./history.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), cyan: wrap("36"), red: wrap("31") };

interface Args {
  channel?: string;
  text: string;
  space?: string;
  server?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { text: "" };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a.startsWith("--")) throw new Error(`paw: unknown flag "${a}" — msg <#channel> "<text>" [--space s]`);
    else words.push(a);
  }
  const first = words.shift();
  out.channel = first === undefined ? undefined : stripChannel(first);
  out.text = words.join(" ").trim();
  return out;
}

async function msg(argv: string[]): Promise<void> {
  const { channel, text, space: spaceArg, server: serverArg } = parseArgs(argv);
  if (!channel || !text) throw new Error('paw: usage — msg <#channel> "<text>"');
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;
  assertValidChannel(channel);

  // One-shot sender as the stable "you" (mirrors src/dm.ts's endpoint shape): no presence, no
  // durable consumer, no roster watch — connect, multicast to the one channel, disconnect.
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    card,
    channels: [channel],
    registerPresence: false,
    consume: false,
    watchPresence: false,
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    await ep.multicast(text, { channel });
    console.log(`${c.cyan("→ #" + channel)}${c.dim(":")} ${text}`);
  } finally {
    await ep.stop().catch(() => {});
  }
}

const msgCommand: Command = {
  kind: "command",
  name: "msg",
  group: "Mesh",
  summary: "broadcast to a channel — msg <#channel> \"<text>\" (use `paw dm` for an agent DM)",
  usage: 'msg <#channel> "<text>" [--space s]',
  run: (a) => msg([...a.raw]),
};

registry.register(msgCommand);
