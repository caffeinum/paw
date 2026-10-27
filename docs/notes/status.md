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
  under PAW_AUTH). ConsumerNotFound(10014)/StreamNotFound(10059) → `—`; other errors → `?`. A REMOTE space reads only the seats THIS machine's manager spawned, by exact durable name, with paw's consumer-INFO-only cred — [remote-mesh.md](remote-mesh.md).),
  **ACTIVE** (transcript mtime, relative via `ago` — `transcriptMtime`), plus a
  durability/two-writer note (`⚠ two writers (pid …)` from `foreignWriters`, `⚠ no pin` (claude-only —
  an opencode/codex agent has no claude `resume:` so the warning is a lie), `fresh`, or
  quiet when durable). Rows sort live-first then most-recently-active. `formatStatus`/`meshStatus`/`ago`/
  `inboxText`/`inboxStuck` are pure/unit-tested. Runs ensure() ITSELF (not via NEEDS_MANAGER — see "speed" below).
  Test: `check:status`.
- **`live (unmanaged)`:** every registered agent missing from ps is looked up on the presence roster
  (`readMeshRoster`, waits for the KV snapshot, not a fixed sleep); a live, fresh-heartbeat entry →
  `live: true, unmanaged: true` (JSON keeps `mesh` = the presence status), STATUS `live (unmanaged)`,
  note "`paw restart <name>` re-adopts it". See [addressing.md#unmanaged-agents](addressing.md#unmanaged-agents).

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
- **A turn never outlives its process (`turnOfProcess`, 2026-10-23).** The transcript turn reader
  (`turnState`) also stamps `lastMsgMs`, the newest real message's timestamp. `liveTurn`/`readTurnState`
  hold it against the start of the process holding the session (`startedAt` in `~/.claude/sessions/<pid>.json`,
  earliest of several holders, no claim when any is unrecorded): a message older than the process means the
  turn died with an earlier one. Incident: queue/harbor showed `busy` at 0% CPU for hours after `paw restart`
  — their transcripts ended on a `<task-notification>` ("Background shell command didn't finish before the
  previous session ended") written as the old process died, followed only by the resumed process's
  metadata lines. Process start beats "metadata lines are a boundary": those record types are undocumented
  and also appear mid-session. A dead process's `tool_use` is dropped too (no false `in tool Xm`; `paw
  unstick` no longer Escs an idle prompt). Test: `check:status`.
- **A compaction is not a turn (2026-10-24).** Same process this time: claude's IDLE compaction ("Compacted
  while idle, before the prompt cache expired", `idleCompaction` setting) lands after a closed turn as a
  `system/compact_boundary` record plus a `user` record with `isCompactSummary: true` +
  `isVisibleInTranscriptOnly: true` ("This session is being continued from a previous conversation that ran
  out of context…"), then attachments + metadata — no assistant reply ever follows. `turnState` read the
  summary as a prompt, so evals-intern/mcp-intern showed `busy` for hours while `paw who` said idle. Now the
  summary is skipped (the walk reaches the turn it followed: closed stays closed, a mid-turn auto-compact
  after a tool_result still reads running), and a LOCAL slash command (`<command-name>` +
  `<local-command-stdout|stderr>`, e.g. a manual `/compact`) is transparent. A cotal channel injection is
  `isMeta: true` with `origin.kind: "channel"` and DOES open a turn, so it is read as a prompt despite isMeta
  (a DM after the compaction → busy until answered). Test: `check:status`.
- **A resume-time stale-task notice is not a turn (2026-10-27).** On resume claude writes, per background
  task of the PREVIOUS process, a `user` record `<task-notification>` (`<status>stopped</status>`, "Background
  shell command didn't finish before the previous session ended" + a "No completion record was found" note)
  with `origin.kind: "task-notification"`, `promptSource: "system"`, `queueSkipAttachments: true` and
  `queueTranscriptOnly: true`, preceded by `queue-operation` enqueue/dequeue — seconds AFTER the new process
  started, so turnOfProcess can't discount it, and no turn is ever run for it. harbor showed `busy` 1h+ at ~0%
  CPU while `paw who` said idle. `turnState` now skips any `queueTranscriptOnly` user record: across every
  local transcript all 23 such records (stopped, plus a few session-task completed/failed) went unanswered,
  while a normal task-notification (no flag, any status) still opens a turn. Test: `check:status`.

## json output

- **`paw status --json` / `paw inbox --json`** — machine-readable output added for the extension and
  useful for any tool. status emits the SAME `AgentStatus` rows the table renders (so the two cannot
  disagree) plus the inbox-lag `errors` IN the payload rather than only on stderr. **inbox's `--json`
  never advances the shared `inbox.cursor`** — a GUI polling every second would otherwise silently
  mark everything read out from under `paw inbox`/`paw chat`, which share that one unread marker;
  `--watch` + `--json` fail loud (one-shot vs feed).

## mesh and machine

Agents run on several machines (this mac, the mini, the fly agents box) and several meshes, so
`paw status` prints a `mesh <space> · local|remote broker <url> · you're on <machine>` line above the
table, and a **MACHINE** column (never dropped by the width planner). Rows in `--json` carry `space` and
`host: { label, via, here }` (absent = not running and not teleported).

Where "machine" comes from (src/hosted.ts `machineOf`, evidence only, strongest first):
1. **mesh** — the agent's card: `meta.machine` (shown) / `meta.host` (raw hostname, compared).
   cotal reserves `meta.host` but sets nothing, so paw's connector stamps `host:` + `machine:` into the
   persona at every launch (src/host-stamp.ts); cotal's agent-file loader sweeps unmodelled frontmatter
   keys into card meta. Only claude seats launched by a released paw carry it (kit/hermes/acp don't yet).
2. **teleport** — the persona's `teleported:` target (`ssh:mini`, `fly:2027-agents`), live or not.
3. **manager** — in THIS machine's ps (the rail is pinned to this machine's manager instance).
4. **foreground** — a live `paw claude --fg` here.
5. **local-space** — a registered, not-teleported agent on a local space (one manager per local broker).
6. otherwise a running agent is `?` — never a guessed name.

A machine's NAME (`machineName`): `PAW_MACHINE` > the space's remote record `--as` name (the mini boots as
`aleks-mac-mini`, the fly box as `fly-agents` — its hostname is an opaque machine id) > the hostname's
first label (`aleks-macbook`). Tests: `check:status` (machineOf, machineName, stampHost round-trip
through cotal's `loadAgentFile`, the column, the mesh line).

## speed

- **2026-10-05: `paw status <name>` 3.6s → ~0.5s, full `paw status` 3.5s → ~0.65s** (126 registered,
  18 live, bun CLI, load ~15; medians of 5, interleaved with the old build). Profiled with
  `bun --cpu-prof` and phase timers; where the time went and what fixed it:
  - **The control-rail resolve, twice (~1.3s).** `bin/paw.ts` ran `ensure()` (whose manager probe is a
    full `ps`) and then status opened a SECOND `ManagerControl` and resolved the service again. A
    resolve is NOT one round trip: cotal's `resolveService` recompiles the input+output contract of
    EVERY command the manager serves (31 in 0.66 → 62 Ajv compiles, each building a fresh Ajv that
    re-compiles the 2020-12 meta-schema) — ~0.5s of CPU. Fixes: (1) `status` left NEEDS_MANAGER and
    calls `ensure({ managerProbe })` itself — the probe IS status's ps read, on status's own control
    (`EnsureOpts.managerProbe`; ensure otherwise unchanged — mesh, hub, mailbox, manager start if the
    probe fails; only shared when the read space is the space ensure() targets); (2)
    `withManagerControl(…, { only: ["ps"] })` resolves just `ps` via `resolveCommands` in
    src/control.ts — cotal's own walk (describe → contract store → closure fetch → profile compile,
    same tamper checks) over its exported pieces, stopped after the named commands. 429ms → ~65ms. A
    command outside `only` fails loud as `not-found` (`check:rail` 5b). Asked upstream as an `only`
    option on `resolveService`; drop the local copy when it lands.
  - **`status <name>` collected the whole fleet then filtered.** Names/folders now resolve FIRST
    (`CollectOpts.only`, the same `selectRows` over name stubs, so unknown names fail loud with the
    same did-you-mean); per-row reads run only for the asked rows. State words (`busy`, `live`…) still
    read everything — they are judged on collected rows.
  - **git for 126 folders (~1s, 600+ subprocesses) for a column the table never shows.** The table
    collects with `git: false`; `--json` keeps it (Raycast reads it) — the JSON shape is unchanged.
  - **Per-agent rereads.** `transcriptPath` scanned all ~290 `~/.claude/projects` dirs per call, ~5
    calls per agent; the session index (`~/.claude/sessions`) was re-read per agent twice; failure,
    context and turn state each did their own tail read. Now: `transcriptPaths` (one listing of each
    project dir, same first-dir-wins answer), `readIndex()` once, and `transcriptTails` (ONE 128KB
    read, sliced so it is byte-for-byte `tailRead(64K)`/`tailRead(128K)`). Turn state is still only
    computed for live rows.
  - **Process scans.** `liveSessionProcs` ran `ps` per live pid; now one `ps -A` for all
    (`liveSessionProcsMany`). NOTE macOS ps: `-p a,b,c` (a pid LIST) costs ~130ms — it walks every
    process — while `-p <one>` is ~15ms and `-A` ~50ms. `hubState` was 3 sync pgreps + a ps per pid;
    it is now async + concurrent (per-pid `ps -p`), and runs during the probe's ps round trip.
    `ensureManagerUp` reuses its `managerProcs` result instead of a second pgrep.
  - **Inbox lag** listed every DM consumer once PER AGENT; now one listing, started at the top of
    the collect so it overlaps the roster read (`listDmConsumers` + pure `inboxLag`, same
    none/error/`?` rules — `check:status`).
  - **Startup.** `bin/paw.ts` loads command modules lazily: `status` imports only src/status.ts
    (~0.15s less evaluation); every other command still loads all of them, in the old order.
- **What's left (~0.5s):** bun start + imports ~0.15s, the manager's own reply latency ~0.14s per
  request (ps and inspect alike — manager side, not paw), the narrowed resolve ~65ms, ensure's
  pgreps ~70ms. Getting to ~0.2s needs the manager to answer faster or a long-lived holder of a
  resolved rail (paw web's `sharedManagerControl` is one) to answer `status` for the CLI.
- Verified identical: `paw status --json` (all rows, every field but `activeMs`), the table (every
  line but ACTIVE), `status <name>`, `status live`, `status <folder>`, and the unknown-name error,
  against the previous build on the live fleet.
- **2026-10-19: mtime caches.** Persona frontmatter is cached per path by (mtime ns, size)
  (`frontmatterLines`, src/session.ts); a transcript's derived failure/context/turn answers — not its tails —
  by (mtime, size) (`transcriptMemo`); `transcriptPaths`' directory listings by dir mtime (`listDir`). The
  `ps -A` behind `liveSessionProcsMany` is async now (it ran on paw web's event loop). Warm collect on a
  148-agent copy: ~200ms → ~110ms CPU, rows identical. `check:status` covers invalidation.
