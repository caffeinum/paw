# Addressing: registry, adopt, rm, rename, worktrees, github

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## src/addressing.ts

- `src/addressing.ts` — folder→agent addressing. The mesh carries an agent's NAME but not its cwd
  (neither presence/roster nor `ps` expose it), so paw owns a per-space folder→name registry under
  `~/.paw/spaces/<space>/folders.json` (basename, collision-qualified with a path hash so two
  folders never share one agent). Plus `ensureAgentSpawned` (ps→spawn through `src/control.ts`),
  `ensurePersonaFile`, `controlCreds` (now only `paw status`'s JetStream read — see the control-rail
  section), `waitForPeerId`, and a stable per-space human id (`human.id`, for open-mesh reply
  redelivery).
  **Multi-instance (`agents.json` extras side-table):** N claude agents per folder. `folders.json`
  (`Record<folder, defaultName>`) holds each folder's DEFAULT agent — **UNCHANGED**, still one name per
  folder; `agents.json` (NEW, `Record<extraName, folder>`) holds ONLY the EXTRAS (2nd+ instances). An
  agent lives in EXACTLY one file — default in folders.json, extra in agents.json, NEVER both → nothing
  to sync → cannot desync; an absent `agents.json` (every existing 1:1 install) → `{}`, byte-identical
  to today. `--name <n>` on `paw chat`/`dm`/`open` spawns/addresses an extra at a FOLDER target
  (`registerInstance(space, folder, name)` writes agents.json under the SAME lock as folders.json,
  fail-loud if `name` cleans to empty or is already taken by any default/extra); no `--name` → the
  folder's default, unchanged. **Bare folder addressing (`paw chat .` / `paw attach .` / `paw dm .`)
  hits the DEFAULT when one exists** — extras stay opt-in via `--name`. **No default + exactly one extra
  → that extra** (`resolveFolderAgent`): `cd ~/paw-opencode && paw chat .` reaches `opencode1` (agent:
  opencode), it does NOT mint a sibling claude in folders.json. Several extras and no default → fail
  loud. `ensureAgentSpawned` already forwards persona `agent:` so the extra respawns as itself. Test:
  `check:addressing`. Global name-uniqueness is preserved across
  `Object.values(folders.json) ∪ Object.keys(agents.json)`: `folderToName`/`setFolderName`'s `taken` set
  now unions agents.json keys, `folderForName` falls back to `readAgentIndex(space)[name]` (resolves both
  a default and an extra), `listAgents`/`agentNamesForFolder` union the extras, `removeAgentName` drops an
  extra (leaving the default; `removeFolder` still drops a folder's default). Worktrees (`repo@branch`)
  stay the answer for parallel agents in SEPARATE dirs — this is specifically the SAME dir. New exports:
  `readAgentIndex`/`writeAgentIndex`, `registerInstance`, `agentNamesForFolder`, `resolveFolderAgent`, `removeAgentName`. Test:
  `check:addressing` (+ `check:concurrency` for the N-way `registerInstance` race).
  **Wake gate (`spawnAction`/`psRowAlive`, pure + unit-tested):** `ensureAgentSpawned` decides
  start | reuse | **restart** from the manager's ps ROW LIVENESS (`status`/`mesh`), not mere
  name-in-list. A crash/bounce leaves an agent LISTED but dead on the mesh (`status:"running",
  mesh:"offline"` — a process alive but its mesh link gone); the old gate reused any listed name, so
  `paw dm`/`paw chat` could neither wake it (skipped as "already running") nor reach it (not consuming)
  → timeout. Now a listed-but-dead row (`mesh:"offline"` or `status:"exited"`) → **restart** (ADMIN
  stop the zombie, then start fresh/resumed); `"absent"` (mid-start) counts as alive so a legit boot
  isn't killed — **but that is BOUNDED at the spawn site (`STARTING_GRACE_MS`, 2026-08-12)**: a boot
  that FAILS sits at `starting…` forever, so every wake path reused it and timed out — `paw chat
  research` said "isn't reachable on the mesh" against an agent listed as starting for THIRTEEN HOURS,
  and the suggested `paw down` wouldn't clear it either (the manager relists it on the way back up).
  The one state meaning "wait" was the one state nothing could recover from. `ensureAgentSpawned` now
  `waitForMeshLive`s an `absent` row for 15s and, failing that, RESTARTS it. The pure gate stays
  permissive (killing a live boot only costs a resume; the alternative cost 13h of unreachability). `paw status` uses the same `psRowAlive` so it agrees with `paw ps` (previously it marked
  any listed name "live", disagreeing).
  **Busy-guard (2026-08-27):** the restart branch used to despawn SILENTLY, and it fired on agents
  that were merely BUSY — a claude deep in a deploy/test run lags its presence, reads `mesh:"offline"`,
  and the next `paw dm`/`/api/dm` killed it mid-command ("my deploy got killed right after an inbound
  DM", research + queue-ea; queue release v119 stuck at `running` was this). `restartDespiteOffline`
  (pure, `check:addressing`) refuses the restart when the pinned transcript was written within
  `BUSY_GUARD_MS` (3 min) — the same local truth `inferBusy` uses; the DM simply waits in the durable.
  Every restart now logs its EVIDENCE (ps status/mesh + transcript age) to stderr, so the next kill
  is attributable in one grep instead of a week of symptom reports. Verified the counter-hypothesis
  with harbor: a 194s FOREGROUND command survived three mid-run DM deliveries untouched — DM delivery
  does not interrupt tools at the claude layer. SCOPE: this covers queue-ea's class (operator DM →
  despawn). research's dead `run_in_background` watchers were NOT this (its session context was
  continuous — no respawn happened). MEASURED cause, 2026-08-27, in this session: **the claude harness
  reaps a turn's `run_in_background` Bash tasks when that TURN ENDS** — a heartbeat task armed at a
  quiet moment beat at 10:47:44/10:47:54 and was dead by 10:48:04, the moment the turn closed, with no
  DM in flight and a 600s timeout untouched. The `status: killed` notice surfaces at the NEXT wake,
  which under dense DMs is always a DM's UserPromptSubmit — hence the false correlation. Monitor
  watches are session-scoped and survive. The brief now tells agents so. Two traps worth keeping (research's
  words): "the timestamp on a `killed` notification is the next wake, not the death" — notification
  times alone build the wrong model; and the respawn-vs-reap discriminator is whether the session's
  CONTEXT survived (a respawn destroys it, a reap doesn't). cotal's tmux
  runtime also exposes `interrupt()` = Ctrl-C into the pane, but nothing in the manager calls it.
  Side-find filed upstream (cotal feedback 80f52a2c): one DM to a mid-turn agent is delivered
  repeatedly (3× in 194s; 37× to a sleeping agent) — unacked-DM redelivery re-fires the wake nudge. Refined by research's controlled capture (addendum filed): an IDLE recipient with current
  presence gets exactly one delivery and it WAKES a turn (UserPromptSubmit) — redelivery is specific
  to recipients that can't ack promptly (mid-turn / asleep). RETRACTED same hour (research, correctly): a
  failed cotal_dm to paw-folder (`no peer "paw-folder"`) looked like presence lag on a healthy idle
  agent, but paw-folder's INSTANCE ID changed between research's two messages — the send landed in a
  reconnect/restart gap where there genuinely was no peer, i.e. the resolver was right. "Recently
  active" (`ACTIVE 14s`) does not mean "continuously alive". The busy-guard stands on queue-ea's
  killed deploys and v119 alone; do not cite the roster flake. Reproduced live: killing an agent's connector (mesh drops,
  process lives) makes the zombie; `paw dm` then restarts it back to idle, old proc reaped.
  **Spawn contract (cotal ≥ the v0.7 line):** the manager REQUIRES a persona file to start an agent
  (a bare name → `.cotal/agents/<name>.md` that must exist — no silent default-ACL fallback). paw,
  which addresses by folder, auto-generates a minimal ephemeral persona at
  `~/.paw/spaces/<space>/personas/<name>.md` (its `name:` is the agent's mesh identity) and spawns
  via `--config <abs>`. `ensureAgentSpawned` also forwards cotal's per-agent `--model` override.
  **Channel grants (`GRANT_LINES`/`withChannelGrants`, 2026-08-06):** that minimal persona now declares
  `allowSubscribe: [">"]` + `allowPublish: [">"]`. cotal's defaults are tight ON PURPOSE — an omitted
  `allowSubscribe` means "read exactly what you `subscribe` to" (itself defaulting to `[general]`) and
  an omitted `allowPublish` is a hard DENY (publishing is the dangerous capability, so it must be
  declared) — and paw declared NEITHER, so every paw agent could read only #general and post to NO
  channel: `cotal_join("team2027")` failed with "not within this agent's read ACL", and the whole
  channels surface (`paw web`, `cotal_send`) was inert for paw-spawned agents. `>` matches every channel
  (`channelInAllow`); it's the honest grant HERE because a channel ACL isn't a boundary in paw — agents
  already run `bypassPermissions` with full machine access and can read any channel through the CLI
  regardless of their mesh cred — and a narrower list isn't knowable, since channels are created at
  runtime. **`subscribe` is deliberately LEFT at `[general]`:** the ACL says what an agent MAY read,
  joining stays its own runtime act (`cotal_join`), so permission doesn't mean being woken by every
  channel in the space. **Quoting is load-bearing** — a bare `>` is YAML's folded-block indicator (the
  frontmatter is parsed as real YAML), so it must be written `[">"]`; `[>]` is a parse error. Existing
  personas SELF-HEAL on their next spawn (`ensurePersonaFile` upgrades write-if-absent PER KEY, so a
  persona that already states its own scope is never widened) — which means an ALREADY-LIVE agent keeps
  the old ACL until it restarts, since the cred is minted at launch. Test: `check:addressing`.
  **Ambiguity guard:** `assertUnambiguousTarget(space, target)` fail-louds when a BARE positional is BOTH
  a registered agent name AND the basename of a DIFFERENT folder in the cwd (the `paw log .`/`paw log
  <name>` wrong-session class). Exempts sigil-carrying targets (`.`, `./x`, `/x`, `~…`, `github:`,
  `<repo>@<branch>`). Called by chat/dm/open/log/rm/rename/adopt/sessions right after the space resolves.
  Tested hermetically in `check:addressing`.

## unmanaged agents

- **An agent alive outside the current manager is REUSED, never duplicated (2026-10-05).** cotal ≥0.49
  spares a stopped manager's agents and the next manager does not adopt them (re-verified on 0.66.1 with
  the tmux runtime: SIGTERM the manager → claude keeps running, a fresh manager's ps is empty). The wake
  gate used to decide liveness from ps alone, so `paw chat @evals` tried to start a second evals and the
  two-writer guard refused with a misleading "`evals_2`-style duplicate" hint. Now, when ps lacks the
  name, `findUnmanagedAgent` asks two witnesses — the presence roster (`src/roster.ts`: live status +
  heartbeat < `ROSTER_FRESH_MS`, `paw sleep` stand-ins excluded) and a mesh process holding the name's
  pin whose env says `COTAL_NAME=<name>`/`COTAL_SPACE=<space>` (`meshIdentity`, `ps -E`). Either ⇒
  `{spawned:false, unmanaged:true, id}` and one dim line: `<name> is running but not managed by the
  current manager — talking to it directly; paw restart <name> re-adopts it`.
- `restartAgent` makes that note true: a name not in ps but held by its own mesh process gets that
  process SIGTERMed (operator-invoked only — `paw restart <name>`, adopt, `paw claude`), then a normal
  spawn with `reuseUnmanaged: false` (a just-stopped copy can still look live for seconds).
- When paw still refuses, `twoWriterRefusal` says it plainly: a standalone claude → `paw adopt "<cwd>"
  --resume <pin> --force`; a REAL duplicate (another COTAL_NAME on the pin) is named, and `paw stop <dup>`
  only when ps lists it, else `kill <pid>`; no invented `_2` hint.
- E2E: `scripts/e2e-unmanaged.ts` (own nats, real haiku agent, kill manager only → dm/chat reach it
  without a spawn → status `live (unmanaged)` → `paw restart <name>` re-adopts).

## paw adopt

- `src/adopt.ts` — `paw adopt [folder] [--resume <id|name>] [--name <n>] [--no-start] [--no-attach]` (`--session` aliases `--resume`):
  bring a PAST **or running** claude session back as a LIVE paw agent, **one step**. With no `--resume`,
  auto-picks the folder's NEWEST session via `latestSession` — **including one a live claude holds**. The
  two-writer guard then REFUSES + proposes `--force` (a takeover) when that newest session is live, rather
  than silently skipping to an OLDER session and leaving the running claude behind (the confusing "adopt
  succeeded but nothing was taken over" case — 2026-07-09). This EXPLICIT refuse-and-propose replaced the
  old `latestUnconflictedSession` silent-skip: `paw adopt ~` now surfaces "your live session is here —
  `--force` to take it over" instead of quietly mis-pinning an older one (which is still safe against the
  original `aleks` home-folder mis-pin, just louder). An
  explicit `--resume <id|name>` is honored exactly (the two-writer guard still warns/refuses there).
  Resolves under `~/.claude/projects/<encoded-cwd>/` — `--resume` accepts a transcript
  id OR a **named session** (`claude --session-name`/`/rename`), resolved name→id via `src/named.ts`,
  and VERIFIES the transcript's recorded
  `cwd` matches (the project-dir encoding is lossy; rejects a session-id with `../`), upserts
  `resume: <id>` into the folder's persona (CRLF-safe, never clobbers a frontmatter-free body), then
  `ensure()`s the mesh+manager and brings it live — but only **`restartAgent`** (stop + respawn) when
  the resume pin actually CHANGED; re-adopting the SAME session uses `ensureAgentSpawned` (no-op if live)
  so it doesn't churn the agent or leave ghost presence entries. The agent is **named after the session
  if it's named** (`/rename` → `folderToName(space, folder, sessionName)`), else the folder basename
  (first registration wins). A session id recorded under a different worktree → an error naming the
  owning folder (`locateSession`). `--no-start` keeps it pin-only/local (no mesh, no spawn). The connector's
  `resume:` injection makes the spawn launch with `--resume`, so it rejoins the mesh with full history.
  **Two-writers guard:** before starting, `liveSessionProcs` (src/named.ts) checks the
  `~/.claude/sessions` index for a LIVE process holding that session id; if one is a standalone `claude`
  TUI (no `--dangerously-load-development-channels` in its command line — paw's own mesh agents carry it
  and are excluded) adopt REFUSES with a `kill <pid>` hint, since two writers on one transcript corrupt
  it. **`--force` / `paw adopt .` is a MAKE-BEFORE-BREAK takeover, not a kill-first bypass:** it brings the
  new mesh agent up and CONFIRMS its mesh link is live via the manager's `ps` (`waitForMeshLive` —
  src/addressing.ts, NOT `waitForPeerId`: the control endpoint is `watchPresence:false` so its roster is
  always empty; `op:start` already blocks until the agent registers, so the confirm returns in ~ms),
  lifting the two-writer guard via `allowForeignWriter` for the brief overlap between the new agent
  connecting and the holder dying — THEN SIGTERMs the holder(s) (wait ~8s, SIGKILL any straggler), so a
  failed spawn NEVER strands the operator with a dead session (on a confirm TIMEOUT it stops the
  just-spawned agent first, so the holder stays the sole writer). Before the inline kill it re-checks
  `isSelfAncestor` on the live holders and REFUSES to SIGTERM a process it's running inside (a `ps`
  false-negative could otherwise slip a self-held session past the early self-detection). Residual: if the
  adopted name has QUEUED DMs the new agent may take a turn inside the (seconds-long) overlap — an accepted
  tradeoff; in the self case the old claude is idle (blocked on this very command).
  **Self-adopt (`paw adopt .` from INSIDE the very claude that holds the session, 2026-07-13):** killing
  your own ancestor mid-command would kill the adopt, so when the holder is a process ANCESTOR
  (`selfSessionProc`/`isSelfAncestor`, src/named.ts) adopt hands the takeover to a DETACHED child
  (`spawnDetachedAdopt` — reparented to launchd, `COTAL_*` stripped, `PAW_ADOPT_INFLIGHT=1`, runs the
  synchronous `--force --no-attach` takeover, then `finishDetachedAdopt` drops the pidfile) that outlives
  the old claude — **no `--force` needed** (adopting the session you typed the command in is unambiguous).
  Guarded by an `adopt.pid` in-flight file (`adoptInFlight` — no stacking a second takeover) + an
  `adopt.log`, mirroring `paw restart`'s self-detach (macOS has no `setsid` → node-detached spawn). A
  NON-self takeover (`--force` from another terminal) runs the same make-before-break INLINE and, on a real
  TTY, **auto-attaches in place** via `attachResolved` (src/open.ts) unless `--no-attach`. **`--name <n>`**
  overrides the agent name (sanitized via `sanitizeAdoptName`; fail-loud if it sanitizes empty), winning
  over the session's `/rename` name. `--no-start` only warns. (paw can't stop the reverse — a `claude -r`
  you launch AFTER adopting — that's outside paw; the adopted agent's mesh name is the **folder** name
  unless `--name`/a named session sets it.) Test: `check:adopt` (self-ancestor/sanitize/parseArgs/in-flight).
  **One agent per session, and no silent re-pin (`assertSafeRepin`, 2026-09-14):** the operator ran
  `paw adopt --resume 159777dd . ` meaning "add an agent" — it re-pinned the folder's DEFAULT (`evals`
  lost its session, only a `note —` line said so), a second try with `--name arena-tier-list` pinned the
  SAME session again, and a manager-numbered `evals_2` ended up running `--resume 159777dd` beside
  `arena-tier-list`: two live writers on one transcript. The two-writer guard never saw it because both
  holders were MESH agents, which it excludes by design. Now, checked BEFORE the name is registered (a
  refusal leaves no half-made agent): (1) a session any OTHER persona in the space already pins is
  refused, `--name`/`--replace`/`--force` included; (2) an EXPLICIT `--resume` that would change an
  existing default's pin needs **`--replace`** (the refusal names both `--name <new>` and `--replace`);
  a bare `paw adopt .` keeps its re-pin-to-latest behaviour; (3) re-adopting a session an agent of THIS
  folder already runs targets that agent instead of minting an extra named after the session. Also: a
  transcript STORED under another project dir (claude started in a worktree, then cd'd — evals'
  eb587d4d lives under `…evals--claude-worktrees-feat-runtime-config-fingerprint`) but RECORDING this
  folder's cwd is now found (`locateSession` returns the dir); "not found" there had broken adopt's own
  undo hint, which now includes `--replace`. Verified live against the real registry (refusals left
  folders.json/agents.json/personas byte-identical).
  **A WORKTREE session is adoptable FROM THE REPO ROOT (`sameRepoWorktree`, 2026-09-14):** `paw sessions`
  run at the root is repo-aware and lists every worktree's sessions, but adopt refused those same ids
  ("belongs to <worktree>, not <root>") — the operator's point: "worktree sessions should be adoptable
  from the repo root, we were supposed to make worktrees invisible". An explicit `--resume <id>` whose
  recorded cwd is a worktree of the TARGET's repo (`git worktree list` from its toplevel, both
  directions) now retargets the adopt to that worktree, announcing it; the agent still registers to the
  WORKTREE's folder (that is where its cwd is). An unrelated project is still refused, naming its folder.
  The post-adopt hint names the AGENT (`paw chat <name>`), not `.` — from the root `.` is a different
  folder, and a folder target reaches that folder's DEFAULT, not the extra just adopted.

## paw rename

- `src/rename.ts` — `paw rename <folder|name> <newname>`: relabel an agent — the set is chat --fresh = new,
  adopt = resume, **rename = relabel**. `renameAgentOnDisk` (pure, unit-tested) renames the folders.json
  entry (`setFolderName`) and MOVES the persona file (resume pin + body kept, `name:` frontmatter
  rewritten to match), so the agent keeps its session. Fails loud on a no-op, an empty/invalid name, an
  unmapped target, or a name already held by a DIFFERENT folder (it pre-checks `folderForName` because
  `setFolderName` would otherwise silently hash-qualify). The first arg resolves as a known agent NAME
  (reverse lookup), a `<repo>@<branch>` worktree, or a folder path. If the agent is LIVE it's retired
  under the old name (`stopAgent`) and respawned under the new one (`ensureAgentSpawned`, resumes via
  the moved pin); if not live, only the on-disk state changes. In NEEDS_MANAGER. Test: `check:rename`.

## paw rm

- `src/rm.ts` — `paw rm <name|folder|repo@branch|github:owner/repo>`: **forget** an agent — the set is
  chat --fresh = new, adopt = resume, rename = relabel, **rm = forget**. Stops it if live (`stopAgent`), drops
  its folders.json mapping (`removeFolder` in addressing — locked RMW), and deletes its persona. The
  claude **transcript is ALWAYS kept** (it's the conversation; prints a `paw adopt --resume <id>` revive
  hint). `resolveRemoval` (exported, unit-tested) resolves the target three ways with NO spawn/clone: a
  registered agent NAME (`folderForName`), a folder/worktree/`github:` handle mapped in the registry
  (a github handle → its clone dir via `repoDir`, never fetched), or an **orphaned persona** (a
  `personas/<name>.md` with no mapping left — e.g. after a folder was re-registered under a new name).
  Fails loud if the target matches none. In NEEDS_MANAGER (to stop a live agent; no-op if offline).
  Test: `check:rm`. Pairs with the always-new birth semantics: `paw rm` then `paw chat --fresh` for a
  clean reset.

## named sessions

- `src/named.ts` — named-session resolution. `claude --session-name`/`/rename` write the human name into
  `~/.claude/sessions/<pid>.json` (the transcript file stays UUID-named), so `resolveNamedSession(folder,
  name)` scans that index for a `{name, cwd===folder}` match (most-recent wins) and `namesForFolder`
  maps id→name for the listing. Read-only; tolerates partial index files.

## github handles

- `src/github.ts` — github-handle addressing: `github:owner/repo[#branch]` (branch delim is `#`, not
  `@`) adopts a REMOTE repo by cloning it ONCE (blobless `gh repo clone … -- --filter=blob:none`, the
  upstream directly — **no fork**) into `<PAW_HOME or ~/.paw>/repos/<owner>/<repo>` and resolving to
  that folder. Idempotent (an existing `.git` checkout is reused, never re-cloned); a `#branch` is
  checked out, **CREATED if missing** (local → checkout, remote-tracking → checkout, else `checkout -b`).
  All sync (execFileSync) since `resolveFolderArg` is sync. `parseGithubHandle`/`ghCloneArgs` are pure
  + unit-tested; owner/repo validated against GitHub's charset (also blocks traversal/argv injection),
  unsafe branches (`..`, leading `/`, control chars) rejected. Fails loud if `gh` is missing or the
  clone fails (points at `gh auth status`). Test: `check:github`.

## github pasted URLs

- `src/github.ts` accepts a PASTED URL under the `github:` sigil (2026-08-24):
  `github:https://github.com/o/r`, `github:github.com/o/r/`, `github:git@github.com:o/r.git` all peel
  to `o/r` (+ `#branch` kept) — the old error `invalid owner "https:"` was true and useless.

## worktrees

- `src/worktree.ts` — worktree addressing: `<repo>@<branch>` resolves (via `git worktree list`) to the
  folder of the worktree that has `<branch>` checked out. **Strict v1: resolves an existing worktree,
  fails loud if the branch/worktree is missing (never auto-creates).** `resolveFolderArg(target)` is
  the shared entry point used by chat/open/adopt/dm — it now resolves `github:owner/repo[#branch]`
  (clone via `src/github.ts`) first, then a `<repo>@<branch>` worktree, else a plain folder.
  `paw sessions <repo>` is repo-aware: lists every worktree + the claude transcripts inside each;
  `paw sessions <repo>@<branch>` shows just that worktree.
