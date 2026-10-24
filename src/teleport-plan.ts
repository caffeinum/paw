/**
 * `paw teleport` — the pure half (docs/notes/teleport.md): argument parsing, the transport word, the
 * compaction-chain walk over Claude Code transcripts, the source MANIFEST (every file that moves, with
 * its size), the destination FACTS a probe script reports, the BLOCKERS those imply, and the printed
 * plan. Nothing here talks to a network or a manager; src/teleport.ts drives the cutover.
 *
 * Paths that move live under the source HOME and land under the destination HOME at the same relative
 * path (`.claude/projects/<slug>/<id>.jsonl`); the agent's folder is MIRRORED at the same absolute path,
 * so a transcript's `cwd` and its project slug need no rewriting.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { branchWorktreeDir, repoDirUnder } from "./repo-layout.ts";
import { beadsBlockers, beadsHere, beadsPlanLines, type BeadsManifest, type BeadsSide } from "./teleport-beads.ts";
import {
  claudeProjectsRoot,
  isClaudeHarness,
  kitSessionsRoot,
  personaValue,
  readAgentType,
  readCwd,
  readKitArgs,
  readKitStorage,
  readResumeId,
  transcriptPath,
  transcriptRoots,
} from "./session.ts";

export const WHAT = ["session", "repo", "skills", "memory", "claude-md", "beads"] as const;
export type What = (typeof WHAT)[number];

/** Harnesses whose agent paw can move: their persona says everything a launch needs. */
export const TELEPORT_AGENTS = ["claude", "kit", "acp"] as const;

export type Transport = { kind: "fly"; app: string; machine?: string } | { kind: "ssh"; host: string };

export type TeleportArgs = {
  name: string;
  space?: string;
  to?: Transport;
  back: boolean;
  /** undefined = no checkmark given (a tty asks; a pipe refuses). */
  what?: What[];
  dryRun: boolean;
  yes: boolean;
};

export const TELEPORT_USAGE =
  "teleport <agent> --to fly:<app>[/<machine>] | ssh:<host>  [--all | --session --repo --skills --memory --claude-md --beads | --no-<one>…] [--dry-run] [--yes]\n" +
  "       teleport <agent> --back [--dry-run] [--yes]";

export function parseTransport(raw: string): Transport {
  const fly = /^fly:([a-z0-9][a-z0-9-]*)(?:\/([0-9a-f]+))?$/.exec(raw);
  if (fly) return { kind: "fly", app: fly[1], ...(fly[2] ? { machine: fly[2] } : {}) };
  const ssh = /^ssh:([^\s-][^\s]*)$/.exec(raw);
  if (ssh) return { kind: "ssh", host: ssh[1] };
  throw new Error(`paw: --to "${raw}" — a target is fly:<app> (fly:<app>/<machine-id> when the app has several machines) or ssh:<host>`);
}

export function transportLabel(t: Transport): string {
  return t.kind === "fly" ? `fly:${t.app}${t.machine ? `/${t.machine}` : ""}` : `ssh:${t.host}`;
}

export function parseTeleportArgs(argv: string[]): TeleportArgs {
  const out: TeleportArgs = { name: "", back: false, dryRun: false, yes: false };
  const what = new Set<What>();
  const without = new Set<What>();
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--to") {
      const v = argv[++i];
      if (v === undefined) throw new Error("paw: --to needs a target (fly:<app> or ssh:<host>)");
      out.to = parseTransport(v);
    } else if (a.startsWith("--to=")) out.to = parseTransport(a.slice("--to=".length));
    else if (a === "--back") out.back = true;
    else if (a === "--all") all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a.startsWith("--") && (WHAT as readonly string[]).includes(a.slice(2))) what.add(a.slice(2) as What);
    else if (a.startsWith("--no-") && (WHAT as readonly string[]).includes(a.slice(5))) without.add(a.slice(5) as What);
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${TELEPORT_USAGE}`);
    else if (!out.name) out.name = a;
    else throw new Error(`paw: unexpected argument "${a}" — teleport moves one agent`);
  }
  if (!out.name) throw new Error(`paw: which agent? — ${TELEPORT_USAGE}`);
  if (!/^[A-Za-z0-9_-]+$/.test(out.name)) throw new Error(`paw: "${out.name}" is not an agent name`);
  if (out.back) {
    if (out.to) throw new Error("paw: --back returns over the transport recorded at teleport time — it takes no --to");
    if (all || what.size || without.size) throw new Error("paw: --back brings back what was sent — it takes no --all/--session/… checkmarks");
    return out;
  }
  if (!out.to) throw new Error(`paw: where to? — ${TELEPORT_USAGE}`);
  if (all && what.size) throw new Error("paw: --all already picks every checkmark — give --all or the ones you want, not both");
  for (const w of without)
    if (what.has(w)) throw new Error(`paw: --${w} and --no-${w} contradict each other`);
  if (without.size && what.size) throw new Error("paw: --no-<one> trims --all (or the whole list) — give checkmarks or --no-<one>s, not both");
  // `--no-repo` alone = everything but the repo, the same as `--all --no-repo`.
  if (all || without.size) out.what = WHAT.filter((w) => !without.has(w));
  else if (what.size) out.what = WHAT.filter((w) => what.has(w));
  return out;
}

// ── the interactive checklist (a pure reducer; src/teleport.ts wires the keys) ─────────────────────

export type Checklist = { cursor: number; on: Record<What, boolean>; done: boolean; cancelled: boolean };

export function newChecklist(): Checklist {
  return { cursor: 0, on: Object.fromEntries(WHAT.map((w) => [w, true])) as Record<What, boolean>, done: false, cancelled: false };
}

/** One keypress: ↑/k ↓/j move, space toggles, a toggles all, enter confirms, q/esc/ctrl-c cancel. */
export function checklistKey(s: Checklist, key: string): Checklist {
  const n = WHAT.length;
  if (key === "\x1b[A" || key === "k") return { ...s, cursor: (s.cursor + n - 1) % n };
  if (key === "\x1b[B" || key === "j") return { ...s, cursor: (s.cursor + 1) % n };
  if (key === " ") return { ...s, on: { ...s.on, [WHAT[s.cursor]]: !s.on[WHAT[s.cursor]] } };
  if (key === "a") {
    const every = WHAT.every((w) => s.on[w]);
    return { ...s, on: Object.fromEntries(WHAT.map((w) => [w, !every])) as Record<What, boolean> };
  }
  if (key === "\r" || key === "\n") return { ...s, done: true };
  if (key === "q" || key === "\x1b" || key === "\x03") return { ...s, cancelled: true };
  return s;
}

export function checklistLines(s: Checklist): string[] {
  return [
    "move what? (↑/↓ move · space toggles · a all · enter go · q cancel)  — the persona always moves",
    ...WHAT.map((w, i) => `${i === s.cursor ? "›" : " "} [${s.on[w] ? "x" : " "}] ${w.padEnd(9)} ${WHAT_HINT[w]}`),
  ];
}

const WHAT_HINT: Record<What, string> = {
  session: "the pinned transcript, the sessions it was continued from, subagents + tool results",
  repo: "same remote, branch and HEAD; unpushed commits as a git bundle",
  skills: "~/.claude/skills/*",
  memory: "~/.claude/projects/<slug>/memory/",
  "claude-md": "~/.claude/CLAUDE.md (never overwrites a different one)",
  beads: "its open beads (assigned to it) into the target's beads db; the copies here close as teleported",
};

// ── the compaction chain ───────────────────────────────────────────────────────────────────────────

/**
 * Claude Code continues a long session in a NEW session id and records the link in the OLD one only: a
 * `{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}` line (the new file carries
 * no pointer back — inspected 2026-10-22 across 516 transcripts). A `/compact` stays in the same file
 * (a `compact_boundary` system line), so it needs nothing here. The chain of `pin` is every session
 * that led to it (walked back through those records, from every transcript in the same project dir)
 * plus every session it was continued in (walked forward), oldest first.
 */
export function sessionChain(projectDir: string, pin: string): string[] {
  const next = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    (next.get(from) ?? next.set(from, new Set()).get(from)!).add(to);
    (prev.get(to) ?? prev.set(to, new Set()).get(to)!).add(from);
  };
  if (existsSync(projectDir))
    for (const f of readdirSync(projectDir)) {
      if (!f.endsWith(".jsonl")) continue;
      for (const r of continuedInRecords(join(projectDir, f))) link(r.sessionId ?? f.slice(0, -".jsonl".length), r.continuedInSessionId);
    }
  const walk = (start: string, edges: Map<string, Set<string>>): string[] => {
    const seen = new Set<string>([start]);
    const order: string[] = [];
    const queue = [start];
    while (queue.length) {
      for (const n of edges.get(queue.shift()!) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        order.push(n);
        queue.push(n);
      }
    }
    return order;
  };
  const before = walk(pin, prev).reverse();
  const after = walk(pin, next).filter((id) => !before.includes(id));
  return [...before, pin, ...after].filter((id) => id === pin || existsSync(join(projectDir, `${id}.jsonl`)));
}

const CONTINUED_IN = Buffer.from('"type":"continued-in"');

/** Every `continued-in` record in one transcript. Streams the file (some are 150 MB+) and parses only
 *  the lines that carry the marker; a marker inside message text is JSON-escaped (`\"type\"`), so the
 *  raw byte pattern only ever matches a real record. */
export function continuedInRecords(file: string): Array<{ sessionId?: string; continuedInSessionId: string }> {
  const out: Array<{ sessionId?: string; continuedInSessionId: string }> = [];
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const lastNl = buf.lastIndexOf(0x0a);
      const whole = lastNl === -1 ? Buffer.alloc(0) : buf.subarray(0, lastNl);
      carry = Buffer.from(lastNl === -1 ? buf : buf.subarray(lastNl + 1));
      if (whole.indexOf(CONTINUED_IN) !== -1) collect(whole.toString("utf8"), out);
    }
    if (carry.indexOf(CONTINUED_IN) !== -1) collect(carry.toString("utf8"), out);
  } finally {
    closeSync(fd);
  }
  return out;
}

function collect(text: string, out: Array<{ sessionId?: string; continuedInSessionId: string }>): void {
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"continued-in"')) continue;
    let rec: { type?: unknown; sessionId?: unknown; continuedInSessionId?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line of a live transcript
    }
    if (rec.type !== "continued-in" || typeof rec.continuedInSessionId !== "string") continue;
    out.push({ ...(typeof rec.sessionId === "string" ? { sessionId: rec.sessionId } : {}), continuedInSessionId: rec.continuedInSessionId });
  }
}

// ── the source manifest ────────────────────────────────────────────────────────────────────────────

export type FileEntry = { rel: string; bytes: number; mtimeMs: number };
export type Group = "session" | "memory" | "skills" | "claude-md";

export type RepoInfo = {
  top: string;
  remote: string;
  url: string;
  /** undefined = detached HEAD. */
  branch?: string;
  head: string;
  /** commits on HEAD that no ref of `remote` has — they travel as a git bundle. */
  unpushed: number;
  /** The agent's folder inside the repo ("" = the top itself). */
  sub: string;
};

export type Manifest = {
  name: string;
  space: string;
  agent: string;
  pin?: string;
  cwd: string;
  /** The persona file's text as it should land on the destination (teleport keys stripped). */
  persona: string;
  home: string;
  groups: Partial<Record<Group, FileEntry[]>>;
  /** Session ids moved, oldest first (the pin's chain), per store. */
  chain: string[];
  /** HOME-relative project dirs (`.claude/projects/<slug>`, kit's `.kit/sessions/<slug>`) the session and
   *  memory files sit in — renamed to the destination folder's slug when the folder moves. */
  projectDirs: string[];
  skills: Array<{ name: string; hash: string }>;
  claudeMdHash?: string;
  /** Enabled Claude Code plugins — listed, not moved (v1). */
  plugins: string[];
  repo?: RepoInfo;
  /** The open beads assigned to it, in this machine's beads db (src/teleport-beads.ts). */
  beads?: BeadsManifest;
  notes: string[];
};

/** Persona keys a teleport writes; they never travel with the persona. */
export const TELEPORT_KEYS = ["teleported", "teleportedAt", "teleportedWhat"] as const;

export function stripTeleportKeys(text: string): string {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("paw: the persona has no frontmatter — not a paw agent file");
  const head = m[1].split("\n").filter((l) => !TELEPORT_KEYS.some((k) => l.trimStart().startsWith(`${k}:`)));
  return `---\n${head.join("\n")}\n---\n${m[2]}`;
}

/** Replace (or add) one frontmatter scalar in persona text. */
export function withPersonaKey(text: string, key: string, value: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("paw: the persona has no frontmatter — not a paw agent file");
  const head = m[1].split("\n").filter((l) => !l.trimStart().startsWith(`${key}:`));
  return `---\n${[...head, `${key}: ${value}`].join("\n")}\n---\n${m[2]}`;
}

/** The marker a teleported-away persona carries: where it went and when (absent ⇒ not teleported). */
export function readTeleported(personaFile: string): { to: string; at?: string; what: What[] } | undefined {
  if (!existsSync(personaFile)) return undefined;
  const to = personaValue(personaFile, "teleported")?.replace(/^["']|["']$/g, "");
  if (!to) return undefined;
  const at = personaValue(personaFile, "teleportedAt")?.replace(/^["']|["']$/g, "") || undefined;
  const raw = personaValue(personaFile, "teleportedWhat")?.replace(/^["']|["']$/g, "") ?? "";
  const what = raw.split(",").map((w) => w.trim()).filter((w): w is What => (WHAT as readonly string[]).includes(w));
  return { to, ...(at ? { at } : {}), what };
}

/** `teleported: origin` marks the copy on a target the agent was brought BACK from. */
export const ORIGIN = "origin";

/** The refusal every wake path (src/addressing.ts ensureAgentSpawned) gives a teleported agent. */
export function teleportedRefusal(name: string, mark: { to: string; at?: string }): string {
  const when = mark.at ? ` at ${mark.at}` : "";
  if (mark.to === ORIGIN)
    return `paw: "${name}" was teleported back to the machine it came from${when} — it runs there now, not here (its persona keeps \`teleported: ${ORIGIN}\`)`;
  return `paw: "${name}" was teleported to ${mark.to}${when} — it runs there now; \`paw teleport ${name} --back\` brings it back here`;
}

/** How many dirty paths a refusal lists before "… and N more". */
export const DIRTY_SHOWN = 10;

type Git = (args: string[], cwd: string) => { ok: boolean; out: string; err: string };
const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // trimEnd: `git status --porcelain` lines START with a status column that may be a space.
  return { ok: r.status === 0, out: (r.stdout ?? "").trimEnd(), err: (r.stderr ?? r.error?.message ?? "").trim() };
};

/**
 * The repo the agent's folder is in, ready to mirror: one remote URL, a branch (or detached HEAD), its
 * HEAD and how many commits only this checkout has. A dirty tree (tracked changes or untracked files)
 * throws with the list: what isn't committed can't move as git, and paw won't copy loose files.
 */
export function repoInfo(cwd: string, git: Git = realGit): RepoInfo {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) throw new Error(`paw: ${cwd} is not in a git repo — --repo mirrors a git checkout (drop --repo, or put the folder in git)`);
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"], top.out);
  if (!dirty.ok) throw new Error(`paw: git status failed in ${top.out}: ${dirty.err}`);
  if (dirty.out) {
    const files = dirty.out.split("\n");
    throw new Error(
      `paw: ${top.out} has ${files.length} uncommitted change(s) — teleport moves commits, never loose files:\n` +
        files.slice(0, DIRTY_SHOWN).map((l) => `  ${l}`).join("\n") +
        (files.length > DIRTY_SHOWN ? `\n  … and ${files.length - DIRTY_SHOWN} more (\`git -C ${top.out} status\`)` : "") +
        `\n  commit or stash them, or teleport without the repo: --no-repo (or leave repo unchecked) — the agent then gets a fresh folder there`,
    );
  }
  const head = git(["rev-parse", "HEAD"], top.out);
  if (!head.ok) throw new Error(`paw: ${top.out} has no commit yet — nothing to check out on the target`);
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"], top.out);
  const upstream = branch.ok ? git(["rev-parse", "--abbrev-ref", `${branch.out}@{upstream}`], top.out) : { ok: false, out: "", err: "" };
  const remotes = git(["remote"], top.out).out.split("\n").filter(Boolean);
  const remote = upstream.ok ? upstream.out.split("/")[0] : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
  if (!remote)
    throw new Error(
      remotes.length
        ? `paw: ${top.out} has remotes ${remotes.join(", ")} and the branch tracks none — set one (\`git branch -u <remote>/<branch>\`), so the target knows what to clone`
        : `paw: ${top.out} has no git remote — the target clones the repo from its remote; push it somewhere first`,
    );
  // Literal, not `git remote get-url` (which expands url.*.insteadOf): the target resolves it with ITS config.
  const url = git(["config", "--get", `remote.${remote}.url`], top.out);
  if (!url.ok) throw new Error(`paw: remote ${remote} in ${top.out} has no url: ${url.err}`);
  const ahead = git(["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`], top.out);
  if (!ahead.ok) throw new Error(`paw: git rev-list failed in ${top.out}: ${ahead.err}`);
  const sub = relative(top.out, realpathSync(cwd));
  return { top: top.out, remote, url: url.out, ...(branch.ok ? { branch: branch.out } : {}), head: head.out, unpushed: Number(ahead.out), sub };
}

/** Every regular file under `abs` (following symlinks), as entries relative to `home`. */
function filesUnder(home: string, abs: string, rel = relative(home, abs)): FileEntry[] {
  const st = statSync(abs);
  if (st.isFile()) return [{ rel, bytes: st.size, mtimeMs: Math.floor(st.mtimeMs) }];
  if (!st.isDirectory()) return [];
  return readdirSync(abs)
    .sort()
    .flatMap((n) => filesUnder(home, join(abs, n), join(rel, n)));
}

function underHome(home: string, abs: string, what: string): void {
  const rel = relative(home, abs);
  if (rel.startsWith("..") || rel.startsWith(sep) || rel === "")
    throw new Error(`paw: ${what} ${abs} is outside HOME (${home}) — teleport lands files at the same path under the target's HOME`);
}

/** Claude Code's project-dir name for a folder: every non-alphanumeric character becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where the agent's folder lands on the destination, and why there. `clone` = the repo's paw clone
 *  there; `worktree` = the per-branch worktree it uses when the clone has another branch checked out. */
export type DestFolder = { cwd: string; top?: string; clone?: string; worktree?: string; how: "agents" | "repo" | "worktree" | "original" };

/** The folder paw owns for an agent that moved without its repo: `<PAW_HOME>/agents/<name>`. */
export function agentsFolder(pawHome: string, name: string): string {
  return join(pawHome, "agents", name);
}

/** owner/repo of a GitHub remote URL (https, git@ or ssh://). Anything else throws: teleport lays a repo
 *  out as paw's github clones are, `<PAW_HOME>/repos/<owner>/<repo>`, and invents no path for others. */
export function githubRepoOf(url: string): { owner: string; repo: string } {
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m)
    throw new Error(
      `paw: --repo puts the repo in the target's paw clones (<PAW_HOME>/repos/<owner>/<repo>), and ${url} is not a GitHub remote — ` +
        `teleport without it (--no-repo), or give the repo a GitHub remote`,
    );
  return { owner: m[1], repo: m[2] };
}

/**
 * The destination folder — never the source's absolute path. Without --repo: `<dest PAW_HOME>/agents/<name>`,
 * which paw creates and treats as its own (src/cwd.ts). With --repo: the repo's paw clone there,
 * `<dest PAW_HOME>/repos/<owner>/<repo>` (src/repo-layout.ts, as `github:` handles), the agent's folder at
 * the same place inside it; {@link placeRepo} moves it to a branch worktree when the clone is on another
 * branch. `--back` passes `original`: the folder it left from.
 */
export function destFolder(m: Manifest, what: What[], dest: { home: string; pawHome: string }, original?: string): DestFolder {
  const repo = what.includes("repo") ? m.repo : undefined;
  if (original !== undefined) {
    const top = repo ? (repo.sub && original.endsWith(`/${repo.sub}`) ? original.slice(0, -repo.sub.length - 1) : original) : undefined;
    return { cwd: original, ...(top ? { top, clone: top } : {}), how: "original" };
  }
  if (!repo) return { cwd: agentsFolder(dest.pawHome, m.name), how: "agents" };
  const gh = githubRepoOf(repo.url);
  const clone = repoDirUnder(dest.pawHome, gh.owner, gh.repo);
  const worktree = repo.branch ? branchWorktreeDir(clone, gh.repo, repo.branch) : `${clone}.worktrees/${gh.repo}-${repo.head.slice(0, 12)}`;
  return { cwd: repo.sub ? join(clone, repo.sub) : clone, top: clone, clone, worktree, how: "repo" };
}

/**
 * Settle where the repo goes, from what the probe saw there. A fresh target clones; a clone already on the
 * agent's branch is reused if nothing else is in the way; a clone on ANOTHER branch is left alone and the
 * agent gets a worktree beside it (`<clone>.worktrees/<repo>-<branch>`, the layout `github.com/…/tree/…`
 * addressing uses). Refused: a non-repo or another remote at that path, uncommitted changes in the folder
 * it would use, another agent running in a clone this would move, a branch checked out in a third worktree.
 */
export function placeRepo(m: Manifest, what: What[], folder: DestFolder, d: DestFacts): { folder: DestFolder; blockers: string[] } {
  const R = what.includes("repo") ? m.repo : undefined;
  const r = d.repo;
  if (!R || folder.how === "agents" || !r?.exists) return { folder, blockers: [] };
  const there = d.label;
  const at = folder.clone!;
  const out: string[] = [];
  const dirtyList = (fs: string[]) => fs.slice(0, DIRTY_SHOWN).map((l) => `    ${l}`).join("\n") + (fs.length > DIRTY_SHOWN ? `\n    … and ${fs.length - DIRTY_SHOWN} more` : "");
  if (r.isRepo === false) return { folder, blockers: [`${at} exists on ${there} and is not a git repo — move it aside there first`] };
  if (r.url !== undefined && r.url !== R.url) return { folder, blockers: [`${at} on ${there} is a clone of ${r.url}, not ${R.url} — move it aside there first`] };
  const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  const others = (dir: string) => d.agentCwds.filter((a) => a.who !== `${m.space}/${m.name}` && inside(a.cwd, dir)).map((a) => a.who);
  const sameCheckout = R.branch ? r.branch === R.branch : r.branch === undefined && r.head === R.head;
  if (folder.how === "original" || sameCheckout) {
    if (r.dirty?.length) out.push(`${at} on ${there} has uncommitted changes — they would be in the way:\n${dirtyList(r.dirty)}`);
    const busy = others(at);
    if (busy.length && r.head !== R.head)
      out.push(`${busy.join(", ")} run${busy.length === 1 ? "s" : ""} in ${at} on ${there}; moving its checkout to ${R.head.slice(0, 12)} would change their files — stop or move ${busy.length === 1 ? "it" : "them"} first`);
    return { folder, blockers: out };
  }
  const top = folder.worktree!;
  const held = R.branch ? r.worktrees.find((w) => w.branch === R.branch && w.path !== top) : undefined;
  if (held) out.push(`branch ${R.branch} is checked out at ${held.path} on ${there} — git keeps a branch in one worktree; free it there first`);
  if (r.wt?.exists && r.wt.dirty.length) out.push(`${top} on ${there} has uncommitted changes — they would be in the way:\n${dirtyList(r.wt.dirty)}`);
  const busy = others(top);
  if (r.wt?.exists && busy.length) out.push(`${busy.join(", ")} already run${busy.length === 1 ? "s" : ""} in ${top} on ${there} — stop or move ${busy.length === 1 ? "it" : "them"} first`);
  return { folder: { ...folder, top, cwd: R.sub ? join(top, R.sub) : top, how: "worktree" }, blockers: out };
}

/** A moved file's HOME-relative path on the destination: session and memory files follow the folder
 *  into ITS project dir (the slug of the new cwd); everything else keeps its path. */
export function remapRel(rel: string, m: Pick<Manifest, "projectDirs">, destCwd: string): string {
  for (const pd of m.projectDirs)
    if (rel.startsWith(`${pd}/`)) return join(dirname(pd), projectSlug(destCwd), rel.slice(pd.length + 1));
  return rel;
}

/** The transcripts (`.jsonl`) of a set of moved session files — the ones whose `cwd` fields follow the folder. */
export function transcriptRels(files: FileEntry[], m: Pick<Manifest, "groups">): string[] {
  const session = new Set((m.groups.session ?? []).map((f) => f.rel));
  return files.filter((f) => session.has(f.rel) && f.rel.endsWith(".jsonl")).map((f) => f.rel);
}

/**
 * Rewrite the `cwd` field of every line of a Claude Code transcript from `from` (or a folder under it) to
 * the same place under `to`. The ONE field rewritten: claude finds a session by id in any project dir and
 * stamps each new line with its own cwd (claude 2.1.309, checked 2026-10-23), so nothing else needs it —
 * this keeps one folder per transcript, matching the project dir it now lives in. Byte-exact elsewhere;
 * idempotent (a value already under `to` is left alone). Returns the number of lines changed.
 */
export function rewriteCwdText(text: string, from: string, to: string): { text: string; changed: number } {
  let changed = 0;
  const out = text.replace(/"cwd":("(?:[^"\\]|\\.)*")/g, (all, lit: string) => {
    const v = JSON.parse(lit) as string;
    if (v === to || v.startsWith(`${to}/`)) return all;
    if (v !== from && !v.startsWith(`${from}/`)) return all;
    changed++;
    return `"cwd":${JSON.stringify(to + v.slice(from.length))}`;
  });
  return { text: out, changed };
}

/** {@link rewriteCwdText} over HOME-relative transcript files, each written back atomically when it changed. */
export function rewriteCwdFiles(home: string, rels: string[], from: string, to: string): number {
  let total = 0;
  for (const rel of rels) {
    const file = join(home, rel);
    const r = rewriteCwdText(readFileSync(file, "utf8"), from, to);
    if (!r.changed) continue;
    const tmp = `${file}.teleport-${process.pid}`;
    writeFileSync(tmp, r.text);
    renameSync(tmp, file);
    total += r.changed;
  }
  return total;
}

/** sha256 of a file or a directory tree — the same recipe as the probe script's `paw_hash`, so a hash
 *  computed here compares with one computed on the target. */
export function contentHash(abs: string): string {
  const r = spawnSync("sh", ["-c", `${HASH_SH}\npaw_hash "$1"`, "sh", abs], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`paw: could not hash ${abs}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.trim();
}

/** POSIX sh: `paw_hash <path>` prints one sha256 for a file, or for a tree (each file's hash + its
 *  relative path, sorted bytewise, hashed again). Shared by the source (local) and the probe (target). */
export const HASH_SH = `paw_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
paw_hash() { if [ -d "$1" ]; then (cd "$1" && find -L . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\\n' "$(paw_sha < "$f")" "$f"; done) | paw_sha; else paw_sha < "$1"; fi; }`;

export type ManifestDeps = { home?: string; git?: Git; hash?: (abs: string) => string; env?: NodeJS.ProcessEnv };

/**
 * Everything that moves for `what`, read from THIS machine (the source side; on `--back` the target's
 * paw runs this same function). The persona file always moves. Throws on what can't move at all.
 */
export function buildManifest(o: { space: string; name: string; personaFile: string; what: What[] }, deps: ManifestDeps = {}): Manifest {
  // Real path: the repo top git reports is one, and the HOME-relative mirror compares the two.
  const home = realpathSync(deps.home ?? homedir());
  const hash = deps.hash ?? contentHash;
  const { space, name, personaFile, what } = o;
  if (!existsSync(personaFile)) throw new Error(`paw: no agent "${name}" in space "${space}" (no persona at ${personaFile})`);
  const cwd = readCwd(personaFile);
  if (!cwd) throw new Error(`paw: "${name}" has no folder (\`cwd:\` in ${personaFile}) — an orphan persona has nothing to run in`);
  const agentType = readAgentType(personaFile);
  const agent = isClaudeHarness(agentType) ? "claude" : agentType!;
  if (!(TELEPORT_AGENTS as readonly string[]).includes(agent))
    throw new Error(`paw: "${name}" runs on ${agent} — teleport v1 moves claude, kit and acp agents (their login and state paw can name)`);
  const pin = readResumeId(personaFile);
  const notes: string[] = [];
  const groups: Manifest["groups"] = {};
  let chain: string[] = [];
  const projectDirs: string[] = [];
  const claudeDir = join(home, ".claude");

  if (what.includes("session")) {
    if (agent === "acp") throw new Error(`paw: "${name}" is an acp agent — its session lives inside the ACP agent, which paw can't name; teleport it without --session`);
    if (!pin) throw new Error(`paw: "${name}" has no \`resume:\` pin — no session to move; teleport it without --session`);
    const roots = agent === "kit" ? transcriptRoots("kit", readKitStorage(personaFile)) : transcriptRoots(agent);
    const files: FileEntry[] = [];
    for (const root of roots) {
      const at = transcriptPath(pin, [root]);
      if (!at) continue;
      underHome(home, root, "the transcript store");
      const dir = dirname(at);
      if (!projectDirs.includes(relative(home, dir))) projectDirs.push(relative(home, dir));
      const ids = sessionChain(dir, pin);
      for (const id of ids) {
        files.push(...filesUnder(home, join(dir, `${id}.jsonl`)));
        if (existsSync(join(dir, id))) files.push(...filesUnder(home, join(dir, id)));
        const history = join(claudeDir, "file-history", id);
        if (root === claudeProjectsRoot() && existsSync(history)) files.push(...filesUnder(home, history));
      }
      for (const id of ids) if (!chain.includes(id)) chain.push(id);
    }
    if (!files.length)
      notes.push(`no transcript at resume: ${pin} yet — the target starts that session fresh`);
    if (chain.length > 1) notes.push(`session chain ${chain.join(" → ")} (continued-in links)`);
    groups.session = files;
  }

  if (what.includes("memory")) {
    const slug = pin ? (transcriptPath(pin) ? basename(dirname(transcriptPath(pin)!)) : projectSlug(cwd)) : projectSlug(cwd);
    const dir = join(claudeProjectsRoot(), slug, "memory");
    if (!projectDirs.includes(relative(home, dirname(dir)))) projectDirs.push(relative(home, dirname(dir)));
    groups.memory = existsSync(dir) ? filesUnder(home, dir) : [];
    if (!groups.memory.length) notes.push(`no memory dir at ${dir}`);
  }

  const skills: Manifest["skills"] = [];
  if (what.includes("skills")) {
    const dir = join(claudeDir, "skills");
    const files: FileEntry[] = [];
    for (const n of existsSync(dir) ? readdirSync(dir).sort() : []) {
      if (n.startsWith(".")) continue;
      const abs = join(dir, n);
      let st;
      try {
        st = statSync(abs);
      } catch {
        notes.push(`skill ${n}: a dangling link at ${abs} — not moved`);
        continue;
      }
      if (!st.isDirectory()) continue;
      skills.push({ name: n, hash: hash(abs) });
      files.push(...filesUnder(home, abs, join(".claude", "skills", n)));
    }
    groups.skills = files;
  }

  let claudeMdHash: string | undefined;
  if (what.includes("claude-md")) {
    const file = join(claudeDir, "CLAUDE.md");
    if (existsSync(file)) {
      claudeMdHash = hash(file);
      groups["claude-md"] = filesUnder(home, file, join(".claude", "CLAUDE.md"));
    } else notes.push("no ~/.claude/CLAUDE.md here — nothing to move");
  }

  const plugins = what.includes("skills") ? enabledPlugins(claudeDir) : [];
  const repo = what.includes("repo") ? repoInfo(cwd, deps.git) : undefined;
  const beads = what.includes("beads") ? beadsHere(name) : undefined;
  if (agent === "kit") {
    const kitRoot = kitSessionsRoot(deps.env);
    if (what.includes("session")) underHome(home, kitRoot, "kit's session store");
    if (readKitArgs(personaFile).some((a) => a.startsWith("/"))) notes.push("kitArgs name absolute paths — they must exist on the target too");
  }
  return {
    name,
    space,
    agent,
    ...(pin ? { pin } : {}),
    cwd,
    persona: stripTeleportKeys(readFileSync(personaFile, "utf8")),
    home,
    groups,
    chain,
    projectDirs,
    skills,
    ...(claudeMdHash ? { claudeMdHash } : {}),
    plugins,
    ...(repo ? { repo } : {}),
    ...(beads ? { beads } : {}),
    notes,
  };
}

function enabledPlugins(claudeDir: string): string[] {
  const file = join(claudeDir, "settings.json");
  if (!existsSync(file)) return [];
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { enabledPlugins?: Record<string, unknown> };
    return Object.entries(s.enabledPlugins ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort();
  } catch (e) {
    throw new Error(`paw: ${file} is not valid JSON (${(e as Error).message}) — can't list the enabled plugins`);
  }
}

/** Every file entry the manifest moves, across its groups. */
export function manifestFiles(m: Manifest): FileEntry[] {
  return Object.values(m.groups).flat();
}

/** What actually crosses: every moved file, minus a CLAUDE.md or skill already there byte for byte (a
 *  different one is a blocker, never an overwrite). */
export function filesToSend(m: Manifest, dest: Pick<DestFacts, "claudeMdHash" | "skillHashes">): FileEntry[] {
  const same = new Set(m.skills.filter((s) => dest.skillHashes[s.name] === s.hash).map((s) => `.claude/skills/${s.name}/`));
  return Object.entries(m.groups).flatMap(([group, fs]) => {
    if (group === "claude-md" && m.claudeMdHash && dest.claudeMdHash === m.claudeMdHash) return [];
    if (group === "skills") return fs.filter((f) => ![...same].some((p) => f.rel.startsWith(p)));
    return fs;
  });
}

/** The entries of `after` that are new or changed since `before` — the final pass after the stop. */
export function changedSince(before: FileEntry[], after: FileEntry[]): FileEntry[] {
  const was = new Map(before.map((f) => [f.rel, f]));
  return after.filter((f) => {
    const b = was.get(f.rel);
    return !b || b.bytes !== f.bytes || b.mtimeMs !== f.mtimeMs;
  });
}

// ── the destination facts (what the probe script reports) and the blockers ─────────────────────────

export type DestFacts = {
  /** "this Mac" / "fly:2027-agents" — for messages. */
  label: string;
  home: string;
  pawHome: string;
  paw?: string;
  /** `paw __teleport probe` answered (the target's paw can honour the teleported marker and --back). */
  teleportSupport: boolean;
  pawRoot?: string;
  allowAnyCwd: boolean;
  spaceRecord?: { server: string };
  personaText?: string;
  claudeLogin?: { loggedIn: boolean; raw: string };
  kitAuth?: string[];
  acpCommand?: { path: string; executable: boolean };
  git?: string;
  repo?: {
    exists: boolean;
    isRepo?: boolean;
    url?: string;
    /** The clone's checked-out branch (undefined = detached) and HEAD. */
    branch?: string;
    head?: string;
    dirty?: string[];
    /** Every worktree of the clone and its branch. */
    worktrees: Array<{ path: string; branch?: string }>;
    /** The per-branch worktree teleport would use. */
    wt?: { exists: boolean; dirty: string[] };
    lsRemote?: { ok: boolean; err: string };
  };
  /** Every agent there (`space/name`) and its folder — who a moved checkout would disturb. */
  agentCwds: Array<{ who: string; cwd: string }>;
  cwdExists: boolean;
  /** Mount point of the nearest existing parent of the repo/cwd path (`df -P`). */
  cwdMount?: string;
  claudeMdHash?: string;
  skillHashes: Record<string, string>;
  freeKb?: number;
  /** Its beads db — probed apart from the rest (src/teleport-beads.ts), only for --beads. */
  beads?: BeadsSide;
};

export type PlanCtx = { what: What[]; dest: DestFacts; folder: DestFolder; transport?: Transport; sourceServer?: string; back: boolean };

/** What stops this teleport, each with the fix. Empty ⇒ go. Pure; check:teleport covers it. */
export function teleportBlockers(m: Manifest, c: PlanCtx): string[] {
  const d = c.dest;
  const out: string[] = [];
  const there = d.label;
  if (!d.paw) out.push(`${there} has no \`paw\` on PATH — install paw there first`);
  else if (!d.teleportSupport)
    out.push(`${there}'s paw predates this \`paw teleport\` (paw-teleport 2) — it would not honour the marker, take a moved folder, or serve --back; update paw there (agents-host: redeploy)`);
  if (!d.spaceRecord && !c.back)
    out.push(`${there}'s paw does not join space "${m.space}" (no ${d.pawHome}/spaces/${m.space}/remote-mesh.json) — \`paw mesh add ${m.space} --server … --root …\` there`);
  if (d.personaText !== undefined && !/^\s*teleported:/m.test(d.personaText.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""))
    out.push(`${there} already has an agent "${m.name}" (${d.pawHome}/spaces/${m.space}/personas/${m.name}.md, not a teleported copy) — rename one of them first`);
  if (m.agent === "claude" && d.claudeLogin && !d.claudeLogin.loggedIn)
    out.push(`claude is not logged in on ${there} — run \`claude auth login\` there (paw never copies logins)`);
  if (m.agent === "claude" && !d.claudeLogin) out.push(`${there} has no \`claude\` on PATH`);
  if (m.agent === "kit") {
    const need = kitProvider(m.persona);
    const lines = d.kitAuth ?? [];
    if (!d.kitAuth) out.push(`${there} has no \`kit\` on PATH`);
    else {
      const ok = (p: string) => lines.some((l) => l.startsWith(`${p} `) && !/no login/.test(l));
      if (need && !ok(need)) out.push(`kit has no ${need} login on ${there} — run \`kit auth ${need}\` there (paw never copies logins)`);
      if (!need && !lines.some((l) => !/no login/.test(l) && /^\w+ \(/.test(l)))
        out.push(`kit has no login at all on ${there} — run \`kit auth codex\` or \`kit auth grok\` there`);
    }
  }
  if (m.agent === "acp" && d.acpCommand && !d.acpCommand.executable)
    out.push(`the acp agent's command ${d.acpCommand.path} is not an executable on ${there} — install it at that path`);

  const folder = c.folder.top ?? c.folder.cwd;
  // `<PAW_HOME>/agents/<name>` is paw-managed (src/cwd.ts), allowed under any PAW_ROOT.
  // Under `<PAW_HOME>/agents` and `<PAW_HOME>/repos` a folder is paw-managed (src/cwd.ts), allowed under any PAW_ROOT.
  if (c.folder.how === "original" && d.pawRoot !== undefined && !d.allowAnyCwd && !insideDir(d.pawRoot, c.folder.cwd))
    out.push(
      `${there} confines agents to PAW_ROOT=${d.pawRoot}, and the folder ${c.folder.cwd} is outside it — ` +
        `set PAW_ROOT to a parent of it (or PAW_ALLOW_ANY_CWD=1) in the environment paw runs with there`,
    );
  if (c.transport?.kind === "fly" && d.cwdMount === "/")
    out.push(
      `${folder} would land on ${there}'s root filesystem, which Fly resets on every deploy — ` +
        `mount a volume at (or bind-mount one onto) a parent of it first, e.g. /Users from /data`,
    );
  if (c.what.includes("repo") && m.repo) {
    const r = d.repo;
    if (!d.git) out.push(`${there} has no \`git\``);
    if (r?.lsRemote && !r.lsRemote.ok)
      out.push(
        `${there} can't read ${m.repo.url}: ${r.lsRemote.err.split("\n")[0] || "git ls-remote failed"}` +
          gitLoginHint(m.repo.url),
      );
  } else if (c.folder.how === "original" && !d.cwdExists) out.push(`${c.folder.cwd}, the folder it left from, is gone on ${there} — recreate it first`);

  if (c.what.includes("claude-md") && m.claudeMdHash && d.claudeMdHash && d.claudeMdHash !== m.claudeMdHash)
    out.push(`${there} has a different ~/.claude/CLAUDE.md — teleport never overwrites it; reconcile the two by hand, or drop --claude-md`);
  if (c.what.includes("skills"))
    for (const s of m.skills)
      if (d.skillHashes[s.name] && d.skillHashes[s.name] !== s.hash)
        out.push(`${there} has a different skill "${s.name}" (~/.claude/skills/${s.name}) — teleport never overwrites it; reconcile it by hand, or drop --skills`);
  if (c.what.includes("beads")) {
    if (!m.beads) out.push(`the source's paw read no beads for --beads — it predates teleporting beads; update paw there, or --no-beads`);
    else out.push(...beadsBlockers(m.beads, d.beads, there));
  }
  const bytes = manifestFiles(m).reduce((n, f) => n + f.bytes, 0);
  if (d.freeKb !== undefined && d.freeKb * 1024 < bytes * 1.1) out.push(`${there} has ${fmtBytes(d.freeKb * 1024)} free under ${d.home}, and this moves ${fmtBytes(bytes)}`);
  return out;
}

/** How the target gets read access to a remote — paw never copies the login itself. */
export function gitLoginHint(url: string): string {
  if (/^https:\/\/github\.com\//.test(url)) return " — run `gh auth login && gh auth setup-git` there (paw never copies logins)";
  if (/^(ssh:\/\/)?[\w.-]+@/.test(url)) return " — an ssh remote needs a key the target may use (or an https remote + `gh auth setup-git` there); paw never copies keys";
  return " — give the target read access to it (paw never copies logins)";
}

function insideDir(root: string, p: string): boolean {
  const r = root.endsWith("/") ? root : `${root}/`;
  return p === root || p.startsWith(r);
}

/** The kit provider this persona runs on, when it says so (persona `provider:`, kit `-P`, or `-m provider/model`). */
export function kitProvider(persona: string): string | undefined {
  const fm = persona.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const scalar = (k: string) => fm.split("\n").find((l) => l.trimStart().startsWith(`${k}:`))?.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
  const p = scalar("provider");
  if (p) return p;
  const raw = scalar("kitArgs");
  const args: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-P" || args[i] === "--provider") return args[i + 1];
    if (args[i].startsWith("--provider=")) return args[i].slice("--provider=".length);
    const model = args[i] === "-m" || args[i] === "--model" ? args[i + 1] : args[i].startsWith("--model=") ? args[i].slice(8) : undefined;
    if (model?.includes("/")) return model.split("/")[0];
  }
  return undefined;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Where the source's beads say the agent went: the transport, or `origin` on --back. */
export function beadsMarkTo(c: Pick<PlanCtx, "back" | "transport" | "dest">): string {
  if (c.back) return ORIGIN;
  if (!c.transport) throw new Error(`paw: a forward teleport to ${c.dest.label} has no transport — can't name where its beads went`);
  return transportLabel(c.transport);
}

/** The plan, as printed before anything is copied. */
export function formatPlan(m: Manifest, c: PlanCtx & { from: string }): string[] {
  const sum = (fs: FileEntry[] = []) => `${fs.length} file${fs.length === 1 ? "" : "s"}, ${fmtBytes(fs.reduce((n, f) => n + f.bytes, 0))}`;
  const lines = [`teleport ${m.name} (${m.agent}, space ${m.space}): ${c.from} → ${c.dest.label}`];
  lines.push(`  persona    ${m.space}/personas/${m.name}.md → ${c.dest.pawHome}/spaces/${m.space}/personas/${m.name}.md` + (m.pin ? `  (resume: ${m.pin})` : ""));
  const f = c.folder;
  const why = {
    repo: "the repo's paw clone there",
    worktree: `a worktree beside the repo's paw clone there (${f.clone} has ${c.dest.repo?.branch ?? "a detached HEAD"} checked out)`,
    agents: `no --repo: a fresh folder paw owns there — nothing in ${m.cwd} moves`,
    original: "back where it came from",
  }[f.how];
  lines.push(`  folder     ${m.cwd} → ${f.cwd}  (${why})`);
  const moved = f.cwd !== m.cwd;
  const destProject = (pd: string) => `${c.dest.home}/${join(dirname(pd), projectSlug(f.cwd))}/`;
  const projects = moved && m.projectDirs.length ? `  → ${destProject(m.projectDirs[0])}, cwd fields rewritten` : "";
  const skip = (w: What) => !c.what.includes(w) && lines.push(`  ${w.padEnd(10)} — not moved`);
  if (c.what.includes("session")) lines.push(`  session    ${m.chain.length ? m.chain.join(" → ") : "(none yet)"}  ${sum(m.groups.session)}${m.groups.session?.length ? projects : ""}`);
  else skip("session");
  if (c.what.includes("repo") && m.repo) {
    const r = m.repo;
    const state =
      f.how === "worktree"
        ? `${c.dest.repo?.wt?.exists ? "update the worktree" : "add a worktree"} ${f.top} of ${f.clone}`
        : c.dest.repo?.exists
          ? `update the checkout at ${f.top}`
          : `clone into ${f.top}`;
    lines.push(`  repo       ${r.url} ${r.branch ?? "(detached)"} @ ${r.head.slice(0, 12)} — ${state}` + (r.unpushed ? `; ${r.unpushed} unpushed commit(s) as a git bundle` : ""));
    lines.push(`             .gitignored files (.env, node_modules, …) do not move`);
  } else skip("repo");
  if (c.what.includes("memory"))
    lines.push(`  memory     ${sum(m.groups.memory)}${moved && m.groups.memory?.length ? `  → ${destProject(m.groups.memory[0].rel.slice(0, m.groups.memory[0].rel.indexOf("/memory/")))}memory/` : ""}`);
  else skip("memory");
  if (c.what.includes("skills")) {
    const same = m.skills.filter((s) => c.dest.skillHashes[s.name] === s.hash).map((s) => s.name);
    const names = m.skills.map((s) => s.name);
    const shown = names.length > 10 ? `${names.slice(0, 10).join(", ")}, … +${names.length - 10} more` : names.join(", ") || "(none)";
    lines.push(`  skills     ${m.skills.length} skill(s): ${shown}  ${sum(m.groups.skills)}` + (same.length ? `  (${same.length} already there, identical)` : ""));
    if (m.plugins.length) lines.push(`             plugins NOT moved (v1): ${m.plugins.join(", ")}`);
  } else skip("skills");
  if (c.what.includes("claude-md"))
    lines.push(`  claude-md  ${m.claudeMdHash ? (c.dest.claudeMdHash === m.claudeMdHash ? "identical there — skipped" : sum(m.groups["claude-md"])) : "(none here)"}`);
  else skip("claude-md");
  if (c.what.includes("beads") && m.beads) lines.push(...beadsPlanLines(m.beads, m.name, c.dest.beads, c.dest.label, beadsMarkTo(c)));
  else skip("beads");
  lines.push(`  logins     never copied — checked on ${c.dest.label}`);
  if (c.sourceServer && c.dest.spaceRecord && c.dest.spaceRecord.server !== c.sourceServer)
    lines.push(`  mesh       ${m.space} is ${c.sourceServer} here and ${c.dest.spaceRecord.server} there — the presence wait proves it is one broker`);
  for (const n of m.notes) lines.push(`  note       ${n}`);
  return lines;
}
