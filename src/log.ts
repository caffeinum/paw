/**
 * `paw log [folder|name|repo@branch] [--tail N] [--follow]` — read an agent's session DIRECTLY from its
 * transcript, without attaching (`paw open`) or messaging it (`paw chat`). Dispatches on the persona's
 * `agent:`: claude jsonl, opencode sqlite, codex jsonl. Never falls back to a sibling's session.
 * LOCAL + read-only (no mesh). `--follow` tails it live.
 *
 * Renders in the SAME shape Claude Code prints to its own terminal: `●` bullets for assistant text
 * (markdown "glow") and tool calls (`● Write(index.html)`), `⎿` continuation lines for tool results
 * (paired from the following tool_result record), and `> ` for user/wake turns. Tool names match the UI
 * (`Task`→`Agent`, `mcp__x__y`→`x:y`); the agent's outgoing mesh DMs surface as `↩` replies.
 *
 * `--tail N` counts rendered BLOCKS (turns/actions), not raw lines. Claude/codex only read the TAIL
 * of the file (transcripts reach hundreds of MB).
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { assertUnambiguousTarget, canonicalDir, folderForName, lookupFolderName, personaFilePath, sanitizeAgentName } from "./addressing.js";
import { claudeProjectDir, latestSession } from "./adopt.js";
import { CodexParser, findCodexSessionFile, resolveCodexRoots } from "./codex-log.js";
import { latestOpencodeSession, opencodeBlocks, resolveOpencodeDb } from "./opencode-log.js";
import { isClaudeHarness, readAgentType, readResumeId } from "./session.js";
import { resolveSpace } from "./lifecycle.js";
import { inlineMd, renderMarkdown } from "./markdown.js";
import { oneLine, tailRead, TranscriptParser, type Block } from "./transcript.js";
import { parseWorktreeRef, resolveWorktreeFolder } from "./worktree.js";

const TAIL_BYTES = 512 * 1024; // how much of the end of the transcript to read for the initial render

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  italic: wrap("3"),
  cyan: wrap("36"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
};

const BULLET = "●";
const PIPE = "⎿"; // result continuation glyph (matches Claude Code's tool-result rail)

/** Lay a block out under a `●` bullet: first line carries the bullet, the rest align beneath it. */
function bullet(first: string, rest: string[] = []): string {
  return [`${BULLET} ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
}

/** A `⎿` result rail under a tool call: first line carries the glyph, wrapped lines align beneath it. */
function rail(lines: string[], color: (s: string) => string = c.dim): string {
  if (lines.length === 0) return "";
  return lines.map((l, i) => `  ${i === 0 ? PIPE + "  " : "   "}${color(l)}`).join("\n");
}

/**
 * One {@link Block} → the exact line(s) `paw log` has always printed.
 *
 * The walk that produces the blocks moved to src/transcript.ts so a browser (or anything else that
 * wants an agent's turns without escape codes) can have the same structure. This function is the only
 * thing that knows about ANSI, and its output is byte-identical to the pre-split renderer — the
 * blocks carry SOURCE (raw markdown, summary lines), never presentation.
 */
function renderBlock(b: Block): string {
  switch (b.kind) {
    case "user":
      return `${c.bold(">")} ${oneLine(b.text, 400)}`;
    case "wake":
      return c.dim(`📨 ${b.via} from ${b.from}`);
    case "failure":
      // Amber, like Claude Code: this is the runtime failing, not the agent talking — and it is not
      // fatal to the session either, so it must not read as loudly as a tool error.
      return `${c.yellow(BULLET)} ${c.yellow(oneLine(b.text, 400))}`;
    case "notification":
      // The summary VERBATIM — it is already the sentence Claude Code prints ("Monitor event: …",
      // "Background command … completed"). Adding a label of my own produced
      // `Monitor event: "Monitor event: "…""` on real data, and would have been simply wrong for the
      // summaries that aren't monitor events at all. The event body follows on the ⎿ rail, where every
      // other "what came back" detail in this renderer already lives.
      return bullet(b.summary, b.event ? rail(b.event.split("\n"), c.dim).split("\n") : []);
    case "assistant": {
      const md = renderMarkdown(b.markdown);
      return bullet(md[0], md.slice(1));
    }
    case "tool":
      return `${BULLET} ${c.bold(b.display)}${b.arg ? `(${b.arg})` : ""}`;
    case "result":
      return rail(b.lines, b.isError ? c.red : c.dim);
    case "incoming": {
      // Rendered in FULL and through the markdown pass — this is what someone SAID to the agent, and a
      // 120-char summary of it would be the least useful line in the log. A quote rail rather than the
      // 📨 the wake marker already uses: two identical glyphs back to back read as one repeated event,
      // and these are two different things (mail arrived / here is the mail).
      return renderMarkdown(b.text).map((l) => `${c.dim("│")} ${l}`).join("\n");
    }
    case "reply":
      return `${BULLET} ${c.green(`↩ ${b.to}`)} ${b.text}`;
    case "channelReply":
      return `${BULLET} ${c.green(`↩ #${b.channel}`)} ${b.text}`;
    case "spawn":
      return c.dim(`  ${PIPE}  ⊕ spawn ${b.name}`);
  }
}

/** The agent name for a folder: its registered name, else its basename — but if that basename is the
 *  name of a DIFFERENT folder's registered agent, FAIL LOUD instead of silently borrowing it. Without
 *  this, `paw log .` in an unregistered local checkout that shares a basename with a github clone (e.g.
 *  `~/Github/team2027/noninteractive` vs the agent's `~/.paw/repos/team2027/noninteractive`) resolved to
 *  the clone agent's name, read its pin, then looked for that transcript under the LOCAL folder's project
 *  dir — surfacing a misleading "no transcript yet" for a folder that has no such agent. */
export function agentNameForFolder(space: string, folder: string): string {
  const registered = lookupFolderName(space, folder);
  if (registered) return registered;
  const base = sanitizeAgentName(folder);
  const owner = folderForName(space, base); // a different folder already holding this name?
  if (owner && owner !== folder) {
    throw new Error(
      `paw: "${folder}" isn't a paw agent — the name "${base}" belongs to a different folder (${owner}). ` +
        `Use \`paw log ${base}\` to read that agent, or spawn one here with \`paw chat --fresh "${folder}"\`.`,
    );
  }
  return base;
}

/** Resolve a target to its agent name + folder. Folder, worktree, or a live agent name.
 *  The try/catch ONLY guards canonicalDir (path vs name disambiguation) — agentNameForFolder is
 *  called outside it so its collision error propagates instead of being mis-handled as name mode. */
export function resolveLogTarget(space: string, target: string | undefined): { name: string; folder: string } {
  if (target && parseWorktreeRef(target)) {
    const folder = resolveWorktreeFolder(target);
    return { name: agentNameForFolder(space, folder), folder };
  }
  let folder: string;
  try {
    folder = canonicalDir(target ?? ".");
  } catch {
    if (target === undefined) throw new Error(`paw: "." is not a directory`);
    const named = folderForName(space, target); // name mode — reverse-resolve the folder from the registry
    if (!named) throw new Error(`paw: no folder known for agent "${target}" (\`paw ps\` for live names)`);
    return { name: target, folder: named };
  }
  return { name: agentNameForFolder(space, folder), folder };
}

export type AgentLog = {
  name: string;
  label: string;
  blocks(tail: number): Block[];
  pull(): Block[];
};

/** Open the harness-native session for this agent. Claude path stays the jsonl pin/latest walk. */
export function openAgentLog(space: string, name: string, folder: string, bytes = TAIL_BYTES): AgentLog {
  const persona = personaFilePath(space, name);
  const agentType = existsSync(persona) ? readAgentType(persona) : undefined;
  if (isClaudeHarness(agentType)) return openClaudeLog(space, name, folder, bytes);
  if (agentType === "opencode") return openOpencodeLog(space, name, folder);
  if (agentType === "codex") return openCodexLog(space, name, folder, bytes);
  throw new Error(`paw: "${name}" is a ${agentType} agent — paw log does not read ${agentType} sessions yet.`);
}

/** One-shot blocks for the web trace (and tests). Same dispatch as `paw log`. */
export function blocksForAgent(space: string, name: string, folder: string, opts?: { tail?: number; bytes?: number }): { name: string; label: string; blocks: Block[] } {
  const log = openAgentLog(space, name, folder, opts?.bytes ?? TAIL_BYTES);
  return { name: log.name, label: log.label, blocks: log.blocks(opts?.tail ?? 20) };
}

function openClaudeLog(space: string, name: string, folder: string, bytes: number): AgentLog {
  const persona = personaFilePath(space, name);
  const pinned = existsSync(persona) ? readResumeId(persona) : undefined;
  const agentType = existsSync(persona) ? readAgentType(persona) : undefined;
  const dir = claudeProjectDir(folder);
  const file = join(dir, `${chooseTranscriptId(name, dir, pinned, agentType)}.jsonl`);
  const parser = new TranscriptParser();
  let offset = 0;
  let partial = "";
  return {
    name,
    label: file,
    blocks(tail) {
      const out: Block[] = [];
      for (const l of tailRead(file, bytes).split("\n")) {
        if (l) out.push(...parser.feed(l));
      }
      offset = statSync(file).size;
      partial = "";
      return out.slice(-tail);
    },
    pull() {
      const size = statSync(file).size;
      if (size < offset) {
        offset = 0;
        partial = "";
      }
      if (size <= offset) return [];
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        partial += buf.toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        const out: Block[] = [];
        for (const l of lines) {
          if (l) out.push(...parser.feed(l));
        }
        return out;
      } finally {
        closeSync(fd);
      }
    },
  };
}

function openOpencodeLog(space: string, name: string, folder: string): AgentLog {
  const dbPath = resolveOpencodeDb(space, name);
  if (!dbPath || !existsSync(dbPath)) {
    throw new Error(`paw: "${name}" is an opencode agent — no opencode session for this folder (${folder})`);
  }
  const session = latestOpencodeSession(dbPath, folder);
  if (!session) {
    throw new Error(`paw: "${name}" is an opencode agent — no opencode session for this folder (${folder})`);
  }
  let emitted = 0;
  const all = (): Block[] => opencodeBlocks(dbPath, session.id);
  return {
    name,
    label: `${dbPath}#${session.id}`,
    blocks(tail) {
      const b = all();
      emitted = b.length;
      return b.slice(-tail);
    },
    pull() {
      const b = all();
      if (b.length < emitted) emitted = 0;
      const next = b.slice(emitted);
      emitted = b.length;
      return next;
    },
  };
}

function openCodexLog(space: string, name: string, folder: string, bytes: number): AgentLog {
  const file = findCodexSessionFile(folder, resolveCodexRoots(space));
  if (!file) {
    throw new Error(`paw: "${name}" is a codex agent — no codex session for this folder (${folder})`);
  }
  const parser = new CodexParser();
  let offset = 0;
  let partial = "";
  return {
    name,
    label: file,
    blocks(tail) {
      const out: Block[] = [];
      for (const l of tailRead(file, bytes).split("\n")) {
        if (l) out.push(...parser.feed(l));
      }
      offset = statSync(file).size;
      partial = "";
      return out.slice(-tail);
    },
    pull() {
      const size = statSync(file).size;
      if (size < offset) {
        offset = 0;
        partial = "";
      }
      if (size <= offset) return [];
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        partial += buf.toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        const out: Block[] = [];
        for (const l of lines) {
          if (l) out.push(...parser.feed(l));
        }
        return out;
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Pick which transcript id to show for an agent. A PINNED agent's transcript is authoritative: if it
 *  doesn't exist yet (the agent booted but wrote no turns), fail LOUD rather than fall back to the
 *  folder's newest session — that fallback can surface an UNRELATED, live session (e.g. the human's
 *  own interactive session in their home folder, the `paw log aleks` → `993b92e7` bug). Only an
 *  UNPINNED *claude* agent falls back to its latest session (it legitimately has history under an auto
 *  id). A non-claude harness (opencode/codex/…) has no claude jsonl of its own — falling back would
 *  print a SIBLING's session in the same folder (`paw log personal-grok` → `personal`'s perkmal-55). */
export function chooseTranscriptId(
  name: string,
  dir: string,
  pinned: string | undefined,
  agentType?: string,
): string {
  if (pinned) {
    if (existsSync(join(dir, `${pinned}.jsonl`))) return pinned;
    throw new Error(`paw: "${name}" is pinned to session ${pinned} but it has no transcript yet (the agent hasn't written a turn) — nothing to show.`);
  }
  if (!isClaudeHarness(agentType)) {
    throw new Error(
      `paw: "${name}" is a ${agentType} agent — paw log only reads claude transcripts, not ${agentType} sessions. ` +
        `Attach with \`paw open ${name}\` (or the ${agentType} TUI).`,
    );
  }
  const id = latestSession(dir);
  if (!id) throw new Error(`paw: no claude transcript for "${name}" yet (looked in ${dir})`);
  return id;
}

function parseArgs(argv: string[]): { space?: string; target?: string; tail: number; follow: boolean } {
  const out: { space?: string; target?: string; tail: number; follow: boolean } = { tail: 20, follow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--tail" || a === "-n") out.tail = Math.max(1, Number(argv[++i]) || 20);
    else if (a === "--follow" || a === "-f") out.follow = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — log takes [<folder>|<name>] [--tail N] [--follow]`);
    else if (out.target === undefined) out.target = a;
    else throw new Error(`paw: unexpected argument "${a}" — log takes a single target`);
  }
  return out;
}

/** Print a block with Claude-Code spacing: a blank line precedes each `●`/`>` turn for breathing room,
 *  but a `⎿` result rail stays attached to the tool call above it. */
function emit(b: string): void {
  if (!b.trimStart().startsWith(PIPE)) console.log("");
  console.log(b);
}

async function log(argv: string[]): Promise<void> {
  const { space: spaceArg, target, tail, follow } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud
  const { name, folder } = resolveLogTarget(space, target);
  const session = openAgentLog(space, name, folder);
  console.log(c.dim(`# ${session.name} · ${session.label}`));

  for (const b of session.blocks(tail)) emit(renderBlock(b));
  if (!follow) return;

  console.log(c.green(`\n— following ${name} (Ctrl-C to stop) —`));
  const tick = (): void => {
    for (const b of session.pull()) emit(renderBlock(b));
  };
  const timer = setInterval(tick, 1000);
  await new Promise<void>(() => {}); // park; Ctrl-C exits
  clearInterval(timer); // unreachable, but keeps the timer referenced
}

const logCommand: Command = {
  kind: "command",
  name: "log",
  group: "Mesh",
  summary: "read an agent's session transcript directly (no attach, no message) — log [<folder>|<name>] [--tail N] [--follow]",
  usage: 'log [<folder>|<name>|<repo>@<branch>] [--tail N] [--follow]   (default: ".", tail 20)',
  run: (a) => log([...a.raw]),
};

registry.register(logCommand);
