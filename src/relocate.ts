/**
 * `paw relocate <agent>[#<space>] <new-folder> [--all] [--dry-run] [--yes]` — the agent's folder moved
 * (or should move) on disk; make the agent follow it. docs/notes/addressing.md#paw-relocate has the design.
 *
 * Two shapes, read from the disk, never guessed:
 *  - old folder there, new one not → paw MOVES it (`rename(2)`: same filesystem only), then re-points;
 *  - old folder gone, new one there → the operator already moved it: re-point only.
 * Re-point = the persona's `cwd:`, legacy folders.json/agents.json entries, and Claude Code's per-folder
 * state: the session chain (transcripts + sidecar dirs) COPIED into the new folder's project dir with
 * `cwd` rewritten (teleport's helpers), and the auto-memory merged into the dir the new folder is keyed by
 * (canonical git root — teleport-memory.ts). The originals stay where they were, as the backup.
 *
 * The incident: `skills` ran in ~/Github/team2027/2027-skills; the operator ran `mv 2027-skills skills`;
 * its cwd was gone, so it could not start, and its transcript sat under -Users-aleks-Github-team2027-2027-skills.
 *
 * Pure planning ({@link relocateDisk}, {@link relocateBlockers}, {@link relocatePlan}) is split from the
 * cutover ({@link applyRelocate}), whose stop/start are injected so check:relocate drives it hermetically.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { registry, type Command } from "@cotal-ai/core";
import {
  elsewhereHint,
  ensureAgentSpawned,
  findUnmanagedAgent,
  personaFilePath,
  psRowAlive,
  quietFor,
  SESSION_RELEASE_MS,
  stopAgent,
  withRegistryLock,
  type PsRow,
} from "./addressing.ts";
import { readForeground } from "./foreground.ts";
import { resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { liveSessionProcs, meshIdentity } from "./named.ts";
import { personaTranscriptRoots, readAgentType, readCwd, readResumeId, transcriptExists, transcriptMtime, transcriptPath, writesClaudeTranscript } from "./session.ts";
import { sleepState } from "./sleep-state.ts";
import { readTeleported, rewriteCwdText, sessionChain } from "./teleport-plan.ts";
import { claudeMemoryBase, LAST_DREAM, MEMORY_SLUG_MAX, memoryManifest, memoryOverride, memoryPathOf, memorySlug, sanitizePath, type MemorySource } from "./teleport-memory.ts";

/** A running agent whose transcript was written this recently is mid-work: relocating it needs `--yes` (as `paw move`). */
export const RELOCATE_BUSY_MS = 10 * 60_000;

export const RELOCATE_USAGE = "relocate <agent>[#<space>] <new-folder> [--all] [--dry-run] [--yes]";

export type RelocateArgs = { name: string; space?: string; target: string; all: boolean; dryRun: boolean; yes: boolean };

export function parseRelocateArgs(argv: string[]): RelocateArgs {
  const out: { name?: string; space?: string; target?: string; all: boolean; dryRun: boolean; yes: boolean } = { all: false, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`paw: --space needs a value — ${RELOCATE_USAGE}`);
      out.space = v;
    } else if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${RELOCATE_USAGE}`);
    else if (out.name === undefined) out.name = a;
    else if (out.target === undefined) out.target = a;
    else throw new Error(`paw: unexpected argument "${a}" — relocate takes one agent and one folder`);
  }
  if (!out.name) throw new Error(`paw: which agent? — ${RELOCATE_USAGE}`);
  if (!/^[A-Za-z0-9_-]+$/.test(out.name)) throw new Error(`paw: "${out.name}" is not an agent name — relocate addresses an agent by name (\`paw status\` lists them)`);
  if (!out.target) throw new Error(`paw: where to? — ${RELOCATE_USAGE}`);
  return out as RelocateArgs;
}

function pawHome(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

/** `p` is `root` or inside it. */
export function under(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/** `p` (under `from`) at the same place under `to`. */
function moveUnder(p: string, from: string, to: string): string {
  return to + p.slice(from.length);
}

/** The new folder as an absolute path: `~` expanded, resolved against `base`, real-pathed as far as it
 *  exists (the folder itself, else its parent) — the form paw registers folders in. */
export function resolveNewFolder(target: string, base: string, home: string): string {
  const expanded = target === "~" ? home : target.startsWith("~/") ? join(home, target.slice(2)) : target;
  const abs = resolve(base, expanded);
  if (existsSync(abs)) return realpathSync(abs);
  return existsSync(dirname(abs)) ? join(realpathSync(dirname(abs)), basename(abs)) : abs;
}

/** One agent that follows the folder: its old and new `cwd`. */
export type Mover = { space: string; name: string; persona: string; agent: string; pin?: string; from: string; to: string };

/** One file to place. `rewrite` = a transcript whose `cwd` fields follow the folder; `overwrite` = dream's
 *  `.last-dream` stamp replaced by a newer one (the only file ever overwritten). */
export type FileCopy = { src: string; dst: string; rewrite?: { from: string; to: string }; overwrite?: true };

export type MemoryMove = { fromBase: string; toBase: string; dstDir: string; sources: MemorySource[]; copies: FileCopy[]; same: number };

export type RelocateDisk = {
  space: string;
  name: string;
  /** undefined when neither/both folders exist — a blocker says which. */
  mode?: "move" | "repoint";
  from: string;
  to: string;
  movers: Mover[];
  /** Agents in the old folder (or under it) that were not asked to follow — `--all` takes them along. */
  others: Mover[];
  sessions: FileCopy[];
  /** The new project dirs the sessions land in. */
  sessionDirs: string[];
  /** Session files already in the new project dir, identical. */
  sessionsSame: number;
  memory: MemoryMove[];
  /** Legacy registry files (pre-registry.v2 side-tables) that name the old path: their new text. */
  legacy: Array<{ file: string; text: string; count: number }>;
  /** Where the originals stay (the project dirs the copies came from). */
  backups: string[];
  notes: string[];
  blockers: string[];
};

type Deps = { home?: string; cwd?: string; env?: NodeJS.ProcessEnv };

/** Every local persona whose `cwd:` is `root` or under it, across all spaces on this machine. */
function agentsUnder(root: string): Mover[] {
  const spaces = join(pawHome(), "spaces");
  if (!existsSync(spaces)) return [];
  const out: Mover[] = [];
  for (const s of readdirSync(spaces, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const dir = join(spaces, s, "personas");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const persona = join(dir, f);
      const cwd = readCwd(persona);
      if (!cwd || !under(cwd, root)) continue;
      const pin = readResumeId(persona);
      out.push({ space: s, name: f.slice(0, -".md".length), persona, agent: readAgentType(persona) || "claude", ...(pin ? { pin } : {}), from: cwd, to: cwd });
    }
  }
  return out;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Every file under `dir` (recursively, links followed). */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    const st = statSync(abs);
    if (st.isFile()) out.push(abs);
    else if (st.isDirectory()) for (const n of readdirSync(abs).sort()) walk(join(abs, n));
  };
  walk(dir);
  return out;
}

/** The bytes a copy writes: a transcript with its `cwd` fields moved, anything else verbatim. */
export function copyContent(c: FileCopy): Buffer {
  const raw = readFileSync(c.src);
  return c.rewrite ? Buffer.from(rewriteCwdText(raw.toString("utf8"), c.rewrite.from, c.rewrite.to).text) : raw;
}

/** What the disk says. Pure reads; check:relocate builds it over a temp HOME + PAW_HOME. */
export function relocateDisk(a: { space: string; name: string; target: string; all: boolean }, deps: Deps = {}): RelocateDisk {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const { space, name } = a;
  const persona = personaFilePath(space, name);
  if (!existsSync(persona)) throw new Error(`paw: no agent named "${name}" in space "${space}"${elsewhereHint(space, name)} (\`paw status --space ${space}\` lists them)`);
  const from = readCwd(persona);
  if (!from) throw new Error(`paw: "${name}" in "${space}" has no \`cwd:\` in ${persona} — an orphan persona has no folder to follow; \`paw rm ${name}#${space}\` it instead`);
  const to = resolveNewFolder(a.target, deps.cwd ?? process.cwd(), home);
  const blockers: string[] = [];
  const notes: string[] = [];
  const fromExists = existsSync(from);
  const toExists = existsSync(to);
  let mode: RelocateDisk["mode"];

  if (to === from) blockers.push(`${to} is already "${name}"'s folder — nothing to relocate`);
  else if (under(to, from)) blockers.push(`${to} is inside "${name}"'s own folder ${from} — a folder can't move into itself`);
  else if (fromExists && toExists)
    blockers.push(`both ${from} (its folder) and ${to} exist — paw never merges folders or guesses which one is the agent's; move one aside first`);
  else if (!fromExists && !toExists) blockers.push(`neither ${from} (its folder) nor ${to} exists — where did the folder go? point at the folder it lives in now`);
  else if (fromExists) {
    mode = "move";
    if (!statSync(from).isDirectory()) blockers.push(`${from} is not a directory`);
    if (!existsSync(dirname(to))) blockers.push(`${dirname(to)} doesn't exist — create the parent first (paw moves the folder, it doesn't invent the path to it)`);
    else if (statSync(from).dev !== statSync(dirname(to)).dev)
      blockers.push(`${from} and ${dirname(to)} are on different filesystems — paw only moves a folder with rename(2), never a copy+delete; move it yourself (\`mv\`), then rerun to re-point`);
  } else {
    mode = "repoint";
    if (!statSync(to).isDirectory()) blockers.push(`${to} is not a directory`);
  }

  const all = agentsUnder(from).map((m) => ({ ...m, to: moveUnder(m.from, from, to) }));
  const self = all.find((m) => m.space === space && m.name === name)!;
  const others = all.filter((m) => m !== self);
  if (others.length && !a.all)
    blockers.push(
      `${others.length} other agent(s) are registered in ${from} or under it — relocating the folder strands them; --all takes them along:\n` +
        others.map((m) => `    ${m.name}#${m.space}  ${m.from}`).join("\n"),
    );
  const movers = a.all ? [self, ...others] : [self];

  for (const m of movers) {
    const at = `${m.name}#${m.space}`;
    const mark = readTeleported(m.persona);
    if (mark) blockers.push(`${at} was teleported to ${mark.to} — it runs there now; \`paw teleport ${m.name} --back\` first`);
    const fg = readForeground(m.space, m.name);
    if (fg) blockers.push(`${at} is a foreground \`paw claude\` (pid ${fg.pid}) in a terminal here — close it first`);
    const sleep = sleepState(m.space, m.name);
    if (sleep) blockers.push(`${at} is ${sleep} (paw sleep) — wake it (\`paw start ${at}\`) or \`paw stop ${at}\` first`);
    for (const p of [m.from, m.to]) if (sanitizePath(p).length > MEMORY_SLUG_MAX) blockers.push(`${p} is over ${MEMORY_SLUG_MAX} chars — Claude Code names its project dir by a hash paw can't reproduce`);
    const text = readFileSync(m.persona, "utf8");
    const elsewhere = text.split("\n").filter((l) => !/^cwd:/.test(l) && l.includes(from));
    if (elsewhere.length) notes.push(`${m.persona} still names ${from} outside \`cwd:\` (not rewritten): ${elsewhere.map((l) => l.trim().slice(0, 80)).join(" | ")}`);
  }

  // ── sessions ──────────────────────────────────────────────────────────────────────────────────
  const sessions: FileCopy[] = [];
  const backups = new Set<string>();
  const chains = new Map<string, Set<string>>(); // old project dir → ids that move
  const sessionDirs: string[] = [];
  let sessionsSame = 0;
  const place = (c: FileCopy) => {
    if (sessions.some((s) => s.dst === c.dst)) return;
    if (existsSync(c.dst)) {
      if (sha256(readFileSync(c.dst)) === sha256(copyContent(c))) sessionsSame++;
      else blockers.push(`${c.dst} already exists and differs from the copy of ${c.src} — paw never overwrites a transcript; move it aside first`);
      return;
    }
    sessions.push(c);
  };
  for (const m of movers) {
    const at = `${m.name}#${m.space}`;
    if (!writesClaudeTranscript(m.agent)) {
      notes.push(`${at} runs on ${m.agent} — its session lives in that harness's own store, which paw doesn't key by folder; left as is`);
      continue;
    }
    if (!m.pin) {
      notes.push(`${at} has no \`resume:\` pin — no session to carry`);
      continue;
    }
    const roots = personaTranscriptRoots(m.persona);
    let found = false;
    for (const root of roots) {
      const oldDir = join(root, sanitizePath(m.from));
      const newDir = join(root, sanitizePath(m.to));
      if (!existsSync(join(oldDir, `${m.pin}.jsonl`))) {
        const at2 = transcriptPath(m.pin, [root]);
        if (at2) {
          found = true;
          notes.push(`${at}'s session ${m.pin} is in ${dirname(at2)}, not the old folder's dir — claude resumes it by id from there; left as is`);
        }
        continue;
      }
      found = true;
      backups.add(oldDir);
      const ids = sessionChain(oldDir, m.pin);
      const moving = chains.get(oldDir) ?? new Set<string>();
      chains.set(oldDir, moving);
      for (const id of ids) moving.add(id);
      if (!sessionDirs.includes(newDir)) sessionDirs.push(newDir);
      if (ids.length > 1) notes.push(`${at}: session chain ${ids.join(" → ")} (continued-in links) — all of it moves`);
      const rewrite = { from: m.from, to: m.to };
      for (const id of ids) {
        place({ src: join(oldDir, `${id}.jsonl`), dst: join(newDir, `${id}.jsonl`), rewrite });
        const side = join(oldDir, id);
        if (existsSync(side))
          for (const f of filesIn(side)) {
            const dst = join(newDir, id, relative(side, f));
            place({ src: f, dst, ...(f.endsWith(".jsonl") ? { rewrite } : {}) });
          }
      }
    }
    if (!found) notes.push(`${at} has no transcript at resume: ${m.pin} yet — it starts that session fresh in the new folder`);
  }
  for (const [dir, ids] of chains) {
    const rest = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !ids.has(f.slice(0, -".jsonl".length))).length;
    if (rest) notes.push(`${rest} other session(s) in ${dir} are not these agents' — they stay there (\`claude --resume <id>\` still finds them)`);
  }

  // ── memory ────────────────────────────────────────────────────────────────────────────────────
  const memory: MemoryMove[] = [];
  const seenBase = new Set<string>();
  for (const m of movers) {
    let fromBase: string;
    let toBase: string;
    if (mode === "repoint") {
      toBase = claudeMemoryBase(m.to);
      fromBase = under(toBase, to) ? moveUnder(toBase, to, from) : toBase;
    } else {
      fromBase = claudeMemoryBase(m.from);
      toBase = under(fromBase, from) ? moveUnder(fromBase, from, to) : fromBase;
    }
    if (seenBase.has(fromBase)) continue;
    seenBase.add(fromBase);
    if (fromBase === toBase) {
      notes.push(`memory stays — Claude Code keys it by ${fromBase}, which doesn't move`);
      continue;
    }
    const override = memoryOverride(home, existsSync(m.from) ? m.from : m.to, env);
    if (override) {
      notes.push(`memory not copied — Claude Code writes ${m.name}'s memory where ${override} says, not under ~/.claude/projects`);
      continue;
    }
    const toSlug = memorySlug(toBase);
    if (!toSlug) {
      blockers.push(`${toBase} is over ${MEMORY_SLUG_MAX} chars — Claude Code keys its memory by a hash paw can't reproduce`);
      continue;
    }
    const pinned = m.pin ? join(home, ".claude", "projects", sanitizePath(m.from)) : undefined;
    const mm = memoryManifest({ home, cwd: m.from, base: fromBase, ...(pinned && existsSync(pinned) ? { sessionDir: pinned } : {}) });
    for (const c of mm.clashes) blockers.push(`memory: ${c} — paw never picks one; merge them by hand`);
    const dstDir = join(home, ".claude", "projects", toSlug);
    const copies: FileCopy[] = [];
    let same = 0;
    for (const f of mm.files) {
      const inner = memoryPathOf(f.rel)!.inner;
      const src = join(home, f.rel);
      const dst = join(dstDir, inner);
      if (src === dst) continue;
      if (!existsSync(dst)) {
        copies.push({ src, dst });
        continue;
      }
      if (basename(inner) === LAST_DREAM) {
        const stamp = (p: string) => Number(readFileSync(p, "utf8").trim());
        if (stamp(src) > stamp(dst)) copies.push({ src, dst, overwrite: true });
        else same++;
        continue;
      }
      if (sha256(readFileSync(dst)) === mm.hashes[inner]) same++;
      else blockers.push(`memory: ${dst} already exists and differs from ${src} — paw never overwrites memory; reconcile them by hand`);
    }
    if (!mm.files.length) {
      notes.push(`no memory to carry — nothing in ${mm.sources.map((s) => `~/${s.dir}/memory/`).join(", ")}`);
      continue;
    }
    for (const s of mm.sources) if (s.files) backups.add(join(home, s.dir));
    memory.push({ fromBase, toBase, dstDir, sources: mm.sources, copies, same });
  }

  // ── legacy registry side-tables (read only before registry.v2; kept true anyway) ──────────────────
  const legacy: RelocateDisk["legacy"] = [];
  const spaces = join(pawHome(), "spaces");
  for (const s of existsSync(spaces) ? readdirSync(spaces).sort() : []) {
    for (const [f, keyed] of [["folders.json", true], ["agents.json", false]] as const) {
      const file = join(spaces, s, f);
      if (!existsSync(file)) continue;
      let map: Record<string, string>;
      try {
        map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      } catch (e) {
        blockers.push(`${file} is not valid JSON (${(e as Error).message}) — fix or delete it`);
        continue;
      }
      let count = 0;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(map)) {
        const folder = keyed ? k : v;
        const moved = typeof folder === "string" && under(folder, from) ? moveUnder(folder, from, to) : folder;
        if (moved !== folder) count++;
        if (keyed) next[moved] = v;
        else next[k] = moved;
      }
      if (count) legacy.push({ file, text: `${JSON.stringify(next, null, 2)}\n`, count });
    }
  }

  // ── what doesn't follow: said, not done ────────────────────────────────────────────────────────
  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      const projects = (JSON.parse(readFileSync(claudeJson, "utf8")) as { projects?: Record<string, Record<string, unknown>> }).projects ?? {};
      for (const [p, v] of Object.entries(projects)) {
        if (!under(p, from)) continue;
        const kept = ["mcpServers", "enabledMcpjsonServers", "allowedTools"].filter((k) => {
          const x = v?.[k];
          return Array.isArray(x) ? x.length > 0 : x && typeof x === "object" ? Object.keys(x).length > 0 : false;
        });
        if (kept.length) notes.push(`~/.claude.json has per-folder settings for ${p} (${kept.join(", ")}) — not copied; re-add them for ${moveUnder(p, from, to)}`);
      }
    } catch (e) {
      notes.push(`~/.claude.json unreadable (${(e as Error).message}) — couldn't check its per-folder settings`);
    }
  }
  if (mode === "move") {
    const dotGit = join(from, ".git");
    if (existsSync(dotGit) && statSync(dotGit).isFile()) notes.push(`${from} is a linked git worktree — after the move: git -C ${to} worktree repair`);
    else if (existsSync(dotGit)) {
      const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: from, encoding: "utf8" });
      const linked = r.status === 0 ? r.stdout.split("\n").filter((l) => l.startsWith("worktree ")).length - 1 : 0;
      if (linked > 0) notes.push(`${linked} linked git worktree(s) point into ${from}/.git — after the move: git -C ${to} worktree repair`);
    }
  }

  return { space, name, ...(mode ? { mode } : {}), from, to, movers, others, sessions, sessionDirs, sessionsSame, memory, legacy, backups: [...backups], notes, blockers };
}

/** What the live mesh/processes say about one mover. */
export type MoverLive = { listed: boolean; running: boolean; activeMs?: number; strangers: string[]; unmanaged?: string };
export type RelocateLive = Map<string, MoverLive>;
export const moverKey = (m: Pick<Mover, "space" | "name">) => `${m.name}#${m.space}`;

/** The live half of the blockers. Pure; check:relocate covers each. */
export function liveBlockers(d: RelocateDisk, live: RelocateLive, o: { yes: boolean; now: number }): string[] {
  const out: string[] = [];
  for (const m of d.movers) {
    const l = live.get(moverKey(m));
    if (!l) continue;
    const at = moverKey(m);
    if (l.strangers.length) out.push(`${at}'s session ${m.pin} is held by ${l.strangers.join(", ")} — two writers on one transcript; close ${l.strangers.length === 1 ? "it" : "them"} first`);
    if (l.unmanaged) out.push(`${at} is live on the mesh but not under this machine's manager (${l.unmanaged}) — paw can't stop it; \`paw restart ${at}\` re-adopts it if it runs here`);
    if (l.running && !o.yes && l.activeMs !== undefined && o.now - l.activeMs >= 0 && o.now - l.activeMs < RELOCATE_BUSY_MS)
      out.push(`${at} is busy — its transcript was written ${quietFor(o.now - l.activeMs)} ago (< ${RELOCATE_BUSY_MS / 60_000}m); wait for it, or --yes to stop it mid-work`);
  }
  return out;
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

/** The plan: one line per thing that changes, then what stays and why. Pure. */
export function relocatePlan(d: RelocateDisk, live: RelocateLive | undefined, o: { now: number }): string[] {
  const h = homedir();
  const short = (p: string) => (under(p, h) ? `~${p.slice(h.length)}` : p);
  const lines = [
    `relocate ${d.name}#${d.space}: ${d.from} → ${d.to}`,
    d.mode === "move"
      ? `  ${"folder".padEnd(10)} mv ${d.from} → ${d.to}  (same filesystem, one rename)`
      : d.mode === "repoint"
        ? `  ${"folder".padEnd(10)} already moved — ${d.from} is gone, ${d.to} is there; re-pointing only`
        : `  ${"folder".padEnd(10)} ?`,
  ];
  for (const m of d.movers) {
    const l = live?.get(moverKey(m));
    const state = !l ? "" : l.running ? `  — running${l.activeMs !== undefined ? `, transcript written ${quietFor(o.now - l.activeMs)} ago` : ""}: stopped, then started again in the new folder` : "  — not running";
    lines.push(`  ${"agent".padEnd(10)} ${moverKey(m)} (${m.agent}) cwd: ${m.from} → ${m.to}${state}`);
  }
  const bytes = d.sessions.reduce((n, c) => n + statSync(c.src).size, 0);
  if (d.sessions.length || d.sessionsSame) {
    lines.push(
      `  ${"sessions".padEnd(10)} ${d.sessions.length} file(s), ${size(bytes)} copied → ${d.sessionDirs.map((p) => `${short(p)}/`).join(", ")}  (cwd fields rewritten${d.sessionsSame ? `; ${d.sessionsSame} already there, identical` : ""})`,
    );
  } else lines.push(`  ${"sessions".padEnd(10)} nothing to copy`);
  for (const mm of d.memory) {
    lines.push(`  ${"memory".padEnd(10)} ${mm.copies.length} file(s) → ${short(mm.dstDir)}/  (keyed by ${mm.toBase}${mm.same ? `; ${mm.same} already there, identical` : ""})`);
    for (const s of mm.sources) lines.push(`             ${s.files} file(s)  ~/${s.dir}/  (${s.why})`);
  }
  for (const l of d.legacy) lines.push(`  ${"registry".padEnd(10)} ${short(l.file)}: ${l.count} legacy entr${l.count === 1 ? "y" : "ies"} re-pointed`);
  if (d.backups.length) lines.push(`  ${"backup".padEnd(10)} originals stay where they are: ${d.backups.map(short).join(", ")}`);
  for (const n of d.notes) lines.push(`  ${"note".padEnd(10)} ${n}`);
  return lines;
}

export type RelocateDeps = {
  stop(space: string, name: string, pin: string | undefined): Promise<{ released: boolean }>;
  start(space: string, name: string, cwd: string): Promise<void>;
  log(line: string): void;
};

/**
 * The cutover. Never two writers, never a half-moved agent: stop every running mover (and wait for its
 * session to be let go) → `replan()` (the transcripts may have grown while it ran) → move the folder →
 * copy sessions + memory (`wx`: never over an existing file, but a newer `.last-dream`) → rewrite the
 * personas + legacy entries → start again whoever ran. Any failure after the stop undoes every disk step
 * in reverse and starts them again where they were.
 */
export async function applyRelocate(d0: RelocateDisk, live: RelocateLive, deps: RelocateDeps, replan: () => RelocateDisk): Promise<{ started: Mover[] }> {
  const running = d0.movers.filter((m) => live.get(moverKey(m))?.running);
  const stopped: Mover[] = [];
  const restartOld = async (): Promise<string[]> => {
    const notes: string[] = [];
    for (const m of running.filter((r) => stopped.includes(r)))
      try {
        await deps.start(m.space, m.name, m.from);
      } catch (e) {
        notes.push(`restarting ${moverKey(m)} in ${m.from} FAILED (${(e as Error).message}) — start it by hand: paw start ${moverKey(m)}`);
      }
    return notes;
  };
  for (const m of d0.movers.filter((x) => live.get(moverKey(x))?.listed)) {
    deps.log(`→ stopping ${moverKey(m)} …`);
    const r = await deps.stop(m.space, m.name, m.pin);
    stopped.push(m);
    if (!r.released) {
      const notes = await restartOld();
      throw new Error(`paw: ${moverKey(m)}'s session ${m.pin} is still held ${SESSION_RELEASE_MS / 1000}s after the stop — nothing was relocated${notes.length ? `; ${notes.join("; ")}` : ""}`);
    }
  }
  const d = replan();
  if (d.blockers.length || d.mode !== d0.mode) {
    const notes = await restartOld();
    throw new Error(`paw: the disk changed after the stop — nothing was relocated:\n  ${d.blockers.join("\n  ") || `mode ${d0.mode} → ${d.mode}`}${notes.length ? `\n  ${notes.join("; ")}` : ""}`);
  }
  const undo: Array<{ what: string; run: () => void }> = [];
  const started: Mover[] = [];
  try {
    if (d.mode === "move") {
      if (existsSync(d.to)) throw new Error(`${d.to} appeared during the relocate — not moving onto it`);
      renameSync(d.from, d.to);
      undo.push({ what: `move ${d.to} back to ${d.from}`, run: () => renameSync(d.to, d.from) });
    }
    for (const c of [...d.sessions, ...d.memory.flatMap((mm) => mm.copies)]) {
      const made = mkdirSync(dirname(c.dst), { recursive: true });
      if (made) undo.push({ what: `remove ${made}`, run: () => rmSync(made, { recursive: true, force: true }) });
      if (c.overwrite) {
        const was = readFileSync(c.dst);
        copyFileSync(c.src, c.dst);
        undo.push({ what: `restore ${c.dst}`, run: () => writeFileSync(c.dst, was) });
      } else {
        if (c.rewrite) writeFileSync(c.dst, copyContent(c), { flag: "wx" });
        else copyFileSync(c.src, c.dst, constants.COPYFILE_EXCL);
        undo.push({ what: `remove ${c.dst}`, run: () => rmSync(c.dst, { force: true }) });
      }
    }
    for (const space of [...new Set(d.movers.map((m) => m.space))])
      withRegistryLock(space, () => {
        for (const m of d.movers.filter((x) => x.space === space)) {
          const was = readFileSync(m.persona, "utf8");
          if (!/^cwd:.*$/m.test(was)) throw new Error(`${m.persona} lost its \`cwd:\` line during the relocate`);
          writeFileSync(m.persona, was.replace(/^cwd:.*$/m, `cwd: ${m.to}`));
          undo.push({ what: `restore ${m.persona}`, run: () => writeFileSync(m.persona, was) });
        }
      });
    for (const l of d.legacy) {
      const was = readFileSync(l.file, "utf8");
      writeFileSync(l.file, l.text);
      undo.push({ what: `restore ${l.file}`, run: () => writeFileSync(l.file, was) });
    }
    for (const m of d.movers.filter((x) => running.some((r) => moverKey(r) === moverKey(x)))) {
      deps.log(`→ starting ${moverKey(m)} in ${m.to} …`);
      started.push(m); // before the await: a start that fails may have left a half-up seat to stop
      await deps.start(m.space, m.name, m.to);
    }
    return { started };
  } catch (e) {
    const msg = (e as Error).message;
    const notes: string[] = [];
    for (const m of started)
      try {
        await deps.stop(m.space, m.name, m.pin);
      } catch (se) {
        notes.push(`stopping ${moverKey(m)} in the new folder failed: ${(se as Error).message}`);
      }
    for (const u of undo.reverse())
      try {
        u.run();
      } catch (ue) {
        notes.push(`${u.what} FAILED: ${(ue as Error).message}`);
      }
    notes.push(...(await restartOld()));
    throw new Error(`paw: relocate ${d.name} failed: ${msg}\n  rolled back — ${notes.length ? notes.join("; ") : `everything is as before${running.length ? ", running again" : ""}`}`);
  }
}

/** The live half of preflight: each mover's manager row, the processes on its session, an unmanaged seat. */
async function relocateLive(d: RelocateDisk): Promise<RelocateLive> {
  const out: RelocateLive = new Map();
  for (const space of [...new Set(d.movers.map((m) => m.space))]) {
    const rows = await withEnsuredManager(space, async (ctl) => {
      const ps = await ctl.ps();
      if (!ps.ok) throw new Error(`paw: "${space}"'s manager isn't answering (${ps.error ?? "no reply"})`);
      return (ps.data as PsRow[]) ?? [];
    });
    for (const m of d.movers.filter((x) => x.space === space)) {
      const row = rows.find((r) => r.name === m.name);
      const running = row !== undefined && psRowAlive(row);
      const own = (pid: number, mesh: boolean) => {
        if (!running || !mesh) return false;
        const id = meshIdentity(pid);
        return id.name === m.name && id.space === m.space;
      };
      const lost = row ? undefined : await findUnmanagedAgent(m.space, m.name);
      const strangers = (m.pin ? liveSessionProcs(m.pin) : [])
        .filter((p) => !own(p.pid, p.mesh) && !lost?.pids.includes(p.pid))
        .map((p) => `pid ${p.pid}${p.mesh ? " (a mesh agent)" : " (a standalone claude)"}`);
      const unmanaged = lost ? [lost.id && `peer ${lost.id}`, lost.pids.length && `pid ${lost.pids.join(", ")}`].filter(Boolean).join(", ") : undefined;
      const activeMs = m.pin ? transcriptMtime(m.pin, personaTranscriptRoots(m.persona)) : undefined;
      out.set(moverKey(m), { listed: row !== undefined, running, ...(activeMs !== undefined ? { activeMs } : {}), strangers, ...(unmanaged ? { unmanaged } : {}) });
    }
  }
  return out;
}

const liveDeps: RelocateDeps = {
  stop: async (space, name, pin) => {
    await withEnsuredManager(space, (ctl) => stopAgent(ctl, name));
    const deadline = Date.now() + SESSION_RELEASE_MS;
    while (pin && liveSessionProcs(pin).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    return { released: !pin || liveSessionProcs(pin).length === 0 };
  },
  start: async (space, name, cwd) => {
    const r = await withEnsuredManager(space, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd, reuseUnmanaged: false }));
    if (r.stuck) throw new Error(`paw: "${name}" is stuck starting in ${space}: ${r.stuck}`);
  },
  log: (s) => console.log(s),
};

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function relocate(a: RelocateArgs): Promise<void> {
  const space = a.space?.trim() || resolveSpace();
  const args = { space, name: a.name, target: a.target, all: a.all };
  const d = relocateDisk(args);
  const live = d.blockers.length ? undefined : await relocateLive(d);
  const now = Date.now();
  const blockers = [...d.blockers, ...(live ? liveBlockers(d, live, { yes: a.yes, now }) : [])];
  for (const line of relocatePlan(d, live, { now })) console.log(line);
  if (blockers.length) {
    console.log("");
    console.log(`blocked — ${blockers.length} thing(s) to fix first:`);
    for (const b of blockers) console.log(`  ✗ ${b}`);
    throw new Error(`paw: relocate ${d.name} is blocked (${blockers.length}) — nothing was changed`);
  }
  if (a.dryRun) {
    console.log("");
    console.log("dry run — preflight passed; nothing was stopped, moved, copied or started");
    return;
  }
  const running = d.movers.filter((m) => live!.get(moverKey(m))?.running).map(moverKey);
  if (!a.yes) {
    const what = `${d.mode === "move" ? `move ${d.from} → ${d.to} and ` : ""}re-point ${d.movers.map(moverKey).join(", ")}${running.length ? ` — running: ${running.join(", ")} (stopped, then started again in the new folder)` : ""}`;
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error(`paw: no terminal to confirm on — pass --yes to ${what}`);
    if (!(await confirm(`${what}? [y/N] `))) throw new Error("paw: relocate cancelled — nothing was changed");
  }
  const { started } = await applyRelocate(d, live!, liveDeps, () => relocateDisk(args));
  console.log(`✓ relocated ${d.movers.map(moverKey).join(", ")}: ${d.from} → ${d.to}`);
  if (d.backups.length) console.log(`  originals kept (backup) in: ${d.backups.join(", ")}`);
  for (const m of d.movers) {
    const pinned = !!m.pin && writesClaudeTranscript(m.agent);
    const resumed = pinned && transcriptExists(m.pin!, personaTranscriptRoots(m.persona));
    console.log(
      started.some((s) => moverKey(s) === moverKey(m))
        ? `  ${moverKey(m)} live again in ${m.to} (${!pinned ? "its harness keeps its own session" : resumed ? `resumed its session ${m.pin}` : "fresh session — no turns yet"})`
        : `  ${moverKey(m)} not running — \`paw start ${moverKey(m)}\` brings it up in ${m.to}`,
    );
  }
  console.log(`  check: paw status ${d.name}#${space}`);
}

const relocateCommand: Command = {
  kind: "command",
  name: "relocate",
  group: "Lifecycle",
  summary: "the agent's folder moved (or should move) on disk — make it follow: persona cwd, sessions, memory — relocate <agent> <new-folder>",
  usage: RELOCATE_USAGE,
  run: (a) => relocate(parseRelocateArgs([...a.raw])),
};

registry.register(relocateCommand);
