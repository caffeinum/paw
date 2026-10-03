# paw sleep — opt-in hibernation

Index: [CLAUDE.md](../../CLAUDE.md). Source of truth is the code: the header comments of
`src/sleep.ts`, `src/sleep-host.ts`, `src/sleep-state.ts` (and `scripts/probe-sleep-dm.ts`). Read those
before changing anything; this page is only a map. Commits: a34b0b1, 3f4311a, 65b4d3a (2026-10-02).

## What it is

`paw sleep [<name>…] [--after 60m | --off] [--now [--force]] [--sweep] [--space s]`. **Opt-in per agent**
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
- `paw stop <sleeper>` says it was asleep and is now stopped. Open mesh only (v1).
