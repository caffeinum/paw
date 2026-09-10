#!/usr/bin/env node
/**
 * The COTAL composition root — the raw cotal CLI + manager + paw's connector, with none of paw's
 * user-facing commands or alias/space/gating pipeline. Only ever run as a SUBPROCESS: src/lifecycle.ts
 * drives the daemons (`up`, `supervise`) through it, and bin/paw.ts's `paw cotal <verb>` passthrough
 * spawns it — runtime coordination, never a compile-time import from the paw CLI path.
 *
 * **0.12 connector/runtime model (migrated 2026-07-19).** As of @cotal-ai 0.11.4 the published
 * `supervise` command constructs its Manager with `installedExtensions: true` — it resolves connectors
 * AND runtimes from the operator EXTENSION MANIFEST (`cotal ext add`), NOT from static imports, so paw's
 * in-memory-registered connector was invisible → agents failed to spawn ("no connector 'claude'
 * installed"). paw is a DIRECT library Manager user (cotal's own note: "a direct library Manager keeps
 * the registry-only default"), so we no longer route `supervise` through runCli's manifest-mode command:
 * cotald handles `supervise` ITSELF with a minimal `new Manager({ installedExtensions: false })`, so the
 * connector + the tmux/cmux runtimes resolve from the registry these imports populate. Every OTHER verb
 * (`up`, `ps`, `start`, `stop`, `attach`) still goes through runCli — they don't construct a Manager.
 *
 * The manager's default agent type is now "claude" (0.12 `DEFAULT_CONNECTOR`), and importing
 * connector-claude-code SELF-REGISTERS its vanilla `claude` connector; we drop that and register paw's
 * OPINIONATED connector under "claude" (+ a "cotal" alias for any explicit 0.11-era `--agent cotal`).
 */
import { runCli } from "@cotal-ai/cli";
import { Manager } from "@cotal-ai/manager"; // named import also runs the module → registers up/ps/start/stop/attach
import "@cotal-ai/tmux"; // self-registers the `tmux` runtime (manager ships only `pty`)
import "@cotal-ai/cmux"; // self-registers the `cmux` runtime + terminal-layout providers
import "@cotal-ai/connector-codex"; // self-registers the `codex` connector (host-mode peer over codex app-server)
import "@cotal-ai/connector-opencode"; // self-registers the `opencode` connector (in-process plugin)
import { DEFAULT_SERVER, isReachable, registry } from "@cotal-ai/core";
import { pawConnector } from "../src/connector.js"; // importing this self-registers the VANILLA `claude` connector (0.12) + paw's `paw`

// Replace the vanilla `claude` connector (just self-registered by the connector-claude-code import) with
// paw's opinionated wrapper, so the manager's default agent type "claude" resolves to OURS. `register`
// throws on a duplicate, so unregister the vanilla one first.
registry.unregister("connector", "claude");
registry.register({ ...pawConnector, name: "claude" });
registry.register({ ...pawConnector, name: "cotal" }); // back-compat alias for an explicit `--agent cotal`

/**
 * Minimal DIRECT-Manager `supervise` (installedExtensions:false → registry-only resolution) — the
 * published `supervise` forces manifest mode. paw only ever passes `--space/--server/[--runtime]`
 * (no roster/launch/resume/console — see src/lifecycle.ts startManagerDaemon), so this is all it needs.
 * The process command line is UNCHANGED (`cotald.ts supervise --space <s> --server <y> [--runtime <r>]`),
 * so paw's pgrep-based manager ownership + `actualManagerRuntime` (reads the `--runtime` flag) still work.
 */
async function supervise(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const space = flag("--space");
  if (!space) throw new Error("cotald: supervise needs --space <s>");
  const server = flag("--server") ?? DEFAULT_SERVER;
  const runtime = flag("--runtime") ?? "pty"; // paw's default; tmux/cmux resolve from the imported runtime exts
  if (!(await isReachable(server))) throw new Error(`cotald: can't reach NATS at ${server} — run \`cotal up\` first`);

  const mgr = new Manager({ space, servers: server, runtime, installedExtensions: false });
  await mgr.start();
  console.log(`✓ manager up (space ${space} · ${runtime})`);

  // Tear the manager + its spawned teammates down on a clean signal (mirrors runManager's shutdown).
  const shutdown = (): void => {
    void mgr
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // start() keeps the event loop alive via the mesh connection + timers — no explicit keep-alive needed.
}

const argv = process.argv.slice(2);
try {
  if (argv[0] === "supervise") await supervise(argv);
  else await runCli(registry, argv);
} catch (err) {
  // Failures surface in daemon logs / the passthrough terminal: one clear line, stack behind PAW_DEBUG.
  console.error((err as Error)?.message ?? String(err));
  if (process.env.PAW_DEBUG) console.error(err);
  process.exit(1);
}
