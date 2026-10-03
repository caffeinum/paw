# Raycast extension

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## raycast

- `raycast/` — **the Raycast extension** (its own npm project, NOT a pnpm workspace member; paw's
  tsconfig `include` is explicit so `pnpm typecheck` never sees it). Two commands: **Paw Agents** (the
  `paw status` roster — mesh status, runtime, folder, inbox lag, last-active; Enter chats) and **Paw
  Chat** (opens straight into ONE GLOBAL transcript — every agent's DMs to "you" land in the same
  inbox, so the dropdown picks who your NEXT message goes to, not what you're looking at; the List
  SEARCH BAR is the composer — Raycast has no chat primitive, so `filtering={false}` + controlled
  `searchText` is the idiomatic substitute).
  **It SHELLS OUT to the `paw` CLI, never joining the mesh itself** — paw's human peer "you" owns a
  SINGLE durable DM consumer and cotal allows one active consumer per durable, so a second process
  connecting under that identity would contend with a live `paw chat`/`paw inbox` and starve it. Via
  the CLI, Raycast is just another reader of the same state. Raycast runs extensions with a MINIMAL
  PATH (no shell rc, no nvm), so the launcher is invoked by ABSOLUTE path — fine, because
  `~/.local/bin/paw` already resolves bun/tsx absolutely for exactly this class of caller (verified
  with `env -i`). Sending is `paw dm` (which also WAKES an offline agent from its pin); replies arrive
  by POLLING `paw inbox --json` every 2s (skipping a tick while the previous one is still in flight,
  or a slow mesh stacks `paw` processes; a RUN of failed polls toasts instead of looking like a quiet
  empty chat). The chat opens on the last 30 inbox messages and then shows anything newer than the
  moment it opened — a bounded tail, because the inbox holds the whole history with every agent and
  replaying all of it would bury the conversation you just started. There is no mesh-side "working"
  signal to render (`cotal_status` is agent-invoked, so peers read `idle` mid-turn), so a pending line
  carries the honest client-side one instead: `sending…`, then a ticking `waiting 12s`, then `failed`.
  **Installing is `npx ray build -e dev`, run ONCE — no dev server needed.**
  That hands the compiled bundle to the Raycast app, which keeps its OWN copy: nothing is written into
  the extension folder (no `dist/`, no hidden build dir — checked), and the commands stay in Raycast
  after the CLI exits. Re-run it after a change to push the new build; `npm run dev` is the same thing
  plus a file watcher. (An earlier note here claimed the extension was only live while `ray develop`
  ran — WRONG, and it sent the operator hunting for a daemon they did not need.) **Unread state is RAYCAST'S OWN, tracked PER MESSAGE**
  (`src/read-state.ts`, a LocalStorage Set keyed per space). Two designs failed first, both worth
  keeping: (1) sharing paw's `inbox.cursor` — every paw surface advances it as a side effect of
  DISPLAYING, so with `paw chat` open in a terminal it is past the newest message before Raycast
  renders and nothing is ever unread; (2) a Raycast-local CURSOR — still ONE number for the whole
  inbox, so reading anything from agent B silently marked agent A's older messages read, and since it
  only moved on an explicit keystroke it never moved at all. The unit of reading is a MESSAGE, so the
  state is per message, and a message is marked read when you SELECT it — that makes the state
  maintain itself instead of depending on a shortcut nobody presses. Bounded at 2000 keys (oldest fall
  off, which can only resurface an old message as unread, never hide a new one); an unparseable value
  reads as "nothing known read", never "all read" — a storage glitch should show too much mail, not
  hide it. ⌘⇧R marks everything currently VISIBLE (in a focused view, that conversation only) and also
  advances paw's shared cursor, since "I have read these" is true everywhere. The store is SHARED, not
  per-component, for the same reason `feed.ts` is: Raycast keeps pushed-behind views MOUNTED and the
  chat stacks a focused view over the unfocused one, so two components each held a copy loaded at
  mount and the filtered and unfiltered views disagreed about what you had read. Subscribers and the
  in-flight load are keyed BY SPACE — one session only talks to one space today, but a flat set would
  quietly hand space A's read state to a view showing space B.
  **Image attachments** ride as extra
  ARGV WORDS to `paw dm`, that command's existing contract (it peels absolute paths, stages them,
  rewrites to `[Image #1]`), so Raycast gets paw's whole attachment pipeline and cannot drift from the
  terminal. macOS has TWO clipboard shapes and both are handled: a COPIED FILE exposes a path
  (`Clipboard.read().file`), while a SCREENSHOT is raw image DATA with no path — Raycast exposes no
  image buffer, so that case goes through `osascript` (`the clipboard as «class PNGf»`) written under
  `~/.paw/clipboard/`. A zero-byte or failed extraction is DROPPED rather than announced as an image the
  agent can't Read, and a FAILED send puts the staged images back instead of silently losing them.
  Verified end to end: clipboard data → osascript → `paw dm` argv → staged → received → Read rendered it.
  **Empty states are gated on the FIRST read**, in both commands: before it lands, "no messages" /
  "no agents registered" is not true, it is not-yet-known, and flashing it reads as a broken chat or a
  dead mesh. An error also counts as loaded — better the empty state than a spinner forever.
  **Enter on an EMPTY composer toggles the filter** (it was a no-op before): narrow to the agent whose
  message the cursor is on, Enter again on empty widens back. The primary action RENAMES itself
  ("Send" / "Filter to X" / "Show All Agents"), because an unlabelled key that does two different
  things depending on hidden state is a feature nobody finds.
  **Two modes, expressed as NAVIGATION.** Unfocused, the chat is the whole inbox (every agent's DMs to
  "you" share one stream); opening an agent from the roster pushes a FOCUSED view — that agent's
  messages plus your own sends to them — on top of the unfocused one (`ChatEntry`). So Escape widens to
  the full transcript and Escape again goes back, WITHOUT paw binding Escape: it is bindable, but taking
  "go back" away from the operator is a worse trade than one extra view on the stack. The recipient
  dropdown is hidden while focused (switching it there would send to B while you read A).
  **`src/feed.ts` — one refcounted poller per kind, because Raycast keeps pushed-behind views MOUNTED.**
  The moment the chat stacked two views, per-component intervals meant TWO `paw` processes every 2s,
  each spawning a runtime and connecting to NATS — the cost is O(views), and views are exactly what the
  operator adds by navigating. N subscribers now share ONE interval and ONE invocation; the last
  unsubscribe stops it, and a new subscriber gets the last payload immediately so a pushed view renders
  populated rather than blank-then-filled. The roster feed yields the WHOLE `StatusPayload`, not just
  rows: `errors` carries paw's inbox-lag query failures (which paw reports rather than fabricating a
  zero for), and dropping them to keep the type tidy would discard the one signal saying the lag column
  is unknown rather than fine.
  **Row shape:** the row carries the AGENT NAME, the read/unread state and the time — and NOT the
  message, which lives in the detail pane. Three columns competing for a narrow list truncated all
  three ("paw-fol… / all thre… / 3 minutes"); dropping the preview gives the name and stamp room to
  render whole. The LEFT slot carries ONE signal — this is new: an unread row gets a dot, a READ row
  gets NO icon, so the eye lands on what changed instead of scanning a column of identical decoration
  (an indicator every row has indicates nothing). A FAILED send keeps its mark regardless — an error
  must never be the thing that renders as blank. An unread line from an agent that is currently OFFLINE
  goes RED, because that is the case where no reply is coming until something wakes it; the roster
  behind it is re-read every 15s (much slower than the 2s message poll — presence changes on a human
  timescale) since a red "offline" dot that is merely STALE is worse than none. Offline stays GREY on
  the agents list on purpose: most agents are offline most of the time, so painting twenty rows red
  would make the resting state look like an alarm. Times are
  RELATIVE (`date-fns` `formatDistanceStrict`, pinned 4.4.0 for the age gate) computed from a threaded
  `now` rather than the wall clock, so the whole list renders off ONE instant and cannot disagree with
  itself; `now` ticks every 1s while awaiting a reply and every 30s otherwise, because a relative stamp
  that stops ticking freezes at whatever it said when the last message landed. **State is never encoded
  in colour alone** — Raycast themes recolour, and a tinted tag can land invisible against the accent
  (the "red on red" report), so unread is a glyph in the accessory TEXT (`● unread`), which inherits the
  theme's own foreground.
  `@raycast/api` is PINNED to 1.104.23, the newest release outside the
  registry's min-release-age window (the gate is a supply-chain guard — pin, don't override).
