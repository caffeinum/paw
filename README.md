# paw

**Hand any repo a task, walk away, and the answer finds you.**

One always-on agent per folder, on a [cotal](https://github.com/Cotal-AI/Cotal) mesh. Live chat or fire-and-forget DM. Agents keep context across restarts, and they can talk to each other and to you.

```bash
paw dm ~/some/repo "rebase onto main, fix the conflicts, run the tests, then DM me the result"
paw inbox     # the result (or a question) is waiting
```

## Quickstart

Node ≥ 22, [pnpm](https://pnpm.io), [Claude Code](https://claude.com/claude-code). `pnpm install` pulls `@cotal-ai/*` — no separate cotal install.

```bash
git clone https://github.com/caffeinum/paw && cd paw && pnpm install && pnpm paw release
pnpm paw chat .
```

`paw release` pins an immutable snapshot the daemons run from (a missing pin fails loud). Then `pnpm paw chat .` brings up the mesh, spawns this folder's agent, and drops you into a REPL.

```bash
mkdir -p ~/.local/bin && ln -sf "$PWD/bin/paw.mjs" ~/.local/bin/paw   # optional PATH
```

## Talk

| | |
| --- | --- |
| `paw chat [folder\|name]` | live REPL. `@name` latches a sticky target. `--fresh` mints a new agent (fails if one exists). |
| `paw dm <target> "<msg>"` | fire-and-forget, sent as **you** so the reply is deliverable. |
| `paw inbox` | your DMs. `--history` backlog, `--watch` live tail. |
| `paw status` | the fleet: live/idle, folder, inbox lag. |
| `paw log <name>` | that agent's transcript. |
| `paw open <name>` | attach to its terminal (`paw attach` is the same). |
| `paw stop` / `paw rm` / `paw rename` | stop, forget, relabel. |
| `paw down` | tear down daemons paw started. |
| `paw cotal <cmd>` | raw cotal CLI. use `paw dm`, not `cotal send`. |

A folder is an agent. Address it as `.`, a path, a registered name, `repo@branch` (existing worktree), or `github:owner/repo[#branch]` (cloned once via `gh`).

`paw chat` / `paw dm` spawn on first contact and resume after that. `paw adopt` lifts a past `claude` session onto the mesh.

## Safety

Agents run `--permission-mode bypassPermissions` and auto-spawn. That's the product. Scope is your machine. Opt into a fence with `PAW_ROOT=~/work`.

Apache-2.0. `paw` prints the rest of the verbs.
