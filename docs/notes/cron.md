# paw cron

Durable scheduled wake-ups for agents (issue #51, cut down to the operator's ask: "a really really simple
interface where agents can schedule wake-ups for themselves … basically a cron"). Replaces the ad-hoc
`~/Library/LaunchAgents/*.plist` + shell script per reminder.

## Interface
```
paw cron add [<agent>[#space]] "<m h dom mon dow>" "<prompt>"   recurring, local time
paw cron add [<agent>[#space]] "<cron>" "<prompt>" --once        next match only, then deleted
paw cron add [<agent>[#space]] --in 20m|--at 09:30 "<prompt>"    one-shot (--at also "YYYY-MM-DD HH:MM")
paw cron ls [--all]   ·   paw cron rm <id>   ·   paw cron tick
```
- Mirrors Claude Code's CronCreate: 5-field cron (`*`, lists, ranges, steps, `mon`/`jan` names, 7 = Sunday,
  dom+dow both restricted = either), local time, recurring by default. Unlike session crons: durable, no
  7-day expiry.
- Agent defaults to the caller (`COTAL_NAME`); the default space for `cron` is `PAW_SPACE`, else the
  caller's `COTAL_SPACE` (bin/paw.ts `callerSpace`) — a team2027 agent has no PAW_SPACE.
- `<agent>#<space>`: the hoister (`ADDRESS_ARGS.cron`, arity-based `slots` fn) only treats slot 1 as an
  address when the arity says an agent was given, so a prompt containing `#` is never mangled.
- `add` fails loud for an unregistered name or one that runs elsewhere (teleported / remote persona not here).

## Store
`$PAW_HOME/spaces/<space>/cron.json` — `{ jobs: [...] }`, read-modify-write under `cron.json.lock`
(src/lock.ts), atomic tmp+rename. A job is `{id, agent, prompt, cron | at, createdAt, createdBy,
lastFiredAt?, attempts?, lastError?}`.

## Firing
- Rides the global keeper tick (`paw global`, launchd 60s `StartInterval`): `cronSweep` runs AFTER global
  is brought up, and even when that fails. It sweeps EVERY space under `$PAW_HOME` with a store.
  `paw cron tick` runs the same sweep by hand.
- Claim under the lock (`lastFiredAt = now`), deliver outside it, settle under it. Due = next occurrence
  after `lastFiredAt ?? createdAt` ≤ now, so missed fires (machine asleep) collapse into ONE fire.
- A fire is ONLY a DM: `sendAsYou({ byName: true })` (src/dm.ts) — the `paw dm` path as "you", text
  `⏰ paw cron <id> (…, set by X; scheduled wake-up, no reply needed): <prompt>`. A stopped registered
  agent wakes the way a DM wakes it (wake gate, `restartLive` absent ⇒ a live seat is never restarted);
  a sleeping one through its stand-in. `byName` skips folder/handle resolution so the keeper's cwd can
  never turn a job into a new registration.
- Before each fire: `unfireable()` (registered + `runsElsewhere` false). On a remote space a job only fires
  from the machine hosting the agent; otherwise it logs and counts as a failed attempt.
- One-shot: removed on delivery; on failure retried every 5 min, dropped after 3 attempts (log line).
  Recurring: keeps its schedule, `lastError` shown in `paw cron ls`.
- Logs: the keeper's `~/.paw/spaces/paw/launchd-global.log` (`paw cron: fired …` / `NOT delivered …`).

## Going live
`paw global` (the keeper) runs the CLI from the checkout the plist names, not a release — the sweep goes
live once the code is on that checkout. The brief line (src/brief.ts `CRON_BRIEF`) is in the connector,
so agents see it only after a release + restart (and their next spawn).

## Tests
`pnpm check:cron` (hermetic: parse, next-fire, --in/--at, catch-up-once, one-shot delete/retry/drop,
store, argv shapes, fire gate); `check:hash-space` covers the `#space` hoist. Live:
`PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-cron.ts`
— real mesh + manager, a listening "target" peer, the real CLI; tears down with stop + purgeTestSpace.
