# cotal hub — one MCP process for every agent (PAW_COTAL_HUB=1, opt-in)

Index: [CLAUDE.md](../../CLAUDE.md). Source of truth is the code: `src/hub/daemon.mjs`,
`src/hub/cotal-shim.c`, `src/hub/paths.ts`, `src/hub/route.ts`, the hub section of `src/lifecycle.ts`.
Tests: `check:hub` (hermetic), `scripts/e2e-hub.ts` (real claudes, own broker).

## Why

Every paw claude launched cotal's MCP server as its own `node mcp.cjs`: ~55–90MB phys_footprint
each, ~1.8GB for a 25-agent fleet. Claude Code's `claude/channel` push (the wake on a DM) only works
for a stdio MCP server claude launched itself, so a shared HTTP MCP server can't replace it.

## Shape

- claude launches **`cotal-shim <hub.sock>`** (C, ~50KB binary, ~1.4MB footprint) as its `cotal`
  MCP server — `routeCotalToHub` rewrites that one entry in cotal's `--mcp-config`, nothing else.
- The shim sends one handshake line (`{"v":1,"pid":…,"env":{COTAL_*, HOME, XDG_CONFIG_HOME, TMPDIR}}`),
  then relays newline-delimited JSON-RPC.
- **`node src/hub/daemon.mjs --space <s> --socket <path>`** (one per space, `~/.paw/spaces/<s>/hub.sock`,
  mode 0600) calls cotal's
  own `serveClaudeSession` per connection: the same code `node mcp.cjs` runs, handed a socket and the
  handshake env. Each session = its own MeshAgent (own NATS connection), hook control socket, wake
  policy, McpServer.
- `serveClaudeSession` is upstream PR https://github.com/Cotal-AI/Cotal/pull/2401. Until a release
  carries it, `patches/@cotal-ai__connector-claude-code@0.58.0.patch` (pnpm `patchedDependencies`)
  is that PR rebuilt onto the 0.58.0 sources. **Delete the patch when the release lands.**

## Why plain node, not tsx (measured)

Every other paw daemon runs under tsx. The hub can't: tsx's require hook turned loading cotal's 4MB
`mcp.cjs` into ~400MB of V8 heap (same file, 485MB footprint under tsx vs 85MB under plain node; a
hub with 0 sessions measured 586MB under tsx). So the daemon is `src/hub/daemon.mjs` — plain ESM with
JSDoc types, type-checked by `tsc` via `allowJs`, importing only node builtins and `mcp.cjs` — and the
supervisor runs it with `node --max-old-space-size=1024` directly. The same tsx tax very likely sits
on the manager / mailbox / `paw web` today (141 / 96 / 305MB live); not addressed here.

## Identity across a hub restart (the must-have)

A session's identity — owner/actor/lifecycle uid, creds — comes from the LAUNCH env (the manager's
`COTAL_ID`/`COTAL_LIFECYCLE_UID`/launch-material path), which the shim re-sends on every reconnect.
So a restarted hub re-creates the SAME peer, and core's `ensureDmDurable` finds the existing
`dm_<owner>-<actor>-<uid>` durable and keeps its frontier: DMs published while no hub ran are
delivered on reconnect. Verified by e2e-hub (SIGKILL the hub, DM during the gap; and 10s with no hub
at all, recovered by ensure()).

## Lifecycle

- `ensure()` starts the hub BEFORE the manager (the connector routes every new spawn at it); `paw
  restart` stops and restarts it with the manager; `paw down` stops it. Ownership is the pgrep
  signature `hub/daemon\.mjs --space <s> --socket` (space-exact), like the manager and mailbox.
- **Supervisor = a POSIX `sh` loop** (`HUB_SUPERVISOR`), not launchd KeepAlive: per space (test spaces
  leave no login items), restarts in ~1s (exponential to 30s while it keeps dying young), and is
  owned/killed by the same signature. If the supervisor itself dies, the next `ensure()` — any paw
  command, and the 60s `paw global` keeper tick — starts it again.
- The shim is built by `paw release` into `<release>/.build/cotal-shim` (fail loud without `cc` when
  the hub is on; a warning otherwise), and by the connector on first use if a tree lacks it.
- Turning the hub on/off needs a manager restart (the connector reads `PAW_COTAL_HUB` in the manager
  process) and `PAW_COTAL_HUB=1` in the env that runs `ensure()`.

## What agents see during a hub restart

Tool calls in flight and any made while the hub is down get a JSON-RPC error ("cotal hub
unavailable — retry shortly") from the shim — never a hang. The shim reconnects (500ms, backing off
to 10s while connections die young), replays claude's `initialize` + `initialized`, and swallows the
duplicate reply, so claude never sees its MCP server die. Un-acked injected batches come back from
the durable (at-least-once: one may be injected twice). Presence flaps offline only on a graceful
stop (SIGTERM); a crash leaves presence to expire, usually after the hub is already back.

## Crash routes (each covered by check:hub or e2e-hub)

| Route | Containment |
|---|---|
| garbage / oversized / slow handshake | size cap 64KB, 5s deadline, connection dropped |
| handshake without identity, missing launch material | session refused, hub untouched |
| unbindable control socket | `fatalBind:false` → `serveClaudeSession` rejects, that session only |
| JSON-RPC garbage | transport logs, session keeps serving |
| line > 8MB | session cut (shim reconnects fresh) |
| shim not reading (backpressure) | session cut at 16MB unflushed |
| connection flood | pending table capped at 64, OLDEST evicted (a real shim handshakes at once) |
| session table | capped at 512 |
| throw/rejection inside a session | guarded → that connection closed |
| escaped uncaught error | logged; >5 in a minute → exit, supervisor restarts |
| event-loop stall (sync loop, runaway parse) | watchdog THREAD SIGKILLs after 15s (`PAW_HUB_STALL_MS`) |
| heap runaway | `--max-old-space-size=1024` → V8 aborts, supervisor restarts |
| hub log | append-only `spaces/<s>/hub.log`, one line per session event + a stats line a minute (not rotated — same as manager.log) |
| broker down / restart | each endpoint reconnects on its own |
| manager's cooperative shutdown | session closed, hub sends `{"cotal_hub":"exit"}`, the shim exits instead of reconnecting |
| shim SIGKILLed | that claude loses its cotal tools until restart (same as an mcp.cjs crash today) |
| claude dies | shim stdin EOF → shim exits → hub closes the session (agent leaves the mesh) |

Not contained by design: a bug that corrupts shared state without throwing — the hub is one process.
NOT verified: PAW_AUTH meshes, cmux/tmux runtimes, codex/opencode agents (they don't use this
connector), more than ~30 concurrent sessions with real claudes.

## PAW_SERVER

Added for this work: `src/server.ts` `pawServer()` = `PAW_SERVER` else cotal's DEFAULT_SERVER, used
everywhere paw used DEFAULT_SERVER. It lets an e2e run against a broker of its own instead of
sharing the live :4222. paw never starts a broker on a custom URL — ensure() fails loud if it's down.
