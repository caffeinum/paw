/**
 * `paw teleport --memory` (docs/notes/teleport.md#memory) — the agent's Claude Code auto-memory, found
 * where Claude Code really keeps it, merged into the ONE dir the destination's Claude Code will read.
 *
 * How Claude Code keys it (2.1.310 binary: `getAutoMemPath` → `resolveEntry` / `defaultKey`, checked
 * 2026-10-23): `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, else an `autoMemoryDirectory` setting, else
 * `<CLAUDE_CODE_REMOTE_MEMORY_DIR | ~/.claude>/projects/<sanitized base>/memory/`, where the base is the
 * CANONICAL git root of the folder — walk up to the first `.git`; a `.git` FILE (a linked worktree) is
 * followed through `gitdir:` + `commondir` to the main checkout — or the folder itself outside git.
 * So every worktree of a repo shares the repo root's memory; a session's own slug (a worktree's) is
 * where its transcript lives, not its memory. Sanitized = every non-alphanumeric char → `-`; a result
 * over 200 chars is cut and suffixed with a hash paw can't reproduce.
 *
 * The dream skill (~/.claude/skills/dream, `native` mode) consolidates every `projects/<slug>/memory/`
 * and keeps per-project state beside it: `memory/.last-dream` (unix seconds of the last run) and a
 * first-run backup `memory-backup-<YYYYMMDD>/`. Both move with the memory. `~/.claude/.dream-pending`
 * is a machine-wide flag, not the agent's: it stays.
 *
 * What moves: the canonical dir, plus any memory under the folder's own slug, the pinned session's
 * project dir, and the repo's worktrees (live ones and Claude Code's `.claude/worktrees/*` slugs) — older
 * Claude Codes keyed memory per folder. Merged by path inside the dir: identical files are one file, a
 * `.last-dream` keeps the newest stamp, anything else that differs is a clash and blocks.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Claude Code cuts a sanitized path past this length and appends a hash of it. */
export const MEMORY_SLUG_MAX = 200;
/** Dream's per-project stamp: newest wins on a merge, never a clash. */
export const LAST_DREAM = ".last-dream";
const SHOWN = 10;

export type MemFile = { rel: string; bytes: number; mtimeMs: number };

export type MemorySource = {
  /** HOME-relative project dir (`.claude/projects/<slug>`). */
  dir: string;
  why: string;
  /** Files under its memory/ and memory-backup-*\/ dirs. */
  files: number;
};

export type MemoryManifest = {
  /** The folder Claude Code keys the memory by (canonical git root, or the folder). */
  base: string;
  slug: string;
  sources: MemorySource[];
  /** The merged files, each at its SOURCE path (one per path inside the dir). */
  files: MemFile[];
  /** Path inside the project dir (`memory/MEMORY.md`) → sha256 of the file that moves. */
  hashes: Record<string, string>;
  /** Same path, different content, in two source dirs. */
  clashes: string[];
};

/** Claude Code's project-dir name for a path: every non-alphanumeric character becomes `-`. */
export function sanitizePath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

/** The memory slug of `base`, or undefined when Claude Code would hash it (paw can't name that dir). */
export function memorySlug(base: string): string | undefined {
  const s = sanitizePath(base);
  return s.length <= MEMORY_SLUG_MAX ? s : undefined;
}

/**
 * The folder Claude Code keys `cwd`'s memory by: the first ancestor holding `.git`; when that is a file
 * (a linked worktree), the main checkout it belongs to, read the way Claude Code reads it (`gitdir:` →
 * `commondir`, which must have `worktrees/` as the gitdir's parent); outside git, `cwd` itself. A `.git`
 * file that doesn't check out leaves the worktree root, as Claude Code does.
 */
export function claudeMemoryBase(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    let st;
    try {
      st = statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) return mainCheckout(dir, readFileSync(dotGit, "utf8"));
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

function mainCheckout(root: string, dotGit: string): string {
  const line = dotGit.trim();
  if (!line.startsWith("gitdir:")) return root;
  const gitdir = resolve(root, line.slice("gitdir:".length).trim());
  const commondirFile = join(gitdir, "commondir");
  if (!existsSync(commondirFile)) return root;
  const common = resolve(gitdir, readFileSync(commondirFile, "utf8").trim());
  if (dirname(gitdir) !== join(common, "worktrees")) return root;
  return basename(common) === ".git" ? dirname(common) : common;
}

/** Why Claude Code writes this agent's memory somewhere teleport doesn't look — or undefined. */
export function memoryOverride(home: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE) return `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=${env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE}`;
  if (env.CLAUDE_CODE_REMOTE_MEMORY_DIR) return `CLAUDE_CODE_REMOTE_MEMORY_DIR=${env.CLAUDE_CODE_REMOTE_MEMORY_DIR}`;
  for (const file of [join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json")]) {
    if (!existsSync(file)) continue;
    let s: { autoMemoryDirectory?: unknown };
    try {
      s = JSON.parse(readFileSync(file, "utf8")) as { autoMemoryDirectory?: unknown };
    } catch (e) {
      throw new Error(`paw: ${file} is not valid JSON (${(e as Error).message}) — can't tell where Claude Code keeps this agent's memory`);
    }
    if (s.autoMemoryDirectory !== undefined) return `autoMemoryDirectory: ${JSON.stringify(s.autoMemoryDirectory)} in ${file}`;
  }
  return undefined;
}

type Git = (args: string[], cwd: string) => { ok: boolean; out: string };
const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/** Every worktree path of the repo at `base` (`git worktree list`), the main one included. */
function worktreePaths(base: string, git: Git): string[] {
  if (!existsSync(join(base, ".git"))) return [];
  const r = git(["worktree", "list", "--porcelain"], base);
  if (!r.ok) return [];
  return r.out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

/** Files under `<projectDir>/memory/` and `<projectDir>/memory-backup-*\/` (following links). */
function memoryFilesIn(home: string, projectDir: string): MemFile[] {
  if (!existsSync(projectDir)) return [];
  const out: MemFile[] = [];
  const walk = (abs: string) => {
    const st = statSync(abs);
    if (st.isFile()) out.push({ rel: relative(home, abs), bytes: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    else if (st.isDirectory()) for (const n of readdirSync(abs).sort()) walk(join(abs, n));
  };
  for (const n of readdirSync(projectDir).sort())
    if ((n === "memory" || n.startsWith("memory-backup-")) && statSync(join(projectDir, n)).isDirectory()) walk(join(projectDir, n));
  return out;
}

function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/** `memory/MEMORY.md` for `.claude/projects/<slug>/memory/MEMORY.md`, with its slug — or undefined. */
export function memoryPathOf(rel: string): { slug: string; inner: string } | undefined {
  const m = /^\.claude\/projects\/([^/]+)\/((?:memory|memory-backup-[^/]+)\/.+)$/.exec(rel);
  return m ? { slug: m[1], inner: m[2] } : undefined;
}

/**
 * Every memory dir that is this agent's (see the file header), merged. `sessionDir` is the absolute
 * project dir of its pinned transcript, when it has one.
 */
export function memoryManifest(o: { home: string; cwd: string; sessionDir?: string; git?: Git }): MemoryManifest {
  const { home, cwd } = o;
  const git = o.git ?? realGit;
  const projects = join(home, ".claude", "projects");
  const base = claudeMemoryBase(cwd);
  const slug = memorySlug(base);
  if (!slug)
    throw new Error(`paw: Claude Code keys ${base}'s memory by a hashed name (its path is over ${MEMORY_SLUG_MAX} chars) — paw can't name that dir; teleport it with --no-memory`);
  const candidates: Array<{ slug: string; why: string }> = [{ slug, why: base === resolve(cwd) ? "its folder — Claude Code's key" : "the repo root — Claude Code's key" }];
  const add = (s: string | undefined, why: string) => s && !candidates.some((c) => c.slug === s) && candidates.push({ slug: s, why });
  add(memorySlug(resolve(cwd)), "its folder");
  if (o.sessionDir) add(basename(o.sessionDir), "its session's project dir");
  for (const wt of worktreePaths(base, git)) add(memorySlug(wt), `worktree ${wt}`);
  // Claude Code's own worktrees (`<repo>/.claude/worktrees/<name>`), also those removed since.
  const wtPrefix = `${slug}--claude-worktrees-`;
  if (existsSync(projects)) for (const d of readdirSync(projects).sort()) if (d.startsWith(wtPrefix)) add(d, "a Claude Code worktree of the repo");

  const sources: MemorySource[] = [];
  const kept = new Map<string, { file: MemFile; hash: string; from: string; stamp?: number }>();
  const clashes: string[] = [];
  for (const c of candidates) {
    const dir = join(projects, c.slug);
    const files = memoryFilesIn(home, dir);
    if (c.slug === slug || files.length) sources.push({ dir: relative(home, dir), why: c.why, files: files.length });
    for (const f of files) {
      const inner = memoryPathOf(f.rel)!.inner;
      const hash = sha256File(join(home, f.rel));
      const was = kept.get(inner);
      if (basename(inner) === LAST_DREAM) {
        const stamp = Number(readFileSync(join(home, f.rel), "utf8").trim());
        if (!Number.isFinite(stamp)) throw new Error(`paw: ${join(home, f.rel)} is not a unix timestamp — dream's stamp is unreadable; fix or remove it`);
        if (!was || stamp > (was.stamp ?? -Infinity)) kept.set(inner, { file: f, hash, from: c.slug, stamp });
        continue;
      }
      if (!was) kept.set(inner, { file: f, hash, from: c.slug });
      else if (was.hash !== hash) clashes.push(`${inner}: ~/.claude/projects/${was.from}/ and ~/.claude/projects/${c.slug}/ hold different files`);
    }
  }
  return {
    base,
    slug,
    sources,
    files: [...kept.values()].map((k) => k.file),
    hashes: Object.fromEntries([...kept.entries()].map(([inner, k]) => [inner, k.hash])),
    clashes,
  };
}

// ── the destination ────────────────────────────────────────────────────────────────────────────────

/** What the destination's Claude Code will read: its key folder, slug, and the files already there. */
export type DestMemory = { base: string; slug: string; files: Record<string, string> };

/**
 * POSIX sh: the destination's memory key for `cwd` (the same walk as {@link claudeMemoryBase}; `clone`
 * set = the repo's paw clone, the key of it and of every worktree of it) and the hash of every file in
 * that dir's memory/ and memory-backup-*\/. Needs HASH_SH's `paw_hash` and an `out` function.
 */
export function memoryProbeScript(cwd: string, clone?: string): string {
  return `MCWD=${shq(cwd)}
MCLONE=${shq(clone ?? "")}
if [ -n "$MCLONE" ]; then mb="$MCLONE"; else
  mb="$MCWD"; q="$MCWD"; while [ ! -e "$q" ]; do q=$(dirname "$q"); done
  while :; do
    if [ -d "$q/.git" ]; then mb="$q"; break; fi
    if [ -f "$q/.git" ]; then
      c=$(cd "$q" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || c=""
      if [ -z "$c" ]; then mb="$q"; elif [ "$(basename "$c")" = .git ]; then mb=$(dirname "$c"); else mb="$c"; fi
      break
    fi
    [ "$q" = / ] && break
    q=$(dirname "$q")
  done
fi
ms=$(printf '%s' "$mb" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')
out membase "$mb"
out memslug "$ms"
md="$HOME/.claude/projects/$ms"
if [ -d "$md" ]; then
  for sub in "$md"/memory "$md"/memory-backup-*; do
    [ -d "$sub" ] || continue
    (cd "$md" && find -L "$(basename "$sub")" -type f) | while IFS= read -r f; do out memfile "$(paw_hash "$md/$f") $f"; done
  done
fi`;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** {@link memoryProbeScript}'s lines (already split `key<TAB>value`) → {@link DestMemory}. */
export function parseDestMemory(lines: ReadonlyArray<readonly [string, string]>): DestMemory | undefined {
  const base = lines.find(([k]) => k === "membase")?.[1];
  const slug = lines.find(([k]) => k === "memslug")?.[1];
  if (base === undefined || slug === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const [k, v] of lines) if (k === "memfile") files[v.slice(v.indexOf(" ") + 1)] = v.slice(0, v.indexOf(" "));
  return { base, slug, files };
}

/** What stops the memory move. `replaceable`: the files there are this agent's own older copies (a
 *  `--back`, or a teleported-away copy there), which the move may overwrite. */
export function memoryBlockers(mm: MemoryManifest, d: DestMemory | undefined, there: string, replaceable: boolean): string[] {
  const out: string[] = [];
  if (mm.clashes.length)
    out.push(
      `${mm.clashes.length} memory file(s) differ between this agent's memory dirs here — teleport never picks one; merge them by hand, or --no-memory:\n` +
        mm.clashes.slice(0, SHOWN).map((c) => `    ${c}`).join("\n") +
        (mm.clashes.length > SHOWN ? `\n    … and ${mm.clashes.length - SHOWN} more` : ""),
    );
  if (!d) return [...out, `the memory dir on ${there} was not probed — refusing to place memory blind`];
  if (d.slug !== sanitizePath(d.base) || d.slug.length > MEMORY_SLUG_MAX)
    return [...out, `${there} keys the folder's memory by ${d.base}, whose Claude Code dir name paw can't reproduce there (non-ASCII, or over ${MEMORY_SLUG_MAX} chars) — --no-memory`];
  if (replaceable) return out;
  const differ = Object.entries(mm.hashes).filter(([inner, h]) => basename(inner) !== LAST_DREAM && d.files[inner] !== undefined && d.files[inner] !== h).map(([inner]) => inner);
  if (differ.length)
    out.push(
      `${there} already has ${differ.length} different memory file(s) in ~/.claude/projects/${d.slug}/ — teleport never overwrites them; reconcile them by hand, or --no-memory:\n` +
        differ.slice(0, SHOWN).map((f) => `    ${f}`).join("\n") +
        (differ.length > SHOWN ? `\n    … and ${differ.length - SHOWN} more` : ""),
    );
  return out;
}

/** The memory files identical on the destination already — not sent again. */
export function memoryAlreadyThere(mm: MemoryManifest, d: DestMemory | undefined): Set<string> {
  const same = new Set<string>();
  if (!d) return same;
  for (const f of mm.files) {
    const inner = memoryPathOf(f.rel)!.inner;
    if (d.files[inner] === mm.hashes[inner]) same.add(f.rel);
  }
  return same;
}

/** The plan's memory lines: the total, where it lands, and every source dir with its count. */
export function memoryPlanLines(mm: MemoryManifest, d: DestMemory | undefined, destHome: string, size: string): string[] {
  const same = memoryAlreadyThere(mm, d).size;
  const to = d ? `  → ${destHome}/.claude/projects/${d.slug}/  (keyed by ${d.base})` : "";
  const lines = [`  memory     ${size}${to}${same ? `  (${same} already there, identical)` : ""}`];
  for (const s of mm.sources) lines.push(`             ${s.files} file(s)  ~/${s.dir}/  (${s.why})`);
  return lines;
}
