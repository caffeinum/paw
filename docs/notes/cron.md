# paw cron

Durable scheduled wake-ups for agents (issue #51, cut down to the operator's ask: "a really really simple
interface where agents can schedule wake-ups for themselves … basically a cron"). Replaces the ad-hoc
`~/Library/LaunchAgents/*.plist` + shell script per reminder.

## Interface
```
paw cron add [<agent>[#space]] "<m h dom mon dow>" "<prompt>"   recurring, local time
paw cron add [<agent>[#space]] "<cron>" "<prompt>" --once        next match only, then deleted
paw cron add [<agent>[#space]] --in 20m|--at 09:30 "<prompt>"    one-shot (--at also "YYYY-MM-DD HH:MM")
paw cron add [<agent>] <schedule> ["<prompt>"] --run "<cmd>" [--timeout 10m]
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

## --run (operator, 2026-10-28)
For hourly scripts (vibeos-cron-retry.sh, vibeos-hosted-prefer-first.sh) that should not cost a claude
turn every hour. At fire time the KEEPER runs `<cmd>` itself (`runCommand`): `/bin/sh -c`, cwd = the
agent's registered folder, `daemonEnv()` (PATH backfilled, harness markers stripped, no COTAL_NAME/SPACE),
`PAW_CRON_JOB`/`PAW_CRON_AGENT` set, own process group killed at the timeout (default 10m, `--timeout`).
- exit 0 + empty stdout ⇒ silent: nothing sent, no mesh touched (the job still counts as fired).
- non-empty stdout ⇒ ONE DM from "cron": header + prompt (optional with --run) + stdout (first 8000 chars,
  truncation said) + stderr tail if any.
- non-zero exit / timeout ⇒ ONE DM: what failed + the tail (4000 chars) of stdout+stderr.
- The hosted/registered gate runs BEFORE the command: nothing runs for an agent not hosted here.
- A DM that then fails to deliver retries the whole fire (command re-runs) like any one-shot.
- Arity with --run (prompt optional): cron form — the agent is whatever precedes the 5-field expression;
  timed form — a lone single word is the agent, a multi-word lone positional is the prompt.
- The keeper runs commands sequentially inside its tick; a long command delays later jobs and the next tick.

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
- A fire is ONLY a DM: `sendAsYou({ byName: true, sender: "cron" })` (src/dm.ts) — the `paw dm` path,
  but from the peer **"cron"**, never "you", so an agent can't take a fire for the operator. Open mesh:
  stable id `spaces/<s>/cron.id`; remote: its own nkey `spaces/<s>/cron.nkey.json` (0600) minted
  `operator` from the signer (`senderEndpointAuth`). Text: `⏰ paw cron <id> (…, set by X; scheduled
  wake-up, no reply needed): <prompt>`. A stopped registered
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
store, argv shapes, fire gate, --run argv/messages/execution incl. timeout + process-group kill); `check:hash-space` covers the `#space` hoist. Live:
`PAW_HOME=$(mktemp -d) PAW_SPACE=test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) node scripts/e2e-cron.ts`
— real mesh + manager, a listening "target" peer, the real CLI (incl. --run: silent sends nothing, a
printing run and a failing run each deliver one DM); tears down with stop + purgeTestSpace.
- `scripts/e2e-cron-agent.ts` (same env): a REAL haiku claude agent; fires driven by the keeper entry
  `paw global --space <s>` (the plist's argv; brings up a test-space `global`). Live idle agent acts on
  an `--in 1m` fire; then `paw sleep --now`, the next fire wakes it through the stand-in (sleep.log:
  "woke worker — DM from cron") and it acts.
- `COTAL_BIN=<cotal-ai@0.100.0>/dist/cotal.js node scripts/e2e-cron-remote.ts`: own JWT+TLS broker +
  `paw mesh add`; a real claude agent hosted here acts on a fire (history shows it from `cron`), an agent
  with no persona here is refused at add, skipped + logged at fire, and nothing is spawned for it.
