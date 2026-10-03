# paw status

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## src/status.ts

- `src/status.ts` — `paw status`: **the ONE agent view** (the former `paw ps` + `paw status`, MERGED —
  `paw ps` is deleted; the raw manager ps stays at `paw cotal ps`). One row per registered agent, live
  or not: **STATUS** (mesh idle/working/starting/offline via `meshStatus` over the manager ps —
  `mesh:"absent"` → starting), **RUNTIME** (the `manager.runtime` marker, shown only when live), **CWD**
  (tilde-abbreviated folder), **SESSION** (the human session name `"research"` via `nameForSession` if
  set, else a short id), **INBOX** (per-agent durable DM-consumer lag — the ZOMBIE detector, added
  after the 2026-07-12 team2027-research incident where a presence-`idle` agent sat deaf on an unacked
  DM for hours: `fetchInboxLag` queries JetStream `consumers.info(DM_<space>, dm_<id>)` where `id` is
  the agent's nkey from the manager's ps row (ps carries `id` — the card.id minted at spawn), rendering
  `✓` (drained), `N queued` (num_pending, undelivered), `N unread` (num_ack_pending, delivered-unacked),
  `—` (no consumer / not ps-listed — legit), or `?` (query FAILED — stderr detail, never a fabricated 0).
  A LIVE agent with queued/unread > 0 gets `⚠ inbox stuck — …, agent not consuming` and a footer count.
  CotalEndpoint keeps its jsm private, so status opens its own short-lived NATS connection via
  `@nats-io/{transport-node,jetstream}` (core's own client libs, now direct deps; creds via controlCreds
  under PAW_AUTH). ConsumerNotFound(10014)/StreamNotFound(10059) → `—`; other errors → `?`.),
  **ACTIVE** (transcript mtime, relative via `ago` — `transcriptMtime`), plus a
  durability/two-writer note (`⚠ two writers (pid …)` from `foreignWriters`, `⚠ no pin` (claude-only —
  an opencode/codex agent has no claude `resume:` so the warning is a lie), `fresh`, or
  quiet when durable). Rows sort live-first then most-recently-active. `formatStatus`/`meshStatus`/`ago`/
  `inboxText`/`inboxStuck` are pure/unit-tested. In NEEDS_MANAGER (reads the manager ps for liveness).
  Test: `check:status`.

## unregistered agents

- **Unregistered manager-listed agents get a row (2026-09-09):** `paw status`/`/api/status` rendered ONE
  row per REGISTERED agent (folders.json ∪ agents.json) joined with the manager's ps, so a
  `cotal_spawn(name, agent: "codex", cwd…)` peer — on the roster, in `paw cotal ps` — was invisible on
  paw's dashboard (personal relayed the operator's "why can't i see gpt-6_2"). Two sources of truth is the
  honest description; a dashboard that omits a live agent answers the wrong question. `collectStatus` now
  appends every ps row paw didn't register with what the ps row carries and NOTHING invented: no folder
  (`—`), no pin/transcript, inbox lag still read (the ps row has the id), `unregistered: {agent}` +
  the note `unregistered <harness> peer (cotal_spawn) — not revived by paw restart/start`; the web header
  shows the same. Registering after the fact is still manual (a persona with `agent: codex` + a
  folders.json/agents.json entry — the codex1/opencode1 pattern); `paw adopt` is a claude-transcript
  verb and has no codex form yet. Test: `check:status`.

## failure

- **`failure` (src/status.ts `transcriptFailure` → src/transcript.ts `recordFailure`/`lastFailure`, 2026-09-03)** —
  "from paw web it looks like the agent is ignoring me": the DM wakes it, claude tries a turn, the API
  refuses ("You've hit your session limit · resets 2:50am", "Login expired · Please run /login", "Request
  timed out", "API Error: …"), the turn ends with no reply, and the mesh still shows a healthy idle
  agent — presence knows only working/idle and `cotal_status` is something the MODEL would have to call.
  cotal has no rail for "the model couldn't run"; the transcript is the only place claude writes it, as
  a SYNTHETIC assistant turn: `message.model: "<synthetic>"` + `isApiErrorMessage: true` (the
  authoritative flag; the text family above is the fallback). "No response requested." is synthetic too
  and is NOT a failure. `lastFailure` walks the tail (64KB) NEWEST-first and lets the latest assistant
  turn decide — a failure followed by a real reply is recovery, not news. Surfaced as `AgentStatus.failure`
  ({text, ts}): `paw status` note column, `/api/status` rows, the web header (⚠ beats "idle"), a red pip
  on the row, and a standing notice above that agent's chat ("your DMs queue and will be answered once it
  can run again"). Measured on this box: 907 "Login expired" synthetic turns in one day across
  transcripts — the class is common. Test: `check:transcript`.

## inferBusy

- **`inferBusy` (src/status.ts)** — paw's own "this agent is mid-turn" guess, rendered as **`busy`**,
  deliberately a DIFFERENT word from the mesh's `working` so a reader can tell what the agent said
  from what paw worked out. WHY it's needed: the connector publishes `working` only on the
  `UserPromptSubmit` hook, but a turn woken by a mesh DM arrives via the channel nudge + inbox drain
  and submits no user prompt — so essentially every agent-to-agent turn runs while presence still
  reads `idle`, which is why `paw status` looked like nothing was ever working. Transcript mtime is
  the one local signal that moves during a turn however it started: live + `idle` + written in the
  last 10s → `busy`. The agent's OWN `working`/`waiting` always wins (never overwritten by a guess),
  an offline agent is never busy, a missing mtime yields no inference rather than a fabricated one,
  and an mtime in the FUTURE (clock skew) is not evidence. Upstream fix would be cotal setting
  `working` when a channel-woken turn begins. Test: `check:status`.

## json output

- **`paw status --json` / `paw inbox --json`** — machine-readable output added for the extension and
  useful for any tool. status emits the SAME `AgentStatus` rows the table renders (so the two cannot
  disagree) plus the inbox-lag `errors` IN the payload rather than only on stderr. **inbox's `--json`
  never advances the shared `inbox.cursor`** — a GUI polling every second would otherwise silently
  mark everything read out from under `paw inbox`/`paw chat`, which share that one unread marker;
  `--watch` + `--json` fail loud (one-shot vs feed).
