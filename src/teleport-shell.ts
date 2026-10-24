/**
 * `paw teleport` — the shell half (docs/notes/teleport.md). Every step that touches a machine is a
 * POSIX sh script run on one SIDE: this machine (`sh -c`) or the target over its literal transport,
 *
 *   fly:<app>[/<machine>]   fly ssh console -a <app> [--machine <id>] -C <script>
 *   ssh:<host>              ssh -o BatchMode=yes <host> <script>
 *
 * so the same probe / pack / extract / repo scripts run on either end (`--back` is the same steps with
 * the sides swapped). Bytes travel as a tar or git-bundle stream on the script's stdin — fly's ssh
 * carries binary stdin intact (sha256 round-trip checked 2026-10-22). The script itself rides the
 * command line base64-encoded, so neither fly's nor a remote login shell's quoting ever touches it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { depsProbeScript, parseDestDeps } from "./teleport-deps.ts";
import { memoryProbeScript, parseDestMemory } from "./teleport-memory.ts";
import { HASH_SH, type DestFacts, type DestFolder, type Manifest, type RepoInfo, type Transport, type What, transportLabel } from "./teleport-plan.ts";

/** The oldest target paw this one can drive: 2 = the agents folder and `__teleport rewrite-cwd`. */
export const TELEPORT_MIN_PROTOCOL = 2;

export interface Side {
  label: string;
  /** Start `script` there; stdin/stdout are pipes, stderr is collected by {@link collect}. */
  spawn(script: string): ChildProcess;
  remote: boolean;
}

/** Single-quote a value for sh. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Variable assignments heading a script. */
function vars(v: Record<string, string>): string {
  return Object.entries(v)
    .map(([k, val]) => `${k}=${sq(val)}`)
    .join("\n");
}

/** The login environment a target's paw runs with (agents-host's /etc/profile.d/paw.sh, a user's
 *  ~/.profile), sourced quietly — a non-interactive `sh -c` over ssh reads neither. */
const PROFILE = `[ -r /etc/profile ] && . /etc/profile >/dev/null 2>&1
[ -r "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1
true`;

/** The argv that runs `script` on the target. */
export function remoteArgv(t: Transport, script: string): [string, string[]] {
  const b64 = Buffer.from(`${PROFILE}\n${script}`, "utf8").toString("base64");
  const wrapped = `sh -c 'eval "$(echo ${b64} | base64 -d)"'`;
  if (t.kind === "fly") return ["fly", ["ssh", "console", "-a", t.app, ...(t.machine ? ["--machine", t.machine] : []), "-C", wrapped]];
  return ["ssh", ["-o", "BatchMode=yes", t.host, wrapped]];
}

export function localSide(label = "this machine"): Side {
  return { label, remote: false, spawn: (script) => spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] }) };
}

export function remoteSide(t: Transport): Side {
  return {
    label: transportLabel(t),
    remote: true,
    spawn: (script) => {
      const [cmd, args] = remoteArgv(t, script);
      return spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    },
  };
}

export type RunResult = { code: number; stdout: Buffer; stderr: string };

/** Run a script to completion, feeding `input` (or a stream) on stdin. */
export function collect(child: ChildProcess, input?: Buffer | string | Readable): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let err = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.stdin!.on("error", () => {}); // a script that exits early closes its stdin; the exit code says why
    if (input === undefined) child.stdin!.end();
    else if (typeof input === "string" || Buffer.isBuffer(input)) child.stdin!.end(input);
    else pump(input, child.stdin!).catch(() => {}); // a failed side shows in its exit code
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(out), stderr: err }));
  });
}

/** Copy a stream into a child's stdin chunk by chunk, honouring backpressure. Not `pipe()`: under bun a
 *  piped child stdout → child stdin cuts large streams short (a 50 MB transcript → "Truncated tar archive"). */
async function pump(from: Readable, to: Writable): Promise<void> {
  try {
    for await (const chunk of from) if (!to.write(chunk)) await once(to, "drain");
  } finally {
    to.end();
  }
}

export async function run(side: Side, script: string, input?: Buffer | string | Readable): Promise<RunResult> {
  return collect(side.spawn(script), input);
}

/** The stderr worth quoting: fly's "Connecting to …" banner dropped. */
export function said(r: RunResult): string {
  return r.stderr
    .split("\n")
    .filter((l) => l.trim() && !/^Connecting to /.test(l))
    .join("\n")
    .trim();
}

/** `fly:<app>` without a machine id is only unambiguous when the app has exactly one machine. */
export function checkFlyMachines(t: Transport, list?: () => string): void {
  if (t.kind !== "fly") return;
  let machines: Array<{ id: string; state?: string }>;
  try {
    machines = JSON.parse((list ?? (() => flyMachinesJson(t)))()) as Array<{ id: string; state?: string }>;
  } catch (e) {
    throw new Error(`paw: \`fly machines list -a ${t.app} --json\` did not return JSON (${(e as Error).message})`);
  }
  if (t.machine) {
    if (!machines.some((m) => m.id === t.machine))
      throw new Error(`paw: fly app ${t.app} has no machine ${t.machine} (it has ${machines.map((m) => m.id).join(", ") || "none"})`);
    return;
  }
  if (machines.length === 0) throw new Error(`paw: fly app ${t.app} has no machines`);
  if (machines.length > 1)
    throw new Error(
      `paw: fly app ${t.app} has ${machines.length} machines (${machines.map((m) => `${m.id} ${m.state ?? ""}`.trim()).join(", ")}) — ` +
        `say which: --to fly:${t.app}/<machine-id>`,
    );
}

function flyMachinesJson(t: Transport & { kind: "fly" }): string {
  const r = spawnSync("fly", ["machines", "list", "-a", t.app, "--json"], { encoding: "utf8", timeout: 60_000 });
  if (r.error) throw new Error(`paw: can't run \`fly\` (${r.error.message}) — fly:<app> needs flyctl on PATH, logged in`);
  if (r.status !== 0) throw new Error(`paw: \`fly machines list -a ${t.app}\` failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// ── the destination probe ──────────────────────────────────────────────────────────────────────────

/** The destination's HOME and PAW_HOME — the folder it gets depends on them (teleport-plan destFolder). */
export const ENV_SH = `printf 'home\\t%s\\npawhome\\t%s\\nend\\t1\\n' "$HOME" "\${PAW_HOME:-$HOME/.paw}"`;

export async function probeEnv(side: Side): Promise<{ home: string; pawHome: string }> {
  const r = await run(side, ENV_SH);
  const text = r.stdout.toString("utf8");
  const get = (k: string) => text.split("\n").find((l) => l.startsWith(`${k}\t`))?.slice(k.length + 1);
  const home = get("home");
  const pawHome = get("pawhome");
  if (r.code !== 0 || !home || !pawHome || get("end") !== "1") throw new Error(`paw: can't reach ${side.label}: ${said(r) || text.trim() || `exit ${r.code}`}`);
  return { home, pawHome };
}

/** POSIX sh that reports every destination fact {@link teleportBlockers} needs, one `key<TAB>value` per line. */
export function probeScript(m: Manifest, what: What[], folder: DestFolder): string {
  const acp = m.agent === "acp" ? acpCommandPath(m.persona) : "";
  return `${vars({
    N: m.name,
    S: m.space,
    AGENT: m.agent,
    CWD: folder.cwd,
    TOP: folder.top ?? folder.cwd,
    CLONE: folder.clone ?? "",
    WT: folder.how === "original" ? "" : (folder.worktree ?? ""),
    REPO: what.includes("repo") && m.repo ? "1" : "",
    URL: m.repo?.url ?? "",
    REMOTE: m.repo?.remote ?? "",
    ACP: acp,
    SKILLS: m.skills.map((s) => s.name).join(" "),
  })}
${HASH_SH}
out() { printf '%s\\t%s\\n' "$1" "$2"; }
b64() { base64 | tr -d '\\n'; }
PH="\${PAW_HOME:-$HOME/.paw}"
out home "$HOME"
out pawhome "$PH"
P=$(command -v paw 2>/dev/null) && out paw "$P" && out teleport "$(paw __teleport probe 2>/dev/null | head -n 1)"
[ "\${PAW_ROOT+set}" = set ] && out pawroot "$PAW_ROOT"
out allowany "\${PAW_ALLOW_ANY_CWD:-}"
[ -f "$PH/spaces/$S/remote-mesh.json" ] && out record "$(b64 < "$PH/spaces/$S/remote-mesh.json")"
if [ -f "$PH/spaces/$S/personas/$N.md" ]; then
  out persona "$(b64 < "$PH/spaces/$S/personas/$N.md")"
  # Its pinned session held by a live claude there (Claude Code's per-process index, ~/.claude/sessions/<pid>.json).
  pin=$(sed -n 's/^resume:[[:space:]]*//p' "$PH/spaces/$S/personas/$N.md" | head -n 1 | tr -d "\\"' ")
  if [ -n "$pin" ]; then for f in "$HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    grep -q "\\"sessionId\\":\\"$pin\\"" "$f" || continue
    p=$(basename "$f" .json); kill -0 "$p" 2>/dev/null && out livepid "$p"
  done; fi
fi
if [ "$AGENT" = claude ] && command -v claude >/dev/null 2>&1; then out claude "$(claude auth status 2>&1 | b64)"; fi
if [ "$AGENT" = kit ] && command -v kit >/dev/null 2>&1; then out kit "$(kit auth status 2>&1 | b64)"; fi
if [ -n "$ACP" ]; then if [ -x "$ACP" ]; then out acp 1; else out acp 0; fi; fi
command -v git >/dev/null 2>&1 && out git "$(command -v git)"
[ -d "$CWD" ] && out cwdexists 1
[ -d "$CWD" ] && [ -n "$(ls -A "$CWD" 2>/dev/null)" ] && out cwdnonempty 1
p="$TOP"; while [ ! -e "$p" ]; do p=$(dirname "$p"); done
out mount "$(df -P "$p" 2>/dev/null | tail -n 1 | awk '{print $NF}')"
out freekb "$(df -Pk "$HOME" 2>/dev/null | tail -n 1 | awk '{print $4}')"
if [ -n "$REPO" ]; then
  if [ -e "$CLONE" ]; then
    out repoexists 1
    if git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1; then
      out isrepo 1
      out repourl "$(git -C "$CLONE" config --get "remote.$REMOTE.url" 2>/dev/null)"
      b=$(git -C "$CLONE" symbolic-ref -q --short HEAD 2>/dev/null) && out repobranch "$b"
      out repohead "$(git -C "$CLONE" rev-parse -q --verify HEAD 2>/dev/null)"
      git -C "$CLONE" status --porcelain=v1 --untracked-files=all 2>/dev/null | while IFS= read -r l; do out dirty "$l"; done
      git -C "$CLONE" worktree list --porcelain 2>/dev/null | awk '/^worktree /{p=substr($0,10)} /^branch /{b=$2; sub("^refs/heads/","",b); print p "\t" b}' | while IFS= read -r l; do out wtlist "$l"; done
    else out isrepo 0; fi
  fi
  if [ -n "$WT" ] && [ -e "$WT" ]; then
    out wtexists 1
    git -C "$WT" status --porcelain=v1 --untracked-files=all 2>/dev/null | while IFS= read -r l; do out wtdirty "$l"; done
  fi
  if e=$(GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes' git ls-remote "$URL" HEAD 2>&1 >/dev/null); then out lsremote ok; else out lsremote "$(printf '%s' "$e" | b64)"; fi
  for f in "$PH"/spaces/*/personas/*.md; do
    [ -f "$f" ] || continue
    grep -q '^teleported:' "$f" && continue
    c=$(sed -n 's/^cwd: //p' "$f" | head -n 1)
    [ -n "$c" ] && out agentcwd "$(basename "$(dirname "$(dirname "$f")")")/$(basename "$f" .md)	$c"
  done
fi
[ -f "$HOME/.claude/CLAUDE.md" ] && out claudemd "$(paw_hash "$HOME/.claude/CLAUDE.md")"
for s in $SKILLS; do [ -d "$HOME/.claude/skills/$s" ] && out skill "$s $(paw_hash "$HOME/.claude/skills/$s")"; done
${m.hostDeps ? `${depsProbeScript(m.hostDeps, folder.cwd)}\nout depsprobed 1` : ""}
${what.includes("memory") ? memoryProbeScript(folder.cwd, folder.how === "repo" || folder.how === "worktree" ? folder.clone : undefined) : ""}
out end 1
`;
}

function acpCommandPath(persona: string): string {
  const raw = persona.match(/^---\n([\s\S]*?)\n---/)?.[1].split("\n").find((l) => l.trimStart().startsWith("acpCommand:"));
  const json = raw?.slice(raw.indexOf(":") + 1).trim().replace(/^'|'$/g, "");
  const cmd = json ? (JSON.parse(json) as string[]) : [];
  if (!cmd[0]) throw new Error("paw: the acp agent's persona has no acpCommand — nothing to run on the target");
  return cmd[0];
}

/** The probe's output, read into {@link DestFacts}. Missing `end` ⇒ the script died mid-way: throw. */
export function parseProbe(label: string, stdout: string): DestFacts {
  const lines = stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)] as const);
  const one = (k: string) => lines.find(([key]) => key === k)?.[1];
  const all = (k: string) => lines.filter(([key]) => key === k).map(([, v]) => v);
  const unb64 = (v: string | undefined) => (v === undefined ? undefined : Buffer.from(v, "base64").toString("utf8"));
  if (one("end") !== "1") throw new Error(`paw: the probe on ${label} did not finish — its output:\n${stdout.slice(0, 2000)}`);
  const home = one("home");
  const pawHome = one("pawhome");
  if (!home || !pawHome) throw new Error(`paw: the probe on ${label} reported no HOME — its output:\n${stdout.slice(0, 2000)}`);
  const record = unb64(one("record"));
  const claude = unb64(one("claude"));
  const kit = unb64(one("kit"));
  const lsRemote = one("lsremote");
  const facts: DestFacts = {
    label,
    home,
    pawHome,
    ...(one("paw") ? { paw: one("paw") } : {}),
    teleportSupport: Number(/^paw-teleport (\d+)/.exec(one("teleport") ?? "")?.[1] ?? 0) >= TELEPORT_MIN_PROTOCOL,
    ...(one("pawroot") !== undefined ? { pawRoot: one("pawroot") } : {}),
    allowAnyCwd: one("allowany") === "1",
    ...(record ? { spaceRecord: { server: (JSON.parse(record) as { server: string }).server } } : {}),
    ...(one("persona") !== undefined ? { personaText: unb64(one("persona")) } : {}),
    ...(claude !== undefined ? { claudeLogin: { loggedIn: claudeLoggedIn(claude), raw: claude } } : {}),
    ...(kit !== undefined ? { kitAuth: kit.split("\n").filter(Boolean) } : {}),
    ...(one("git") ? { git: one("git") } : {}),
    cwdExists: one("cwdexists") === "1",
    cwdNonEmpty: one("cwdnonempty") === "1",
    ...(one("depsprobed") === "1" ? { deps: parseDestDeps(lines) } : {}),
    ...(one("mount") ? { cwdMount: one("mount") } : {}),
    ...(one("claudemd") ? { claudeMdHash: one("claudemd") } : {}),
    agentCwds: all("agentcwd").map((v) => ({ who: v.slice(0, v.indexOf("\t")), cwd: v.slice(v.indexOf("\t") + 1) })),
    skillHashes: Object.fromEntries(all("skill").map((v) => [v.slice(0, v.lastIndexOf(" ")), v.slice(v.lastIndexOf(" ") + 1)])),
    ...(one("freekb") && /^\d+$/.test(one("freekb")!) ? { freeKb: Number(one("freekb")) } : {}),
    livePids: all("livepid").map(Number),
  };
  if (one("acp") !== undefined) facts.acpCommand = { path: "", executable: one("acp") === "1" };
  if (one("repoexists") || lsRemote) {
    const tabbed = (v: string) => [v.slice(0, v.indexOf("\t")), v.slice(v.indexOf("\t") + 1)] as const;
    facts.repo = {
      exists: one("repoexists") === "1",
      ...(one("isrepo") !== undefined ? { isRepo: one("isrepo") === "1" } : {}),
      ...(one("repourl") !== undefined ? { url: one("repourl") } : {}),
      ...(one("repobranch") ? { branch: one("repobranch") } : {}),
      ...(one("repohead") ? { head: one("repohead") } : {}),
      dirty: all("dirty"),
      worktrees: all("wtlist").map((v) => {
        const [path, branch] = tabbed(v);
        return { path, ...(branch ? { branch } : {}) };
      }),
      ...(one("wtexists") ? { wt: { exists: true, dirty: all("wtdirty") } } : {}),
      ...(lsRemote ? { lsRemote: lsRemote === "ok" ? { ok: true, err: "" } : { ok: false, err: unb64(lsRemote)!.trim() } } : {}),
    };
  }
  const memory = parseDestMemory(lines);
  if (memory) facts.memory = memory;
  return facts;
}

/** `claude auth status` prints JSON with `loggedIn`; anything else (an older claude) reads as not logged in. */
export function claudeLoggedIn(raw: string): boolean {
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  try {
    return (JSON.parse(json) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

export async function probe(side: Side, m: Manifest, what: What[], folder: DestFolder): Promise<DestFacts> {
  const r = await run(side, probeScript(m, what, folder));
  if (r.code !== 0) throw new Error(`paw: can't reach ${side.label}: ${said(r) || `exit ${r.code}`}`);
  const facts = parseProbe(side.label, r.stdout.toString("utf8"));
  if (facts.acpCommand) facts.acpCommand.path = acpCommandPath(m.persona);
  return facts;
}

// ── moving bytes ───────────────────────────────────────────────────────────────────────────────────

/**
 * Source: a tar on stdout of the HOME-relative files listed on stdin as `<src><TAB><dst>` — each stored
 * under its DESTINATION path. A staging dir of symlinks named the dst paths, archived with -h, renames
 * them without tar's own (GNU --transform vs bsdtar -s) rename flags; a linked skill lands as a real dir.
 * bsdtar (macOS) is told to leave its extended attributes out, which GNU tar warns on.
 */
export const PACK_SH = `cd "$HOME" || exit 1
st=$(mktemp -d) || exit 1
trap 'rm -rf "$st"' EXIT
tab=$(printf '\\t')
while IFS="$tab" read -r src dst; do
  [ -n "$src" ] || continue
  mkdir -p "$st/$(dirname "$dst")" && ln -s "$HOME/$src" "$st/$dst" && printf '%s\\n' "$dst" >> "$st/.paw-list" || exit 1
done
COPYFILE_DISABLE=1; export COPYFILE_DISABLE
cd "$st" || exit 1
if tar --version 2>/dev/null | grep -q bsdtar; then tar --no-mac-metadata --no-xattrs -h -c -f - -T .paw-list; else tar -h -c -f - -T .paw-list; fi`;

/** Destination: unpack a tar from stdin under HOME. */
export const UNPACK_SH = `mkdir -p "$HOME" && cd "$HOME" && exec tar -x -p -f - --no-same-owner`;

/** Copy files from one side's HOME to the other's (`src` → `dst`, both HOME-relative): pack | unpack, streamed. */
export async function copyFiles(from: Side, to: Side, files: Array<{ src: string; dst: string }>): Promise<void> {
  if (!files.length) return;
  const src = from.spawn(PACK_SH);
  const dst = to.spawn(UNPACK_SH);
  const [s, d] = await Promise.all([collect(src, files.map((f) => `${f.src}\t${f.dst}`).join("\n") + "\n"), collect(dst, src.stdout!)]);
  if (s.code !== 0) throw new Error(`paw: packing on ${from.label} failed: ${said(s) || `exit ${s.code}`}`);
  if (d.code !== 0) throw new Error(`paw: unpacking on ${to.label} failed: ${said(d) || `exit ${d.code}`}`);
}

/** Source: the commits only this checkout has, as a git bundle on stdout. */
export function bundleScript(r: RepoInfo): string {
  return `${vars({ TOP: r.top, REF: r.branch ? `refs/heads/${r.branch}` : "HEAD", REMOTE: r.remote })}
f=$(mktemp) || exit 1
git -C "$TOP" bundle create "$f" "$REF" --not --remotes="$REMOTE" >/dev/null 2>&1 || { git -C "$TOP" bundle create "$f" "$REF" --not --remotes="$REMOTE" >&2; rm -f "$f"; exit 1; }
cat "$f"; rc=$?; rm -f "$f"; exit $rc`;
}

/**
 * Destination: the same remote, branch and HEAD in `folder` — the repo's paw clone (cloned when absent), or
 * a per-branch worktree of it (`folder.how === "worktree"`, added when absent). An existing checkout must be
 * of the same URL and clean, and its branch may only move FORWARD to the source HEAD (never drops a commit
 * the target has). Unpushed commits arrive as a bundle on stdin.
 */
export function repoApplyScript(r: RepoInfo, folder: DestFolder, withBundle: boolean): string {
  return `${vars({ CLONE: folder.clone ?? folder.top!, TOP: folder.top!, WT: folder.how === "worktree" ? "1" : "", URL: r.url, REMOTE: r.remote, BR: r.branch ?? "", HEAD_SHA: r.head, BUNDLE: withBundle ? "1" : "" })}
set -e
fail() { echo "$*" >&2; exit 1; }
clean() { [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || fail "$PWD has uncommitted changes"; }
forward() {
  [ -n "$BR" ] && git rev-parse -q --verify "refs/heads/$BR" >/dev/null || return 0
  git merge-base --is-ancestor "refs/heads/$BR" "$HEAD_SHA" && return 0
  if git merge-base --is-ancestor "$HEAD_SHA" "refs/heads/$BR"; then
    fail "the source HEAD $HEAD_SHA is BEHIND branch $BR there ($(git rev-parse "refs/heads/$BR")) — the source checkout is stale, not ahead; fast-forward it (git merge --ff-only $REMOTE/$BR in the source repo) and teleport again"
  fi
  fail "branch $BR there has commits the source HEAD $HEAD_SHA lacks — refusing to drop them"
}
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes'
# What THIS run creates, it removes again if the run fails — never a folder that was there before.
FRESH=
WTNEW=
undo() {
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  cd /
  if [ -n "$FRESH" ]; then rm -rf "$CLONE" && echo "removed $CLONE (cloned by this run)" >&2
  elif [ -n "$WTNEW" ]; then { git -C "$CLONE" worktree remove --force "$TOP" >/dev/null 2>&1 || rm -rf "$TOP"; } && git -C "$CLONE" worktree prune && echo "removed the worktree $TOP (added by this run)" >&2
  fi
  exit "$rc"
}
trap undo EXIT
if [ ! -e "$CLONE" ]; then mkdir -p "$(dirname "$CLONE")"; FRESH=1; git clone -q --no-checkout --origin "$REMOTE" "$URL" "$CLONE"; fi
cd "$CLONE"
[ "$(git config --get "remote.$REMOTE.url")" = "$URL" ] || fail "$CLONE: remote $REMOTE is not $URL"
git fetch -q "$REMOTE"
if [ -n "$BUNDLE" ]; then
  b=$(mktemp); cat > "$b"
  git bundle verify -q "$b" >/dev/null 2>&1 || { git bundle verify "$b" >&2; rm -f "$b"; exit 1; }
  if [ -n "$BR" ]; then git fetch -q "$b" "+refs/heads/$BR:refs/paw-teleport/$BR"; else git fetch -q "$b" "+HEAD:refs/paw-teleport/HEAD"; fi
  rm -f "$b"
fi
git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || fail "$HEAD_SHA is not on $URL and was not bundled"
if [ -n "$WT" ] && [ ! -e "$TOP" ]; then
  forward
  mkdir -p "$(dirname "$TOP")"
  WTNEW=1
  if [ -n "$BR" ]; then git worktree add -q -B "$BR" "$TOP" "$HEAD_SHA"; else git worktree add -q --detach "$TOP" "$HEAD_SHA"; fi
  cd "$TOP"
else
  cd "$TOP"
  if [ -z "$FRESH" ]; then clean; fi
  forward
  if [ -n "$BR" ]; then git checkout -q -B "$BR" "$HEAD_SHA"; else git checkout -q --detach "$HEAD_SHA"; fi
fi
if [ -n "$BR" ] && git rev-parse -q --verify "refs/remotes/$REMOTE/$BR" >/dev/null; then git branch -q --set-upstream-to="$REMOTE/$BR" "$BR"; fi
git update-ref -d "refs/paw-teleport/\${BR:-HEAD}" 2>/dev/null || true
if [ -n "$FRESH" ]; then echo "created clone $CLONE"; elif [ -n "$WTNEW" ]; then echo "created worktree $TOP"; fi
printf '%s %s\\n' "$(git rev-parse HEAD)" "$(git symbolic-ref -q --short HEAD || echo detached)"`;
}

/** What a mirror made on the destination this run (absent = it reused what was there). */
export type RepoCreated = { kind: "clone" | "worktree"; path: string; clone: string };
export type RepoMoved = { line: string; created?: RepoCreated };

function repoMoved(stdout: string, folder: DestFolder): RepoMoved {
  const lines = stdout.trim().split("\n");
  const made = /^created (clone|worktree) (.+)$/.exec(lines.find((l) => l.startsWith("created ")) ?? "");
  return { line: lines[lines.length - 1], ...(made ? { created: { kind: made[1] as RepoCreated["kind"], path: made[2], clone: folder.clone ?? folder.top! } } : {}) };
}

/** Mirror the repo from one side to the other: the destination's `<HEAD> <branch>` line, and the clone or
 *  worktree it created (a failed mirror removes what it created itself, inside the script). */
export async function moveRepo(from: Side, to: Side, r: RepoInfo, folder: DestFolder): Promise<RepoMoved> {
  const withBundle = r.unpushed > 0;
  const top = folder.top!;
  const dst = to.spawn(repoApplyScript(r, folder, withBundle));
  if (!withBundle) {
    const d = await collect(dst);
    if (d.code !== 0) throw new Error(`paw: mirroring ${r.top} to ${top} on ${to.label} failed: ${said(d) || `exit ${d.code}`}`);
    return repoMoved(d.stdout.toString("utf8"), folder);
  }
  const src = from.spawn(bundleScript(r));
  const [s, d] = await Promise.all([collect(src), collect(dst, src.stdout!)]);
  if (s.code !== 0) throw new Error(`paw: bundling ${r.top} on ${from.label} failed: ${said(s) || `exit ${s.code}`}`);
  if (d.code !== 0) throw new Error(`paw: mirroring ${r.top} to ${top} on ${to.label} failed: ${said(d) || `exit ${d.code}`}`);
  return repoMoved(d.stdout.toString("utf8"), folder);
}

/** Destination: remove a clone or worktree this teleport created, after the run failed later on. Refuses a
 *  path that isn't the git checkout it made. */
export function removeCreatedScript(c: RepoCreated): string {
  return `${vars({ P: c.path, CLONE: c.clone, KIND: c.kind })}
set -e
[ -e "$P" ] || { echo "already gone"; exit 0; }
git -C "$P" rev-parse --git-dir >/dev/null 2>&1 || { echo "$P is not a git checkout — left alone" >&2; exit 1; }
if [ "$KIND" = worktree ]; then git -C "$CLONE" worktree remove --force "$P" && git -C "$CLONE" worktree prune; else rm -rf "$P"; fi
echo "removed $P"`;
}

/** Destination, --force: stop its own agent of this name, then move its persona aside (never deleted).
 *  Prints `stopped <0|1>` and the backup path. */
export function replaceScript(space: string, name: string, backup: string): string {
  return `${vars({ S: space, N: name, B: backup })}
D="\${PAW_HOME:-$HOME/.paw}/spaces/$S/personas"
[ -f "$D/$N.md" ] || { echo "no persona $D/$N.md to replace" >&2; exit 1; }
[ -e "$B" ] && { echo "$B already exists — refusing to overwrite a backup" >&2; exit 1; }
o=$(paw stop "$N" --space "$S" 2>&1) || { echo "paw stop $N there failed: $o" >&2; exit 1; }
case "$o" in *"stopped $N"*) echo "stopped 1";; *) echo "stopped 0";; esac
mkdir -p "$(dirname "$B")" && mv "$D/$N.md" "$B" && echo "$B"`;
}

/** Destination: undo {@link replaceScript} — its persona back in place (over the one teleport wrote). */
export function restoreReplacedScript(space: string, name: string, backup: string): string {
  return `${vars({ S: space, N: name, B: backup })}
D="\${PAW_HOME:-$HOME/.paw}/spaces/$S/personas"
[ -f "$B" ] || { echo "no backup at $B" >&2; exit 1; }
mv -f "$B" "$D/$N.md" && echo "$D/$N.md"`;
}

/** Destination: write the persona file (atomically) from stdin; `folder` (the agents folder) is created first. */
export function writePersonaScript(space: string, name: string, folder?: string): string {
  return `${vars({ S: space, N: name, F: folder ?? "" })}
D="\${PAW_HOME:-$HOME/.paw}/spaces/$S/personas"
{ [ -z "$F" ] || mkdir -p "$F"; } && mkdir -p "$D" && cat > "$D/.$N.md.teleport-$$" && mv "$D/.$N.md.teleport-$$" "$D/$N.md" && printf '%s\\n' "$D/$N.md"`;
}

/** A paw verb on a side: `paw <args…>` (the target's own paw, on its own PATH). */
export function pawScript(args: string[]): string {
  return `exec paw ${args.map(sq).join(" ")}`;
}

/** Source: a tar of absolute paths listed on stdin, stored as `0`, `1`, … (their order), modes kept. */
export const PACK_ABS_SH = `st=$(mktemp -d) || exit 1
trap 'rm -rf "$st"' EXIT
i=0
while IFS= read -r src; do [ -n "$src" ] || continue; ln -s "$src" "$st/$i" || exit 1; printf '%s\\n' "$i" >> "$st/.paw-list"; i=$((i + 1)); done
COPYFILE_DISABLE=1; export COPYFILE_DISABLE
cd "$st" || exit 1
if tar --version 2>/dev/null | grep -q bsdtar; then tar --no-mac-metadata --no-xattrs -h -c -f - -T .paw-list; else tar -h -c -f - -T .paw-list; fi`;

/** Destination: unpack {@link PACK_ABS_SH}'s tar and move entry N to `dsts[N]` (`$HOME/…` expanded there),
 *  keeping its mode. Never overwrites a different file that is there (the preflight compared them too). */
export function unpackAbsScript(dsts: string[]): string {
  return `${vars({ L: dsts.join("\n") })}
t=$(mktemp -d) || exit 1
trap 'rm -rf "$t"' EXIT
(cd "$t" && tar -x -p -f - --no-same-owner) || exit 1
i=0
printf '%s\\n' "$L" | { while IFS= read -r d; do
  case "$d" in '$HOME/'*) d="$HOME/\${d#\\$HOME/}";; esac
  if [ -e "$d" ]; then cmp -s "$t/$i" "$d" || { echo "$d exists there and differs — not overwritten" >&2; exit 1; }
  else mkdir -p "$(dirname "$d")" && mv "$t/$i" "$d" || exit 1; fi
  printf '%s\\n' "$d"
  i=$((i + 1))
done; }`;
}

/** Copy absolute files from one side to destinations on the other (`$HOME/…` = that side's HOME). */
export async function copyAbsFiles(from: Side, to: Side, files: Array<{ src: string; dst: string }>): Promise<string[]> {
  if (!files.length) return [];
  const src = from.spawn(PACK_ABS_SH);
  const dst = to.spawn(unpackAbsScript(files.map((f) => f.dst)));
  const [s, d] = await Promise.all([collect(src, files.map((f) => f.src).join("\n") + "\n"), collect(dst, src.stdout!)]);
  if (s.code !== 0) throw new Error(`paw: packing the --env files on ${from.label} failed: ${said(s) || `exit ${s.code}`}`);
  if (d.code !== 0) throw new Error(`paw: placing the --env files on ${to.label} failed: ${said(d) || `exit ${d.code}`}`);
  return d.stdout.toString("utf8").split("\n").filter(Boolean);
}
