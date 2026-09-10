/**
 * `paw mailbox [--space s]` — the persistent "you" beacon (a long-lived daemon, normally started for
 * you by `ensure()`, not run by hand).
 *
 * Why it exists: an agent can only deliver a DM to a peer it can RESOLVE in the live roster. Without a
 * standing "you" presence, the moment `paw dm` exits "you" goes offline, ages out of the roster, and a
 * reply the agent sends minutes later (a PR link, a result, a question) can't be addressed — it's the
 * "send went offline" failure. This daemon keeps "you" permanently present (a 2s presence heartbeat) so
 * agents can always reach you; their DMs land in your durable inbox, read with `paw inbox`.
 *
 * It is a pure PRESENCE BEACON: registerPresence true, **consume false** — it never drains or acks your
 * inbox (that would steal messages from `paw inbox`). It just holds the "you" identity online. Multiple
 * "you" presences (this beacon + a live `paw chat`) share one stable id and coexist: only the consumer
 * (chat) binds the durable inbox; the beacon never does.
 */
import { CotalEndpoint, DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { controlCreds, stableHumanId } from "./addressing.js";
import { resolveSpace } from "./lifecycle.js";
import { HUMAN_PEER } from "./names.js";

function parseArgs(argv: string[]): { space?: string; server?: string } {
  const out: { space?: string; server?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    // tolerate (and ignore) any other flag so a future ensure() can pass extras without breaking the daemon
  }
  return out;
}

async function mailbox(argv: string[]): Promise<void> {
  const { space: spaceArg, server: serverArg } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    card,
    registerPresence: true, // the whole point: keep "you" online so agents can resolve + reply to you
    consume: false, // beacon only — never drain/ack your inbox (that's `paw inbox`)
    watchPresence: false,
  });
  // The endpoint self-heals across mesh blips (reconnect + re-register presence), so a transient error
  // shouldn't kill the daemon — log it and stay up.
  ep.on("error", (e: Error) => console.error(`[mailbox] ${e.message}`));
  await ep.start();
  console.error(`[mailbox] present as "${HUMAN_PEER}" in space "${space}" — keeping you reachable for replies`);

  const leave = async () => {
    await ep.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void leave());
  process.on("SIGINT", () => void leave());
  await new Promise<void>(() => {}); // park forever; SIGTERM (paw down / stop) ends it
}

const mailboxCommand: Command = {
  kind: "command",
  name: "mailbox",
  group: "Mesh",
  summary: 'the persistent "you" presence beacon (auto-started; keeps you reachable for agent replies)',
  usage: "mailbox [--space <s>]   (daemon — normally started for you by paw, not run by hand)",
  run: (a) => mailbox([...a.raw]),
};

registry.register(mailboxCommand);
