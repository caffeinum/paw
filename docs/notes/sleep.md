# paw sleep — opt-in hibernation

Index: [CLAUDE.md](../../CLAUDE.md). Source of truth is the code: the header comments of
`src/sleep.ts`, `src/sleep-host.ts`, `src/sleep-state.ts` (and `scripts/probe-sleep-dm.ts`). Read those
before changing anything; this page is only a map. Commits: a34b0b1, 3f4311a, 65b4d3a (2026-10-02).

## What it is

`paw sleep [<name>…] [--after 60m | --off] [--now [--force]] [--sweep [--dry-run]] [--space s]`. **Opt-in per agent**
(`hibernate:` in the persona, set by `paw sleep <name> --after 60m`) because no automation touches a
live agent without the operator's go. The `paw global` keeper tick sweeps ONLY opted-in agents: idle
≥ the threshold (minimum 60m = the prompt-cache TTL), mesh idle, no turn in flight, inbox drained, no
open background task / Monitor in the transcript, no shell under claude, no channel beyond #general.
`global` itself never sleeps. Sleeping = **despawn the seat**; persona, registry entry and resume pin
are untouched, so a wake is the ordinary `ensureAgentSpawned` interactive `--resume` (never `claude -p`).
SIGSTOP was rejected (frees nothing, stale presence reads as dead). Every sleep/wake is logged to
`spaces/<s>/sleep.log`.

## Why a stand-in (the sleep host)

Measured on 0.48.1 and 0.58.0: every spawn mints a FRESH actor nkey and its durable starts at the
activation frontier, so a DM sent to a stopped agent is stored but never read, and a sender whose
roster lacks the name fails with "no peer". So the **mailbox daemon hosts a sleep host**
(src/sleep-host.ts): per `sleep/<name>.json` it raises a stand-in presence under the agent's name (stable
per-agent actor) and listens on both the stand-in's and the old seat's DM subjects. The first DM wakes
the agent with the stand-in STILL up (name never goes dead), then lowers it and re-publishes the backlog
to the new principal under the ORIGINAL sender (each forwarded seq recorded — no double sends).
External wakes (`paw dm`/`chat`/`start`) go through `prepareWake` in `ensureAgentSpawned`.

## Robustness rules (65b4d3a)

- A sleeping name with a live ps row (late boot, `paw claude`, `cotal spawn`) is reconciled every 15s as
  woken: stand-in lowered, backlog forwarded, record cleared; `ensureAgentSpawned`'s reuse paths hand a
  live seat's record to the host (`healSleep`).
- A failed wake is retried on a 1m→30m backoff; after `MAX_WAKE_FAILURES` it goes back to sleep with the
  error on the record (`paw status` shows it). A vanished/moved registry entry is NOT woken — dropped loudly.
- Every host tick is caught and logged — it runs inside the process that keeps "you" reachable.
- `paw stop <sleeper>` says it was asleep and is now stopped. Open mesh + REMOTE spaces (agents this machine hosts only, narrow creds — [remote-mesh.md](remote-mesh.md)); a local PAW_AUTH mesh is refused.
- ps matches `mesh` BY NAME, so a sleeping/waking agent's row reads the stand-in's presence (`offline`
  while it yields the name to a boot). The wake gate gives such a row `STARTING_GRACE_MS` before
  restarting it (2026-10-11: the host's own wake restarted the seat `paw chat @evals` had just spawned).
  `paw sleep` polls ps after the despawn and refuses to record a sleep while the seat is still listed.

## Every space, live evidence, sandboxed agents (2026-11-04)

The operator opted all 19 team2027 agents into `--after 12h`; one slept in a day. Three causes:

- **The keeper swept only its own space.** launchd runs `paw global --space paw`, and the tick swept `paw`
  alone. Now `sweepOtherSpaces` (src/sleep.ts, called from src/global.ts after the tick, like cron — even when
  global fails) sweeps every `$PAW_HOME/spaces/<s>` with an opted-in persona, each on its own
  `withManagerControl` handle, ONLY where this machine's manager for it already runs (`managerProcs`, never
  `ensure` — no mesh/manager is started to sweep). On a remote space the rail is pinned to our instance and the
  sweep skips any agent `hosting()` says is not ours. A failing space is logged, the rest continue.
- **Stale task records.** Claude Code writes `api-request-blob`/`api-request` lines: copies of whole request
  bodies, old tool results included, with NO `timestamp`. `scanActivity` let a timestamp-less line through the
  "since the process started" filter, so a Monitor/Bash started (and TaskStop'd) weeks before re-opened forever
  (firegoat-cli's bbdqj945e from 10-20, mcp-intern's five). Lines without a timestamp are now skipped. Second
  belt: a Bash/Monitor task is believed only while a LIVE process backs it — a shell under the agent's claude, or a
  process it detached (stamped COTAL_NAME/COTAL_SPACE, reparented to launchd, younger than its claude — `paw
  top`/`tidy`'s attribution). No live process → "stale task record(s), ignored" in the verdict. An async
  agent/workflow runs inside claude (no process), so its record still blocks. Monitor's newer `expires in 30m`
  wording now gives it a deadline. Nothing is ever killed.
- **Sandboxed agents read as "0 live processes hold the session"** — their claude runs in the VM, invisible to
  the host's session index. The `ProcInspector` now reads a `sandbox: container` agent INSIDE its VM:
  `container exec <live id> ps -eo pid=,ppid=,etimes=,args=` → the image's claude (exactly one), its shells, and
  anything else parented to the VM's init (that dies with the container, so it blocks — e.g. fly's
  `flyctl agent`). ppid-0 processes are `container exec` sessions (port forwarder, `!cmd`), not the agent's. A VM
  that can't be read stays awake: "can't tell what is running (its VM can't be inspected: …)". Sleeping one
  reaps its container exactly like `paw stop` (`reapSandbox`, after the record is written — the seat is gone
  either way and a DM must still wake it; a container that won't go is logged and fails loud). Waking is the
  ordinary `ensureAgentSpawned` → sandbox launch (the launcher removes any leftover container of the agent first);
  the mailbox daemon's PATH has `container`.

`paw sleep --sweep --dry-run [--space s]` prints each opted-in agent's verdict and sleeps nobody (no DM-cursor
read, no ensure — a space whose manager isn't running here fails loud). Tests: check:sleep G1–G5 (hermetic,
injectable inspector/status/sleep), `scripts/e2e-sleep-spaces.ts` (two real isolated managers + one without).

## kit agents (2026-11-04)

The verdict refused every non-claude harness ("v1 reads only claude transcripts"), so a kit agent (tracepaper)
never slept. kit writes Claude Code JSONL, so `agent: kit` is now judged like claude, with kit's own evidence:

- **idle** = its transcript's mtime, from the store its persona's `storage:` names (`personaTranscriptRoots`:
  kit's `<KIT_HOME>/sessions` then claude's, or claude's alone for `storage: claude`) — the same lookup `paw log`
  / `paw status` use, so `activeMs` and the pre-despawn recheck already read the right file. Busy = presence
  alone (`liveTurn`: kit sets `working` for exactly the turn).
- **running** = the process table under its seat (`kitSessionProcs`): the ONE `kit run … --name <n> --space <s>`
  root stamped COTAL_NAME/COTAL_SPACE (kit writes no Claude Code session index, so `liveSessionProcs` can't find
  it; 0 or 2 seats → "can't tell", stays awake). kit's persistent `/bin/bash --noprofile --norc` is plumbing;
  ANY process under kit besides it (a `cmd &` from its shell tool stays a child of that bash) blocks. Detached,
  reparented processes are reported but never block (they outlive the seat), as for claude. kit has no
  Monitor/run_in_background tool, so there are no transcript task records to scan.
- **kit's own schedules** (`<PAW_HOME>/spaces/<s>/kit/<n>/schedules.json`, kit's `schedule` package) fire only
  while kit runs → armed jobs block like a Monitor (`paw cron` wakes a sleeper instead). Unreadable → "can't tell".
- **the wake must resume it**: a wake is the ordinary `ensureAgentSpawned` → kit connector with the persona's
  `agent:` pin, so the launch is `kit run … --resume <pin> [--overwrite] <kitArgs>`. `kitWakeBlocker` refuses
  the sleep when that can't happen: a persona the connector would refuse (`readKitPersona`), no transcript for the
  pin in its store (a wake would start a fresh session), no kit binary at `kitBinPath()`, or kitArgs kit's own
  parse rejects (`preflightKitArgs`). Reason: "a DM couldn't wake it back into its session: …".
- Other harnesses (codex, opencode, hermes, acp) stay awake with "harness <x> not supported yet". None is a
  drop-in: hermes/acp keep their sessions outside any transcript paw reads, codex/opencode in their own formats.

Tests: check:sleep G6 (hermetic: seat attribution, shell plumbing vs work, schedules, wake blockers, sweep);
`scripts/lean/kit/e2e-kit-sleep.ts` (real isolated manager, kit `fake:codex`: dry-run verdict, a backgrounded
`sleep` blocks `--now`, sleep → seat gone + stand-in, DM wakes it `--resume <pin>` with its kitArgs into the same
transcript).
