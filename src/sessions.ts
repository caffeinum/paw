/**
 * `paw sessions [<folder>|<repo>@<branch>]` — see claude transcripts so you can `paw adopt --resume`.
 * LOCAL (reads ~/.claude/projects + paw personas) — no mesh. Three shapes:
 *   - `<repo>@<branch>` → that one worktree's sessions.
 *   - a folder inside a git repo → the WHOLE repo: every worktree + the transcripts inside each.
 *   - a plain (non-git) folder → just that folder's sessions.
 * Each block shows the agent's MODE — "fresh" (cold-start) vs "adopted ← <id>" — and marks the pinned
 * transcript.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { assertUnambiguousTarget, canonicalDir, lookupFolderName, personaFilePath, sanitizeAgentName } from "./addressing.js";
import { claudeProjectDir } from "./adopt.js";
import { readResumeId } from "./session.js";
import { resolveSpace } from "./lifecycle.js";
import { liveSessionProcs, namesForFolder } from "./named.js";

/** A warning when a pinned (adopted) session is ALSO open in a standalone `claude` outside paw — two
 *  writers on one transcript can corrupt it. paw can't stop a `claude -r` you launch after adopting,
 *  but it surfaces it here. Empty when there's no pin or no foreign process. */
function foreignWarn(pinned: string | undefined): string {
  if (!pinned) return "";
  const foreign = liveSessionProcs(pinned).filter((p) => !p.mesh);
  return foreign.length ? `  ⚠ also open outside paw (pid ${foreign.map((p) => p.pid).join(", ")})` : "";
}
import { gitToplevel, listWorktrees, parseWorktreeRef, resolveWorktreeFolder } from "./worktree.js";

const PER_WORKTREE_CAP = 6; // transcripts shown per worktree in the repo view

interface Transcript {
  id: string;
  mtime: number;
  file: string;
}

/** First user-typed text in a transcript (skips tool-result-only user records), for a one-line preview. */
function firstUserText(file: string): string | undefined {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg: { role?: string; content?: unknown } = rec.message ?? rec;
    if (rec.type !== "user" && msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const part = content.find((p) => p && p.type === "text" && typeof p.text === "string" && p.text.trim());
      if (part) return (part.text as string).trim();
    }
  }
  return undefined;
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function oneLine(s: string, max = 64): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Claude transcripts for a folder, newest first. Empty if the folder has no project dir. */
function transcriptsOf(folder: string): Transcript[] {
  const dir = claudeProjectDir(folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.slice(0, -".jsonl".length), mtime: statSync(join(dir, f)).mtimeMs, file: join(dir, f) }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Read-only agent name + adopt pin for a folder (never registers it). */
function agentModeOf(space: string, folder: string): { name: string; pinned?: string } {
  const known = lookupFolderName(space, folder);
  const name = known ?? sanitizeAgentName(folder);
  const persona = personaFilePath(space, name);
  const pinned = known && existsSync(persona) ? readResumeId(persona) : undefined;
  return { name, pinned };
}

function transcriptLine(
  t: Transcript,
  pinned: string | undefined,
  names: Map<string, string>,
  indent: string,
  previewMax: number,
): string {
  const preview = firstUserText(t.file) ?? "(no user message)";
  const name = names.get(t.id);
  const tag = name ? `  «${name}»` : "";
  const mark = t.id === pinned ? "  ← adopted" : "";
  return `${indent}${t.id}  ${ago(Date.now() - t.mtime).padEnd(7)}  ${oneLine(preview, previewMax)}${tag}${mark}`;
}

/** Single-folder view: agent mode + the full transcript list + an adopt hint. */
function printFolder(space: string, folder: string, target: string | undefined): void {
  const { name, pinned } = agentModeOf(space, folder);
  console.log(`agent ${name}  ${folder}`);
  console.log(`  mode: ${pinned ? `adopted ← ${pinned}` : "fresh (cold-start on next paw chat)"}${foreignWarn(pinned)}\n`);
  const ts = transcriptsOf(folder);
  if (!ts.length) {
    console.log("  no claude sessions recorded for this folder");
    return;
  }
  const names = namesForFolder(folder);
  for (const t of ts) console.log(transcriptLine(t, pinned, names, "  ", 64));
  console.log(`\n  adopt one:  paw adopt ${target ?? "."} --resume <id|name>`);
}

/** Repo view: every worktree + the transcripts inside each. */
function printRepo(space: string, repoRoot: string): void {
  const wts = listWorktrees(repoRoot);
  // `git worktree list` puts the main worktree first; its basename is the repo's real name (querying
  // from a linked worktree makes repoRoot that worktree, so don't label off repoRoot).
  const repoName = basename(wts[0]?.path ?? repoRoot);
  console.log(`repo ${repoName}  (${wts.length} worktree${wts.length === 1 ? "" : "s"})\n`);
  for (const wt of wts) {
    const folder = existsSync(wt.path) ? realpathSync(wt.path) : wt.path;
    const head = wt.branch ?? `(detached ${wt.head?.slice(0, 7) ?? "?"})`;
    const { name, pinned } = agentModeOf(space, folder);
    console.log(`${head}   ${wt.path}`);
    console.log(`  agent ${name} · ${pinned ? `adopted ← ${pinned}` : "fresh"}${foreignWarn(pinned)}`);
    const ts = transcriptsOf(folder);
    if (!ts.length) {
      console.log("  (no sessions)\n");
      continue;
    }
    const names = namesForFolder(folder);
    for (const t of ts.slice(0, PER_WORKTREE_CAP)) console.log(transcriptLine(t, pinned, names, "    ", 52));
    if (ts.length > PER_WORKTREE_CAP) console.log(`    … +${ts.length - PER_WORKTREE_CAP} more (paw sessions ${wt.path})`);
    console.log("");
  }
  console.log(`adopt a branch:  paw adopt ${repoRoot}@<branch>   ·   a specific session: append --resume <id>`);
}

function parseArgs(argv: string[]): { space?: string; target?: string } {
  const out: { space?: string; target?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — sessions takes [<folder>|<repo>@<branch>] [--space <s>]`);
    else if (out.target === undefined) out.target = a;
    else throw new Error(`paw: unexpected argument "${a}" — sessions takes a single folder`);
  }
  return out;
}

async function sessions(argv: string[]): Promise<void> {
  const { space: spaceArg, target } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud

  // <repo>@<branch> → just that worktree's sessions.
  if (target && parseWorktreeRef(target)) {
    printFolder(space, resolveWorktreeFolder(target), target);
    return;
  }

  const folder = canonicalDir(target ?? ".");
  const repoRoot = gitToplevel(folder);
  if (repoRoot) printRepo(space, repoRoot); // a git repo → show all worktrees + their sessions
  else printFolder(space, folder, target); // plain folder → just this one
}

const sessionsCommand: Command = {
  kind: "command",
  name: "sessions",
  group: "Mesh",
  summary: "list claude transcripts for a folder/repo — repo shows every worktree + sessions inside each; <repo>@<branch> for one",
  usage: 'sessions [<folder>|<repo>@<branch>]   (default: ".")',
  run: (a) => sessions([...a.raw]),
};

registry.register(sessionsCommand);
