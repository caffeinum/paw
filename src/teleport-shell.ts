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
import type { Readable } from "node:stream";
import { HASH_SH, type DestFacts, type FileEntry, type Manifest, type RepoInfo, type Transport, type What, transportLabel } from "./teleport-plan.ts";

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
    else input.pipe(child.stdin!);
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(out), stderr: err }));
  });
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

/** POSIX sh that reports every destination fact {@link teleportBlockers} needs, one `key<TAB>value` per line. */
export function probeScript(m: Manifest, what: What[]): string {
  const acp = m.agent === "acp" ? acpCommandPath(m.persona) : "";
  const top = m.repo?.top ?? m.cwd;
  return `${vars({
    N: m.name,
    S: m.space,
    AGENT: m.agent,
    CWD: m.cwd,
    TOP: top,
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
[ -f "$PH/spaces/$S/personas/$N.md" ] && out persona "$(b64 < "$PH/spaces/$S/personas/$N.md")"
if [ "$AGENT" = claude ] && command -v claude >/dev/null 2>&1; then out claude "$(claude auth status 2>&1 | b64)"; fi
if [ "$AGENT" = kit ] && command -v kit >/dev/null 2>&1; then out kit "$(kit auth status 2>&1 | b64)"; fi
if [ -n "$ACP" ]; then if [ -x "$ACP" ]; then out acp 1; else out acp 0; fi; fi
command -v git >/dev/null 2>&1 && out git "$(command -v git)"
[ -d "$CWD" ] && out cwdexists 1
p="$TOP"; while [ ! -e "$p" ]; do p=$(dirname "$p"); done
out mount "$(df -P "$p" 2>/dev/null | tail -n 1 | awk '{print $NF}')"
out freekb "$(df -Pk "$HOME" 2>/dev/null | tail -n 1 | awk '{print $4}')"
if [ -n "$REPO" ]; then
  if [ -e "$TOP" ]; then
    out repoexists 1
    if git -C "$TOP" rev-parse --git-dir >/dev/null 2>&1; then
      out isrepo 1
      out repourl "$(git -C "$TOP" remote get-url "$REMOTE" 2>/dev/null)"
      git -C "$TOP" status --porcelain=v1 --untracked-files=all 2>/dev/null | while IFS= read -r l; do out dirty "$l"; done
    else out isrepo 0; fi
  fi
  if e=$(GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes' git ls-remote "$URL" HEAD 2>&1 >/dev/null); then out lsremote ok; else out lsremote "$(printf '%s' "$e" | b64)"; fi
fi
[ -f "$HOME/.claude/CLAUDE.md" ] && out claudemd "$(paw_hash "$HOME/.claude/CLAUDE.md")"
for s in $SKILLS; do [ -d "$HOME/.claude/skills/$s" ] && out skill "$s $(paw_hash "$HOME/.claude/skills/$s")"; done
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
    teleportSupport: /^paw-teleport \d+/.test(one("teleport") ?? ""),
    ...(one("pawroot") !== undefined ? { pawRoot: one("pawroot") } : {}),
    allowAnyCwd: one("allowany") === "1",
    ...(record ? { spaceRecord: { server: (JSON.parse(record) as { server: string }).server } } : {}),
    ...(one("persona") !== undefined ? { personaText: unb64(one("persona")) } : {}),
    ...(claude !== undefined ? { claudeLogin: { loggedIn: claudeLoggedIn(claude), raw: claude } } : {}),
    ...(kit !== undefined ? { kitAuth: kit.split("\n").filter(Boolean) } : {}),
    ...(one("git") ? { git: one("git") } : {}),
    cwdExists: one("cwdexists") === "1",
    ...(one("mount") ? { cwdMount: one("mount") } : {}),
    ...(one("claudemd") ? { claudeMdHash: one("claudemd") } : {}),
    skillHashes: Object.fromEntries(all("skill").map((v) => [v.slice(0, v.lastIndexOf(" ")), v.slice(v.lastIndexOf(" ") + 1)])),
    ...(one("freekb") && /^\d+$/.test(one("freekb")!) ? { freeKb: Number(one("freekb")) } : {}),
  };
  if (one("acp") !== undefined) facts.acpCommand = { path: "", executable: one("acp") === "1" };
  if (one("repoexists") || lsRemote) {
    facts.repo = {
      exists: one("repoexists") === "1",
      ...(one("isrepo") !== undefined ? { isRepo: one("isrepo") === "1" } : {}),
      ...(one("repourl") !== undefined ? { url: one("repourl") } : {}),
      dirty: all("dirty"),
      ...(lsRemote ? { lsRemote: lsRemote === "ok" ? { ok: true, err: "" } : { ok: false, err: unb64(lsRemote)!.trim() } } : {}),
    };
  }
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

export async function probe(side: Side, m: Manifest, what: What[]): Promise<DestFacts> {
  const r = await run(side, probeScript(m, what));
  if (r.code !== 0) throw new Error(`paw: can't reach ${side.label}: ${said(r) || `exit ${r.code}`}`);
  const facts = parseProbe(side.label, r.stdout.toString("utf8"));
  if (facts.acpCommand) facts.acpCommand.path = acpCommandPath(m.persona);
  return facts;
}

// ── moving bytes ───────────────────────────────────────────────────────────────────────────────────

/** Source: a tar of the listed HOME-relative files on stdout (symlinks followed — a linked skill lands
 *  as a real dir). bsdtar (macOS) is told to leave its extended attributes out, which GNU tar warns on. */
export const PACK_SH = `cd "$HOME" || exit 1
COPYFILE_DISABLE=1; export COPYFILE_DISABLE
if tar --version 2>/dev/null | grep -q bsdtar; then exec tar --no-mac-metadata --no-xattrs -h -c -f - -T -; else exec tar -h -c -f - -T -; fi`;

/** Destination: unpack a tar from stdin under HOME. */
export const UNPACK_SH = `mkdir -p "$HOME" && cd "$HOME" && exec tar -x -f - --no-same-owner`;

/** Copy `files` from one side's HOME to the other's: pack | unpack, streamed. */
export async function copyFiles(from: Side, to: Side, files: FileEntry[]): Promise<void> {
  if (!files.length) return;
  const src = from.spawn(PACK_SH);
  const dst = to.spawn(UNPACK_SH);
  const [s, d] = await Promise.all([collect(src, files.map((f) => f.rel).join("\n") + "\n"), collect(dst, src.stdout!)]);
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
 * Destination: the same remote, branch and HEAD at the same absolute path. Clones when the folder is
 * absent; an existing clone must be of the same URL and clean, and its branch may only move FORWARD to
 * the source HEAD (never drops a commit the target has). Unpushed commits arrive as a bundle on stdin.
 */
export function repoApplyScript(r: RepoInfo, withBundle: boolean): string {
  return `${vars({ TOP: r.top, URL: r.url, REMOTE: r.remote, BR: r.branch ?? "", HEAD_SHA: r.head, BUNDLE: withBundle ? "1" : "" })}
set -e
fail() { echo "$*" >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes'
FRESH=
if [ ! -e "$TOP" ]; then mkdir -p "$(dirname "$TOP")"; git clone -q --no-checkout --origin "$REMOTE" "$URL" "$TOP"; FRESH=1; fi
cd "$TOP"
[ "$(git remote get-url "$REMOTE" 2>/dev/null)" = "$URL" ] || fail "$TOP: remote $REMOTE is not $URL"
[ -n "$FRESH" ] || [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || fail "$TOP has uncommitted changes"
git fetch -q "$REMOTE"
if [ -n "$BUNDLE" ]; then
  b=$(mktemp); cat > "$b"
  git bundle verify -q "$b" >/dev/null 2>&1 || { git bundle verify "$b" >&2; rm -f "$b"; exit 1; }
  if [ -n "$BR" ]; then git fetch -q "$b" "+refs/heads/$BR:refs/paw-teleport/$BR"; else git fetch -q "$b" "+HEAD:refs/paw-teleport/HEAD"; fi
  rm -f "$b"
fi
git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || fail "$HEAD_SHA is not on $URL and was not bundled"
if [ -n "$BR" ]; then
  if git rev-parse -q --verify "refs/heads/$BR" >/dev/null; then
    git merge-base --is-ancestor "refs/heads/$BR" "$HEAD_SHA" || fail "$TOP: branch $BR there has commits the source HEAD $HEAD_SHA lacks — refusing to drop them"
  fi
  git checkout -q -B "$BR" "$HEAD_SHA"
  if git rev-parse -q --verify "refs/remotes/$REMOTE/$BR" >/dev/null; then git branch -q --set-upstream-to="$REMOTE/$BR" "$BR"; fi
else
  git checkout -q --detach "$HEAD_SHA"
fi
git update-ref -d "refs/paw-teleport/\${BR:-HEAD}" 2>/dev/null || true
printf '%s %s\\n' "$(git rev-parse HEAD)" "$(git symbolic-ref -q --short HEAD || echo detached)"`;
}

/** Mirror the repo from one side to the other; returns the destination's `<HEAD> <branch>` line. */
export async function moveRepo(from: Side, to: Side, r: RepoInfo): Promise<string> {
  const withBundle = r.unpushed > 0;
  const dst = to.spawn(repoApplyScript(r, withBundle));
  if (!withBundle) {
    const d = await collect(dst);
    if (d.code !== 0) throw new Error(`paw: mirroring ${r.top} on ${to.label} failed: ${said(d) || `exit ${d.code}`}`);
    return d.stdout.toString("utf8").trim();
  }
  const src = from.spawn(bundleScript(r));
  const [s, d] = await Promise.all([collect(src), collect(dst, src.stdout!)]);
  if (s.code !== 0) throw new Error(`paw: bundling ${r.top} on ${from.label} failed: ${said(s) || `exit ${s.code}`}`);
  if (d.code !== 0) throw new Error(`paw: mirroring ${r.top} on ${to.label} failed: ${said(d) || `exit ${d.code}`}`);
  return d.stdout.toString("utf8").trim();
}

/** Destination: write the persona file (atomically) from stdin. */
export function writePersonaScript(space: string, name: string): string {
  return `${vars({ S: space, N: name })}
D="\${PAW_HOME:-$HOME/.paw}/spaces/$S/personas"
mkdir -p "$D" && cat > "$D/.$N.md.teleport-$$" && mv "$D/.$N.md.teleport-$$" "$D/$N.md" && printf '%s\\n' "$D/$N.md"`;
}

/** A paw verb on a side: `paw <args…>` (the target's own paw, on its own PATH). */
export function pawScript(args: string[]): string {
  return `exec paw ${args.map(sq).join(" ")}`;
}
