import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HUMAN_PEER } from "./names.ts";
import { ADDRESSING_BRIEF, BACKGROUND_BASH_BRIEF, CHANNELS_BRIEF, FILES_BRIEF, OPERATOR_REQUESTS_BRIEF, TASKS_BRIEF, UNATTENDED_BRIEF, WAKE_BRIEF } from "./brief.ts";
import { beadsDir } from "./beads-dir.ts";
import { voiceLineFor } from "./personality.ts";
import { readClaudeArgs, readCwd, readHeadless, readResumeId, transcriptExists } from "./session.ts";
import { ensureShim, headlessDir, hubEnabled, hubSocketPath } from "./hub/paths.ts";
import { headlessLaunch } from "./headless.ts";
import { routeCotalToHub } from "./hub/route.ts";
import { readTracepaperUrl, routeTracepaperDirect } from "./tracepaper-direct.ts";

/** Claude Code's permission modes — PAW_PERMISSION must be one of these (fail loud otherwise). */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;

/**
 * Default permission mode for paw agents. They run unattended on your repos, so they must not
 * block on tool-approval prompts — hence `bypassPermissions`. Override per process with
 * PAW_PERMISSION (one of PERMISSION_MODES) to put a human back in the loop. An unknown value
 * throws rather than passing a bad mode through to claude with a misleading "launching" notice.
 */
function permissionMode(): string {
  const override = process.env.PAW_PERMISSION?.trim();
  if (!override) return "bypassPermissions";
  if (!(PERMISSION_MODES as readonly string[]).includes(override)) {
    throw new Error(`paw: PAW_PERMISSION="${override}" is not a valid permission mode (expected one of: ${PERMISSION_MODES.join(", ")})`);
  }
  return override;
}

/** Agents already warned about running unattended this process, so the notice prints once each. */
const warnedBypass = new Set<string>();

/** Make the unattended-permission posture loud (design §6): one stderr line per agent. */
function warnUnattended(name: string, mode: string): void {
  if (warnedBypass.has(name)) return;
  warnedBypass.add(name);
  console.warn(`paw: "${name}" launching with --permission-mode ${mode} (acts unattended; set PAW_PERMISSION to change)`);
}

/**
 * The mesh brief appended to every paw agent's system prompt: who it is and how to reach its
 * peers (the human included) over the cotal tools. The sections live in src/brief.ts, where
 * src/kit.ts composes its own brief from the ones that hold for any harness.
 */
export function meshBrief(name: string, voice?: string): string {
  return [
    `You are "${name}", a paw agent rooted at this folder and a peer on the cotal mesh.`,
    ...(voice ? [voice] : []),
    `Reach teammates with the cotal_* MCP tools: cotal_dm(to, text) for a direct message,`,
    `cotal_anycast(role, text) to reach any agent of a role, cotal_roster to see who is online,`,
    `and cotal_inbox to drain messages waiting for you.`,
    `CRITICAL: NO human is watching this session — text you write here reaches NO ONE. The ONLY way`,
    `to answer a message is to call cotal_dm(sender, your_answer). When you cotal_inbox a DM, you MUST`,
    `then cotal_dm your reply back to that exact sender (a human operator is the peer "${HUMAN_PEER}",`,
    `e.g. cotal_dm("${HUMAN_PEER}", …); a teammate is their agent name). Ending your turn without`,
    `cotal_dm means your reply is silently lost — reading the inbox is NOT replying.`,
    ...ADDRESSING_BRIEF,
    ...CHANNELS_BRIEF,
    ...UNATTENDED_BRIEF,
    ...FILES_BRIEF,
    ...WAKE_BRIEF,
    ...TASKS_BRIEF,
    ...OPERATOR_REQUESTS_BRIEF,
    ...BACKGROUND_BASH_BRIEF,
  ].join(" ");
}


/**
 * Append text to an existing `--append-system-prompt` value if the base launch already set one
 * (cotal adds it for an agent-file persona), otherwise add a fresh flag — so the flag is never
 * emitted twice. Mutates args in place.
 */
function appendSystemPrompt(args: string[], text: string): void {
  // cotal ≥0.48 hands claude the persona as a FILE (`--append-system-prompt-file <tmp>`), and claude
  // refuses the two flags together ("Cannot use both …") — every seat exited 1 at launch, silently,
  // under the pty runtime. paw's brief is appended INTO a sibling file rather than the inline flag:
  // a paw-owned copy beside cotal's (never mutating cotal's file — it is cotal's to reap), so the
  // persona and the brief reach claude as one prompt through the one flag cotal chose.
  const f = args.indexOf("--append-system-prompt-file");
  if (f !== -1 && f + 1 < args.length) {
    const personaFile = args[f + 1];
    const merged = join(dirname(personaFile), "paw-brief.md");
    writeFileSync(merged, `${readFileSync(personaFile, "utf8")}\n\n${text}`);
    args[f + 1] = merged;
    return;
  }
  const i = args.indexOf("--append-system-prompt");
  if (i !== -1 && i + 1 < args.length) {
    args[i + 1] = `${args[i + 1]}\n\n${text}`;
    return;
  }
  args.push("--append-system-prompt", text);
}

/**
 * paw's connector: cotal's claude connector plus paw's opinions — unattended permissions, a mesh
 * brief, optional session resume, and folder pre-trust. Pure composition over
 * claudeConnector.buildLaunch; never edits cotal source. Self-registers under "paw" on import;
 * bin/paw.ts also aliases it to the manager's default agent type.
 */
export const pawConnector: Connector = {
  // Inherit EVERY capability the claude connector declares (eventChannel, requires, supportsPrompt,
  // launchHint, …), then override only the name and the launch. cotal ≥0.5x refuses to start a seat
  // whose connector lacks `eventChannel` ("does not publish an AG-UI event plane") — a hand-copied
  // subset of fields silently dropped it, and every spawn failed. New upstream capabilities now
  // travel without paw having to learn their names.
  ...claudeConnector,
  kind: "connector",
  name: "paw",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const spec = claudeConnector.buildLaunch(opts);
    const args = [...spec.args];

    // Hub mode (`paw hub on`, read per spawn): the cotal MCP server is the hub's C shim, not a node process per agent
    // (src/hub/). ensure() starts the hub; the shim is built here on first use if the tree lacks one.
    if (hubEnabled(opts.space)) routeCotalToHub(args, ensureShim(), hubSocketPath(opts.space));

    // tracepaper direct (src/tracepaper-direct.ts): one shared HTTP server instead of a ~17MB stdio
    // bridge per agent. The canvas follows the agent's folder, read from its persona.
    const tpUrl = readTracepaperUrl(opts.space);
    if (tpUrl) {
      const cwd = readCwd(opts.configPath);
      if (!cwd) throw new Error(`paw: tracepaper direct needs "${opts.name}"'s folder (persona cwd:) to pick its canvas — none in ${opts.configPath}`);
      routeTracepaperDirect(args, tpUrl, cwd);
    }

    // KEEP cotal's `--dangerously-load-development-channels server:cotal` intact. It is NOT a no-op:
    // it is the channel-REGISTRATION gate that lets claude 2.1.x honour cotal's
    // notifications/claude/channel wake nudges, so an idle agent wakes on a peer DM instead of only
    // draining at its next turn. (It's hidden from --help and tolerated when passed, which earlier
    // fooled us into stripping it as "dead" — verified live that stripping makes idle agents go
    // deaf.) cotal also sets COTAL_CHANNEL=1 to force the server to emit. paw must not touch it.

    // NOTE: cwd confinement + folder pre-trust used to live here (the connector once received the cwd
    // on LaunchOpts). As of cotal's per-agent cwd landing upstream (#43), the MANAGER owns the working
    // directory and passes it straight to the runtime — the connector never sees it. So that safety
    // step moved to paw's spawn site (src/cwd.ts `confineAndTrustCwd`, called by ensureAgentSpawned).

    const mode = permissionMode();
    if (mode !== "default") {
      warnUnattended(opts.name, mode);
      args.push("--permission-mode", mode);
    }

    // A warm agent has no human at its pty — the operator is on the MESH. Tools that block the
    // terminal waiting for a keystroke (the AskUserQuestion picker, plan-mode ExitPlanMode) hang the
    // agent forever: it's stuck mid-turn, so it can never drain a DM. Deny them — with no way to ask
    // on the screen, the agent asks in plain text over cotal_dm instead (a normal mesh round-trip).
    args.push("--disallowedTools", "AskUserQuestion,ExitPlanMode");

    // The personality's VOICE line (src/personality.ts) rides right after the identity line; a malformed
    // vibe/emoji/hue throws here, at spawn, rather than reaching the model half-read.
    appendSystemPrompt(args, meshBrief(opts.name, voiceLineFor(opts.configPath)));

    // Durable session pin: paw writes a stable `resume:` id into every persona (minted at birth, or
    // a real past id via `adopt`). If its transcript exists → resume it; if not, this is the first
    // boot → create the session AT that id so every later restart resumes instead of cold-starting a
    // fresh, amnesiac session. (The paw-reset bug of 2026-06-26: pinless agents lost all history on
    // any mesh bounce / reboot because claude auto-generated a new session id each launch.)
    const resumeId = readResumeId(opts.configPath);
    if (resumeId) args.push(transcriptExists(resumeId) ? "--resume" : "--session-id", resumeId);

    // The operator's own claude flags, recorded when the agent was created (`paw claude --model opus`).
    // LAST on purpose: a flag the operator named should beat paw's default for the same flag, and
    // claude resolves a repeated flag to the last occurrence. Session flags are never stored here —
    // the durable pin above owns those, and two sources for one session is how you get two writers.
    args.push(...readClaudeArgs(opts.configPath));

    // The fleet's shared task list (beads). BEADS_DIR pins every agent to the machine-wide global db
    // (~/.beads) regardless of cwd — bd resolves a repo-local .beads FIRST otherwise, so an agent in
    // team2027 would silently file fleet tasks into that repo's own project db. The brief tells them
    // what it's for; this makes bare `bd` hit the right store.
    // BEADS_ACTOR makes the audit trail honest: without it bd falls back to git user.name and every
    // agent-filed task reads "created by Aleksey Bykhun" — the one fact the operator's hover card
    // exists to answer ("which agent filed this?") fabricated away by a default.
    const env = { ...spec.env, BEADS_DIR: beadsDir(), BEADS_ACTOR: opts.name };

    // `headless: true` in the persona: the same launch, run as `claude -p` stream-json with no TUI
    // (docs/notes/headless.md). -p drops the channel push, so the HUB is what wakes it — no hub, no
    // way to deliver a DM, so refuse rather than boot a deaf agent.
    if (readHeadless(opts.configPath)) {
      if (!hubEnabled(opts.space))
        throw new Error(`paw: "${opts.name}" is headless, which needs the cotal hub to deliver its messages — \`paw hub on --space ${opts.space}\` first`);
      return headlessLaunch({ ...spec, args, env }, headlessDir(opts.space, opts.name));
    }

    return { ...spec, args, env };
  },
};

registry.register(pawConnector);
