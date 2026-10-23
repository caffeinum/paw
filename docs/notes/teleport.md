# paw teleport

```
paw teleport <agent> --to fly:<app>[/<machine-id>] | ssh:<host>  [--all | --session --repo --skills --memory --claude-md] [--dry-run] [--yes]
paw teleport <agent> --back [--dry-run] [--yes]
```

`--no-<one>` trims the list: `--no-repo` alone = everything but the repo (= `--all --no-repo`).

## Where the agent's folder lands (never the source path)

- **without --repo** → `<target PAW_HOME>/agents/<name>`, created by teleport. Nothing from the source
  folder moves; files the agent writes there stay there on `--back`.
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
- **skills** — `~/.claude/skills/*` (dirs; a linked skill lands as a real dir; dot-dirs skipped). Enabled
  plugins are LISTED as not moved (v1). Project `.claude/skills` travel with the repo.
- **memory** — `~/.claude/projects/<slug>/memory/`.
- **claude-md** — `~/.claude/CLAUDE.md`.
- A different CLAUDE.md or skill already on the target is a blocker, never an overwrite; an identical one
  is skipped (`filesToSend`). Paths land under the target's HOME at the same HOME-relative path.
- **Logins are never copied** (claude, kit, gh, ssh keys). The probe checks `claude auth status`
  (`loggedIn`), `kit auth status` (the persona's provider), and `git ls-remote <url>` from the target.

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
4. Copy (tar stream), mirror the repo.
5. Stop it here; wait (≤30s) for its claude to release the session file.
6. Re-read the manifest and send what changed during the copy (whole files; a big transcript is re-sent).
7. Write the persona there, run the target's own `paw start <name>`, wait (≤180s) until a present peer of
   that name with a NEW id is on the mesh (the old seat's lingering presence never counts).
8. Mark this persona `teleported: <transport>`, `teleportedAt:`, `teleportedWhat:`, `teleportedCwd:` (the
   folder it runs in THERE — since 2026-10-23; older markers and `--back`'s `origin` have none).

A failed step 7 rolls back loudly: `paw stop` there + mark that copy `teleported: origin`, restart here.
The end prints everything written on both sides and the undo (`paw teleport <name> --back`).

`--back` is the same cutover with the sides swapped: source steps run on the target's paw through the
hidden `paw __teleport manifest|stop|mark`, the destination probe runs here. The target's copy ends
marked `teleported: origin`.

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

- `pnpm check:teleport` — hermetic: args/transport parsing, fly machine count, the checklist reducer, the
  chain on fixture transcripts (a record past the 1 MB scan chunk, an escaped one in message text), the
  manifest, the dirty-repo refusal, the probe parse and every blocker, the plan, persona keys, the
  wake-gate refusal (before any manager call), and the pack/unpack/repo/persona scripts run for real
  between two temp HOMEs (bundle → fresh clone at the unpushed HEAD; dirty or ahead target refused).
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
