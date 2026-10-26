# Check scripts

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## check scripts

- `scripts/check-launch.ts` (`pnpm check:launch`) — connector smoke checks.
  `scripts/check-addressing.ts` (`pnpm check:addressing`) — name/registry/collision/model + the
  ambiguity guard (`assertUnambiguousTarget`: name-vs-folder collision throws, sigils exempt), no daemons.
  `scripts/check-adopt.ts` (`pnpm check:adopt`) — session discovery + cwd-verify + persona resume upsert.
  `scripts/check-concurrency.ts` (`pnpm check:concurrency`) — N processes race the folder→name registry
  (the lock keeps names distinct + all persisted).
  `scripts/check-dispatch.ts` (`pnpm check:dispatch`) — --space injection (operator --space/-= form
  respected; trailing body-word not mistaken), `stripCotalNamespace`, `expandEqFlags`
  (--space=/--server= expansion, positionals untouched), + all 7 native commands self-register.
  `scripts/check-hash-space.ts` (`pnpm check:hash-space`) — `<agent>#<space>`: parser precedence,
  per-command hoisting through each command's own parser, every address verb via the real CLI.
  `scripts/check-commands.ts` (`pnpm check:commands`) — the native commands' registration
  (summary/usage present) + pure helpers (formatPs, resolveStopName, stripChannel, formatWhen,
  idNames, renderTap, formatWho) under a temp PAW_HOME; hermetic, no daemons.
  `scripts/check-worktree.ts` (`pnpm check:worktree`) — builds a temp repo+worktree; parse/list/resolve
  `<repo>@<branch>`, fail-loud on missing branch/worktree.
  `scripts/check-images.ts` (`pnpm check:images`) — the attachment helpers: the tokenizer against all
  three drag/quote conventions with REAL files whose names contain spaces, absolute-only resolution
  (+ `file://`/`~`), `hasProse` (the path-only-line regression), ephemeral BOUNDARY matching, staging
  copy-vs-in-place (and that a staged copy survives the original being reaped), and `composeMessage`.
  Hermetic; its non-ephemeral fixture lives beside the repo, NOT under tmpdir() (which is itself
  ephemeral — that would test the wrong staging branch).
  `scripts/check-github.ts` (`pnpm check:github`) — parse `github:owner/repo[#branch]` + fail-loud on
  malformed/unsafe; pure `ghCloneArgs`; `ensureBranch` against a pre-created local repo (hermetic, no clone).
  `scripts/check-rm.ts` (`pnpm check:rm`) — `removeFolder` (registry RMW + idempotent) and `resolveRemoval`
  by name / folder / orphaned-persona, fail-loud on an unknown target (hermetic, no daemons).
  `scripts/check-foreground.ts` (`pnpm check:foreground`) — the foreground registry (register/read/list +
  stale-pid self-reap), the `ensureAgentSpawned` reuse-guard ({spawned:false} for a live foreground name),
  and `paw claude`'s pure helpers (`peelArgs`, `deriveSessionIntent`, `stripSessionFlags`); hermetic, no daemons.
  `scripts/check-release.ts` (`pnpm check:release`) — the release discipline against a tiny FAKE checkout
  under a temp PAW_HOME: id determinism + lockfile sensitivity, snapshot completeness, node_modules is a
  clone (inode differs) and never a symlink, immutability under a checkout edit AND a node_modules
  rewrite, daemon argv resolving through the release and NOT moving when the checkout does, the pgrep
  ownership patterns against release-dir argv, cross-process flip atomicity (a real child hammering
  readlink while the parent flips), prune keeping the current release, and the arg parse. Hermetic.
  `scripts/check-loop.ts` (`pnpm check:loop`) — boots an isolated mesh and proves the human↔agent
  reply loop closes (persistent peer addressable + reply lands); self-tears-down. **It does NOT start a
  manager** (`ensure({needMesh:true})`, no `needManager`) and makes NO control call — which is precisely
  why it stayed green through a completely dead control rail. That gap is `check:rail`'s job.
  `scripts/check-rail.ts` (`pnpm check:rail`) — **the control-rail check**: `ensure({needMesh,
  needManager})`, let the manager settle, then call `ps` from THREE SEPARATE PROCESSES (own connection,
  own `resolveService`, nothing warm inherited) — the shape of every real paw invocation and the one
  that was never tested. Also asserts a refusal comes back as a refusal PROMPTLY (`inspect`/`despawn` of
  an unknown name), since the dead rail's symptom was silence, not error. `PAW_RAIL_SPAWN=1` adds a REAL
  claude spawn + despawn (off by default: an API session and ~a minute, but it is the only stage that
  exercises a manager holding state). **Isolation is ENFORCED, not documented** — it refuses to run
  without a non-default `PAW_HOME` and a `PAW_SPACE` that isn't `paw`, because it starts a real manager;
  and it `removeMesh(space)`es on teardown (the check:loop landmine).
  `scripts/check-prune.ts` (`pnpm check:prune`) — `paw spaces prune` against a PRIVATE nats-server
  (random port, temp store, temp PAW_HOME + COTAL_HOME): seeds real spaces with cotal's
  `setupSpaceStreams` and proves the plan keeps paw / the current space / --keep / a registered mesh /
  a space a running process names / a recently active space / a collision space, leaves a foreign
  stream alone, that executing deletes exactly the dead spaces' streams, that the CLI dry run deletes
  nothing, and `purgeTestSpace` (refuses paw and a busy space; deletes streams + registry entry).
  `scripts/check-boot.ts` (`pnpm check:boot`) — a COLD local mesh boot on a PRIVATE port (temp
  PAW_HOME, COTAL_HOME, PAW_COTAL_ROOT; its nats-servers are killed by temp-dir signature): `meshUpArgs`
  carries `--no-manager`; a canary that the OLD argv still makes cotald's `up` exit 1 ("control plane
  degraded"); `bootLocalMesh` from cold exits clean and adopts mesh.pid; two processes booting one
  cold broker at once BOTH succeed (fails without the adopt fallback — `.cotal` EEXIST); the lifecycle
  lock waits out a 90s-old LIVE holder, announces the wait once, and a timeout names the holder. ~20s.
  `scripts/check-teleport.ts` (`pnpm check:teleport`) — hermetic (temp HOME + PAW_HOME): teleport's args,
  transports, checklist, the continued-in chain on fixture transcripts, manifest, dirty-repo refusal, probe
  parse + blockers, plan, persona marker + the wake-gate refusal, and its pack/unpack/repo scripts run for
  real between two temp HOMEs. `scripts/e2e-teleport.ts` (`COTAL_BIN=… node scripts/e2e-teleport.ts`) —
  the real `ssh:` transport into a Docker container running this checkout's paw on a private JWT+TLS broker;
  see [teleport.md#tests](teleport.md#tests).
  `scripts/check-move.ts` (`pnpm check:move`) — hermetic (temp HOME + PAW_HOME + PAW_BEADS_DIR): `paw move`'s
  args and `#space` hoist, plan text, every refusal, the cutover + `moved-to-<to>/` backup (stamped on a
  second move), a hermes profile following it, rollback (failed target start, unreleased session), and
  `--as` bead reassignment on a temp beads db. Stop/start are fakes — no mesh.
