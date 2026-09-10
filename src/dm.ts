/**
 * `paw dm <name|folder|repo@branch> <message…>` — fire-and-forget DM to an agent.
 *
 * Send it and walk away; read the reply later with `paw inbox`. It sends under the stable "you"
 * identity (the same peer `paw inbox`/`paw chat` use), NOT cotal's throwaway `send` peer — that one
 * (registerPresence:false, no inbox) is gone the instant it sends, so the agent's reply is
 * undeliverable ("send went offline"). Sending as "you" addresses the reply to your durable inbox, and
 * the persistent mailbox beacon (src/mailbox.ts) keeps "you" present so a reply minutes later lands.
 *
 * There is no wait/stream mode on purpose: the LIVE conversation is `paw chat`; the ASYNC hand-off is
 * `paw dm` + `paw inbox`. (A former `--wait` bound "you"'s single durable consumer and could starve
 * `paw inbox`/`paw chat` — removed so dm never competes for that slot.)
 *
 * `--name <n>` targets an EXTRA agent instance at a DIRECTORY (multiple claudes in one dir): with a
 * folder target — a plain path OR an address handle (a `repo@branch` worktree / `github:` clone both
 * resolve to a directory) — it `registerInstance`s the name in the agents.json side-table (fail-loud on
 * a collision) and DMs that instance instead of the folder's default. `--name` fails loud only when
 * combined with a bare agent NAME (a name already IS one agent; an extra is minted against a directory).
 * Mirrors `paw chat`/`paw open` so the same handle form addresses the extra you created there.
 */
import { CotalEndpoint, DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  canonicalDir,
  controlCreds,
  ensureAgentSpawned,
  folderForName,
  registerInstance,
  resolveFolderAgent,
  setFolderName,
  stableHumanId,
  waitForPeerId,
} from "./addressing.js";
import { isAddressHandle, resolveAddress } from "./address.js";
import { withManagerControl } from "./control.js";
import { composeMessage, peelWords, stageAttachment } from "./images.js";
import { resolveSpace } from "./lifecycle.js";
import { HUMAN_PEER } from "./names.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), cyan: wrap("36"), red: wrap("31") };

interface Args {
  target?: string;
  /** The message words, UNJOINED — an attachment path may contain spaces, and the shell already
   *  unquoted it into exactly one argv word, so joining first would make it unrecoverable. */
  words: string[];
  space?: string;
  server?: string;
  model?: string;
  name?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { words: [] };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a.startsWith("--"))
      throw new Error(`paw: unknown flag "${a}" — dm <name|folder|repo@branch> "<message>" [--name n] [--model m] [--space s]`);
    else words.push(a);
  }
  out.target = words.shift();
  out.words = words;
  return out;
}

/** Resolve the target to a present agent id, spawning/waking it if it's a known folder or an
 *  offline-but-known agent name (mirrors `paw chat`'s @mention behaviour). */
/** The addressable id for a (possibly just-spawned) agent. On a FRESH spawn, wait for its PRESENCE
 *  before returning: presence-up implies the agent connected and provisioned its 0.11 durable DM inbox,
 *  so the send doesn't race an un-provisioned JetStream stream ("jetstream is not enabled" / not-found).
 *  A REUSED live agent is already provisioned — its start-reply/presence id is usable at once. */
export const FRESH_SPAWN_MS = 20_000;
export const LIVE_AGENT_MS = 8_000;

export async function readyId(ep: CotalEndpoint, name: string, r: { spawned: boolean; id?: string }): Promise<string> {
  const id = r.spawned ? await waitForPeerId(ep, name, FRESH_SPAWN_MS) : (r.id ?? (await waitForPeerId(ep, name, LIVE_AGENT_MS)));
  if (!id) throw new Error(`paw: agent "${name}" did not come up in time`);
  return id;
}

async function resolveTarget(
  ep: CotalEndpoint,
  space: string,
  server: string,
  target: string,
  model: string | undefined,
  nameFlag: string | undefined,
): Promise<{ id: string; name: string }> {
  const me = ep.card.id;
  const live = (name: string) =>
    ep.getRoster().filter((p) => p.card.name.toLowerCase() === name.toLowerCase() && p.card.id !== me).find((p) => p.status !== "offline");

  // A URL / web: / gh: / github: handle, a repo@branch worktree, or a bare host → spawn-if-absent under
  // its name; a plain folder path too. An explicit handle's errors surface (fail loud); a plain string
  // that isn't a path/host falls through to agent-name resolution below.
  if (isAddressHandle(target)) {
    const addr = resolveAddress(target);
    // --name registers a SAME-directory EXTRA at the handle's resolved dir (clone/worktree), mirroring
    // chat/open; without it the handle resolves to the folder's default (label-hinted, else basename).
    const name = nameFlag
      ? registerInstance(space, addr.cwd, nameFlag)
      : addr.name
        ? setFolderName(space, addr.cwd, addr.name).name
        : resolveFolderAgent(space, addr.cwd);
    const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: addr.cwd, model, brief: addr.brief, kind: addr.kind }));
    return { id: await readyId(ep, name, r), name };
  }
  let folder: string | undefined;
  try {
    folder = canonicalDir(target);
  } catch {
    /* not a path — treat as an agent name below */
  }
  if (folder) {
    // With --name, address (registering it if new) an EXTRA instance at this folder instead of the
    // folder's default agent; registerInstance fails loud if the name collides with any known agent.
    const name = nameFlag ? registerInstance(space, folder, nameFlag) : resolveFolderAgent(space, folder);
    const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder, model }));
    return { id: await readyId(ep, name, r), name };
  }

  // An agent name: --name is meaningless here — a bare name already IS the address (an extra is minted
  // against a FOLDER, not another agent name).
  if (nameFlag)
    throw new Error(
      `paw: --name adds an extra agent to a FOLDER — combine it with a folder path (e.g. \`paw dm . "…" --name ${nameFlag}\`), ` +
        `not with an agent name "${target}"`,
    );
  // An agent name: prefer a live peer; wake a known-but-offline one via its folder.
  const present = live(target);
  if (present) return { id: present.card.id, name: present.card.name };
  const home = folderForName(space, target);
  if (home) {
    const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name: target, cwd: home, model }));
    return { id: await readyId(ep, target, r), name: target };
  }
  throw new Error(`paw: no agent "${target}" present or known (\`paw ps\` for live names)`);
}

/** Send, tolerating the boot-race window. A just-spawned agent publishes PRESENCE before it runs
 *  `ensureStreams` (cotal endpoint boot order), so a send right after presence can hit a not-yet-created
 *  DM stream ("jetstream is not enabled"). It's transient — the stream lands within ~1-2s — so retry a
 *  few times; a non-transient error (bad recipient) still fails fast. */
async function unicastResilient(ep: CotalEndpoint, id: string, text: string): Promise<void> {
  const transient = (m: string) => /jetstream is not enabled|no stream|stream not found|no responders|timeout|503/i.test(m);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await ep.unicast(id, text);
      return;
    } catch (e) {
      lastErr = e;
      if (!transient((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

/**
 * Send `text` to `target` as the stable "you" — THE send path, shared by `paw dm` and the web composer.
 *
 * It exists so there is exactly one answer to "how does the human send a message": target resolution
 * (folder → spawn, offline name → wake from its pin), the boot-race retry, and the pure-sender endpoint
 * shape are all decisions that must not drift between surfaces. A second copy in the web server would
 * be a second place for "why did my message wake the agent here but not there".
 *
 * A send needs NO durable consumer — publishing is not the contended half — so this can open its own
 * short-lived endpoint from anywhere without touching the single "you" inbox slot that `paw chat` binds.
 * Returns the RESOLVED agent name, which is not always what the caller typed (a folder path, a
 * worktree handle and a bare name all land here).
 */
export async function sendAsYou(opts: {
  space: string;
  server: string;
  target: string;
  text: string;
  model?: string;
  name?: string;
}): Promise<{ name: string }> {
  const { space, server, target, text, model, name: nameFlag } = opts;
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud

  // Pure sender: watch the roster to resolve/spawn the target, but don't register presence (the mailbox
  // beacon holds "you") and don't consume (never touch the durable inbox slot — that's `paw inbox`'s).
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({ space, servers: server, creds, card, registerPresence: false, consume: false, watchPresence: true });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    const tgt = await resolveTarget(ep, space, server, target, model, nameFlag);
    await unicastResilient(ep, tgt.id, text);
    return { name: tgt.name };
  } finally {
    await ep.stop().catch(() => {});
  }
}

/** Read stdin to EOF — the `-` message form. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function dm(argv: string[]): Promise<void> {
  const { target, words, space: spaceArg, server: serverArg, model, name: nameFlag } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;

  // `paw dm <target> -` takes the message on STDIN. It exists for producers that hand text to a command
  // rather than building an argv — voice dictation being the one that prompted it. Two reasons it isn't
  // just `"$(cat)"` at the call site: dictated text is full of apostrophes and newlines, so shell
  // quoting breaks on the first possessive; and argv is world-readable in `ps`, so every utterance
  // would leak to any process listing on the machine.
  if (words.length === 1 && words[0] === "-") {
    if (process.stdin.isTTY) throw new Error('paw: `dm <target> -` reads the message on stdin — e.g. `echo "ship it" | paw dm voice -`');
    const piped = (await readStdin()).trim();
    if (!piped) throw new Error("paw: empty message on stdin — nothing to send");
    words[0] = piped;
  }

  // Peel attachment paths out of the message words (see src/images.ts). Unlike chat there's no
  // pending list — a one-shot dm carrying ONLY an image is a legitimate send, so the usage check
  // accepts a body OR attachments.
  const peeled = peelWords(words);
  // `--name` with no positional is a specific mistake with a specific fix, and the generic usage line
  // did not say so: --name mints an EXTRA agent at a FOLDER, so the folder is the part that is missing.
  // Reached for naturally after the ambiguity guard refuses a bare name, which is exactly when a bare
  // usage dump is least helpful.
  if (nameFlag && !peeled.body && !peeled.paths.length)
    throw new Error(
      `paw: --name adds an EXTRA agent at a FOLDER, so it needs the folder as well — e.g. \`paw dm . "${target ?? "…"}" --name ${nameFlag}\`.\n` +
        `       To message the EXISTING agent "${nameFlag}", drop --name: \`paw dm ${nameFlag} "${target ?? "…"}"\` — from a directory where that name isn't also a folder, or use its path.`,
    );
  if (!target || (!peeled.body && !peeled.paths.length))
    throw new Error('paw: usage — dm <name|folder|repo@branch> "<message>" (or `-` to read it on stdin, or an image path to attach)');

  // Checked BEFORE the attachments are staged: an ambiguous target must fail without having copied
  // files into the space first. sendAsYou re-checks, so every sender carries the guard.
  assertUnambiguousTarget(space, target);

  const attachments = peeled.paths.map((src, i) => stageAttachment(space, src, i + 1));
  const text = composeMessage(peeled.body, attachments);

  // Send AS the stable "you" so the reply is addressed to your durable inbox — through the SHARED
  // sender, so the web composer and this command cannot drift apart.
  const { name } = await sendAsYou({ space, server, target, text, model, name: nameFlag });
  console.log(`${c.cyan("→ " + name)}${c.dim(":")} ${text}`);
  console.log(c.dim("sent → read replies with `paw inbox`"));
}

const dmCommand: Command = {
  kind: "command",
  name: "dm",
  group: "Mesh",
  summary: "fire-and-forget DM to an agent — read replies with `paw inbox` (use `paw chat` for a live conversation)",
  usage: 'dm <name|folder|repo@branch> "<message>"|- [--name n] [--model m] [--space s]',
  run: (a) => dm([...a.raw]),
};

registry.register(dmCommand);
