# Sandboxed agents (`sandbox: container`)

Index: [CLAUDE.md](../../CLAUDE.md)

A claude (or [kit](#kit-in-the-vm)) agent that runs inside its own Linux VM (Apple's [`container`](https://github.com/apple/container),
macOS 26+, Apple silicon) and is still the same peer on the cotal mesh: `paw dm`/`chat`/`status`/`log`/
`attach`/`restart` all work unchanged. It can change only its own folder.

## Use

```
<root>/bin/container system start --install-root <root>   # once per boot (Apple's services; `paw` never starts them).
                                           # The REAL binary + --install-root, never via a symlink — see "A wrong install root"
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
- a harness that can't run in the VM: `agent: acp|hermes|codex|opencode|…` (it would silently run unsandboxed). claude
  and kit run inside it ([kit in the VM](#kit-in-the-vm)). Also `headless: true` (needs the hub's host socket), no
  persona `cwd:`, `--fg`;
- a swap that couldn't launch: `paw restart <sandboxed> --agent kit|claude` checks the TARGET harness against all of
  the above, the host side (image, `container`, the Claude token or the linux kit + provider login) and the manager's
  `sandbox-kit` feature BEFORE it writes the persona ([below](#swapping-a-sandboxed-agent));
- `container` missing / services down / image not built / token file missing, empty or group/other-readable;
- `paw move` and `paw teleport` of a sandboxed agent (its store under `spaces/<s>/sandbox/<n>` and its home
  aren't carried yet); `paw rename` moves the store AND the home with the persona, refusing if
  `containers/<new>` (or its owner file) already exists;
- a sandboxed agent whose NAME already owns a home on another space (below).

## kit in the VM

`agent: kit` + `sandbox: container` (src/sandbox-kit.ts, 2026-11-24): kit runs INSIDE the agent's VM the way claude
does, so a sandboxed agent that hit Claude's usage limit keeps working on codex or grok and stays sandboxed.

**Why kit, of the non-claude harnesses** (the operator's "choose one that's easier to integrate"): kit is one static
Go binary — `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build` gives a 13 MB linux/arm64 ELF on this Mac, no image
change; it speaks cotal itself (no MCP/hub to carry into the VM), takes the manager-minted `--creds` file, reads
tokens from files only, and with `storage: claude` keeps appending to the SAME claude transcript claude left in the
agent's sandbox store — so the swap continues the conversation. The others need more: acp's seat host is a Rust
binary built from a private git dep (`cotal-rs`) plus a node agent and its own home; hermes is a Python venv via `uv`
plus a per-profile OAuth login; codex/opencode would need their CLIs in the image and their own session stores.

How it launches — the kit connector builds kit's launch exactly as for a host agent, then `sandboxKitLaunch` wraps it
in the same launcher (`bin/paw-sandbox-run.mjs`) as claude's: `container run … <image> /paw/kit/kit run <same args>`.

| host | in the VM | mode | why |
|---|---|---|---|
| the agent's folder | same path | rw | as for claude |
| `$PAW_HOME/containers/<n>` | `/root` (`HOME`; `KIT_HOME=/root/.kit`) | rw | its private home: kit's config, models cache, own store, own `kit auth` login |
| `…/sandbox/<n>/claude` | `/paw/claude` (= `CLAUDE_CONFIG_DIR`) | rw | `storage: claude` → kit `--overwrite` appends to the claude transcript there |
| `$PAW_HOME/spaces/<s>/kit/<n>` | same path | rw | kit's brief (`system.md`) + `schedules.json` (paw sleep reads it) |
| `$PAW_HOME/bin/linux-arm64/` (`KIT_LINUX_BIN` overrides) | `/paw/kit` | ro | the linux kit; the dir must hold nothing else (refused otherwise) |
| `…/sandbox/<n>/creds/` | the creds dir's own path | ro | ONLY its mesh creds, re-copied on renewal — as for claude |
| `…/sandbox/<n>/kit-auth/` | `/paw/kit-auth` | ro | ONE provider's access token ([below](#the-provider-login)) |
| each `~/.claude/skills/<n>` (realpath) | `/paw/claude/skills/<n>` | ro | the operator's skills, as for claude; `handoff` is one |
| `…/sandbox/<n>/seat/` | `/paw/seat` | ro | `bashenv.sh` (kit's persistent shell is a non-interactive bash, so `~/.env` + `~/.bashrc` reach it), a CA |

Env by name only: `TERM`/`COLORTERM`/`LANG`/`LC_*`/`TZ`, `COTAL_SPACE`/`COTAL_NAME`; the paths (`HOME`, `KIT_HOME`,
`CLAUDE_CONFIG_DIR`, `PATH`, `BASH_ENV`) from the per-launch env file. A broker on a private CA: the manager's
`NODE_EXTRA_CA_CERTS` goes into `/paw/seat/ca` with `SSL_CERT_DIR=/etc/ssl/certs:/paw/seat/ca` (Go keeps the public
roots); `SSL_CERT_FILE` is copied as a whole bundle. The brief gets `SANDBOX_KIT_BRIEF` (no MCP lines: kit has no MCP
client — `paw mcp add --to <kit agent>` is refused). The operator's skills mount read-only at `/paw/claude/skills/<n>`
as for claude (2026-11-25: before that a kit seat got none, so `handoff --to` from neon found an empty dir); plugin
skills don't (they need claude's `--plugin-dir`).

**The linux kit.** Built by paw on the CLI side before the spawn when missing: `ensureKitLinuxBinary` cross-builds
from `$KIT_SRC` (the same checkout the host kit comes from; default `~/Github/caffeinum/kit`). No checkout → fail loud
with the command: `cd <kit> && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ~/.paw/bin/linux-arm64/kit ./cmd/kit`.
Like the host kit it is not part of a release; rebuild both from one commit when upgrading. The host kit still parses
`kitArgs` (`preflightKitArgs`) and refreshes the host login.

### The provider login

kit reads its bearer from FILES and re-reads them on every call, so the token reaches the VM as a file (never argv,
never an env var — a running process could never be handed a renewed one): `bin/paw-sandbox-kitauth.mjs`.
- **Which provider**: `sandboxKitProvider` — `-P`, else what `-m` implies (`grok-*` → grok; `gpt-*`/`codex-*`/`o<n>`/
  `codex/…` → codex), from kitArgs (last wins), a spawn `--model`, the persona's `provider:`/`model:`. Nothing named
  (kit's own defaults) or a model paw can't place is REFUSED — paw mirrors exactly one provider. `fake[:…]` needs none.
- **What crosses**: `…/sandbox/<n>/kit-auth/auth.json` = `{"<xai|openai>": {access, expires[, accountId]}}`, 0600,
  mounted read-only; the agent's `~/.kit/auth.json` is a symlink to `/paw/kit-auth/auth.json` (made only when it has
  no login file of its own). Never a refresh token, never the host's `~/.kit`, `~/.codex` or opencode dir. Source =
  what the HOST kit would use: kit's own store (`$KIT_HOME|~/.kit/auth.json`), else the borrowed codex/opencode login.
- **Fresh**: the launcher polls the host login every 5 s and copies each change in. When kit's OWN host login is within
  10 min of expiry it runs the HOST kit — `kit models <grok|codex> --refresh`, which goes through kit's own token
  source and saves the rotated pair in the host store, as a host kit agent would — synchronously before the first
  mirror, in the background after (≤ once per 2 min). A borrowed login is never refreshed (kit never does either); a
  lapsing one is logged. `launcher.log` names the origin and each renewal, never the value.
- **Its own login instead**: `paw sandbox shell <n>#<s>` → `kit auth grok` writes `/root/.kit/auth.json` over the
  symlink; from then on paw mounts nothing and kit refreshes that login itself. An own login without the agent's
  provider is refused (never mixed with the host's).
- Refused before launch (spawn site, swap, launcher): no host login, a lapsed borrowed one, an unreadable or
  group-readable kit store.

Threat model: the agent can read the access token (inherent, as with claude's), not the refresh token, so it can't
mint new ones or log the host out; another host agent can read `…/kit-auth/auth.json` like any of the user's files.

### Readers

`paw log`/status/`attach`'s kit view/the wake gate: `personaTranscriptRoots` = the sandbox claude store
(`storage: claude`) or `containers/<n>/.kit/sessions` then it (kit's store). `paw sleep`: the VM's ps
(`vmKitSessionProcs`: the seat is `/paw/kit/kit run`, kit's persistent shell is plumbing) + `schedules.json`; a wake
blocker if the linux kit is gone. `paw status` busy = presence (as every kit agent). `!cmd`, `paw sandbox shell`,
`stop`, `rename`, `rm` work unchanged (they are the VM's, not the harness').

### Swapping a sandboxed agent

```
cd ~/Code/caffeinum/kit && go build -o ~/.paw/bin/kit ./cmd/kit && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ~/.paw/bin/linux-arm64/kit ./cmd/kit
kit auth grok                                   # once, if `kit auth status` has no grok login on this Mac
paw restart neon#team2027 --agent kit -- -m grok-4.7
paw restart neon#team2027 --agent claude        # back, once Claude's limit resets
```

The swap sets `storage: claude` and keeps `sandbox:`. **A swap that can't launch never writes** (`assertSwapLaunchable`,
src/swap.ts): before 2026-11-24 the persona was flipped to `agent: kit` and the agent stopped, and only then did the
spawn site refuse a sandboxed kit — the agent stayed down on a flipped persona. Now the target harness, the host side
and the manager's `sandbox-kit` feature are checked against the persona as it WILL be; any refusal says "nothing was
changed; <n> keeps running on <harness>". Needs a manager on a release that has `sandbox-kit` (an older kit connector
ignores `sandbox:` and would run the agent on the host) — refused otherwise, naming `paw release` + the restart.

Verified (2026-11-24, this Mac, container 1.6.0, image `paw-sandbox:df0569e40d03` unchanged): `scripts/e2e-sandbox-kit.ts`,
22/22 — isolated PAW_HOME, a throwaway JWT+TLS broker on 192.168.64.1, real manager (PAW_RELEASE=dev), kit 273f4ee
cross-built by paw itself. A sandboxed claude persona → `paw restart --agent kit -- -P fake:codex` started kit in a
VM (`/paw/kit/kit run … --creds …` in the VM's ps, none on the host), a DM was answered from it over the mesh (its
shell: `Linux aarch64`, `KIT_HOME=/root/.kit`, `CLAUDE_CONFIG_DIR=/paw/claude`, no `~/.paw`), the transcript landed
in `sandbox/<n>/claude/projects/…/<pin>.jsonl` and not in `~/.claude`, `paw log` read it, `paw restart` resumed it
(history 3 → 9) in a fresh container, `paw stop` left none. A second agent on `-m grok-4.7` with a FAKE grok login in
the test kit home: `kit auth status` in the VM said `kit auth (/root/.kit/auth.json) … refreshable=false`, the mount
was read-only and held no refresh token, launcher.log and host argv carried no token. NOT run: a real codex/grok turn
from a VM (no real token used in tests), and nothing on team2027.

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

## Handoff from a sandboxed agent (src/handoff-relay.ts, 2026-11-10) {#handoff}

The `handoff` skill script stores a one-time secret in `<recipient folder>/.handoff/NAME` (0600), found
through `~/.paw/spaces/<s>/personas/<agent>.md`. A VM sees neither the personas nor other agents' folders
(on purpose, see "How it launches"), so a sandboxed SENDER could never deliver. betterstack (team2027)
read a Better Stack token, got `handoff: no persona 'vercel#team2027'`, and the operator had to copy it by
hand. Host → sandboxed already worked: the recipient's folder is mounted at the same path.

- **The sender's own folder is the outbox.** In a VM (`IS_SANDBOX=1`), `handoff --to <agent>[#space] NAME`
  finds its folder as `/proc/1/cwd` (the init's cwd = the `-w` folder, mounted read-write at the same
  host path). It writes `.handoff/.outbox/.tmp-<id>/{to,name,value[,force]}`, commits it by renaming to
  `<id>`, and waits for `<id>.ok` / `<id>.err`.
- **The mailbox relays** (`startHandoffRelay`, one pass a second). For each sandboxed agent hosted on this
  machine (persona `sandbox:` set, `machine:` absent or this machine, not teleported), it claims each
  committed request by renaming it to `.claimed-<id>`. It resolves the recipient from the HOST's personas
  (default space = the sender's), stores it as the script would (0700 dir, 0600 file, no overwrite without
  `force`, `.handoff/` into the repo's local git exclude), writes a one-line receipt and deletes the
  request. Receipts nobody collected go after 10 minutes.
- **Who sent it** = whose folder holds the outbox; no other VM can write there. A folder shared by two
  sandboxed agents is refused with a receipt.
- **Refused, never guessed:** unknown agent, bad NAME, a recipient whose `machine:` is another machine
  (cross-machine handoff isn't supported), teleported, folder missing.
- **The value never leaves the filesystem.** Not on the mesh, in a DM or on argv. The mailbox log gets
  `[handoff] betterstack → vercel#team2027 NAME (24 bytes)`.
- **The script fails loud** in a VM: no receipt in 15s → the request is withdrawn ("its mailbox may
  predate the handoff relay"); `pop/ls/env/rm --to` refuse (another agent's store isn't readable from a
  VM). Before this, a VM `--to` whose lookup had succeeded would have written into the wiped rootfs and
  printed "stored": the secret silently lost.
- **Rollout:** the script lives in `~/.claude/skills/handoff` (mounted read-only into every VM, so an edit
  is live at once); the relay needs a release + `paw restart --mailbox --space <s>`. No agent restarts.
  `check:handoff-relay` (hermetic); verified end to end in a throwaway `paw-sandbox` container.

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

## A wedged VM

**Incident (2026-11-06, team2027).** `vercel` (`sandboxMemory: 1G`) flapped "seat offline on the mesh … process
running" / "seat back" every 10–40s from 07:28Z, then stayed offline from 07:33:47Z with DMs queued. The other VMs
were fine. Same principal throughout, so this was not two incarnations or a sleep stand-in fighting over the name. The seat ran the
manager's release (594a832b377c), whose connector bundle carries the nats reconnect patch, so it was not the stale-link bug either.

**Root cause: the guest ran out of memory and livelocked.** `container logs --boot` showed `claude: page allocation
failure: order:1 GFP_ATOMIC` from 07:32:09Z, `inactive_anon` ≈ 1002908kB of the 1G, no swap, page-cache thrash
(`filemap_fault`), and **no OOM kill**. Processes got CPU only in slivers, so the cotal MCP server's heartbeats
came late and then stopped. Everything that talks to the guest hung: `container exec` (the sleep host's
"ps did not settle within 20s", the port forwarder), `container stop`, `container delete --force`. paw could not see it, because the
launcher and `container run` on the host were alive. When the operator restarted the seat, the launcher's detached
`stop` hung and the VM outlived its launcher. Each relaunch then blocked on `delete --force` of that leftover
(60s) past the manager's 15s startup confirmation, logged as "WARNING: Loading development channels did not appear".

**Fix.**
- `bin/paw-sandbox-kill.mjs` `forceRemoveContainers`: a bounded `delete --force`, then SIGKILL of the VM's HOST
  process (`container-runtime-linux start … --uuid <id>`, which always dies), a short settle, then delete again. It throws while
  the container is still listed and never reports one gone that isn't. The launcher's SIGTERM reaper (now this module as a detached
  CLI), the leftover removal at launch (a leftover that won't go fails the launch loud, ≤ ~9s), the run CLI's
  exit cleanup and `reapSandbox` (`paw stop`/`sleep`) all use it.
- The launcher's guest watchdog runs `container exec <id> true` every 30s (20s timeout). After the VM has answered once,
  4 failures in a row mean wedged: it logs `WEDGED … out of memory? raise its sandboxMemory`, kills the VM, and exits **75**.
  Knobs for tests: `PAW_SANDBOX_PROBE_MS`, `PAW_SANDBOX_PROBE_TIMEOUT_MS`, `PAW_SANDBOX_PROBE_FAILS`.
- A sandboxed spawn carries cotal's `supervise` policy (`SANDBOX_SUPERVISE`: 3 restarts per 30 min). When a seat exits on its
  own, the manager relaunches it in place: same principal, lifecycle and DM durable, so the queued DMs are delivered, and
  the persona's pin makes it `--resume`. A despawn (`stop`/`sleep`/`restart`) is never restarted. When the budget runs out, the seat is
  retired loud.

The memory itself is the persona's call: a wedge says so in `launcher.log`. `check:sandbox-wedge` uses a fake
`container` whose guest wedges on cue.

## A wrong install root

**Incident (the mini, 2026-11-06, ~30 h):** something ran `container system start` through the symlink
`~/.local/bin/container -> ~/.local/opt/container/bin/container`. `system start` derives the install root from the
path it was INVOKED by, so `~/Library/Application Support/com.apple.container/apiserver/apiserver.plist` recorded
`EnvironmentVariables.CONTAINER_INSTALL_ROOT = ~/.local` instead of `~/.local/opt/container`. With no plugins
there the apiserver crash-looped ("Error: cannot find any plugins with type network", 2,400+ launchd runs), and
every sandboxed wake failed with a `container system status` ETIMEDOUT that said nothing about why.

`bin/paw-container-root.mjs` (plain ESM, shared by `src/sandbox.ts` and the launcher) reads that plist and checks
`<CONTAINER_INSTALL_ROOT>/libexec/container/plugins/container-network-vmnet`. Missing ⇒ one actionable error naming
the recorded root, the root from the realpath of the `container` paw would run (`realpath(bin)` minus
`/bin/container`), and the exact fix — `<root>/bin/container system stop; <root>/bin/container system start
--install-root <root>`, or `plutil -replace EnvironmentVariables.CONTAINER_INSTALL_ROOT -string <root> <plist>` +
`launchctl bootout gui/<uid>/com.apple.container.apiserver; launchctl bootstrap gui/<uid> <plist>`. If the realpath
root lacks the plugin too, it says the install itself is incomplete instead of offering a fix that can't work.
- **Where:** `assertSandboxHostReady` runs it ALWAYS (one `plutil`), before `container system status` — and also
  over ssh, where `outsideGuiSession()` skips the status probes but a file read is fine (`container` not on an ssh
  PATH ⇒ the bad root is still named, without the real one). The launcher runs it when `container ls` fails.
- **Never edits the plist**, and never starts Apple's services under another root (see below). No plist (services
  never started) or a plist that records no install root ⇒ nothing judged, never a guessed root.
- paw's own hints that used to say `container system start` now say `<realpath root>/bin/container system start
  --install-root <root>`, so paw can never cause this itself.
- `check:sandbox` ("apiserver install root"): fake install tree + symlink + fake plist (good / wrong / no key /
  incomplete install), the ssh path, the plist unchanged after.

## After a reboot

**Incident (the mini, 2026-11-09, macOS 27.2→27.3):** `container`'s services are registered with launchd by
`system start`, not by a LaunchAgents file, so a reboot leaves the apiserver "not running and not registered with
launchd". Every sandboxed agent (vercel, neon, fly, stripe, cf…) then refused to wake with a message naming the exact
`<root>/bin/container system start --install-root <root>` — which fixed it when the operator ran it by hand.

`assertSandboxHostReady` (the CLI-side preflight of every sandboxed spawn, including `paw start --boot`) now runs
that command itself when `container system status` fails with "not running"/"not registered":
- **Once per process**, bounded at 90s, `stdin` closed and `--disable-kernel-install` (never an interactive prompt);
  then `system status` again. One stderr line: `paw: started Apple container's apiserver (it wasn't running — after
  a reboot?)`.
- **Never a guessed root:** the binary is `realpath(container)`, the root is its parent's parent (`installRootOf`). The
  wrong-root diagnosis runs first and still throws (start never called); a plist recording a DIFFERENT working root
  is refused loud (paw won't re-register it under another one); a root without the network plugin is refused.
- Any other status failure (a timeout…), a failed start, or a status still failing after it ⇒ the old loud error,
  now with the start's own output.
- **Never over ssh:** `outsideGuiSession()` skips the probes there, and a `system start` from a Background session
  would register it in `user/<uid>`, invisible to the login session (see the install notes below). An ssh wake of a
  sandboxed agent after a reboot still fails in the launcher (`container ls`), until a login-session `paw start`
  (the fleet job at login does it).
- The launcher (`bin/paw-sandbox-run.mjs`) does not start it — only reports.
- `check:sandbox` ("apiserver not registered"): fake `container` + install tree + plist, one process per scenario.

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
