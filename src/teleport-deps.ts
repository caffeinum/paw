/**
 * `paw teleport` host-dependency preflight (docs/notes/teleport.md#what-it-needs-there) — what the agent
 * actually uses on this machine, from evidence only, checked on the target:
 *
 *  - commands: the binaries its Bash tool calls ran (every `tool_use` named Bash in its session chain's
 *    transcripts), kept only when they resolve here (`command -v`) — a typo or a failed call is no evidence;
 *  - files: `~/…` / `$HOME/…` / `<HOME>/…` paths outside its folder that its own files name (the folder's
 *    tree when it moves as a folder, else the repo's tracked files in it), kept only when they exist here;
 *  - plugins: the Claude Code plugins enabled here (`~/.claude/settings.json` enabledPlugins).
 *
 * Missing ones are WARNINGS in the plan (the agent can still run; it will fail where it uses them). The
 * secret files among them — `.env*`, `secret*`, `*.key`, mode 0600 — and the gitignored files in its repo
 * folder that its files name (`.env.prod`) never move unless `--env` is checked; their names are listed,
 * their contents never read here beyond a hash.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { secretLooking } from "./teleport-folder.ts";

/** One secret-ish file `--env` would move. `there` = where it lands: `~/rel` (same HOME-relative path) or
 *  `@/rel` (the same place inside the agent's folder there). */
export type EnvFile = { src: string; there: string; bytes: number; hash: string };

export type HostDeps = {
  commands: string[];
  /** HOME-relative paths (no `~/`). */
  files: string[];
  plugins: string[];
  env: EnvFile[];
  /** Its files that name its own folder by absolute path (they keep pointing at the old place). */
  selfRefs: string[];
};

const KEYWORDS = new Set(
  "if then else elif fi for in do done while until case esac function select time coproc ! { } [[ ]] [ test cd echo printf export unset set source . eval exec exit return true false read local declare typeset shift trap wait alias unalias type command builtin hash pwd pushd popd dirs let readonly ulimit umask jobs fg bg kill disown sudo env nohup nice timeout xargs then : sleep".split(" "),
);

/** The commands a shell command line runs: the first word of each simple command, past `VAR=…`
 *  assignments and wrappers (`sudo`, `env`, `timeout 5`, …), outside quotes and heredoc bodies. */
export function commandWords(cmd: string): string[] {
  const body = cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "");
  const segs: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let quote: string | undefined;
  const endTok = () => {
    if (tok) cur.push(tok);
    tok = "";
  };
  const endSeg = () => {
    endTok();
    if (cur.length) segs.push(cur);
    cur = [];
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"') i++;
      continue; // quoted text is an argument, never a command
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tok += "\0"; // a quoted word: never a command name
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "#" && !tok) {
      while (i < body.length && body[i] !== "\n") i++;
      endSeg();
      continue;
    }
    if (";&|\n()`".includes(ch) || (ch === "$" && body[i + 1] === "(")) {
      if (ch === "$") i++;
      endSeg();
      continue;
    }
    if (ch === " " || ch === "\t") endTok();
    else tok += ch;
  }
  endSeg();
  const out: string[] = [];
  for (const s of segs) {
    let i = 0;
    while (i < s.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i])) i++;
    while (i < s.length && ["sudo", "env", "nohup", "exec", "command", "builtin", "time", "nice", "timeout", "xargs"].includes(s[i])) {
      i++;
      while (i < s.length && (s[i].startsWith("-") || /^\d+[smhd]?$/.test(s[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i]))) i++;
    }
    const w = s[i];
    if (!w || w.includes("\0") || KEYWORDS.has(w)) continue;
    if (/^(\/|~\/)[A-Za-z0-9._\/+-]+$/.test(w) || /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(w)) out.push(w);
  }
  return out;
}

const BASH = Buffer.from('"name":"Bash"');

/** Every Bash `command` its transcripts' assistant turns ran (streamed; only lines naming Bash parsed). */
export function bashCommands(transcripts: string[]): string[] {
  const out: string[] = [];
  for (const file of transcripts) {
    if (!existsSync(file)) continue;
    const fd = openSync(file, "r");
    try {
      const chunk = Buffer.alloc(1 << 20);
      let carry = Buffer.alloc(0);
      const take = (buf: Buffer) => {
        if (buf.indexOf(BASH) === -1) return;
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line.includes('"name":"Bash"')) continue;
          let rec: { type?: string; message?: { content?: unknown } };
          try {
            rec = JSON.parse(line);
          } catch {
            continue; // a torn last line of a live transcript
          }
          if (rec.type !== "assistant" || !Array.isArray(rec.message?.content)) continue;
          for (const c of rec.message!.content as Array<{ type?: string; name?: string; input?: { command?: unknown } }>)
            if (c.type === "tool_use" && c.name === "Bash" && typeof c.input?.command === "string") out.push(c.input.command);
        }
      };
      for (;;) {
        const n = readSync(fd, chunk, 0, chunk.length, null);
        if (n === 0) break;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        const nl = buf.lastIndexOf(0x0a);
        take(nl === -1 ? Buffer.alloc(0) : buf.subarray(0, nl));
        carry = Buffer.from(nl === -1 ? buf : buf.subarray(nl + 1));
      }
      take(carry);
    } finally {
      closeSync(fd);
    }
  }
  return out;
}

/** HOME-relative paths a text names: `~/x`, `$HOME/x`, `${HOME}/x`, or `<home>/x`. */
export function homeRefs(text: string, home: string): string[] {
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|${esc})((?:/[A-Za-z0-9._@%+=,-]+)+)`, "g");
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const rel = m[1].slice(1).replace(/[.,:]+$/, "");
    if (rel) out.add(rel);
  }
  return [...out];
}

const MAX_FILE = 1 << 20;
const MAX_FILES = 20_000;

function textOf(abs: string): string | undefined {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size > MAX_FILE) return undefined;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return undefined; // binary
  return buf.toString("utf8");
}

type Git = (args: string[], cwd: string) => { ok: boolean; out: string };
const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trimEnd() };
};

/** Which of `names` resolve here (`command -v` in sh) — the evidence filter for commands. */
export function resolvableHere(names: string[]): Set<string> {
  if (!names.length) return new Set();
  const r = spawnSync("sh", ["-c", 'for c in "$@"; do case "$c" in "~/"*) c="$HOME/${c#\\~/}";; esac; command -v "$c" >/dev/null 2>&1 && printf "%s\\n" "$c"; done', "sh", ...names], { encoding: "utf8" });
  const found = new Set((r.stdout ?? "").split("\n").filter(Boolean));
  return new Set(names.filter((n) => found.has(n.startsWith("~/") ? `${process.env.HOME}/${n.slice(2)}` : n)));
}

/**
 * The evidence, read on THIS machine. `files` = the agent's own files to read references from (absolute);
 * `repoTop` set = its folder is in that git repo (gitignored files there that its files name are --env
 * candidates).
 */
export function hostDeps(o: {
  home: string;
  cwd: string;
  transcripts: string[];
  files: string[];
  repoTop?: string;
  plugins: string[];
  resolve?: (names: string[]) => Set<string>;
  git?: Git;
}): HostDeps {
  const { home, cwd } = o;
  const words = new Set<string>();
  for (const c of bashCommands(o.transcripts)) for (const w of commandWords(c)) words.add(w);
  const here = (o.resolve ?? resolvableHere)([...words].sort());
  const commands = [...words].filter((w) => here.has(w)).sort();

  const cwdRel = relative(home, cwd);
  const inside = (rel: string) => rel === cwdRel || rel.startsWith(`${cwdRel}/`);
  const files = new Set<string>();
  const selfRefs: string[] = [];
  const texts: Array<{ abs: string; text: string }> = [];
  for (const abs of o.files.slice(0, MAX_FILES)) {
    const text = textOf(abs);
    if (text === undefined) continue;
    texts.push({ abs, text });
    if (text.includes(cwd)) selfRefs.push(relative(cwd, abs));
    for (const rel of homeRefs(text, home)) if (!inside(rel) && existsSync(join(home, rel))) files.add(rel);
  }
  const env: EnvFile[] = [];
  for (const rel of [...files].sort()) {
    const st = statSync(join(home, rel));
    if (st.isFile() && secretLooking(rel, st.mode & 0o7777)) env.push({ src: join(home, rel), there: `~/${rel}`, bytes: st.size, hash: fileHash(join(home, rel)) });
  }
  if (o.repoTop) {
    const git = o.git ?? realGit;
    const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "."], cwd);
    for (const rel of ignored.ok ? ignored.out.split("\n").filter((l) => l && !l.endsWith("/")) : []) {
      const name = basename(rel);
      if (!texts.some((t) => t.text.includes(name))) continue;
      const abs = join(cwd, rel);
      const st = statSync(abs);
      if (st.isFile()) env.push({ src: abs, there: `@/${rel}`, bytes: st.size, hash: fileHash(abs) });
    }
  }
  return { commands, files: [...files].sort().filter((f) => !env.some((e) => e.there === `~/${f}`)), plugins: o.plugins, env, selfRefs: selfRefs.sort() };
}

/** The repo's tracked files inside `cwd` (absolute) — what a git agent's references are read from. */
export function trackedFiles(cwd: string, git: Git = realGit): string[] {
  const r = git(["ls-files", "-z", "."], cwd);
  return r.ok ? r.out.split("\0").filter(Boolean).map((f) => join(cwd, f)) : [];
}

// ── on the target ──────────────────────────────────────────────────────────────────────────────────

/** Where an --env file lands on a destination whose agent folder is `destCwd`. */
export function envDest(e: EnvFile, destCwd: string): string {
  return e.there.startsWith("@/") ? join(destCwd, e.there.slice(2)) : `$HOME/${e.there.slice(2)}`;
}

/** POSIX sh (inside the probe; `out`, `b64` and `paw_hash` defined): what of `d` is missing there. */
export function depsProbeScript(d: HostDeps, destCwd: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const envLines = d.env.map((e, i) => `${i} ${envDest(e, destCwd)}`).join("\n");
  return `DCMDS=${q(d.commands.join("\n"))}
DFILES=${q(d.files.join("\n"))}
DENV=${q(envLines)}
printf '%s\\n' "$DCMDS" | while IFS= read -r c; do [ -n "$c" ] || continue; case "$c" in "~/"*) p="$HOME/\${c#\\~/}"; [ -x "$p" ] || out cmdmissing "$c";; /*) [ -x "$c" ] || out cmdmissing "$c";; *) command -v "$c" >/dev/null 2>&1 || out cmdmissing "$c";; esac; done
printf '%s\\n' "$DFILES" | while IFS= read -r f; do [ -n "$f" ] || continue; [ -e "$HOME/$f" ] || out pathmissing "$f"; done
printf '%s\\n' "$DENV" | while IFS= read -r l; do [ -n "$l" ] || continue; i=\${l%% *}; p=\${l#* }; case "$p" in '$HOME/'*) p="$HOME/\${p#\\$HOME/}";; esac; [ -f "$p" ] && out envthere "$i $(paw_hash "$p")"; done
[ -f "$HOME/.claude/settings.json" ] && out settings "$(b64 < "$HOME/.claude/settings.json")"`;
}

export type DestDeps = { cmdMissing: string[]; pathMissing: string[]; envThere: Record<number, string>; plugins?: string[] };

export function parseDestDeps(lines: ReadonlyArray<readonly [string, string]>): DestDeps {
  const all = (k: string) => lines.filter(([key]) => key === k).map(([, v]) => v);
  const settings = lines.find(([k]) => k === "settings")?.[1];
  let plugins: string[] | undefined;
  if (settings !== undefined) {
    try {
      const s = JSON.parse(Buffer.from(settings, "base64").toString("utf8")) as { enabledPlugins?: Record<string, unknown> };
      plugins = Object.entries(s.enabledPlugins ?? {}).filter(([, v]) => v === true).map(([k]) => k);
    } catch {
      plugins = undefined; // unreadable there: reported as unknown, never as "none enabled"
    }
  }
  return {
    cmdMissing: all("cmdmissing"),
    pathMissing: all("pathmissing"),
    envThere: Object.fromEntries(all("envthere").map((v) => [Number(v.slice(0, v.indexOf(" "))), v.slice(v.indexOf(" ") + 1)])),
    ...(plugins ? { plugins } : {}),
  };
}

/** sha256 of a local file (the same as `paw_hash` of a file). */
export function fileHash(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/** --env: a different file already there blocks (never overwritten); not --env: nothing blocks. */
export function envBlockers(d: HostDeps, dd: DestDeps | undefined, envChecked: boolean, there: string): string[] {
  if (!envChecked || !d.env.length) return [];
  if (!dd) return [`the --env files' destinations on ${there} were not probed — refusing to place secrets blind`];
  return d.env
    .map((e, i) => [e, dd.envThere[i]] as const)
    .filter(([e, h]) => h !== undefined && h !== e.hash)
    .map(([e]) => `${there} already has a different ${e.there.replace(/^@\//, "<folder>/")} — teleport never overwrites a secret file; reconcile it by hand, or drop --env`);
}

/** The plan's warnings: what it used here that is missing there, and the secrets that stay unless --env. */
export function depsPlanLines(d: HostDeps, dd: DestDeps | undefined, there: string, envChecked: boolean, folderMoves: boolean, cwd: string): string[] {
  const lines: string[] = [];
  if (dd) {
    const pluginsMissing = dd.plugins ? d.plugins.filter((p) => !dd.plugins!.includes(p)) : [];
    const missing = [...dd.cmdMissing, ...dd.pathMissing.map((f) => `~/${f}`), ...pluginsMissing.map((p) => `plugin ${p}`)];
    if (missing.length) lines.push(`  needs on ${there}: ${missing.map((x) => `${x} (missing)`).join(", ")}  — warnings: it used these here`);
    if (!dd.plugins && d.plugins.length) lines.push(`  needs on ${there}: plugins ${d.plugins.join(", ")} (can't read ~/.claude/settings.json there — unknown)`);
  }
  if (d.env.length) {
    const names = d.env.map((e) => e.there.replace(/^@\//, "<folder>/")).join(", ");
    if (envChecked) {
      const same = dd ? d.env.filter((e, i) => dd.envThere[i] === e.hash).length : 0;
      lines.push(`  env        ${d.env.length} secret file(s) its files name — moved, names only: ${names}${same ? ` (${same} already there)` : ""}`);
    } else lines.push(`  env        ${d.env.length} secret file(s) its files name are NOT moved (opt in with --env; names only): ${names}`);
  }
  if (folderMoves && d.selfRefs.length)
    lines.push(`  note       ${d.selfRefs.length} of its files name its folder ${cwd} by absolute path — they still point there after the move: ${d.selfRefs.slice(0, 8).join(", ")}${d.selfRefs.length > 8 ? ", …" : ""}`);
  return lines;
}
