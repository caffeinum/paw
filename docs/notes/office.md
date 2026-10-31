# paw office — a space mirrored into an agent-office

Index: [CLAUDE.md](../../CLAUDE.md)

paw's Office view is an agent-office (its own repo; README there documents the API): a hosted 3D voxel
office (Cloudflare Worker + one Durable Object per office) that any agent can join over MCP, REST or
a CLI. paw links a SPACE to one office; the space's mailbox daemon then mirrors every live agent into
it, and paw web's `~office` embeds the office's own viewer. (Until 2026-10-31 paw shipped its own
three.js renderer with ~83k lines of vendored three; that was replaced by this.)

## Connect

You need the office's base URL and its keys, which `agent-office create` (or `POST /api/offices` with
the deployment's `ADMIN_KEY`) prints once:

```sh
# a hosted office
paw office connect --space <s> --url https://office.example.com --join-key <joinKey> --owner-key <ownerKey>

# a local one (in the agent-office checkout)
npm run dev                                    # wrangler dev, http://127.0.0.1:8799
bin/agent-office create http://127.0.0.1:8799 --admin-key "$(sed -n 's/^ADMIN_KEY=//p' .dev.vars)" --name "paw"
paw office connect --space <s> --url http://127.0.0.1:8799 --join-key <joinKey> --owner-key <ownerKey>

paw office status [--json] --space <s>    # link (keys named, never shown), who the bridge mirrors, who is in the office
paw office open --space <s>               # the viewer in your browser
paw office disconnect --space <s>         # delete link + tokens; the bridge (and the CLI) walk every agent out
```

- `--join-key` is required (the bridge acts as the agents). `--owner-key` lets the embedded viewer
  chat with agents and edit the office; `--view-key` alone gives a read-only embed; neither ⇒ paw web
  says how to reconnect.
- `connect` refuses bad input loudly (non-http(s), plain http to a non-loopback host, a page/API path
  instead of the base URL, a malformed key, keys of two different offices) and proves the link with a
  real `office_look` per key BEFORE writing anything. A wrong key fails without echoing it.
- Keys are bearer secrets. They live in `$PAW_HOME/spaces/<s>/office.json` (0600, atomic write) and the
  agent tokens in `$PAW_HOME/spaces/<s>/office-agents.json` (0600). paw never prints or logs either;
  `status` names which keys are stored. They do appear in `connect`'s argv (shell history, `ps`) —
  prefix the command with a space if your shell skips those in history. `paw office open` likewise hands
  the viewer URL (owner key in its `#k=` fragment) to `open`/`xdg-open` as an argument, so it is briefly
  visible in `ps` to other local users.

## The bridge (src/office-bridge.ts, src/office-daemon.ts)

**Home: the mailbox daemon** (src/mailbox.ts) — the paw-owned always-on per-space process that
`ensure()` starts, which already hosts the sleep host and the stale-id forwarder. The manager is
cotal's (bin/cotald.ts) and paw doesn't add code there; paw web is not always on. The bridge is idle
until a link exists; it re-reads `office.json` every 10s, so connect/disconnect need no restart — but a
mailbox started from an OLDER release has no bridge until `paw restart --space <s>` (operator's call).
Its failure never takes the beacon down: every error is a `[office]` line in `spaces/<s>/mailbox.log`.

While linked it holds one observer endpoint (no presence, no consume): its roster feeds
`collectStatus` every 10s (the same rows as `paw status`/paw web) and its tap feeds speech. Git (≈5
processes per agent; only the repo NAME is used) runs on every 30th read — every 5 min — and is cached
in between; the rest (manager ps, live-session ps, transcript tails) still runs every 10s, which on a
54-agent space is on the order of a second of the mailbox's time per read. One sequential worker ticks
every 2s (only while `office.json` exists):

| paw row | office |
| --- | --- |
| live, mesh `working` or paw's `busy` | `office_status working`, activity = pending tool's NAME (`Bash`, `cotal_dm` — never its arguments) + ` · <repo>` (repo name only, never a path) |
| mesh `waiting` | `waiting` (checked before busy: paw counts waiting as mid-turn) |
| last turn failed / stuck | `waiting`, "needs a look" |
| `starting` | `idle`, "starting up" |
| `idle` | `idle` |
| not live / `offline` | `office_leave` (the character walks out, desk freed); rejoins when live |

- Join: `office_join {name, hue (persona), emoji (persona; omitted unless exactly one emoji), client:"paw"}`;
  the agentToken is kept per agent and reused after a restart. A refused TOKEN (401 "unknown agentToken":
  walked out after an hour, kicked from the viewer, office reset) is dropped and the agent rejoins next
  pass — so "show out" on a live paw agent only lasts until the next tick. A refused JOIN KEY (401
  "missing or wrong key": rotated, office deleted) is different: the whole link pauses (60s, retried),
  every token is KEPT, and one loud line says to reconnect with the new key; reconnecting to the same
  office reuses the tokens, so no duplicate characters.
- Disconnect: `paw office disconnect` deletes the link FIRST, then leaves the tokens it read. The bridge
  checks the link before every tick, so within ~2s it stops, never saves tokens again, walks out every
  agent it holds a token for (including one it rejoined mid-race) and deletes `office-agents.json`.
  Removing `office.json` by hand does the same. A daemon restart, by contrast, keeps the tokens.
- Status only on change (status + activity), never on fields the office doesn't show.
- Nothing is joined or left before the first roster read (an unread roster is not "everyone offline").
- Speech, from the tap: an agent's DM to another bridged agent → `office_chat_send` to that agent's
  office id; an agent's DM to you (matched by your id or, under auth/remote, your roster name) →
  `office_chat_send` to whoever last wrote to it from the office — a `human:<name>` or a non-paw office
  agent's id — else the last office human, else `$PAW_OPERATOR`/your username; a channel post → `office_say "#chan: …"`.
  Clipped to 200 chars, one line, control/bidi chars stripped; consecutive lines from one speaker to one
  target coalesce; queue capped at 40 (overflow logged). Your own DMs to agents are not mirrored (they
  can't be attributed over REST, and office chat already shows there).
- Human chat: each mirrored agent's `office_chat_read` is polled (every 15s, longer for big fleets —
  `pollInterval`), which is also the presence heartbeat (5 min silent = away). A message TO that agent
  from a human (or a non-paw office agent) becomes a paw DM from you (`sendAsYou`, the path paw web
  uses): `[agent office] <name>: <text>`. The agent's reply comes back through speech mirroring. The
  read cursor is per agent, on the office's clock, persisted; delivered message ids are remembered (500
  per agent, in memory) so a retried batch never DMs one twice; a failed delivery is retried twice, then
  logged and skipped.
- Limits: budgets of 100 calls/10s per link (office: 120/IP), 8 joins/min (office: 10/IP) and 20 calls/10s
  per agent (office: 30). A 429 pauses the whole link for its `retryAfter`. Other errors back off per agent
  (5s doubling to 5 min), logged on the first failure and every 10th, "recovered" when they clear.

### Limits and caveats

- Key rotation means reconnect: `paw office connect --space <s> --url <url> --join-key <new> [--owner-key <k>]`.
- Big fleets fill in at 8 joins a minute (measured: 8 at 2s, 16 at 63s) — a 40-agent space takes ~5 min.
- Remote spaces: connect only ONE machine's PAW_HOME per space. Every linked machine mirrors every agent
  it sees on the roster, so two linked machines make duplicate characters.
- Your own DMs to agents (paw chat / web) are not mirrored; office chat typed in the viewer already shows.

## paw web ~office

`GET /api/office` (loopback + exact Origin/Host, like every route) answers the viewer URL
(`<url>/o/<office>#k=<ownerKey|viewKey>` — the key in the fragment never reaches the office's server
logs) or `connected:false` + the exact `paw office connect` command. The pane is an iframe filling the
content area, sandboxed (`allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`,
no top navigation — a hostile office can't navigate the paw web tab, which runs `!cmd`), written only when its src changes (a rewrite reloads the 3D viewer) and dropped when you
leave the view. The route, sidebar row and palette entry are as before.

## Tests

- `pnpm check:office` — pure mapping, the link file (validation, 0600, no key in any rendering), arg
  parsing, and the engine against a fake office (join → status → poll, change detection, leave, 429 +
  retryAfter, 401 → rejoin, join-key refusal → pause + keep tokens, inbound delivery + reply routing
  (to a human or an office agent) + retry without duplicates, `shutdown(leave)`, the join budget). The live
  part also rotates the join key and reconnects without duplicate characters. With
  `PAW_OFFICE_TEST_URL` + `PAW_OFFICE_TEST_ADMIN_KEY` it also runs against a real agent-office (creates a
  throwaway office; human chat via the owner viewer socket); skipped with a note otherwise.
- `scripts/e2e-office.ts` (same env) — fully isolated stack (private nats, temp PAW_HOME/COTAL_HOME/cotal
  root, `test-office-<pid>`, `PAW_RELEASE=dev`), three registered agents stood in by stub endpoints:
  `paw office connect` via the CLI, the MAILBOX's bridge joining them with the right status, a status
  change, agent↔agent and agent→you speech, an owner-viewer chat landing as a paw DM, offline → walk out,
  `disconnect`, and the office still empty 15s later (no ghost rejoin). The temp dir is removed after
  (`PAW_E2E_KEEP=1` keeps it). `PAW_E2E_HOLD=<port>` serves `paw web` there and waits so the embed can be checked
  (and chatted from) in Yab.
- `check:web` "office embed": the shell routes `?at=office`, `/api/office` both shapes, 403 cross-origin,
  501 without the reader.
