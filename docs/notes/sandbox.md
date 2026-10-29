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
paw sandbox ls                             # every paw container on THIS machine: agent#space, state, mem used/limit, launcher live|orphan, forwarded ports
```

Persona keys: `sandbox: container` (any other value throws — a typo never boots the agent unsandboxed),
`sandboxImage:` (default `paw-sandbox:<sha256(Containerfile)[:12]>`, so a recipe change asks for a rebuild),
`sandboxMemory:` (default `2G`), `sandboxForward: false` (turns off [port forwarding](#port-forwarding); default on). `paw claude --sandbox` writes `sandbox: container` once; it is never cleared
by paw (un-sandboxing is a deliberate persona edit). Auth: the Claude OAuth token at
`$PAW_HOME/secrets/claude-oauth-token` (`PAW_CLAUDE_TOKEN_FILE` overrides), a 0600 regular file.
`PAW_CONTAINER` pins the `container` binary (else the first on PATH).

## How it launches

`pawConnector.buildLaunch` builds claude's launch exactly as for any agent, then `sandboxLaunch`
(src/sandbox.ts) turns it into `node bin/paw-sandbox-run.mjs … -- container run --rm -i -t --init … <image>
claude <the same args>`. The hub rewrite, tracepaper-direct and `nice` are skipped for a sandboxed seat (it
runs its own cotal MCP in the VM; the VM has its own CPUs). The in-VM command is always the IMAGE's
`claude` — the manager resolves `spec.command` to the host binary's absolute path, which the VM lacks.

What the VM sees (everything else of the host is absent — verified: `~/.ssh`, `~/.paw`, `~/Github`,
`~/Library` don't exist in it, a write outside the mounts lands in the VM's own rootfs, `ps` shows ~6 VM-local
processes):

| host | in the VM | mode | why |
|---|---|---|---|
| the agent's folder (persona `cwd:`) | same path | rw | the only host folder it can change |
| `$PAW_HOME/spaces/<s>/sandbox/<n>/claude` | `/paw/claude` (= `CLAUDE_CONFIG_DIR`) | rw | transcripts, `.claude.json`, settings survive every container restart; seeded with onboarding done, the folder trusted, bypass consent |
| `…/sandbox/<n>/seat/` (per-launch copies of the persona and any `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`) | `/paw/seat` | ro | single files are COPIED: their own dirs hold other agents' personas / a CA's key |
| `…/sandbox/<n>/creds/` (a mirror of ONLY this agent's creds file) | the creds dir's own path (the launch material names it) | ro | the real dir holds every agent's creds on this machine; the launcher re-copies on renewal |
| paw's topmost `node_modules` (release or checkout) | same path | ro | the cotal MCP server (`mcp.cjs`) and plugin hooks claude starts as its children |
| cotal's launch dirs (`material.json`, persona prompt file + `paw-brief.md`) | same paths | ro | |
| `<cotal root>/.cotal/events` | same path | rw | the MCP server's event write-ahead log — never the root itself (the signer) |

Env reaches the VM by NAME only (`-e KEY`, values inherited from the launcher's env): every `COTAL_*` except
`COTAL_HOME`, plus `TERM`/`COLORTERM`/`LANG`/`LC_ALL`, CA vars, `CLAUDE_CONFIG_DIR`, `IS_SANDBOX=1` (claude
runs as the VM's root; the VM is the sandbox) and `CLAUDE_CODE_OAUTH_TOKEN`. `COTAL_CONTROL_SOCKET` moves to
`/tmp/cotal-control.sock` in the VM (the MCP server listens, the hooks dial — both inside). Any OTHER
`COTAL_*` value that is an absolute host path not under a mount fails the launch loud (a future cotal var
must be taught, not silently missing). `--mcp-config` is cut to the cotal server alone: servers `paw mcp`
shares run host commands with host secrets in their env.

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

## Refusals (all fail loud, `check:sandbox`)

- a LOCAL space (v1, below) — at `paw claude --sandbox` before anything is written, at the spawn site
  (`ensureAgentSpawned`) and in the manager's `buildLaunch`;
- a non-claude harness (`agent: kit|acp|…` would silently run unsandboxed), `headless: true` (needs the hub's
  host socket), no persona `cwd:`, `--fg`;
- `container` missing / services down / image not built / token file missing, empty or group/other-readable;
- `paw move` and `paw teleport` of a sandboxed agent (its store under `spaces/<s>/sandbox/<n>` isn't carried
  yet); `paw rename` moves the store with the persona.

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
copy `x/Payload` to `~/.local/opt/container`, symlink `bin/container` into `~/.local/bin`, then
`container system start --install-root ~/.local/opt/container --enable-kernel-install`. Its services are user
launchd agents. The system install (`sudo installer -pkg … -target /`) is the supported path.

## Live verification (2026-10-28, the mini)

Isolated JWT+TLS brokers (real cotal 0.100 `up --no-manager`, one on the vmnet gateway, one on the mini's
tailscale address), isolated PAW_HOME: every one-liner above ran literally; DMs answered over the mesh; a
`paw restart` resumed the session (the agent recalled its first reply); `paw stop` left no container; the
mac (its own isolated paw, broker reached through an ssh port-forward since the mac's tailscale is
userspace) DM'd and chatted with the mini's sandboxed agent. NOT run on team2027: paw identifies its
manager by command signature (`cotald.ts supervise --space <s> --server`), so a second, isolated paw on a
machine that already runs the live team2027 manager refuses to start one — and the live one runs the
released code, which doesn't know `sandbox:` until a release + manager restart.
