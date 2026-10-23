# paw teleport

```
paw teleport <agent> --to fly:<app>[/<machine-id>] | ssh:<host>  [--all | --session --repo --skills --memory --claude-md] [--dry-run] [--yes]
paw teleport <agent> --back [--dry-run] [--yes]
```

Moves an agent from this machine to another box, and back. v1 (2026-10-22). Code: `src/teleport.ts`
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
- **repo** — same remote URL, same branch, same HEAD, at the SAME absolute path on the target, so a
  transcript's `cwd` and its project slug need no rewriting. Unpushed commits (`HEAD --not
  --remotes=<remote>`) go as a git bundle. A dirty tree (tracked changes or untracked files) is refused
  with the list. On the target: clone if absent; an existing checkout must be the same URL and clean, and
  its branch may only move forward to the source HEAD. `.gitignored` files (.env, node_modules) don't move.
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
   running on a third machine (roster + this machine's manager ps). Target (one probe script): paw on PATH,
   `paw __teleport probe` answers `paw-teleport 1` (its paw honours the marker and serves `--back`), a
   record for the space, no different agent of that name, logins, PAW_ROOT confinement of the mirrored
   folder, fly root-fs (see below), the repo state there, CLAUDE.md/skill hashes, free disk.
   Every blocker is listed at once, with its fix.
2. The plan with sizes. `--dry-run` stops here (exit 1 when blocked).
3. Confirm on a tty unless `--yes` (a pipe without `--yes` refuses).
4. Copy (tar stream), mirror the repo.
5. Stop it here; wait (≤30s) for its claude to release the session file.
6. Re-read the manifest and send what changed during the copy (whole files; a big transcript is re-sent).
7. Write the persona there, run the target's own `paw start <name>`, wait (≤180s) until a present peer of
   that name with a NEW id is on the mesh (the old seat's lingering presence never counts).
8. Mark this persona `teleported: <transport>`, `teleportedAt:`, `teleportedWhat:`.

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

## Fly specifics

- Fly resets the root filesystem on every deploy: a mirrored path like `/Users/aleks/Github/x` would be
  wiped. The probe reads `df -P` of the nearest existing parent; mount point `/` on a fly target blocks.
  The fix is on the box (a bind mount from the volume, e.g. `/data/mirror/Users` onto `/Users`, done at
  boot) — paw does not invent one. A symlink is NOT enough: claude's cwd (and so the project slug) would
  resolve to the link target and the transcripts would not be found.
- agents-host sets `PAW_ROOT=/data/repos`: a mirrored `/Users/...` folder is outside it and blocks until
  PAW_ROOT is widened (or PAW_ALLOW_ANY_CWD=1) in the image ENV.

## Out of scope (v1)

Harnesses other than claude/kit/acp (codex/opencode/hermes: their logins and state aren't named here);
plugins; git submodules and LFS; ignored files; delta transfer (changed files re-sent whole); agents on a
local-only space; a target on a different broker for the same space name (the presence wait times out and
rolls back); rewriting paths in transcripts (the mirror makes it unnecessary).

## Tests

- `pnpm check:teleport` — hermetic: args/transport parsing, fly machine count, the checklist reducer, the
  chain on fixture transcripts (a record past the 1 MB scan chunk, an escaped one in message text), the
  manifest, the dirty-repo refusal, the probe parse and every blocker, the plan, persona keys, the
  wake-gate refusal (before any manager call), and the pack/unpack/repo/persona scripts run for real
  between two temp HOMEs (bundle → fresh clone at the unpushed HEAD; dirty or ahead target refused).
- `COTAL_BIN=<cotal-ai@0.84.0>/dist/cotal.js node scripts/e2e-teleport.ts` — the real `ssh:` transport to a
  Docker container (sshd + this checkout's paw) on a private JWT+TLS broker, an acp agent with a scripted
  ACP agent (no login anywhere): dry run, teleport (repo with an unpushed commit, memory, skill,
  CLAUDE.md), the box runs it, a DM here reaches it there, with it down a DM here refuses, `--back`, the
  box's own `paw start` refuses its copy, and a failing `paw start` there rolls back here. ~1 min with the image cached.
  It found the acp seat's missing private-CA env (src/acp.ts now adds `remoteTlsEnv` like the claude
  connector).
