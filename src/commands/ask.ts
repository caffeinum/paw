/**
 * `paw ask <role> <text…>` — one-shot anycast to a role, endpoint-native (the old alias
 * re-dispatched cotal's `send ask`; this is paw's own). Queue-group semantics: the mesh delivers to
 * ANY ONE live holder of the role. Sends under the stable "you" identity (same as `paw dm`) so the
 * answering agent's reply is addressed to your durable inbox — read it with `paw inbox`.
 */
import { CotalEndpoint, DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { HUMAN_PEER } from "../names.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), cyan: wrap("36"), red: wrap("31") };

interface Args {
  role?: string;
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
    else if (a.startsWith("--")) throw new Error(`paw: unknown flag "${a}" — ask <role> "<text>" [--space s]`);
    else words.push(a);
  }
  out.role = words.shift();
  out.text = words.join(" ").trim();
  return out;
}

async function ask(argv: string[]): Promise<void> {
  const { role, text, space: spaceArg, server: serverArg } = parseArgs(argv);
  if (!role || !text) throw new Error('paw: usage — ask <role> "<text>"');
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  // One-shot sender as the stable "you" (mirrors src/dm.ts's endpoint shape): no presence, no
  // durable consumer, no roster watch — connect, anycast to the role, disconnect.
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    card,
    channels: [],
    registerPresence: false,
    consume: false,
    watchPresence: false,
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    await ep.anycast(role, text);
    console.log(`${c.cyan("→ " + role)}${c.dim(" (any one holder):")} ${text}`);
    console.log(c.dim("sent → a reply lands in `paw inbox`"));
  } finally {
    await ep.stop().catch(() => {});
  }
}

const askCommand: Command = {
  kind: "command",
  name: "ask",
  group: "Mesh",
  summary: "anycast to any one holder of a role — ask <role> \"<text>\" (reply lands in `paw inbox`)",
  usage: 'ask <role> "<text>" [--space s]',
  run: (a) => ask([...a.raw]),
};

registry.register(askCommand);
