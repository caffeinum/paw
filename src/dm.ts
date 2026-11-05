/**
 * `paw dm <name|folder|repo@branch|github:owner/repo|…> <message…>` — fire-and-forget DM to an agent.
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
 * resolve to a directory) — it `registerInstance`s the name as an extra persona (fail-loud on
 * a collision) and DMs that instance instead of the folder's default. `--name` fails loud only when
 * combined with a bare agent NAME (a name already IS one agent; an extra is minted against a directory).
 * Mirrors `paw chat`/`paw open` so the same handle form addresses the extra you created there.
 */
import { CotalEndpoint, registry, type Command } from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  canonicalDir,
  humanEndpointAuth,
  cliRestartConsent,
  ensureAgentSpawned,
  SeatAliveError,
  stuckWarning,
  type RestartConsent,
  folderForName,
  registerInstance,
  resolveFolderAgent,
  senderEndpointAuth,
  setFolderName,
  stableHumanId,
  stableSenderId,
  waitForPeerId,
} from "./addressing.ts";
import { isAddressHandle, resolveAddress } from "./address.ts";
import { classifyEndpointError } from "./conn-state.ts";
import { absentVerdict, dmDeadline, dmWaitMs, retryUntil, seenInLedger, unknownAgentMessage, waitExpiredMessage, waitingForMeshLine, waitingLine } from "./dm-wait.ts";
import { draftDm, publishDraft } from "./mesh-publish.ts";
import { readLedger } from "./peer-ledger.ts";
import { withManagerControl } from "./control.ts";
import { attachedPlaceholders, composeMessage, peelWords, stageAttachment } from "./images.ts";
import { elsewhereFiles, runsElsewhere } from "./hosted.ts";
import { resolveSpace } from "./lifecycle.ts";
import { humanPeer } from "./names.ts";
import { pawServer } from "./server.ts";

/** Every target form `paw dm` resolves (resolveTarget): an agent name, a folder, a local worktree, a
 *  GitHub repo/branch (cloned on first use), a URL or a website host. One string for every usage line. */
export const DM_TARGETS = "<name|@name|folder|folder@branch|owner/repo@branch|github:owner/repo[#branch]|https://…|host>";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), cyan: wrap("36"), red: wrap("31") };
const errDim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One deadline shared by the connect wait and the presence wait (src/dm-wait.ts). */
interface Budget {
  ms: number;
  deadline: number;
  server: string;
}
const left = (b: Budget) => Math.max(0, b.deadline - Date.now());

interface Args {
  target?: string;
  /** The message words, UNJOINED — an attachment path may contain spaces, and the shell already
   *  unquoted it into exactly one argv word, so joining first would make it unrecoverable. */
  words: string[];
  space?: string;
  server?: string;
  model?: string;
  name?: string;
  waitFor?: string;
  restart: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { words: [], restart: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--restart") out.restart = true;
    else if (a === "--wait-for") out.waitFor = argv[++i];
    else if (a.startsWith("--"))
      throw new Error(`paw: unknown flag "${a}" — dm ${DM_TARGETS} "<message>" [--name n] [--model m] [--restart] [--wait-for s] [--space s]`);
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

export async function readyId(ep: CotalEndpoint, name: string, r: { spawned: boolean; id?: string; starting?: true; stuck?: string }): Promise<string> {
  if (r.stuck) {
    // The gate gave up restarting it (it never reached the mesh): queue to its durable inbox, say so loudly.
    if (!r.id) throw new Error(`paw: ${stuckWarning(name, r.stuck, false)} — and it has no mesh address, so nothing could be queued`);
    console.error(stuckWarning(name, r.stuck, true));
    return r.id;
  }
  if (r.starting) {
    // Its process runs but it isn't on the mesh yet (ensureAgentSpawned said so). Its principal is
    // allocated, so the message goes to its durable inbox and lands when the seat drains it.
    const live = await waitForPeerId(ep, name, LIVE_AGENT_MS);
    if (live) return live;
    if (!r.id) throw new Error(`paw: "${name}" is still starting and has no mesh address yet — retry once \`paw status\` shows it live`);
    console.error(`paw: "${name}" is still starting — the message will be delivered by its durable inbox`);
    return r.id;
  }
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
  restartLive: RestartConsent | undefined,
  byName: boolean,
  budget: Budget,
): Promise<{ id: string; name: string }> {
  if (target.startsWith("@")) target = target.slice(1); // `@name` = that agent, like everywhere else
  const me = ep.card.id;
  const live = (name: string) =>
    ep.getRoster().filter((p) => p.card.name.toLowerCase() === name.toLowerCase() && p.card.id !== me).find((p) => p.status !== "offline");
  if (byName) return resolveByName(ep, space, server, target, model, restartLive, live, budget);

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
    const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: addr.cwd, model, brief: addr.brief, kind: addr.kind, restartLive }));
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
    const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder, model, restartLive }));
    return { id: await readyId(ep, name, r), name };
  }

  // An agent name: --name is meaningless here — a bare name already IS the address (an extra is minted
  // against a FOLDER, not another agent name).
  if (nameFlag)
    throw new Error(
      `paw: --name adds an extra agent to a FOLDER — combine it with a folder path (e.g. \`paw dm . "…" --name ${nameFlag}\`), ` +
        `not with an agent name "${target}"`,
    );
  return resolveByName(ep, space, server, target, model, restartLive, live, budget);
}

/** An agent NAME: prefer a live peer; wake a known-but-offline one via its registered folder. Never
 *  registers or spawns anything that isn't already a registered agent. */
async function resolveByName(
  ep: CotalEndpoint,
  space: string,
  server: string,
  target: string,
  model: string | undefined,
  restartLive: RestartConsent | undefined,
  live: (name: string) => { card: { id: string; name: string } } | undefined,
  budget: Budget,
): Promise<{ id: string; name: string }> {
  // An unread roster can't support an absence verdict (it said "not present" for a live agent).
  await ep.waitForPresenceSnapshot(Math.max(1000, Math.min(5000, left(budget))));
  const present = live(target);
  const home = folderForName(space, target);
  const want = target.toLowerCase();
  const verdict = absentVerdict({
    present: !!present,
    registered: !!home,
    onRoster: ep.getRoster().some((p) => p.card.name.toLowerCase() === want && p.card.id !== ep.card.id),
    inLedger: !present && !home && seenInLedger(readLedger(space), target, Date.now()),
  });
  if (verdict === "send") return { id: present!.card.id, name: present!.card.name };
  if (verdict === "wake") {
    const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name: target, cwd: home!, model, restartLive }));
    return { id: await readyId(ep, target, r), name: target };
  }
  if (verdict === "unknown") throw new Error(unknownAgentMessage(target));
  // Known (seen on this mesh) but not here right now — a broker redeploy / reconnect gap. Wait, bounded.
  console.error(errDim(waitingLine(target)));
  await waitForPeerId(ep, target, left(budget));
  const back = live(target);
  if (back) return { id: back.card.id, name: back.card.name };
  throw new Error(waitExpiredMessage({ name: target, server: budget.server, budgetMs: budget.ms, meshUp: ep.presenceView().state === "current" }));
}

/** POSIX single-quote a word for a copy-pasteable command line. Pure. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./#-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A just-launched agent whose process is alive but couldn't take the DM: say it is alive, that the DM
 *  was NOT sent, and the exact command that sends it once the agent is reachable (#96). Pure. */
export function notSentMessage(e: SeatAliveError, text: string): string {
  return `${e.message}\npaw: "${e.agent}" is alive (pid ${e.pids.join(", ")}) — the DM was NOT sent. Retry once it's reachable: paw dm ${e.agent}#${e.space} ${shellQuote(text)}`;
}

/** `ep.start()`, waiting out a DOWN mesh (refused/reset/DNS/timeout) within the budget. Auth and anything
 *  unrecognised still throw at once. Re-calling start() on the same endpoint is safe (startResilient). */
function startWithin(ep: CotalEndpoint, budget: Budget): Promise<void> {
  return retryUntil(() => ep.start(), {
    deadline: budget.deadline,
    retryable: (e) => classifyEndpointError(e) === "transient",
    onWait: () => console.error(errDim(waitingForMeshLine(budget.server))),
    expired: (e) => new Error(waitExpiredMessage({ server: budget.server, budgetMs: budget.ms, meshUp: false, lastError: e.message })),
  });
}

/** Send, tolerating the boot-race window and a reconnecting link. A just-spawned agent publishes PRESENCE
 *  before it runs `ensureStreams` (cotal endpoint boot order), so a send right after presence can hit a
 *  not-yet-created DM stream ("jetstream is not enabled"); a publish mid-reconnect times out or finds no
 *  `js`. Both are transient, so retry — at least 6 tries, and on until the wait budget ends. Every retry
 *  re-publishes the SAME drafted message (paw-owned id → JetStream `msgID` dedup), so an attempt whose ack
 *  was lost but that did land is not delivered twice. A non-transient error (bad recipient) fails fast. */
async function unicastResilient(ep: CotalEndpoint, id: string, text: string, budget?: Budget): Promise<void> {
  const bootRace = (m: string) => /jetstream is not enabled|no stream|stream not found|no responders|timeout|503/i.test(m);
  const msg = draftDm(ep, id, text);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6 || (budget && left(budget) > 0); attempt++) {
    try {
      await publishDraft(ep, msg);
      return;
    } catch (e) {
      lastErr = e;
      const err = e as Error;
      if (!bootRace(err.message) && classifyEndpointError(err) !== "transient") throw e;
      await sleep(800);
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
  /** Who approves the wake gate restarting a live-but-stuck agent; absent (web, tidy) ⇒ refused. */
  restartLive?: RestartConsent;
  /** `target` is an agent NAME only — never a folder/handle, whatever the cwd holds (paw cron). */
  byName?: boolean;
  /** Send as this non-human peer instead of "you" (paw cron fires as "cron"). */
  sender?: string;
  /** How long to wait for a down mesh / a known-but-absent agent (src/dm-wait.ts); default PAW_DM_WAIT or 20s. */
  waitMs?: number;
}): Promise<{ name: string; from: string }> {
  const { space, server, target, text, model, name: nameFlag, restartLive, byName = false, sender } = opts;
  const waitMs = opts.waitMs ?? dmWaitMs(undefined);
  const budget: Budget = { ms: waitMs, deadline: dmDeadline(waitMs), server };
  if (!byName) assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud

  // Pure sender: watch the roster to resolve/spawn the target, but don't register presence (the mailbox
  // beacon holds "you") and don't consume (never touch the durable inbox slot — that's `paw inbox`'s).
  const humanAuth = sender ? await senderEndpointAuth(space, sender) : await humanEndpointAuth(space, "operator");
  const creds = humanAuth.creds;
  const peerName = sender ?? humanPeer(space);
  const card = creds
    ? { name: peerName, kind: "endpoint" as const }
    : { name: peerName, kind: "endpoint" as const, id: sender ? stableSenderId(space, sender) : stableHumanId(space) };
  const ep = new CotalEndpoint({ space, servers: server, ...humanAuth, card, registerPresence: false, consume: false, watchPresence: true });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  try {
    await startWithin(ep, budget);
    const tgt = await resolveTarget(ep, space, server, target, model, nameFlag, restartLive, byName, budget).catch((e: unknown) => {
      if (e instanceof SeatAliveError) throw new Error(notSentMessage(e, text));
      throw e;
    });
    // Attachments are paths on THIS machine — an agent running elsewhere would be told about files it can't open.
    const files = attachedPlaceholders(text);
    const away = files.length ? runsElsewhere(space, tgt.name, ep.getRoster().find((p) => p.card.id === tgt.id)?.card) : undefined;
    if (away) throw new Error(`paw: ${elsewhereFiles(tgt.name, away, files)}`);
    await unicastResilient(ep, tgt.id, text, budget);
    return { name: tgt.name, from: ep.card.id };
  } finally {
    await ep.stop().catch(() => {});
  }
}

/**
 * Send `text` to the mesh id `id` as the non-human peer `sender` — no name resolution, no wake, no spawn.
 * The office bridge's roster mode uses it: it mirrors agents this machine doesn't host, and two of them can
 * share a name, so the id read off the roster is the only unambiguous address.
 */
export async function sendToPeerId(opts: { space: string; server: string; id: string; text: string; sender: string }): Promise<{ from: string }> {
  const { space, server, id, text, sender } = opts;
  const auth = await senderEndpointAuth(space, sender);
  const card = auth.creds ? { name: sender, kind: "endpoint" as const } : { name: sender, kind: "endpoint" as const, id: stableSenderId(space, sender) };
  const ep = new CotalEndpoint({ space, servers: server, ...auth, card, registerPresence: false, consume: false, watchPresence: false });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    await unicastResilient(ep, id, text);
    return { from: ep.card.id };
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
  const { target, words, space: spaceArg, server: serverArg, model, name: nameFlag, restart, waitFor } = parseArgs(argv);
  const waitMs = dmWaitMs(waitFor);
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? pawServer(space);

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
    throw new Error(`paw: usage — dm ${DM_TARGETS} "<message>" (or \`-\` to read it on stdin, or an image path to attach)`);

  // Checked BEFORE the attachments are staged: an ambiguous target must fail without having copied
  // files into the space first. sendAsYou re-checks, so every sender carries the guard.
  assertUnambiguousTarget(space, target);

  const attachments = peeled.paths.map((src, i) => stageAttachment(space, src, i + 1));
  const text = composeMessage(peeled.body, attachments);

  // Send AS the stable "you" so the reply is addressed to your durable inbox — through the SHARED
  // sender, so the web composer and this command cannot drift apart.
  const { name } = await sendAsYou({ space, server, target, text, model, name: nameFlag, restartLive: cliRestartConsent(restart), waitMs });
  console.log(`${c.cyan("→ " + name)}${c.dim(":")} ${text}`);
  console.log(c.dim("sent → read replies with `paw inbox`"));
}

const dmCommand: Command = {
  kind: "command",
  name: "dm",
  group: "Mesh",
  summary: "fire-and-forget DM to an agent — read replies with `paw inbox` (use `paw chat` for a live conversation)",
  usage: `dm ${DM_TARGETS}[#space] "<message>"|- [--name n] [--model m] [--restart] [--wait-for s] [--space s]   (x#space = x --space space; --restart = may restart it if it looks stuck, else a tty asks; --wait-for s = how long to wait for a known agent or the mesh to come back, default 20, env PAW_DM_WAIT)`,
  run: (a) => dm([...a.raw]),
};

registry.register(dmCommand);
