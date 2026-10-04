# paw web

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## paw web

- `src/web.ts` + `web/app/` — **`paw web`**: the mesh in a browser, LOCALHOST only (added 2026-08-06,
  built by three agents: dev-web the daemon, pm-web the acceptance checks, paw-folder the client).
  `paw web [--port 7788] [--space s] [--no-open]` — **7788 because cotal web owns 7799**, and a busy port
  THROWS rather than picking another (auto-increment is the failure that looks like success: you open the
  port you asked for and debug this morning's stale daemon). Serves `GET /api/status` · `/api/inbox` ·
  `/api/trace/<name>` · `POST /api/dm` · `POST /api/read` and a `/ws` pushing `{type:"message"|"status"}`.
  **WHY IT EXISTS rather than `cotal web`:** cotal web cannot see paw-local state (per-folder agents,
  sessions, the shared cursor) or an agent's TRACE — the claude transcript lives on disk and never crosses
  the mesh. **Security (no token, operator's call):** loopback bind + EXACT-match Origin (a `startsWith`
  passes `127.0.0.1:7788.evil.example`, ours-in-the-path and ours-as-userinfo) + a **Host** check, which is
  what actually stops DNS rebinding. **The server owns unread** — over the WHOLE conversation, not the
  page slice, or the count changes with every `limit` a caller passes; `dir !== "out"` (not `=== "in"`,
  because the inbox-only shape omits `dir` and everything in it is by definition addressed to you).
  `POST /api/read {ts}` is the CLEAR half — without it the badge only ever counts up, since the cursor
  advances when a paw surface DISPLAYS a message and a browser isn't one. `ts` is what was displayed, not
  `Date.now()`, and the client only marks when the tab is **visible and focused** — rendering happens in a
  background tab too, and silently-cleared mail is worse than a stuck badge. **The hand-rolled WebSocket
  framing is where the bugs were:** 27 assertions found a control frame >125 bytes truncating its length
  and desynchronising the stream (RFC 6455 §5.5). The pong is the assertion in those tests — a misparse
  leaves the stream misaligned rather than erroring. Tests: `check:web` (hermetic; it
  points PAW_HOME at a temp dir because `/api/read` WRITES the shared cursor).
  **`/invite @agent` (composer slash-command, 2026-08-06)** — `POST /api/invite {channel, names}` DMs
  each agent asking it to `cotal_join` the channel you're viewing, then posts `invited @a, @b to this
  channel`. It is a **REQUEST, not an admin action, and the surface must not pretend otherwise**: cotal
  has no "add someone else to a channel" — membership is the agent's OWN act — so paw can only ask, and
  the channel line is what makes the ask visible even if the agent never acts on it. Only agents
  actually REACHED are announced (naming an un-DM-able one would claim something that didn't happen);
  one failure never aborts the rest; the DMs go SEQUENTIALLY because each may spawn a sleeping agent.
  The parse (`web/app/commands.js`, tested) is client-side since it decides command-vs-message, matches
  only at the START of a line (so "use /invite to add someone" still sends as a message), and REPORTS a
  token that can't name an agent rather than dropping it (`/invite @a @b!` must not read as though @b
  was asked). In a DM it stays an ordinary message — there's no channel to invite anyone to. **Caveat
  that WILL bite: an agent's ACL is minted at SPAWN**, so an agent already running from before the
  channel-grant fix refuses the join until restarted (observed live; the agent diagnosed itself:
  "ACL is baked at spawn"). Verified live end-to-end into a brand-new channel.
  **Drafts, conversation stepping, and the unread divider (`web/app/conversation.js`, 2026-08-07).**
  **Drafts are PER (space, target)** — there is ONE textarea, so nothing scoped them and a half-typed
  line stayed in the box on switch, i.e. one global draft following you around (that's how a message for
  one agent gets sent to the next one you open). Persisted in localStorage, because the point of keeping
  what you typed is that it survives the reload you most want it back after; keyed by SPACE too, since
  two spaces share a browser origin. **Staged images move with the draft but are NOT persisted** —
  unscoped they'd attach to whatever you opened next, but a persisted staged path would promise a file
  cmux may have reaped (the failure images.ts stages around). Cleared when the draft becomes a message,
  NOT on a failed send (that text lives on in the retryable pending row). **The restore waits for the
  first inbox read**: the key needs the space, which only that read reveals — restoring in `readUrl`
  reads the wrong key, comes back empty, and leaves the draft on disk with no way to reach it.
  **Option-↑/↓ steps conversations** in the sidebar's own order AND filter (`orderTargets` — a keyboard
  order that disagrees with the visible one makes the selection look like it jumps at random). CLAMPED,
  never wrapped (in a 40-agent list a wrap is indistinguishable from a glitch); a focus filtered out from
  under you starts from the top rather than doing nothing. Bound on the DOCUMENT so it works with the
  cursor in the composer, `preventDefault` because macOS otherwise moves the caret by paragraph.
  **The "new" divider** marks where you left off. `firstUnreadTs` is computed ONCE when the conversation
  is opened and FROZEN: the cursor advances as messages are displayed, so a live one would slide away
  while you were still looking for your place. Only INBOUND messages open the run (your own send would
  put the line above your own words); CHANNELS are excluded because unread is tracked against the DM
  cursor and there is no channel equivalent — a divider there would be unsupported. The scroll-to-divider
  is ONE-SHOT (scrolling on every poll is the bug that made reading older messages impossible). Test:
  `check:web`; all three verified in a real browser.
  **`!cmd` in the composer (2026-08-13)** — `POST /api/bash {agent, command}` runs a shell command in the
  FOCUSED AGENT'S folder (`folderForName`; an unregistered name fails loud rather than defaulting to
  some directory), then **DMs the agent the command AND its output** (`bashMessage`, a fenced console
  transcript). Handing it over IS the feature: `!git log -5` becomes the agent's context, so the next
  question is grounded in what the repo says. Stated plainly: **this is arbitrary code execution
  reachable from a page.** It's consistent because `paw web` ALREADY exposes `/api/dm` against agents
  running `bypassPermissions` — directness, not new capability — and inherits the same and only
  defences (loopback + exact Origin + Host). NOT a boundary. Only a LEADING `!` counts (`src/bash.ts`
  `parseBang`, mirrored client-side in `web/app/bash.js`), so prose containing one never runs; the
  command goes through a SHELL on purpose (pipes are most of why you'd type it), so nothing may ever be
  assembled from anything but what the operator typed. 60s timeout, 256KB output cap, and `code` is
  read as a NUMBER only (a spawn failure sets it to a STRING like ETIMEDOUT, which would render as
  "exit ETIMEDOUT"). The result returns even when the DM fails, so a command whose delivery breaks
  isn't also lost to the operator. Test: `check:web`.
  **A rebuild waits for your text selection (`selectionInside`/`pendingRender`, 2026-08-19)** —
  `renderMessages` writes `innerHTML`, which destroys every node in the list and takes the operator's
  SELECTION with it. The relative stamps ("3m ago") change on their own, so a poll eventually produces
  different HTML through no action of yours: selections vanished every 15–30s while reading. A rebuild
  now POSTPONES while a non-collapsed selection sits inside `#msgs`, and runs the moment it clears
  (`selectionchange`); a SEND bypasses it, because your own message is your action, not a poll.
  **Two mistakes worth keeping, both mine, both caught only by using it:** (1) I first paired this with
  a "skip if the HTML is identical" MEMO, which broke the list outright — the empty-state branch writes
  `#msgs` without touching the memo, so the two desync and every later render is skipped against a DOM
  that no longer matches (a cache of what the DOM holds must be invalidated by EVERY writer, and this
  function is not the only one). (2) The `selectionchange` listener must clear `pendingRender` BEFORE
  calling `render()`: render rebuilds the sidebar, which perturbs the selection and re-fires the event —
  with the flag still set that is an infinite loop, and it froze the tab. Verified live: a selection
  held 20s across ~10 poll ticks with **0** rebuilds, then 7 rebuilds the instant it was released.
  NOTE the underlying cost this only mitigates — the list is **300 rows / ~420KB of HTML rebuilt
  wholesale**; the real fix is incremental rendering or a smaller Activity window.
  **Quote reply, clickable names, and timestamp-jump (`web/app/quote.js`, 2026-08-19)** — three ways to
  act on a message you are looking at, all missing until now. **Quote reply:** select text in a message
  → a button follows the SELECTION (fixed-position, where you finished dragging) → the text lands in
  the composer markdown-quoted, ABOVE any draft you had, with a blank line under it and the caret
  below. **Every line is quoted INCLUDING blanks** — a bare blank line ENDS a markdown quote block, so
  a half-quoted paragraph renders as quote-then-body and silently attributes the rest to YOU; that is
  the one way this can misrepresent who said what. Leading indentation survives (in a code block it IS
  the meaning). **`mouseup`, not `selectionchange`** (the latter fires per character and the button
  would chase the cursor mid-drag), deferred a tick (at mouseup the selection isn't yet what the
  browser will report), and the handler IGNORES events from the button itself — otherwise its own
  mouseup re-creates the button after the click hid it. `hideQuote` removes EVERY `.quotebtn` in the
  DOM rather than the one the closure holds: the tracked reference can be reassigned between create and
  hide, and the orphan floats over the page acting on a selection you can no longer see. **Names and
  the `→` chip open that conversation** (only when the name is a known agent — an unresolved id has no
  conversation to open). **The timestamp jumps to that message**: it was already the row's most precise
  handle and did nothing. A pending jump **OWNS the scroll for that render** — the follow-to-bottom
  logic runs later in `renderMessages` and would otherwise throw you back to the newest message with
  the row still flashing three screens away, which reads as a half-working click. The flash is held in
  STATE (`flashTs`), not as a class on the node, because the 2s poll rebuilds every row. In Activity,
  quoting also OPENS the quoted message's conversation — there is no composer to quote into there.
  **The jump TOP-aligns, it does not centre (`jumpScrollTop`)** — centring was wrong in a way that looks
  like a different bug entirely: an agent message is routinely TALLER than the viewport (measured live:
  2357px in a 553px list), so centring starts it above the top of the list and the operator reports
  "ignores header size" — the header overlaps nothing, the message simply began off-screen. When you
  jump to a message you want its BEGINNING, so it top-aligns and gives back whatever headroom is spare:
  a short message shows some of the conversation above it for context, a tall one gets a 12px margin
  and starts at its first line. Both clamps matter — uncapped, a short message would land halfway down
  the screen. Test: `check:web` (21 assertions incl. the taller-than-viewport case); all verified in a
  real browser.
  **The PRs section (`web/app/prs.js`, `/api/prs`, `prInfoMany`, 2026-08-19)** — what the RUNNING agents
  currently have open on GitHub, in one place. Different question from the roster ("who is here"): a
  fleet that mostly writes code is really working on a handful of PRs, and the only way to see one was
  to focus an agent and read its header. **LIVE agents only** — that's what "active agents' cwds" means,
  and a stopped agent's branch isn't work in progress; including 40 of them turns a decoration into a
  rate limit. **Cost is the whole design constraint:** each entry is a `gh pr view` network call, so it
  rides git.ts's 60s cache (which caches MISSES too — the common case is a branch with no PR),
  `prInfoMany` runs them ≤5 at a time, and `shouldRefetch` refuses to run on the 2s message poll or
  while the section is folded shut. `prInfo` gained `headRefName`→`branch` (the PR's OWN branch, not
  the folder's current one — a worktree can be checked out elsewhere), `additions`/`deletions`, and
  `rollupChecks`: **any failure dominates, then pending, and an UNRECOGNISED conclusion is pending —
  never claimed as pass.** No checks configured is `undefined` and renders NOTHING, distinct from a
  spinner that never resolves; an unknown diff size renders nothing rather than a false `+0 −0` (zero
  itself is a real answer and shows). Two lines because a PR carries two kinds of fact — what it is
  (status · #number · title · checks) and where it came from (agent · branch · ±) — and one line makes
  the branch truncate and take the title with it; the whole row is one link to GitHub. Sorted by number
  DESC (the number IS the chronology). Verified live against the real daemon and real `gh` data.
  Test: `check:web` (21 assertions).
  **Every worktree, not just the agent's folder (2026-08-27):** `expandAgentWorktrees` (web.ts, pure
  over injected git fns, tested) turns each live agent's folder into ALL worktrees of its repo
  (`gitToplevel` + `listWorktrees` from src/worktree.ts — superconductor's and claude's worktree dirs
  are plain `git worktree`s and show up); a non-repo folder contributes nothing; a worktree reached
  through two agents is one target. The first sweep found 25 PRs of which 12 were merged/closed on
  dead worktrees, hence `keepSidebarPr`: sibling-worktree PRs only while OPEN (drafts included), the
  agent's OWN folder in any state. 13 open across evals + canary-env-52 after the filter.
  **Channel unread (`Channels.stamps`/`activity`, `/api/channel-unread`, `paw.chseen.<space>`, 2026-09-03)** —
  channel rows light up (bold + count) like agent rows. The DM cursor is ONE number for the inbox with
  no channel equivalent, so a channel keeps its own client-side "last seen" stamp per space
  (`loadSeen`/`saveSeen`/`markSeen`, forward-only, corrupt ⇒ nothing seen ⇒ everything unread — too
  much mail, never hidden mail). The SERVER counts: the tracker records every message stamp per channel
  (the one-time backlog scan + the tap, deduped, capped at FETCH_CAP) and `POST /api/channel-unread
  {seen}` answers `{channel: {latest, unread}}` = stamps strictly after `seen[channel]` (never looked
  ⇒ everything counts). A channel is marked seen only when it is the FOCUSED view AND the tab is
  visible+focused — the same `lookedAt` rule DMs use — up to the newest message on screen; the client
  polls the count on every status tick and on a channel `message` socket frame, skipping a tick while
  one is in flight; a daemon without the route leaves the last counts standing rather than flashing to
  zero. Test: `check:web` (both sides).
  **Search (`src/search.ts`, `/api/search`, 2026-09-03)** — the sidebar box FILTERS as you type (as
  before) and **Enter SEARCHES**: two tiers because they cost differently. `scope=messages` = the DM
  conversation the daemon already holds (`searchEntries`, an outgoing hit opens the agent it went TO)
  plus every channel's backlog (`channelMessages`); `scope=transcripts` = the agents' claude jsonl:
  `rg -i -F` finds candidate LINES (one record each), only those are parsed, and a hit is kept only when
  the record's human-readable TEXT (`recordText` — user/assistant text blocks, never tool JSON) contains
  the query; one 12s budget across agents (`agents=` narrows it — the client passes the filter box's
  matches), per-file cap 20, `truncated` reported rather than silently cut. Results are a view in the
  message pane (`SEARCH = "~search"` sentinel, `?at=search&q=`; composer hidden); a DM/channel hit
  opens the conversation and `jumpTo`s the message, a transcript hit opens that agent's trace (no
  in-trace jump yet). Measured live: 122MB + 369MB transcripts searched in 0.3s. Test: `check:web`.
  **Channel header** says `N seen here` (or `everyone subscribes` for #general) instead of the roster
  count that read as "71 agents" on a brand-new channel; an unfolded channel also carries a
  `+ add agent…` row that runs the same `/invite` request (paw can only ASK; joining is the agent's act).
  **The Village tab (`web/app/village.js` + `Village` in web.ts + `/api/village`, 2026-09-09)** — a map of
  the fleet. Iterated with the operator through 5 tracepaper mocks (A grid / B city-blocks / C transit-
  lines-by-owner / D nested-folder-areas / E folder-tree-metro); **E is the shipped design**: the FOLDER
  TREE is the map. A grey orthogonal backbone IS the filesystem — `~` → `Github`/`.superconductor`/`.paw`,
  `Github` → `team2027`/`caffeinum`, each folder → its repos, each repo → the agents living in it — so you
  trace any agent home by walking the line to the root (`buildTree` compresses lone agent-less chains like
  `.claude/worktrees` into one hop; `segmentsFor` maps a folder to its chain, a cotal_spawn peer with no
  folder lives under `· workers`; "you" is a leaf off the root). DM traffic is drawn as STEPPY orange
  rails on the RIGHT (operator: "steppy too") — orthogonal like the backbone, never diagonal, staggered
  lanes, weight = message count. Grouping by REPOSITORY/folder, NOT by owner-type (the C mistake the
  operator corrected: "should not group by type, it should group by repository"). **Edges are REAL**: the
  `Village` tracker rides the same whole-space `ep.tap` and counts DMs `from.name → to` once BOTH ends
  resolve to a name (never a raw id); live-accumulated (paw has no historical agent↔agent store), `last`-
  lines seeded from `Conversation` history for the hover card. Station colours = live/busy/off; a hollow
  ring + dot = interchange (talks across repos or to you, `crossRepo`). Station label is `name · branch`
  (`stationLabel`, from `row.git.branch` already on `/api/status`; worktrees get ⑂) so two checkouts
  of the same repo don't look identical. Shows the living map (live +
  currently-talking); a silent sleeper is hidden but `placement()` keeps its localStorage slot so it
  returns where it was (persistent locations — a new agent is APPENDED). A view like Tasks/Board:
  `VILLAGE = "~village"`, `?at=village`, one sidebar row, composer hidden. Verified headless (real folder
  tree, path compression, status, 0 JS errors). Tests: `check:web` (Village tracker server-side; buildTree/
  segmentsFor/crossRepo/placement client-side).

  **Channels are agent FOLDERS (`web/app/channels.js`, 2026-09-03)** — each channel row carries a ▸
  that unfolds the agents in it: click the channel = message the channel, click an agent beneath it =
  DM that agent (`focusAgent`); the chevron stops propagation so unfolding is never "open". WHERE
  MEMBERSHIP COMES FROM, stated honestly: on an OPEN mesh cotal has no membership registry paw can
  read — `ep.channelMembers()` and `ep.readMembership()` both answer EMPTY (probed live: the members KV
  is manager-written on authed meshes, the feed needs the delivery daemon). So the server's `Channels`
  tracker keeps `authors` = who has been SEEN posting per channel (the tap, plus a ONE-TIME backlog scan
  per channel on the roster tick — a failed scan is retried, never marked done, because "nobody here"
  would be a claim), exposed as `channelMembers` on `/api/status`; the client rule (`channelMembersFor`)
  lists those authors, marks non-roster authors (a human, an endpoint) as `nonagent` (shown, not
  clickable), and lists the WHOLE roster for #general since every paw persona subscribes to it. Open
  state is per space in localStorage (`paw.chopen.<space>`; corrupt ⇒ nothing open). Verified headless
  (playwright, computed style): unfold → names, click agent → `?at=<agent>`, click channel → `→ #ch`,
  survives reload. Test: `check:web`.
  **Foldable sidebar sections (`applyFolds`/`toggleFold`, 2026-08-19)** — Channels · Agents · Archived
  each fold from their header, and the fold is PERSISTED per space (a fold you must redo on every
  reload is a setting that fights you). The header became a control, so it looks like one: pointer,
  hover, `user-select:none`, and a chevron pointing the way the click will go. The row COUNT appears
  only while a section is FOLDED — open, the rows are right there and a number is noise; folded, it is
  the only thing saying what's hidden. `applyFolds` runs on every render (driven from state, never from
  the DOM's current classes) so a fold survives the 2s poll rebuilding the rows underneath it. Archived
  is its OWN foldable section rather than a toggle inside Agents, and its header is `hidden` when
  nothing is filed. A corrupt fold value reads as NOTHING folded — same direction as everywhere else,
  because a section silently shut looks like data that has gone missing. Verified in a real browser:
  fold, chevron, count-when-folded, survives a poll, persists, and unarchiving from inside the Archived
  section returns the agent to Agents.
  **Archiving agents out of the sidebar (`web/app/archive.js`, 2026-08-19)** — this space has 56+
  agents and most are finished work, so the list you navigate by had stopped being navigable. The
  operator's rule IS the design: **archived stays archived until that agent SAYS something** — an
  inbound message un-files it automatically, which is what separates this from a hide-list you must
  remember to prune. State is `name → archived-AT ms`, NOT a set: a set can only answer "is this
  hidden", while the wake rule needs "has anything arrived SINCE", and with a set the very message that
  un-archived an agent would re-archive it on the next poll. **Your own send never un-archives** (that
  is you talking to something you filed away; otherwise clearing a backlog un-files everything you just
  tidied). Two rows are never hidden: the **FOCUSED** agent (the view must exist in the list that
  navigates it — so archiving the OPEN conversation also leaves it, or the button reads as broken) and
  anything matching a **SEARCH** (a search that won't find what you typed is worse than an untidy
  list). Corrupt storage reads as EMPTY — a glitch must show too many agents, never hide one. Client-
  side per space like drafts/read-state: a view preference for THIS surface, never a fact about the
  mesh. The prune runs inside `renderAgents` (every 2s) and only WRITES when something actually woke.
  Verified in a real browser, both directions: archived-before-the-message came back into the list and
  out of storage, archived-after stayed put. **Un-archiving is not instant** — it fires on the first
  poll after the message reaches the client, a few seconds. Test: `check:web` (14 assertions).
  **Who an outgoing message went TO, in Activity (`recipientLabel`, 2026-08-19)** — Activity is every
  conversation at once, and an outgoing row said only "you", so the one fact a mixed feed cannot
  recover was which agent you said it to (inbound rows never had the problem — they carry `from`).
  Rendered as a chip in the header's existing tag slot (empty until now for outgoing; inbound shows
  `AGENT`), and **only in Activity** — in a focused conversation the answer IS the view, so the chip
  would be noise on every row. The recipient is an ID on the wire and paw resolves it to a name only if
  that id has ever appeared as a SENDER, so the label must render both: a roster name renders whole, an
  unresolved id is SHORTENED to its actor (`UB5BWUNB…`) and never dressed up as a name — a truncated id
  can still be matched against `paw status`, whereas a guessed name is a false claim about who you
  talked to. Grouping is keyed on (dir, recipient) too, so two consecutive sends to DIFFERENT agents
  don't merge into one block under a single avatar — which is precisely the confusion being fixed.
  Test: `check:web`; verified in a real browser against the live daemon (client files are read
  per-request, so a reload picks up client changes with no restart — unlike routes).
  **The browser owns its OWN unread cursor (`web.cursor` / `WEB_CURSOR`, 2026-08-19)** — every TERMINAL
  surface advances the shared `inbox.cursor` as a side effect of PRINTING a DM (that's what makes one
  unread state span `paw inbox` and `paw chat`), so a `paw chat` left running in another window walks
  it past the newest message within seconds and a browser reading it can only ever report **0 unread**.
  Reported live with the cause correctly guessed ("maybe cause i have paw chat running") and CONFIRMED
  before fixing: `paw chat .` live as pid 44377, shared cursor 40s old. The shared cursor answers "have
  I seen this ANYWHERE"; a GUI needs "what have I shown YOU", and only one of those may be moved by a
  process in another window. **Raycast reached this exact conclusion first** (`src/read-state.ts`) and
  its notes here warned about it — the web was wired to the shared cursor anyway. Two deliberate
  asymmetries: marking read in the browser advances **BOTH** cursors ("I have read these" is true
  everywhere; "the browser displayed these" is only true here), and `webCursor()` **SEEDS** from the
  shared one on first use, because a fresh file reads 0 and would light the ENTIRE history as unread —
  a wrong answer with a badge on it, not an honest "don't know yet". `cursor.ts` takes a `which` name
  (default `inbox`) so a display-only surface can keep its own. Verified live: a new DM lit `unread: 1`
  and STAYED lit while the shared cursor advanced past it.
  **Never size the composer from a HIDDEN measurement (`autogrow`, 2026-08-19)** — the real cause of
  "input field does not work". Activity hides the composer outright (`.main.nofocus .comp{display:none}`)
  and a hidden element measures `scrollHeight` 0, so writing that back PINS the textarea to
  `height: 0px`. `switchDraft` → `autogrow` runs from `focusTarget` BEFORE `render()` reveals the
  composer, which is exactly that case: switching from Activity to an agent left a ZERO-height box the
  operator could neither see nor click into, and nothing re-measures on its own so it stayed collapsed.
  The SECOND switch looked fine because the composer was already visible by then — hence the decisive
  clue, "only the first switch is broken". Fix is two-sided: `autogrow` returns early when
  `offsetParent === null` (a measurement taken while hidden is never persisted), and `focusTarget`
  re-runs it AFTER `render()` so a restored multi-line draft gets its true height. Verified in a real
  browser: first switch 22px + focused + typing visible, a 3-line draft 66px and still 66px when
  switched back to.
  **The caret follows the conversation you pick (`focusComposer`, 2026-08-19)** — choosing an agent
  revealed the composer but left focus on `BODY`, so you typed and nothing appeared and the box read as
  BROKEN when it was merely unfocused ("input field does not work", reported live). Worst coming FROM
  Activity, which has no composer at all (`.main.nofocus .comp{display:none}`), so the box is newly
  revealed and the operator has no reason to suspect it needs a click. Focused in `focusTarget` — a
  DELIBERATE switch — and never in `render()`, which runs on every 2s poll and would yank the caret out
  of whatever you were mid-way through typing. Skipped when the caret is in ANOTHER input: the sidebar
  search is a text field and Option-↑/↓ steps conversations while you are still in it, so grabbing focus
  there would break filtering to fix typing. Verified in a real browser on all three: click from
  Activity → caret in the composer, a half-typed line survives the poll, and a step from the search box
  keeps the caret in the search box.
  **`web/app/pending.js` — retiring an optimistic send (2026-08-06).** A send is put on screen
  immediately and held in `state.pending` (NOT `state.messages`, which the next read REPLACES wholesale —
  a row pushed there vanishes on reload, and silently disappearing is worse than a duplicate), then
  retired when the server echoes it back. The trap: **the two destinations echo in different SHAPES, in
  different ARRAYS.** A DM comes back into `state.messages` directed (`dir:"out"` + `to`); a channel post
  comes back into `state.channelMessages` as `{from:"you", channel, text, ts}` — no direction, no
  recipient. The single `dir === "out"` test therefore NEVER matched a channel post, and `loadChannel`
  didn't reconcile at all, so every channel post rendered TWICE: the real message plus a pending row
  stuck at `sending…` that no reload cleared (reported live). Identity is (destination, exact text) since
  `Entry` carries no wire id. Split into its own module + `.d.ts` so the predicate is asserted directly —
  including what must NOT retire a row: another agent's identical post, an inbound DM with the same text,
  and a FAILED send (the operator's only handle to retry it).

## node re-exec

- **`paw web` RE-EXECS ITSELF UNDER NODE when the CLI is bun (`reexecUnderNode`, 2026-08-19)** — paw's
  rule was always "the CLI may run under bun, the DAEMONS must be node+tsx", written for node-pty's
  ioctl. `paw web` is a long-lived daemon started through that same CLI, so it inherited bun and hit a
  SECOND incompatibility: **bun's `node:http` server never emits `upgrade`**, so the WebSocket handshake
  gets NO REPLY — not a 403, not a close, nothing. Measured side by side on identical code: bun answers
  nothing (the client sits on `connecting…` forever), node returns `101 Switching Protocols` instantly.
  Without the socket the browser falls back to its 2s poll, which browsers throttle hard in a BACKGROUND
  tab — so mail appeared to arrive "only on start", which is exactly how it was reported. `web()` now
  hands the whole command to `pawViaNode` (now exported) and becomes a passthrough — stdio inherited,
  exit code forwarded, SIGINT/TERM/HUP forwarded so Ctrl-C stops the child rather than orphaning it.
  Re-exec rather than refuse: the operator asked for a server, and "run it a different way" is paw's job.
  Done BEFORE `ensure()` so nothing runs twice. Verified live through the real bun launcher: a bun parent
  with a node child, `101` on the handshake, `status` frames arriving, socket staying open. Test:
  `check:spawn-env` (the node branch must NOT fork; the bun branch is unreachable from node and was
  verified live).
