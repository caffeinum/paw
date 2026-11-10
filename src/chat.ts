/**
 * `paw chat [folder|name]` — the headline. Joins the mesh as a PERSISTENT human peer (named by
 * HUMAN_PEER), wakes the folder's REGISTERED agent if it isn't live (never creates one — that's --fresh — except for a
 * github repo handle, which clones and births its agent), and opens an interactive
 * loop: what you type is direct-messaged to that agent, and its replies (and any other DMs) stream
 * back in real time. This is what closes the human↔agent loop that `paw dm` couldn't — `dm` is
 * fire-and-forget (a throwaway "send" peer that publishes and vanishes), so an agent had nowhere to
 * reply. Here the peer stays present and consuming, so cotal_dm(HUMAN_PEER, …) from the agent lands.
 *
 * Pure cotal underneath: a CotalEndpoint for presence/DMs, the manager control plane for spawn.
 * Registers a "chat" command into the cotal registry on import; it ensures the mesh + manager
 * itself (see `startup` in chat()), so ensure()'s manager probe and the startup spawn share one rail.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as readline from "node:readline";
import { format, stripVTControlCharacters } from "node:util";
import {
  CotalEndpoint,
  registry,
  type Command,
  type CotalMessage,
  type Delivery,
  type MessageMeta,
  type Presence,
  type PresenceStatus,
} from "@cotal-ai/core";
import {
  agentNamesForFolder,
  applyAgentType,
  checkAgentSpec,
  assertUnambiguousTarget,
  canonicalDir,
  cliRestartConsent,
  ensureAgentSpawned,
  unreachableHint,
  stuckWarning,
  folderForName,
  folderToName,
  registeredAgentFor,
  resolveFolderAgent,
  listAgents,
  lookupFolderName,
  personaFilePath,
  registerInstance,
  setFolderName,
  setPersonaKeys,
  stableHumanId,
  startResilient,
  waitForPeerId,
  type Kind,
} from "./addressing.ts";
import { isAddressHandle, resolveAddress } from "./address.ts";
import { HOST_RE } from "./url.ts";
import { bashMessage, parseBang } from "./bash.ts";
import { bangPlace, bangWhere, runBang, type BangPlace } from "./sandbox-exec.ts";
import { ManagerControl, withManagerControl } from "./control.ts";
import { advanceCursor } from "./cursor.ts";
import { attachConn, shortReason, type ConnLine, type ConnPhase } from "./conn-state.ts";
import { DEDUP_WINDOW_MS, draftDm, draftPost, publishDraft } from "./mesh-publish.ts";
import { Outbox, type OutEvent } from "./outbox.ts";
import { LinkProbe, PROBE_MS, isAckTimeout } from "./link-probe.ts";
import { PresenceHold, type PresenceLine } from "./presence-hold.ts";
import { AwaitTracker } from "./chat-awaiting.ts";
import { arrowRun, CLEAR_ALL, displayWidth, fitWidth, entryVisible, hintFor, hintWithTag, whereTag, History, LogFollower, navKey, scrollKey, Painter, type Entry, pickerWindow, showsChat, showsLogs, showsPeers, stepView, VIEW_LABEL, viewNeedsTarget, type ChatView } from "./chat-views.ts";
import { classifyPeer, isPeerForwardOf, mergeByTs, peerRows, peerSummary, pickPeers, type PeerMsg, type RawMsg } from "./chat-peers.ts";
import { agentBeads, agentInfo, CLOSED_RECENT_MS, hitAt, renderTasksPanel, type InfoFacts, type TasksHit } from "./chat-tasks.ts";
import { MOUSE_OFF, MOUSE_ON, SELECT_MODE_KEY, stripMouse, type MouseEvent } from "./mouse.ts";
import { collectStatus, contextShare, contextText, inboxText, toolLabel } from "./status.ts";
import { listAssigned, type Task } from "./tasks.ts";
import { operatorName } from "./company.ts";
import { attachesAbove, openAgentLog, renderBlock } from "./log.ts";
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
} from "./images.ts";
import { FRESH_SPAWN_MS, LIVE_AGENT_MS } from "./dm.ts";
import { messageText as textOf, type Entry as FeedEntry } from "./feed.ts";
import { forwardedFrom, isForwardOf, withoutForwardNote } from "./forward-mark.ts";
import { MAX_PEER_IDS, peerMsg, remoteNoPastIdsNote, readOwnConversation, readPeerTraffic, startEcho, tapAgentTraffic, tapOwnSubject, tapPeerTraffic } from "./chat-own.ts";
import { backlogSize, earlierDivider, moreCount, moreInsertAt, NOW_DIVIDER, nothingEarlier, pickBacklog } from "./chat-backlog.ts";
import { dedupeRoster } from "./commands/who.ts";
import { isContinueKey, joinLines, LEAKED_TAIL, leaksTail, peelContinuation } from "./multiline.ts";
import { ensureManagerOn, ensureSpaceFor, resolveSpace } from "./lifecycle.ts";
import { chatAgentInfo } from "./agent-summary.ts";
import { renderMarkdown } from "./markdown.ts";
import { HUMAN_PEER, humanPeer } from "./names.ts";
import { sameSpaceAddress } from "./dispatch.ts";
import { describeInboxBindFailure, inboxLedgerDir, prepareHumanInbox, sweepOrphanInboxes, type HumanInbox } from "./human-inbox.ts";
import { bootLabel, DeferredQueue, failed as failedSlot, LOADER, lineNeedsMesh, loading as loadingSlot, ok as okSlot, slotText, type BootPhase, type Slot } from "./chat-boot.ts";
import { canRepaintInPlace, paintedRows, renderBanner, type BannerState } from "./chat-banner.ts";
import { PendingConsent } from "./chat-consent.ts";
import { lookingFor, takeFrame } from "./chat-preshell.ts";
import { otherSpaceHits, pawHome, suggestNames } from "./chat-lookup.ts";
import { chooserKey, notFoundChooser, renderChooser, unreachableChooser, type Chooser, type Choice } from "./chat-chooser.ts";
import { concurrentStartup } from "./chat-startup.ts";
import { bangNoFolder, elsewhereBang, elsewhereBanner, elsewhereFiles, elsewhereLogs, elsewhereStatus, localMachine, machineOf, machineOfCard, runsElsewhere, type Elsewhere, type Machine } from "./hosted.ts";
import { readTeleported } from "./teleport-plan.ts";
import { cachedLedger, ledgerName } from "./peer-ledger.ts";
import { hueSgr, parsePersonalityArg, personaGlyph, personalityFor, type Glyph } from "./personality.ts";
import {
  composePastes,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  makeBlock,
  PASTE_END,
  PasteScanner,
  shouldCollapse,
  submittedLineCount,
  type PasteBlock,
} from "./paste.ts";
import { isRemoteSpace, pawServer } from "./server.ts";
import { parseComposed, RAIL, railMessage, railLine, railPastes, type ViewOpts } from "./compose-view.ts";

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

/** The where-tag's colour: this machine is quiet, another machine stands out, `?` warns. */
const connColor = (p: ConnPhase): ((s: string) => string) =>
  p === "connected" ? c.green : p === "disconnected" ? c.red : c.yellow;
const machineColor = (m: Machine | undefined): ((s: string) => string) => (!m || m.here ? c.dim : m.via === "unknown" ? c.yellow : c.cyan);

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
  /** Lines typed before the connect are still waiting to replay (or it is still connecting): hands off. */
  holding?: boolean;
}): boolean {
  if (s.holding || s.historical || s.ageMs >= FOLLOW_FRESH_MS) return false;
  if (!s.from) return false;
  if (s.curName && s.from.toLowerCase() === s.curName.toLowerCase()) return false; // already there
  if (s.typed.trim() !== "" || s.held > 0 || s.staged > 0) return false; // mid-composition — hands off
  return true;
}

/** How fresh a DM must be to move the sticky target — the same line `agoTag` draws between a live
 *  reply and one stamped with an age. */
const FOLLOW_FRESH_MS = 60_000;
/** The messages view reads a tap gap back from this long before it was noticed (a frame in flight). */
const PEER_GAP_SLACK_MS = 5_000;

/**
 * What the positional MEANS, by its sigil. Three modes, because "who am I talking to" and "what am I
 * looking at" are different questions and the CLI only ever answered the first:
 *
 *   paw chat            → this folder's agent (`.`) PRESELECTED, like `paw attach`
 *   paw chat --all      → global: every conversation, plain lines broadcast to #general
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
/** A bare `paw chat` means THIS folder's agent, like `paw attach`/`paw open` (operator, 2026-09-14); the
 *  every-conversation view with nothing preselected is `--all`. Pure; `check:chat`. */
export function chatTargetArg(given: string | undefined, all: boolean): string | undefined {
  if (all && given !== undefined) throw new Error(`paw: --all is every conversation with no agent preselected — drop "${given}" or drop --all`);
  return all ? undefined : (given ?? ".");
}

export function parseChatTarget(raw?: string): { mode: "global" | "agent" | "channel"; target?: string } {
  if (raw === undefined) return { mode: "global" };
  if (raw.startsWith("@")) {
    const name = raw.slice(1).trim();
    if (!name) throw new Error('paw: `@` needs an agent name — e.g. `paw chat @research` (or `paw chat --all` for every conversation)');
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

/** A presence change belongs in a filtered session only when it is the filtered agent's; a channel
 *  view has no single agent, so it shows none. Unfiltered sessions see everyone. */
export function presenceVisible(filter: { kind: "agent" | "channel"; name: string } | undefined, name: string): boolean {
  if (!filter) return true;
  return filter.kind === "agent" && name.toLowerCase() === filter.name.toLowerCase();
}

/** Presence activity is whatever the hook saw — a whole multi-line Bash script included. A status
 *  line must stay one line, so whitespace collapses and the tail is cut. */
/** The prompt badge for traffic a filtered session keeps off screen: one count that updates in place
 *  (the prompt is redrawn, never appended to), so a busy space costs zero lines. */
export function elsewhereBadge(hidden: number): string {
  return hidden > 0 ? `${hidden} elsewhere` : "";
}

export function activityLine(activity: string, max = 100): string {
  const flat = activity.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The footer's peer-status part — where status flips live now, instead of a transcript line per flip
 * (team2027, 2026-10-27: `• 2027-intern ● idle` / `● working` / `● idle` … under every message).
 * With a target: its live status (a live record wins over a stale offline one under the same name;
 * none at all = offline). Without: who is working, by name up to two, else a count; nothing when no
 * one is. Uncoloured; the caller paints it by `status`.
 */
export function peerStatusTag(
  target: string | undefined,
  roster: { card: { id: string; name: string }; status: string }[] | undefined,
  me: string | undefined,
  visible: (name: string) => boolean = () => true,
): { text: string; status: string } | undefined {
  // Never read yet: the target shows a loader. An unread roster is not an empty one — `offline` here
  // would call a live agent dead.
  if (roster === undefined) return target ? { text: `${target} ${LOADER}`, status: "loading" } : undefined;
  if (me === undefined) throw new Error("peerStatusTag: a read roster needs our own id to leave out");
  const others = roster.filter((p) => p.card.id !== me);
  if (target) {
    const same = others.filter((p) => p.card.name.toLowerCase() === target.toLowerCase());
    const st = (same.find((p) => p.status !== "offline") ?? same[0])?.status ?? "offline";
    return { text: `${target} ${st === "offline" ? "○" : "●"} ${st}`, status: st };
  }
  const names = [...new Set(others.filter((p) => p.status === "working" && visible(p.card.name)).map((p) => p.card.name))];
  if (!names.length) return undefined;
  return { text: names.length <= 2 ? `${names.join(", ")} working` : `${names.length} working`, status: "working" };
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

type ChatArgs = { space?: string; server?: string; target?: string; model?: string; name?: string; agent?: string; provider?: string; personality?: string; history?: string; fresh: boolean; only: boolean; all: boolean; restart: boolean };
export function parseArgs(argv: string[]): ChatArgs {
  const out: ChatArgs = { fresh: false, only: false, all: false, restart: false };
  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--agent") out.agent = value(a, argv[++i]); // create (or target) an agent on this harness — kit, codex, opencode, hermes, claude
    else if (a === "--provider") out.provider = value(a, argv[++i]); // kit's model provider: codex (default) | grok; hermes' provider id (e.g. xai-oauth)
    else if (a === "--name") out.name = argv[++i]; // pin an EXTRA agent instance at the folder (multi-instance)
    else if (a === "--personality") out.personality = value(a, argv[++i]); // birth personality: a seed, a quoted vibe, or none (docs/notes/personalities.md)
    else if (a === "--fresh") out.fresh = true; // birth a NEW agent (was `paw create`); fails loud if one exists
    else if (a === "--only") out.only = true; // FILTER to the target agent (the `@name` view, reached by folder/`.` instead of a name)
    else if (a === "--all") out.all = true; // every conversation, no agent preselected (what a bare `paw chat` used to mean)
    else if (a === "--restart") out.restart = true; // consent in advance: the wake gate may restart a live-but-stuck agent
    else if (a === "--history") out.history = value(a, argv[++i]); // the earlier block: last N messages with the target (0 = off) — src/chat-backlog.ts
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
/**
 * Plain `paw chat` CONNECTS; it never creates. A folder, URL or dotted name with no agent registered to
 * it fails here, pointing at `--fresh` (the birth verb) and at registered names that look close.
 *
 * It used to mint one on the spot. That is how `paw chat @getslash.co` — a mistyped name for the
 * operator's `getslash-co` — produced a brand-new agent in a scratch folder, received the image and
 * the question meant for the real one, and looked like success (2026-09-24). Operator's call: "it
 * should not auto-create agent at paw chat if not found". Waking a REGISTERED agent that is offline
 * still works — that's resuming, not creating — and so does `--name`, an explicit ask for an extra.
 */
export function noAgentMessage(folder: string, typed: string, registered: string[]): string {
  const near = suggestNames(typed, registered);
  return (
    `paw: no agent for ${folder.replace(homedir(), "~")} — \`paw chat --fresh ${typed}\` creates one` +
    (near.length ? `; did you mean ${near.map((n) => `@${n}`).join(", ")}?` : " (`paw status` lists your agents)")
  );
}

/**
 * A github repo handle (`github:o/r`, `gh:o/r`, a pasted https://github.com/o/r URL) is an explicit ask to
 * clone AND chat — unlike a mistyped name or a bare dotted host, it can't land somewhere by accident — so
 * chat births its agent when none exists (operator, 2026-10-28: "clone and chat in one command").
 */
export function isExplicitRepoHandle(target: string): boolean {
  return /^(github:|gh:)/.test(target) || /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/.test(target);
}

function requireExistingAgent(space: string, folder: string, typed: string): void {
  if (agentNamesForFolder(space, folder).length) return;
  throw new Error(noAgentMessage(folder, typed, listAgents(space).map((a) => a.name)));
}

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

/** Every manager command chat's startup handle sends: ensure()'s probe (`ps`), and ensureAgentSpawned's
 *  wake gate — `ps`, `spawn`, and a stop/restart's `despawn` (targeted, so resolved by `inspect` on the
 *  same rail). A command outside it is absent from the narrowed resolve and fails loud as not-found. */
export const CHAT_STARTUP_COMMANDS = ["ps", "spawn", "inspect", "despawn"] as const;

async function chat(argv: string[]): Promise<void> {
  timing("chat"); // modules loaded — what is before this is import cost
  const { space: spaceArg, server: serverArg, target: givenTarget, model, name: nameFlag, agent: agentFlag, provider, personality: personalityFlag, history: historyFlag, fresh, only, all, restart } = parseArgs(argv);
  const historySize = backlogSize(historyFlag); // validated before anything else runs
  // A personality is given at BIRTH; an existing agent's is changed with `paw persona <name> --reroll`.
  if (personalityFlag !== undefined && !fresh) throw new Error("paw: --personality is for a new agent (`paw chat --fresh <folder> --personality …`) — for an existing one use `paw persona <name> --reroll [seed]`");
  const personalityArg = personalityFlag !== undefined ? parsePersonalityArg(personalityFlag) : undefined; // validated before anything is registered
  if (provider !== undefined && agentFlag === undefined) throw new Error("paw: --provider picks kit's or hermes' model provider — pass it with --agent kit|hermes");
  if (agentFlag !== undefined && all) throw new Error("paw: --agent creates or targets ONE agent at a folder — it can't combine with --all");
  const agentSpec = agentFlag !== undefined ? { agent: agentFlag, provider, model } : undefined;
  if (agentSpec) checkAgentSpec(agentSpec); // before any name is registered for it
  const rawTarget = chatTargetArg(givenTarget, all);
  // The sigil decides the MODE; the rest of setup then sees a plain target and behaves exactly as
  // before, so `@name` reuses the same spawn/resume path a bare name has always taken.
  const addressed = parseChatTarget(rawTarget);
  let target = addressed.mode === "channel" ? undefined : addressed.target;
  /** What this session shows, reads and (for a channel) sends to. Undefined = every conversation. */
  let filter: { kind: "agent" | "channel"; name: string } | undefined =
    addressed.mode === "agent" ? { kind: "agent", name: addressed.target! } : addressed.mode === "channel" ? { kind: "channel", name: addressed.target! } : undefined;
  /** Where a plain line broadcasts when there's no sticky target — the channel you opened, else #general. */
  const room = addressed.mode === "channel" ? addressed.target! : ROOM;
  const space = spaceArg ?? resolveSpace();
  const server = serverArg ?? pawServer(space);
  const remoteSpace = isRemoteSpace(space);
  /** Both ends on a terminal: the instant REPL. Anything else (a pipe, a script) keeps the old order —
   *  connect and resolve first, then read lines — byte for byte. */
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (historyFlag !== undefined && !interactive) throw new Error("paw: --history shows the earlier block on a terminal — a piped `paw chat` reads no history (`paw inbox --history` / `paw history` do)");
  // The pre-shell (src/chat-preshell.ts) may already have painted a skeleton frame — chat adopts it below.
  const frame = takeFrame();

  // No target (only `--all` gets here) => start in broadcast mode: plain lines go to #general, and @name latches a sticky DM
  // (so you only pin a target once you actually mention someone). A target seeds that sticky target up
  // front: a <repo>@<branch> ref or a real directory => folder mode (spawn if absent); else a live
  // agent's name to focus.
  let folder: string | undefined;
  let name: string | undefined; // the initial sticky target; undefined = broadcast mode
  let brief: string | undefined; // per-kind persona body (web/pr); undefined ⇒ generic
  let kind: Kind | undefined; // persona kind marker (folder/worktree/repo/pr/web)
  /**
   * Resolve what was typed to an agent. Two kinds of resolution:
   *  - READ-ONLY (a registered name, a folder with an agent, `.`): runs at once, before any network — an
   *    unknown or ambiguous name fails loud before the UI or the mesh is touched;
   *  - MUTATING (`--fresh`, `--name`, `--agent`, a URL/handle that clones): runs inside the background
   *    connect, after ensure(), as it always has — a manager that won't come up fails before anything
   *    is registered.
   */
  const mutating = fresh || nameFlag !== undefined || agentSpec !== undefined || (target !== undefined && addressed.mode !== "agent" && isAddressHandle(target));
  const resolveTarget = (): void => {
    if (!fresh) assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder → fail loud (skipped under --fresh: the only interpretation there is a folder)
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
      // Written onto the still-unborn persona, so the birth (ensurePersonaFile) keeps it instead of drawing.
      if (personalityArg) setPersonaKeys(space, name, personalityFor(personalityArg, name, folder));
    } else if (nameFlag !== undefined && target === undefined) {
      // --name pins an EXTRA instance AT A FOLDER; with no explicit target that folder is the cwd (".",
      // like `paw chat --fresh`), never broadcast mode — so `cd repo && paw chat --name reviewer` works.
      folder = canonicalDir(".");
      name = registerInstance(space, folder, nameFlag);
    } else if (target !== undefined) {
      // `@name` names an AGENT — never a website to scaffold, never a folder. A dotted `@getslash.co`
      // used to fall into the address resolver below and mint a new agent in ~/.paw/web/ (2026-09-24);
      // resolve it against the registry instead, and fail loud if nothing is registered by that name.
      if (addressed.mode === "agent" && !/^[A-Za-z0-9_-]+$/.test(target)) {
        const known = registeredAgentFor(space, target);
        if (!known) throw new Error(`paw: no agent "${target}" — @ names an agent (\`paw status\` lists them); for a website use \`paw chat web:${target}\``);
        target = known.name;
        // The filter was built from what was TYPED; it must compare against the real name, or every DM
        // from `getslash-co` would be hidden as "not getslash.co".
        if (filter?.kind === "agent") filter = { kind: "agent", name: known.name };
      }
      if (addressed.mode !== "agent" && isAddressHandle(target)) {
        // A URL / web: / gh: / github: / <repo>@<branch> / bare host — resolveAddress clones/creates and
        // returns the cwd + kind + optional brief/name hint (all throw clearly on failure).
        // A bare dotted word with no agent behind it is almost always a mistyped NAME — refuse BEFORE the
        // resolver scaffolds a website folder for it (it would leave ~/.paw/web/<word> behind).
        if (!nameFlag && HOST_RE.test(target) && !existsSync(target) && !registeredAgentFor(space, target)) {
          throw new Error(noAgentMessage(target, target, listAgents(space).map((a) => a.name)));
        }
        const addr = resolveAddress(target);
        folder = addr.cwd;
        if (!nameFlag && agentFlag === undefined && !isExplicitRepoHandle(target)) requireExistingAgent(space, folder, target); // --agent / a repo handle is an explicit ask to create
        // --name pins a 2nd+ EXTRA instance at the resolved folder (its own persona), overriding the address's
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
          // `@name` is the NAME sigil — never a folder. `paw chat @queue` run from ~/Github/team2027
          // resolved the folder `queue/` and opened its DEFAULT agent (queue-ea) while the operator was
          // reading queue's replies, so every line went to the wrong agent (2026-09-17).
          asFolder = addressed.mode === "agent" ? undefined : canonicalDir(target);
        } catch {
          asFolder = undefined;
        }
        if (asFolder !== undefined) {
          folder = asFolder;
          if (!nameFlag && agentFlag === undefined) requireExistingAgent(space, folder, target); // --agent is an explicit ask to create
          // --name → register a 2nd+ EXTRA agent at this folder (its own persona); no --name → the folder default.
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
      if (!name) throw new Error("paw: --only needs an agent — it can't combine with --all");
      filter = { kind: "agent", name };
    }

    // `--agent <type>`: the resolved agent runs on that harness — a new one is born with it (persona
    // `agent:`/`provider:`/`model:`, a fresh pin), an existing one must already be on it (fails loud).
    if (agentSpec) {
      if (!name || !folder) throw new Error("paw: --agent needs a folder (or a registered agent) to create or target — e.g. `paw chat . --agent kit`");
      applyAgentType(space, name, agentSpec, { brief, kind });
    }
  };
  /** A mutating path's READ-ONLY refusals, run now so a typo fails before the UI waits on the mesh for
   *  it (resolveTarget repeats them; they are idempotent). */
  const precheck = (): void => {
    if (!fresh) assertUnambiguousTarget(space, target);
    if (fresh && nameFlag !== undefined) throw new Error(`paw: --fresh can't be combined with --name — see \`paw chat --fresh <folder>\` or \`paw chat <folder> --name ${nameFlag}\``);
    if (target !== undefined && addressed.mode !== "agent" && isAddressHandle(target) && !nameFlag && HOST_RE.test(target) && !existsSync(target) && !registeredAgentFor(space, target))
      throw new Error(noAgentMessage(target, target, listAgents(space).map((a) => a.name)));
  };
  {
    try {
      if (mutating) precheck();
      else resolveTarget();
    } catch (e) {
      frame?.erase(); // the skeleton promised a chat that isn't coming — take it down before the error
      throw e;
    }
  }
  /** The name the UI shows for the target while it resolves: what was typed (`.` → this folder). */
  const typedLabel = target === undefined ? undefined : target === "." ? basename(process.cwd()) : target;
  /**
   * A bare name registered nowhere here (no folder to wake it from): maybe a peer hosted on another
   * machine, maybe a typo — only the live roster can say. `pending` shows "◌ looking for @name…" in
   * place of a live prompt; the roster settles it: `found` → the normal prompt, `absent` → the chooser
   * (src/chat-chooser.ts), `unreachable` → said so, with retry. A pipe keeps today's behaviour.
   */
  let lookup: "pending" | "found" | "absent" | "unreachable" | undefined =
    interactive && !mutating && name !== undefined && folder === undefined ? "pending" : undefined;

  let rl: readline.Interface | undefined;
  let closing = false;

  // Everything shown lives in ONE ordered history, and a view is a filter over it — that is what lets
  // ←/→ REDRAW a different view instead of appending a few lines (src/chat-views.ts). The Painter holds
  // the "visual rounds" spacing (a blank where the side changes, conversation closes with air before
  // the prompt, system noise stays tight) and is shared by the live path and every redraw, so a redraw
  // is spaced exactly like the screen it replaces.
  type Side = "you" | "peer" | "sys";
  const history = new History();
  // Other-peer rows are laid out at paint time — the width now, the age now (src/chat-peers.ts).
  const layPeer = (p: PeerMsg): string =>
    peerRows(p, {
      cols: process.stdout.columns || 80,
      age: stripVTControlCharacters(agoTag(p.ts)),
      dim: c.dim,
      md: (t, w) => renderMarkdown(t, { width: w }),
      strip: stripVTControlCharacters,
      tag: (n) => agentTag(n),
    }).join("\n");
  const painter = new Painter(renderBlock, c.dim, "  ", attachesAbove, layPeer);
  const follower = new LogFollower(
    (name) => {
      const away = awayOf(name);
      if (away) throw new Error(elsewhereLogs(away));
      const folder = folderForName(space, name);
      if (!folder) throw new Error(`${name} isn't registered to a folder`);
      return openAgentLog(space, name, folder);
    },
    (e) => show(e),
    // Only the logs views need to hear that there are no logs; the follower runs in every view, so a
    // plain emit would put this note in the chat view of every agent paw can't read a trace for.
    (name, msg) => show({ kind: "chat", text: c.dim(`(no logs for ${name} — ${msg})`), side: "sys", tight: true, onlyLogs: true }),
  );
  // Declared up here because emit() reads them to decide visibility, and emit can run during startup
  // (the endpoint's error handler) before the code that first assigns them.
  let curId: string | undefined;
  let curName: string | undefined;
  /** The entry last written to the screen — the banner may be repainted in place only while it is this. */
  let lastPainted: Entry | undefined;
  /** How `lastPainted` was painted (its text, the painter's state before it, the width then) — so a
   *  loader that is still the last thing on screen can be swapped in place for what it was loading. */
  let lastPaint: { text: string; before: { lastSide: Painter["lastSide"]; trailingBlank: boolean }; cols: number } | undefined;
  /** The banner's history entry (its text is rewritten as fields load) and how many rows it last took. */
  let bannerEntry: (Entry & { kind: "banner" }) | undefined;
  let bannerRows = 0;

  /** Record `e`; print it now if the current view shows it. Every screen write of conversation goes
   *  through here — anything that bypassed it would be on screen once and gone after the next redraw. */
  function show(e: Entry): void {
    history.push(e);
    if (view === "beads") {
      // The dashboard has no scrolling conversation, so a receipt or an error (anything that isn't a
      // message) becomes its notice line — a send that failed must not fail silently here.
      if (e.kind === "chat" && !e.onlyLogs) {
        // A message arriving answers whatever the notice was waiting on ("⏳ waiting for kit…").
        tasksNotice = e.side === "peer" ? undefined : stripVTControlCharacters(e.text).trim().split("\n")[0];
        paintTasks();
      }
      return;
    }
    if (!entryVisible(e, view, curName, follower.readable(curName))) return;
    const before = { lastSide: painter.lastSide, trailingBlank: painter.trailingBlank };
    const text = painter.paint(e, view);
    if (!text) return;
    lastPaint = { text, before, cols: process.stdout.columns || 80 };
    // Once we're shutting down (EOF/SIGINT/quit) the readline is closed — touching it throws
    // ERR_USE_AFTER_CLOSE. Still write the message, just skip the prompt redraw.
    // The picker draws its rows above the prompt and erases them by COUNT; a line printed in between
    // made it erase the wrong rows and leave stale ones behind. Take it down, print, put it back.
    if (picking) pickerHooks?.erase();
    else if (chooserHooks?.open()) chooserHooks.erase();
    if (rl && !closing) {
      // From the prompt's FIRST row: a line wrapped past the terminal width puts the cursor rows below
      // it, and clearing from there left the prompt's earlier rows stranded above every printed line.
      readline.moveCursor(process.stdout, 0, -rl.getCursorPos().rows);
      readline.cursorTo(process.stdout, 0);
      // clearScreenDown, not clearLine: the hint line sits BELOW the prompt, and a message printed
      // over the prompt row would otherwise leave a stale hint stranded in the middle of the text.
      readline.clearScreenDown(process.stdout);
    }
    process.stdout.write(text);
    lastPainted = e;
    if (picking && pickerHooks) pickerHooks.draw();
    else if (chooserHooks?.open()) chooserHooks.draw();
    else if (rl && !closing) rl.prompt(true);
  }

  /**
   * Print a conversation line. `side` drives the spacing (see Painter); `tight` keeps the held lines of
   * one multi-line message together; `from` marks an INBOUND DM with its sender, which the logs view
   * needs (another agent's DM stays visible there — hiding it would hide mail).
   */
  function emit(s: string, side: Side = "sys", tight = false, from?: string): void {
    show({ kind: "chat", text: s, side, tight, ...(from !== undefined ? { from } : {}) });
  }

  /** Redraw the whole current view: clear the screen AND the scrollback, then reprint every entry the
   *  view shows, through the same Painter the live path uses. */
  function redraw(): void {
    if (!rl || closing || !process.stdout.isTTY) return;
    if (view === "beads") return paintTasks(true);
    painter.reset();
    const readable = follower.readable(curName);
    let out = CLEAR_ALL;
    const cols = process.stdout.columns || 80;
    for (const e of history.entries) {
      if (!entryVisible(e, view, curName, readable)) continue;
      if (e.kind === "chat" && e.bannerDelta && bannerEntry) continue; // the banner below says it now
      const before = { lastSide: painter.lastSide, trailingBlank: painter.trailingBlank };
      const text = painter.paint(e, view);
      out += text;
      if (text) {
        lastPainted = e;
        lastPaint = { text, before, cols };
      }
    }
    process.stdout.write(out);
    bannerRows = bannerEntry && lastPainted === bannerEntry ? paintedRows(bannerEntry.text, process.stdout.columns || 80) : bannerRows;
    rl.prompt(true);
  }

  /** Which view the conversation is in (see src/chat-views.ts). `chat` is what `paw chat` always was,
   *  so nobody's session changes until they press ←. */
  let view: ChatView = "chat";
  /** The beads view's state (src/chat-tasks.ts): beads for `tasksFor` (agent name, or the operator
   *  when there is no target), the last message each way PER AGENT this session knows of, the notice
   *  line, and what was last painted so an unchanged repaint writes nothing. */
  let tasksBeads: { for: string; tasks: Task[] } | undefined;
  /** The bead list's first row (src/chat-tasks.ts scroll); the renderer reports what it really used. */
  let tasksScroll = 0;
  let tasksScrollFor: string | undefined;
  /** `paw status`'s row for the target, read with the beads; an error is shown, never a guessed row. */
  let tasksInfo: { for: string; facts?: InfoFacts; error?: string; note?: string } | undefined;
  let tasksError: { for: string; message: string } | undefined;
  let tasksNotice: string | undefined;
  /** Mouse reporting (src/mouse.ts): ON exactly while the beads view is on screen and select mode is
   *  off — the wheel scrolls the list, a click on a parent's icon folds it. `selectMode` (ctrl+o in the
   *  beads view) hands the mouse back to the terminal for selecting text; every entry starts without it.
   *  `mouseOn` = what the terminal was last told. `folded` is view state. `tasksHits` = the icon per row. */
  let selectMode = false;
  let mouseOn = false;
  const folded = new Set<string>();
  let tasksHits: (TasksHit | undefined)[] = [];
  let tasksPainted = "";
  /** Whether the agent picker is open. Declared up here, not with the rest of the picker, because
   *  drawHint reads it and readline can prompt before the picker's section of this function runs. */
  let picking = false;
  /** Lines held by a continuation (Alt/Shift/Ctrl+Enter, or a trailing `\\`), waiting for the Enter that
   *  finishes the message. Typing multi-line had no answer at all before: you got one line, or you sent
   *  three messages. See src/multiline.ts. Declared up here because the prompt and the hint read it.
   *  The draft is drawn on the rail (src/compose-view.ts) and the continuation prompt IS that rail. */
  let held: string[] = [];
  /** The on-screen rows of each held line, so taking a line back also takes it off screen. */
  let heldEntries: Entry[][] = [];
  /** The picker's erase/draw, registered once its section of this function has run. */
  let pickerHooks: { erase(): void; draw(): void } | undefined;
  /** The not-found chooser's, likewise (src/chat-chooser.ts). */
  let chooserHooks: { open(): boolean; erase(): void; draw(): void } | undefined;

  /** What the footer last said (bar the mesh/machine part), so a tick redraws only when it changed. */
  let hintState: string | undefined;
  /** The outbox, once it exists (presence events can redraw the footer before it does). */
  let outboxRef: Outbox<Outgoing> | undefined;
  /** Every connection the endpoint opens, PINGed when a send's ack times out (src/link-probe.ts). */
  const linkProbe = new LinkProbe();
  /**
   * The hint row's RIGHT side, plain and coloured: the target's live status (or, with no target, who is
   * working), unsent messages, the connection state, the mesh and machine. Status flips live HERE, not
   * as transcript lines (src/chat.ts presence handler).
   */
  function footerParts(): [string, (s: string) => string][] {
    const now = Date.now();
    const parts: [string, (s: string) => string][] = [];
    const narrow = (process.stdout.columns || 80) < 40;
    if (!narrow) {
      // A roster never read is NOT an empty one: the target shows a loader, never `offline`.
      const peer = peerStatusTag(curName ?? pendingName(), roster(), me, (n) => presenceVisible(filter, n));
      if (peer) parts.push([peer.text, peer.status === "working" ? c.yellow : peer.status === "waiting" ? c.magenta : c.dim]);
      if (deferred.count) parts.push([`◌ ${deferred.count} queued`, c.yellow]);
      // Only a send that has hit trouble shows: a healthy one acks in milliseconds and would just flicker.
      const pending = outboxRef?.pending() ?? [];
      const failed = outboxRef?.failed().length ?? 0;
      if (pending.some((i) => i.retried)) parts.push([`◌ sending ${pending.length}`, c.yellow]);
      if (failed) parts.push([`✕ ${failed} not sent · /retry`, c.red]);
    }
    if (bootPhase !== "ready" || !conn) parts.push([bootLabel(bootPhase, now - bootStartedAt, curName ?? pendingName()), bootPhase === "failed" ? c.red : c.yellow]);
    else parts.push([conn.label(now), connColor(conn.phase(now))]);
    return parts;
  }
  const footerKey = (parts: [string, unknown][]): string => parts.map(([t]) => t).join(" · ");
  function footerTag(): { plain: string; painted: string; key: string } {
    const parts = footerParts();
    const key = footerKey(parts);
    if ((process.stdout.columns || 80) >= 40) {
      const known = curName && roster();
      const machine = known ? machineFor(curName!) : undefined;
      const tag = whereTag({ space, remote: remoteSpace, ...(known ? { agent: { machine } } : {}) }) + (curName && !known ? ` · on ${LOADER}` : "");
      parts.push([tag, machineColor(machine)]);
    }
    return { plain: footerKey(parts), painted: parts.map(([t, f]) => f(t)).join(c.dim(" · ")), key };
  }
  /** Redraw the hint row when what its footer says changed (the mesh/machine part is read on redraw
   *  only — it reads the persona file, too much for a 1s tick). */
  function refreshFooter(): void {
    if (!rl || closing || scanner.pasting || !process.stdout.isTTY) return;
    if (footerKey(footerParts()) !== hintState) drawHint();
  }
  /**
   * Draw the hint line UNDER the input: where ←/↓/→ go from here, and which view you're in.
   *
   * Drawn relative to the cursor, never with save/restore: when the prompt sits on the terminal's last
   * row, the newline that makes room for the hint scrolls the screen, and a SAVED position then points
   * at the row that just moved — relative moves stay right. readline wipes everything below the line
   * on its own full refreshes (history, mid-line edits), so this is re-run after every keystroke.
   *
   * Gated on `rl`, which is created after all of chat's state: emit() can run during startup, before
   * `curName`/`bang`/`picking` exist, and touching them then would be a temporal-dead-zone crash.
   */
  function drawHint(): void {
    if (!rl || closing || !process.stdout.isTTY) return;
    const hint = hintFor({ view, picking, hasTarget: !!curName, bang, selectMode, draft: { held: held.length, pastes: stage().pastes.length } });
    const cols = process.stdout.columns || 80;
    // The RIGHT side — the picker and `$` mode keep the row.
    const foot = footerTag();
    const row = hintWithTag(hint, picking || bang ? "" : foot.plain, cols);
    const pos = rl.getCursorPos();
    const shown = displayWidth(stripVTControlCharacters(rl.getPrompt())) + displayWidth(rl.line);
    const lastRow = Math.floor(Math.max(0, shown - 1) / cols);
    const down = Math.max(0, lastRow - pos.rows);
    readline.moveCursor(process.stdout, 0, down);
    // The input may have just WRAPPED onto the row the hint occupied, overwriting its start and leaving
    // the rest ("…png mode · esc or backspace leaves", seen under a pty). readline writes characters, it
    // doesn't clear to the end of the row — so clear what's right of the input's end before redrawing.
    readline.cursorTo(process.stdout, shown % cols);
    readline.clearLine(process.stdout, 1);
    process.stdout.write("\n");
    readline.clearLine(process.stdout, 0);
    const tag = row.tag ? foot.painted : "";
    process.stdout.write(c.dim(row.left) + " ".repeat(row.pad) + tag);
    hintState = foot.key;
    readline.moveCursor(process.stdout, 0, -(down + 1));
    readline.cursorTo(process.stdout, pos.cols);
  }
  // cotal's endpoint reports trouble one event at a time — a remote broker's slow link printed a red
  // `! timeout` per presence-watch rebind, dozens of them (src/conn-state.ts). They fold into one state
  // shown on the hint line; only sustained trouble, its recovery, and non-transient errors print.
  const emitConn = (lines: ConnLine[]): void => {
    for (const l of lines) emit(l.level === "recovered" ? c.green(l.text) : c.red(l.text));
  };

  // ── the mesh side, filled in by boot() ─────────────────────────────────────────────────────────────
  // The REPL is up before any of this exists (docs/notes/chat.md "instant UI"). Every read of the
  // endpoint goes through `roster()` (undefined until the presence view has been read ONCE — an unread
  // roster is not an empty one) or `needEp()` (throws: only reachable once `ready`).
  let ep: CotalEndpoint | undefined;
  let conn: ReturnType<typeof attachConn> | undefined;
  /** "you"'s principal on the mesh, known from the endpoint's construction (before it connects). */
  let me: string | undefined;
  /** The presence view has been read at least once (it can go stale later; the roster stays usable). */
  let rosterSeen = false;
  let ready = false;
  let bootPhase: BootPhase = "mesh";
  let bootStartedAt = Date.now();
  /** The target could not be reached — plain lines to it are REFUSED (kept), never posted to #general. */
  let targetLost: { name: string; reason: string } | undefined;
  const roster = (): Presence[] | undefined => (ep && rosterSeen ? ep.getRoster() : undefined);
  const needEp = (): CotalEndpoint => {
    if (!ep || !ready) throw new Error("not connected yet — the line waits in the queue (◌) until it is");
    return ep;
  };
  /** The typed target's label while it is still being resolved (mutating paths resolve inside boot). */
  const pendingName = (): string | undefined => (!curName && !ready && addressed.mode !== "channel" ? typedLabel : undefined);

  // Resolve a peer by name, preferring a LIVE one. Restarting an agent (e.g. re-adopt) leaves stale
  // OFFLINE presence entries under the same name until they TTL out; without this `@name`/`/dm` could
  // pick a ghost and refuse to send even though a live agent is right there.
  /** An agent's personality glyph (persona emoji/hue), read once per name per session. */
  const glyphs = new Map<string, Glyph>();
  const glyphOf = (name: string): Glyph => {
    if (!glyphs.has(name)) glyphs.set(name, /^[A-Za-z0-9_-]+$/.test(name) ? personaGlyph(personaFilePath(space, name)) : {});
    return glyphs.get(name)!;
  };
  /** `🐈 queue` with the name in the agent's hue — or the given fallback colour when it has none. */
  const agentTag = (name: string, fallback: (s: string) => string = c.cyan): string => {
    const g = glyphOf(name);
    const tinted = g.hue !== undefined && tty ? `\x1b[${hueSgr(g.hue)}m${name}\x1b[0m` : fallback(name);
    return g.emoji ? `${g.emoji} ${tinted}` : tinted;
  };
  /** An id → agent name, from the live roster, else paw's peer ledger (a restarted agent's old id).
   *  Unknown ids stay ids — never invent a name. */
  const rosterName = (id?: string): string | undefined =>
    id ? ((roster() ?? []).find((p) => p.card.id === id)?.card.name ?? ledgerName(cachedLedger(space), id)) : undefined;

  const findPeer = (to: string) => {
    const peers = (roster() ?? []).filter((p) => p.card.name.toLowerCase() === to.toLowerCase() && p.card.id !== me);
    return peers.find((p) => p.status !== "offline") ?? peers[0];
  };
  /** Where `name` runs when that is NOT this machine (teleported, or another machine's agent on a
   *  remote space) — then its logs, ctx, folder and files are there, and only messaging works from here. */
  const awayOf = (name: string): Elsewhere | undefined => runsElsewhere(space, name, findPeer(name)?.card);
  /** Which machine runs `name` (src/hosted.ts machineOf): its live card's `meta.host`, else its
   *  teleport marker, else — a local space with its persona here — this machine, else `?` while live.
   *  chat reads no manager ps, so on a remote space a live agent whose card names no host is `?`. */
  const here = localMachine(space);
  const machineFor = (name: string): Machine | undefined => {
    const peer = findPeer(name);
    const live = !!peer && peer.status !== "offline";
    const persona = /^[A-Za-z0-9_-]+$/.test(name) ? personaFilePath(space, name) : undefined;
    const personaHere = !!persona && existsSync(persona);
    const teleportedTo = personaHere ? readTeleported(persona!)?.to : undefined;
    return machineOf({ card: live ? machineOfCard(peer.card) : undefined, teleportedTo, localSpaceHere: !remoteSpace && personaHere && !teleportedTo, running: live, local: here });
  };
  /** A typed `name#space` / `#chan#space`: this session's space → the bare name; another (or unknown)
   *  space → said in red and undefined — this REPL is one space's endpoint and never re-routes. */
  const inThisSpace = (typed: string): string | undefined => {
    try {
      return sameSpaceAddress(typed, space, "chat");
    } catch (e) {
      emit(c.red((e as Error).message));
      return undefined;
    }
  };

  // The current sticky DM target: plain lines go here once set. Undefined => broadcast mode (plain
  // lines multicast to #general). `@name` latches it; a positional target seeds it below.
  /** Re-read the sticky target's id from the live roster just before a send — a presence event can be
   *  missed across a reconnect, and the roster is what `@name` resolves against anyway. */
  const refreshTarget = (): void => {
    if (!curName) return;
    const live = findPeer(curName);
    if (live && live.status !== "offline") curId = live.card.id;
  };

  // The target named on the command line is the sticky target from the first frame; its mesh id comes
  // from boot() (spawn/reuse, then the roster). Lines typed meanwhile wait in `deferred`.
  curName = name;
  let spawned = false;
  let busy: true | undefined;
  const deferred = new DeferredQueue<Attachment, PasteBlock>();
  /** When the first key of the line being typed was pressed (restart consent takes only a line typed
   *  after its question appeared), and whether a paste landed in it. Reset on every submitted line. */
  let lineStartedAt: number | undefined;
  let pastedIntoLine = false;
  /** Wait (≤5s) for the presence view's first read; false = it hasn't loaded and the caller must not
   *  treat an absent name as absent. */
  const rosterReady = async (): Promise<boolean> => {
    if (rosterSeen) return true;
    await needEp().waitForPresenceSnapshot(5000);
    onRosterSeen();
    return rosterSeen;
  };
  /** The wake gate's restart question, asked in this REPL (src/chat-consent.ts). */
  // The draft being typed stays as it is: a line started before the question is never its answer.
  const consent = new PendingConsent({
    ask: (question) => {
      emit(c.yellow(`? ${question}`));
      rl?.setPrompt(promptFor()); // promptFor() shows the question while it is open
      if (rl && !closing) rl.prompt(true);
    },
    done: () => {
      rl?.setPrompt(promptFor());
      if (rl && !closing) rl.prompt(true);
    },
    now: Date.now,
  });

  // Attachments staged but not yet sent. A line that is ONLY paths (the shape you get from dragging
  // an image in and hitting Enter) stages them and does NOT send — otherwise you'd fire a message
  // with an empty body, and a multi-file drop (some terminals join paths with newlines, which
  // readline sees as several separate lines) would fire one empty message PER file. They flush with
  // the next line that actually has prose, as a single message.
  const pending: Attachment[] = [];

  /** Multi-line pastes captured but not yet sent — same staging contract as `pending` images: the
   *  placeholder sits in the line you're editing, the payload rides along on the next send. */
  const pastes: PasteBlock[] = [];

  /**
   * While the queued lines replay, `pending`/`pastes` hold the REPLAYED line's attachments — a line can
   * wait seconds (a respawn, a `!cmd`, presence loading) between staging them and sending. Whatever the
   * operator stages meanwhile goes here instead, and lines typed meanwhile join the queue behind the
   * replayed ones (`replaying`), so nothing jumps the queue and nothing rides on someone else's line.
   */
  let liveStage: { pending: Attachment[]; pastes: PasteBlock[]; stagedFor?: string; bang: boolean } | undefined;
  const stage = (): { pending: Attachment[]; pastes: PasteBlock[] } => liveStage ?? { pending, pastes };
  let replaying = false;
  /** Queued lines refused at replay that could not go back into the input: printed in full on quit. */
  const keptUnsent: { to: string; text: string }[] = [];

  /** The prompt reflects where plain lines go right now: a sticky target, or the broadcast room —
   *  plus what's riding along with your next message. */
  /** Command mode, entered by typing `!` on an empty line with an agent targeted (the web composer's
   *  `state.bang`). The `!` is CONSUMED — it is the mode now, shown by the prompt, not a character in
   *  what you typed — so the line you send and the line you see agree. One command per entry. */
  let bang = false;
  /** Messages a filtered session did not show. Counted, never printed — see elsewhereBadge. */
  let hiddenCount = 0;
  const bangPrompt = (): string => `${c.yellow("$ >")} `;
  const promptFor = (): string => {
    // An open restart question owns the prompt: every redraw (a staged paste, a queued line, a hidden
    // DM's badge) must keep asking it, or the next line answers a question nobody can see.
    if (consent.prompt) return c.yellow(consent.prompt);
    if (bang && curName) return bangPrompt();
    if (held.length) return c.dim(RAIL); // mid-draft: the line being typed sits on the draft's rail
    const st = stage();
    const badges = [deferred.count ? `${deferred.count} queued` : "", st.pending.length ? `${st.pending.length} img` : "", st.pastes.length ? `${st.pastes.length} pasted` : "", elsewhereBadge(hiddenCount)].filter(Boolean);
    const narrow = (process.stdout.columns || 80) < 40;
    if (lookup === "pending" && curName) return c.dim(`${lookingFor(curName, space)}${badges.length ? ` [${badges.join(" · ")}]` : ""}> `);
    const state = targetLost && curName && targetLost.name === curName ? ` ${c.red("✕")}` : !ready && bootPhase !== "failed" && (curName || pendingName()) ? ` ${c.dim(LOADER)}` : "";
    const tail = c.dim(`${curName && filter?.kind === "agent" && !narrow ? " (only)" : ""}${badges.length ? ` [${badges.join(" · ")}]` : ""}`) + state + c.dim("> ");
    const shown = curName ?? pendingName();
    if (shown && narrow) return `${agentTag(shown, c.dim)}${tail}`;
    return shown ? `${c.dim(`${HUMAN_PEER} → `)}${agentTag(shown, c.dim)}${tail}` : `${c.dim(`${HUMAN_PEER} → #${room}`)}${tail}`;
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

  /** Said the moment a file is staged for an agent running elsewhere — flush refuses to send it. */
  const warnAwayFile = (): void => {
    const away = curName ? awayOf(curName) : undefined;
    if (away) emit(c.yellow(`  ⚠ ${curName} runs on ${away.where} and can't open a file on this machine — /noimg drops it`));
  };

  const flush = (body: string, target?: string, to: string | undefined = target): string => {
    if (!pending.length && !pastes.length) return body;
    // A staged path names a file on THIS machine; an agent running elsewhere would be handed a path it
    // cannot open. Refuse the send (thrown → printed, nothing sent, still staged) — pastes are inline
    // text and would travel fine, but the message is one unit.
    const away = pending.length && to && !to.startsWith("#") ? awayOf(to) : undefined;
    if (away) throw new Error(`${elsewhereFiles(to!, away, pending.map((a) => a.placeholder))} — /noimg drops ${pending.length === 1 ? "it" : "them"}`);
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

  // After you DM someone, note what you're awaiting — one entry PER MESSAGE (chat-awaiting.ts). Gives
  // an immediate "sent, waiting…" confirmation (the typed line alone doesn't prove it went out), says
  // so when the agent is mid-turn (the line is queued, not lost), and lets each reply be stamped with
  // how long ITS message took — so a long-running agent doesn't feel like silence.
  const awaiting = new AwaitTracker();
  const markWaiting = (to: string, m: CotalMessage, lead = ""): void => {
    if (!m?.id) throw new Error(`send to ${to} returned no message id — cannot track the reply`);
    const { queued } = awaiting.sent(to, m.id, Date.now(), findPeer(to)?.status);
    if (queued) emit(c.dim(`${lead}⏳ queued — ${to} is mid-turn`), "you");
    else emit(c.dim(`${lead}⏳ waiting for ${to}…`), "you");
  };

  // Banner. A LIVE entry (src/chat-banner.ts): painted at the first frame with loaders for what the
  // network has not answered, and repainted where it stands as boot() fills each field in — or, once
  // something has been printed under it, each change is appended as one dim line instead. The mesh
  // line names the space (a remote one marked) and, for an agent, the machine running it right now — a
  // just-spawned agent has no card yet, so it shows the mesh alone, never a guess.
  const fields: { status: Slot<string>; info: Slot<{ model: string; context: string } | undefined> } = {
    status: lookup === "pending" ? okSlot(c.dim(lookingFor(name!, space))) : loadingSlot(),
    info: loadingSlot(),
  };
  /** Has the endpoint's view of who is where been read? On a local space the machine is known from the
   *  persona alone; on a remote one only a card says, so it loads with the roster. */
  const whereKnown = (): boolean => roster() !== undefined;
  const bannerState = (): BannerState => {
    if (filter?.kind === "channel") return { mode: "channel", space, remote: remoteSpace, room };
    const shown = curName ?? pendingName();
    if (!shown) {
      const r = roster();
      const names = r ? [...new Set(r.filter((p) => p.card.id !== me && p.status !== "offline").map((p) => p.card.name))] : undefined;
      return { mode: "all", space, remote: remoteSpace, room: ROOM, roster: names ? okSlot(names) : loadingSlot() };
    }
    // Running on another machine: this machine's folder, transcript and model/ctx readings are the
    // frozen copy from before it left (or don't exist) — show where it runs instead, and no stale numbers.
    const away = curName && whereKnown() ? awayOf(curName) : undefined;
    const where = away ? `${c.dim("runs on")} ${c.cyan(away.where)}${away.cwd ? c.dim(` · ${away.cwd}`) : ""}` : folder ? c.dim(folder) : curName ? c.dim("(by name)") : "";
    const m = curName && whereKnown() ? machineFor(curName) : undefined;
    return {
      mode: "agent",
      space,
      remote: remoteSpace,
      agent: c.cyan(shown) + (curName ? "" : ` ${c.dim(LOADER)}`),
      where,
      status: fields.status,
      machine: curName && whereKnown() ? okSlot(m ? machineColor(m)(m.label) : undefined) : loadingSlot(),
      info: away ? okSlot(undefined) : fields.info,
      ...(away ? { away: elsewhereBanner(away) } : {}),
      only: filter?.kind === "agent",
      bang: !away,
    };
  };
  /** Each field as the delta line says it, so a change after the banner scrolled is one line, not a reprint. */
  const fieldLines = (st: BannerState): Map<string, string> => {
    const out = new Map<string, string>();
    if (st.mode === "agent") {
      if (st.status.s !== "loading") out.set("status", `status: ${slotText(st.status, (s) => s, c)}`);
      // A field that loaded to NOTHING still gets its line: the banner on screen shows a loader for it,
      // and without a line saying it resolved that loader would read as loading forever.
      if (st.machine.s === "ok") out.set("machine", st.machine.v ? `on ${st.machine.v}` : "on: no machine known");
      if (st.info.s === "ok") out.set("info", st.info.v ? `model: ${st.info.v.model} · context: ${st.info.v.context}` : "model: no reading here");
      if (st.info.s === "err") out.set("info", `model: ${c.red(`✕ ${st.info.msg}`)}`);
    } else if (st.mode === "all" && st.roster.s === "ok") {
      out.set("roster", st.roster.v.length ? `${st.roster.v.length} live: ${st.roster.v.map((n) => c.cyan(n)).join(c.dim(" · "))}` : "no agents live yet");
    }
    return out;
  };
  let bannerSaid = new Map<string, string>();
  let bannerQueued = false;
  let resizedSinceBanner = false;
  /** Coalesce: every field change in one tick is one repaint. */
  const updateBanner = (): void => {
    if (!bannerEntry || bannerQueued || closing) return;
    bannerQueued = true;
    setImmediate(flushBanner);
  };
  function flushBanner(): void {
    bannerQueued = false;
    if (!bannerEntry || closing) return;
    // A paste is arriving (readline's echo is muted): hold the repaint until it has been staged.
    if (scanner.pasting || pasteOpen || swallow) return void setTimeout(updateBanner, 50).unref();
    const st = bannerState();
    const next = renderBanner(st, c);
    const lines = fieldLines(st);
    const changed = [...lines].filter(([k, v]) => bannerSaid.get(k) !== v);
    if (next === bannerEntry.text) return;
    bannerEntry.text = next; // a redraw (←/→) shows the current values either way
    bannerSaid = lines;
    if (!rl) return; // not on screen yet — the first paint shows it
    const cols = process.stdout.columns || 80;
    const promptRows = Math.floor(Math.max(0, displayWidth(stripVTControlCharacters(rl.getPrompt() + rl.line)) - 1) / cols) + 2;
    const inPlace = canRepaintInPlace({
      bannerIsLast: lastPainted === bannerEntry,
      resizedSince: resizedSinceBanner,
      tty: process.stdout.isTTY === true,
      chatView: showsChat(view),
      picking: picking || chooserHooks?.open() === true, // an in-place repaint would wipe the chooser drawn under it
      pasting: false,
      bannerRows,
      promptRows,
      screenRows: process.stdout.rows || 24,
    });
    if (inPlace) {
      readline.moveCursor(process.stdout, 0, -rl.getCursorPos().rows);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      readline.moveCursor(process.stdout, 0, -bannerRows);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(painter.paint(bannerEntry, view));
      bannerRows = paintedRows(next, cols);
      rl.prompt(true);
    } else {
      for (const [, line] of changed) show({ kind: "chat", text: c.dim(`  ${line}`), side: "sys", tight: false, bannerDelta: true });
    }
    markSettled();
  }
  /** The first paint: adopt the pre-shell's skeleton (erased and replaced in the same write) or paint fresh. */
  const paintBanner = (): void => {
    bannerEntry = { kind: "banner", text: renderBanner(bannerState(), c) };
    bannerSaid = fieldLines(bannerState());
    frame?.erase();
    show(bannerEntry);
    bannerRows = paintedRows(bannerEntry.text, process.stdout.columns || 80);
  };
  /** Timing mark: nothing on screen is still loading (PAW_CHAT_TIMING `settled`). */
  let settledMarked = false;
  function markSettled(): void {
    if (settledMarked || !ready || !bannerEntry || bannerEntry.text.includes(LOADER)) return;
    settledMarked = true;
    timing("settled");
  }
  /** model + context from the persona's transcript — local reads, done after the first prompt. */
  const loadInfo = (): void => {
    if (!curName) return;
    try {
      const personaPath = personaFilePath(space, curName);
      fields.info = okSlot(existsSync(personaPath) ? chatAgentInfo(personaPath) : undefined);
    } catch (e) {
      fields.info = failedSlot((e as Error).message);
    }
    updateBanner();
  };

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

  // Attached to the endpoint BEFORE it starts (boot → startEndpoint): a DM that lands the moment the
  // inbox binds is shown and acked, not left to redeliver a minute later.
  const onMessage = (m: CotalMessage, d: Delivery, meta: MessageMeta): void => {
    // A stale-id forward (src/stale-forward.ts): the sender DM'd one of "you"'s old ids and paw re-sent
    // it here. Show what the sender wrote, marked — the forwarder's note is addressed to agents.
    const fwdMark = forwardedFrom(m.parts) !== undefined ? c.dim(" · forwarded from an old id") : "";
    const text = textOf(fwdMark ? { ...m, parts: withoutForwardNote(m.parts) } : m);
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
      // Not shown, not marked read, and not printed either — a line per hidden message was the clutter
      // this mode exists to remove. The count lives in the prompt and redraws in place.
      hiddenCount++;
      if (rl && !closing && !bang) {
        rl.setPrompt(promptFor());
        rl.prompt(true);
      }
      d.ack();
      return;
    }
    if (meta.kind === "dm") {
      const from = m.from.name;
      // Already on screen in an earlier block (src/chat-backlog.ts): once is enough. It IS shown, so it
      // counts as read like any DM shown here — but it is not news: no follow, no reply-timing.
      if (m.id && shownIds.has(m.id)) {
        advanceCursor(space, m.ts);
        d.ack();
        return;
      }
      if (m.id) shownIds.add(m.id);
      if (view === "beads" && curName?.toLowerCase() === from.toLowerCase()) refreshBeadsSoon();
      // If this is the reply we were waiting on, clear the wait and note the round-trip time.
      let took = "";
      let stillPending = 0;
      if (!meta.historical) {
        const { answered, remaining } = awaiting.reply(from, m.replyTo);
        if (answered) {
          took = c.dim(` (${Math.max(1, Math.round((Date.now() - answered.at) / 1000))}s)`);
          stillPending = remaining;
        }
      }
      // The transcript is written BEFORE the DM goes out (the tool call is recorded, then it runs), so
      // the turn that produced this reply is already on disk. Capture it first, or the reply would land
      // above the work that led to it — the live feed is push, the transcript is a 1s poll.
      pumpLogs();
      // `from` tags it as inbound mail: the logs view keeps another agent's DM visible, and shows the
      // target's as the transcript's `↩ you` block instead (entryVisible).
      if (curName && from.toLowerCase() === curName.toLowerCase()) emit(said(`${tag}${agentTag(from)}${fwdMark}${age}${took}${c.dim(":")}`, text), "peer", false, from);
      else emit(said(`${tag}${c.magenta("(DM)")} ${agentTag(from, c.bold)}${fwdMark}${age}${took}${c.dim(":")}`, text), "peer", false, from);
      if (stillPending) emit(c.dim(`⏳ still waiting for ${from} on ${stillPending} more message${stillPending === 1 ? "" : "s"}`), "you");
      advanceCursor(space, m.ts); // shown here = seen, so `paw inbox` won't re-surface it as new
      // Follow the conversation: an empty input means you have not started a reply to anyone else, so
      // the next thing you type is almost certainly for whoever just spoke. Announced, never silent —
      // a target that moves without saying so is how a line goes to the wrong agent.
      // Not in a logs view either: there you are WATCHING one agent's trace, the same commitment a
      // filtered session makes — following a DM there swapped the whole screen to another agent's log
      // with no visible reason (the critic reproduced it: DM hidden, announcement hidden, trace changed).
      // Never while lines typed before the connect are waiting to replay: they were typed for the target
      // on screen THEN, and a backlog DM must not retarget them.
      const holding = !ready || replaying || deferred.count > 0;
      if (!filter && showsChat(view) && shouldFollowDm({ from, curName, typed: rl?.line ?? "", held: held.length, staged: pending.length + pastes.length, historical: !!meta.historical, ageMs: Date.now() - m.ts, holding })) {
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
      if (m.id) shownIds.add(m.id); // the messages view's tap won't print it a second time
      const line: Entry = { kind: "chat", text: said(`${tag}${c.dim("#" + ((m as { channel?: string }).channel ?? "?"))} ${m.from.name}${age}${c.dim(":")}`, text), side: "peer", tight: false };
      // The tap beat this delivery and placed it as a peer row: the line takes the row's place, once.
      if (!swapPeerRowFor(m.id, line)) show(line);
    }
    d.ack(); // surfaced = recorded
  };

  // Declared before the tap starts (a frame can arrive the moment it does — a TDZ throw in a tap
  // handler kills the feed for good).
  /** Every "you" send this chat has SHOWN (typed here, or echoed from another session), by id with its
   *  recipient — what a later stale-id forward of it is paired against. Bounded, oldest out. */
  const shownSends = new Map<string, { id: string; to?: string; from: { id?: string } }>();
  const noteShownSend = (m: { id?: string; to?: string }): void => {
    if (!m?.id) return;
    shownSends.set(m.id, { id: m.id, to: m.to, from: { id: me } });
    if (shownSends.size > 2000) shownSends.delete(shownSends.keys().next().value!);
  };

  /**
   * Every `paw chat` runs as the SAME peer ("you"), so a message one session sends is addressed to the
   * agent, not to "you" — the other open sessions never receive it and their transcripts silently
   * diverge. Tap the space (a plain NATS subscribe: ephemeral, no durable consumer, so it cannot
   * contend with the inbox) and surface anything sent by "you" that THIS process didn't send.
   *
   * `ownIds` makes that exact rather than heuristic: unicast/multicast mint a uuid per message and
   * hand it back, so "mine" is an id lookup, not a text-and-timestamp guess.
   *
   * On a remote space the tap is narrowed to "you"'s own send subjects (src/chat-own.ts) — the agent
   * cred chat holds may not subscribe to the whole space.
   */
  const onOwnSend = (_subject: string, m: unknown): void => {
    // A space-wide tap also sees non-message frames (control replies are bare {ok,data} with no
    // `from`), and core does not try/catch this handler — an unguarded deref kills the feed for good.
    const msg = m as CotalMessage & { to?: string; channel?: string };
    if (!msg || typeof msg !== "object" || !msg.from || !msg.id) return;
    if (msg.from.id !== me) return; // another peer entirely — the normal message handler owns that
    // Your DM to an agent's OLD id, re-sent by the stale-id forwarder to its live one: the same message.
    // When this chat already showed the original (you typed it here, or echoed it from another
    // session), the forward is not a second line. Paired exactly (src/forward-mark.ts), never by text.
    const forwardOf = forwardedFrom(msg.parts);
    if (forwardOf !== undefined) {
      const fwd = { id: msg.id, to: msg.to, from: { id: msg.from.id }, forwardOf };
      for (const o of shownSends.values()) if (isForwardOf(fwd, o)) return;
    }
    // Our sends are recorded in ownIds BEFORE they are published (the outbox drafts the id), so the
    // echo can't outrun the record; a short grace and re-check stays for safety. Deciding on a send
    // whose id was only known after `unicast` returned is what once made a session label its OWN
    // message "(other session)".
    const decide = (attempt: number): void => {
      if (ownIds.has(msg.id)) return; // ours after all — the send resolved while we waited
      if (shownIds.has(msg.id)) return; // already in an earlier block
      if (attempt < 3) {
        setTimeout(() => decide(attempt + 1), 100);
        return;
      }
      try {
        const body = textOf(forwardOf !== undefined ? { ...msg, parts: withoutForwardNote(msg.parts) } : msg);
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
          : toName ? agentTag(toName) : c.cyan(msg.to ? msg.to.slice(0, 8) : "?");
        noteShownSend(msg);
        shownIds.add(msg.id);
        const fwdMark = forwardOf !== undefined ? " · forwarded from an old id" : "";
        const header = `${c.dim("↗ you →")} ${label}${c.dim(` (other session${fwdMark}):`)}`;
        // As the agent got it, readable: on the rail, blank runs folded, each paste inline at its
        // placeholder (not as raw `--- [Pasted text #1] ---` fences). The painter indents rows 2+.
        const sent = parseComposed(body);
        const rows = railMessage(sent.body, sent.blocks, { ...viewOpts(), width: viewOpts().width - 2, rail: RAIL.trimStart() });
        emit(rows.length === 1 && !sent.blocks.length ? `${header} ${sent.body.trim()}` : [header, ...rows].join("\n"), "you");
      } catch {
        /* a render failure must never abort the tap iterator */
      }
    };
    decide(0);
  };
  /** Stops the remote half of the echo (started once ready, src/chat-own.ts startEcho). */
  let stopOwnTap: (() => Promise<void>) | undefined;

  // ── the earlier block (src/chat-backlog.ts) ──────────────────────────────────────────────────────
  // What was said with the target BEFORE this chat, read from the DM stream behind the prompt (a `◌`
  // loader holds its place) and put on screen between `── earlier ──` and `── now ──`, dimmed. It never
  // passes through onMessage: history can't retarget, answer an await, or mark anything read.
  /** Every message id this chat has put on screen — live DMs, the echo, earlier blocks. Our own sends
   *  are in `ownIds`. An earlier block skips these; a live copy of an earlier-block message is dropped. */
  const shownIds = new Set<string>();
  /** Per agent (lowercased): the first earlier block this chat drew for it — `/more` reaches back past
   *  its oldest message and grows it in place. */
  const backlogs = new Map<string, { divider: Entry & { kind: "chat" }; agent: string; count: number; oldest: number; older: number; windowed: boolean }>();
  /** Agents whose earlier block has been asked for this session (on open, on a switch). */
  const backlogAsked = new Set<string>();
  const dimAll = (s: string): string =>
    s
      .split("\n")
      .map((l) => c.dim(stripVTControlCharacters(l)))
      .join("\n");
  /** One earlier message, drawn as its live twin would be (markdown, images, pastes on the rail) — dimmed. */
  const historyEntry = (agent: string, e: FeedEntry): Entry => {
    const age = agoTag(e.ts);
    let text: string;
    if (e.dir === "out") {
      const sent = parseComposed(e.text);
      const header = `you → ${agent}${age}:`;
      const rows = railMessage(sent.body, sent.blocks, { ...viewOpts(), width: viewOpts().width - 2, rail: RAIL.trimStart() });
      text = rows.length === 1 && !sent.blocks.length ? `${header} ${sent.body.trim()}` : [header, ...rows].join("\n");
    } else text = said(`${agentTag(e.from)}${e.forwardedFrom !== undefined ? " · forwarded from an old id" : ""}${age}:`, e.text);
    return { kind: "chat", text: dimAll(text), side: e.dir === "out" ? "you" : "peer", tight: false, historical: true, ts: e.ts };
  };
  const sysLine = (text: string, historical = true): Entry & { kind: "chat" } => ({ kind: "chat", text, side: "sys", tight: true, ...(historical ? { historical: true } : {}) });

  /**
   * Put `block` where the loader `slot` stands. While the loader is still the last thing painted (the
   * usual case — it was shown a moment ago), it is erased and the block painted in its place; otherwise
   * the chat view is redrawn, like a view switch. Another view shows it on the way back to chat. With
   * the picker or chooser open the history is updated and the screen follows on the next redraw.
   */
  function placeOver(slot: Entry, block: Entry[]): void {
    const cols = process.stdout.columns || 80;
    const inPlace = slot === lastPainted && lastPaint !== undefined && lastPaint.cols === cols;
    const was = lastPaint;
    history.replace(slot, block);
    if (!rl || closing || !process.stdout.isTTY || !showsChat(view) || picking || chooserHooks?.open()) return;
    if (!inPlace || !was) return redraw();
    readline.moveCursor(process.stdout, 0, -rl.getCursorPos().rows);
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
    readline.moveCursor(process.stdout, 0, -paintedRows(was.text, cols));
    readline.clearScreenDown(process.stdout);
    painter.lastSide = was.before.lastSide;
    painter.trailingBlank = was.before.trailingBlank;
    let out = "";
    lastPainted = undefined;
    lastPaint = undefined;
    for (const e of block) {
      if (!entryVisible(e, view, curName, follower.readable(curName))) continue;
      const before = { lastSide: painter.lastSide, trailingBlank: painter.trailingBlank };
      const text = painter.paint(e, view);
      out += text;
      if (text) {
        lastPainted = e;
        lastPaint = { text, before, cols };
      }
    }
    process.stdout.write(out);
    rl.prompt(true);
  }

  /** Remove a loader that turned out to have nothing to say (a re-switch with everything shown). */
  function dropLoader(slot: Entry): void {
    placeOver(slot, []);
  }

  /**
   * Load the earlier block for `agent` — `more` = that many OLDER messages (`/more`). Never awaited by
   * anything: the prompt keeps taking keys, a `◌` line holds the block's place, and a failed read says
   * so in red where the block would have been (never an empty block that looks like "no history").
   */
  function loadBacklog(agent: string, more?: number): void {
    if (!interactive || !ep) return;
    if (more === undefined && historySize.limit === 0) return;
    const key = agent.toLowerCase();
    backlogAsked.add(key);
    const first = backlogs.get(key);
    const slot = sysLine(c.dim(`${LOADER} loading ${more ? `${more} older` : "earlier"} messages with ${agent}…`));
    show(slot);
    const ids = new Set<string>();
    if (curId && curName?.toLowerCase() === key) ids.add(curId);
    readOwnConversation(ep, space, server).then(
      (conv) => {
        if (closing) return;
        if (!history.entries.includes(slot)) return; // gone (a reconnect reset) — nothing to place
        const shown = (id: string): boolean => shownIds.has(id) || ownIds.has(id);
        let pick;
        try {
          pick = pickBacklog(conv, agent, { ...(more !== undefined ? { limit: more } : historySize), now: Date.now(), shown, ids, ...(more !== undefined && first ? { before: first.oldest } : {}) });
        } catch (e) {
          return placeOver(slot, [sysLine(c.red(`! couldn't show earlier messages with ${agent}: ${(e as Error).message}`), false)]);
        }
        for (const e of pick.entries) shownIds.add(e.id!);
        const rows = pick.entries.map((e) => historyEntry(agent, e));
        if (more !== undefined && first) {
          if (!rows.length) return placeOver(slot, [sysLine(c.dim(`(no older messages with ${agent})`))]);
          first.count += rows.length;
          first.oldest = pick.entries[0]!.ts;
          first.older = pick.older;
          first.windowed = false;
          first.divider.text = c.dim(earlierDivider(first.agent, first.count, first.older, false));
          history.replace(slot, []);
          history.insertAt(moreInsertAt(history.entries, (e) => e === first.divider)!, rows);
          return redraw();
        }
        if (!rows.length) {
          // Already on screen (a re-switch): nothing to add, nothing to say.
          if (first) return dropLoader(slot);
          return placeOver(slot, [sysLine(c.dim(nothingEarlier(agent, pick.older)))]);
        }
        const windowed = more === undefined && historySize.windowMs !== undefined;
        const divider = sysLine(c.dim(earlierDivider(agent, rows.length, pick.older, windowed)));
        if (!first) backlogs.set(key, { divider, agent, count: rows.length, oldest: pick.entries[0]!.ts, older: pick.older, windowed });
        placeOver(slot, [divider, ...rows, sysLine(c.dim(NOW_DIVIDER))]);
      },
      (e: Error) => {
        if (closing || !history.entries.includes(slot)) return;
        placeOver(slot, [sysLine(c.red(`! couldn't load earlier messages with ${agent}: ${e.message} — /more retries`), false)]);
      },
    );
  }

  // ── the messages view's other-peer rows (src/chat-peers.ts) ──────────────────────────────────────
  // What the target said to and heard from everyone but "you", indented right and dimmed. Open mesh:
  // live off a space-wide tap, earlier rows from the DM + channel streams. Remote: the operator-only
  // `chat-peers` cred on the target's own subjects — signed per read, plus one live tap for the current
  // target (src/chat-own.ts tapAgentTraffic), retired on a switch and read back when it comes back.
  /** Every id → name the tap has seen a sender use (a DM's `to` is a bare id). */
  const peerIdNames = new Map<string, string>();
  /** Agents whose other-peer history has been read (or is being read) this session, key → name. From
   *  then on the tap captures their traffic whether or not they are the target, so @kit → @bob → @kit
   *  shows what kit said in between; a gap in the tap (a disconnect) is read back ({@link catchUpPeers}). */
  const peerAgents = new Map<string, string>();
  /** `<agent key>\0<id>` of every other-peer row placed — per agent: kit → bob is a row under both. */
  const peerShown = new Set<string>();
  const peerKey = (agent: string, id: string): string => `${agent.toLowerCase()}\0${id}`;
  /** Every DM placed as a peer row, by id — what a later stale-id forward of it pairs against. Bounded. */
  const peerOriginals = new Map<string, PeerMsg>();
  /** When the tap stopped seeing frames (a transport drop, an endpoint gone) — read back on the way up. */
  let peerDownAt: number | undefined;
  const peerNameOf = (id: string): string | undefined => rosterName(id) ?? peerIdNames.get(id);
  /** Every id `agent` is known by: its live id, roster cards, what the tap saw, paw's ledger. */
  const agentIdsFor = (agent: string): Set<string> => {
    const key = agent.toLowerCase();
    const ids = new Set<string>();
    if (curId && curName?.toLowerCase() === key) ids.add(curId);
    for (const p of roster() ?? []) if (p.card.name.toLowerCase() === key) ids.add(p.card.id);
    for (const [id, n] of peerIdNames) if (n.toLowerCase() === key) ids.add(id);
    for (const [id, e] of Object.entries(cachedLedger(space))) if (e.name.toLowerCase() === key) ids.add(id);
    return ids;
  };
  /** Already on screen: as a chat line ("you"'s own mail, a channel post "you" receive), as this
   *  agent's row, or as the forward of a DM already shown. */
  const peerPlaced = (agent: string, p: PeerMsg): boolean =>
    shownIds.has(p.id) || ownIds.has(p.id) || peerShown.has(peerKey(agent, p.id)) || (p.forwardOf !== undefined && [...peerOriginals.values()].some((o) => isPeerForwardOf(p, o)));
  const markPeer = (agent: string, p: PeerMsg): void => {
    peerShown.add(peerKey(agent, p.id));
    if (p.toId === undefined || p.forwardOf !== undefined) return;
    peerOriginals.set(p.id, p);
    if (peerOriginals.size > 2000) peerOriginals.delete(peerOriginals.keys().next().value!);
  };
  const peerEntry = (agent: string, p: PeerMsg, historical: boolean): Entry => ({ kind: "peer", agent, msg: p, ...(historical ? { historical: true } : {}) });
  const peerNote = (text: string): Entry & { kind: "chat" } => ({ kind: "chat", text, side: "sys", tight: true, onlyMessages: true });
  /** Agents already told that their oldest ids are past the chat-peers cap — said once each. */
  const peerOmittedSaid = new Set<string>();
  const onPeerOmitted = (agent: string) => (n: number): void => {
    if (peerOmittedSaid.has(agent.toLowerCase())) return;
    peerOmittedSaid.add(agent.toLowerCase());
    show(peerNote(c.yellow(`! ${agent} has had more than ${MAX_PEER_IDS} mesh ids — messages on its ${n} oldest aren't read`)));
  };
  const readPeers = (e: CotalEndpoint, agent: string): Promise<PeerMsg[]> =>
    readPeerTraffic(e, space, server, agent, agentIdsFor(agent), peerNameOf, { onOmitted: onPeerOmitted(agent) });

  // Remote: ONE live chat-peers tap, on the current target. A switch retires it (when, per agent, so
  // coming back reads the time it was off back); a failed start or renewal is a red line.
  let peerTap: { key: string; stop?: () => Promise<void> } | undefined;
  const peerTapOffAt = new Map<string, number>();
  function ensurePeerTap(): void {
    if (!remoteSpace || !curName || closing) return;
    const key = curName.toLowerCase();
    if (peerTap?.key === key) return;
    if (peerTap) retirePeerTap();
    const agent = curName;
    const tap: { key: string; stop?: () => Promise<void> } = { key };
    peerTap = tap;
    const offAt = peerTapOffAt.get(key);
    tapAgentTraffic(space, server, agent, () => agentIdsFor(agent), onPeerTraffic, (e) => emit(c.red(`! messages view: ${e.message}`)), onPeerTransport, { onOmitted: onPeerOmitted(agent) }).then(
      (stop) => {
        if (peerTap !== tap || closing) return void stop();
        tap.stop = stop;
        if (offAt !== undefined) {
          peerTapOffAt.delete(key);
          catchUpPeers(offAt - PEER_GAP_SLACK_MS, [agent]);
        }
      },
      (e: Error) => {
        if (peerTap === tap) peerTap = undefined;
        emit(c.red(`! messages view: couldn't tap ${agent}'s messages with other peers: ${e.message}`));
      },
    );
  }
  function retirePeerTap(): void {
    const t = peerTap;
    if (!t) return;
    peerTap = undefined;
    if (peerAgents.has(t.key)) peerTapOffAt.set(t.key, Date.now());
    void t.stop?.().catch(() => {});
  }

  /** A frame off the space-wide tap: other-peer traffic of the target or any tracked agent becomes a row
   *  (shown in the messages view only). Never news: no follow, no await, no cursor. */
  const onPeerTraffic = (_subject: string, raw: unknown): void => {
    const msg = raw as (CotalMessage & RawMsg) | undefined;
    if (!msg || typeof msg !== "object" || !msg.from || !msg.id || !Array.isArray(msg.parts)) return;
    if (msg.from.id && msg.from.name) peerIdNames.set(msg.from.id, msg.from.name);
    if (!me) return;
    const agents = new Map(peerAgents);
    if (curName) agents.set(curName.toLowerCase(), curName);
    for (const agent of agents.values()) {
      try {
        const who = classifyPeer(msg, { agent, agentIds: agentIdsFor(agent), me, nameOf: peerNameOf });
        if (!who) continue;
        const p = peerMsg(msg, who);
        // A channel post "you" also receive comes through onMessage as a chat line. Give that a beat;
        // if it lands after this row anyway, onMessage swaps the row for the line (exact, by id).
        setTimeout(() => {
          if (closing || peerPlaced(agent, p)) return;
          markPeer(agent, p);
          show(peerEntry(agent, p, false));
        }, msg.channel ? 300 : 0).unref();
      } catch (e) {
        emit(c.red(`! messages view: couldn't show a message between ${agent} and another peer: ${(e as Error).message}`));
      }
    }
  };

  /**
   * A channel post onMessage is about to print as a chat line that the tap already placed as a peer row
   * (delivery slower than the tap's beat): put the line where the row stood, drop any other copy, and
   * report that it did. The caller prints nothing more.
   */
  function swapPeerRowFor(id: string | undefined, line: Entry): boolean {
    if (!id) return false;
    const rows = history.entries.filter((e) => e.kind === "peer" && e.msg.id === id);
    if (!rows.length) return false;
    history.replace(rows[0]!, [line]);
    for (const r of rows.slice(1)) history.replace(r, []);
    if (view !== "beads") redraw(); // the beads view paints no conversation
    return true;
  }

  /**
   * The messages view's earlier other-peer rows for the target — once per agent per session, sized like
   * the earlier block (`--history`), behind a `◌` loader, never blocking keys. They are merged by time
   * into that agent's earlier block when there is one; a summary line takes the loader's place. A
   * failed read says so in red. On a remote space it also keeps the live tap on the target.
   */
  function ensurePeers(): void {
    if (!showsPeers(view) || !curName || !interactive || !ep) return;
    ensurePeerTap();
    if (historySize.limit === 0) return;
    const key = curName.toLowerCase();
    if (peerAgents.has(key)) return;
    const agent = curName;
    peerAgents.set(key, agent); // the tap captures it from here on, target or not
    const slot = peerNote(c.dim(`${LOADER} loading ${agent}'s messages with other peers…`));
    show(slot);
    readPeers(ep, agent).then(
      (msgs) => {
        if (closing || !history.entries.includes(slot)) return;
        const placed = new Set(msgs.filter((m) => peerPlaced(agent, m)).map((m) => m.id));
        const pick = pickPeers(msgs, { ...historySize, now: Date.now(), shown: (id) => placed.has(id) });
        for (const p of pick.entries) markPeer(agent, p);
        const rows = pick.entries.map((p) => peerEntry(agent, p, true));
        const summary = peerNote(c.dim(peerSummary(agent, rows.length, pick.older, historySize.windowMs !== undefined)));
        const noPast = remoteSpace && !Object.values(cachedLedger(space)).some((e) => e.name.toLowerCase() === key);
        const tail = noPast ? [summary, peerNote(c.yellow(remoteNoPastIdsNote(agent, space)))] : [summary];
        const block = backlogs.get(key);
        const from = block ? history.entries.indexOf(block.divider) + 1 : 0;
        const nowAt = from > 0 ? history.entries.findIndex((e, i) => i >= from && e.kind === "chat" && e.historical === true && stripVTControlCharacters(e.text) === NOW_DIVIDER) : -1;
        if (!rows.length || nowAt < 0) return placeOver(slot, [...rows, ...tail]);
        const merged = mergeByTs(history.entries, from, nowAt, rows, (e) => (e.kind === "peer" ? e.msg.ts : e.kind === "chat" ? e.ts : undefined));
        history.entries.splice(0, history.entries.length, ...merged);
        history.replace(slot, tail);
        redraw();
      },
      (e: Error) => {
        if (closing || !history.entries.includes(slot)) return;
        placeOver(slot, [peerNote(c.red(`! couldn't load ${agent}'s messages with other peers: ${e.message}`))]);
      },
    );
  }

  /**
   * The tap was down (`since` = when): read back every tracked agent's (or just `only`'s) other-peer
   * traffic from then and place what isn't on screen yet, oldest first, under a line saying where it
   * came from. A failed read says so in red — a silent gap is the failure this exists to close.
   */
  function catchUpPeers(since: number, only?: string[]): void {
    if (!ep || closing || !peerAgents.size) return;
    const e = ep;
    for (const agent of only ?? [...peerAgents.values()]) {
      readPeers(e, agent).then(
        (msgs) => {
          if (closing) return;
          const fresh = msgs.filter((p) => p.ts >= since && !peerPlaced(agent, p));
          if (!fresh.length) return;
          show(peerNote(c.dim(`── ${fresh.length} message${fresh.length === 1 ? "" : "s"} between ${agent} and other peers while the connection was down ──`)));
          for (const p of fresh) {
            markPeer(agent, p);
            show(peerEntry(agent, p, false));
          }
        },
        (err: Error) => emit(c.red(`! messages view: couldn't read back ${agent}'s messages with other peers after the connection came back: ${err.message}`)),
      );
    }
  }
  /** The endpoint's transport went down / came back: note the gap, read it back once it closes. */
  const onPeerTransport = (connected: boolean): void => {
    if (!connected) peerDownAt ??= Date.now();
    else if (peerDownAt !== undefined) {
      const since = peerDownAt - PEER_GAP_SLACK_MS;
      peerDownAt = undefined;
      catchUpPeers(since);
    }
  };

  // Joins/departures are held while the view can't be trusted and debounced while it can
  // (src/presence-hold.ts) — a slow broker flapped `joined` / `went offline` pairs for live peers.
  type Card = Presence["card"];
  const presenceQuiet = (now: number): boolean =>
    !ep || !conn || conn.phase(now) !== "connected" || !ep.presenceView().fresh || ep.presenceWriteFailure()?.stuck === true;
  let peerHold = new PresenceHold<Card, PresenceStatus>();
  const printPeerLines = (lines: PresenceLine<Card, PresenceStatus>[]): void => {
    for (const l of lines) {
      if (!presenceVisible(filter, l.card.name)) continue;
      if (l.type === "join") emit(`${c.green("→")} ${who(l.card)} joined ${statusBadge(l.status)}`);
      else emit(c.dim(`← ${who(l.card)} went offline`));
    }
  };
  /**
   * The presence view was read for the first time: the roster is now a fact, not a blank. Everyone in
   * it is "already here" (seeded, not announced as joins), and every loader waiting on it fills in.
   */
  const onRosterSeen = (): void => {
    if (rosterSeen || !ep || !ep.presenceView().fresh) return;
    rosterSeen = true;
    timing("roster");
    peerHold.seed(ep.getRoster().filter((p) => p.card.id !== me).map((p) => ({ id: p.card.id, card: p.card, status: p.status })));
    updateBanner();
    refreshFooter();
  };

  const onPresence = (ev: { type: string; presence: Presence }): void => {
    const card = ev.presence.card;
    if (card.id === me) return;
    onRosterSeen();
    if (rosterSeen && (ev.type === "join" || ev.type === "offline"))
      printPeerLines(peerHold.feed({ type: ev.type, id: card.id, card, status: ev.presence.status }, presenceQuiet(Date.now()), Date.now()));
    // A restarted agent comes back under a NEW id. Follow it, or every later line goes to the dead id —
    // the send still succeeds (the DM stream stores it) and nobody ever reads it (benmore-intern, 2026-09-16).
    if (ready && ev.type !== "offline" && curName && card.name === curName && card.id !== curId) curId = card.id;
    // The agent that couldn't be reached at startup came up after all: lines to it send again.
    if (ready && ev.type !== "offline" && ev.presence.status !== "offline" && targetLost && card.name.toLowerCase() === targetLost.name.toLowerCase()) {
      targetLost = undefined;
      if (lookup === "absent" || lookup === "unreachable") {
        lookup = "found";
        closeChooser();
      }
      if (curName?.toLowerCase() === card.name.toLowerCase()) curId = card.id;
      fields.status = okSlot(c.green("live on the mesh"));
      emit(c.green(`→ ${card.name} is on the mesh now — lines to it send again`));
      rl?.setPrompt(promptFor());
      updateBanner();
    }
    if (view === "beads" && card.name === curName) {
      refreshBeadsSoon();
      paintTasks(); // the title row carries its live status
    }
    if (!presenceVisible(filter, card.name)) return;
    // Track the status on join/offline too, so the next flip into working is judged against the truth.
    const picked = awaiting.presence(card.name, ev.type === "offline" ? "offline" : ev.presence.status);
    if (ev.type === "join" || ev.type === "offline") return;
    if (picked.length) {
      // A NEW turn began on an agent we're waiting on — an explicit "got it, on it" receipt for the
      // messages sent before it (otherwise the only feedback is the final reply, minutes away).
      const what = picked.length === 1 ? "picked it up" : `picked up your ${picked.length} messages`;
      emit(`${c.green("✓")} ${card.name} ${what}${ev.presence.activity ? c.dim(" — " + activityLine(ev.presence.activity)) : c.dim(" — working…")}`, "you");
    }
    // A plain status flip (idle ↔ working, activity updates) is NOT a transcript line any more — a
    // line per flip buried the conversation (team2027, 2026-10-27). The footer shows the target's live
    // status (or, with no target, who is working); `/who` lists everyone.
    refreshFooter();
  };

  // Tab-complete `@name` mentions. Names are the UNION of the live roster (present peers) + paw's
  // folder→name registry (every KNOWN agent, live or offline) — so you can `@`-wake a durable agent
  // (e.g. `@team2027-research`) that isn't present, matching the in-REPL respawn-a-known-agent
  // behavior. completeMention (pure/tested) finds the `@partial` under the cursor anywhere in the line.
  const completer = (line: string): [string[], string] => {
    const live = (roster() ?? []).filter((p) => p.card.id !== me).map((p) => p.card.name);
    const registered = listAgents(space).map((a) => a.name);
    return completeMention(line, [...live, ...registered]);
  };

  /** Readline, with paw's prompt/hint wrapper and paste-echo muting. Created once everything it reads
   *  exists — in a tty that is the first frame, before the mesh; in a pipe, after the connect. */
  function createRepl(): readline.Interface {
    const r = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: promptFor(),
      completer,
    });
    rl = r;
    // Ctrl-Z. readline's own suspend stops the process with the terminal still in mouse reporting and
    // bracketed paste — every wheel in the parent shell then typed `\e[<64;…M` into it. Listening takes
    // the suspend over (readline then does none of it): give the terminal back, stop, and on `fg` take
    // the modes back and repaint whatever the shell drew over.
    r.on("SIGTSTP", () => {
      if (process.stdin.isTTY) {
        process.stdout.write((mouseOn ? MOUSE_OFF : "") + DISABLE_BRACKETED_PASTE);
        process.stdin.setRawMode(false);
      }
      mouseOn = false;
      process.once("SIGCONT", () => {
        if (closing) return;
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdout.write(ENABLE_BRACKETED_PASTE);
        }
        r.resume();
        syncMouse();
        tasksPainted = ""; // the beads view repaints from a clear screen
        redraw();
      });
      // SIGSTOP, not SIGTSTP: the kernel discards SIGTSTP in an orphaned process group (a chat that is
      // its session's leader — a pty spawned straight into it), and the stop never happened. The shell's
      // job control reports a SIGSTOP the same way.
      process.kill(process.pid, "SIGSTOP");
    });
    // Every redraw of the prompt redraws the hint beneath it. Wrapping the one method all ~20 call
    // sites go through beats threading drawHint() through each of them, where the next new call site
    // would be the one that forgets.
    const basePrompt = r.prompt.bind(r);
    r.prompt = (preserveCursor?: boolean) => {
      // readline's prompt() WITHOUT `true` sets the cursor to column 0 of the line — harmless on an empty
      // line, wrong on a line you're typing. The line handler is async: it awaits the `!cmd` (or the
      // send) and re-prompts when that returns, by which time you've started the next message — so the
      // caret jumped to its start and your next keys landed at the front of it (operator, 2026-09-28).
      // Whatever called prompt(), text in the buffer keeps its caret.
      basePrompt(preserveCursor || r.line.length > 0);
      drawHint();
    };

    // A paste is payload, not typing — but readline echoes it line by line and redraws the prompt after
    // every newline, so a 16-line paste painted sixteen `you → x>` lines that looked like sixteen sends
    // (it was one message; reported 2026-09-16). Readline's output is muted while a paste is open or
    // being swallowed; stagePaste (or the short-paste redraw) repaints the line once it is known.
    // `_writeToOutput` is readline's single internal write path — fail loud if a node release drops it.
    const rlInternal = r as unknown as { _writeToOutput?: (s: string) => void };
    if (typeof rlInternal._writeToOutput !== "function") throw new Error("paw chat: readline._writeToOutput is gone — paste echo muting needs a new hook");
    const writeToOutput = rlInternal._writeToOutput.bind(r);
    rlInternal._writeToOutput = (str: string) => {
      if (scanner.pasting || pasteOpen || swallow) return;
      writeToOutput(str);
    };
    r.on("line", (line) => void onLine(line));
    // readline echoed the submitted line below the beads panel; repaint over it whatever the send does.
    r.on("line", () => {
      if (view === "beads") setImmediate(() => paintTasks(true));
    });
    r.on("close", () => void shutdown());
    // Raw mode turns Ctrl-C into a keystroke readline reports as SIGINT; with no listener it closes.
    r.on("SIGINT", () => void shutdown());
    return r;
  }

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
  const mine = <T extends { id?: string }>(m: T): T => {
    if (m?.id) ownIds.add(m.id);
    noteShownSend(m as { id?: string; to?: string });
    return m;
  };

  /**
   * Every message this chat sends goes through the outbox (src/outbox.ts): drafted here with an id WE
   * own (src/mesh-publish.ts), recorded as ours before it is published (so the echo tap never races
   * it), and retried through a flaky link with that same id — a copy that did land is deduped by the
   * broker. A bare `! timeout` after a send (team2027, 2026-10-27) left the operator unable to tell
   * whether it went; now the transcript says `◌ sending…` while it retries, `✓ sent` when it lands,
   * and ONE `✕ not sent … /retry` when it gives up.
   */
  interface Outgoing {
    msg: CotalMessage;
    /** The agent whose reply to await (⏳ / ✓ picked it up) once it lands; none for a channel post. */
    awaitFrom?: string;
  }
  const preview = (m: CotalMessage): string => {
    const t = textOf(m).replace(/\s+/g, " ").trim();
    return t.length > 48 ? `${t.slice(0, 47)}…` : t;
  };
  const secsOf = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;
  const onOutEvent = (e: OutEvent<Outgoing>): void => {
    const { item } = e;
    const o = item.msg;
    if (e.kind === "pending") {
      emit(c.dim(`◌ sending… ${HUMAN_PEER} → ${item.label}: ${preview(o.msg)}   (${shortReason(e.error)} — retrying)`), "you");
    } else if (e.kind === "sent") {
      const lead = item.retried ? `✓ sent after ${secsOf(Date.now() - item.firstAt)} · ` : "";
      if (o.awaitFrom) markWaiting(o.awaitFrom, o.msg, lead);
      else if (lead) emit(c.dim(`✓ sent to ${item.label} after ${secsOf(Date.now() - item.firstAt)}`), "you");
    } else {
      const why = e.transient ? `${shortReason(e.error)} — no ack in ${secsOf(Date.now() - item.firstAt)}, ${item.attempts} tries` : e.error;
      emit(c.red(`✕ not sent to ${item.label}: ${why} — /retry to send again`) + c.dim(`   (${preview(o.msg)})`), "you");
    }
    refreshFooter();
  };
  /** A send whose ack timed out may be riding a socket that died silently: PING it, replace it if dead. */
  const publishProbed = async (o: Outgoing) => {
    try {
      return await publishDraft(needEp(), o.msg);
    } catch (err) {
      if (isAckTimeout(err)) void linkProbe.check().catch((e: Error) => emit(c.red(`! ${e.message}`)));
      throw err;
    }
  };
  const outbox = new Outbox<Outgoing>({ publish: publishProbed, onEvent: onOutEvent });
  outboxRef = outbox;
  /** Queue a DM to `toId` (the agent `name`). `awaitReply` false: no ⏳ tracking (a stuck seat). */
  const sendDm = (name: string, toId: string, text: string, awaitReply = true): void => {
    const msg = mine(draftDm(needEp(), toId, text));
    void outbox.submit(name, { msg, ...(awaitReply ? { awaitFrom: name } : {}) });
    refreshFooter();
  };
  const sendPost = (channel: string, text: string): void => {
    const msg = mine(draftPost(needEp(), channel, text));
    void outbox.submit(`#${channel}`, { msg });
    refreshFooter();
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

  /** Width + paint for the rail renderer (src/compose-view.ts). */
  const viewOpts = (): ViewOpts => ({ width: process.stdout.columns || 80, dim: c.dim });
  /** Print rows that belong to the draft as ONE logical unit: one tight entry per row (the painter would
   *  indent the rows of a multi-row entry, pushing them off the rail), returned so they can be taken back. */
  const emitRows = (rows: string[]): Entry[] =>
    rows.map((r) => {
      emit(r, "you", true);
      return history.entries[history.entries.length - 1];
    });

  /** Take what's typed onto the held stack and clear the line, so the next one starts fresh. */
  const holdLine = (line: string): void => {
    if (!rl || closing) return;
    // The FIRST line of a draft reads as readline's own echo would (prompt + text); every later one sits
    // on the rail the continuation prompt draws — so the draft, the line being typed and, once sent, the
    // whole message read as ONE block instead of a column of `│` fragments under an unchanged prompt.
    const rows = held.length ? railLine(line, stage().pastes, viewOpts()) : [rl.getPrompt() + line, ...railPastes(line, stage().pastes, viewOpts())];
    held.push(line);
    rl.write(null, { ctrl: true, name: "u" }); // same buffer rewrite the paste staging uses
    rl.write(null, { ctrl: true, name: "k" });
    rl.setPrompt(promptFor()); // the continuation prompt: the rail
    // Clearing the buffer also erases what you just typed, so REPRINT it. Without this the line you
    // continued from simply vanishes and you are composing a message you can no longer see — the
    // opposite of what a multi-line editor is for. TIGHT: these lines are one message taking shape.
    heldEntries.push(emitRows(rows));
  };

  /** Drop the last `n` held lines (and their rows) and reprint the screen without them. */
  const unholdLines = (n: number): string[] => {
    const taken = held.splice(held.length - n, n);
    const gone = new Set(heldEntries.splice(heldEntries.length - n, n).flat());
    for (let i = history.entries.length - 1; i >= 0; i--) if (gone.has(history.entries[i])) history.entries.splice(i, 1);
    rl?.setPrompt(promptFor());
    redraw();
    return taken;
  };

  /** Park a captured paste: placeholder into the line you're editing. Nothing is printed into the
   *  conversation here — the hint row names it while it is staged, and it is shown INLINE, under the
   *  line that mentions it, once that line is held or sent (a preview printed now landed ABOVE its own
   *  placeholder line, which then printed below it: the order the operator could not read). */
  const stagePaste = (block: PasteBlock, prefix: string): void => {
    if (!rl || closing) return;
    stage().pastes.push(block);
    rl.write(null, { ctrl: true, name: "u" }); // drop the paste's trailing segment…
    rl.write(null, { ctrl: true, name: "k" }); // …from both sides of the cursor
    rl.setPrompt(promptFor());
    rl.write(`${prefix}${block.placeholder} `);
    drawHint();
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
  let picked = 0; // index into the last filtered list
  let drawn = 0; // lines currently occupied by the picker, so a redraw can erase exactly them
  /** The filter, held HERE rather than read back from `rl.line`. readline handles ↑/↓ as
   *  history-prev/next and REPLACES the buffer with a past line before our handler runs — reading the
   *  filter from it then saw something that no longer looked like `@name` and closed the picker, so
   *  the arrows cycled history and the marker never moved. Our own state cannot be clobbered. */
  let pickFilter = "";

  /** Every agent worth offering: live peers first (they answer now), then registered-but-offline. */
  const pickerAgents = (): Array<{ name: string; note: string }> => {
    const r = roster();
    const live = (r ?? []).filter((p) => p.card.id !== me && p.status !== "offline").map((p) => ({ name: p.card.name, note: statusBadge(p.status) }));
    const seen = new Set(live.map((a) => a.name.toLowerCase()));
    // Before the roster is read nobody is known to be offline: registered agents show a loader.
    const offline = listAgents(space)
      .map((a) => a.name)
      .filter((nm) => !seen.has(nm.toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((nm) => ({ name: nm, note: r ? c.dim("○ offline — a message wakes it") : c.dim(`${LOADER} loading live agents`) }));
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
    // A WINDOW around the selection, not the whole list: all 118 agents ran off the top of the screen
    // and took the selection with them (2026-09-23). Sized to leave the prompt, the hint and a little
    // of the conversation visible — the picker is a detour, not a new screen.
    const size = Math.max(3, Math.min(12, (process.stdout.rows || 24) - 6));
    const { start, end } = pickerWindow(hits.length, picked, size);
    const cols = process.stdout.columns || 80;
    const rows = [
      c.dim(hits.length ? `agents ${picked + 1}/${hits.length}` : `no agent matches "${pickFilter}"`),
      ...(start > 0 ? [c.dim(`    ↑ ${start} more`)] : []),
      ...hits.slice(start, end).map((a, j) => {
        const i = start + j;
        const marker = i === picked ? c.green("▸") : " ";
        const name = i === picked ? c.bold(c.cyan(a.name)) : c.cyan(a.name);
        const row = `  ${marker} ${name} ${a.note}${a.name === curName ? c.dim("  (current)") : ""}`;
        // Where it runs, when the row has room for it — read only for the rows on screen.
        const m = machineFor(a.name);
        const where = m ? `  · ${m.label}` : "";
        return where && displayWidth(row) + displayWidth(where) < cols ? row + machineColor(m)(where) : row;
      }),
      ...(end < hits.length ? [c.dim(`    ↓ ${hits.length - end} more`)] : []),
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
    picked = (((picked + delta) % hits.length) + hits.length) % hits.length; // a held ↑ can step past −length
    // Rewrite through readline's own editing ops so the prompt redraws correctly.
    rl.write(null, { ctrl: true, name: "u" });
    rl.write(null, { ctrl: true, name: "k" });
    rl.write(`@${hits[picked].name}`);
    drawPicker();
  };

  pickerHooks = { erase: erasePicker, draw: drawPicker };

  const openPicker = (): void => {
    if (!rl || closing || picking) return;
    if (!pickerAgents().length) {
      emit(c.dim(roster() ? "(no agents yet — `paw chat <folder>` births one)" : `(${LOADER} loading live agents — try ↓ again in a moment)`));
      return;
    }
    picking = true;
    picked = 0;
    drawn = 0;
    pickFilter = "";
    rl.write("@"); // the filter lives in the line buffer, so the completer and Enter both still work
    drawPicker();
  };

  // ── the not-found chooser (src/chat-chooser.ts) ─────────────────────────────────────────────────
  // Drawn above the prompt like the picker (erased by row count). While it is open it owns the keys it
  // knows (stdin's emit wrapper below hands them to it before readline sees them); any other key closes
  // it and reaches the input as usual.
  let chooser: Chooser | undefined;
  let chooserDrawn = 0;
  const eraseChooser = (): void => {
    if (!chooserDrawn || !rl || closing) return;
    readline.cursorTo(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -chooserDrawn);
    readline.clearScreenDown(process.stdout);
    chooserDrawn = 0;
  };
  const drawChooser = (): void => {
    if (!chooser || !rl || closing) return;
    eraseChooser();
    const rows = renderChooser(chooser, c, "a new agent is `paw chat --fresh <folder>`");
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    const text = rows.join("\n") + "\n";
    process.stdout.write(text);
    chooserDrawn = paintedRows(text, process.stdout.columns || 80); // a wrapped row is erased whole
    rl.prompt(true);
  };
  function openChooser(ch: Chooser): void {
    if (!rl || closing) return;
    if (picking) closePicker();
    eraseChooser();
    chooser = ch;
    drawChooser();
  }
  function closeChooser(): void {
    if (!chooser) return;
    eraseChooser();
    chooser = undefined;
    if (rl && !closing) rl.prompt(true);
  }
  chooserHooks = { open: () => chooser !== undefined, erase: eraseChooser, draw: drawChooser };
  /** One stdin chunk while the chooser is open: true = it was the chooser's (readline never sees it). */
  const chooserTakes = (raw: string): boolean => {
    if (!chooser || !rl || closing) return false;
    const r = chooserKey(chooser, raw);
    if (r.pass) {
      closeChooser();
      return false;
    }
    chooser.sel = r.sel;
    const pick = r.pick;
    if (pick) setImmediate(() => void onChoice(pick).catch((e: Error) => emit(c.red(`! ${e.message}`))));
    else drawChooser();
    return true;
  };

  // ── views: logs · chat · messages · beads (src/chat-views.ts, src/chat-peers.ts, src/chat-tasks.ts) ───────────────────────────
  /** Capture the target's new transcript blocks into the history (printing them if the view shows
   *  logs). Runs every second whenever there is a target, in EVERY view — the history needs the blocks
   *  in arrival order for a later switch into `logs` to reprint them truthfully. */
  const pumpLogs = (): void => {
    if (!rl || closing) return;
    // A re-point (the target changed) swaps which agent's logs are visible, so what's on screen in a
    // logs view is now the wrong agent's trace — redraw rather than append the new one below it.
    if (follower.pump(curName) && showsLogs(view)) redraw();
    if (showsPeers(view)) ensurePeers(); // the target moves down many paths — catch them all here
  };

  // Follow the target's transcript from the start, in every view (pumpLogs says why). unref: a poll must
  // never be the thing keeping a quit chat alive.
  const followTimer = setInterval(pumpLogs, 1000);
  followTimer.unref();
  // The connection state ages on its own (degraded clears, a disconnect's seconds count up, a streak
  // turns sustained), so it is ticked — and the hint redrawn only when its label actually changed.
  // Before the endpoint exists the same tick advances the boot loader's seconds.
  let lastPhase: ConnPhase | undefined;
  const socketDown = (p: ConnPhase): boolean => p === "connecting" || p === "reconnecting" || p === "disconnected";
  const connTimer = setInterval(() => {
    if (closing) return;
    if (conn) {
      emitConn(conn.tick(Date.now()));
      if (rosterSeen) printPeerLines(peerHold.tick(presenceQuiet(Date.now()), Date.now()));
      // The socket is back: a send waiting out its backoff goes now, not up to 15s later.
      const phase = conn.phase(Date.now());
      if (lastPhase && socketDown(lastPhase) && !socketDown(phase)) outbox.kick();
      lastPhase = phase;
    }
    refreshFooter();
  }, 1000);
  connTimer.unref();

  function setView(next: ChatView): void {
    if (next === view) return;
    const leaving = view;
    view = next;
    if (leaving === "beads") {
      syncMouse(); // off: selection comes back with every other view
      clearInterval(tasksTimer);
      tasksTimer = undefined;
      tasksPainted = "";
    }
    if (rl && !closing) follower.pump(curName); // capture anything pending first — and ONE redraw, not two
    if (next === "beads") enterTasks();
    redraw();
    if (showsPeers(next)) ensurePeers();
  }

  /** ←/→ on an empty line. At an end of the strip it does nothing — the hint already shows no arrow
   *  that way. With no target there is no transcript to follow, so `logs` says why instead. */
  function switchView(dir: -1 | 1): void {
    const next = stepView(view, dir);
    if (!curName && viewNeedsTarget(next)) {
      emit(c.dim("(the logs follow one agent — pick one with ↓ first)"));
      return;
    }
    setView(next);
  }

  // ── the beads view ──────────────────────────────────────────────────────────────────────────────
  /** Whose beads the view lists: the target, or — with none — the operator. */
  const tasksFor = (): string => curName ?? operatorName();
  const BEADS_EVERY_MS = 12_000;
  let tasksTimer: NodeJS.Timeout | undefined;
  let beadsInFlight = false;
  let beadsReadAt = 0;

  /** Read the beads for whoever the view is on. One read at a time; the result is dropped if the view
   *  moved to someone else meanwhile. A failure is SHOWN — never rendered as "no beads". */
  async function refreshBeads(): Promise<void> {
    if (view !== "beads" || beadsInFlight || closing) return;
    const who = tasksFor();
    beadsInFlight = true;
    beadsReadAt = Date.now();
    const info = curName ? readInfo(who) : undefined;
    try {
      const tasks = await listAssigned(who, Date.now() - CLOSED_RECENT_MS);
      tasksBeads = { for: who, tasks };
      tasksError = undefined;
    } catch (e) {
      tasksError = { for: who, message: (e as Error).message };
    } finally {
      if (info) tasksInfo = await info;
      beadsInFlight = false;
    }
    if (tasksFor() !== who) return void refreshBeads(); // the target moved mid-read
    paintTasks();
  }
  /** The target's `paw status` row (only that row's reads run). Never throws: a failure is the result. */
  async function readInfo(name: string): Promise<{ for: string; facts?: InfoFacts; error?: string; note?: string }> {
    try {
      const { rows } = await collectStatus(space, undefined, { only: () => new Set([name]) });
      const r = rows.find((x) => x.name === name);
      if (!r) return { for: name, note: "not in paw status — a mesh-only peer, no ctx/inbox to show" };
      if (r.elsewhere) return { for: name, note: elsewhereStatus(r.elsewhere) };
      const share = contextShare(r.context);
      return {
        for: name,
        facts: {
          live: r.live,
          mesh: r.mesh,
          ...(r.busy ? { busy: true } : {}),
          ctx: contextText(r.context),
          ...(share !== undefined ? { ctxShare: share } : {}),
          inbox: inboxText(r.inbox),
          ...(r.activeMs !== undefined ? { activeMs: r.activeMs } : {}),
          ...(r.failure ? { failure: r.failure } : {}),
          ...(r.tool ? { tool: toolLabel(r.tool) } : {}),
        },
      };
    } catch (e) {
      return { for: name, error: (e as Error).message };
    }
  }

  /** Mesh activity from the agent: re-read soon, but never more than once per few seconds. */
  function refreshBeadsSoon(): void {
    if (view !== "beads") return;
    const wait = Math.max(0, beadsReadAt + 3000 - Date.now());
    setTimeout(() => void refreshBeads(), wait).unref();
  }

  function enterTasks(): void {
    tasksPainted = "";
    selectMode = false; // every entry starts with the wheel working
    syncMouse();
    void refreshBeads();
    tasksTimer = setInterval(() => {
      void refreshBeads();
      paintTasks(); // the ages move even when nothing else does
    }, BEADS_EVERY_MS);
    tasksTimer.unref();
  }

  /**
   * Paint the beads view in place: cursor home, each row over the old one (clear to its end), clear
   * whatever is below, then the prompt. Skipped when the text is what's already on screen (`force`
   * after anything else wrote to the terminal — a submitted line, a resize, a view switch). The first
   * paint after a switch clears the scrollback too, like every other view switch.
   */
  /** The target's presence as the title row shows it; nothing when it isn't on the mesh. */
  function liveStatus(name: string): { status?: string } {
    const key = name.toLowerCase();
    const p = (roster() ?? []).find((r) => r.card.name.toLowerCase() === key && r.card.id !== me && r.status !== "offline");
    if (!p) return {};
    return { status: statusBadge(p.status) + (p.activity ? c.dim(" — " + activityLine(p.activity, 60)) : "") };
  }

  /** Tell the terminal whether to report the mouse: on exactly while the beads view is up and select
   *  mode is off. Off is also written on EVERY way out (shutdown, exit) — a terminal left reporting is
   *  the worst failure here. */
  function syncMouse(): void {
    const want = view === "beads" && !selectMode && !closing && process.stdin.isTTY === true;
    if (want === mouseOn) return;
    mouseOn = want;
    process.stdout.write(want ? MOUSE_ON : MOUSE_OFF);
  }

  /** ctrl+o in the beads view: hand the mouse to the terminal (select text) or take it back (wheel). */
  function toggleSelectMode(): void {
    selectMode = !selectMode;
    syncMouse();
    paintTasks(true);
    drawHint();
  }

  /** A click or wheel while the beads view has the mouse. The panel is painted from the top-left, so
   *  screen row N is painted row N-1. Clicks off a parent's icon do nothing. */
  function onMouse(e: MouseEvent): void {
    if (!mouseOn || view !== "beads" || !rl || closing || picking || !e.press) return;
    if (e.kind === "wheelUp" || e.kind === "wheelDown") {
      tasksScroll = Math.max(0, tasksScroll + (e.kind === "wheelUp" ? -3 : 3));
      return paintTasks(true);
    }
    if (e.kind !== "left") return;
    const id = hitAt(tasksHits, e.row - 1, e.col - 1);
    if (!id) return;
    if (!folded.delete(id)) folded.add(id);
    paintTasks(true);
  }

  function paintTasks(force = false): void {
    if (view !== "beads" || !rl || closing || !process.stdout.isTTY || picking) return;
    const who = tasksFor();
    if (tasksBeads?.for !== who && tasksError?.for !== who) void refreshBeads(); // the target moved
    const now = Date.now();
    if (tasksScrollFor !== who) {
      tasksScroll = 0; // a new agent's list starts at the top
      tasksScrollFor = who;
    }
    const { rows, hits } = renderTasksPanel(
      {
        ...(curName ? { agent: curName } : {}),
        operator: operatorName(),
        ...(tasksBeads?.for === who ? { beads: agentBeads(tasksBeads.tasks, who, now) } : {}),
        ...(tasksError?.for === who ? { beadsError: tasksError.message } : {}),
        ...(tasksNotice ? { notice: tasksNotice } : {}),
        ...(curName ? liveStatus(curName) : {}),
        ...(tasksInfo && tasksInfo.for === curName
          ? { info: tasksInfo.facts ? agentInfo(tasksInfo.facts, now, c) : tasksInfo.note ? c.dim(tasksInfo.note) : c.red(`! status: ${tasksInfo.error}`) }
          : {}),
        selectMode,
      },
      {
        width: (process.stdout.columns || 80) - 1,
        // Fullscreen: every row but the prompt row and the hint row below the panel (and one spare for a
        // wrapped input) is the panel's.
        height: Math.max(3, (process.stdout.rows || 24) - 3),
        now,
        scroll: tasksScroll,
        onScroll: (s) => (tasksScroll = s),
        folded,
        style: { ...c, tag: (n) => agentTag(n), md: (t, w) => renderMarkdown(t, { width: w }) },
      },
    );
    tasksHits = hits;
    const text = rows.map((r) => `${r}\x1b[K`).join("\n");
    if (!force && tasksPainted && text === tasksPainted) return;
    const first = !tasksPainted;
    tasksPainted = text;
    process.stdout.write((first ? CLEAR_ALL : "\x1b[H") + text + "\n\x1b[J");
    rl.prompt(true);
  }
  // Other-peer rows are laid out at paint time; a resize re-lays them out (one redraw per burst of
  // resize events — a window drag fires dozens).
  let peerResize: NodeJS.Timeout | undefined;
  process.stdout.on("resize", () => {
    if (view === "beads") paintTasks(true);
    if (!showsPeers(view)) return;
    clearTimeout(peerResize);
    peerResize = setTimeout(() => showsPeers(view) && redraw(), 150);
    peerResize.unref();
  });

  if (process.stdin.isTTY) {
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    // chat layers ~11 key listeners on stdin (each owns one key); node warns past 10 — and its warning
    // would print through the prompt.
    process.stdin.setMaxListeners(Math.max(process.stdin.getMaxListeners(), 32));
    // The first key of a line, timed BEFORE readline folds it in (src/chat-consent.ts reads it).
    process.stdin.prependListener("data", () => {
      if (rl && rl.line === "" && lineStartedAt === undefined) lineStartedAt = Date.now();
    });
    // View navigation (src/chat-views.ts navKey): ←/→ step the view, a MODIFIED ↓ opens the picker
    // (plain ↓ already does, below). Only on an EMPTY line — mid-edit these keys move the caret and
    // jump words, and taking them away while someone types would break editing to add navigation.
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!rl || closing || scanner.pasting || picking || bang || rl.line) return;
      const k = navKey(raw);
      if (k === "left" || k === "right") setImmediate(() => rl && !rl.line && switchView(k === "left" ? -1 : 1));
      else if (k === "down" && arrowRun(raw) === undefined) setImmediate(openPicker); // plain ↓ runs are the picker listener's
    });
    // Mouse reports (src/mouse.ts) are cut out of every chunk BEFORE any listener — readline included —
    // sees it: readline would type `0;10;5M` into the line. Wrapping emit is the one place that sits in
    // front of all of them. Always on (cheap: a chunk without `\e[<` passes untouched), so a report
    // that lands just after click mode ends is still eaten.
    const stdinEmit = process.stdin.emit.bind(process.stdin);
    process.stdin.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event !== "data") return stdinEmit(event, ...args);
      const chunk = args[0] as Buffer | string;
      if (chooser && chooserTakes(typeof chunk === "string" ? chunk : chunk.toString("utf8"))) return true;
      const text = typeof chunk === "string" ? chunk : chunk.includes("\x1b[<") || chunk.includes(PASTE_END) ? chunk.toString("utf8") : undefined;
      // Keys typed after a paste's END marker in the SAME chunk — what the kernel hands over at once for
      // everything typed while chat was still loading — are cut off and re-emitted a tick later: the
      // paste is staged on a setImmediate (readline is mid-chunk), and an Enter folded into the same
      // chunk would otherwise submit the paste's trailing segment as a message of its own.
      const endAt = text === undefined ? -1 : text.indexOf(PASTE_END);
      if (text !== undefined && endAt >= 0 && endAt + PASTE_END.length < text.length) {
        const head = text.slice(0, endAt + PASTE_END.length);
        const rest = text.slice(endAt + PASTE_END.length);
        const handled = process.stdin.emit("data", typeof chunk === "string" ? head : Buffer.from(head, "utf8"));
        setImmediate(() => process.stdin.emit("data", typeof chunk === "string" ? rest : Buffer.from(rest, "utf8")));
        return handled;
      }
      if (text === undefined || !text.includes("\x1b[<")) return stdinEmit(event, ...args);
      const { rest, events } = stripMouse(text);
      for (const e of events) onMouse(e);
      if (!rest) return true;
      return stdinEmit(event, typeof chunk === "string" ? rest : Buffer.from(rest, "utf8"));
    }) as typeof process.stdin.emit;
    // ctrl+o in the beads view toggles select mode (readline binds nothing to it, so it needs no eating).
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      if (view !== "beads" || !rl || closing || picking || scanner.pasting) return;
      if ((typeof chunk === "string" ? chunk : chunk.toString("utf8")) !== SELECT_MODE_KEY) return;
      setImmediate(() => view === "beads" && toggleSelectMode());
    });
    // The beads view's bead list scrolls by a third of the screen per PgUp/PgDn.
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      if (view !== "beads" || !rl || closing || picking) return;
      const k = scrollKey(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (!k) return;
      const step = Math.max(3, Math.floor((process.stdout.rows || 24) / 3));
      tasksScroll = Math.max(0, tasksScroll + (k === "up" ? -step : step));
      setImmediate(() => paintTasks(true));
    });
    // readline repaints the whole input on some edits (history, a mid-line change) and wipes what's
    // below it — the hint included. Redraw after every keystroke; appended, so it runs after readline.
    process.stdin.on("data", () => setImmediate(() => rl && !closing && !scanner.pasting && drawHint()));
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      // Command mode (mirrors the web composer, 2026-09-09): `!` as the FIRST character of a line with
      // an agent targeted flips the prompt to `$ runs in <folder> → then tells <agent>` and is consumed;
      // Backspace on the empty command line leaves it (the reverse of the key that entered it), Esc
      // leaves it keeping the text. Checked after readline folds the keystroke in (setImmediate) —
      // except Backspace, which must be read BEFORE readline eats it against an already-empty buffer.
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!rl || closing || scanner.pasting || picking) return;
      // A multi-line draft is editable across lines: Backspace on an empty line takes the previous held
      // line back into the input; Ctrl+U on an empty line throws the whole draft away (operator,
      // 2026-10-09: "i can remove the last line, but not multiline"). Read BEFORE readline, which would
      // otherwise spend the key on an already-empty buffer.
      if (!bang && held.length && rl.line === "" && (raw === "\x7f" || raw === "\b")) {
        const [line] = unholdLines(1);
        setImmediate(() => rl && !closing && rl.write(line));
        return;
      }
      if (!bang && held.length && rl.line === "" && raw === "\x15") {
        const n = held.length;
        unholdLines(n); // resets the prompt too
        emit(c.dim(`✕ cleared the draft (${n} line${n === 1 ? "" : "s"})`));
        return;
      }
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
      if (!bang && curName && raw === "!" && !consent.open && !replaying) {
        setImmediate(() => {
          // `!` as the FIRST character switches to command mode — on an empty line, and also when it is
          // typed at the start of a line already written ("typed the command first, then went to the
          // beginning and typed !", operator 2026-11-04). The rest of the line is kept as the command.
          if (!rl || bang || !rl.line.startsWith("!") || rl.cursor !== 1) return;
          const rest = rl.line.slice(1);
          bang = true;
          rl.write(null, { ctrl: true, name: "u" });
          rl.write(null, { ctrl: true, name: "k" });
          rl.setPrompt(promptFor());
          rl.prompt(true);
          if (rest) {
            rl.write(rest);
            rl.write(null, { ctrl: true, name: "a" }); // the cursor stays where you typed `!`
          }
        });
      }
    });
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!rl || closing || scanner.pasting) return;
      // ↓ on a genuinely EMPTY line opens the picker; mid-edit it stays history-next.
      if (!picking) {
        // A held ↓ arrives as a RUN: open on it too, and spend the rest of the run as movement.
        const run = arrowRun(raw);
        if (run !== undefined && run > 0 && !rl.line)
          setImmediate(() => {
            openPicker();
            if (run > 1) movePicker(run - 1);
          });
        return;
      }
      // While picking: arrows move the selection, Esc closes, anything else re-filters off the
      // buffer once readline has folded the keystroke in (hence setImmediate). A RUN of arrows in one
      // chunk (key repeat) is one net step — see arrowRun.
      const step = arrowRun(raw);
      if (step !== undefined) return void setImmediate(() => step && movePicker(step));
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
        pastedIntoLine = true; // a pasted `y` never answers a restart question
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
        if (!shouldCollapse(text)) {
          // Echo was muted while it arrived; show the (ordinary, uncollapsed) text now it's in the buffer.
          setImmediate(() => { if (rl && !closing) rl.prompt(true); });
          continue;
        }
        const block = makeBlock(stage().pastes.length + 1, text);
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
      const leaked = leaksTail(text);
      setImmediate(() => {
        if (!rl || closing) return;
        holdLine(leaked && rl.line.endsWith(LEAKED_TAIL) ? rl.line.slice(0, -LEAKED_TAIL.length) : rl.line);
      });
    });
    process.stdin.on("data", () => {
      setImmediate(() => {
        if (closing || !rl) return;
        if (scanner.pasting || swallow) return; // mid-paste: a path INSIDE a paste isn't a drag
        // In `!` command mode a path is an ARGUMENT to the shell, not an attachment. Swapping it for
        // `[Image #1]` handed zsh `ESCALATE=1 [Image #1]` → "bad pattern: [Image" (operator screenshot,
        // 2026-09-23) and staged a file nobody meant to send.
        if (bang) return;
        const cur = rl.line;
        if (!cur || !cur.includes("/")) return; // cheap gate: no separator ⇒ no path ⇒ no stat calls
        const into = stage().pending;
        const peeled = peelLine(cur, undefined, into.length + 1);
        if (!peeled.paths.length) return;
        const staged: Attachment[] = [];
        try {
          for (const src of peeled.paths) staged.push(stageAttachment(space, src, into.length + staged.length + 1));
        } catch (e) {
          emit(c.red("! " + (e as Error).message));
          return; // leave the raw path in the buffer — never silently swallow the drop
        }
        into.push(...staged);
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
        warnAwayFile();
      });
    });
  }

  /** `!<command>` — the same contract as the web composer (src/bash.ts): run it in the STICKY agent's
   *  folder, show the output here, then DM the agent the command AND its output so the answer becomes
   *  its context. Needs an agent target — a channel has no folder to run in. */
  async function runBangCommand(command: string): Promise<void> {
    if (!curName || !curId) return void emit(c.red("! `!cmd` runs in an agent's folder — `@name` first (a channel has no folder)"));
    const away = awayOf(curName);
    if (away) return void emit(c.red(`! ${elsewhereBang(curName, away)}`));
    const cwd = folderForName(space, curName);
    if (!cwd) return void emit(c.red(`! ${bangNoFolder(space, curName, (roster() ?? []).find((p) => p.card.id === curId)?.card)}`));
    if (!existsSync(cwd)) return void emit(c.red(`! "${curName}" is registered at ${cwd}, which no longer exists`));
    // A sandboxed agent's command runs in ITS VM (its tools, ~/.env, PATH live only there); its VM not
    // running is an error here — never a silent run on this machine (src/sandbox-exec.ts).
    let place: BangPlace;
    try {
      place = bangPlace(space, curName);
    } catch (e) {
      return void emit(c.red(`! ${(e as Error).message}`));
    }
    emit(c.dim(`$ ${command}  (${bangWhere(curName, cwd, place)})`), "you", true);
    // Output STREAMS while the command runs (a login prints its URL, then waits for the browser), batched
    // per ~100ms of complete lines: emit redraws the prompt after each call, and a 200-line build log
    // emitted line by line is 200 prompt redraws.
    let partial = "";
    let ready: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flushLines = (): void => {
      timer = undefined;
      if (ready.length) emit(ready.map((l) => `  ${l}`).join("\n"), "you", true);
      ready = [];
    };
    const onOutput = (chunk: string): void => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      ready.push(...lines);
      if (ready.length && !timer) timer = setTimeout(flushLines, 100);
    };
    const result = await runBang(command, cwd, place, { interactive: true, onOutput }); // paw chat is a real terminal → the host path sources the operator's shell rc
    if (timer) clearTimeout(timer);
    if (partial) ready.push(partial);
    const streamed = result.output.trim() !== "";
    const status = result.timedOut ? "timed out" : result.code === 0 || result.code === null ? undefined : `exit ${result.code}`;
    const tail = [...ready.map((l) => `  ${l}`), ...(streamed ? [] : ["  (no output)"]), ...(status ? [c.yellow(`  (${status})`)] : [])];
    if (tail.length) emit(tail.join("\n"), "you");
    refreshTarget();
    sendDm(curName, curId!, bashMessage(result));
  }

  async function onLine(rawLine: string): Promise<void> {
    // What readline just printed for this line — its prompt plus what you typed. Captured before
    // anything below can change the prompt; recorded (once we know it's a real submission) so the
    // line survives a view redraw.
    const echoed = rl!.getPrompt() + rawLine;
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
      heldEntries = [];
      raw = joinLines(all, raw);
      rl!.setPrompt(promptFor());
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
    // (Recorded as an `echo` entry, so a redraw reproduces your line; the painter asserts both facts.)
    if (typed) {
      const echo: Entry = { kind: "echo", text: echoed };
      history.push(echo);
      lastPainted = echo;
      // A paste this line mentions shows right under it — where it sits in the message the agent gets.
      if (!bang) emitRows(railPastes(rawLine, stage().pastes, viewOpts()));
    }
    painter.lastSide = "you";
    // And a blank line the previous round ended on is no longer adjacent once a prompt and your typed
    // line sit between it and the next output — leaving the flag set swallowed later gaps entirely.
    painter.trailingBlank = false;
    const startedAt = lineStartedAt;
    lineStartedAt = undefined;
    const pasted = pastedIntoLine;
    pastedIntoLine = false;
    // The wake gate's restart question takes only a line typed AS its answer (src/chat-consent.ts) —
    // y/yes, or n/no/an empty Enter; any other line is a message and the question stays open.
    if (!bang && consent.offer({ text: typed, startedAt, pasted, replay: false })) return;
    if (!typed) {
      if (!closing) rl!.prompt();
      return;
    }
    // Not connected yet: a line that needs the mesh waits, in order, with what was staged for it. While
    // the queue replays, EVERY line but a quit joins it behind the lines typed before it.
    const quits = /^\/?(quit|exit)$/i.test(typed);
    // During the replay `bang`/`stagedFor` are the REPLAYED line's; the operator's own are in liveStage.
    const lineBang = liveStage ? liveStage.bang : bang;
    if ((!ready && lineNeedsMesh(lineBang ? `!${typed}` : typed)) || (replaying && !quits)) {
      const st = stage();
      const boundTo = liveStage ? liveStage.stagedFor : stagedFor;
      deferred.push({ text: typed, pending: st.pending.splice(0), pastes: st.pastes.splice(0), ...(boundTo !== undefined ? { stagedFor: boundTo } : {}), bang: lineBang, at: Date.now() });
      if (liveStage) {
        liveStage.stagedFor = undefined;
        liveStage.bang = false;
      } else {
        stagedFor = undefined;
        bang = false;
      }
      emit(c.dim(replaying ? `${LOADER} queued — sends after the lines before it` : `${LOADER} queued — sends when connected`), "you");
      rl!.setPrompt(promptFor());
      if (!closing) rl!.prompt();
      return;
    }
    await handleLine(typed, {});
  }

  /**
   * One submitted line, after paste/continuation handling — typed now, or replayed from the queue of
   * lines typed before the mesh was up (`replay`). Same handler either way, so `@name`, attachments and
   * every refusal mean exactly what they meant when the line was typed.
   */
  async function handleLine(typed: string, opts: { replay?: boolean }): Promise<{ refusedTo: string; body: string } | undefined> {
    /** The line was refused whole (its target can't be reached): nothing of it was sent. `body` is the
     *  line with its dragged paths already swapped for placeholders (they are staged). */
    let refused: { refusedTo: string; body: string } | undefined;
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
        for (const b of pastes) emitRows(railMessage(b.placeholder, [b], viewOpts()));
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
      if (peeled.paths.length) warnAwayFile();
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

      if (text === "/retry") {
        const again = outbox.retry();
        const inFlight = outbox.pending().length - again.length;
        if (!again.length) emit(c.dim(inFlight ? `(nothing failed — ${inFlight} still sending, retried on its own)` : "(nothing to retry — every message went out)"));
        for (const it of again) {
          const old = Date.now() - it.createdAt > DEDUP_WINDOW_MS;
          emit(
            c.dim(`↻ sending again → ${it.label}: ${preview(it.msg.msg)}`) +
              (old ? c.yellow(`   (first tried ${secsOf(Date.now() - it.createdAt)} ago, past the broker's 2m dedup window — if that copy did land, it arrives twice)`) : ""),
            "you",
          );
        }
        refreshFooter();
      } else if (text === "/conn") {
        const since = `${((Date.now() - bootStartedAt) / 1000).toFixed(1)}s`;
        emit(c.dim(`startup: ${bootPhase}${ready ? "" : ` (${since})`}${targetLost ? ` · target lost: ${targetLost.reason}` : ""}${deferred.count ? ` · ${deferred.count} queued` : ""}`));
        if (conn && ep) {
          for (const l of conn.report(Date.now())) emit(c.dim(l));
          emit(c.dim(`reconnects forced by a send's probe (ack timed out, then no PONG in ${PROBE_MS / 1000}s): ${linkProbe.forced}`));
          const view = ep.presenceView();
          const stuck = ep.presenceWriteFailure();
          emit(
            c.dim(
              `presence view: ${view.state}${stuck ? ` · our presence writes failing ×${stuck.consecutiveFailures}${stuck.error ? ` (${stuck.error})` : ""}` : ""}` +
                (presenceQuiet(Date.now()) ? ` · joins/departures held (${peerHold.heldCount()} so far); net changes print when live` : ""),
            ),
          );
        } else emit(c.dim("no endpoint yet"));
      } else if (text === "/reconnect") {
        if (bootPhase !== "failed" || booting) emit(c.dim(booting ? "(already connecting)" : "(connected — nothing to reconnect)"));
        else {
          bootAbort = new AbortController();
          bootSettled = boot().catch((e: Error) => emit(c.red(`! ${e.message}`)));
        }
      } else if (text === "/more" || text.startsWith("/more ")) {
        // Older messages with the target, above the earlier block (src/chat-backlog.ts).
        if (!curName) emit(c.dim("/more loads older messages with the agent you're talking to — pick one with ↓ or @name"));
        else {
          let n: number | undefined;
          try {
            n = moreCount(text.slice("/more".length));
          } catch (e) {
            emit(c.red((e as Error).message));
          }
          if (n !== undefined) {
            if (view !== "chat") emit(c.dim(`(loading ${n} older messages with ${curName} — they show in the chat view)`));
            loadBacklog(curName, n);
          }
        }
      } else if (text === "/help") {
        emit(c.dim("@name [msg] switches target · #channel msg broadcasts · !cmd runs in the agent's folder · /more [N] older messages · /who · /ps · /conn · /retry · /reconnect · /imgs · /noimg · /paste · /nopaste · /quit"));
      } else if (text === "/who") {
        const fresh = await rosterReady();
        emit(c.dim(fresh ? "Roster:" : "Roster (presence still loading — this may be partial):"));
        // One row per NAME: a restart mints a new id and the stale record only goes `offline`, never
        // away, so a long-lived chat shows one dead row per past incarnation. See dedupeRoster.
        for (const p of dedupeRoster(needEp().getRoster())) {
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
          const typed = rest.slice(0, sp);
          const body = rest.slice(sp + 1);
          const to = inThisSpace(typed); // undefined: another space, already said in red
          const peer = to === undefined ? undefined : findPeer(to);
          if (to !== undefined && !peer) emit(c.red(`no peer named "${to}" present`));
          else if (peer) {
            sendDm(peer.card.name, peer.card.id, flush(body, undefined, peer.card.name)); // confirm sent + await the reply (typed line alone isn't proof)
          }
        }
      } else if (text.startsWith("@")) {
        // @name [message] — switch the sticky target to <name> (and send the rest as a DM if given).
        const sp = text.indexOf(" ");
        const typed = (sp === -1 ? text.slice(1) : text.slice(1, sp)).trim();
        const body = sp === -1 ? "" : text.slice(sp + 1).trim();
        const to = typed ? inThisSpace(typed) : "";
        if (to === undefined) warnStranded(typed, body);
        else if (!to) emit(c.red("usage: @<name> [message]"));
        else {
          // A roster that was never read is not one with nobody in it: wait for it (≤5s), and never
          // wake (respawn) an agent on the word of a roster that hasn't loaded.
          const fresh = await rosterReady();
          let peer = fresh ? findPeer(to) : needEp().getRoster().find((p) => p.card.name.toLowerCase() === to.toLowerCase() && p.card.id !== me && p.status !== "offline");
          let stuckId: string | undefined; // a stuck seat's inbox address: queue there instead of stranding
          if (!fresh && !peer) emit(c.dim(`(presence still loading — not waking ${to} from a roster that hasn't loaded)`));
          // Not live? If we know the agent's folder, resurrect it (resumed) — `@name` wakes an agent
          // you exited earlier, with full history, instead of just saying "offline".
          if (fresh && (!peer || peer.status === "offline")) {
            const home = folderForName(space, to);
            if (home && existsSync(home)) {
              emit(c.dim(`↻ ${to} is offline — respawning from ${home}…`));
              try {
                const r = await withManagerControl(space, server, (ctl) => ensureAgentSpawned(ctl, { space, name: to, cwd: home, model, ...(restart ? { restartLive: "allow" as const } : {}) }));
                if (r.stuck) {
                  emit(c.yellow(stuckWarning(to, r.stuck, !!body && !!r.id)));
                  stuckId = r.id;
                }
                // A COLD start — a fresh claude resuming a days-old session — takes well over the 8s
                // this used to allow, so it reported "couldn't be respawned" against an agent that was
                // simply still booting, while `paw dm` (which waits 20s) woke the SAME agent fine. One
                // number now, shared with dm: two answers to "how long may a spawn take" is how one
                // agent looks dead down one path and alive down the other.
                await waitForPeerId(needEp(), to, r.spawned ? FRESH_SPAWN_MS : LIVE_AGENT_MS);
                peer = findPeer(to);
              } catch (e) {
                emit(c.red("! " + (e as Error).message));
              }
            }
          }
          if (stuckId) {
            const switched = to.toLowerCase() !== curName?.toLowerCase();
            if (to !== curName) bang = false;
            curId = stuckId;
            targetLost = undefined;
            curName = to;
            if (filter?.kind === "agent") filter = { kind: "agent", name: to };
            rl!.setPrompt(promptFor());
            if (switched) loadBacklog(curName);
            if (body) sendDm(curName, curId, flush(body, curName), false);
          } else if (!peer) {
            emit(c.red(`no peer named "${to}" present (/who to list)`));
            warnStranded(to, body);
          } else if (peer.status === "offline") {
            emit(c.red(`"${peer.card.name}" hasn't come up yet — a cold start can outlast the wait; try \`@${to}\` again in a moment`));
            warnStranded(to, body);
          } else {
            const switched = peer.card.name.toLowerCase() !== curName?.toLowerCase();
            if (peer.card.name !== curName) bang = false; // a command typed for one agent's folder never runs in another's
            curId = peer.card.id;
            targetLost = undefined;
            curName = peer.card.name;
            // In a filtered session the view must keep matching who you're addressing — otherwise
            // `@other` sends somewhere you cannot see, which is the misdirection this mode prevents.
            if (filter?.kind === "agent") filter = { kind: "agent", name: peer.card.name };
            rl!.setPrompt(promptFor());
            if (!body) emit(c.dim(`(now messaging ${curName})`));
            // A new target's earlier conversation, above what you are about to say to it.
            if (switched) loadBacklog(curName);
            if (body) sendDm(curName, curId, flush(body, curName));
          }
        }
      } else if (parseBang(text) !== undefined) {
        await runBangCommand(parseBang(text)!);
      } else if (text.startsWith("#")) {
        // #channel <message> — broadcast to a channel so every subscribed agent sees it.
        const sp = text.indexOf(" ");
        if (sp < 2) emit(c.red("usage: #<channel> <message>"));
        else {
          const typed = inThisSpace(text.slice(0, sp).trim());
          const channel = typed?.slice(1);
          const body = text.slice(sp + 1).trim();
          if (channel !== undefined) sendPost(channel, flush(body, `#${channel}`));
          else warnStranded(text.slice(0, sp).trim(), body);
        }
      } else if (curName) {
        // The sticky target. A target that could not be reached REFUSES the line (kept, ↑ recalls it):
        // falling through to the room below would post a message typed for one agent to everyone.
        refreshTarget();
        const lost = targetLost?.name === curName ? targetLost : undefined;
        if (!curId || lost) {
          refused = { refusedTo: curName, body: text };
          const why = `✕ not sent to ${curName}: ${lost?.reason ?? "it isn't reachable on the mesh"}`;
          // A replayed line's keeping is said by replayDeferred, which knows where it put it.
          if (opts.replay) emit(c.red(why));
          else {
            emit(c.red(`${why} — text kept (↑ to recall)`));
            if (rl && !closing) setImmediate(() => rl && !closing && rl.write(text));
          }
        } else sendDm(curName, curId, flush(text, curName));
      } else {
        sendPost(room, flush(text, `#${room}`)); // no sticky target — post to the room this session opened
      }
    } catch (e) {
      emit(c.red("! " + (e as Error).message));
    }
    if (!closing) rl!.prompt();
    return refused;
  }

  /**
   * Run the queued lines, oldest first, each with the attachments staged for it when it was typed —
   * until the queue is EMPTY, including lines typed while it ran (`replaying` queues them), so the
   * typed order is the sent order. A line refused here (its target can't be reached) is never dropped:
   * it goes back into an empty input with its attachments still staged — exactly as a refused live
   * line does — or, when the input is in use or it spans lines, it is kept and printed in full on quit.
   */
  async function replayDeferred(): Promise<void> {
    if (replaying) return;
    replaying = true;
    const live: NonNullable<typeof liveStage> = { pending: pending.splice(0), pastes: pastes.splice(0), ...(stagedFor !== undefined ? { stagedFor } : {}), bang };
    liveStage = live;
    stagedFor = undefined;
    try {
      for (let it = deferred.shift(); it && !closing; it = deferred.shift()) {
        pending.push(...it.pending);
        pastes.push(...it.pastes);
        stagedFor = it.stagedFor;
        bang = it.bang;
        const outcome = await handleLine(it.text, { replay: true });
        bang = false;
        if (outcome) {
          const { refusedTo: to, body } = outcome;
          const single = !body.includes("\n");
          if (single && rl && !closing && rl.line === "" && !held.length && !live.pending.length && !live.pastes.length) {
            // Back into the input; its attachments stay staged with it (the prompt counts them).
            live.pending.push(...pending.splice(0));
            live.pastes.push(...pastes.splice(0));
            setImmediate(() => rl && !closing && rl.write(body));
            emit(c.dim("  that line is back in the input — edit it, or @name to send it elsewhere"));
          } else {
            const full = composeMessage(composePastes(body, pastes.splice(0)), pending.splice(0));
            keptUnsent.push({ to, text: full });
            emit(c.dim("  that line is kept, not sent — it is printed in full when you quit"));
          }
          stagedFor = undefined;
        }
        // What a line left staged (an attachment held back for another agent) stays, ahead of what was
        // staged since, still bound to whom it was for.
        live.pending.unshift(...pending.splice(0));
        live.pastes.unshift(...pastes.splice(0));
        if (stagedFor !== undefined) live.stagedFor ??= stagedFor;
        stagedFor = undefined;
      }
    } finally {
      pending.push(...live.pending);
      pastes.push(...live.pastes);
      stagedFor = live.stagedFor;
      liveStage = undefined;
      bang = live.bang;
      replaying = false;
    }
    rl?.setPrompt(promptFor());
    if (rl && !closing) rl.prompt(true);
  }

  // ── the background connect ─────────────────────────────────────────────────────────────────────
  /** `/reconnect`, quit and the boot loader all read this: the running boot (settled once it is done). */
  let bootSettled: Promise<void> = Promise.resolve();
  let booting = false;
  let bootAbort = new AbortController();
  /** Retires this run's remote inbox (registered before provisioning; src/human-inbox.ts). */
  let inboxRelease: (() => Promise<void>) | undefined;
  let inboxUid: string | undefined;
  let everReady = false;
  const setPhase = (p: BootPhase): void => {
    bootPhase = p;
    if (rl && !closing) rl.setPrompt(promptFor());
    refreshFooter();
  };
  /**
   * Forget an endpoint that is gone (stopped after a failed startup, or never started): its roster,
   * "you"'s id and the presence seed all described IT. Left set, a `/reconnect` trusted the dead
   * endpoint's roster as already read — live agents showed `offline` and `@name` said "no peer".
   */
  const dropEndpoint = (): void => {
    peerDownAt ??= Date.now(); // the messages view's tap goes with it — read the gap back once one is up
    ep = undefined;
    conn = undefined;
    me = undefined;
    rosterSeen = false;
    peerHold = new PresenceHold<Card, PresenceStatus>();
  };
  /** The endpoint, with every listener attached BEFORE it connects (no DM lands unheard). */
  const startEndpoint = async (i: HumanInbox): Promise<{ ep: CotalEndpoint; conn: ReturnType<typeof attachConn> }> => {
    const humanAuth = i.auth;
    const card = humanAuth.creds
      ? { name: humanPeer(space), kind: "endpoint" as const }
      : { name: humanPeer(space), kind: "endpoint" as const, id: stableHumanId(space) };
    const e = new CotalEndpoint({
      space,
      servers: server,
      ...humanAuth,
      card,
      registerPresence: true,
      consume: true,
      watchPresence: true,
      // A channel session must actually SUBSCRIBE to that channel — the default is #general only, so
      // `paw chat '#team2027'` would otherwise sit filtered on traffic it never receives. Posting needs
      // no subscription (multicast is a publish), which is why only the read side needs this.
      ...(addressed.mode === "channel" ? { channels: [room] } : {}),
      ...linkProbe.endpointOptions(),
    });
    // cotal's endpoint reports trouble one event at a time (src/conn-state.ts); the conn state listens
    // before the endpoint starts (an unheard "error" event crashes the process).
    const cs = attachConn(e, Date.now, (lines) => emitConn(lines), (raw) => emit(c.dim(raw)));
    dropEndpoint(); // a new endpoint's roster is unread until IT reads it
    me = e.card.id;
    ep = e;
    conn = cs;
    e.on("message", onMessage);
    e.on("presence", onPresence);
    e.on("presence-view", () => onRosterSeen());
    // A fresh socket: a send in flight on the old one (or waiting out its backoff) goes now. The 1s conn
    // tick misses a forced reconnect — its down and up land in the same millisecond.
    e.on("transport", (st: { connected: boolean }) => st.connected && outboxRef?.kick());
    let started = false; // a read-back needs a started endpoint; the first "up" before that is startup itself
    e.on("transport", (st: { connected: boolean }) => (!st.connected || started) && onPeerTransport(st.connected));
    tapOwnSubject(e, space, onOwnSend);
    tapPeerTraffic(e, space, onPeerTraffic);
    try {
      await startResilient(e);
      started = true;
      onPeerTransport(true); // up: read back what the tap missed while there was none
    } catch (err) {
      dropEndpoint();
      await e.stop().catch(() => {});
      throw describeInboxBindFailure(space, humanAuth.lifecycleUid, err as Error);
    }
    timing("endpoint");
    return { ep: e, conn: cs };
  };

  /** Stop the endpoint and retire the inbox — what a quit (or a pipe-mode failure) owes the broker. */
  async function teardown(): Promise<void> {
    await stopOwnTap?.().catch(() => {});
    retirePeerTap();
    await ep?.stop().catch(() => {});
    dropEndpoint();
    await inboxRelease?.().catch((e: Error) => consoleOrig.error(c.red(e.message)));
    inboxRelease = undefined;
  }

  /** Why the roster could not be read, for the unreachable chooser. */
  let lookupWhy = "";
  /**
   * Settle a `pending` lookup against the live roster: wait (≤5s) for its first read, then the name is
   * on it (found — the normal path from here, an offline one included), or not (absent), or the roster
   * never loaded (unreachable — never read as "not found").
   */
  async function settleLookup(nm: string, signal?: AbortSignal): Promise<void> {
    const e = ep;
    if (!rosterSeen && e) {
      await e.waitForPresenceSnapshot(5000);
      onRosterSeen();
    }
    if (signal?.aborted) return;
    if (!rosterSeen) {
      lookup = "unreachable";
      lookupWhy = `${space}'s roster didn't load in 5s`;
      targetLost = { name: nm, reason: `couldn't reach ${space} to check @${nm}` };
      fields.status = failedSlot(`couldn't reach ${space} to check`);
      return;
    }
    const peer = findPeer(nm);
    if (peer) {
      lookup = "found";
      targetLost = undefined;
      curId = peer.status !== "offline" ? peer.card.id : await waitForPeerId(ep!, nm, 5000, signal);
      fields.status = curId ? okSlot(c.green("live on the mesh")) : failedSlot("offline");
      return;
    }
    lookup = "absent";
    targetLost = { name: nm, reason: `no agent @${nm} in ${space}` };
    fields.status = failedSlot(`no agent @${nm} in ${space}`);
  }

  /** The chooser for a lookup that did not find its agent (no-op otherwise). */
  function presentLookup(): void {
    const nm = curName;
    if (!nm || !rl || closing) return;
    if (lookup === "unreachable") return openChooser(unreachableChooser({ name: nm, space, why: lookupWhy }));
    if (lookup !== "absent") return;
    const live = (roster() ?? []).filter((p) => p.card.id !== me).map((p) => p.card.name);
    const suggestions = suggestNames(nm, [...live, ...listAgents(space).map((a) => a.name)]).filter((n) => n.toLowerCase() !== nm.toLowerCase());
    let elsewhere: ReturnType<typeof otherSpaceHits> = [];
    try {
      elsewhere = otherSpaceHits(pawHome(), nm, space);
    } catch (e) {
      emit(c.red(`! couldn't check the other spaces: ${(e as Error).message}`));
    }
    openChooser(notFoundChooser({ name: nm, space, suggestions, elsewhere }));
  }

  /** Act on a pick. Queued lines are never sent by it: they are already in the input or kept. */
  async function onChoice(ch: Choice): Promise<void> {
    closeChooser();
    if (ch.kind === "quit") return void (await shutdown());
    if (ch.kind === "space") {
      execAfterQuit = [process.execPath, ...process.execArgv, process.argv[1]!, "chat", `@${ch.name}`, "--space", ch.space];
      writeOut(c.dim(`\n→ opening @${ch.name} in ${ch.space}…\n`));
      return void (await shutdown());
    }
    if (ch.kind === "all") {
      curName = undefined;
      curId = undefined;
      targetLost = undefined;
      lookup = undefined;
      bang = false;
      if (filter?.kind === "agent") filter = undefined;
      emit(c.dim(`(showing all conversations — plain lines go to #${room} · @name starts a DM)`));
      rl?.setPrompt(promptFor());
      updateBanner();
      return;
    }
    if (ch.kind === "switch") {
      await handleLine(`@${ch.name}`, {});
      if (curName === ch.name) lookup = undefined;
      else presentLookup(); // it could not be reached either — choose again
      updateBanner();
      return;
    }
    // retry
    const nm = curName;
    if (!nm) return;
    lookup = "pending";
    targetLost = undefined;
    fields.status = okSlot(c.dim(lookingFor(nm, space)));
    rl?.setPrompt(promptFor());
    updateBanner();
    if (bootPhase === "failed") {
      if (booting) return;
      bootAbort = new AbortController();
      bootSettled = boot().catch((e: Error) => emit(c.red(`! ${e.message}`)));
      return;
    }
    await settleLookup(nm);
    rl?.setPrompt(promptFor());
    updateBanner();
    presentLookup();
  }

  /**
   * Connect behind the UI: ensure() beside the inbox + endpoint, resolve a mutating target, the wake
   * gate, the target's mesh id — then `ready`, and the queued lines replay. Failures are shown, never
   * fatal in a terminal (`/reconnect`); in a pipe they throw, exactly as before.
   */
  async function boot(): Promise<void> {
    booting = true;
    const signal = bootAbort.signal;
    if (signal.aborted) return void (booting = false); // quit before it started: nothing to undo
    bootStartedAt = Date.now();
    setPhase("mesh");
    if (!interactive && typedLabel !== undefined) process.stdout.write(c.dim(`  connecting to ${typedLabel}…\n`));
    const startup = new ManagerControl(space, server, undefined, CHAT_STARTUP_COMMANDS);
    try {
      const r = await concurrentStartup<HumanInbox, { ep: CotalEndpoint; conn: ReturnType<typeof attachConn> }>({
        ensure: (meshUp) =>
          ensureManagerOn(startup, ensureSpaceFor(space), {
            onMeshUp: () => {
              timing("meshUp");
              meshUp();
            },
          }),
        prepareInbox: async () => {
          const p = await prepareHumanInbox(space, server, addressed.mode === "channel" ? [room] : []);
          inboxUid = p.uid;
          return p;
        },
        startEndpoint,
        stopEndpoint: async (x) => {
          if (ep === x.ep) dropEndpoint();
          await x.ep.stop();
        },
        report: (m) => emit(c.red(m)),
        signal,
        onPhase: (p) => {
          if (p === "endpoint") timing("inbox");
          setPhase(p);
        },
      });
      inboxRelease = r.release;
      if (signal.aborted) return;
      if (mutating) {
        try {
          resolveTarget();
        } catch (e) {
          if (!interactive) throw e;
          emit(c.red((e as Error).message));
          void shutdown();
          return;
        }
        curName = name;
        if (typedLabel !== undefined && name !== undefined && name !== typedLabel) emit(c.dim(`→ ${typedLabel} is ${name}`));
        rl?.setPrompt(promptFor());
        updateBanner();
        if (!remoteSpace) loadInfo();
      }
      // The earlier block reads the DM stream only — it needs the endpoint, not the agent — so it loads
      // while a cold agent is still waking. A name still being looked up waits for the roster (below).
      if (name !== undefined && lookup !== "pending" && !backlogAsked.has(name.toLowerCase())) loadBacklog(name);
      if (name !== undefined) {
        setPhase("agent");
        try {
          if (folder) {
            const restartLive = interactive ? (restart ? ("allow" as const) : consent.consent) : cliRestartConsent(restart);
            const r = await ensureAgentSpawned(startup, { space, name, cwd: folder, model, brief, kind, ...(restartLive ? { restartLive } : {}), say: (l) => emit(c.dim(l)) });
            spawned = r.spawned;
            busy = r.busy;
            // A fresh spawn is the genuinely slow path (a cold claude, resuming a long session). Naming it
            // turns "it hung" into "it is doing the slow thing", which is the difference between waiting
            // and Ctrl-C.
            fields.status = okSlot(
              r.stuck
                ? c.yellow(stuckWarning(name, r.stuck, true))
                : r.starting
                  ? c.yellow("still starting — messages will be delivered by its durable inbox")
                  : r.spawned
                    ? c.green("spawned a new agent · starting up") + c.dim(` — a cold start can take up to ${Math.round(FRESH_SPAWN_MS / 1000)}s`)
                    : c.green("reusing live agent"),
            );
            updateBanner();
            setPhase("roster");
            curId = r.id ?? (await waitForPeerId(ep!, name, r.spawned ? FRESH_SPAWN_MS : LIVE_AGENT_MS, signal));
          } else if (lookup === "pending") {
            setPhase("roster");
            await settleLookup(name, signal);
          } else {
            setPhase("roster");
            curId = await waitForPeerId(ep!, name, 5000, signal);
            if (curId) fields.status = okSlot(c.green("reusing live agent"));
          }
        } catch (e) {
          targetLost = { name, reason: (e as Error).message };
        }
        if (signal.aborted) return;
        if (!curId && !targetLost)
          targetLost = { name, reason: folder ? unreachableHint(name, space, busy) : `paw: no live agent named "${name}" — start one with \`paw chat <folder>\`` };
        if (targetLost && lookup !== "absent" && lookup !== "unreachable") {
          if (!interactive) throw new Error(targetLost.reason);
          fields.status = failedSlot(curId ? "not reachable" : "not on the mesh — see below");
          flushBanner(); // repaint before the reason prints under it, so the banner can still change in place
          emit(c.red(`✕ ${targetLost.reason}`));
          emit(c.dim("  lines to it are kept, not sent · @name talks to another agent · /quit"));
        }
        timing("agent");
      }
      ready = true;
      everReady = true;
      setPhase("ready");
      timing("ready");
      rl?.setPrompt(promptFor());
      updateBanner();
      // The rest of the echo (a second connection on a remote space) is off the critical path.
      startEcho(ep!, space, server, onOwnSend, (e) => conn && emitConn(conn.feed({ kind: "warning", error: e }, Date.now()))).then(
        (stop) => (closing ? void stop() : (stopOwnTap = stop)),
        (e: Error) => conn && emitConn(conn.feed({ kind: "warning", error: e }, Date.now())),
      );
      if (remoteSpace) loadInfo();
      if (curName && lookup !== "absent" && lookup !== "unreachable" && !backlogAsked.has(curName.toLowerCase())) loadBacklog(curName);
      // A chat that died mid-startup left its inbox in the ledger; retire it now (src/human-inbox.ts).
      sweepOrphanInboxes(space).then(
        ({ retired }) => retired.length && emit(c.dim(`retired ${retired.length} chat inbox${retired.length === 1 ? "" : "es"} a closed chat left on ${space}`)),
        (e: Error) => emit(c.red(e.message)),
      );
      await replayDeferred();
      // Lines typed while looking were refused above (kept, or back in the input) — never sent to a
      // choice. Now the choice.
      presentLookup();
      markSettled();
    } catch (e) {
      if (signal.aborted) return;
      if (!interactive) {
        await teardown();
        throw e;
      }
      // Whatever this attempt acquired after the concurrent startup (endpoint, inbox) goes now, so a
      // `/reconnect` starts clean instead of leaking the first inbox behind a second.
      await teardown();
      bootPhase = "failed";
      fields.status = failedSlot("not connected");
      emit(c.red(`✕ ${(e as Error).message}`));
      emit(c.dim("  /reconnect tries again · what you type is kept until then"));
      if (lookup === "pending") {
        lookup = "unreachable";
        lookupWhy = "not connected (why is above)";
      }
      rl?.setPrompt(promptFor());
      updateBanner();
      refreshFooter();
      presentLookup();
    } finally {
      booting = false;
      await startup.close().catch((e: Error) => emit(c.red(`paw: chat startup control did not close cleanly: ${e.message}`)));
    }
  }

  // ── one way out ────────────────────────────────────────────────────────────────────────────────
  /** Everything not sent, in full: queued lines, the outbox's pending/failed, and the draft. */
  function printUnsent(draft: string): void {
    const queued = deferred.unsentLines();
    const out = [...outbox.pending(), ...outbox.failed()];
    const n = keptUnsent.length + queued.length + out.length;
    if (n) {
      writeOut(c.red(`\n✕ quitting with ${n} message${n === 1 ? "" : "s"} not sent:\n`));
      for (const k of keptUnsent) writeOut(c.dim(`   → ${k.to} (refused): `) + `${k.text}\n`);
      for (const t of queued) writeOut(c.dim(`   → ${curName ?? pendingName() ?? `#${room}`} (queued): `) + `${t}\n`);
      for (const it of out) writeOut(c.dim(`   → ${it.label}: `) + `${textOf(it.msg.msg)}${it.lastError ? c.dim(` (${shortReason(it.lastError)})`) : ""}\n`);
    }
    if (draft.trim()) writeOut(c.yellow("\n✎ your unsent draft:\n") + `${draft}\n`);
  }
  let leavingAt = 0;
  /** A command to hand the terminal to once this chat has left (the chooser's other-space pick). */
  let execAfterQuit: string[] | undefined;
  async function shutdown(code?: number): Promise<void> {
    if (closing) {
      // A second Ctrl-C while startup settles: leave NOW. The ledger makes the promise below true.
      if (leavingAt && Date.now() - leavingAt > 50) {
        if (inboxUid && existsSync(join(inboxLedgerDir(space), `${inboxUid}.json`))) writeOut(c.yellow(`left chat inbox ${inboxUid} on ${space} — the next paw chat retires it\n`));
        process.exit(130);
      }
      return;
    }
    closing = true;
    leavingAt = Date.now();
    consent.cancel();
    bootAbort.abort();
    if (followTimer) clearInterval(followTimer);
    clearInterval(connTimer);
    const draft = [...held, ...(rl ? [rl.line] : [])].filter((l) => l !== "").join("\n");
    // Leave the terminal as we found it — bracketed paste is a MODE, and a shell that inherits it
    // set without knowing would see raw \e[200~ markers in its own input.
    if (process.stdin.isTTY) process.stdout.write(DISABLE_BRACKETED_PASTE + MOUSE_OFF);
    mouseOn = false;
    restoreConsole();
    // The hint row under the prompt goes with us; anything said from here starts on a fresh line.
    if (rl && process.stdout.isTTY) {
      readline.clearScreenDown(process.stdout);
      writeOut("\n");
    }
    rl?.close();
    // Never a silent drop: say what is leaving with us unsent.
    printUnsent(draft);
    if (booting) {
      writeOut(c.dim(`${LOADER} letting startup finish so nothing is left on the broker — Ctrl-C again to leave now\n`));
      await Promise.race([bootSettled, new Promise((r) => setTimeout(r, 10_000).unref())]);
    }
    await teardown();
    if (execAfterQuit) {
      // "open @name in <other space>": this REPL is one space's endpoint, so the other space is a new chat.
      const [cmd, ...args] = execAfterQuit;
      const r = spawnSync(cmd!, args, { stdio: "inherit" });
      if (r.error) throw r.error;
      process.exit(r.status ?? 1);
    }
    process.exit(code ?? (everReady ? 0 : 1));
  }

  // ── the first frame ──────────────────────────────────────────────────────────────────────────
  // While the REPL is up, a stray console line (cotal, a library) goes above the prompt, not through it.
  const installConsole = (): void => {
    for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...a: unknown[]) => (rl && !closing ? emit(c.dim(format(...a))) : consoleOrig[k](...a));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // Last line of defence — a crash, or any exit that skipped shutdown(): never leave mouse mode or
  // bracketed paste on, and give the console back.
  process.on("exit", () => {
    restoreConsole();
    if (!process.stdin.isTTY) return;
    try {
      writeSync(1, (mouseOn ? MOUSE_OFF : "") + DISABLE_BRACKETED_PASTE);
    } catch {} // the terminal is already gone — nothing left to restore
  });
  process.stdout.on("resize", () => {
    resizedSinceBanner = true; // rows re-wrap: the banner can no longer be found by counting up
    drawHint();
  });

  if (interactive) {
    paintBanner();
    createRepl();
    installConsole();
    rl!.prompt();
    timing("prompt");
    // Started a beat later: keys typed during the load are already waiting, and readline should echo
    // them before boot()'s synchronous start (signer, creds) holds the loop.
    booting = true;
    bootSettled = new Promise((r) => setTimeout(r, 15))
      .then(() => boot())
      .catch((e: Error) => emit(c.red(`! ${e.message}`)));
    if (!remoteSpace && !mutating) setTimeout(loadInfo, 30);
  } else {
    // A pipe or a script: today's order — connect, resolve, THEN read lines.
    await boot();
    if (!remoteSpace) loadInfo();
    paintBanner();
    createRepl();
    rl!.prompt();
  }
  await new Promise<void>(() => {}); // park until shutdown() exits the process
}

/** Opt-in startup timing (`PAW_CHAT_TIMING=<file>`): JSONL `{mark, ms}` stamps from process start —
 *  what `pnpm measure:chat` reads. Off unless set; a write failure is loud. */
const TIMING_FILE = process.env.PAW_CHAT_TIMING;
function timing(mark: string): void {
  if (TIMING_FILE) appendFileSync(TIMING_FILE, JSON.stringify({ mark, ms: Math.round(performance.now()) }) + "\n");
}

/** The console as it was before chat routed it above its prompt. */
const consoleOrig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
function restoreConsole(): void {
  Object.assign(console, consoleOrig);
}
const writeOut = (s: string): void => void process.stdout.write(s);

const chatCommand: Command = {
  kind: "command",
  name: "chat",
  group: "Mesh",
  summary: "chat with an EXISTING agent (by @name or folder; wakes it if offline); replies stream back live — --fresh creates a new one",
  usage: 'chat [<folder>|<name>|@<name>|#<channel>][#<space>] [--only] [--all] [--restart] [--history N] [--name <n>] [--fresh [--personality <seed|"vibe"|none>]] [--agent kit|codex|opencode|hermes|claude [--provider codex|grok|<hermes provider>] [--model m]]   (default: "." — this folder\'s agent; --all = every conversation, nothing preselected; --restart = may restart the agent if it looks stuck (else a tty asks); --history N = show the last N messages with the agent from before this chat (default: up to 20 from the last 24h; 0 = off; /more [N] loads older); --name pins a 2nd+ EXTRA agent at the folder; --fresh births a NEW default agent, fails loud if one already exists; --agent creates the agent on that harness, or targets it if it already runs there)',
  run: (a) => chat([...a.raw]),
};

registry.register(chatCommand);
