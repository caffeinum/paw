# DMs, inbox, mailbox, read path, channel replay

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## paw dm

- `src/dm.ts` — `paw dm <name|folder|repo@branch> "<msg>"|-`: **fire-and-forget** DM to an agent. A lone
  **`-`** reads the message on **STDIN** — for producers that hand text to a command rather than build an
  argv (voice dictation prompted it: yapless runs its `output.command` with the transcript on stdin).
  NOT `"$(cat)"` at the call site: dictation is full of apostrophes and newlines so shell quoting breaks
  on the first possessive, and argv is world-readable in `ps` so every utterance would leak to any
  process listing on the machine. paw OWNS
  `dm` (NOT aliased to cotal's `send`) so it sends under the stable **"you"** identity — cotal's `send dm`
  fires from a throwaway peer literally named "send" (registerPresence:false, no inbox) that's gone the
  instant it sends, so the agent's reply is undeliverable ("send went offline"). Sending as "you"
  addresses the reply to your durable inbox; read it with `paw inbox`. **Pure sender**: registerPresence
  false (the mailbox beacon holds "you" present), **consume:false** (never binds "you"'s single durable
  consumer — that's `paw inbox`'s, and contending would starve it), watchPresence true only to
  resolve/spawn the target like chat (folder→spawn, offline name→respawn via `folderForName`). No
  wait/stream mode — the LIVE conversation is `paw chat`, the ASYNC hand-off is dm + inbox (a former
  `--wait` bound the durable consumer and could starve inbox/chat; removed). NEEDS_MANAGER.

## paw mailbox

- `src/mailbox.ts` — `paw mailbox` (daemon; auto-started by `ensure()`, not run by hand): the
  persistent **"you" presence beacon**. An agent can only deliver a DM to a peer it can RESOLVE in the
  live roster, so without a standing "you" presence a reply sent after `paw dm` exits is undeliverable
  ("send went offline"). This holds the stable "you" identity online (2s presence heartbeat) so agents
  can always reach you; their DMs land in your durable inbox for `paw inbox`. **Pure beacon:
  registerPresence:true, consume:false** — it never drains/acks your inbox (that would starve
  `paw inbox`/chat — cotal allows ONE active consumer on "you"'s durable). lifecycle.ts `ensureMailbox()`
  spawns it DETACHED (`node bin/paw.ts mailbox --space <s>` via the tsx runtime, pid in `mailbox.pid`, log in
  `mailbox.log`), called from `ensure()` on any mesh-up context; `stop()`/`paw down` kills it.

## paw inbox

- `src/inbox.ts` — `paw inbox [--history] [--watch] [--limit N]`: read the human peer ("you")'s DM inbox — the
  READ half of the async loop (`paw dm @agent "task"`, walk away, `paw inbox` to collect the
  reply/PR/question). **PURE READER**: reads the DM stream directly via `ep.dmHistory()` (a throwaway,
  non-acking consumer, observer endpoint — registerPresence:false/consume:false) filtered to
  `m.to === me`, so it NEVER binds the durable consumer and can't contend with a live chat/`dm --wait`.
  "New since last time" is the SHARED local cursor (`src/cursor.ts`, `inbox.cursor`), NOT mesh acking:
  **default** shows DMs with `ts > cursor` then `advanceCursor`s past them; **`--history`** shows the
  last N (default 50), cursor untouched. **`--watch`** is a live foreground tail: it polls the SAME
  pure-reader path every 2s (mirrors `log --follow`), prints DMs as they arrive, and advanceCursor-s
  past each so the shared unread state stays consistent (Ctrl-C to exit; never binds the durable
  consumer, so it runs alongside a live `paw chat`). **It keeps its OWN high-water mark rather than
  gating on the shared cursor** (fixed 2026-08-06, reported live): the cursor answers "what haven't I
  read?" and EVERY surface advances it, so a `paw chat` open in another tab displayed each DM, moved the
  cursor past it, and the cursor-gated tail sat showing nothing while mail visibly arrived next door. A
  tail answers a different question — "what is arriving while I watch?" — which must hold whether or not
  something else also read it. First tick drains the unread backlog (cursor-gated, the useful catch-up);
  everything after is gated on what the tail itself has shown; it still ADVANCES the cursor, because
  reading here IS reading. Verified against a reader racing the cursor: old code printed 0/6, new 6/6.
  `--watch` + `--history` fail loud (contradictory).
  `paw chat` advances the SAME cursor when it shows a DM, so a
  message read live in chat won't re-surface in inbox (and vice-versa) — one unread state across both. Reads the newest via a tail (dmHistory returns oldest-N, so fetch up to `FETCH_CAP=10k` and
  slice the tail — a deeper history needs a tail-read API cotal lacks). NEEDS_MESH (mesh only).

## inbox sent

- **`paw inbox --sent`** — widen the read to BOTH directions (adds `dir: "in"|"out"` and, for an
  outgoing message, `to`). The default stays your INBOX (messages addressed to "you"); a chat UI needs
  the whole conversation, because a transcript of only the other side is half of one and reopening it
  would lose everything YOU said. The recipient is an ID on the wire, so names are resolved from the
  stream itself (any agent you have talked to has almost certainly replied, and its reply carries
  `from.name`); an id that never appears as a sender STAYS an id — an id you can still match on is
  honest, a guessed name is not.

## inbox mark-read

- **`paw inbox --mark-read`** — the EXPLICIT "I've seen these" verb, added for surfaces that DISPLAY
  without consuming. Every other read path either advances `inbox.cursor` as a side effect of PRINTING
  (the default) or deliberately never touches it (`--history`, `--json`); a GUI showing unread state
  needs a way to clear it that isn't "print everything again". Forward-only like every other writer, and
  it counts BEFORE advancing (counting after always reports 0 — caught immediately).

## src/feed.ts

- `src/feed.ts` — **the shared read path** (added 2026-08-06): `messageText` (THE flattener — it had four
  independent copies in chat/inbox/watch/history, which this file's own notes warned about),
  `observerEndpoint` (connect as "you" but only to LOOK: registerPresence:false + consume:false, so no
  reader can ever bind the durable), `readConversation` (dmHistory → `Entry[]`, `withSent` widens to both
  directions), `FETCH_CAP`, and `pollLoop` (the non-overlapping tick — the re-entrancy guard is the point:
  a tick outlasting its interval would re-read the same pre-advance cursor and print twice). `paw inbox`
  (+`--watch`) is now a renderer over it; watch/history/chat take `messageText` from here.
  **It deliberately does NOT own `paw chat`'s connection:** chat joins as a PARTICIPANT (registerPresence
  + consume — it's a peer others must reach), everything here is an OBSERVER. Collapsing those into one
  factory would hide the distinction that matters most.

## src/cursor.ts

- `src/cursor.ts` — the human's single "have I seen this DM?" marker: one local file per space
  (`inbox.cursor`, a ms epoch), zero-dep like names.ts. `readCursor`/`advanceCursor` (FORWARD-only, so
  concurrent readers can't rewind each other). BOTH readers advance it — `paw inbox` when it shows new
  mail, `paw chat` when it displays a DM live — so one unread state spans both surfaces (read a DM in
  chat → inbox won't re-surface it). Separate from cotal's durable ack so inbox never binds that slot.

## Channel replay (why a restarted agent gets flooded)

**Symptom (2026-08-13):** restart an agent and it takes ~25 wake nudges in a row, replaying channel
traffic from days ago — "New channel from you — delivering your Cotal inbox now", over and over. They
are CHANNEL messages, not DMs.

**Cause, from cotal's own resolution:** replay-on-join is `per-channel ?? space default ?? **true**`
(`effectiveReplay`), and an unset `replayWindow` means **the full retained window**, not a recent
slice. The backfill runs on **first connect of a process** — and a restart IS a first connect for the
new process (a reconnect reopens the subs WITHOUT re-backfilling; only a fresh process re-reads). So
every restart replays a channel's entire retained history, and each replayed message fires its own
wake nudge.

**The lever** (`paw cotal channels …`, verified live):
```
paw cotal channels list                          # space default + per-channel entries
paw cotal channels default --replay --window 1h  # bound it space-wide
paw cotal channels set general --window 24h      # or per channel
paw cotal channels default --no-replay           # or no backfill at all
```
**`--window` is a DURATION, never a count** — `parseDuration` accepts only `<n><s|m|h|d>` and THROWS
otherwise, so "the last 10 messages" is not expressible. Set to `1h` for this space.

**The cost of a short window, and why it's a real trade:** this space's channel `deliveryClass` is
`live`, and in open mode there is no durable backstop for channels (Plane-3 needs the delivery daemon,
which paw doesn't run — see the delivery-daemon note). So the replay IS the only catch-up path: an
agent down longer than the window doesn't get that traffic late, it never gets it.

**Reading the config back is not trivial:** `channelDefaults` is populated by a KV watch gated on
`doWatch && doWatchChannels`, so an `observerEndpoint` with `watchPresence:false` NEVER opens the
channel registry and reports every window as unbounded — which looks exactly like "the setting didn't
take". Probe with `watchPresence:true` (a real agent opens it via `consume:true` instead).
