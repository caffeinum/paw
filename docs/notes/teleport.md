# paw teleport

```
paw teleport <agent> --to fly:<app>[/<machine-id>] | ssh:<host>  [--all | --session --repo --folder --skills --memory --claude-md --beads] [--env] [--force] [--dry-run] [--yes]
paw teleport <agent> --back [--dry-run] [--yes]
```

`--no-<one>` trims the list: `--no-repo` alone = everything but the repo (= `--all --no-repo`). `--env` is
OPT-IN: `--all`, `--no-<one>` and the checklist's preselection leave it out (`--all --env` adds it).

## Where the agent's folder lands (never the source path)

- **without --repo** → `<target PAW_HOME>/agents/<name>`, created by teleport. Nothing from the source
  folder moves (unless it is not a git checkout and `--folder` is on: [Folder](#folder)); files the agent
  writes there stay there on `--back`.
- **with --repo** → the repo's paw clone on the target, `<target PAW_HOME>/repos/<owner>/<repo>` — the
  layout `github:` handles use (src/repo-layout.ts); owner/repo come from the remote URL, read literally
  (`git config remote.<r>.url`, not `get-url`, which expands insteadOf). A non-GitHub remote fails loud
  (no invented path). The agent's folder keeps its place inside the repo (`pkg/web` stays `pkg/web`).
  An existing clone is reused when it is the same URL, on the agent's branch, clean, and no other agent
  there would see its checkout move; if the clone has ANOTHER branch checked out, the agent gets a worktree
  beside it, `<clone>.worktrees/<repo>-<branch slug>` (the layout `github.com/…/tree/<branch>` addressing
  makes, src/address.ts). A branch already checked out in a third worktree blocks.
- `<PAW_HOME>/agents` and `<PAW_HOME>/repos` are paw-managed (src/cwd.ts): allowed under any PAW_ROOT.
- `--back` returns it to the folder it left from (this machine's persona keeps `cwd:` while marked).
- The persona's `cwd:` on the destination names the new folder. Session and memory files move into THAT
  folder's project dir (`.claude/projects/<slug of the new path>/`, kit's store likewise), and the `cwd`
  field of every moved transcript line is rewritten (`rewriteCwdText`: the field only, `from` or a folder
  under it; message text, a sibling prefix and other paths are untouched; idempotent), on the destination
  by `paw __teleport rewrite-cwd`.
- Why only `cwd`: claude 2.1.309 finds `--resume <id>` in ANY project dir, `-p` and the TUI alike, replays
  the history with no cross-directory prompt, and appends new lines to the file where it found it, stamped
  with its own cwd (scratch HOME, 2026-10-23; a bogus id says "No conversation found"). So nothing in the
  transcript is needed to resume; the slug move is for memory, `--continue` and the picker, and the rewrite
  keeps one folder per transcript. Verified on files this code produced: resumed from `~/.paw/agents/<name>`.
- Absolute paths inside persona VALUES (`acpCommand`, `claudeArgs --add-dir`, kitArgs) are not rewritten.

Moves an agent from this machine to another box, and back. v1 2026-10-22; the folder rules below 2026-10-23. Code: `src/teleport.ts`
(the cutover + the command), `src/teleport-plan.ts` (pure: args, chain, manifest, blockers, plan),
`src/teleport-shell.ts` (the transports and every script that runs on a side). Rule it follows: the
operator's "a good API is as transparent as possible, no inventions" — literal transports, no host
registry, nothing renamed, every write printed with its undo.

## Transports

- `fly:<app>` = `fly ssh console -a <app> -C <script>`. An app with more than one machine is refused
  ("say which: `--to fly:<app>/<machine-id>`"), checked with `fly machines list --json`.
- `ssh:<host>` = `ssh -o BatchMode=yes <host> <script>` — whatever `~/.ssh/config` says about the host.
- The script rides the command line base64-encoded inside `sh -c 'eval "$(echo … | base64 -d)"'`, so no
  shell (fly's arg split, a remote login shell) ever re-quotes it. It first sources `/etc/profile` and
  `~/.profile` quietly (agents-host's `/etc/profile.d/paw.sh` env; a non-interactive ssh reads neither).
- Bytes travel on the script's stdin: a tar (files) or a git bundle (unpushed commits). fly's ssh carries
  binary stdin intact (3 MB random blob, sha256 equal, 2026-10-22). fly returns exit 1 for any non-zero
  remote exit, so scripts report through their output, not their exit code.

## What moves

The persona always moves (agent type, model, kitArgs, storage, channels, nice, the `resume:` pin — the
name stays). Checkmarks (none given: a checklist on a tty, all preselected; a pipe refuses):

- **session** — the pinned transcript plus its whole **continued-in chain**. Claude Code continues a long
  session under a NEW id and records the link only in the OLD file:
  `{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}`; the new file has no pointer
  back (checked across 516 transcripts; a `/compact` stays in the same file as a `compact_boundary`). So
  predecessors are found by scanning every transcript in the same project dir for those records (streamed,
  marker-only parse; a record quoted inside message text is JSON-escaped and never matches), successors by
  following them forward. Per id: `<id>.jsonl`, the `<id>/` sidecar dir (subagents, tool-results,
  workflows) and `~/.claude/file-history/<id>/`. Kit agents: kit's store (`~/.kit/sessions/<slug>/`) as
  well as claude's, per `storage:`. acp agents refuse `--session` (their session lives inside the ACP agent).
  Without `--session` the target keeps the pin of a copy it ran before, or gets a fresh one — never the
  source's id with no transcript behind it (that would fork the session at the same id).
- **repo** — same remote URL, same branch, same HEAD, in the target's paw clone (above). Unpushed commits
  (`HEAD --not --remotes=<remote>`) go as a git bundle. A dirty tree is refused with the first 10 paths,
  "… and N more", and the way out (`--no-repo`). A checkout there may only move forward to the source HEAD.
  `.gitignored` files (.env, node_modules) don't move.
- **skills** — `~/.claude/skills/*` (dirs; a linked skill lands as a real dir; dot-dirs skipped). Not
  `~/.claude/skills/synced/`: Claude Code's claude.ai skill-sync state for this machine's login
  (`<org>_<account>` bucket dirs, `.bucket-*` markers, `manifest.json`, `.last-complete-round`; 2.1.310 loads
  it as `loadedFrom: "syncedSkills"`) — neither moved nor compared (it was a false "different skill"
  blocker); the target's Claude Code syncs its own. Plugins don't move; the ones enabled here and missing
  there are plan warnings. Project `.claude/skills` travel with the repo.
- **memory** — every memory dir that is the agent's, merged into the one the target's Claude Code reads:
  [Memory](#memory).
- **folder** — a cwd that is not a git checkout, as a tree: [Folder](#folder). In `--all`; a git cwd moves
  with `--repo` instead (`--all` on a non-git cwd skips the repo with a note; `--repo` alone still refuses).
- **env** (opt-in) — the secret files its files name: [What it needs there](#what-it-needs-there).
- **claude-md** — `~/.claude/CLAUDE.md`.
- **beads** — its open beads; see [Beads](#beads).
- A different CLAUDE.md or skill already on the target is a blocker, never an overwrite; an identical one
  is skipped (`filesToSend`). Paths land under the target's HOME at the same HOME-relative path.
- **Logins are never copied** (claude, kit, gh, ssh keys). The probe checks `claude auth status`
  (`loggedIn`), `kit auth status` (the persona's provider), and `git ls-remote <url>` from the target.

## Memory

How Claude Code keys auto-memory (2.1.310 binary, `getAutoMemPath` → `resolveEntry`/`defaultKey`, read
2026-10-23): `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, else the `autoMemoryDirectory` setting, else
`<CLAUDE_CODE_REMOTE_MEMORY_DIR | ~/.claude>/projects/<sanitized base>/memory/`. The base is the CANONICAL
git root: walk up to the first `.git`; a `.git` FILE (linked worktree) is followed through `gitdir:` →
`commondir` to the main checkout (`Qn()`); outside git, the folder. Sanitized = non-alphanumerics → `-`,
cut at 200 chars + a hash paw can't reproduce (refused). So worktrees share the repo root's memory. On
this Mac: `-Users-aleks-Github-team2027-evals/memory` has 269 entries and none of its 7 `--claude-worktrees-*`
slugs has a memory dir; the old code took the pinned transcript's slug (a worktree's) and found nothing.

Dream (`~/.claude/skills/dream`, `.dream-config` = `native`) consolidates every `projects/*/memory/` and keeps
per-project state beside it: `memory/.last-dream` (unix seconds; 49 on this Mac) and a first-run backup
`memory-backup-<YYYYMMDD>/`. Both move. `~/.claude/.dream-pending` is a machine-wide flag: it stays.

What moves (src/teleport-memory.ts): the canonical dir, plus memory under the folder's own slug, the pinned
session's project dir, the repo's worktrees (`git worktree list`) and Claude Code's `<repo>/.claude/worktrees/*`
slugs (removed ones too) — older Claude Codes keyed memory per folder. Merged by path inside the dir:
identical = one file, `.last-dream` = the newest stamp, anything else different = a clash that blocks. It
lands in the dir the TARGET keys the folder by: the probe runs the same walk there (the repo's paw clone
for `--repo`, which is also every worktree's key). A different file already there blocks (never
overwritten) unless it is this agent's own older copy (`--back`, or a `teleported:` persona there);
identical files aren't re-sent. An `autoMemoryDirectory`/env override refuses `--memory`. Plan:

```
  memory     5 files, 40 B  → /data/home/.claude/projects/-data-home--paw-repos-x-evals/  (keyed by /data/home/.paw/repos/x/evals)
             4 file(s)  ~/.claude/projects/-Users-aleks-Github-evals/  (the repo root — Claude Code's key)
             3 file(s)  ~/.claude/projects/-Users-aleks-Github-evals--claude-worktrees-feat-x/  (its session's project dir)
```

## Folder

A cwd that is not a git checkout (mcp-intern: `~/.cache/firegoat-ideas/mcp-arena`, 103M of scripts and
state with 0600 `state/secret_*`) used to get an empty `<PAW_HOME>/agents/<name>`. With `--folder` its
whole tree moves there (src/teleport-folder.ts): one `tar` of `.` from the cwd, unpacked with `tar -x -p`,
so file AND directory modes stay (0600 stays 0600, a 0700 dir stays 0700) and symlinks stay links. Then the
final pass after the stop re-sends what changed (size, mtime or mode). Destination: `<PAW_HOME>/agents/<name>`
there, not the same absolute path — HOME differs between boxes, and that folder is paw-managed under any
PAW_ROOT; transcripts' `cwd` fields are rewritten as for any moved folder. Files that name the old absolute
path are listed (`note … still point there`). A destination that exists and isn't empty refuses, unless it
is this agent's own earlier copy; a folder this run created is removed again if the run fails. A HOME or
`/` cwd refuses. The plan:

```
  files      1234 file(s), 103.0 MB — the whole folder, modes kept (0600 stays 0600)
             3 secret-looking (names only, contents never shown): .env, keys/a.key, state/secret_openai
```

Secret-looking = `secret*`, `*.key`, `.env*`, or mode without group/other bits.

## What it needs there

Host dependencies, from evidence only (src/teleport-deps.ts), checked by the probe, printed as WARNINGS:

- commands: the binaries its Bash tool calls ran (every `tool_use` named Bash in its session chain; a light
  shell tokenizer: past `VAR=` and `sudo`/`env`/`timeout N`, split on `; && || | ( ) $(`, quoted words and
  heredoc bodies are arguments, builtins skipped), kept only when `command -v` resolves them HERE;
- files: `~/…`, `$HOME/…`, `${HOME}/…`, `<HOME>/…` paths outside its folder named by its own files (the
  tree for a non-git folder, the tracked files in it for a repo), kept only when they exist here;
- plugins: enabled here (`settings.json` enabledPlugins), missing there (unreadable there = "unknown").

```
  needs on ssh:mini: psql (missing), search (missing), ~/.config/cotal/config.json (missing), plugin team2027-skills@… (missing)  — warnings: it used these here
  env        1 secret file(s) its files name are NOT moved (opt in with --env; names only): ~/Github/team2027/evals/.env.prod
```

Warnings, not blockers: the agent still runs and fails only where it uses them, and paw can't install a
CLI. The secret ones among the files (`.env*`, `secret*`, `*.key`, 0600) and the gitignored files in a repo
folder that its files name (`.env.prod`) move only with `--env` — to the same HOME-relative path, or the same
place inside the agent's folder there; names only in every line, modes kept, and a different file already
there blocks (never overwritten; also re-checked with `cmp` when placing).

## --force

`ssh:mini already has an agent "x" … not a teleported copy` used to be final. `--force` replaces it:

```
  replace    --force: ssh:mini's own "firegoat-cli" (claude, not a teleported copy) is replaced:
             persona  /Users/x/.paw/spaces/team2027/personas/firegoat-cli.md → moved to /Users/x/.paw/spaces/team2027/personas/replaced-by-teleport/firegoat-cli.20261023T221500Z.md (never deleted)
             session  resume: <id> — its transcript stays where it is there
             folder   /Users/x/.paw/repos/team2027/firegoat-cli
             live     yes — pid 4242 holds its session there; stopped there first
```

Live = a live pid in Claude Code's per-process index there (`~/.claude/sessions/<pid>.json` with its pinned
`sessionId`). After the confirm, before any copy: `paw stop <name>` there, then the persona is MOVED to the
backup (a subdir, so out of the persona listing; an existing backup refuses). Then the normal cutover. The new
copy never inherits the replaced agent's `resume:` pin (that is another agent's session): without `--session`
it gets a fresh one. Mesh: every present peer under the name must be accounted for — this machine's seat, and
with `--force` the target's copy only when a live claude there holds its session; after its stop teleport waits
≤30s for that presence to leave, else (a third machine) it aborts. Without `--force`, both refusals name it.
A failure anywhere after the replace puts its persona back over teleport's and restarts it if it ran.
`--force` bypasses nothing else: logins, CLAUDE.md/skill/memory/secret differences, bead collisions, a dirty
or stale repo all still block. `--back --force` is refused.

## Repo: a stale source, a failed mirror

- A clean source that is BEHIND its upstream (`<remote>/<branch>` as last fetched) blocks in preflight: a
  fresh clone there starts from that newer branch, and teleport never moves the agent to another commit
  silently — `git -C <top> merge --ff-only origin/main` first (diverged: rebase/merge). The apply script says
  the same when the target's branch turns out ahead because the source's tracking ref was stale (the source
  HEAD is an ancestor there): "the source checkout is stale, not ahead; fast-forward it".
- A clone or worktree the mirror creates is removed again when the same run fails — inside the script (an
  EXIT trap: the half-made no-checkout clone with every file staged-deleted, which blocked the retry), and by
  the rollback for a failure later on (`removeCreatedScript`, only a git checkout this run recorded). A clone
  or folder that was there before is never removed.

## Cutover (never two writers)

1. Preflight — source: persona, folder, harness (claude/kit/acp), not foreground, not already teleported,
   the space is a REMOTE mesh (an agent on the local `paw` space is refused: only this Mac serves it), not
   running on a third machine (roster + this machine's manager ps). Target (its HOME/PAW_HOME first, which
   fix the folder; then one probe script): paw on PATH, `paw __teleport probe` answers `paw-teleport 2`
   (its paw honours the marker, takes a moved folder and serves `--back`), a
   record for the space, no different agent of that name, logins, fly root-fs (see below), the repo's
   clone/worktree state there and the agents in it, CLAUDE.md/skill hashes, free disk.
   Every blocker is listed at once, with its fix.
2. The plan with sizes. `--dry-run` stops here (exit 1 when blocked).
3. Confirm on a tty unless `--yes` (a pipe without `--yes` refuses).
4. `--force`: stop + set aside the target's own agent. Copy (tar stream), mirror the repo, the folder.
5. Stop it here; wait (≤30s) for its claude to release the session file.
6. Re-read the manifest and send what changed during the copy (whole files; a big transcript is re-sent);
   `--env` files are placed now.
   `--beads`: import its beads there and verify them ([Beads](#beads)).
7. Write the persona there, run the target's own `paw start <name>`, wait (≤180s) until a present peer of
   that name with a NEW id is on the mesh (the old seat's lingering presence never counts).
8. Mark this persona `teleported: <transport>`, `teleportedAt:`, `teleportedWhat:`, `teleportedCwd:` (the
   folder it runs in THERE — since 2026-10-23; older markers and `--back`'s `origin` have none); close the moved beads here.

A failed step 7 rolls back loudly: `paw stop` there + mark that copy `teleported: origin` (+ close its imported beads), restart here.
The end prints everything written on both sides and the undo (`paw teleport <name> --back`).

`--back` is the same cutover with the sides swapped: source steps run on the target's paw through the
hidden `paw __teleport manifest|stop|mark`, the destination probe runs here. The target's copy ends
marked `teleported: origin`.

## Beads

Every agent files into ONE machine-wide beads db (`BEADS_DIR=~/.beads`, `PAW_BEADS_DIR` overrides it;
src/beads-dir.ts), and each machine has its own, so without `--beads` a teleported agent loses its work
list. src/teleport-beads.ts.

- **What moves:** the non-closed beads ASSIGNED to the agent (`assignee == <name>`). Beads it only
  created (`created_by`, from `BEADS_ACTOR`) and that someone else (or no one) holds stay: they are fleet
  backlog. The plan shows both: `beads      172 open, assigned to evals → ssh:mini's /Users/x/.beads · 17
  it created (assigned elsewhere) stay here`, plus the dependency links that won't carry.
- **How:** bd's own JSONL round-trip, run through the same transport as everything else. `bd export` on the
  source (the whole db, each line an issue with its labels, dependencies and comments; filtered in paw, no
  child-to-child pipe) → those lines on stdin of `bd import - --json` on the target. Ids are kept (also
  across a different db prefix); dependencies between moved beads survive; a dependency on a bead that
  stays is skipped by bd (`skipped_dependencies`) and listed in the plan. Then the target is exported again
  and every moved id must be there, open, assigned to the agent — or the teleport rolls back.
  Checked on bd 1.2.2; the target's bd needs `bd import --allow-stale` (probed from `bd import --help`)
  only when it holds earlier teleported copies.
- **Ownership — one open copy:** the import runs after the stop and before the target's `paw start`; the
  source copies are closed only after the presence wait, with `bd close --force --reason "teleported to
  <transport>"` (`--force`: bd refuses to close a bead an open bead still blocks, and since bd 1.3.1 one assigned to
  anyone but the actor — a moved bead is the agent's) and verified by export.
  Never deleted. `--back` closes the target's copies with `teleported to origin`. A failed import leaves
  the source untouched; an import followed by a failed start closes the target's copies again (`teleported
  to origin (rolled back)`). A source bead changed after the export is closed anyway and named loudly.
  A failed close at the very end prints the `bd close …` to run by hand and exits non-zero.
- **Preflight:** bd on PATH there and `bd export` of its db works (else the fix: `bd init` or
  `--no-beads`); any moved id already in the target's db is a collision and blocks, unless it is a closed
  bead whose reason starts `teleported to ` — its own earlier copy, which the import reopens with
  `--allow-stale` (bd's import otherwise keeps the newer local row, and the closed copy is newer).
- Closing the source copy unblocks beads here that depended on it — a bd close is the closest idiom bd has
  for "moved"; there is no status for it.

## The marker

`ensureAgentSpawned` (src/addressing.ts) refuses a persona with `teleported:` before touching the manager —
every wake path (dm, chat, start, restart revival, sleep wake) funnels through it:
`"<name>" was teleported to <to> at <t> — it runs there now; paw teleport <name> --back brings it back`.
A DM to a teleported agent that IS present reaches the copy on the target (no spawn here) — correct.

Everything else here is the FROZEN copy from before it left (persona cwd, transcript, folder), so every
local-only feature asks `runsElsewhere` (src/hosted.ts) first and says where it runs instead: chat's
header/logs/`!cmd`/attachments, `paw log` + the web trace, web `!cmd`, `paw dm` with a file, `paw attach`,
and `paw status` (live/mesh from the roster, no ctx/failure/last-active/inbox/git, never "unmanaged").
Strings and the feature table: [chat.md#remote-agents](chat.md#remote-agents).

## Fly specifics

- Fly resets the root filesystem on every deploy. Folders now land under the target's PAW_HOME
  (`/data/home/.paw` on agents-host, the volume), but the probe still reads `df -P` of the nearest existing
  parent and blocks on mount point `/`.

## Out of scope (v1)

Harnesses other than claude/kit/acp (codex/opencode/hermes: their logins and state aren't named here);
plugins; git submodules and LFS; ignored files; delta transfer (changed files re-sent whole); agents on a
local-only space; a target on a different broker for the same space name (the presence wait times out and
rolls back); paths inside persona values and message text are not rewritten; the source folder's files
when moving without the repo.

## Tests

- `pnpm check:teleport` — hermetic: `--force` (the plan's replace lines, the refusal naming it, the mesh
  accounting, the replace/restore scripts with a stub `paw` and the backup byte for byte, the live pid from a
  fixture session index, and logins/CLAUDE.md/skills/beads/memory/dirty repo still blocking under it); memory
  (a worktree keyed by the main checkout, the merge with dream's `.last-dream` + `memory-backup-*`, a clash,
  a different file there, the sh walk there); folder (a non-git tree with a 0600 secret, a 0700 dir, a symlink
  moved for real with modes kept, the delta pass, the non-empty refusal); host deps (the tokenizer, home refs,
  commands/files/plugins missing there, `--env` placed 0600 and never overwriting); the stale-source blocker
  and the self-cleaning clone; plus args/transport parsing, fly machine count, the checklist reducer, the
  chain on fixture transcripts (a record past the 1 MB scan chunk, an escaped one in message text), the
  manifest, the dirty-repo refusal, the probe parse and every blocker, the plan, persona keys, the
  wake-gate refusal (before any manager call), and the pack/unpack/repo/persona scripts run for real
  between two temp HOMEs (bundle → fresh clone at the unpushed HEAD; dirty or ahead target refused).
  Beads run for real against two temp bd dbs (`bd init` in temp dirs, `PAW_BEADS_DIR` — never `~/.beads`):
  what moves vs stays, the plan lines, every beads blocker (no bd, no db, a collision, a missing
  `--allow-stale`), a failed import leaving the source open, import → verify → close with the marker, and
  `--back` reopening the closed copies with what was written on the target.
- `COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-teleport.ts` — the real `ssh:` transport to a
  Docker container (sshd + this checkout's paw) on a private JWT+TLS broker, an acp agent with a scripted
  ACP agent (no login anywhere). HOME differs (a temp dir here, /root there). Repo case: a GitHub-URL remote
  served by a bind-mounted bare repo via insteadOf → lands in `/root/.paw/repos/e2e/repo` with its unpushed
  commit; memory in that clone's project dir; the box runs it, a DM here reaches it there, with it down a DM
  here refuses, `--back` (back to its own path), the box's `paw start` refuses its copy, a failing `paw start`
  there rolls back here. No-repo case: `/root/.paw/agents/tele2` created, nothing of the source folder
  copied, memory in the new project dir, `--back` restores the folder and slug. A claude agent on a dirty
  30-file repo: `--all` refused with 10 paths + "… and 20 more" + `--no-repo`; the no-repo dry run (a fake
  `claude auth status` there) passes; its continued-in chain + subagent moved over ssh land in
  `-root--paw-agents-intern/` with every `cwd` rewritten by `paw __teleport rewrite-cwd` there. 58 checks,
  ~1.5 min with the image cached.
  It found the acp seat's missing private-CA env (src/acp.ts now adds `remoteTlsEnv` like the claude
  connector).
