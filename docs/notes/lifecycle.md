# Daemon lifecycle, releases, managers, runtimes

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## src/lifecycle.ts

- `src/lifecycle.ts` — paw owns the cotal daemon lifecycle: `ensure({needMesh,needManager,space})`
  auto-starts (or adopts) a **detached** mesh + manager under a per-space lock, with readiness gates;
  `stop()` tears down only daemons paw started.
  Mesh defaults to **open** (no creds) — `PAW_AUTH=1` for JWT; never forks.
  **Manager/mailbox ownership is by COMMAND SIGNATURE, not the recorded pid** (`managerProcs`/
  `mailboxProcs` = `pgrep -f`, both exported; `managerMatchPattern`/`mailboxMatchPattern` are the
  SPACE-EXACT regexes — `cotald\.ts supervise --space <s> --server` bounded by the always-emitted
  trailing ` --server`, `paw\.ts mailbox --space <s>( |$)` bounded by end-of-arg, so `owntest-1`
  never matches `owntest-11`; the space value is regex-escaped). WHY: paw records `spawn().pid`, but
  these daemons run under tsx (a re-exec CHILD) and cotal can detach, so the recorded pid is only the
  tsx WRAPPER — correctness then hinged on the wrapper staying alive AND forwarding signals, and a
  SINGLE pid can't represent the DUPLICATE managers a night of restart churn leaves orphaned (each
  overwrote the marker). That's the 2026-07-08 bug: `paw restart` errored "no paw-owned manager",
  `paw down` left the real manager running, retries spawned COMPETING managers. Since ONLY paw ever
  starts a `cotald supervise` / `paw.ts mailbox` for a space, a pgrep match IS paw's daemon — no pid
  bookkeeping needed. `stopOwnedManager(space)`/`stopMailbox(space)` SIGTERM ALL matching procs (dups
  included), wait for the signature to clear (~4s), SIGKILL any straggler, then drop the now-secondary
  markers; both are best-effort/no-throw. `ensureManagerUp`'s ownership check (adopt-vs-switch) and
  `restartManager`'s guard both use `managerProcs(space).length > 0`; `paw restart` with NO manager
  running is not an error — it just STARTS one (and its `liveAgentNames` swallows the "no responders"
  a managerless ps throws, so a cold restart brings a manager up cleanly). The MESH kill stays a pid
  marker (`meshPidPath` from cotal's own `nats.pid`, which is correct — not a spawn() pid). Space-
  exactness is unit-tested in `check:commands`. Verified live: `paw restart` → exactly one manager
  (no dup), `paw down` → zero managers + zero mailbox, `down` on `ex1` leaves `ex11` untouched.
  **Daemons are pinned to node+tsx.** `ensureMesh`/`ensureManagerUp` start the mesh (`up --detach`)
  and manager (`supervise`) by driving **bin/cotald.ts** via `cotaldViaTsx` (exported — bin/paw.ts
  reuses it for the passthrough); `ensureMailbox` spawns the beacon through **bin/paw.ts** via the
  private `pawViaTsx` (mailbox is a paw command, not a cotal one). Both use the repo's
  `node_modules/.bin/tsx` directly, NOT the current CLI runtime — so the **CLI may run under bun**
  (fast startup) while the daemons always run node+tsx (bun can't drive node-pty's ioctl →
  bun-hosted manager = pty stubs, no agents). `isReachable` is the only cotal-core import;
  readiness still probed in-process via a `ps` round-trip. **Runtime (`resolveRuntime(space?)`):**
  precedence is `PAW_RUNTIME` env (fail-loud on garbage) > the space's **sticky preference file**
  (`~/.paw/spaces/<space>/runtime`, set by `paw runtime <r>` — `readRuntimePreference`/
  `writeRuntimePreference`; a garbage file is ignored) > `pty`. `ensureManagerUp` records the runtime
  it started under (`manager.runtime` marker, distinct from the durable preference) and RESTARTS a
  paw-owned manager when the resolved runtime differs (the setting can't switch a daemon ensure()
  merely adopts). **The RUNNING runtime is read from the live supervise proc's cmdline
  (`actualManagerRuntime` — `--runtime` flag, absent = pty), NEVER the marker:** the marker is written
  at spawn time and survives failed switches/churn, and a stale cmux marker over a pty manager made
  `paw runtime cmux` adopt-and-skip ("already running cmux") while agents spawned headless and the
  cmux tabs sat empty (2026-07-12). The marker remains only for post-kill reap paths (no process left
  to ask); `paw runtime` show/switch + `paw restart`'s summary all use the live truth. **Rollback net:** a runtime SWITCH kills the known-good old manager BEFORE starting
  the new one, so a new runtime that never comes up (cmux not installed/reachable) would leave NONE;
  if the new manager misses the readiness window, `ensureManagerUp` **rolls back** — restarts the
  previous runtime and throws loud (`… failed to start under <new> … — restored the <old> manager`) —
  so the operator always ends with a working manager (a fresh start has nothing to roll back to and
  just throws the timeout). **`restartManager({space})`** (exported) is the force-bounce `paw restart`
  needs that ensure() won't do on a same-runtime manager (e.g. after a connector edit): under the lock,
  ensureMesh → (if `managerProcs(space)` non-empty) stop the manager by signature + **`reapRuntimeUi` the
  OLD runtime's leftover windows/tabs** → ensureManagerUp → **kill + re-spawn the beacon** (`stopMailbox`
  by signature → ensureMailbox). No running manager is NOT an error — it just starts one. The beacon
  refresh is load-bearing:
  the mailbox is a LONG-LIVED daemon ensure() only ADOPTS, so a STALE beacon (old paw code / old
  @cotal-ai in its memory) keeps holding "you" under a mismatched id — e.g. a server-minted nkey rather
  than the current `stableHumanId` — and agents then reply to a "you" that `paw inbox` doesn't read, so
  replies silently vanish (the "mailbox broken" incident of 2026-07-07: a Jul-6 beacon held
  `UASTVCQU…` while inbox read `f415f5d0…`). A plain restart of the manager wouldn't fix it; bouncing
  the beacon under the current code re-registers "you" = stableHumanId and the round-trip lands again.
  **UI reap (`reapRuntimeUi(space, runtime, agentNames?)`, exported):** on a RESTART/SWITCH the old
  manager's terminal UI must be gone BEFORE revival re-creates it, else you get DUPLICATE windows/tabs
  (the `cotal-paw`×2 / `cotal-paw-folder`×2 cmux bug of 2026-07-07). The manager DOES tear its own
  children down on a clean SIGTERM — verified for **tmux** (its agent windows close; only the session
  shell survives) — but that can MISS under **cmux** (the detached daemon's socket close lags/fails on
  shutdown), so paw reaps DEFENSIVELY after `stopOwnedManager` and before the new manager/revival. tmux
  → `tmux kill-session -t cotal-<space>` (session-scoped nuke; the new manager's `ensureSession` +
  revival recreate it, so it stays at N, not 2N). cmux → each agent is its OWN `cotal-<name>` tab and
  cmux labels carry NO space, so paw can only SAFELY close the tabs of the KNOWN agents (closing every
  `cotal-*` would nuke OTHER spaces) — hence `restartManager`/the switch branch capture the live agent
  NAMES (`managerAgentNames` ps round-trip) BEFORE the stop, then `reapRuntimeUi` matches `cotal-<name>`
  in `cmux list-workspaces` and `cmux close-workspace --workspace <ref>` each. Best-effort, NEVER throws
  (a stale/unreachable cmux app can't abort the restart); pty → no-op. Both `restartManager` and
  `ensureManagerUp`'s mismatch-restart (switch) reap the **OLD/RUNNING** runtime (the one whose UI
  exists), read from the `manager.runtime` marker before it's dropped — never the new one. `stop()`/`paw
  down` drops the `manager.runtime` marker but KEEPS the preference file (a durable choice, not a daemon
  marker), and calls the SAME `reapRuntimeUi(space, runtime)` (tmux → kill-session the per-space session
  `cotal-<space>`; the manager's per-window teardown closes agent windows but leaves the session shell,
  so stopping the manager alone would orphan it; cmux no-op here — no agent names). See the Env knobs
  entry + `src/commands/runtime.ts`. **cmux reap is UNVERIFIED live** (no cmux surface in CI); the tmux
  path is tested (`paw restart` keeps the window count at N, not 2N).
  **tmux socket pinning (`defaultTmuxEnv`, 2026-07-08):** the manager is a DETACHED daemon that inherits
  whatever `$TMUX`/`$TMUX_TMPDIR` the launching shell/surface had, and cotal's tmux driver calls bare
  `tmux` (no `-L`/`-S`), so its `cotal-<space>` server could land on a socket the operator's plain shell
  never looks at → `tmux ls` reports "no server running", the session is invisible, agents effectively
  headless though marked tmux. Fix (mirrors the cmux `CMUX_*` stripping — same detached-daemon /
  inherited-surface-socket class of bug): `startManagerDaemon` STRIPS `$TMUX`+`$TMUX_TMPDIR` for the tmux
  runtime, pinning the manager to tmux's STANDARD default socket (`/tmp/tmux-<uid>/default`) — exactly
  where a fresh operator shell + `paw attach` resolve `tmux`. `reapRuntimeUi`'s tmux kill-session runs on
  the SAME default socket (else a paw launched with a stray TMUX_TMPDIR reaps the wrong socket and orphans
  the session), and `attachTmux` strips `TMUX_TMPDIR` on the non-inside (attach-session) path (the inside
  switch-client path keeps ambient env — it needs the operator's real client on that same default server).
  CAVEAT: an operator who exports a CUSTOM `TMUX_TMPDIR` in their own interactive shell must export the
  same value for a bare `tmux attach` to see the default-socket session. Verified live: a manager launched
  with a custom `TMUX_TMPDIR` still lands `cotal-<space>` on the default socket (visible + `paw attach`
  select-window resolves it); the inherited custom socket has no server; `paw down` reaps it clean.

## release discipline

- `src/release.ts` + `src/commands/release.ts` — **OTP-style RELEASE DISCIPLINE: the daemons run from an
  IMMUTABLE snapshot, never from the operator's checkout** (2026-08-21). **The incident:** every daemon
  (mesh `up`, manager `supervise`, mailbox beacon, `paw web`) resolved its entry file AND its
  `node_modules/tsx/dist/cli.mjs` from `REPO_ROOT` — `/Users/aleks/Github/paw`, the tree the operator also
  EDITS. A `pnpm add @cotal-ai/*@0.25.0` ran there while a 0.15 manager was live; the next `ensure()`
  started a SECOND manager off the half-installed tree → two managers on incompatible protocol versions →
  fleet down. Generalised: any `git checkout`, install, or half-saved edit in the repo was an unreviewed
  LIVE change to whatever daemon started next. **The fix is the OTP one — you don't mutate a running
  system, you stand a new version up beside it and cut over:** `paw release` snapshots the checkout into
  `$PAW_HOME/releases/<id>/` and flips a `current` pointer; `paw restart` (unchanged) brings the daemons
  up from wherever it now points. **The id is a CONTENT hash** (12 hex of a sha256 over
  bin/+src/+web/+package.json+pnpm-lock.yaml, sorted paths, `<relpath>\0<filehash>`), so the same tree is
  the same release (re-running is a free no-op) and a bumped dependency — which moves pnpm-lock — is a
  DIFFERENT release by construction. **Not `git describe`:** the incident's tree was DIRTY, and a describe
  would have called it the same release as the clean one it no longer was. node_modules is copied but not
  hashed (100MB+); the lockfile is the honest statement of intent, and `paw release` is a deliberate act
  you run AFTER an install, never something ensure() does behind your back (`--force` re-copies for the
  one case the id can't see). **node_modules travels as `cp -Rc`** — an APFS CoW clone, ~free, degrading
  to a real copy elsewhere; **a symlink or `cp -l` hardlink back into the checkout is FORBIDDEN — that
  aliases the bytes and IS the original bug with extra steps** (asserted: the release's inode differs).
  Immutability is content-addressing + write-once: built under a `.staging-*` name, renamed into place
  (so no reader ever sees a half-copy), never written again. **The flip is rename(2)** — a symlink made
  under a temp name and renamed over the pointer, so another process sees the old id or the new one and
  never a missing pointer (unlink-then-create would leave a window where paw has NO release, which under
  fail-loud is a command that dies for nothing; asserted from a real child process: 214k reads across 4k
  flips, 0 missing). `currentRelease` reads the LINK, never `realpathSync` — realpath rewrites the path
  through every symlink above it (a `$PAW_HOME` under `/var` comes back `/private/var`) and the release
  path would stop matching the one `paw release` printed. **`daemonRoot()` fails LOUD when nothing is
  pinned** (naming the one-line fix) rather than falling back to the checkout — the silent fallback is the
  behaviour being ended. **THE BOUNDARY:** the discipline covers what paw spawns as a child of itself —
  every `viaTsx` caller: mesh, manager, mailbox, `paw web`'s node re-exec, the detached restart/adopt
  children, and the `paw cotal` passthrough (which must speak the manager's cotal version). The
  short-lived foreground CLI still runs straight from the checkout: it exits in a second, can't drift out
  from under anything, and keeping it there keeps the dev loop fast. `PAW_RELEASE=dev` puts the daemons
  back on the checkout, printing a loud line every time (it IS the pre-incident behaviour);
  `PAW_RELEASE=<id>` pins/rolls back. **`paw release --prune N` never deletes the CURRENT release** however
  old it is — that's what the live daemons are running, and deleting it would be the outage from the other
  direction. **The pgrep ownership patterns are unaffected, and that was the load-bearing check:**
  `managerMatchPattern`/`mailboxMatchPattern` match `cotald\.ts supervise --space <s> --server` — the TAIL
  of the entry path plus flags, naming no directory — so a daemon launched from a release dir still
  matches and `paw down`/`paw restart` still find it, still space-exactly (asserted against release-dir
  argv in check:release). Had they been anchored to a path prefix, this change would have silently
  orphaned every daemon. Test: `check:release` (64 assertions: determinism, lock-sensitivity,
  immutability under a live edit + a reinstall, argv stability, cross-process flip atomicity, prune
  safety, the pgrep patterns, arg parse). Verified live on an isolated space: no release → fail loud;
  `paw release` → `ensure()` brought mesh+manager+beacon up with every daemon argv under
  `releases/<id>/`; editing the checkout changed neither the release's bytes nor the resolved argv;
  a second snapshot + `paw restart` cut over to the new dir.
  **`check:loop` and `check:spawn-env` set `PAW_RELEASE=dev`** — the first must never write into the
  operator's REAL `~/.paw/releases` or move the pointer their live daemons follow (a test must not cut
  over production), the second is about PATH/exec resolution, not which tree.

## cotal root

- `src/cotal-root.ts` — `pawCotalRoot(space)`: THE cotal root for a space, replacing every bare
  `findCotalRoot()` (which defaults to `process.cwd()`). cotal finds a checkout's root by walking UP
  from the cwd for a `.cotal/` dir — correct for cotal (one mesh per checkout), WRONG for paw, which is
  machine-wide (one space, one mesh, agents rooted in dozens of unrelated folders), so the same command
  must resolve the same root from anywhere. Precedence: `PAW_COTAL_ROOT` (escape hatch, absolute or
  fail-loud) > the space's mesh-registry entry (`recordMesh` persists `root` at mesh-up; read back with
  `findMesh`) > `homedir()` (not a guess — where `~/.cotal` lives, and what the registry holds for every
  paw space, so first-run and steady-state agree). Zero-dep leaf like `names.ts`/`cursor.ts` so both
  `lifecycle.ts` and `addressing.ts` can import it without a cycle. **The 2026-07-29 incident:**
  `~/Github/team2027` has its own `.cotal/auth/auth.json`, a LEGACY MONOLITH labelled space `"main"`.
  paw spawned its daemons with NO `cwd`, so the manager inherited the operator's shell directory,
  resolved root there, and read that repo's auth through cotal's SecretStore seam — which, unlike the FS
  reader (`loadSpaceAuth` correctly answers `undefined` for a wrong-space bundle, so the CLI itself
  degraded to open mode), fails LOUD: `the space trust bundle (auth/auth.json) failed trust-chain
  validation for space "paw"`. The manager never stayed up. The same root split made it record
  `root /Users/aleks/Github/team2027` and fight the running manager for the space's SINGLETON LEASE
  (`a manager already serves space "paw" … root /Users/aleks` / `wrong last sequence`), and
  `cotalNatsPidPath` is root-relative too, so `paw down` from there would have read
  `<team2027>/.cotal/nats.pid` and killed THAT repo's nats server. Fix is two-sided: the five bare
  `findCotalRoot()` call sites now take the space (`cotalNatsPidPath`, `probeCreds`, `ensureSpaceAuth`,
  `controlCreds`), AND every daemon spawn passes `cwd: pawCotalRoot(space)` so the daemon's OWN root
  discovery agrees with paw's. Verified live: `paw status` from inside a directory holding a
  mislabeled `.cotal/auth/auth.json` now works. Test: `check:commands`.

## nodeBin and viaTsx

- **`nodeBin` / `viaTsx` (src/lifecycle.ts)** — the daemon spawn resolves node ABSOLUTELY, never via
  PATH. `node_modules/.bin/tsx` is a shell shim whose last line is a bare `exec node …`, so spawning a
  daemon through it required `node` in the CHILD's PATH. The launcher already resolves bun absolutely,
  so the CLI itself runs from anywhere — which is exactly what hid this: **paw works right up until it
  has to START a daemon**, then dies with `tsx: line 20: exec: node: not found` buried in
  mesh.log/manager.log while the terminal shows a generic "mesh failed to start". Exposed by the
  Raycast extension (Raycast runs extensions with a minimal PATH — no shell rc, no nvm, no
  `/opt/homebrew/bin`), but a launchd job or any stripped env does the same. `viaTsx` now runs
  `<abs node> node_modules/tsx/dist/cli.mjs <entry>`; `nodeBin()` prefers `process.execPath` when that
  IS node, then the usual absolute installs, then nvm's `default` alias, and FAILS LOUD rather than
  returning a bare "node" that would fail later as somebody else's error.
  **`withToolPath` — node was only the FIRST hop.** A daemon inherits the caller's PATH and then has to
  exec `tmux`/`cmux`/`gh`/`claude` itself; on a normal macOS box every one of those lives in
  `/opt/homebrew/bin`, `~/.bun/bin` or `~/.local/bin`, none of which a stripped PATH has. So resolving
  node absolutely fixed the mesh but left the manager coming up and failing to exec `tmux` — surfacing
  as `manager started but did not answer ps within 8s (is tmux running and reachable?)`, which names
  tmux and is not a tmux problem. `daemonEnv` now BACKFILLS the missing tool dirs, and so do the tmux
  reap, the `cmux ping` probe/reap and the detached-restart wake. Missing dirs are APPENDED, never
  prepended: the operator's ordering is a deliberate choice (it is how a chosen node version or a
  shimmed binary wins) and paw only fills what isn't there at all; non-existent dirs are skipped.
  Test: `check:spawn-env`, which asserts the exec is absolute and not the shim, that a present
  tmux/cmux/gh stays reachable, that ordering is preserved — and RUNS the resolved command under a
  stripped PATH, since both bugs type-checked fine. NOT covered: a full mesh+manager COLD start from a
  stripped PATH, because `DEFAULT_SERVER` is a hard constant in core and `ensure()` takes no server
  override, so an isolated boot can't avoid the live 4222.

## explainManagerFailure

- **`explainManagerFailure` (src/lifecycle.ts, 2026-08-20)** — the manager-startup error used to dump
  ~20 lines of manager.log and ask "is tmux running and reachable?", which is the WRONG question in
  every case but one and reads as a tmux fault. It now CLASSIFIES the tail and names the cause in two
  lines: a second manager (`already serves space` / `managerProcs > 1`) → "they compete and neither
  wins, `paw down`"; **lease churn** (`lost its singleton lease`, COUNTED) → "it started but keeps
  losing its lease and restarting, which drops every agent each time"; a missing binary (`not
  found`/ENOENT) → the one case that DOES name the runtime; else the last 3 lines. Always ends with the
  log PATH rather than reprinting it — a path is a better offer than 20 lines of someone else's output.
  **A duplicate is detected ONLY from the manager's own `already serves space` line, NEVER from a
  process count:** a healthy manager is TWO processes (the tsx wrapper + the node child it re-execs —
  the same fact that made `managerProcs` signature-based in the first place), so `> 1` is true on every
  working install. I shipped that heuristic and it would have labelled every failure a duplicate; caught
  the same day by reading `ps` on a healthy box.
  **WHY it matters (reported live):** on a dead LTE link `paw chat` failed this way and the message
  pointed at tmux. The real chain is **slow internet → slow agent boots → loaded machine → LOCAL mesh
  timeout → the 0.15 lease bug tears the manager down → paw restarts it → it revives the whole fleet →
  repeat** (measured in the operator's log: 25 lease losses, 24 restarts, ending with 2 competing
  managers). paw's mesh itself never touches the internet — `DEFAULT_SERVER` is `nats://127.0.0.1:4222`,
  a raw IP with no DNS, and `ensure()` makes no HTTP calls; the internet enters ONLY through the agents
  the manager spawns. Test: `check:commands` (9 assertions on the classification).

## mesh registry hygiene

- **Mesh-registry hygiene** — `~/.cotal/meshes/<space>.json` records which mesh owns a server URL, and
  cotal's `up` preflight matches the FIRST entry holding a port. `check:loop` used to delete its paw
  state dir but NOT its registry entry, so every run left a `pawloopprobe` claiming
  `nats://127.0.0.1:4222`; with six such leftovers accumulated, a mesh restart failed with
  `✗ nats://127.0.0.1:4222 is already in use by mesh "forktest-90246"` — a test space from weeks
  earlier. `check:loop` now calls `removeMesh(space)` in its teardown. A test that litters shared
  machine state is a landmine that goes off much later, in an unrelated command.

## stripHarnessMarkers

- **`stripHarnessMarkers` / `HARNESS_SESSION_MARKERS` (src/lifecycle.ts, 2026-09-08)** — Claude Code stamps its
  own process tree with session markers (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`,
  the messaging socket/token, …). A `paw restart`/`paw start` run INSIDE a claude session (an agent
  restarting the fleet after an outage — exactly what paw-folder did) passed them to the detached manager
  and from it to EVERY agent it spawned, which then booted as "child sessions" with **transcript saving
  OFF** ("inherited CLAUDE_CODE_CHILD_SESSION marker", operator screenshot) — paw's durability silently
  gone for the whole fleet. `daemonEnv` (the one choke point: mesh, manager, mailbox, detached
  restart/adopt children, `paw claude`) now drops an EXPLICIT marker list; operator config under the same
  prefix (`CLAUDE_CODE_USE_BEDROCK`…) is kept — a list, not a prefix wipe. Verified live: after a clean
  restart no manager/agent env carries the markers and no pane says transcript off. Test: `check:spawn-env`.
  **2026-09-08 outage, for the record:** nats-server 2.14.0's filestore for `KV_cotal_presence_paw` hit
  `Critical write error: no message found` at 06:38 (disk 98% full, the KV carried 122 never-cleaned
  presence-watch consumers, its msg block had just rotated); every presence put failed for 3h20m →
  empty roster, manager/mailbox timeouts, keeper flapping, MCP links closed, while every daemon was
  RUNNING. Fix: delete the (ephemeral) presence KV, `paw restart`, `paw start`. Neither cotal nor paw
  detected a failed stream — follow-up in beads-eic (store hygiene, keeper probe, disk headroom).

## sanitizeNodeOptions and daemonEnv

- **`sanitizeNodeOptions` / `daemonEnv` (src/lifecycle.ts)** — the env every paw-spawned child gets:
  the operator's, minus NODE_OPTIONS preloads that would kill it before it runs. cmux wraps a claude
  session with `NODE_OPTIONS=--require=<tmp>/cmux-claude-node-options/restore-node-options.cjs` and
  later REAPS that temp dir out from under the still-running session (the same reaping `images.ts`
  stages pasted images around), after which EVERY node process spawned from that terminal dies at
  preload with `MODULE_NOT_FOUND` before reaching a line of its own code. paw's detached children
  inherit the env, so `paw adopt .` printed its `⟳ adopting…` banner from the PARENT while the child
  was already dead — the traceback went to `adopt.log`, so the terminal showed a success banner and
  nothing happened, twice (2026-07-29). A preload that isn't on disk cannot be honoured and isn't
  paw's to keep: drop it and say so, rather than let node kill a daemon with a stack trace about a
  file the operator never named. Only ABSOLUTE and `file://` targets are checked — a bare specifier
  (`--import tsx`) resolves from node_modules at load time and a relative one against the CHILD's cwd,
  so neither is paw's to judge; a dangling flag with no target passes through (node's error is
  clearer). Applied at every spawn site: mesh `up`, the manager daemon, the mailbox beacon, the
  detached restart/adopt children, and `paw claude` (whose HOOKS are node — the same stale preload
  breaks them, which is how the session that hit this showed `Stop hook error` too). Test:
  `check:commands`.

## pid-stamped locks

- **Locks are PID-STAMPED and break on a dead holder (`src/lock.ts`, 2026-08-20)** — the lock file used
  to be created EMPTY and staleness was purely `mtime > STALE_MS` (60s), while a waiter gave up at
  `MAX_WAIT_MS` (30s). Those two constants make a guaranteed-lose race: a lock abandoned by a KILLED
  holder can never be broken inside the wait window, so the waiter always times out first. Ctrl-C-ing a
  `paw chat` that was mid-spawn therefore poisoned the next command for 30s and then failed it —
  reported live as `paw attach research` → `timed out acquiring lock … spawn.research.lock`. Now each
  holder writes its pid and `holderAlive` probes it with signal 0 (the self-reap pattern from
  foreground.ts): **ESRCH ⇒ break immediately, EPERM ⇒ alive (held), unreadable/pidless ⇒ fall back to
  the age test** (an older paw's empty locks still work). Timeouts are injectable (`LockOpts`) so the
  WAITING paths are testable without waiting 30s. Test: `check:commands`.

## src/lock.ts

- `src/lock.ts` — dependency-free exclusive file locks (`withFileLock` sync / `withFileLockAsync`),
  shared by the connector (pre-trust), addressing (folder→name registry RMW + per-(space,name) spawn
  serialization). cross-process safe: O_EXCL create, retry, stale-break.

## Env knobs
- `PAW_SPACE` — override the machine-wide default space (`paw`). Folder → agent NAME, not space.
- `PAW_AUTH=1` — JWT-authed mesh instead of the default open localhost mesh (open needs no creds).
- `PAW_PERMISSION` — override the default `bypassPermissions` (one of default/acceptEdits/bypassPermissions/plan).
- `PAW_MODEL` — default model for spawned agents (cotal's per-agent `--model`); a `--model` flag on
  `paw chat`/`paw open` overrides it. Blank = unset (no fabricated default).
- `PAW_RUNTIME` — one-shot override of the manager runtime: `pty` (default; headless warm agents),
  `tmux`, or `cmux` (each agent in its own tab/pane). `bin/cotald.ts` imports `@cotal-ai/{tmux,cmux}`
  so the runtimes register. **Precedence: `PAW_RUNTIME` env > the space's sticky preference file
  (`~/.paw/spaces/<space>/runtime`) > `pty`.** The discoverable surface is the **`paw runtime`** /
  **`paw restart`** commands (below) — the env var is the transient override; the preference file is
  the durable per-space choice. Because the manager is a background daemon `ensure()` ADOPTS, changing
  the setting alone can't switch a running one — `ensureManagerUp` records the runtime it started
  (`manager.runtime` marker) and, when the resolved runtime differs from the running manager paw OWNS,
  **restarts it** into the new runtime (durable agents re-wake on the next chat/open) with a rollback
  net (see the lifecycle bullet). A switch/restart also **`reapRuntimeUi`s the OLD runtime's leftover
  windows/tabs** right after stopping the old manager, so the revived agents don't stack DUPLICATE
  windows/tabs next to orphans the manager's own SIGTERM teardown missed (tmux → `kill-session
  cotal-<space>`; cmux → close the KNOWN agents' `cotal-<name>` tabs; see the lifecycle bullet).
  A marker-less owned manager counts as `pty` (so the first switch
  triggers); a manager paw doesn't own is never killed (warns instead). `cmux`/`tmux` must be installed
  + reachable or the switch rolls back to the previous runtime and fails loud with the log tail.
  Invalid env value → fail loud; a garbage preference FILE is ignored (falls to pty).
  **cmux works from ANY shell (`assertRuntimeUsable` = `cmux ping`):** the cmux app is a SINGLETON
  reachable over a stable DEFAULT unix socket — `cmux ping` finds it from any process, no cmux surface
  needed. The earlier "cmux only works from inside a cmux terminal" belief was a bug: paw's detached
  manager INHERITED the launching cmux shell's per-surface `CMUX_SOCKET_PATH`, and the cmux CLI PREFERS
  that over the default socket — so when that surface/window closed, every LATER agent spawn targeted a
  DEAD socket ("cmux couldn't reach the app"), i.e. spawns "only worked from the same tab". Fixed on two
  fronts: (1) `startManagerDaemon` STRIPS `CMUX_SOCKET_PATH` from the cmux manager's env (and pins
  `CMUX_BUNDLED_CLI_PATH`=`cmuxBin()` so a detached, outside-a-surface manager can still find the CLI), so
  the manager always reaches the app via the stable default socket — a spawn no longer depends on which
  tab launched paw; (2) `assertRuntimeUsable(cmux)` now probes `cmux ping` (with `CMUX_SOCKET_PATH` unset,
  matching the manager) instead of requiring `CMUX_SOCKET_PATH` — so `paw runtime cmux`/`restart`/a fresh
  cmux start work from a plain terminal as long as the app is running, and fail loud only when it isn't.
  `cmuxBin()` falls back to the macOS bundled CLI (`/Applications/cmux.app/…/bin/cmux`) when
  `CMUX_BUNDLED_CLI_PATH` is unset. Gated only on the START/SWITCH paths (ensureManagerUp fresh-start +
  mismatch-restart, restartManager, the `paw runtime`/`restart` entry points); ADOPTING a running manager
  takes no probe (a control request over the mesh). Raw `paw cotal supervise --runtime cmux` stays
  available. tmux/pty are always usable. **DM caveat is NOT runtime-specific:** a warm agent receives DMs live under any
  runtime IF its mesh consumer is healthy; a claude whose link went stale through restart churn shows
  "idle" from cached presence but stops consuming — re-spawn it (`paw stop` + `paw chat`), don't blame
  the runtime.
  **⚠ cmux SETUP REQUIREMENT — `automation.socketControlMode` must NOT be `cmuxOnly` (2026-07-08, hard-won):**
  the DEEPEST cmux blocker isn't env at all — it's a cmux-SIDE gate. cmux's `automation.socketControlMode`
  defaults to **`cmuxOnly`**, which authorizes socket control by the client's cmux PROCESS LINEAGE (peer
  creds / ancestry — NOT env, NOT a password). paw's manager is a DETACHED daemon (`setsid`, reparented to
  init) with NO cmux-surface ancestry, so under `cmuxOnly` EVERY spawn/close is rejected mid-write
  ("cmux couldn't reach the app" / "Failed to write to socket (Broken pipe, errno 32)") — even though the
  app pings fine and the env is perfect. It "works then breaks" because it only works while the manager
  still has cmux ancestry (freshly forked from a surface-launched paw), and dies the instant it detaches.
  **No paw-side env/socket fix beats a lineage gate.** FIX (operator's `~/.config/cmux/cmux.json`), verified
  live on **cmux 0.64.17**: set `automation.socketControlMode` to **`"fullOpenAccess"`** ("Full open access"
  in Settings → Automation) and **RESTART the cmux app** (see caveats). Enum:
  `off · cmuxOnly · automation · password · allowAll · openAccess · fullOpenAccess · full`.
  **The other modes are BROKEN on 0.64.17** (all filed as cmux bugs, `~/cmux-socket-repro.py`): `password`
  and `automation` need a server password, but a password Saved via the Settings GUI is NEVER registered
  server-side ("Password mode is enabled but no socket password is configured in Settings" — rejects every
  client, lineage included); `allowAll` still demands auth. So `fullOpenAccess` (no auth at all — any local
  process may drive the socket, a security trade-off) is the ONLY working headless-automation mode.
  **Apply caveats (all cmux bugs):** (1) `cmux reload-config` does NOT re-read `socketControlMode` — it's a
  LAUNCH-time setting, so a full **app restart** is required to apply a file change (the GUI applies live but
  see #2). (2) A file-managed `socketControlMode` (present in `cmux.json`) **locks/greys the Settings
  dropdown**, and the app WRITES the key into `cmux.json` itself when you Save a password — so once it's in
  the file, the GUI can't change it and removing it from the file + restart may not fully un-stick the app's
  internal state. Net: drive it purely from `cmux.json` + app restart, don't fight the GUI.
  `access_mode` in `cmux capabilities` reflects the CALLER's auth path (a cmux-descended shell ALWAYS shows
  `cmuxOnly` / passes regardless of the server mode), NOT the server's configured mode — so it (and any test
  from a cmux terminal or from Claude Code running inside cmux) is USELESS to preflight this. The ONLY valid
  test is a process reparented to init (ppid=1, no cmux lineage) — `~/cmux-socket-repro.py`. Verified live:
  under `fullOpenAccess` a ppid=1 process (and paw's ORPHANED detached manager) spawns agents into
  `cotal-<name>` tabs with no auth; under `cmuxOnly`/`password`/`automation` it's rejected.
  `ensureAgentSpawned` appends a socketControlMode hint to a cmux-unreachable spawn error. The earlier
  `CMUX_*`/shim-PATH strips + the `CMUX_SOCKET_PASSWORD` injection are still correct (harmless under
  `fullOpenAccess`; needed if cmux ever ships a working `password` mode) — but the socketControlMode gate is
  the load-bearing one.
  - **`paw runtime`** (`src/commands/runtime.ts`) — no-arg: LOCAL, prints the preferred runtime + the
    last-started `manager.runtime` marker (flags drift). `paw runtime <pty|tmux|cmux>`: writes the
    preference then `ensure()`s (restarts on a switch). **`paw restart [<r>]`**: force-bounce the
    paw-owned manager (optionally set the preference first) — the bounce `ensure()` won't do on a
    same-runtime manager (e.g. after a connector edit). Neither is in NEEDS_MANAGER/NEEDS_MESH gating:
    they self-ensure AFTER writing the preference (pre-ensuring would boot the STALE runtime).
    **Self-restart (`paw restart` from INSIDE a managed agent, 2026-07-13):** an agent that runs `paw
    restart` can't finish it synchronously — the bounce's revive step SIGTERMs its own caller mid-command,
    leaving a half-restart / stacked managers (the 2026-07-13 disaster: `paw down; paw dm; …` one-liner
    killed the operator mid-bounce → competing 0.10+0.11 managers → `no responders`). So `paw restart`
    now DETECTS self-invocation via `agentSelfName(space)` (cotal stamps `COTAL_NAME`/`COTAL_SPACE` on a
    managed agent, inherited by its tool subprocesses; an operator shell has neither) and hands off to a
    **detached child** (`spawnDetachedRestart` — `spawn(detached:true)` reparented to launchd, node+tsx,
    **`COTAL_*` stripped** so the child isn't seen as an agent and can't re-detach, `PAW_WAKE_AGENT=<name>`
    set) that outlives the caller's death, completes the bounce+revive, then `finishDetachedRestart` wakes
    the agent with a `paw dm … "resume where you left off"` (a respawned claude session is idle until it
    gets a turn — proven live). Guarded by a `restart.pid` in-flight file (`restartInFlight` — no stacking,
    the direct fix for the multi-manager mess) + a `restart.log`; macOS has **no `setsid`**, hence the
    node-detached spawn (the same mechanism the mesh/manager/mailbox daemons use), NOT a shell trick. A
    plain **operator** shell (no `COTAL_NAME`) still gets today's SYNCHRONOUS bounce (inline output + exit
    code). `agentSelfName` is pure/unit-tested (`check:commands`); both paths verified live on an isolated
    mesh. This is what makes "an agent restarts itself onto new code and keeps working" one command.
- `PAW_ROOT` — opt-in cwd confinement root (absolute; unset = no confinement). `PAW_ALLOW_ANY_CWD=1`
  permits one out-of-root cwd (which is then neither bypassed nor pre-trusted).
- `PAW_HOME` — paw state root (default `~/.paw`). Releases live under `$PAW_HOME/releases`.
- `PAW_RELEASE` — which tree the DAEMONS run from (src/release.ts). Unset = the `current` release
  (fail-loud if none: `paw release`). `dev` = the live checkout, announced loudly on every resolution —
  the pre-incident behaviour, kept as the dev loop's escape hatch. `<id>` = pin one release (a rollback:
  `paw release --list` shows what's on disk). It never affects the CLI itself, only what it spawns.

## Dev
- ESM, run TS directly with tsx — no build step for dev: `pnpm paw <cmd>` (= `tsx bin/paw.ts`).
- **The CLI may run under bun; the DAEMONS must be node+tsx.** The CLI startup tax is real — tsx
  ~0.82s vs bun ~0.21s (~4×) on every `paw` invocation — so the launcher (`~/.local/bin/paw`) MAY
  exec bun for speed. What previously made bun fatal: cotal's `ensureManager`/`startMeshDetached`
  re-exec the *current* runtime (`selfArgv()`), so a bun CLI spawned the manager under bun, where
  `@lydell/node-pty`'s native ioctl fails (`ioctl(2) failed`) → pty stubs stuck `starting…`, no agents
  (2026-06-26: bricked all 5 agents). FIXED by `cotalViaTsx` (src/lifecycle.ts): paw now spawns the
  mesh/manager/beacon via the repo's tsx-bin directly, so they're node+tsx regardless of the CLI
  runtime. To switch the CLI to bun: change the launcher's last line to
  `exec bun "/Users/aleks/Github/paw/bin/paw.ts" "$@"`. Verify after: `paw ps`, then confirm the
  manager process is `node …/tsx/…` (NOT bun) and a `paw chat --fresh <folder>` boots a real claude (RSS > 100MB).
- `pnpm typecheck`, `pnpm check:launch`.
- **History vs github (2026-09-10):** github visibility is the whole repo, not per-branch. Full history lives on local `private-main` (**no upstream**, never pushed). `main` is an orphan snapshot of that tree and is what `origin` has; future commits on `main` are the public git log. `remote.origin.push` is `main:main` only. `scripts/githooks/pre-push` refuses `private-main`. `scripts/push-public-snapshot.sh` is leftover from a second remote and should not be used to rewrite origin. Visibility flip of `caffeinum/paw` is the operator's.
- pnpm 11 reads settings from `pnpm-workspace.yaml`, NOT the package.json `pnpm` field or `.npmrc`.
  Ours declines esbuild's build (`allowBuilds.esbuild: false` — same as the global ignore-scripts
  policy; esbuild runs from its prebuilt platform binary) and disables the pre-run deps check
  (`verifyDepsBeforeRun: false`) so scripts don't choke on the intentionally-skipped build.
