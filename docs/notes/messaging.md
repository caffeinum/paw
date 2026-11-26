# DMs, inbox, mailbox, read path, channel replay

Moved verbatim from CLAUDE.md (2026-10-02 split). Index: [CLAUDE.md](../../CLAUDE.md)

## paw dm

("you" below is the DEFAULT human name; on a remote space with a record `human` it is that name —
`humanPeer(space)`, [remote-mesh.md#human-name](remote-mesh.md#human-name).)

- `src/dm.ts` — `paw dm <name|folder|repo@branch|github:owner/repo|…> "<msg>"|-`: **fire-and-forget** DM to an agent. A lone
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
- **A just-launched agent that is alive but not ready (#96, 2026-11-05).** The target forms are one
  string, `DM_TARGETS` (name, `@name`, folder, `folder@branch`, `owner/repo@branch`,
  `github:owner/repo[#branch]`, a URL, a host) in every usage/error line — `github:` worked but only `rm`
  listed it. A slow first boot is waited out inside `ensureAgentSpawned` (first-spawn budget 180s while its
  pid lives, control-rail.md) and the DM goes out once it joins (same drafted msg id → `msgID` dedup);
  listed-but-starting still queues to its durable inbox. When the gate throws `SeatAliveError` (pid alive,
  but the manager dropped the seat / it never joined), `sendAsYou` rethrows with `notSentMessage`: "<name>
  is alive (pid N) — the DM was NOT sent. Retry once it's reachable: paw dm <name>#<space> '<text>'"
  (`shellQuote`d). `check:dm`.
- **A known agent mid-reconnect is waited for, not refused** (`src/dm-wait.ts`, 2026-11-04). The team2027
  broker (one Fly node) redeploys on every push to paw main: a 10–60s gap with the connection down, then
  presence (memory-backed, republished by each endpoint's 2s heartbeat) briefly empty. `paw dm evals` from
  cron / an agent / the office bridge failed at once with `no agent "evals" present or known` against a
  healthy agent. Now, for a bare name, after the presence snapshot is read (an unread roster never
  supports an absence verdict): present → send; registered here → wake (ensureAgentSpawned, unchanged);
  on the roster offline or in the peer ledger (`peers.json`) within 7 days → print one dim `waiting for
  <name> to come back on the mesh…` and wait; never seen → fail at once (today's message). A DOWN mesh is
  waited out too: `startWithin` retries `ep.start()` on transient connect errors (conn-state's
  classifier; auth fails at once), and `paw dm`'s CLI gate retries `ensure()` on `MeshUnreachableError`
  (PAW_SERVER / remote space only — the default local mesh is just booted). ONE budget for all of it
  (`startDmClock` in bin/paw.ts): `--wait-for <s>` > `PAW_DM_WAIT` (s) > 20s; expiry names the half that
  failed (`mesh unreachable — <server> …` vs `"<name>" stayed offline — the mesh is up …`). The publish
  retry re-sends ONE drafted message (`draftDm` + `publishDraft`, JetStream `msgID` dedup), so a retried
  publish whose ack was lost is stored once. paw chat's send path (its own outbox) is untouched.
  `pnpm check:dm` (pure), `scripts/e2e-dm-wait.ts` (own nats-server: down→up delivered once, stays down →
  loud after budget, unknown → immediate, broker restart mid-send → delivered once, broker gone → names the mesh).

## paw mailbox

- `src/mailbox.ts` — `paw mailbox` (daemon; auto-started by `ensure()`, not run by hand): the
  persistent **"you" presence beacon**. An agent can only deliver a DM to a peer it can RESOLVE in the
  live roster, so without a standing "you" presence a reply sent after `paw dm` exits is undeliverable
  ("send went offline"). This holds the stable "you" identity online (2s presence heartbeat) so agents
  can always reach you; their DMs land in your durable inbox for `paw inbox`. **Pure beacon:
  registerPresence:true, consume:false** — it never drains/acks your inbox (that would starve
  `paw inbox`/chat — cotal allows ONE active consumer on "you"'s durable). lifecycle.ts `ensureMailbox()`
  spawns it DETACHED (`node bin/paw.ts mailbox --space <s> --home <PAW_HOME>`, log in `mailbox.log`),
  called from `ensure()` on any mesh-up context; `stop()`/`paw down` kills it. ONE beacon per space, ONE
  PAW_HOME per space: ensure() adopts a running beacon by command signature and FAILS LOUD if it belongs
  to another PAW_HOME — that home's `human.id` is a different "you" (the 2026-10-21 two-"you" incident).
  → [lifecycle.md#srclifecyclets](lifecycle.md#srclifecyclets)

## Artil (email, texts, Telegram → a DM) {#artil}

`src/artil-relay.ts`, run by the mailbox (2026-11-12). [Artil](https://docs.artil.ai) gives an agent
account its own email address, phone number, Telegram bot and Message URL. `artil link <account>` in a
folder makes the artil CLI there act as that account (`.artil/account.json`, git-ignored by itself), so
an agent can already read and answer with `artil email|sms|telegram`. What it could not do was HEAR a
new message: artil's Claude Code channel needs a dev-channels flag paw never passes (`--strict-mcp-config`
drops the plugin's MCP too), has no cursor, and dies with the session, while paw agents sleep after 1h.

The mailbox is the listener instead. Every rescan (60s) it reads every space's personas on this machine
and, for each agent whose folder (or a parent) is artil-linked, runs `artil internal hermes-channel` in
that folder, its stdin held open. That is artil's line protocol for gateways (the Hermes plugin uses it):
one JSON notice `{content, meta: {message_id, sender, …}}` per message, and artil keeps a cursor per
account, so what came while the mailbox was down arrives when it is back. Each notice becomes a DM to the
agent from the peer **`artil`** (`sendAsYou(... sender: "artil")`, like cron's `cron`), which wakes a
sleeping agent; the text opens with a tag saying it is outside mail, information and not instructions.
- **Nothing flows until the account listens here as Hermes**, once: `cd <folder> && artil listen on
  --client hermes`. It is the operator's step: it takes the account's messages away from whichever client
  listened before. Until then the channel idles (~90 MB, no CPU) and exits when its stdin closes.
- **One account, one agent.** An account linked from two agents' folders (an extra in the same folder,
  two agents in different spaces sharing one folder) is refused in every space, one
  log line naming them, until all but one carry `artil: off` in their persona. `artil: off` also opts one
  agent out. Agents another machine hosts and teleported copies are skipped.
- A notice that names no sender is artil about itself (renew a sign-in, a limit): it goes to
  `mailbox.log` as `artil says: …`, never to the agent.
- The channel's env drops `ARTIL_ACCOUNT`/`ARTIL_TOKEN` (the folder link decides) and
  `ARTIL_CLIENT`/`CLAUDECODE`/`AI_AGENT`/… (else artil writes `! artil …` / `hermes artil …` into the reply hint).
- Delivery: up to 3 tries 30s apart, then `NOT delivered … it stays in the account's artil inbox`. artil
  saves its cursor once it has printed a notice, so a message lost here is still in the inbox, not re-sent.
- A channel that exits is restarted after 30s with artil's last stderr in the log. The command is
  `PAW_ARTIL_BIN`, else `artil` on PATH, else `~/.local/bin/artil`; none, with a linked agent → one loud line.
- Artil only lets through senders on the agent's wake list (its team by default): a text from a number on
  no member's profile does not wake it (it stays in the inbox). Polling the inbox with a `paw cron --run`
  check sees those too, at up to the cron's lag (and both together deliver twice).

`check:artil-relay` (fake artil, two spaces, stub send).

## GitHub (PR comments, reviews, CI, merges → a DM) {#github}

`src/github-relay.ts` + `src/commands/github.ts`, run by the global keeper's 60s tick (2026-11-17). New
activity on a pull request used to wake nobody: the agent working the PR had to poll `gh` itself. Now each
new comment, review (verdict, body, the first inline comments), settled CI result and merge/close reaches
the agents that follow the PR as a DM from the peer **`github`** (`sendAsYou(... sender: "github")`, the
cron path), which wakes a sleeper. The operator's answers that shaped it: agents comment as their OWN
GitHub accounts; comments, reviews, CI and merges all count; every author (bots too) reaches whoever follows.

Who follows a PR — for every agent this machine hosts, in every space (teleported copies and agents pinned
to another `machine:` skipped):
- **branch**: its folder has the PR's head branch checked out (not the repo's default branch, not a fork's
  PR with the same branch name) — what a `paw chat <PR url>` agent is;
- **author**: open PRs opened by the persona's `github: <login>` (the agent's own account);
- **watch**: `paw github watch <pr> [<agent>]` (default: the caller). `paw github unwatch` drops a watch,
  or MUTES a branch/author PR for that agent. Watches and mutes end with the PR.

An event by the follower's own `github:` login is never sent back to it. A follower with no `github:` gets
a note on comments/reviews by the account paw reads GitHub with (`viewer`), since it may have posted them.

How a sweep reads GitHub (`gh api graphql`, the operator's login, one machine-wide pass):
1. one query: `viewer`, the open PRs of every checked-out (repo, branch), every login's open PRs (search),
   and the cheap state (`updatedAt`, state, head sha + rollup) of every PR already followed or watched;
2. only if something moved: one detail query — the last 25 timeline items (comments, reviews, merged/closed/
   reopened) and, for a head whose rollup settled (SUCCESS/FAILURE/ERROR), its checks.
A PR seen first is baselined: its detail is read, nothing is sent. New items = submit/create time ≥ the
cursor and not already seen at it — a page, not `since`, because a review sits at its START time and one
written over ten minutes would fall behind a time cursor. CI is told once per `<sha>:<verdict>`. A merge
drops the ClosedEvent beside it. A merged/closed PR is told to who followed it last, then forgotten.

State is `<PAW_HOME>/github.json` (watches, mutes, per-PR cursor/seen/ci/followers, outbox, last log).
DMs go to the outbox under the lock first, then out: a failed send stays queued (`paw github ls` shows
it) and is retried every tick, dropped after 5 tries with a `NOT delivered` keeper-log line. A GitHub error
is logged once while unchanged. Two sweeps at once (keeper + `paw github tick`): the second is a no-op.
`gh` comes from the daemon PATH or `PAW_GH_BIN`. Cost: ~1 GraphQL point a minute when quiet.

`check:github-relay` (fake GitHub, stub send).

## GitHub teams: tag an agent with @org/<agent> {#github-teams}

`src/github-teams.ts` + `paw github org|teams` (2026-11-24). The operator wanted to tag an agent on GitHub with
autocomplete. A user can't be autocompleted unless it is a real account; a TEAM can, so each agent gets one.

- `paw github org <org>` once (stored in `$PAW_HOME/github-config.json`; `--org` overrides per call). No org ⇒
  every team verb fails loud; the relay just doesn't poll teams.
- `paw github teams [--space s]` is a dry run: every agent of the space, `✓` for a team that exists (same name,
  any case, or the slug GitHub would give it), `+` for one it would create. `--apply` creates the missing ones:
  `POST orgs/<org>/teams {name: <agent>, privacy: closed}` (a `secret` team does not autocomplete), then
  `DELETE …/memberships/<you>` (GitHub makes the creator a maintainer; removed so no seat is used), then reads
  the members back and fails loud if any remain. Existing teams are never touched. An API error stops the run
  and names the teams made before it; running it again is safe.
- Team names are the agent names (`[A-Za-z0-9_-]+`); the slug is whatever GitHub answers (it lowercases).

**Delivery without a webhook receiver** (the operator: "I'm not sure we need a receiver"). The relay sweep
(keeper, 60s) calls `teamMentions` after the PR part: at most every 2 min (`PAW_GITHUB_TEAM_POLL_MS`) and at most
10 teams a poll (rotating), for every hosted agent whose name has a team in the org:
1. one REST search per team, `org:<org> team:<org>/<slug> updated:>=<last poll − 10 min>` (REST search has its own
   30/min bucket, so it costs no GraphQL points; the 10 min overlap covers the search index's lag);
2. for each hit: `issues/<n>/comments?since=`, and for a PR `pulls/<n>/comments?since=` (inline review comments)
   and `pulls/<n>/reviews` (first 100) — search says which issue, never which comment;
3. a comment/review/new issue body that contains `@<org>/<slug>` (word-bounded, any case) and was written
   or edited after the team was first polled (its baseline) is ONE DM from `github` to every hosted agent of
   that name:
   ```
   you were tagged by <login> in <owner>/<repo>#<n>
   <html_url of the comment>
   ```
   The agent reads the comment itself with `gh`. Deduped by comment id (`ic:`/`rc:`/`rv:`/`is:`, last 5000 kept);
   tags by the agent's own App bot or persona `github:` login are skipped. Through the same outbox as PR events.
4. a failed search keeps that team's cursor (said once in the keeper log); a failed comment read keeps it too.

Does search see review comments? **Yes** (checked read-only, 2026-11-24): firegoat-ai/evals#1837 mentions
`@firegoat-ai/mini-cto` ONLY in an inline review comment, and `team:firegoat-ai/mini-cto` returns it. The comment
scan reads review comments and review bodies anyway. Not verified yet: that a mention of a team with NO members is
indexed the same way (every team checked had one member) — tag a fresh team once after `--apply` and `paw github
tick` to see it arrive. Not covered: a mention added by editing an issue/PR BODY (only a new issue's body counts),
a PR with more than 100 reviews (later reviews unread).

State: `<PAW_HOME>/github.json` `teams` (org, team list re-read every 10 min, per-team `since`/`polled`, rotation,
seen ids). `check:github-identity`.

## GitHub team tags by push: `gh webhook forward` {#github-forward}

`src/github-forward.ts` + `src/github-forward-status.ts` + `paw github forward on|off|status` (2026-11-25). The
`team:` poll above reaches 10 teams every 2 min, so with 45 teams a tag took up to ~10 min. Now one machine can
stream the org's events and a tag arrives in seconds; the poll stays as a reconciliation fallback.

- **Opt in, one machine:** `paw github forward on [--space s]` (needs `paw github org`, the `cli/gh-webhook`
  extension and the `admin:org_hook` scope) records `forward: {space}` in `$PAW_HOME/github-config.json` and makes
  the signing secret `$PAW_HOME/secrets/github-forward.secret` (0600, dir 0700, never printed or logged). `off`
  removes it; `status` shows the config and health. Off by default: nothing changes for anyone who doesn't.
- **Host: the mailbox of that space.** It is always up, one per space, and already holds long-lived child streams
  (the artil relay); the keeper is a one-shot 60s tick and can't hold a websocket. Every other space's mailbox
  stays idle (no gh, no port). Every 30s it re-reads the config, so `on`/`off` take effect without a restart —
  once the mailbox runs a release that has this code (`paw release && paw restart`: mailbox-only, A1 passes).
- **Receiver:** `127.0.0.1:<random port>/github`. A delivery whose `X-Hub-Signature-256` is not the HMAC-SHA256 of
  the secret is answered 401 and logged (`REJECTED`), nothing parsed. gh gets the secret as `--secret=` on its argv
  (visible to this user's `ps` only; gh-webhook has no other way).
- **gh:** `gh webhook forward --org=<org> --events=issue_comment,pull_request_review,pull_request_review_comment,issues,pull_request --url=… --secret=…`.
  It makes a temporary org dev hook ("cli") and streams it. `Forwarding Webhook events from GitHub...` on its stderr
  = up. It exiting is restarted with backoff (5s doubling to 5 min) and said ONCE per streak (again only if the reason
  changes: down / conflict / access). A 422 "Hook already exists" = another forward for this org somewhere (GitHub
  allows one): said plainly, status `conflict`, retried every 5 min. A 403 = the gh login lacks `admin:org_hook`.
- **Tags:** the comment (`issue_comment`, `pull_request_review_comment`: created/edited), the review body
  (`pull_request_review`: submitted/edited) and an issue/PR body (`issues`/`pull_request`: opened/edited) are scanned
  for `@<org>/<slug>`; each slug maps to the hosted agents whose team it is (the poller's `teamSeats`); tags by the
  agent's own App bot or persona `github:` login are skipped. The id is claimed in the poller's `teams.seen` under the
  store lock, then the poller's DM is sent (`you were tagged by <login> in <repo>#<n>` + URL) straight away; a failed
  send goes to the outbox for the keeper. The poller, when it writes back, drops any of its finds the push claimed
  meanwhile — so a tag is sent exactly once whichever side sees it first.
- **Dedupe ids are per team** since this change: `ic:<id>/<slug>`, `rc:…`, `rv:…`, `is:<owner>/<repo>#<n>/<slug>`
  (a body by number: a webhook names a PR by its pull id, search by its issue id). Before, one id per comment meant a
  comment tagging two teams reached only the first. Old `<kind>:<id>` entries are still honoured.
- **Cadence:** `<PAW_HOME>/github-forward.json` holds the forwarder's state + a 30s heartbeat. While it says `up`
  (and the beat is < 90s old) the keeper polls team tags only to reconcile: each team every 30 min
  (`max(2 min, 30 min × 10 / teams)` between polls). Otherwise the old pace. Each switch is one keeper-log line
  (`arrive by webhook push…` / `no webhook forwarder streams <org> — team tags are polled every 2 min`).
  `paw github ls` and `paw github forward status` print the health line.
- **PR followers too:** a comment/review event on a PR the relay follows triggers one relay sweep (3s debounce) from
  the mailbox, so PR followers hear it in seconds; the sweep is the keeper's own (same lock, cursors, outbox).
  CI results and merges still wait for the keeper tick (those events aren't forwarded).
- **One comment, one DM (2026-11-25):** a comment or review whose body tags a follower's team is left out of that
  follower's PR DM — it already arrives as the tag DM (evals#2029: `@firegoat-ai/ux nice, merge it` reached ux as the
  tag and again inside the `🐙 github · …` DM). Events carry the `owner/slug` teams their body tags; an event by the
  agent's own logins stays (the tag path skips those). Two follower DMs a few seconds apart are otherwise distinct
  events seen by distinct sweeps (the poke sweep, then the keeper's with the settled CI) — not repeats.
  Tag deliveries log `→ <agent>#<space> (tag)`.
- **gh-webhook exits on every websocket drop** (cli/gh-webhook v0.2.0: `handleWebsocket` wraps the read error with
  `%w`, so `runFwd`'s `websocket.IsCloseError(err, 1006)` retry never matches; cobra then prints `Error: …` and the
  whole flag usage, exit 1). paw restarts it (5s backoff); the DOWN line now quotes the `Error:` line
  (`ghExitReason`), not the usage tail (2026-11-26T00:03Z: only `-R/-S/-U` flag lines were logged).

`check:github-forward` (a stub `gh` POSTs signed fixture deliveries; no webhook is ever created).

## 👀 on a delivered tag {#github-react}

`src/github-react.ts` + `paw github react on|off|status` (config `react: false` = off; on by default). Once a team-tag
DM is handed to the mesh — by push straight away, by poll when its outbox entry is sent — paw reacts `eyes` on what
tagged: an issue/PR comment `POST repos/{o}/{r}/issues/comments/{id}/reactions`, a review comment
`…/pulls/comments/{id}/reactions`, an issue/PR body `…/issues/{n}/reactions`. A review has no reaction endpoint:
skipped, one log line. The tagged agent's App bot reacts with the installation token the keeper keeps in its token
dir (missing/expired → a failure line, never the operator instead); an agent without an App → the operator's `gh`.
Claimed in `github.json` `reacted` (tag ids, ≤5000) before the call: once per comment + team, never retried; a
failure is one line and never touches the DM. The bot needs the App's Issues/Pull requests write permission.

## GitHub Apps: an agent writes as <slug>[bot] {#github-apps}

`src/github-app.ts` + `paw github app set|test|ls` (2026-11-24). Agents used to push and comment as the operator.
Each agent can get its own GitHub App, which the operator creates BY HAND (steps below); paw never creates one.

- `paw github app set <agent> --app-id N --installation-id N --key <pem> [--space s]`: refuses a non-claude
  agent and a persona whose `claudeArgs` already pass another `--settings` (before any network call); then
  `GET /app` with the App's JWT (slug; the App id must match), mints a token, `GET /users/<slug>[bot]` (bot id);
  copies the key to `$PAW_HOME/secrets/github-apps/<agent>.pem` (0600, dir 0700; never printed); writes the
  token dir; records `{space, appId, installationId, slug, botId, where}` in `$PAW_HOME/github-config.json`; adds
  `--settings <token dir>/claude-settings.json` to the persona's `claudeArgs`. Takes effect at the agent's next
  start — paw never restarts it.
- Token dir: `$PAW_HOME/github-apps/<agent>/` for a host agent; `<VM home>/.paw-github/` (= `/root/.paw-github`)
  for a sandboxed one — its private home is already mounted, so no launcher/manager change and only the TOKEN goes
  into the VM, never the key. Files (0600): `token`, `token.json` (expiry), `gh/config.yml` + `gh/hosts.yml`
  (gh's migrated multi-account format, `version: "1"`, so gh never rewrites it), `claude-settings.json`.
- `claude-settings.json` is `{env: …}`, which claude applies to itself and every tool it runs:
  `GH_CONFIG_DIR` (gh reads hosts.yml on EVERY run, so a re-minted token is used with no restart);
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` = `<slug>[bot] <<botId>+<slug>[bot]@users.noreply.github.com>`;
  `GIT_CONFIG_COUNT/KEY/VALUE`: `credential.https://github.com.helper` reset (empty — the operator's keychain/gh
  helper must not answer first) then a shell helper that `cat`s the token file, and `url.https://github.com/.insteadOf`
  for `git@github.com:` and `ssh://git@github.com/` (an ssh remote would otherwise push with the operator's key).
- Refresh: the keeper (`githubKeeperSweep`, and `paw github tick`) re-mints any token missing or within 15 min of
  its 1 h expiry, before the relay sweep. A failure is a keeper log line every tick until fixed.
- `paw github app test <agent>`: mints a token and lists `GET /installation/repositories` (read-only).
  `paw github app ls`: what is registered and when each token expires.
- Why `--settings` and not the connector: the connector is in the manager's import graph (a connector edit means a
  full fleet restart, check:doctor A1); persona `claudeArgs` already reach the claude launch, host and sandbox.
- Not done: kit/codex/acp agents (no `--settings`); the relay's own-event filter still uses persona `github:`
  (GraphQL names a bot without `[bot]`), so the bot's own PR comments may come back to it as PR events.

### Creating the App for an agent (the operator, by hand) {#github-app-manual-steps}

For `evals-intern` (repeat per agent, swapping the name):
1. github.com → firegoat-ai → Settings → Developer settings → GitHub Apps → **New GitHub App**
   (`https://github.com/organizations/firegoat-ai/settings/apps/new`).
2. Name: `firegoat-evals-intern` (globally unique; the bot will be `firegoat-evals-intern[bot]`). Homepage URL:
   the org or repo URL (anything).
3. Webhook: **untick Active** — paw needs no webhook (mentions are polled). No callback URL, no device flow.
4. Repository permissions: Contents **Read and write**, Pull requests **Read and write**, Issues **Read and
   write**, Metadata **Read-only** (forced), Workflows **Read and write** only if it must push
   `.github/workflows/` changes. Nothing at organization or account level.
5. "Where can this GitHub App be installed?": **Only on this account**. Create.
6. On the App's page note the **App ID**. Under "Private keys" → **Generate a private key**: a `.pem` downloads.
7. Install App → firegoat-ai → **Only select repositories** → pick the repos it works in (e.g. `evals`) → Install.
   The URL you land on ends in the **installation id**: `…/settings/installations/<installation-id>`.
8. On the agent's machine:
   ```
   paw github app set evals-intern --space team2027 --app-id <App ID> --installation-id <installation id> --key ~/Downloads/firegoat-evals-intern.<date>.private-key.pem
   paw github app test evals-intern
   rm ~/Downloads/firegoat-evals-intern.*.private-key.pem
   paw restart evals-intern --space team2027     # when it is idle: the new env is read at start
   ```

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

**The lever** (cotal 0.110 spelling: `channel` singular, `defaults` plural — the older `paw cotal
channels default …` now fails "unknown command: channels"):
```
paw cotal channel defaults                          # show the space-wide defaults
paw cotal channel defaults --replay --window 1h     # bound it space-wide
paw cotal channel set general --replay --window 24h # or per channel
paw cotal channel defaults --no-replay              # or no backfill at all
```
**`--window` is a DURATION, never a count** — `parseDuration` accepts only `<n><s|m|h|d>` and THROWS
otherwise, so "the last 10 messages" is not expressible. Set to `1h` for this space.

**cotal 0.104.2 (#4851, "keep replayed mentions from waking agents") fixed the wake storm, not the
replay** (read in 0.110's `connector-claude-code/dist/mcp.cjs`, verified 2026-11-19 on an isolated
space with a haiku agent). A restarted seat still RECEIVES the whole backfill: every replayed message
is marked `historical` and buffered **pull-only** (`ingest`: `snapshottedPullOnly = item.historical ||
…`, ~l.70660) — @mentions included. Pull-only never wakes (`inboxWake` skips `pullOnly` and historical
channel items, ~l.71226) and never rides the inline hook delivery (that reads `peekInbox("automatic")`,
~l.78289). It surfaces only when the agent calls `cotal_inbox` (scope `all`), as `(history) …` lines
ranked after DMs and live channel traffic (`renderInbox`, ~l.76360), up to `INBOX_WINDOW_CHARS` =
48k per call; the buffer holds `MAX_INBOX` = 200, pull-only evicted first. Observed: 2 #general posts
handled live, agent stopped, 5 more posted (one `@replaybot … reply PINEAPPLE`), `paw start` → no turn
at all (transcript +1 line); a later DM arrived inline with no history attached; an explicit
`cotal_inbox` peek then listed all 7 as `(history)` — including the 2 it had already handled.
DMs are unaffected: they ride the agent's durable DM consumer, not join replay, and keep waking.

So the window is no longer about wake nudges; it is about **context**: unbounded, the first
`cotal_inbox` after a restart can pull up to 48k chars of old (partly already-handled) channel traffic
into the session. Keep `1h`. paw's brief (`CHANNELS_BRIEF`) tells agents a `(history)` message is
catch-up, not work — `cotal_inbox` prints the tag without the "not new work" note the inline path adds.
A manager PRESERVATION restart also passes `COTAL_BACKFILL_FLOOR` (the chat frontier it recorded), so
those seats backfill only what came after; a per-agent stop/start has no floor and replays the window.

**The cost of a short window, and why it's a real trade:** this space's channel `deliveryClass` is
`live`, and in open mode there is no durable backstop for channels (Plane-3 needs the delivery daemon,
which paw doesn't run — see the delivery-daemon note). So the replay IS the only catch-up path: an
agent down longer than the window doesn't get that traffic late, it never gets it.

**Reading the config back is not trivial:** `channelDefaults` is populated by a KV watch gated on
`doWatch && doWatchChannels`, so an `observerEndpoint` with `watchPresence:false` NEVER opens the
channel registry and reports every window as unbounded — which looks exactly like "the setting didn't
take". Probe with `watchPresence:true` (a real agent opens it via `consume:true` instead).

## Stale peer ids (DMs to a dead incarnation)

**Incident (2026-10-06 23:41):** every agent restart mints a NEW mesh id (`local.<actor>`). evals
restarted ~23:23 (`local.UDWRH…` → `local.UA7YY…`); queue-ea then `cotal_dm`'d the OLD id, copied from
an earlier message's `from.id`. cotal resolves a `to` that is an exact instance id to that id at ANY
status (`resolvePeer`: "an exact instance-id match wins"), so the send succeeded — "stored as seq N …
recipient was idle at send; delivery not confirmed" — onto a subject no consumer will ever read again
(the new incarnation's durable filters on its own new id). paw chat then showed `↩ local.UDWRH…`.

Three layers, cheapest first:

- **Brief** — `ADDRESSING_BRIEF` (src/brief.ts), in both the claude and the kit brief: address peers by
  NAME; never reuse an id from a past message.
- **Naming: the peer ledger** — `src/peer-ledger.ts`, `$PAW_HOME/spaces/<s>/peers.json`, id →
  `{name, first, last}`. Written ONLY by the mailbox daemon (inside the forwarder), from authenticated
  sources: presence cards on the roster and DM senders (the broker forge-locks the sender into the
  subject; the receive path drops a mismatching `from.id`). Sleep stand-ins are never recorded. Pruned
  at 30 days / 5000 ids; a corrupt file throws. Readers: transcript `↩` replies (`openAgentLog` →
  `nameReplyTargets`, so paw log, chat's logs view and the web trace) render `evals (old instance)` when
  another id of that name STARTED after this one was last seen (`isOldInstance`, 60s slack for the
  file's lagging `last`) — a newer `first` alone is not succession: two ids of one name can live side by
  side (2026-10-24: the stable "you" `f415…` plus a second "you" `8b2c…` from some other process, and
  goat-film's DM to the LIVE you rendered `↩ you (old instance)`); `paw history` / `paw watch` label never-sent ids the same way;
  `Entry.to` (inbox `--sent`, web conversation) and chat's `rosterName` get the PLAIN name, because
  `to` is the conversation key surfaces group and filter on. An id the ledger never saw stays the id.
- **Delivery: the stale-id forwarder** — `src/stale-forward.ts`, hosted by the mailbox (open mesh only).
  Tails `DM_<space>` from a persisted cursor (`stale-forward.json`), and for a DM whose recipient has
  no fresh presence: name it via the ledger → exactly ONE live non-stand-in instance of that name →
  re-publish under the ORIGINAL sender's subject (same move as the sleep host), body/replyTo kept,
  a `[paw: forwarded — …previous instance (<id>)…]` part first, deterministic msgID. Pure rules in
  `decideForward`: unknown id → leave it; asleep/waking name or stand-in recipient → the sleep host's;
  recipient seen alive at/after the send (catch-up after a mailbox outage) → leave it; roster not
  current / no live instance yet → HOLD (retried up to 30 min); 2+ live instances → leave it
  (ambiguous); never a different name; each stream seq decided once, each original forwarded once
  (done-set + broker msgID dedup); a forward targets a LIVE id so it is never re-forwarded. Under
  `PAW_AUTH` the broker forbids publishing as another sender, so the mailbox says the forwarder is OFF.
  Checks: `pnpm check:stale-forward` (hermetic), `scripts/e2e-stale-forward.ts` (own nats-server:
  restart → DM old id → delivered once; mailbox restart re-forwards nothing; history/inbox naming;
  `inbox --sent` shows the forwarded "you" DM once).
- **Reading: one message, not two** — the original stays in `DM_<space>` next to its forward, and both
  are "from you" when YOU DM'd the dead id, so `paw inbox --sent`, paw web and chat's cross-session echo
  showed it twice. `src/forward-mark.ts` (leaf) pairs them EXACTLY: the forward's first part is
  `forwardNote(<dead id>)` and its id is `forwardId(original.id, forward.to)`, so a forward pairs with
  the row whose id hashes to it, sent by the same sender to the note's dead id — never a text match.
  `dropPairedForwards` (feed.ts `conversationEntries`; web `Conversation.accept`; chat's `onOwnSend`
  against `shownSends`) drops the FORWARD and keeps the original (what you actually typed, at its place).
  A forward with no original in the read (an agent DM'd one of your old ids: the original went to that
  id, not to you) shows once with the note stripped and `Entry.forwardedFrom = <dead id>`, rendered
  `· forwarded from an old id` (chat header, inbox, web tag). A DM to a dead id that was never
  forwarded has nothing to pair with and stays. Same `ts` as the original, so the unread cursor counts
  one message. `paw history` (raw god-view log) still lists both copies.

**Upstream ask — filed 2026-10-24 via `paw cotal feedback`, AI-disclosed, record
`f4d992ea-aff9-4afe-bf3e-458488456cf6`:** `cotal_dm` / `unicast`
to an exact instance id whose presence is not live should not silently store onto a dead subject.
Either (a) resolve it by the card NAME the id last carried, when exactly one live peer holds that name
now ("id X is offline; delivered to its successor Y under the same name"), or (b) fail loud: "peer
evals (X) is offline — it restarted as Y; address peers by name". Today the tool reply (`recipient was
idle at send`) even reports the dead row's last status as if it were live. paw's forwarder is the
workaround and can only work on an open mesh (it must publish as the original sender).

## Replies to a one-shot `cotal send` (the headless-join "missing DMs")

**Incident (2026-10-19, team2027):** aleks's Mac mini runs a headless presence holder
(`tail -f /dev/null | paw cotal join --space team2027 --creds … --lifecycle-uid … --name aleks-mac-mini
> ~/.cotal-team2027/join.log`). Agents' replies to pings sent from that Mac (`2027-intern →
aleks@Alekss-Mac-Mini.local: pong …` in `paw history`) never appeared in join.log; only the agents'
status flips did. It looked like headless join drops DM text. **It doesn't.**

- **Headless join prints DMs, in full.** cotal 0.84 `dist/commands/join.js:231-240`: one `message`
  handler for both modes; `m.to === me` → `(DM) <sender> → you: <full text>`, then `d.ack()` on the
  join's OWN lifecycle-keyed `dm_<owner>-<actor>-<uid>` durable (`endpoint.js` `startConsumers` →
  `pump`). The live join.log has two such lines (`(DM) evals → you: pong 🐾 …`,
  `(DM) aleks@aleks-macbook → you: macbook here …`). That ack takes nothing from another reader: no one
  else binds that durable, and the DM stream keeps acked messages (`paw history` still lists them).
- **The replies were addressed to someone else.** `paw cotal send dm …` is cotal's one-shot
  (`dist/commands/send.js`): display name `<login>@<host>` (= `aleks@Alekss-Mac-Mini.local`), principal a
  FRESH identity per run (`openTransient` → `connectOrThrow` → `newIdentity()` on an auth mesh; an open
  mesh self-mints), `consume: false`, no presence, no inbox. The agent replied to `m.from.id` — that
  dead one-shot principal — so the reply sits in `DM_<space>` with no consumer. `paw history` names the
  recipient from the sender's own `from.name`, hence the arrow pointing at "aleks@Alekss-Mac-Mini.local".
- **Fix (paw):** `paw cotal send dm|ask` without `--creds` prints a stderr note (`oneShotReplyNote`,
  src/dispatch.ts; check:dispatch) pointing at the two paths where a reply is readable: `paw dm <agent>`
  (sends as the stable "you" principal; replies land in `paw inbox`, remote spaces included), or
  `--creds` of a session that holds an inbox — a one-shot sent with the join's creds IS the join's
  principal, so replies print in its log. No cotal patch: the join is right.
- **Verified** (own nats-server on a random port, temp PAW_HOME/COTAL_HOME, `PAW_RELEASE=dev`): headless
  join under `tail -f /dev/null` printed `(DM) … → you: <full text>` and `#general …: <full text>` for
  `paw cotal send dm|msg`; a stand-in agent that replies to its sender answered a one-shot `cotal send`
  → `intern → aleks@Alekss-Mac-Mini.local: pong …` in history, nothing in join.log (the incident, exactly);
  the same ping sent under the join's principal → `(DM) intern → you: pong …` in join.log; history kept
  every acked DM; the "you" inbox untouched. The `--creds` path was simulated in open mode (same
  principal), not run against an auth broker.
- **Privacy:** join.log holds DM text. It is the operator's own DMs on their own machine — fine — but
  the redirect creates it 0644; start the join under `umask 077` (or `chmod 600` the log).
