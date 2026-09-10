# everything is an agent — CLI brainstorm (2026-07-03)

The thesis: **an address is an agent.** Anything you can point at — a folder, a repo, a branch,
a PR, a website — resolves to a persistent peer with its own claude session (context window),
its own name on the mesh, and the ability to talk to every other agent. The CLI's job shrinks
to two things: a universal **addressing grammar** and a small set of **verbs that work on any
address**.

## 1. The addressing grammar

One scheme, one sigil per concept — `@` is always a *variant/branch*, `#` is always a *number*
(PR/issue), a scheme prefix is always a *source*:

| address                    | agent                                      | status |
|----------------------------|--------------------------------------------|--------|
| `.` / `path/` / `~/x`      | folder agent                               | ✅ today |
| `<repo>@<branch>`          | worktree agent (auto-create the worktree)  | ✅ today (strict; should auto-create) |
| `gh:owner/repo`            | remote repo agent (lazy blobless clone)    | ✅ today as `github:` |
| `gh:owner/repo@branch`     | branch of a remote (create if missing)     | ✅ today as `github:…#branch` — **migrate `#`→`@`** |
| `gh:owner/repo#123`        | PR agent (checkout + PR context brief)     | 🔮 future — `#` freed for numbers |
| `web:docs.foo.com` / bare URL | website agent (cache dir + fetch brief) | 🔮 future |
| `<name>`                   | any already-registered agent by name       | ✅ today |

Notes:
- **`#` currently means branch in `github:…#branch` — swap to `@`** so `@`=branch matches
  `pkg@version` intuition everywhere, and `#` matches GitHub's own `owner/repo#123` PR/issue
  notation. Pre-1.0, do it now, fail-loud redirect on the old form.
- `gh:` as the short scheme (keep `github:` as an accepted long form).
- Every resolver is **lazy + idempotent**: addressing a thing the first time mints it (clone,
  worktree, cache dir, persona with a stable `resume:` pin); addressing it again resumes it.
  Nothing is created by a *read* verb (`log`, `sessions`, `status` stay read-only).

## 2. Verbs are universal; the address carries the meaning

Any verb × any address. No PR-specific or web-specific subcommands — "review this PR" is just
*talking to the PR agent*.

```
paw <address>                  # bare address = chat (talking is the default verb)
paw dm <address> "msg"         # async hand-off; reply lands in paw inbox
paw open <address>             # attach to its terminal
paw log <address>              # read its session
paw rm <address>               # forget it
paw ls                         # EVERY registered agent, grouped by kind, live or cold
```

- **`paw <address>` with no verb = `paw chat <address>`.** Dispatch order: exact command word
  first, else resolve as address (the existing ambiguity guard already covers name-vs-folder).
  `paw .` just works; `paw gh:vercel/ai` clones-and-chats.
- `paw ls` is new: `ps` shows live processes, `ls` shows the *population* — every agent in the
  registry with kind, liveness, session ref, staleness. The world map.

## 3. Agents talking to each other

They're mesh peers already; the missing piece is *ergonomics for brokering*:

```
paw dm ai@fix-stream "ask @docs.stripe.com how webhooks retry, then implement backoff"
```

The worktree agent DMs the website agent itself (cotal_dm), each in its own context window —
the human never relays. Candidate sugar:

- `paw introduce <a> <b> "topic"` — DM both a one-liner naming the other + the topic, let them
  take it from there. (Cheap: two DMs. No new protocol.)
- Per-repo channels (`#<repo>`) so a repo agent + its worktree/PR agents share a room; `paw msg
  #ai "status?"` fans to the family. Registry knows the family tree (same repo root) — join
  them automatically at spawn.

## 4. What each kind actually is (resolver contract)

A resolver takes an address and returns `{ cwd, name, brief, kind }` — everything else (persona,
resume pin, spawn, mesh identity) is the existing shared machinery. New kinds = new resolvers,
nothing else changes:

- **folder** — cwd = the folder. Today's paw.
- **worktree** — cwd = the worktree (auto-`git worktree add` if the branch exists or `-b` it);
  name `repo@branch`; brief notes the branch + upstream.
- **remote repo** — cwd = `~/.paw/repos/owner/repo` blobless clone. Today's `github:`.
- **PR (future)** — cwd = a worktree of the PR head (`gh pr checkout` into `~/.paw/repos/...`);
  name `repo#123`; brief carries PR title/body/review comments/CI state, refreshed on wake.
  "Review it", "address the comments", "rebase it" are all just chat.
- **website (future)** — cwd = `~/.paw/web/<host>/` (scratch + cache); name = host; brief:
  "you represent <url>; answer from its content, fetch/refetch as needed." Its context window
  *is* the site's memory — ask it twice and it's warm.

## 5. Open questions

- **name collisions across kinds** (`ai` the folder vs `ai` the repo): the existing hash-qualifier
  handles it, but `paw ls` grouping + kind-prefixed display names (`web:stripe.com`) keep it legible.
- **lifecycle for heavy kinds**: a website agent that never gets addressed again — reap policy?
  (`paw ls --stale`, manual `rm` for v1.)
- **budgets**: every agent is a context window = tokens. `ls` should show last-active so the
  human sees what's warm.
- **bare-URL sugar** (`paw https://react.dev "what's new in 19?"`) — nice, unambiguous prefix,
  trivially routed to the `web:` resolver.

## 6. Migration path (implementable now)

1. `paw <address>` bare-chat default + `paw ls`.
2. Sigil unification: `gh:` alias, `@`=branch everywhere (`github:…#branch` fail-loud redirect).
3. Worktree auto-create on `repo@branch` (drop strict-v1).
4. `paw introduce` + auto family channels.
5. Then PRs, then websites — pure resolver additions.
