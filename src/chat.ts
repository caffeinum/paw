/**
 * `paw chat [folder|name]` — the headline. Joins the mesh as a PERSISTENT human peer (named by
 * HUMAN_PEER), auto-spawns the agent for a folder if it isn't already live, and opens an interactive
 * loop: what you type is direct-messaged to that agent, and its replies (and any other DMs) stream
 * back in real time. This is what closes the human↔agent loop that `paw dm` couldn't — `dm` is
 * fire-and-forget (a throwaway "send" peer that publishes and vanishes), so an agent had nowhere to
 * reply. Here the peer stays present and consuming, so cotal_dm(HUMAN_PEER, …) from the agent lands.
 *
 * Pure cotal underneath: a CotalEndpoint for presence/DMs, the manager control plane for spawn.
 * Registers a "chat" command into the cotal registry on import; bin/paw.ts ensures the mesh +
 * manager are up before it runs.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as readline from "node:readline";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  registry,
  type Command,
  type CotalMessage,
  type Delivery,
  type MessageMeta,
  type PresenceStatus,
} from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  canonicalDir,
  controlCreds,
  ensureAgentSpawned,
  folderForName,
  folderToName,
  resolveFolderAgent,
  listAgents,
  lookupFolderName,
  registerInstance,
  setFolderName,
  stableHumanId,
  startResilient,
  waitForPeerId,
  type Kind,
} from "./addressing.js";
import { isAddressHandle, resolveAddress } from "./address.js";
import { bashMessage, parseBang, runBash } from "./bash.js";
import { withManagerControl } from "./control.js";
import { advanceCursor } from "./cursor.js";
import {
  ATTACH_ICON,
  attachmentsRide,
  composeMessage,
  formatBytes,
  hasProse,
  isBig,
  peelLine,
  stageAttachment,
  stillThere,
  type Attachment,
} from "./images.js";
import { FRESH_SPAWN_MS, LIVE_AGENT_MS } from "./dm.js";
import { messageText as textOf } from "./feed.js";
import { dedupeRoster } from "./commands/who.js";
import { isContinueKey, joinLines, peelContinuation } from "./multiline.js";
import { resolveSpace } from "./lifecycle.js";
import { renderMarkdown } from "./markdown.js";
import { HUMAN_PEER } from "./names.js";
import {
  composePastes,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  makeBlock,
  PASTE_ICON,
  PasteScanner,
  pastePreview,
  shouldCollapse,
  submittedLineCount,
  type PasteBlock,
} from "./paste.js";

/** Tiny ANSI helpers — kept local so chat doesn't reach into cotal's CLI internals. */
const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  cyan: wrap("36"),
  green: wrap("32"),
  yellow: wrap("33"),
  magenta: wrap("35"),
  red: wrap("31"),
};

/** The channel a plain line broadcasts to when there's no sticky target yet (cotal's default room). */
const ROOM = "general";


function who(card: { name: string; role?: string }): string {
  return card.role ? `${card.name}/${card.role}` : card.name;
}

/** A dim " (Nh ago)" suffix for a message that isn't fresh, "" if it is. A DM redelivered from the
 *  durable inbox (an agent replied while you were away, or after you quit) is a REAL queued message,
 *  not a live reply — stamping its age stops a stale DM from reading as fresh chatter. */
function agoTag(ts: number): string {
  const ms = Date.now() - ts;
  if (!Number.isFinite(ts) || ms < 60_000) return ""; // fresh (or no usable ts) — no tag
  const m = Math.floor(ms / 60_000);
  if (m < 60) return c.dim(` (${m}m ago)`);
  const h = Math.floor(m / 60);
  if (h < 24) return c.dim(` (${h}h ago)`);
  return c.dim(` (${Math.floor(h / 24)}d ago)`);
}

/**
 * Should an arriving DM take over the sticky target?
 *
 * The ask: "if I receive a DM and my input is empty, switch to that agent — unless I've started
 * typing, then keep the one I was typing to." Answering a peer who just spoke is the overwhelmingly
 * common next act, and re-typing `@name` to do it is friction on the default path.
 *
 * What counts as "started typing" is wider than the text buffer, because retargeting under someone's
 * hands is how a message goes to the wrong agent:
 *  - HELD continuation lines are a message mid-composition that just hasn't hit Enter yet.
 *  - STAGED images/pastes are composed input too — you dropped a file FOR the agent on screen. This is
 *    the same misdirection `stagedFor` exists to prevent (an image landing on the wrong peer,
 *    2026-08-17); silently moving the target under staged attachments would reintroduce it by another
 *    door.
 *
 * And two kinds of DM must never retarget, because neither is someone talking to you NOW:
 *  - `historical` — a channel/backlog replay on join.
 *  - a STALE redelivery: JetStream re-delivers an unacked DM from a crashed session, so a days-old
 *    message can land mid-conversation. It's shown with an age tag for exactly this reason; letting it
 *    move the target would point your next line at whoever happened to speak last week. Same 60s
 *    freshness line `agoTag` draws, so what you SEE tagged as old is what refuses to steal focus.
 */
export function shouldFollowDm(s: {
  from: string;
  curName?: string;
  typed: string;
  held: number;
  staged: number;
  historical: boolean;
  ageMs: number;
}): boolean {
  if (s.historical || s.ageMs >= FOLLOW_FRESH_MS) return false;
  if (!s.from) return false;
  if (s.curName && s.from.toLowerCase() === s.curName.toLowerCase()) return false; // already there
  if (s.typed.trim() !== "" || s.held > 0 || s.staged > 0) return false; // mid-composition — hands off
  return true;
}

/** How fresh a DM must be to move the sticky target — the same line `agoTag` draws between a live
 *  reply and one stamped with an age. */
const FOLLOW_FRESH_MS = 60_000;

/**
 * What the positional MEANS, by its sigil. Three modes, because "who am I talking to" and "what am I
 * looking at" are different questions and the CLI only ever answered the first:
 *
 *   paw chat            → global: every conversation, plain lines broadcast to #general
 *   paw chat <folder>   → global, with that agent PRESELECTED as the sticky target
 *   paw chat @<agent>   → FILTERED: only that agent's DMs are shown, read, and sent to
 *   paw chat '#<chan>'  → that channel only, and plain lines post to it
 *
 * The sigils are the operator's existing vocabulary — `@name` and `#channel` already mean exactly this
 * INSIDE the repl, so the argument form is the same language rather than a second one. A bare name
 * stays global-with-a-target, which is what it has always done: the sigil is what opts INTO filtering,
 * so no existing invocation changes meaning.
 *
 * `#` must be quoted in a shell (it starts a comment unquoted) — that's the operator's business, but
 * an empty sigil is ours, and fails loud rather than silently meaning "global".
 */
export function parseChatTarget(raw?: string): { mode: "global" | "agent" | "channel"; target?: string } {
  if (raw === undefined) return { mode: "global" };
  if (raw.startsWith("@")) {
    const name = raw.slice(1).trim();
    if (!name) throw new Error('paw: `@` needs an agent name — e.g. `paw chat @research` (or `paw chat` for every conversation)');
    return { mode: "agent", target: name };
  }
  if (raw.startsWith("#")) {
    const channel = raw.slice(1).trim();
    if (!channel) throw new Error("paw: `#` needs a channel name — e.g. `paw chat '#general'` (quoted, or your shell eats it as a comment)");
    return { mode: "channel", target: channel };
  }
  return { mode: "global", target: raw };
}

/**
 * Does an arriving message belong on screen in this mode?
 *
 * Filtering is about what you SEE, and therefore about what counts as READ: a message the filter hides
 * must not advance the cursor, or a focused session would silently mark mail you never looked at. That
 * is the same mistake the shared inbox cursor makes across surfaces, one scope down.
 */
export function passesFilter(
  filter: { kind: "agent" | "channel"; name: string } | undefined,
  m: { kind: string; from?: string; channel?: string },
): boolean {
  if (!filter) return true;
  if (filter.kind === "agent") return m.kind === "dm" && (m.from ?? "").toLowerCase() === filter.name.toLowerCase();
  return m.kind === "channel" && m.channel === filter.name;
}

function statusBadge(status: PresenceStatus): string {
  if (status === "working") return c.yellow("● working");
  if (status === "waiting") return c.magenta("● waiting");
  if (status === "offline") return c.dim("○ offline");
  return c.dim("● idle");
}

/**
 * Pure, testable `@`-mention completer for the chat REPL. Node's readline passes the input up to the
 * cursor as `line`; we find a trailing `@partial` token (anywhere in the line — a mid-line `msg @te`
 * completes the `@te`, not the whole line), then return readline's `[matches, substringToReplace]`
 * tuple so a UNIQUE match auto-completes and MULTIPLE matches list. Matches are the `names` whose value
 * prefix-matches the partial CASE-INSENSITIVELY, formatted as `@name`, de-duped (case-insensitive,
 * first-wins) and sorted for stable output. A line with no trailing `@token` (a plain word) yields no
 * completions (`[[], line]`), so Tab never mangles ordinary text.
 */
export function completeMention(line: string, names: string[]): [string[], string] {
  const m = line.match(/@([A-Za-z0-9_-]*)$/);
  if (!m) return [[], line];
  const prefix = m[1].toLowerCase();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const n of names) {
    const key = n.toLowerCase();
    if (key.startsWith(prefix) && !seen.has(key)) {
      seen.add(key);
      hits.push(`@${n}`);
    }
  }
  hits.sort((a, b) => a.localeCompare(b));
  return [hits, `@${m[1]}`];
}

function parseArgs(argv: string[]): { space?: string; server?: string; target?: string; model?: string; name?: string; fresh: boolean; only: boolean } {
  const out: { space?: string; server?: string; target?: string; model?: string; name?: string; fresh: boolean; only: boolean } = { fresh: false, only: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--name") out.name = argv[++i]; // pin an EXTRA agent instance at the folder (multi-instance)
    else if (a === "--fresh") out.fresh = true; // birth a NEW agent (was `paw create`); fails loud if one exists
    else if (a === "--only") out.only = true; // FILTER to the target agent (the `@name` view, reached by folder/`.` instead of a name)
    else if (!a.startsWith("-") && out.target === undefined) out.target = a;
  }
  return out;
}

/**
 * The `--fresh` precondition — the former `paw create`, folded in as a flag. Births a BRAND-NEW agent
 * for a folder: it FAILS LOUD if one already exists (resume is the default chat path; reset is `paw rm`
 * then `--fresh`). This is the load-bearing guard from the `paw create evals` stale-resume incident.
 * Returns the resolved folder + its freshly-registered name; the caller spawns it (ensureAgentSpawned
 * mints a fresh persona+pin for the new name) and drops into the REPL.
 */
function freshTarget(space: string, target: string): { folder: string; name: string; brief?: string; kind?: Kind } {
  const addr = resolveAddress(target); // URL/web:/gh:/github:/repo@branch clones/creates; else a folder — throws clearly
  const folder = addr.cwd;
  const existing = lookupFolderName(space, folder);
  if (existing) {
    throw new Error(
      `paw: an agent already exists for ${folder} ("${existing}"). --fresh only births a NEW agent — ` +
        `drop the flag to resume it with \`paw chat ${target}\`, or \`paw rm ${existing}\` first to ` +
        `replace it with a fresh session.`,
    );
  }
  // Register a fresh name (honouring the address's name hint, e.g. a PR's "repo#N") → ensureAgentSpawned
  // mints a fresh pin. Thread the per-kind brief + kind marker through so a fresh URL agent is born with
  // the same persona a non-fresh URL resolve would give it.
  const name = addr.name ? setFolderName(space, folder, addr.name).name : folderToName(space, folder);
  return { folder, name, brief: addr.brief, kind: addr.kind };
}

async function chat(argv: string[]): Promise<void> {
  const { space: spaceArg, server: serverArg, target: rawTarget, model, name: nameFlag, fresh, only } = parseArgs(argv);
  // The sigil decides the MODE; the rest of setup then sees a plain target and behaves exactly as
  // before, so `@name` reuses the same spawn/resume path a bare name has always taken.
  const addressed = parseChatTarget(rawTarget);
  const target = addressed.mode === "channel" ? undefined : addressed.target;
  /** What this session shows, reads and (for a channel) sends to. Undefined = every conversation. */
  let filter: { kind: "agent" | "channel"; name: string } | undefined =
    addressed.mode === "agent" ? { kind: "agent", name: addressed.target! } : addressed.mode === "channel" ? { kind: "channel", name: addressed.target! } : undefined;
  /** Where a plain line broadcasts when there's no sticky target — the channel you opened, else #general. */
  const room = addressed.mode === "channel" ? addressed.target! : ROOM;
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? DEFAULT_SERVER;
  if (!fresh) assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder → fail loud (skipped under --fresh: the only interpretation there is a folder)

  // No target => start in broadcast mode: plain lines go to #general, and @name latches a sticky DM
  // (so you only pin a target once you actually mention someone). A target seeds that sticky target up
  // front: a <repo>@<branch> ref or a real directory => folder mode (spawn if absent); else a live
  // agent's name to focus.
  let folder: string | undefined;
  let name: string | undefined; // the initial sticky target; undefined = broadcast mode
  let brief: string | undefined; // per-kind persona body (web/pr); undefined ⇒ generic
  let kind: Kind | undefined; // persona kind marker (folder/worktree/repo/pr/web)
  if (fresh) {
    // --fresh births a NEW agent for the target folder, defaulting to the current directory (".") like
    // `paw chat <folder>` / `paw open` / the former `paw create` — so `cd repo && paw chat --fresh`
    // just works. freshTarget still fails loud if an agent already exists for that folder.
    if (nameFlag !== undefined) {
      // --name mints an EXTRA instance; a brand-new --name already cold-starts a fresh session (personas
      // + resume pins are name-keyed), so --fresh --name is redundant. Fail loud rather than silently
      // resume-or-reset — a fresh extra is `paw chat <folder> --name`, a reset is `paw rm` then that.
      throw new Error(
        `paw: --fresh can't be combined with --name. A brand-new \`paw chat <folder> --name ${nameFlag}\` already ` +
          `births a fresh EXTRA agent; to reset an existing one, \`paw rm ${nameFlag}\` then \`paw chat <folder> --name ${nameFlag}\`.`,
      );
    }
    ({ folder, name, brief, kind } = freshTarget(space, target ?? "."));
  } else if (nameFlag !== undefined && target === undefined) {
    // --name pins an EXTRA instance AT A FOLDER; with no explicit target that folder is the cwd (".",
    // like `paw chat --fresh`), never broadcast mode — so `cd repo && paw chat --name reviewer` works.
    folder = canonicalDir(".");
    name = registerInstance(space, folder, nameFlag);
  } else if (target !== undefined) {
    if (isAddressHandle(target)) {
      // A URL / web: / gh: / github: / <repo>@<branch> / bare host — resolveAddress clones/creates and
      // returns the cwd + kind + optional brief/name hint (all throw clearly on failure).
      const addr = resolveAddress(target);
      folder = addr.cwd;
      // --name pins a 2nd+ EXTRA instance at the resolved folder (agents.json), overriding the address's
      // own name hint and the folder default; otherwise honour the hint, else mint the folder default.
      name = nameFlag
        ? registerInstance(space, folder, nameFlag)
        : addr.name
          ? setFolderName(space, folder, addr.name).name
          : resolveFolderAgent(space, folder);
      brief = addr.brief;
      kind = addr.kind;
    } else {
      // Resolve the folder in its OWN try, so a registerInstance name-collision below throws straight
      // out instead of being mis-caught as "target isn't a folder" and reinterpreted as a bare name.
      let asFolder: string | undefined;
      try {
        asFolder = canonicalDir(target);
      } catch {
        asFolder = undefined;
      }
      if (asFolder !== undefined) {
        folder = asFolder;
        // --name → register a 2nd+ EXTRA agent at this folder (agents.json); no --name → the folder default.
        name = nameFlag ? registerInstance(space, folder, nameFlag) : resolveFolderAgent(space, folder);
      } else {
        // A bare NAME target. --name creates an EXTRA for a FOLDER, so it's meaningless here — fail loud.
        if (nameFlag !== undefined) {
          throw new Error(
            `paw: --name creates an EXTRA agent for a FOLDER and can't be combined with the agent name "${target}"; ` +
              `pass a folder, e.g. \`paw chat . --name ${nameFlag}\`.`,
          );
        }
        if (!/^[A-Za-z0-9_-]+$/.test(target)) {
          throw new Error(`paw: "${target}" is neither an existing folder nor a valid agent name`);
        }
        name = target;
        // A KNOWN agent addressed by name → resume it from its registered folder (same as the in-REPL
        // `@name` respawn below). Only a name with no registry entry stays live-only focus, so a truly
        // unknown name still fails loud rather than being auto-created out of nothing.
        const home = folderForName(space, target);
        if (home && existsSync(home)) folder = home;
      }
    }
  }

  // `--only` turns whatever the target resolved to into the FILTERED view (`paw chat @name`), reached
  // by FOLDER or `.` instead of by name — "show only this folder's agent" ("does `paw chat .` filter
  // to one agent? if not add `paw chat --only .`", operator 2026-09-09). `@name` already filters, so
  // --only there is a redundant no-op; a channel already filters itself, and broadcast has nothing to
  // filter TO, so both fail loud rather than silently doing nothing.
  if (only) {
    if (addressed.mode === "channel") throw new Error("paw: --only filters to an AGENT; a `#channel` session is already single-channel (drop --only)");
    if (!name) throw new Error("paw: --only needs an agent or folder target — e.g. `paw chat --only .` (this folder's agent) or `paw chat --only research`");
    filter = { kind: "agent", name };
  }

  // Persistent human peer. Open mesh => bare connection with a stable id (so replies sent while we
  // step away queue and redeliver). Auth mesh => the minted creds carry the identity.
  const creds = await controlCreds(space);
  const card = creds
    ? { name: HUMAN_PEER, kind: "endpoint" as const }
    : { name: HUMAN_PEER, kind: "endpoint" as const, id: stableHumanId(space) };
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    card,
    registerPresence: true,
    consume: true,
    watchPresence: true,
    // A channel session must actually SUBSCRIBE to that channel — the default is #general only, so
    // `paw chat '#team2027'` would otherwise sit filtered on traffic it never receives. Posting needs
    // no subscription (multicast is a publish), which is why only the read side needs this.
    ...(filter?.kind === "channel" ? { channels: [room] } : {}),
  });
  // Declared BEFORE ep.start() so the "error" handler (which calls emit) can't hit a temporal-dead-
  // zone ReferenceError if the endpoint emits "error" mid-startup — that would crash the process and
  // mask the real mesh error. emit guards on rl, so it's safe to run before readline exists.
  let rl: readline.Interface | undefined;
  let closing = false;

  // Visual rounds: a conversation reads as turns, so the transcript should look like turns. Every
  // emit declares which SIDE it belongs to, and a blank line is inserted whenever that side changes —
  // so your message, the ⏳/✓ receipts, and the reply group into one block, with air before the next.
  // Tracking the side (rather than blank-lining every line) keeps a burst of roster/presence noise
  // tight instead of double-spacing it.
  type Side = "you" | "peer" | "sys";
  let lastSide: Side | undefined;
  /** Whether the previous emit already ended in a blank line, so the next one doesn't add a second. */
  let trailingBlank = false;
  /** Continuation lines of a multi-line message line up under the first, so a 30-line reply reads as
   *  one block instead of colliding with the left edge where the next prompt will be. */
  const PAD = "  ";
  function emit(s: string, side: Side = "sys", tight = false): void {
    // Once we're shutting down (EOF/SIGINT/quit) the readline is closed — touching it throws
    // ERR_USE_AFTER_CLOSE. Still write the message, just skip the prompt redraw.
    if (rl && !closing) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
    const gap = !trailingBlank && lastSide !== undefined && side !== lastSide ? "\n" : "";
    // Anything that belongs to the conversation closes with a blank line, because emit ALWAYS redraws
    // the prompt right after — so this is the air before the prompt. `sys` noise (presence churn,
    // roster listings) is excluded so a burst of it stays tight instead of double-spaced.
    // `tight` suppresses the trailing blank for lines that are part of ONE growing thing — the held
    // lines of a multi-line message. Without it each line became its own airy block and three typed
    // lines sprawled over eight, which reads as three events rather than one message taking shape.
    const tail = side === "sys" || tight ? "" : "\n";
    trailingBlank = tail !== "";
    lastSide = side;
    process.stdout.write(gap + s.split("\n").join(`\n${PAD}`) + "\n" + tail);
    if (rl && !closing) rl.prompt(true);
  }
  ep.on("error", (e: Error) => emit(c.red("! " + e.message)));
  await startResilient(ep);
  const me = ep.card.id;

  // Resolve a peer by name, preferring a LIVE one. Restarting an agent (e.g. re-adopt) leaves stale
  // OFFLINE presence entries under the same name until they TTL out; without this `@name`/`/dm` could
  // pick a ghost and refuse to send even though a live agent is right there.
  /** An id → agent name, from the live roster. Unknown ids stay ids — never invent a name. */
  const rosterName = (id?: string): string | undefined =>
    id ? ep.getRoster().find((p) => p.card.id === id)?.card.name : undefined;

  const findPeer = (to: string) => {
    const peers = ep.getRoster().filter((p) => p.card.name.toLowerCase() === to.toLowerCase() && p.card.id !== me);
    return peers.find((p) => p.status !== "offline") ?? peers[0];
  };

  // The current sticky DM target: plain lines go here once set. Undefined => broadcast mode (plain
  // lines multicast to #general). `@name` latches it; a positional target seeds it below.
  let curId: string | undefined;
  let curName: string | undefined;

  // If a target was named, resolve it now: spawn the folder's agent, or focus a live agent by name.
  // With no target we skip straight to broadcast mode — nothing is spawned.
  let spawned = false;
  if (name !== undefined) {
    // SAY something before the wait. Resolving a target can take tens of seconds — a cold claude boot,
    // or an agent already `starting` — and until now the terminal printed NOTHING for the whole time:
    // no banner, no cursor, no hint. The operator's report was "why does it take so long to load",
    // which is really two complaints, and the silence is the half paw controls. A wait you can see is
    // a wait; a blank screen is a hang. (Written straight to stdout: the readline that owns `emit`
    // isn't up yet.)
    process.stdout.write(c.dim(`  connecting to ${name}…\n`));
    try {
      if (folder) {
        const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder, model, brief, kind }));
        spawned = r.spawned;
        // A fresh spawn is the genuinely slow path (a cold claude, resuming a long session). Naming it
        // turns "it hung" into "it is doing the slow thing", which is the difference between waiting
        // and Ctrl-C — and a Ctrl-C here used to leave the spawn lock behind (see src/lock.ts).
        if (r.spawned) process.stdout.write(c.dim(`  cold start — this can take up to ${Math.round(FRESH_SPAWN_MS / 1000)}s\n`));
        curId = r.id ?? (await waitForPeerId(ep, name, r.spawned ? FRESH_SPAWN_MS : LIVE_AGENT_MS));
      } else {
        curId = await waitForPeerId(ep, name, 5000);
      }
    } catch (e) {
      await ep.stop().catch(() => {});
      throw e;
    }
    if (!curId) {
      await ep.stop().catch(() => {});
      throw folder
        ? new Error(`paw: agent "${name}" isn't reachable on the mesh — try \`paw down\` then retry`)
        : new Error(`paw: no live agent named "${name}" — start one with \`paw chat <folder>\``);
    }
    curName = name;
  }

  // Attachments staged but not yet sent. A line that is ONLY paths (the shape you get from dragging
  // an image in and hitting Enter) stages them and does NOT send — otherwise you'd fire a message
  // with an empty body, and a multi-file drop (some terminals join paths with newlines, which
  // readline sees as several separate lines) would fire one empty message PER file. They flush with
  // the next line that actually has prose, as a single message.
  const pending: Attachment[] = [];

  /** Multi-line pastes captured but not yet sent — same staging contract as `pending` images: the
   *  placeholder sits in the line you're editing, the payload rides along on the next send. */
  const pastes: PasteBlock[] = [];

  /** The prompt reflects where plain lines go right now: a sticky target, or the broadcast room —
   *  plus what's riding along with your next message. */
  /** Command mode, entered by typing `!` on an empty line with an agent targeted (the web composer's
   *  `state.bang`). The `!` is CONSUMED — it is the mode now, shown by the prompt, not a character in
   *  what you typed — so the line you send and the line you see agree. One command per entry. */
  let bang = false;
  const bangPrompt = (): string => {
    const folder = curName ? folderForName(space, curName) : undefined;
    return `${c.yellow("$")} ${c.dim(`runs in ${folder ? folder.replace(homedir(), "~") : curName} → then tells ${curName}`)}${c.yellow(">")} `;
  };
  const promptFor = (): string => {
    if (bang && curName) return bangPrompt();
    const where = curName ? `${HUMAN_PEER} → ${curName}${filter?.kind === "agent" ? " (only)" : ""}` : `${HUMAN_PEER} → #${room}`;
    const badges = [pending.length ? `${pending.length} img` : "", pastes.length ? `${pastes.length} pasted` : ""].filter(Boolean);
    return c.dim(badges.length ? `${where} [${badges.join(" · ")}]> ` : `${where}> `);
  };

  /**
   * A `@name` that never sent leaves its attachments STAGED — and the sticky target is still whoever it
   * was before. The next plain line then carries an image staged for one agent to a different one, with
   * nothing on screen to say so: the operator drops an image, types `@canary-env-52 …`, the respawn
   * fails, they type `hey`, and the image lands on `research` (reported 2026-08-17).
   *
   * They are deliberately NOT dropped — re-dragging a file to recover from someone else's failed spawn
   * is a worse trade than a warning. So the fix is to make the carry-over impossible to MISS: say what
   * is still staged and, precisely, where the next line would send it.
   */
  const warnStranded = (attempted: string, body: string): void => {
    if (!pending.length && !pastes.length) return;
    stagedFor = attempted; // bind them, so the next line to someone else cannot take them along
    const what = [pending.length ? `${pending.length} image${pending.length === 1 ? "" : "s"}` : "", pastes.length ? `${pastes.length} paste${pastes.length === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(" + ");
    emit(c.yellow(`⚠ nothing was sent to ${attempted}, so ${what} ${pending.length + pastes.length === 1 ? "is" : "are"} still staged`));
    emit(
      c.dim(
        curName
          ? `  the next line goes to ${curName} and would take ${pending.length + pastes.length === 1 ? "it" : "them"} along — /noimg, /nopaste, or @${attempted} to retry`
          : `  /noimg, /nopaste, or @${attempted} to retry`,
      ),
    );
    if (body) emit(c.dim(`  your message is not lost, it just wasn't sent: ${body.length > 60 ? `${body.slice(0, 60)}…` : body}`));
  };

  /** Compose the outgoing text from a typed body + the staged attachments, then clear the pending
   *  list. Every send site goes through this, so an attachment can never be silently left behind.
   *  A staged file that vanished between staging and send is dropped with a loud line — never
   *  announced as a path the agent would fail to Read. */
  /**
   * Who the staged attachments were meant for, when a `@name` send FAILED with them staged.
   *
   * Normally attachments have no intended recipient — you drop a file and type a message to whoever you
   * are already talking to. But a failed `@name` leaves them staged while the sticky target is still
   * the PREVIOUS agent, and the next plain line would then carry an image meant for one agent to a
   * different one. Binding them is what makes that impossible rather than merely announced.
   */
  let stagedFor: string | undefined;

  const flush = (body: string, target?: string): string => {
    if (!pending.length && !pastes.length) return body;
    // Bound to someone else? HOLD them. Sending the body alone is the right half to get wrong: the
    // words were typed for THIS agent, the attachment was not.
    if (!attachmentsRide(stagedFor, target)) {
      emit(c.yellow(`⚠ held back the attachment staged for ${stagedFor} — this line went to ${target} without it`));
      emit(c.dim(`  @${stagedFor} to send it there · /noimg · /nopaste to drop it`));
      return body;
    }
    stagedFor = undefined;
    const live = pending.filter((a) => {
      if (stillThere(a.path)) return true;
      emit(c.red(`! ${a.placeholder} ${a.path} disappeared before sending — dropped`));
      return false;
    });
    // Pastes attach to the body first (the payload follows the text), THEN the image lines — so an
    // image announcement is never buried under a 200-line paste block.
    const composed = composeMessage(composePastes(body, pastes), live);
    pending.length = 0;
    pastes.length = 0;
    rl?.setPrompt(promptFor());
    return composed;
  };

  // After you DM someone, note who you're awaiting a reply from + when. Gives an immediate "sent,
  // waiting…" confirmation (the typed line alone doesn't prove it went out) and lets the reply be
  // stamped with how long it took — so a long-running agent doesn't feel like silence.
  let awaiting: { name: string; at: number; picked: boolean } | undefined;
  const markWaiting = (to: string): void => {
    awaiting = { name: to, at: Date.now(), picked: false };
    emit(c.dim(`⏳ waiting for ${to}…`), "you");
  };

  // Banner.
  if (filter?.kind === "channel") {
    // A channel session says so plainly: what you see, and where a plain line goes, are both this one
    // channel — an operator who thinks they are in the global view would post to the wrong place.
    process.stdout.write(
      `\n${c.bold("  🐾 paw chat")}\n\n` +
        `     channel: ${c.cyan("#" + room)}  ${c.dim("(subscribed)")}\n` +
        `     showing: ${c.dim("this channel only — DMs stay in `paw inbox`")}\n\n` +
        `     ${c.dim(`type to post to #${room} · @name DMs someone · /who · /ps · /quit`)}\n\n`,
    );
  } else if (curName) {
    const where = folder ? c.dim(folder) : c.dim("(by name)");
    const state = spawned ? c.green("spawned a new agent · starting up") : c.green("reusing live agent");
    process.stdout.write(
      `\n${c.bold("  🐾 paw chat")}\n\n` +
        `     agent:  ${c.cyan(curName)}  ${where}\n` +
        `     status: ${state}\n\n` +
        (filter?.kind === "agent" ? `     showing: ${c.dim("this agent only — other DMs stay in `paw inbox`")}\n\n` : "") +
        `     ${c.dim("type to message it · !cmd runs in its folder · @name switches target · #channel broadcasts · /who · /ps · /quit")}\n` +
        `     ${c.dim("drag an image in for [Image #1] · paste multiple lines for [Pasted text #1]")}\n` +
        `     ${c.dim("alt+enter (or end a line with \\\\) for a new line, not a send")}\n` +
        `     ${c.dim("/imgs · /noimg · /paste · /nopaste")}\n\n`,
    );
  } else {
    const live = ep.getRoster().filter((p) => p.card.id !== me);
    const roster = live.length
      ? `${live.length} live: ${live.map((p) => c.cyan(p.card.name)).join(c.dim(" · "))}`
      : c.dim("no agents live yet — `paw chat <folder>` spawns one");
    process.stdout.write(
      `\n${c.bold("  🐾 paw chat")}  ${c.dim('— joined the mesh as "you"')}\n\n` +
        `     ${roster}\n\n` +
        `     ${c.dim(`type to broadcast to #${ROOM} · @name starts a sticky DM · !cmd runs in its folder · #channel · /who · /ps · /quit`)}\n` +
        `     ${c.dim("drag an image in for [Image #1] · paste multiple lines for [Pasted text #1]")}\n` +
        `     ${c.dim("alt+enter (or end a line with \\\\) for a new line, not a send")}\n` +
        `     ${c.dim("/imgs · /noimg · /paste · /nopaste")}\n\n`,
    );
  }

  // Incoming traffic. meta.kind is the trustworthy "how was this addressed" signal (from the NATS
  // subject), not the forgeable payload routing fields.
  /** Header + body, markdown-rendered. Agents write markdown everywhere else, so printing it raw is
   *  just noise; `**bold**` and un-delimited code blocks are the common case. A one-line body stays
   *  on the header line (a short reply shouldn't cost two rows); anything longer becomes a block
   *  underneath, which emit() then indents. */
  const said = (header: string, text: string): string => {
    const lines = renderMarkdown(text);
    return lines.length <= 1 ? `${header} ${lines[0] ?? ""}` : `${header}\n${lines.join("\n")}`;
  };

  ep.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
    const text = textOf(m);
    // meta.historical marks messages replayed from a channel's backlog on join (e.g. #general
    // catch-up) — tag them so they don't read as live chatter.
    const tag = meta.historical ? c.dim("(catch-up) ") : "";
    // Any message — DM or channel — can arrive stale: JetStream redelivers a copy that a prior
    // (crashed/quit) session never acked, after AckWait (~30s). Stamp its age so a redelivered old
    // broadcast/DM never reads as a live reply. Empty for anything sent in the last minute.
    const age = agoTag(m.ts);
    // Filtered session? Anything outside it is NOT shown and NOT marked read — hiding a message and
    // then advancing the cursor past it would silently consume mail you never saw. It is announced in
    // one dim line so nothing vanishes without trace, and it stays in `paw inbox` to be read for real.
    if (!passesFilter(filter, { kind: meta.kind, from: m.from?.name, channel: (m as { channel?: string }).channel })) {
      const what = meta.kind === "dm" ? `dm from ${m.from.name}` : `#${(m as { channel?: string }).channel ?? "?"}`;
      emit(c.dim(`⋯ ${what} hidden by this session's filter — \`paw inbox\` to read it`));
      d.ack();
      return;
    }
    if (meta.kind === "dm") {
      const from = m.from.name;
      // If this is the reply we were waiting on, clear the wait and note the round-trip time.
      let took = "";
      if (awaiting && !meta.historical && from.toLowerCase() === awaiting.name.toLowerCase()) {
        took = c.dim(` (${Math.max(1, Math.round((Date.now() - awaiting.at) / 1000))}s)`);
        awaiting = undefined;
      }
      if (curName && from.toLowerCase() === curName.toLowerCase()) emit(said(`${tag}${c.cyan(from)}${age}${took}${c.dim(":")}`, text), "peer");
      else emit(said(`${tag}${c.magenta("(DM)")} ${c.bold(from)}${age}${took}${c.dim(":")}`, text), "peer");
      advanceCursor(space, m.ts); // shown here = seen, so `paw inbox` won't re-surface it as new
      // Follow the conversation: an empty input means you have not started a reply to anyone else, so
      // the next thing you type is almost certainly for whoever just spoke. Announced, never silent —
      // a target that moves without saying so is how a line goes to the wrong agent.
      if (!filter && shouldFollowDm({ from, curName, typed: rl?.line ?? "", held: held.length, staged: pending.length + pastes.length, historical: !!meta.historical, ageMs: Date.now() - m.ts })) {
        const peer = findPeer(from);
        curId = peer?.card.id ?? m.from.id;
        curName = peer?.card.name ?? from;
        // Redraw the prompt with the NEW target before announcing it. emit() re-prompts with rl's
        // CURRENT string, so without this the label kept saying `you → <old>` while sends went to the
        // new target — the visible prompt lying about where the next line goes (reported 2026-08-25,
        // screenshot: "replying to evals" announced, prompt stuck on research, receipts waiting for
        // evals). The @name path already did this; the follow path is the same act and needs the same line.
        rl?.setPrompt(promptFor());
        emit(c.dim(`↪ replying to ${curName} (@name to change)`));
      }
    } else if (meta.kind === "anycast") {
      emit(said(`${tag}${c.yellow("(@" + ((m as { toService?: string }).toService ?? "?") + ")")} ${m.from.name}${age}${c.dim(":")}`, text), "peer");
    } else {
      emit(said(`${tag}${c.dim("#" + ((m as { channel?: string }).channel ?? "?"))} ${m.from.name}${age}${c.dim(":")}`, text), "peer");
    }
    d.ack(); // surfaced = recorded
  });

  /**
   * Every `paw chat` runs as the SAME peer ("you"), so a message one session sends is addressed to the
   * agent, not to "you" — the other open sessions never receive it and their transcripts silently
   * diverge. Tap the space (a plain NATS subscribe: ephemeral, no durable consumer, so it cannot
   * contend with the inbox) and surface anything sent by "you" that THIS process didn't send.
   *
   * `ownIds` makes that exact rather than heuristic: unicast/multicast mint a uuid per message and
   * hand it back, so "mine" is an id lookup, not a text-and-timestamp guess.
   */
  ep.tap((_subject, m: unknown) => {
    // A space-wide tap also sees non-message frames (control replies are bare {ok,data} with no
    // `from`), and core does not try/catch this handler — an unguarded deref kills the feed for good.
    const msg = m as CotalMessage & { to?: string; channel?: string };
    if (!msg || typeof msg !== "object" || !msg.from || !msg.id) return;
    if (msg.from.id !== me) return; // another peer entirely — the normal message handler owns that
    // NOT-in-ownIds is not yet proof it came from elsewhere: the broker echoes a publish back to our
    // own tap before `unicast` has returned the id we record. Wait out any in-flight send (plus a
    // short grace for the resolve itself) and re-check. Deciding immediately is what made a session
    // label its OWN message "(other session)".
    const decide = (attempt: number): void => {
      if (ownIds.has(msg.id)) return; // ours after all — the send resolved while we waited
      if (attempt < 25 && (sending > 0 || attempt < 3)) {
        setTimeout(() => decide(attempt + 1), 100);
        return;
      }
      try {
        const body = textOf(msg);
        if (!body) return;
        const toName = msg.channel ? undefined : rosterName(msg.to);
        // A FILTERED session must filter this too. The cross-session echo comes through `ep.tap`, not
        // the message handler, so `passesFilter` never saw it — and `paw chat @agent` showed every line
        // you typed to every OTHER agent from another window, under a banner promising "this agent
        // only" (reported 2026-08-20). That is not merely untidy: those lines can carry anything you
        // sent elsewhere, including secrets meant for one agent, into a view you opened for another.
        if (!passesFilter(filter, { kind: msg.channel ? "channel" : "dm", from: toName, channel: msg.channel })) return;
        const label = msg.channel
          ? c.dim(`#${msg.channel}`)
          : c.cyan(toName ?? (msg.to ? msg.to.slice(0, 8) : "?"));
        emit(said(`${c.dim("↗ you →")} ${label}${c.dim(" (other session):")}`, body), "you");
      } catch {
        /* a render failure must never abort the tap iterator */
      }
    };
    decide(0);
  });

  ep.on("presence", (ev) => {
    const card = ev.presence.card;
    if (card.id === me) return;
    if (ev.type === "join") emit(`${c.green("→")} ${who(card)} joined ${statusBadge(ev.presence.status)}`);
    else if (ev.type === "offline") emit(c.dim(`← ${who(card)} went offline`));
    else if (
      awaiting &&
      !awaiting.picked &&
      ev.presence.status === "working" &&
      card.name.toLowerCase() === awaiting.name.toLowerCase()
    ) {
      // The agent we're waiting on flipped to working — an explicit "got it, on it" receipt for your
      // message (otherwise the only feedback is the final reply, which can be minutes away).
      awaiting.picked = true;
      emit(`${c.green("✓")} ${card.name} picked it up${ev.presence.activity ? c.dim(" — " + ev.presence.activity) : c.dim(" — working…")}`, "you");
    } else
      emit(
        `${c.dim("•")} ${who(card)} ${statusBadge(ev.presence.status)}` +
          (ev.presence.activity ? c.dim(" — " + ev.presence.activity) : ""),
      );
  });

  // Tab-complete `@name` mentions. Names are the UNION of the live roster (present peers) + paw's
  // folder→name registry (every KNOWN agent, live or offline) — so you can `@`-wake a durable agent
  // (e.g. `@team2027-research`) that isn't present, matching the in-REPL respawn-a-known-agent
  // behavior. completeMention (pure/tested) finds the `@partial` under the cursor anywhere in the line.
  const completer = (line: string): [string[], string] => {
    const roster = ep.getRoster().filter((p) => p.card.id !== me).map((p) => p.card.name);
    const registered = listAgents(space).map((a) => a.name);
    return completeMention(line, [...roster, ...registered]);
  };

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptFor(),
    completer,
  });

  // LIVE placeholder swap: the moment a pasted/dragged path lands in the line buffer, stage it and
  // rewrite what you're looking at to `[Image #1]` — so the prompt shows what you're SENDING, not a
  // 90-char temp path (this is the Claude Code/OpenCode feel). Cmd-V is invisible to us — the
  // terminal consumes it and writes the path in as ordinary keystrokes — so there's no paste event
  // to hook; we watch the buffer instead.
  //
  // A SECOND "data" listener alongside readline's own does not steal bytes (readline keeps its
  // listener; both receive the chunk). `setImmediate` is required: at "data" time readline hasn't
  // folded the chunk into `rl.line` yet. Ctrl-U + Ctrl-K clears the line through readline's own
  // editing ops, so it redraws correctly with the (possibly re-widthed) prompt instead of us
  // hand-rolling cursor math.
  //
  // The Enter-time peel in the line handler REMAINS the correctness backstop — if this misses a
  // burst, or stdin isn't a TTY (piped input, tests), the path is still peeled on submit.
  // MULTI-LINE PASTE (see src/paste.ts for the full mechanism). readline is line-oriented, so a
  // 40-line paste used to fire 40 `line` events and send 40 separate messages. Bracketed paste (DEC
  // 2004) is the only honest "this was pasted" signal — a debounce would be a guess — so enable it
  // and read the markers from a PREPENDED data listener, which sees the chunk before readline does.
  // readline silently drops the markers, then fires exactly one line event per newline in the
  // payload and leaves the trailing segment in `rl.line`; the line handler swallows exactly that
  // many, then rewrites the buffer to `[Pasted text #N]` — the same Ctrl-U/Ctrl-K rewrite the image
  // swap uses. readline itself is never touched, so editing/history/completion are unaffected.
  /** Ids of messages THIS process sent. `unicast`/`multicast` mint a uuid per message and return it,
   *  so the space tap below can tell "I sent this" from "another `paw chat` sent this" exactly —
   *  no text/timestamp heuristics. */
  const ownIds = new Set<string>();
  /** Sends this process has started but not yet recorded. The id only exists once `unicast` RETURNS,
   *  but the broker has already echoed the message to our own tap by then — so "not in ownIds" is not
   *  yet evidence of "not mine" while this is above zero. */
  let sending = 0;
  const mine = <T extends { id?: string }>(m: T): T => {
    if (m?.id) ownIds.add(m.id);
    return m;
  };
  /** Wrap a send so the in-flight window is visible to the tap. */
  const sent = async <T extends { id?: string }>(p: Promise<T>): Promise<T> => {
    sending++;
    try {
      return mine(await p);
    } finally {
      sending--;
    }
  };

  const scanner = new PasteScanner();
  /** Set by the raw listener the instant a paste lands; consumed by the line handler. `first` is the
   *  payload's first line, used to recover whatever you had ALREADY typed before pasting (readline
   *  submits them fused as one line). */
  let swallow: { remaining: number; block: PasteBlock; first: string; prefix?: string } | undefined;
  /** True from a paste's START marker until its END marker — the window in which readline may submit
   *  payload lines we haven't been able to identify yet (see the chunking note in the data listener). */
  let pasteOpen = false;
  /** Payload lines readline submitted while `pasteOpen`, so the post-payload swallow doesn't recount them. */
  let pasteFired = 0;
  /** The FIRST line readline submitted during an open paste, verbatim. It is `<whatever you had
   *  typed>` + `<the payload's first line>` fused, and the two can only be separated once the payload
   *  is known — which is why it is kept raw rather than split on the spot. */
  let pasteFirstRaw: string | undefined;
  /** Lines held by a continuation (Alt/Shift/Ctrl+Enter, or a trailing `\\`), waiting for the Enter that
   *  finishes the message. Typing multi-line had no answer at all before: you got one line, or you sent
   *  three messages. See src/multiline.ts. */
  let held: string[] = [];

  /** Take what's typed onto the held stack and clear the line, so the next one starts fresh. */
  const holdLine = (line: string): void => {
    if (!rl || closing) return;
    held.push(line);
    rl.write(null, { ctrl: true, name: "u" }); // same buffer rewrite the paste staging uses
    rl.write(null, { ctrl: true, name: "k" });
    // Clearing the buffer also erases what you just typed, so REPRINT it. Without this the line you
    // continued from simply vanishes and you are composing a message you can no longer see — the
    // opposite of what a multi-line editor is for.
    //
    // TIGHT, and on the same rail the paste preview uses: these lines are one message taking shape, so
    // they should read as a block. Spacing each one as its own event turned three typed lines into
    // eight lines of screen.
    emit(`${c.dim("│")} ${line}`, "you", true);
  };

  /** Park a captured paste: placeholder into the line you're editing, preview onto the screen. */
  const stagePaste = (block: PasteBlock, prefix: string): void => {
    if (!rl || closing) return;
    pastes.push(block);
    rl.write(null, { ctrl: true, name: "u" }); // drop the paste's trailing segment…
    rl.write(null, { ctrl: true, name: "k" }); // …from both sides of the cursor
    rl.setPrompt(promptFor());
    emit(`${PASTE_ICON} ${block.placeholder} ${c.dim(`${block.lines} line${block.lines === 1 ? "" : "s"}, ${formatBytes(block.chars)}`)}`, "you");
    for (const line of pastePreview(block)) emit(c.dim(`  │ ${line}`), "you");
    rl.write(`${prefix}${block.placeholder} `);
  };

  /** Down-arrow. readline maps it to history-next, which on an empty line with nothing ahead does
   *  nothing at all — so the keystroke is free to mean something useful. */
  const DOWN = "\x1b[B";
  const UP = "\x1b[A";
  const ESC = "\x1b";

  /** The agents you could talk to: live peers first, then registered-but-offline ones (a DM wakes
   *  those from their pin). Marks the current sticky target so the list answers "who am I talking
   *  to?" as well as "who is there?". */
  /**
   * The agent picker: ↓ on an empty line opens it, typing FILTERS it, ↑/↓ move the selection, Enter
   * picks. Built on readline rather than against it — the selection IS the line buffer (`@name`), so
   * Enter needs no interception at all: it flows through the existing `@name` handler, which already
   * latches the sticky target and even respawns a known-but-offline agent.
   *
   * Why not take the keyboard over properly: pausing readline to own stdin would also stop the data
   * events this needs, and re-implementing editing/history/completion to get one widget is a bad
   * trade. Filtering off `rl.line` costs nothing and keeps every existing key working.
   */
  let picking = false;
  let picked = 0; // index into the last filtered list
  let drawn = 0; // lines currently occupied by the picker, so a redraw can erase exactly them
  /** The filter, held HERE rather than read back from `rl.line`. readline handles ↑/↓ as
   *  history-prev/next and REPLACES the buffer with a past line before our handler runs — reading the
   *  filter from it then saw something that no longer looked like `@name` and closed the picker, so
   *  the arrows cycled history and the marker never moved. Our own state cannot be clobbered. */
  let pickFilter = "";

  /** Every agent worth offering: live peers first (they answer now), then registered-but-offline. */
  const pickerAgents = (): Array<{ name: string; note: string }> => {
    const live = ep
      .getRoster()
      .filter((p) => p.card.id !== me && p.status !== "offline")
      .map((p) => ({ name: p.card.name, note: statusBadge(p.status) }));
    const seen = new Set(live.map((a) => a.name.toLowerCase()));
    const offline = listAgents(space)
      .map((a) => a.name)
      .filter((nm) => !seen.has(nm.toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((nm) => ({ name: nm, note: c.dim("○ offline — a message wakes it") }));
    return [...live, ...offline];
  };

  /** Re-read the filter from the buffer after a TYPED key (never after an arrow). Returns false when
   *  the line stopped being a bare mention, which is the picker's cue to close. */
  const syncFilter = (): boolean => {
    const m = (rl?.line ?? "").match(/^@([A-Za-z0-9_-]*)$/);
    if (!m) return false;
    pickFilter = m[1];
    return true;
  };

  /** The agents matching the current filter, in display order. */
  const pickerHits = (): Array<{ name: string; note: string }> => {
    const all = pickerAgents();
    return pickFilter ? all.filter((a) => a.name.toLowerCase().includes(pickFilter.toLowerCase())) : all;
  };

  /** Erase the rows the picker drew last time, leaving the cursor where the list should start. */
  const erasePicker = (): void => {
    if (!drawn || !rl || closing) return;
    readline.cursorTo(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -drawn);
    readline.clearScreenDown(process.stdout);
    drawn = 0;
  };

  const closePicker = (): void => {
    if (!picking) return;
    erasePicker();
    picking = false;
    picked = 0;
    if (rl && !closing) rl.prompt(true);
  };

  /** Draw (or redraw) the list above the prompt, with the selection marked. */
  const drawPicker = (): void => {
    if (!rl || closing) return;
    const hits = pickerHits();
    picked = hits.length ? Math.min(picked, hits.length - 1) : 0;

    erasePicker();
    const rows = [
      c.dim(hits.length ? `agents — ↑↓ select · Enter picks · keep typing to filter` : `no agent matches "${pickFilter}"`),
      ...hits.map((a, i) => {
        const marker = i === picked ? c.green("▸") : " ";
        const name = i === picked ? c.bold(c.cyan(a.name)) : c.cyan(a.name);
        return `  ${marker} ${name} ${a.note}${a.name === curName ? c.dim("  (current)") : ""}`;
      }),
    ];
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(rows.join("\n") + "\n");
    drawn = rows.length;
    rl.prompt(true);
  };

  /** Move the selection and rewrite the buffer to the selected name, so Enter submits `@<name>`
   *  through the ordinary path. The buffer IS the selection — nothing else has to know about it. */
  const movePicker = (delta: number): void => {
    if (!rl || closing) return;
    // Deliberately does NOT consult rl.line: readline has just overwritten it with a history entry.
    const hits = pickerHits();
    if (!hits.length) return;
    picked = (picked + delta + hits.length) % hits.length;
    // Rewrite through readline's own editing ops so the prompt redraws correctly.
    rl.write(null, { ctrl: true, name: "u" });
    rl.write(null, { ctrl: true, name: "k" });
    rl.write(`@${hits[picked].name}`);
    drawPicker();
  };

  const openPicker = (): void => {
    if (!rl || closing || picking) return;
    if (!pickerAgents().length) {
      emit(c.dim("(no agents yet — `paw chat <folder>` births one)"));
      return;
    }
    picking = true;
    picked = 0;
    drawn = 0;
    pickFilter = "";
    rl.write("@"); // the filter lives in the line buffer, so the completer and Enter both still work
    drawPicker();
  };

  if (process.stdin.isTTY) {
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      // Command mode (mirrors the web composer, 2026-09-09): `!` as the FIRST character of a line with
      // an agent targeted flips the prompt to `$ runs in <folder> → then tells <agent>` and is consumed;
      // Backspace on the empty command line leaves it (the reverse of the key that entered it), Esc
      // leaves it keeping the text. Checked after readline folds the keystroke in (setImmediate) —
      // except Backspace, which must be read BEFORE readline eats it against an already-empty buffer.
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!rl || closing || scanner.pasting || picking) return;
      if (bang && (raw === "\x7f" || raw === "\b") && rl.line === "") {
        bang = false;
        rl.setPrompt(promptFor());
        rl.prompt(true);
        return;
      }
      if (bang && raw === ESC) {
        bang = false;
        setImmediate(() => { rl!.setPrompt(promptFor()); rl!.prompt(true); });
        return;
      }
      if (!bang && curName && raw === "!") {
        setImmediate(() => {
          if (!rl || rl.line !== "!" || bang) return;
          bang = true;
          rl.write(null, { ctrl: true, name: "u" });
          rl.write(null, { ctrl: true, name: "k" });
          rl.setPrompt(promptFor());
          rl.prompt(true);
        });
      }
    });
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!rl || closing || scanner.pasting) return;
      // ↓ on a genuinely EMPTY line opens the picker; mid-edit it stays history-next.
      if (!picking) {
        if (raw === DOWN && !rl.line) setImmediate(openPicker);
        return;
      }
      // While picking: arrows move the selection, Esc closes, anything else re-filters off the
      // buffer once readline has folded the keystroke in (hence setImmediate).
      if (raw === DOWN) return void setImmediate(() => movePicker(1));
      if (raw === UP) return void setImmediate(() => movePicker(-1));
      if (raw === ESC) return void setImmediate(closePicker);
      setImmediate(() => (syncFilter() ? drawPicker() : closePicker()));
    });
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      // A paste ARRIVES IN CHUNKS. The pty hands stdin ~1KB at a time, so a 3KB paste is four `data`
      // events and the END marker (\e[201~) only lands in the last one — while readline processes each
      // chunk as it arrives and fires `line` for every newline in it. Waiting for `feed` to yield the
      // finished payload therefore armed the collapse three chunks too late, and the lines readline had
      // already submitted went out as separate messages: the "multiline paste stopped working" report,
      // which was really "paste larger than one chunk never worked" (a 4-line paste is one chunk, which
      // is why the tests and every earlier live check passed).
      //
      // So suppression begins at the START marker, not at completion: from the moment a paste is open,
      // every line event is payload. `pasteFired` counts the ones eaten before the payload was known, so
      // the count-based swallow below only has to cover what is still to come in the FINAL chunk.
      const wasPasting = scanner.pasting;
      const payloads = scanner.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (!wasPasting && scanner.pasting) {
        pasteOpen = true;
        pasteFired = 0;
        pasteFirstRaw = undefined;
      }
      for (const text of payloads) {
        pasteOpen = false;
        // Recover what had been typed before the paste, now that the payload's first line is known.
        const firstLine = text.includes("\n") ? text.slice(0, text.indexOf("\n")) : text;
        const pastePrefix =
          pasteFirstRaw === undefined
            ? undefined
            : pasteFirstRaw.endsWith(firstLine)
              ? pasteFirstRaw.slice(0, pasteFirstRaw.length - firstLine.length)
              : "";
        pasteFirstRaw = undefined;
        // A short single-line paste is indistinguishable from typing — leave it as ordinary input.
        if (!shouldCollapse(text)) continue;
        const block = makeBlock(pastes.length + 1, text);
        // Only the lines still to come: the ones already eaten while the paste was open are accounted
        // for by `pasteFired`, and counting them twice would swallow real input typed afterwards.
        const remaining = submittedLineCount(text) - pasteFired;
        pasteFired = 0; // consumed by this payload; a later paste starts its own count
        if (remaining > 0) {
          swallow = { remaining, block, first: text.slice(0, text.indexOf("\n")), prefix: pastePrefix };
          continue; // the line handler finishes once it has eaten all of them
        }
        if (pasteFired > 0) {
          // Every payload line was consumed before the end marker arrived — nothing left for the line
          // handler to eat, so stage it here. Deferred for the same reason the line handler defers:
          // readline is still folding this chunk in, and the tail after the last newline lands after us.
          const prefix = pastePrefix ?? "";
          setImmediate(() => stagePaste(block, prefix));
          continue;
        }
        // No newline (a single very long line): readline submits nothing, so the whole payload is
        // sitting in the buffer right now — swap it as soon as readline has folded the chunk in.
        setImmediate(() => {
          if (!rl || closing) return;
          const cur = rl.line;
          stagePaste(block, cur.endsWith(text) ? cur.slice(0, cur.length - text.length) : "");
        });
      }
    });
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      // A modified Enter = newline, not send. Safe to define because readline DROPS all of these as
      // unrecognised escape sequences (measured under a real pty: no line event, nothing inserted), so
      // paw isn't fighting it for a key it already binds. setImmediate for the same reason every other
      // buffer rewrite here defers — readline hasn't folded this chunk into `rl.line` yet.
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (scanner.pasting || swallow || pasteOpen) return; // inside a paste, Enter isn't a keystroke
      if (!isContinueKey(text)) return;
      setImmediate(() => {
        if (!rl || closing) return;
        holdLine(rl.line);
      });
    });
    process.stdin.on("data", () => {
      setImmediate(() => {
        if (closing || !rl) return;
        if (scanner.pasting || swallow) return; // mid-paste: a path INSIDE a paste isn't a drag
        const cur = rl.line;
        if (!cur || !cur.includes("/")) return; // cheap gate: no separator ⇒ no path ⇒ no stat calls
        const peeled = peelLine(cur, undefined, pending.length + 1);
        if (!peeled.paths.length) return;
        const staged: Attachment[] = [];
        try {
          for (const src of peeled.paths) staged.push(stageAttachment(space, src, pending.length + staged.length + 1));
        } catch (e) {
          emit(c.red("! " + (e as Error).message));
          return; // leave the raw path in the buffer — never silently swallow the drop
        }
        pending.push(...staged);
        rl.write(null, { ctrl: true, name: "u" }); // kill to line start
        rl.write(null, { ctrl: true, name: "k" }); // kill to line end
        // Trailing space when the body ends in a placeholder, so you can keep typing your message
        // straight after the swap without the next word butting against the `]`.
        rl.write(peeled.body.endsWith("]") ? `${peeled.body} ` : peeled.body);
        rl.setPrompt(promptFor());
        for (const a of staged) {
          emit(`${ATTACH_ICON} ${a.placeholder} ${c.dim(`${a.path} (${formatBytes(a.size)})`)}`);
          if (isBig(a)) emit(c.yellow(`  ⚠ ${formatBytes(a.size)} is large — reading it will use a lot of the agent's context`));
        }
      });
    });
  }

  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    // Leave the terminal as we found it — bracketed paste is a MODE, and a shell that inherits it
    // set without knowing would see raw \e[200~ markers in its own input.
    if (process.stdin.isTTY) process.stdout.write(DISABLE_BRACKETED_PASTE);
    rl?.close();
    await ep.stop().catch(() => {});
    process.exit(0);
  }

  /** `!<command>` — the same contract as the web composer (src/bash.ts): run it in the STICKY agent's
   *  folder, show the output here, then DM the agent the command AND its output so the answer becomes
   *  its context. Needs an agent target — a channel has no folder to run in. */
  async function runBangCommand(command: string): Promise<void> {
    if (!curName || !curId) return void emit(c.red("! `!cmd` runs in an agent's folder — `@name` first (a channel has no folder)"));
    const cwd = folderForName(space, curName);
    if (!cwd) return void emit(c.red(`! no registered folder for "${curName}" — \`paw status\` lists them`));
    if (!existsSync(cwd)) return void emit(c.red(`! "${curName}" is registered at ${cwd}, which no longer exists`));
    emit(c.dim(`$ ${command}  (in ${cwd})`), "you", true);
    const result = await runBash(command, cwd, undefined, undefined, true); // paw chat is a real terminal → source the operator's shell rc
    const body = result.output.trim() || "(no output)";
    const status = result.timedOut ? "timed out" : result.code === 0 || result.code === null ? undefined : `exit ${result.code}`;
    // One emit for the whole block: emit redraws the prompt after each call, and a 200-line build
    // log emitted line by line is 200 prompt redraws.
    emit(body.split("\n").map((l) => `  ${l}`).join("\n") + (status ? `\n${c.yellow(`  (${status})`)}` : ""), "you");
    await sent(ep.unicast(curId, bashMessage(result)));
    markWaiting(curName);
  }

  rl.on("line", async (rawLine) => {
    let raw = rawLine;
    // A paste in flight owns the next N line events — they're payload readline already consumed, not
    // things you submitted. This MUST precede the trim/empty check below: a blank line inside a paste
    // is payload too, and the empty-line early return would desync the count.
    // A paste is open but its payload isn't known yet (the end marker is in a later chunk): this line is
    // payload readline consumed, so it must not become a message. Same rule as `swallow`, earlier.
    if (pasteOpen) {
      if (pasteFired === 0) pasteFirstRaw = raw;
      pasteFired++;
      return;
    }
    if (swallow) {
      if (swallow.prefix === undefined) {
        // The first submitted line is <whatever you'd typed> + <the paste's first line>, fused.
        swallow.prefix = raw.endsWith(swallow.first) ? raw.slice(0, raw.length - swallow.first.length) : "";
      }
      if (--swallow.remaining > 0) return; // more payload lines still coming
      const done = swallow;
      swallow = undefined;
      // DEFER the buffer rewrite: this fires on the payload's LAST newline, and readline is still
      // mid-chunk — the segment after that newline hasn't been inserted yet. Clearing now would clear
      // an empty line and then readline would append the tail AFTER our placeholder
      // (`[Pasted text #1]   at gamma()`). setImmediate lets it finish folding the chunk in first.
      setImmediate(() => stagePaste(done.block, done.prefix ?? "")); // "" is a real value: nothing typed before the paste
      return;
    }
    // A trailing backslash continues — the universal fallback, since a continuation KEY only works if
    // your terminal sends it and there is no way to know that but to try. Checked before anything else
    // consumes the line, and never inside a paste (a payload line ending in `\\` is payload).
    const cont = peelContinuation(raw);
    if (cont.continues) {
      picking = false;
      drawn = 0;
      picked = 0;
      holdLine(cont.text);
      return;
    }
    // Everything held by a continuation joins THIS line into one message.
    if (held.length) {
      const all = held;
      held = [];
      raw = joinLines(all, raw);
    }

    // Submitting ends the picker. Don't ERASE — readline has already echoed the line and moved on, so
    // the drawn rows are scrollback now; erasing would eat whatever sits there instead.
    picking = false;
    drawn = 0;
    picked = 0;

    const typed = raw.trim();
    // Typing IS taking the "you" side, even though readline echoed the line rather than emit printing
    // it — so claim it here. Without this the first receipt reads as a side CHANGE (peer→you) and
    // opens with a blank, putting air after your own message instead of after the ⏳ receipt.
    lastSide = "you";
    // And a blank line the previous round ended on is no longer adjacent once a prompt and your typed
    // line sit between it and the next output — leaving the flag set swallowed later gaps entirely.
    trailingBlank = false;
    if (!typed) {
      if (!closing) rl!.prompt();
      return;
    }
    try {
      if (bang) {
        bang = false; // one command per entry; the next line starts as a message again
        rl!.setPrompt(promptFor());
        await runBangCommand(typed.trim());
        if (!closing) rl!.prompt();
        return;
      }
      // Bare "exit"/"quit" (no slash) quit too — typing `exit` to leave is reflex, and otherwise it
      // silently DMs the agent the word "exit" (and you only find out when it replies later).
      const cmd = typed.toLowerCase();
      if (cmd === "/quit" || cmd === "/exit" || cmd === "quit" || cmd === "exit") return void (await shutdown());
      if (cmd === "/noimg") {
        emit(c.dim(pending.length ? `(cleared ${pending.length} pending attachment(s))` : "(nothing pending)"));
        pending.length = 0;
        if (!pastes.length) stagedFor = undefined; // nothing is held for anyone any more
        rl!.setPrompt(promptFor());
        if (!closing) rl!.prompt();
        return;
      }
      if (cmd === "/imgs") {
        if (!pending.length) emit(c.dim("(nothing pending — drag an image in to attach one)"));
        for (const a of pending) emit(`  ${a.placeholder} ${c.dim(a.path)} ${c.dim(`(${formatBytes(a.size)})`)}`);
        if (!closing) rl!.prompt();
        return;
      }
      if (cmd === "/nopaste") {
        emit(c.dim(pastes.length ? `(cleared ${pastes.length} pending paste(s))` : "(nothing pasted)"));
        pastes.length = 0;
        if (!pending.length) stagedFor = undefined;
        rl!.setPrompt(promptFor());
        if (!closing) rl!.prompt();
        return;
      }
      if (cmd === "/paste" || cmd === "/pastes") {
        if (!pastes.length) emit(c.dim("(nothing pasted — paste multiple lines to stage them)"));
        for (const b of pastes) {
          emit(`  ${b.placeholder} ${c.dim(`${b.lines} line${b.lines === 1 ? "" : "s"}, ${formatBytes(b.chars)}`)}`);
          for (const line of pastePreview(b)) emit(c.dim(`    │ ${line}`));
        }
        if (!closing) rl!.prompt();
        return;
      }

      // Peel dragged/pasted attachment paths out of the line, replacing each with `[Image #N]`.
      // Runs BEFORE the verb dispatch below, which is safe because only tokens that resolve to an
      // existing ABSOLUTE file are touched — a `@name`, `#channel` or `/dm` prefix never matches.
      const peeled = peelLine(typed, undefined, pending.length + 1);
      peeled.paths.forEach((src, i) => {
        try {
          const a = stageAttachment(space, src, pending.length + 1);
          pending.push(a);
          emit(`${ATTACH_ICON} ${a.placeholder} ${c.dim(`${a.path} (${formatBytes(a.size)})`)}`);
          if (isBig(a)) emit(c.yellow(`  ⚠ ${formatBytes(a.size)} is large — reading it will use a lot of the agent's context`));
        } catch (e) {
          emit(c.red("! " + (e as Error).message));
        }
      });
      const text = peeled.body;

      // A line that was ONLY paths stages and waits — see `pending` above for why it must not send.
      // Tested against `hasProse`, not emptiness: a path-only line peels to the non-empty body
      // "[Image #1]", so an emptiness check would send a placeholder-only message (and one PER file
      // on a multi-file drop, which arrives as several separate lines).
      if (!hasProse(text)) {
        const staged = pending.length + pastes.length;
        if (staged) emit(c.dim(`(type your message — it sends with ${staged === 1 ? "the attachment" : "all attachments"}; /imgs · /paste to list, /noimg · /nopaste to clear)`));
        rl!.setPrompt(promptFor());
        if (!closing) rl!.prompt();
        return;
      }

      if (text === "/who") {
        emit(c.dim("Roster:"));
        // One row per NAME: a restart mints a new id and the stale record only goes `offline`, never
        // away, so a long-lived chat shows one dead row per past incarnation. See dedupeRoster.
        for (const p of dedupeRoster(ep.getRoster())) {
          emit(`  ${who(p.card)} ${statusBadge(p.status)}` + (p.card.id === me ? c.dim(" (you)") : ""));
        }
      } else if (text === "/ps") {
        // Same view as `paw ps`: ask the manager control plane for its managed agents + render rows.
        const reply = await withManagerControl(space, server, (ctl) => ctl.ps());
        if (!reply.ok) emit(c.red(`/ps failed: ${reply.error ?? "no reply"}`));
        else {
          const rows =
            (reply.data as Array<{ name: string; role?: string; agent: string; mode: string; status: string; mesh: string }>) ?? [];
          if (!rows.length) emit(c.dim("(no managed agents)"));
          for (const r of rows) {
            const st =
              r.status === "exited"
                ? c.red("crashed")
                : r.mesh === "absent"
                  ? c.yellow("starting…")
                  : r.mesh === "offline"
                    ? c.dim("offline")
                    : r.mesh === "working"
                      ? c.green("working")
                      : r.mesh === "waiting"
                        ? c.yellow("waiting")
                        : c.cyan(r.mesh);
            emit(`  ${c.bold(r.name)}${r.role ? c.dim("/" + r.role) : ""}  ${c.dim(r.agent + " · " + r.mode)}  ${st}`);
          }
        }
      } else if (text.startsWith("/dm ")) {
        const rest = text.slice(4).trim();
        const sp = rest.indexOf(" ");
        if (sp < 1) emit(c.red("usage: /dm <name> <message>"));
        else {
          const to = rest.slice(0, sp);
          const body = rest.slice(sp + 1);
          const peer = findPeer(to);
          if (!peer) emit(c.red(`no peer named "${to}" present`));
          else {
            await sent(ep.unicast(peer.card.id, flush(body)));
            markWaiting(peer.card.name); // confirm sent + await the reply (typed line alone isn't proof)
          }
        }
      } else if (text.startsWith("@")) {
        // @name [message] — switch the sticky target to <name> (and send the rest as a DM if given).
        const sp = text.indexOf(" ");
        const to = (sp === -1 ? text.slice(1) : text.slice(1, sp)).trim();
        const body = sp === -1 ? "" : text.slice(sp + 1).trim();
        if (!to) emit(c.red("usage: @<name> [message]"));
        else {
          let peer = findPeer(to);
          // Not live? If we know the agent's folder, resurrect it (resumed) — `@name` wakes an agent
          // you exited earlier, with full history, instead of just saying "offline".
          if (!peer || peer.status === "offline") {
            const home = folderForName(space, to);
            if (home && existsSync(home)) {
              emit(c.dim(`↻ ${to} is offline — respawning from ${home}…`));
              try {
                const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name: to, cwd: home, model }));
                // A COLD start — a fresh claude resuming a days-old session — takes well over the 8s
                // this used to allow, so it reported "couldn't be respawned" against an agent that was
                // simply still booting, while `paw dm` (which waits 20s) woke the SAME agent fine. One
                // number now, shared with dm: two answers to "how long may a spawn take" is how one
                // agent looks dead down one path and alive down the other.
                await waitForPeerId(ep, to, r.spawned ? FRESH_SPAWN_MS : LIVE_AGENT_MS);
                peer = findPeer(to);
              } catch (e) {
                emit(c.red("! " + (e as Error).message));
              }
            }
          }
          if (!peer) {
            emit(c.red(`no peer named "${to}" present (/who to list)`));
            warnStranded(to, body);
          } else if (peer.status === "offline") {
            emit(c.red(`"${peer.card.name}" hasn't come up yet — a cold start can outlast the wait; try \`@${to}\` again in a moment`));
            warnStranded(to, body);
          } else {
            if (peer.card.name !== curName) bang = false; // a command typed for one agent's folder never runs in another's
            curId = peer.card.id;
            curName = peer.card.name;
            // In a filtered session the view must keep matching who you're addressing — otherwise
            // `@other` sends somewhere you cannot see, which is the misdirection this mode prevents.
            if (filter?.kind === "agent") filter = { kind: "agent", name: peer.card.name };
            rl!.setPrompt(promptFor());
            if (body) {
              await sent(ep.unicast(curId, flush(body, curName)));
              markWaiting(curName);
            } else emit(c.dim(`(now messaging ${curName})`));
          }
        }
      } else if (parseBang(text) !== undefined) {
        await runBangCommand(parseBang(text)!);
      } else if (text.startsWith("#")) {
        // #channel <message> — broadcast to a channel so every subscribed agent sees it.
        const sp = text.indexOf(" ");
        if (sp < 2) emit(c.red("usage: #<channel> <message>"));
        else {
          const channel = text.slice(1, sp).trim();
          const body = text.slice(sp + 1).trim();
          await sent(ep.multicast(flush(body, `#${channel}`), { channel }));
        }
      } else if (curId) {
        await sent(ep.unicast(curId, flush(text, curName))); // sticky target — DM it
        markWaiting(curName!); // curName is set whenever curId is
      } else {
        await sent(ep.multicast(flush(text, `#${room}`), { channel: room })); // no sticky target — post to the room this session opened
      }
    } catch (e) {
      emit(c.red("! " + (e as Error).message));
    }
    if (!closing) rl!.prompt();
  });
  rl.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  rl.prompt();
  await new Promise<void>(() => {}); // park until shutdown() exits the process
}

const chatCommand: Command = {
  kind: "command",
  name: "chat",
  group: "Mesh",
  summary: "chat with the agent for a folder (auto-spawns it); replies stream back live — --fresh births a NEW one",
  usage: 'chat [<folder>|<name>] [--name <n>] [--fresh]   (default: "."; --name pins a 2nd+ EXTRA agent at the folder; --fresh births a NEW default agent, fails loud if one already exists)',
  run: (a) => chat([...a.raw]),
};

registry.register(chatCommand);
