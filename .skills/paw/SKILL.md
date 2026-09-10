---
name: paw
description: Work on paw — zero-config warm claude-code agents on the cotal mesh. Use when editing, testing, rebasing, or extending paw (chat/open/adopt/sessions, the connector, lifecycle, addressing), or when a cotal upstream bump breaks it. Covers the command surface, architecture, the cotal-integration gotchas that recur, the rebase workflow, and the test suites.
---

# paw

Zero-config, warm, persistent claude-code agents — **one per folder**, addressable, talking to each
other and to you over the **cotal** mesh. A thin layer over cotal with **no fork**. Repo:
`~/Github/paw`. Global binary `~/.local/bin/paw` → `tsx ~/Github/paw/bin/paw.ts` (runs source, no build).

## Command surface

- `paw chat [folder|name]` — the headline. Joins the mesh as a persistent human peer `you`
  (registerPresence+consume → addressable + a durable DM inbox), auto-spawns the folder's agent if
  absent, then a REPL: a plain line DMs the current target; `@name <msg>` switches the sticky target
  to any live peer; `#channel <msg>` broadcasts; `/dm`, `/who`, `/quit`|`/exit`. `--model <m>`.
- `paw open [folder]` — resolve+spawn, then attach the agent's pty (re-dispatches cotal `attach`).
- `paw adopt [folder] [--resume <id>] [--no-start]` — **one step**: resume a PAST claude transcript as
  a LIVE mesh agent. Finds the folder's latest session (or `--resume <id>`), verifies the transcript's
  recorded cwd, upserts `resume:` into the persona, ensures the daemons, and `restartAgent` spawns it
  resumed (stopping a live *cold* instance first; name preserved). `--no-start` = pin only, local.
- `paw sessions [folder]` — list a folder's transcripts (id · when · first message) + the agent's
  mode (fresh vs adopted ← id). Local, read-only.
- `paw ps` · `paw start --name <n> --cwd <dir>` · `paw stop --name <n>` · `paw attach --name <n>`
- `paw dm <agent> "…"` (→ cotal `send dm`) · `paw watch` (→ `console --plain`) · `paw down`
- env: `PAW_SPACE` (default "paw") · `PAW_MODEL` · `PAW_PERMISSION` · `PAW_AUTH=1` (JWT vs open) ·
  `PAW_ROOT` (+`PAW_ALLOW_ANY_CWD=1`) · `PAW_HOME` (default ~/.paw) · `PAW_DEBUG` (show stacks).

## Architecture (paw owns only `src/` + `bin/`)

- `bin/paw.ts` — composition root: registers paw's connector as "cotal", a pre-dispatch wrapper that
  `ensure()`s daemons for mesh/manager verbs, injects the default `--space`, routes `down`.
- `src/dispatch.ts` — `applyAliases` (dm/msg/ask→`send`, watch→`console --plain`) + `withDefaultSpace`
  (append `--space` as a TRAILING flag so a positional subcommand like `send dm`/`history clear` isn't
  shadowed). Pure + tested by `check:dispatch`.
- `src/lifecycle.ts` — `ensure()`/`stop()`: auto-start or adopt a DETACHED mesh + manager per-space
  under a lock; **open mesh by default** (`PAW_AUTH=1` for JWT); ownership markers under ~/.paw so
  `stop()` only kills paw-started daemons.
- `src/connector.ts` — wraps cotal's claude connector: bypassPermissions, mesh brief (names the `you`
  peer), `--resume` from the persona's `resume:` frontmatter, folder pre-trust into ~/.claude.json,
  opt-in `PAW_ROOT` cwd confinement. **Keeps `--dangerously-load-development-channels server:cotal`**
  — it's the channel-REGISTRATION gate for idle-wake, NOT dead (do not strip it).
- `src/addressing.ts` — folder→name registry (`~/.paw/spaces/<space>/folders.json`, collision-
  qualified) under a lock; `ensureAgentSpawned` (ps→start via `requestControl("manager",…)`),
  `restartAgent` (stop-if-live→spawn), `ensurePersonaFile`/`personaFilePath`, `resolveModel`,
  `controlCreds`, `withControlEndpoint`, `waitForPeerId`, `stableHumanId`, `lookupFolderName`.
- `src/adopt.ts`, `src/chat.ts`, `src/open.ts`, `src/sessions.ts`, `src/names.ts`, `src/lock.ts`.

## cotal-integration gotchas (these recur — check after any upstream bump)

cotal is consumed via `link:` to `~/Github/cotal-ai/cotal-cwd` (branch `paw-integration`). cotal moves
fast; each of these has silently broken paw before:

1. **Spawn requires a persona file.** The manager refuses a bare name (`.cotal/agents/<name>.md` must
   exist — "no silent default-ACL fallback"). paw auto-generates an ephemeral persona under ~/.paw and
   spawns via `--config <abs>`. The persona's `name:` is the agent's mesh identity.
2. **Verb renames.** `dm`/`msg`/`ask` → `send <dm|msg|ask>`; `watch` → `console --plain`. paw aliases
   them in `dispatch.ts`. Re-check `paw help` after a bump.
3. **`--space` injection must go at the END** (trailing flag). `send`/`history` read their subcommand
   from the FIRST positional, so front-injection shadows it. Never `args.includes("--space")` (a body
   word matches and misroutes) — skip only on a real `--space` flag.
4. **Manager auto-numbers duplicate names** (`uniqueName` keyed off the agents map + reserved set, NOT
   the roster). `opStop` clears the agents map synchronously, so stop→respawn keeps the name. Serialize
   spawns per (space,name) — concurrent spawns of one folder otherwise leak an unreusable agent.
5. **firstParty-only idle-wake.** Bedrock/Vertex/Foundry get no `claude/channel` wake → turn-boundary
   drain fallback.
6. **The mesh carries name, not cwd** — neither presence/roster nor `ps` expose cwd, so paw owns the
   folder→name registry.
7. **`send`/`dm` is fire-and-forget** (throwaway "send" endpoint) — that's why the human must join as a
   PERSISTENT peer (`paw chat`) for an agent's reply to land.
8. **adopt is for PAST transcripts** — a live terminal claude isn't a mesh peer and can't be
   double-resumed. agent == the transcript (log), not the process.

## Rebase / upgrade workflow (recurring)

```bash
cd ~/Github/cotal-ai/cotal-cwd
git fetch upstream
git branch -f paw-integration-prerebaseN paw-integration   # backup
git rebase upstream/main                                    # resolve conflicts: KEEP upstream's
                                                            # structure, re-graft paw's cwd (4 spots
                                                            # in manager.ts: import resolve,
                                                            # StartAgentOpts.cwd, opStart cwd, the
                                                            # cwd const + buildLaunch cwd + spawn cwd)
pnpm install && pnpm typecheck                              # cotal must be green
cd ~/Github/paw && pnpm typecheck && pnpm check:loop        # paw against the rebased cotal
```
For a big upstream jump, a fast resolve is `git checkout --ours manager.ts` then re-apply the 4 cwd
spots. To refresh PR #43: `git branch -f feat/per-agent-cwd <rebased-cwd-commit>` +
`git push --force-with-lease origin feat/per-agent-cwd`. (Note: cotal's AGENTS.md now forbids
`Co-Authored-By` trailers on cotal commits — but the user's global rule requires them; ask before
committing TO cotal.)

## Tests (run before committing)

`pnpm typecheck` · `check:launch` (connector) · `check:addressing` (registry/collision/model) ·
`check:adopt` (`--no-start`, session discovery, cwd-verify, traversal reject, CRLF/frontmatter
preserve) · `check:dispatch` (aliases + `--space`) · `check:concurrency` (N procs race the registry) ·
`check:loop` (boots an isolated mesh, proves the human↔agent reply loop closes). The mesh-dependent
checks self-isolate (own PAW_HOME + PAW_SPACE on the shared NATS); never `paw down` the default space.
Heavy/manager paths are verified with an **in-process Manager + stub connector** (no real claude).

## Conventions

Fail loud (no fabricated fallbacks). Single responsibility, minimal comments. **Don't claim it works
without running it** — run the binary or a deterministic/stub harness; prefer an adversarial review
pass for substantive changes. Build on cotal, contribute generic gaps upstream, keep paw bits here.
