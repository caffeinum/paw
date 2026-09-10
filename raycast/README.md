# paw for Raycast

Two commands, no config:

- **Paw Agents** — every registered agent, live or not: mesh status, runtime, folder, inbox lag,
  last-active. Enter chats with the highlighted one.
- **Paw Chat** — pick an agent, then talk to it. The search bar is the composer; replies stream in.

## Install it

```sh
cd raycast
npm install
npx ray build -e dev     # pushes the build into Raycast — run once, then stop
```

Then open Raycast and type `Paw Agents` or `Paw Chat`.

**You do not need to keep a dev server running.** `ray build -e dev` hands the compiled bundle to the
Raycast app, which keeps its own copy — nothing is written into this folder, and the commands stay in
Raycast after the CLI exits. Re-run it after pulling changes to push the new build; `npm run dev` is
the same thing plus a file watcher, which is only worth it while you are editing.

To uninstall, remove it in Raycast under Extensions.

## How it talks to paw

It **shells out to the `paw` CLI** rather than joining the mesh itself. That is deliberate: paw's human
peer ("you") owns a single durable DM consumer, and cotal allows exactly one active consumer per
durable — a second process connecting under that identity would contend with a live `paw chat` /
`paw inbox` and starve it. Going through the CLI makes Raycast just another reader of the same state.

- `paw status --json` → the agent rows (the same rows the table prints, so they cannot drift)
- `paw inbox --json` → your DMs, **without advancing paw's shared "seen" cursor**, so polling from a
  GUI never marks things read out from under a terminal
- `paw dm <agent> <text>` → send; this also wakes an offline agent from its pinned session

Raycast runs extensions with a minimal PATH (no shell rc, no nvm), so the launcher is invoked by
absolute path — `~/.local/bin/paw` by default, changeable in the extension's preferences along with
the mesh space.

## Known limits

- Replies arrive by **polling** the inbox every 2s, not by a live subscription — a reply can lag by up
  to that. A live feed would mean joining the mesh, which is what the single-consumer rule rules out.
- The chat shows only messages newer than the moment you opened it. Your inbox holds the whole history
  with every agent; replaying it would bury the conversation you just started.
