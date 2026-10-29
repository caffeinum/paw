# Sandboxed agents (`sandbox: container`)

Index: [CLAUDE.md](../../CLAUDE.md)

A claude agent that runs inside its own Linux VM (Apple's [`container`](https://github.com/apple/container),
macOS 26+, Apple silicon) and is still the same peer on the cotal mesh: `paw dm`/`chat`/`status`/`log`/
`attach`/`restart` all work unchanged. It can change only its own folder.

## Use

```
container system start                     # once per boot (Apple's services; `paw` never starts them)
paw sandbox build                          # build paw's image (src/sandbox/Containerfile), then stop the builder VM
cd <folder> && paw claude --sandbox --space <remote space> --name <n>
paw start|stop|restart <n>#<s> · paw chat @<n>#<s> · paw dm <n>#<s> "…" · paw attach <n>#<s> · paw log <n>#<s>
paw sandbox ls                             # every paw container on THIS machine: agent#space, state, mem used/limit, launcher live|orphan, home, forwarded ports
```

Persona keys: `sandbox: container` (any other value throws — a typo never boots the agent unsandboxed),
`sandboxImage:` (default `paw-sandbox:<sha256(Containerfile)[:12]>`, so a recipe change asks for a rebuild),
`sandboxMemory:` (default `2G`), `sandboxForward: false` (turns off [port forwarding](#port-forwarding); default on),
`sandboxSkills: false | [names…]` ([the operator's skills](#skills); default all), `sandboxOwnMcp: false`
([the VM's own MCP servers](#the-vms-own-mcp-servers); default on). `paw claude --sandbox` writes `sandbox: container` once; it is never cleared
by paw (un-sandboxing is a deliberate persona edit). Auth: the Claude OAuth token at
`$PAW_HOME/secrets/claude-oauth-token` (`PAW_CLAUDE_TOKEN_FILE` overrides), a 0600 regular file.
`PAW_CONTAINER` pins the `container` binary (else the first on PATH).

## How it launches

`pawConnector.buildLaunch` builds claude's launch exactly as for any agent, then `sandboxLaunch`
(src/sandbox.ts) turns it into `node bin/paw-sandbox-run.mjs … -- container run --rm -i -t --init … <image>
claude <the same args>`. The hub rewrite, tracepaper-direct and `nice` are skipped for a sandboxed seat (it
runs its own cotal MCP in the VM; the VM has its own CPUs). The in-VM command is always the IMAGE's
`claude`, by absolute path (`/usr/local/bin/claude`) — the manager resolves `spec.command` to the host binary's
absolute path, which the VM lacks, and a bare `claude` would resolve to one the agent installed into `~/.local/bin`.

What the VM sees (everything else of the host is absent — verified: `~/.ssh`, `~/.paw`, `~/Github`,
`~/Library` don't exist in it, a write outside the mounts lands in the VM's own rootfs, `ps` shows ~6 VM-local
processes):

| host | in the VM | mode | why |
|---|---|---|---|
| the agent's folder (persona `cwd:`) | same path | rw | the only host folder it can change |
| `$PAW_HOME/containers/<n>` (0700, created on first launch) | `/root` (= `HOME`) | rw | the agent's persistent home: `~/.env`, dotfiles, CLI installs, tools' config — see [Private home](#private-home) |
| `$PAW_HOME/spaces/<s>/sandbox/<n>/claude` | `/paw/claude` (= `CLAUDE_CONFIG_DIR`) | rw | transcripts, `.claude.json`, settings survive every container restart; seeded with onboarding done, the folder trusted, bypass consent |
| `…/sandbox/<n>/seat/` (per-launch copies of the persona and any `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`, plus paw's `bashenv.sh`) | `/paw/seat` | ro | single files are COPIED: their own dirs hold other agents' personas / a CA's key |
| `…/sandbox/<n>/creds/` (a mirror of ONLY this agent's creds file) | the creds dir's own path (the launch material names it) | ro | the real dir holds every agent's creds on this machine; the launcher re-copies on renewal |
| paw's topmost `node_modules` (release or checkout) | same path | ro | the cotal MCP server (`mcp.cjs`) and plugin hooks claude starts as its children |
| cotal's launch dirs (`material.json`, persona prompt file + `paw-brief.md`) | same paths | ro | |
| `<cotal root>/.cotal/events` | same path | rw | the MCP server's event write-ahead log — never the root itself (the signer) |
| each `~/.claude/skills/<name>`, symlinks resolved on the host | `/paw/claude/skills/<name>` | ro | the operator's user skills — [Skills](#skills) |
| each enabled, pure (no hooks/MCP/LSP/channels) user-scope plugin's `installPath` | `/paw/plugins/<plugin>` (+ `--plugin-dir`) | ro | the operator's plugin skills/commands/agents — [Skills](#skills) |

Env reaches the VM by NAME only (`-e KEY`, values inherited from the launcher's env): every `COTAL_*` except
`COTAL_HOME`, plus `TERM`/`COLORTERM`/`LANG`/`LC_ALL`, CA vars, `CLAUDE_CONFIG_DIR`, `IS_SANDBOX=1` (claude
runs as the VM's root; the VM is the sandbox) and `CLAUDE_CODE_OAUTH_TOKEN`. The VM's fixed env — paths only,
never a secret — comes from `--env-file …/sandbox/<n>/vm.env` (a host file, not mounted): `HOME`, `PATH`, the
installer prefixes and `BASH_ENV` (see [Private home](#private-home)). `COTAL_CONTROL_SOCKET` moves to
`/tmp/cotal-control.sock` in the VM (the MCP server listens, the hooks dial — both inside). Any OTHER
`COTAL_*` value that is an absolute host path not under a mount fails the launch loud (a future cotal var
must be taught, not silently missing). `--mcp-config` is cut to the cotal server alone: servers `paw mcp`
shares run host commands with host secrets in their env. `--strict-mcp-config` is DROPPED (unless
`sandboxOwnMcp: false`) so the VM's own servers load — [below](#the-vms-own-mcp-servers). The agent's OWN servers go in its VM's claude user
scope — `paw mcp add <name> --to <n>#<s> <https://url>|-- <cmd>` writes `/paw/claude/.claude.json` and restarts it
(`--no-restart`; busy → not without `--now`), `paw mcp ls|rm … --to`; OAuth via `paw sandbox shell` →
`claude mcp login <name>` → [cli.md#a-sandboxed-agents-own-servers-paw-mcp----to-agent-2026-10-28](cli.md#a-sandboxed-agents-own-servers-paw-mcp----to-agent-2026-10-28).

**The token** is read by the launcher from its file into its own env for `container run`, so it is never
on an argv, in the LaunchSpec, a persona or a log line (`check:sandbox` asserts all four, plus `ps`).
Inside the VM it is in claude's env — the agent can read its own token; that is inherent.

**The launcher** (`bin/paw-sandbox-run.mjs`, plain node ESM, no deps): removes this agent's leftover
containers (labels `paw.space`/`paw.agent`) first, runs `container run` on the seat's pty with the run CLI's
STDERR going to `…/sandbox/<n>/launcher.log` (its progress and errors — the pty is claude's screen and the
manager keeps no copy), keeps the creds mirror fresh (5s poll; the manager renews by atomic rename, which a
single-file mount would not follow — verified), and owns the VM's lifetime: killing the `container run` CLI
does NOT stop the VM (verified), so on SIGTERM/SIGHUP/SIGINT it starts a DETACHED `container stop --time 2` +
`delete --force` (it outlives the manager's SIGKILL 3s later), and when the run CLI dies any other way it
deletes the container itself. One fresh container id per launch (`paw-<space>-<name>-<6 hex>`), so a late
cleanup of the previous launch can never stop its successor. Only a SIGKILL of the launcher itself leaves an
orphan VM — `paw sandbox ls` marks it `orphan`, the agent's next launch removes it. It also forwards the VM's
listening ports to the host's loopback ([below](#port-forwarding)).

## Port forwarding

Like OrbStack / VS Code: every TCP port something LISTENS on inside the VM is offered on the HOST's loopback at
the SAME port number. Why: CLIs in the VM (`neonctl auth`, `gh auth login`, …) do OAuth by starting a callback
server on `localhost:<random port>` and printing a URL the operator opens in the host browser — the redirect to
`http://localhost:<port>/callback` has to reach the VM. `container run -p` only publishes ports fixed at launch.

`bin/paw-sandbox-forward.mjs`, run by the launcher (`--forward on|off` from the persona, default on):
- **Discovery**: `container exec <id> cat /proc/net/tcp /proc/net/tcp6` every 1.5 s (the image has no ss/netstat;
  ~45 ms per exec), state `0A` = LISTEN, deduped across v4/v6. Before the VM is up the exec fails — logged once.
- **Transport**: per host connection, one `container exec -i <id> node -e <relay> <addr> <port>` piping stdio to
  the server's own listen address in the VM (wildcard/loopback binds → `127.0.0.1`/`::1`). So a server bound to
  the VM's 127.0.0.1 — the usual OAuth callback, unreachable via the VM's IP — works, and nothing depends on the
  vmnet IP. One exec per connection is ~100 ms of setup: fine for callbacks and dev servers, not a data path.
- **Host side**: binds `127.0.0.1` (and `::1` when free, so `localhost` resolving to either lands in the VM) —
  NEVER a wildcard. A port already taken on the host's 127.0.0.1 is skipped, never stolen or renumbered, logged
  once in `launcher.log` (`NOT forwarded — host 127.0.0.1:<p> is taken`) and picked up once the host frees it. A
  port that stops listening in the VM is closed on the next poll; everything closes when the VM ends.
- **State**: `…/sandbox/<n>/forwards.json` (`{container, ports, skipped}`), removed on exit; `paw sandbox ls`
  shows it in PORTS (`3000,53682(host busy)`) for the matching container only.

Threat model: any process on the host can connect to a VM service through its forwarded port — that is the
point (the host is the more trusted side). Nothing is reachable from the LAN (loopback only). The VM gains
nothing on the host: forwarding is host→VM only, and the ports are the VM's own. Not forwarded: UDP; a
connection lives in its relay, so a VM-side server going away mid-request just ends it.

Verified on the mini (container 1.6.0): a throwaway container's `node` http server on the VM's 127.0.0.1:<p>
answered `curl http://127.0.0.1:<p>/callback?code=x` and `http://localhost:<p>/` on the host, via the forwarder
directly (`PAW_FORWARD_SMOKE=<container id> pnpm check:sandbox-forward`) and through the launcher itself
(forwards.json written, removed on SIGTERM); the host port closed when the VM server stopped.

## Skills

A host agent sees the operator's Claude Code skills from `~/.claude`; a sandboxed one gets the same, READ-ONLY,
without ever mounting `~/.claude` itself (credentials, other agents' transcripts, settings) or anything of it
writable. src/sandbox-skills.ts, per launch:

- **user skills**: each entry of `~/.claude/skills` (the host claude's `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`) is
  `realpath`ed ON THE HOST — most are symlinks (`../../.agents/skills/now`, `/Users/…/dream-skill`) that would dangle
  in the VM — and that real dir bind-mounted `:ro` at `/paw/claude/skills/<name>`. One mount per skill, so a host
  edit shows up live in the running VM. Skipped (never a launch failure), each logged once per launch in
  `launcher.log`: dotfiles (`.trash`), a missing target (dangling symlink), a dir with no `SKILL.md` (e.g. claude's own
  `synced/` buckets of claude.ai skills — the VM's claude syncs its own), and a target that is or contains `~/.claude`
  or `$HOME`, or lies in `~/.claude` outside `skills/`/`plugins/`.
- **plugins**: every plugin in `~/.claude/plugins/installed_plugins.json` with a `scope: user` install AND `true` in
  `~/.claude/settings.json` `enabledPlugins`, mounted `:ro` at `/paw/plugins/<plugin>` and loaded with
  `--plugin-dir /paw/plugins/<plugin>` — skills keep their `<plugin>:<skill>` names, commands and agents come too.
  Chosen over mounting `installed_plugins.json` + `known_marketplaces.json` + `enabledPlugins` into /paw/claude:
  `--plugin-dir` needs no marketplace state (claude would try to refresh/auto-update marketplaces whose
  `installLocation`s don't exist in the VM, and write `.in_use` markers into a read-only cache), and keeps host paths
  (the username) out of the VM. **Excluded by default**: a plugin that ships hooks (`hooks/` or `hooks` in
  `.claude-plugin/plugin.json`), MCP servers (`.mcp.json` / `mcpServers`), LSP servers or `channels` — those run
  host-oriented commands or want host secrets/OAuth. On the mini: `team2027-skills` and `unknowns` are mounted;
  `artil` (`.mcp.json` runs the host's `artil` CLI + a channel) and `slack` (`.mcp.json`, an OAuth'd HTTP server) are
  not. A project- or local-scope plugin is not mounted.
- **the agent's own skills**: `/paw/claude/skills` itself is the agent's (its rw config dir), so it may write
  `/paw/claude/skills/<other-name>/SKILL.md` and it persists. A same-named skill of its own is SHADOWED by the
  operator's (logged); the empty mount points the VM leaves in the host dir are removed at the next launch.
- **knobs**: persona `sandboxSkills: false` mounts none; `sandboxSkills: [now, team2027-skills]` mounts only those
  (skill names, plugin names or `name@marketplace`) — a name matching nothing installed throws, a non-list throws.
- **visible**: `launcher.log` (`skills: … · plugins: …` + every `NOT mounted — <why>`), `…/sandbox/<n>/skills.json`,
  `paw sandbox ls` (SKILLS column, and the plugins left out with why).

Verified (container 1.6.0, the mini): 20 nested `:ro` mounts start in ~1s; in a throwaway VM with the real set
(15 skills, 2 plugins) `ls /paw/claude/skills` and `cat …/now/SKILL.md` work, a write into a skill or a plugin fails
`Read-only file system`, the agent's own `/paw/claude/skills/mine` is writable and persists; `claude -p` (2.1.304)
listed the user skills, `mine`, `unknowns:*` and `team2027-skills:*`.

## The VM's own MCP servers

The operator (via `paw sandbox shell <n>#<s>`) or the agent itself may `claude mcp add -s user <name> -- <cmd…>` IN
the VM: it writes `/paw/claude/.claude.json`, which persists on the host. Host launches pass `--strict-mcp-config`
so ambient host helpers never boot; in the VM, user and project scope are the VM's OWN config, so a sandboxed launch
drops the flag (persona `sandboxOwnMcp: false` keeps it). `--mcp-config` stays cotal-only — host `paw mcp` servers
are never shared (host commands, host secrets). The seeded `settings.json` sets `enableAllProjectMcpServers: true`
(a folder `.mcp.json` would otherwise wait on an approval dialog nobody answers) and `disableClaudeAiConnectors: true`
(the operator's claude.ai connectors — Gmail, Drive… — stay out of the VM). A new server loads on the agent's next
start: `paw restart <n>#<s>`. A folder `.mcp.json` written for the host may name commands the VM lacks — those just
fail to start. Verified (claude 2.1.304, throwaway VM): without the flag, a `--mcp-config` server, a user-scope
`claude mcp add` server and a folder `.mcp.json` server all loaded (merged); with it, only the `--mcp-config` one.

## Refusals (all fail loud, `check:sandbox`)

- a LOCAL space (v1, below) — at `paw claude --sandbox` before anything is written, at the spawn site
  (`ensureAgentSpawned`) and in the manager's `buildLaunch`;
- a non-claude harness (`agent: kit|acp|…` would silently run unsandboxed), `headless: true` (needs the hub's
  host socket), no persona `cwd:`, `--fg`;
- `container` missing / services down / image not built / token file missing, empty or group/other-readable;
- `paw move` and `paw teleport` of a sandboxed agent (its store under `spaces/<s>/sandbox/<n>` and its home
  aren't carried yet); `paw rename` moves the store AND the home with the persona, refusing if
  `containers/<new>` (or its owner file) already exists;
- a sandboxed agent whose NAME already owns a home on another space (below).

## Private home

Every sandboxed agent gets a persistent home on the host, `$PAW_HOME/containers/<name>` (0700, as is
`containers/`), mounted read-write as the VM's `/root` — claude runs as the VM's root, so `HOME=/root` is where
every tool already looks (the host path is not reused in the VM: it would leak the operator's username/layout
and `~` is what tools assume). The rootfs is wiped every launch; the home is not. It is for:

- **secrets**: `~/.env` (`KEY=value` lines). Every bash in the VM sources it, exported: `BASH_ENV` (and `ENV`)
  = `/paw/seat/bashenv.sh`, paw's rc file, which also re-prepends the home's tool dirs to `PATH` (a login bash's
  `/etc/profile` resets PATH before BASH_ENV runs). The values never touch argv, the LaunchSpec, a persona, a log,
  `vm.env` or the seat dir — `check:sandbox` asserts it with a sentinel.
- **`~/.bashrc` is honored by every bash in the VM** — the agent's own Bash tool (non-interactive → BASH_ENV),
  `!cmd` (`bash -lc`), `paw sandbox shell` (`bash -l`) and an interactive `container exec … bash`. Seen live: fly's
  installer (`curl -L https://fly.io/install.sh | sh`) put flyctl in `~/.fly/bin` and appended
  `export FLYCTL_INSTALL="$HOME/.fly"; export PATH="$FLYCTL_INSTALL/bin:$PATH"` to `~/.bashrc`; `!fly auth login`
  said `fly: command not found` — a login non-interactive bash reads no `~/.bashrc`, and BASH_ENV sourced only
  `~/.env`. Now `bashenv.sh` does, in this order: PATH defaults, `~/.env`, then `~/.bashrc` LAST (so an installer's
  PATH line wins). How each shell gets there:
  - non-interactive (`bash -c`, claude's Bash tool) → BASH_ENV → `bashenv.sh` → `~/.bashrc`;
  - login (`bash -l`/`-lc`) → `/etc/profile` → the seeded `~/.profile` → `bashenv.sh` → `~/.bashrc` (then BASH_ENV
    again for `-lc`, a no-op: the file runs once per shell, so a second `~/.env` pass can't undo what `~/.bashrc` set);
  - interactive non-login → `~/.bashrc` itself → the seeded line sources `bashenv.sh`, which sees `~/.bashrc` already
    on `BASH_SOURCE` and doesn't source it back (no recursion, no double load).
  Kept the bang's `bash -lc` rather than switching to `bash -c`: a login shell is what a real terminal (and
  `paw sandbox shell`) gives, `/etc/profile.d` runs, and the seeded `~/.profile` covers installers that write
  there too (rustup, uv). Both seeds are written only when absent — `~/.bashrc` if missing, `~/.profile` only if
  the home has NO login file (bash reads only the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`, so a
  seed beside the agent's own `.bash_profile` would be dead). Never overwritten. Homes seeded before this have
  no `~/.profile`: their bangs still work (BASH_ENV), and their next launch seeds it. The guard is a NON-exported
  shell variable: a child bash loads `~/.bashrc` again, as its functions/aliases need. `~/.bashrc` is bash-only —
  dash (`/bin/sh`, via `ENV` when interactive) and bash in POSIX mode skip it. An error in `~/.bashrc` prints on
  stderr (bash names file + line) and the command still runs; a Debian-style early `return`
  (`case $- in *i*) ;; *) return;; esac`) just ends `~/.bashrc` for non-interactive shells — paw never fakes
  interactivity, so lines below such a guard apply only to interactive shells (paw's seeded `~/.bashrc` has none).
  An `exit` in `~/.bashrc` would end every command — don't. `check:sandbox` runs all of the above with a real bash
  and a fake HOME; `check:sandbox-bang` runs the bang's and the shell's argv tails. Verified with the image's
  bash 5.2 in a throwaway container (not a live agent): `bash -lc`, `bash -c`, `bash -l`, `bash -i` all resolve a
  `~/.bashrc` PATH entry, `~/.bashrc` loaded once each, dash untouched. Live agents get it on their next launch
  (the seat's `bashenv.sh` is rewritten per launch — release + manager restart, then the agent's restart).
- **tools**: the VM env points every installer's default into the home — `NPM_CONFIG_PREFIX=~/.local` (so
  `npm i -g neonctl` → `~/.local/bin`), `PNPM_HOME=~/.local/share/pnpm`, `PIP_USER=1` + `PYTHONUSERBASE=~/.local`,
  `CARGO_HOME=~/.cargo`, `GOPATH=~/go`, `BUN_INSTALL=~/.bun`, `XDG_{CONFIG,DATA,CACHE}_HOME` under `~` (CLIs keep
  their auth/config there). `PATH` = `~/.local/bin`, `~/node_modules/.bin`, `$PNPM_HOME`, `~/.bun/bin`,
  `~/.cargo/bin`, `~/go/bin`, then the image's own (`/usr/local/bin`: node, the image's claude). **apt/system
  packages do NOT survive** — they land in the wiped rootfs; bake them into a custom image (`sandboxImage:`).
- **one per name, machine-wide**: the home is keyed by name only (the shape the operator asked for:
  `~/.paw/containers/neon`). `containers/.owners/<name>` (outside the home, so the agent can't rewrite it) records
  the owning space; a sandboxed agent of the same name on ANOTHER space is refused at the CLI and in the manager's
  `buildLaunch` — it would boot with the first one's secrets.
- `paw rename` carries it (+ the owner file); `paw rm` keeps it and prints its path and the `rm -rf` that deletes
  it (a new sandboxed agent of that name on that space would reuse it); `paw sandbox ls` shows it.
- The agent's brief (`SANDBOX_BRIEF`, src/brief.ts) tells it the home exists and that `~/.env` is where secrets go.

Verified live (container 1.6.0, the mini): in `bash -c -l`, `$NEON_API_KEY` from `~/.env` is set and PATH starts
with `/root/.local/bin`; `npm i -g cowsay` lands in the host's `containers/<n>/.local/bin` and runs in the next VM;
`command -v claude` is still the image's `/usr/local/bin/claude`.

**Threat model — obscurity, not isolation.** The home is a host folder outside every repo, so another host agent
grepping its own repos or `~/.paw/spaces` won't stumble on it, and only this agent's VM mounts it. But every host
agent runs as the same macOS user: any of them can `cat ~/.paw/containers/neon/.env`, or `container exec` into
the VM. Keychain-gating was rejected (prompts). Real isolation from other agents = a separate macOS user (or
machine) for the sandboxed agent's paw.

## `!cmd` and a shell in the VM (src/sandbox-exec.ts)

Seen live: `!neon auth login` in `paw chat @neon` ran on the HOST (`zsh:1: command not found: neon`, exit 127) —
neon had installed `neonctl` in its VM, and its tools, `~/.env` and PATH exist only there. Now every "run in the
agent's folder" path (`paw chat`'s `!cmd`, `paw web`'s `!cmd`) asks `bangPlace(space, name)`: no `sandbox:` in the
persona → the host, exactly as before; `sandbox: container` → its ONE running container (labels `paw.space`/
`paw.agent`, as `paw sandbox ls` finds them). Not running (or a stopped one only) → fails loud naming
`paw start <n>#<s>`; two running → refuses to guess. **Never a host fallback** — that was the bug.

The command runs as `container exec -w <folder> <id> timeout -s KILL <secs> bash -lc <command>` — the command one
argv element (no host shell ever sees it), the folder at the same path in the VM, and the container's own env
(`container exec` inherits it: HOME, PATH, BASH_ENV → `~/.env` + `~/.bashrc`; verified 1.6.0). `timeout` is load-bearing:
killing the `container exec` CLI does NOT stop the process in the VM (verified — a `sleep 200` survived its CLI's
SIGKILL), so the bang timeout is enforced inside; its exit 137 reads as "timed out". An in-VM bang gets **5 min**
(`SANDBOX_BASH_TIMEOUT_MS`), not the host's 60s — `!neon auth login` waits while you finish OAuth in the browser —
and a timeout appends ``long/interactive? use `paw sandbox shell <n>#<s>` `` to the output (chat, web, the agent's DM). The chat echoes
`$ <cmd>  (in <name>'s VM: <folder>)`, the agent's transcript says "I ran this in your sandbox VM, in <folder>", the
web hint adds "· ran in <name>'s VM".

Output STREAMS in `paw chat` (both host and VM, batched per ~100ms of complete lines): a login prints its URL,
then waits for the browser callback — the URL shows while it still runs. The REPL still waits for the command
(60s on the host as before, 5 min in a VM). For a real TTY (a login that wants input, a REPL): `paw sandbox shell <n>[#<s>]` =
`container exec -i -t -w <folder> <id> bash -l` (the seeded `~/.profile` sources BASH_ENV, which reads `~/.bashrc`). `check:sandbox-bang`
(fake `container`); `PAW_SANDBOX_BANG_SMOKE=1` adds a real run against a THROWAWAY labelled container.

## Mesh reconnect

**Incident (2026-10-29, team2027).** A broker/path blip at ~03:15 and again at ~03:33 dropped the remote mesh
for every seat. Host agents were back within minutes; the sandboxed `neon`/`fly`/`vercel` (and two host
agents) stayed `seat offline on the mesh … process running`. At 03:15 they were restarted by hand at 03:23;
at 03:33 `neon` was left alone and came back by itself at **03:50:51 — 17 minutes later**, never sooner.

**Root cause (confirmed): nats.js never redials a stale connection whose write buffer is backed up.** The
heartbeat/presence owner in the VM is the cotal MCP server (`node …/connector-claude-code/dist/mcp.cjs`, a
child of claude), one resident NATS connection, nats.js defaults (`pingInterval` 2 min, `maxPingOut` 2,
reconnect on, `reconnectTimeWait` 2s). On a stale PING the client calls `transport.disconnect()`, whose
`_closed()` first `await`s a zero-byte "goodbye" `socket.write` — and a write callback only fires once
everything queued before it reaches the kernel. With the peer gone and the socket's send buffer full
(neon: `/proc/net/tcp` tx_queue stuck at 66937 bytes, timer `01` = retransmit, retrnsmt climbing to 14),
that never happens, so the stale connection is never closed and no redial starts. It ends only when the
KERNEL abandons the socket: Linux `tcp_retries2=15` ≈ 15–17 min (neon redialed on a new local port right
after its 15th retransmit). The host agents' macOS sockets die sooner (RST from the far side / macOS's
shorter retransmit budget), which is why they "recover" and the VM ones look dead forever. Reproduced on
loopback with no VM at all (fake server that stops reading, 32MB of queued publishes): `staleConnection`
fires and nothing follows; unpatched upstream `@nats-io/transport-node` 3.4.1-0 has the same `_closed`.

Not the cause: an idle vmnet NAT timeout (the broker PINGs every 2 min, the outage hit host seats too —
the retransmits going unanswered does suggest the vmnet NAT forgot the flow during the blip, which is
what keeps the Linux socket alive instead of getting an RST, but it is not proven); IPv6 (the VM has no v6
default route; the connection and the redial are IPv4 168.220.88.45).

**Fix: bound the goodbye flush to 1s** (pnpm patches `@nats-io/transport-node@3.4.0` — manager, mailbox,
chat — and `@cotal-ai/connector-claude-code@0.100.0`, whose `dist/mcp.cjs` BUNDLES its own copy of the
transport). A stale connection now redials ~1s after nats.js detects it (≤ ~6 min with the defaults),
host or VM, with no restart of anything. `pnpm check:nats-reconnect` runs the black-hole repro against
the patched transport and asserts the bundled copy is patched. Re-key the connector patch on every cotal
bump; drop both once nats.js ships a bounded close. Cutover = `pnpm install` (a changed patch needs a fresh
`node_modules`), `paw release`, then each agent picks it up on its next (operator-approved) restart.

## Why remote spaces only (v1) — and the local plan

The local open `paw` broker listens on 127.0.0.1, which a VM can't reach. The VM reaches the host at the
vmnet gateway `192.168.64.1` (a `bridge10x` interface while `container`'s default network is up) — and,
through NAT, the host's other addresses. Enabling local spaces later = bind the local broker ALSO on
192.168.64.1 and require auth there (an open broker reachable from every VM is every agent's identity), i.e.
`PAW_AUTH=1` + a listener on the gateway. Catch, seen live: the gateway address exists only while at least
one container runs — a test broker bound to 192.168.64.1 became unreachable once the last VM stopped — so a
local listener there has to bind/rebind with the bridge (or bind the host's tailscale/LAN address, which VMs
also reach through NAT). Until then: put sandboxed agents on a remote (authed, TLS) space.

## What a sandboxed agent can still reach

The internet (claude needs the API), and host services bound to all interfaces via 192.168.64.1 — on the
mini: sshd (22) and AirPlay (5000); the loopback-only ones (the local broker 4222, `paw web` 7788) are not
reachable. It has no host ssh keys, so sshd still needs credentials it doesn't have.

## Cost

Measured on the mini (macOS 27.2, container 1.6.0, haiku): guest memory in use ~600–670 MB (claude ~330 MB
RSS + the cotal MCP + kernel/page cache); host side ~1.3–1.4 GB RSS for the VM process plus ~37 MB runtime
helper, ~55 MB launcher, ~32 MB `container run` CLI — ~1.5 GB per agent vs ~0.4 GB for a host claude.
`sandboxMemory: 1G` boots and answers fine. Cold start to on-mesh ≈ 10–20 s.

## Install of `container` without sudo (how the mini got it)

The signed release pkg's payload runs from any prefix: `pkgutil --expand-full container-<v>-installer-signed.pkg x`,
copy `x/Payload` to `~/.local/opt/container`, symlink `bin/container` AND `bin/container-apiserver` into
`~/.local/bin`, then `container system start --install-root ~/.local/opt/container --enable-kernel-install`. Its
services are user launchd agents. Two traps (1.6.0):
- `system start` looks for `container-apiserver` NEXT TO THE INVOKED CLI path (`CommandLine.executablePath`), not
  under `--install-root` — through a lone `~/.local/bin/container` symlink it fails with a bare "No such file or
  directory". Symlink the apiserver beside it (done on the mini) or invoke the real binary.
- the launchd domain comes from `launchctl managername`: `gui/501` from a GUI (Aqua) session, `user/501` from
  ssh/Background. Start it from a GUI session — started over ssh it registers in `user/501`, and `container
  system status` from an Aqua shell (and paw's preflight, whose LaunchAgents live in `gui/501`) says "not
  registered" (exit 1) even though XPC works. The system install (`sudo installer -pkg … -target /`) is the supported path.

## Live verification (2026-10-28, the mini)

Isolated JWT+TLS brokers (real cotal 0.100 `up --no-manager`, one on the vmnet gateway, one on the mini's
tailscale address), isolated PAW_HOME: every one-liner above ran literally; DMs answered over the mesh; a
`paw restart` resumed the session (the agent recalled its first reply); `paw stop` left no container; the
mac (its own isolated paw, broker reached through an ssh port-forward since the mac's tailscale is
userspace) DM'd and chatted with the mini's sandboxed agent. NOT run on team2027: paw identifies its
manager by command signature (`cotald.ts supervise --space <s> --server`), so a second, isolated paw on a
machine that already runs the live team2027 manager refuses to start one — and the live one runs the
released code, which doesn't know `sandbox:` until a release + manager restart.
