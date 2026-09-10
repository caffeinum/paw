/**
 * paw as a cotal extension — `cotal paw <verb> …`.
 *
 * ## What this is
 *
 * ONE registered command, named `paw`, with `rawArgs: true`. Everything after the word `paw` is
 * handed to paw's own CLI verbatim. paw's dispatch (bin/paw.ts) then does what it always does:
 * the mesh/manager gate (`NEEDS_MESH`/`NEEDS_MANAGER`), the default `--space` injection, the
 * `cotal`/`claude`/`__complete` early branches, its one-screen help for a bare invocation, and its
 * fail-loud error for an unknown verb. This extension adds no grammar of its own.
 *
 * ## Why ONE command and not ~25
 *
 * `cotal ext add` fails the whole install on a name collision with a builtin, and seven paw verbs
 * already collide (`attach status stop start history completion down`). A single `paw` namespace
 * also survives a later cotal release claiming `chat`/`inbox`/`log`/`files`.
 *
 * ## Why a SUBPROCESS and not an in-process import of paw's src/
 *
 * paw's commands are already core `Command`s that consume `args.raw`, so importing them and
 * dispatching in-process looks like the tighter adapter. It isn't, for three independent reasons:
 *
 *  1. **Two `@cotal-ai/core` instances.** The extension's core is symlinked to the running cotal
 *     binary's copy (`bindExtensionPeers`); paw's `src/` resolves core from the paw checkout's own
 *     `node_modules`. Different realpaths ⇒ different `registry` singletons. Workable, but it means
 *     paw's endpoint/contract objects and cotal's would be distinct classes in one process.
 *  2. **paw's `src/` is TypeScript and must stay executable as TypeScript.** `src/lifecycle.ts`
 *     computes `REPO_ROOT` from `import.meta.url` and spawns `<root>/bin/cotald.ts` and
 *     `<root>/bin/paw.ts` through `<root>/node_modules/tsx`. Importing a COMPILED copy would move
 *     `REPO_ROOT` into `dist/`, where those `.ts` entries do not exist — the daemons would stop
 *     starting. Importing the `.ts` sources directly needs a tsx loader registered inside cotal's
 *     process, which the cotal binary does not have.
 *  3. **bin/paw.ts's pre-dispatch gate is not in `src/`.** The mesh/manager `ensure()`, the default
 *     `--space` append, `expandEqFlags`, the early `cotal`/`claude`/`__complete` branches and the
 *     `create`/`send` redirects all live in the composition root. Reimplementing them here is
 *     exactly the drift the reuse rule exists to prevent.
 *
 * Spawning `bin/paw.ts` reuses strictly MORE of paw than an in-process import would — all of
 * `src/` plus all of the composition root — and it cannot drift, because it is the same program
 * the `paw` binary runs. `stdio: "inherit"` hands the child the real tty, so `chat`'s REPL,
 * `open`/`attach`'s pty takeover and `paw claude`'s inherit-spawn behave identically.
 *
 * The cost is one extra process start (~0.2s under bun) on top of cotal's own. That is the whole
 * tradeoff.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute node binaries to try when the host runtime isn't node itself. Mirrors the reasoning in
 *  src/lifecycle.ts's `nodeBin()`: never return a bare `"node"` that fails later as somebody
 *  else's error — a stripped PATH (launchd, Raycast, a mesh-agent shell) has none of these on it. */
const NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
  join(process.env.HOME ?? "", ".local/bin/node"),
];

/** The conventional checkout location, tried LAST and only if it verifies as a real paw checkout.
 *  A convenience, not a guess: an unverified default would silently run the wrong tree. */
const CONVENTIONAL_ROOT = join(process.env.HOME ?? "", "Github", "paw");

/**
 * The paw checkout this extension drives, in precedence order:
 *
 *   1. `PAW_REPO` — the explicit override (absolute, verified, or loud)
 *   2. `dist/paw-root.json` — the path stamped in at build time (verified, or loud)
 *   3. `~/Github/paw` — the documented convention, used ONLY if it verifies
 *
 * Every branch verifies `<root>/bin/paw.ts` before returning, and exhausting all three throws with
 * all three fixes named. There is no silent fallback: a wrong root would run somebody else's paw.
 */
export function pawRoot(): string {
  const override = process.env.PAW_REPO?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(`paw: PAW_REPO must be an absolute path, got "${override}"`);
    }
    assertPawCheckout(override, "PAW_REPO");
    return override;
  }

  const stamp = join(HERE, "paw-root.json");
  if (existsSync(stamp)) {
    let root: unknown;
    try {
      root = (JSON.parse(readFileSync(stamp, "utf8")) as { root?: unknown }).root;
    } catch (e) {
      throw new Error(`paw: could not read the paw-root stamp ${stamp}: ${(e as Error).message}`);
    }
    if (typeof root !== "string" || !root) {
      throw new Error(`paw: the paw-root stamp ${stamp} records no "root" — rebuild and re-add the extension.`);
    }
    // A stamp that exists but no longer points at a checkout is an ERROR, not a reason to fall
    // through to the convention: the operator built from a specific tree and it moved. Saying so is
    // the useful answer; quietly running a different tree is not.
    assertPawCheckout(root, stamp);
    return root;
  }

  if (isPawCheckout(CONVENTIONAL_ROOT)) return CONVENTIONAL_ROOT;

  throw new Error(
    `paw: could not locate a paw checkout. This extension was built without a paw-root stamp ` +
      `(${stamp} is missing) and the conventional location ${CONVENTIONAL_ROOT} is not a paw checkout. ` +
      "Rebuild and re-add it (`pnpm plugin:install` in the paw checkout), or set " +
      "PAW_REPO=<absolute path to the checkout>.",
  );
}

function isPawCheckout(root: string): boolean {
  return existsSync(join(root, "bin", "paw.ts"));
}

function assertPawCheckout(root: string, source: string): void {
  if (!isPawCheckout(root)) {
    throw new Error(
      `paw: ${source} points at ${root}, which is not a paw checkout (no bin/paw.ts). ` +
        "Move it back, or rebuild + re-add the extension from the checkout's current location.",
    );
  }
}

/** How to execute `<root>/bin/paw.ts`. Prefers bun (the same choice ~/.local/bin/paw makes: ~0.2s
 *  vs ~0.8s under tsx), falls back to node + the checkout's own tsx. Every path is ABSOLUTE. */
export function pawExec(root: string): { exec: string; args: string[] } {
  const entry = join(root, "bin", "paw.ts");

  const explicit = process.env.PAW_BIN?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error(`paw: PAW_BIN must be an absolute path, got "${explicit}"`);
    if (!existsSync(explicit)) throw new Error(`paw: PAW_BIN points at ${explicit}, which does not exist`);
    return { exec: explicit, args: [] };
  }

  const bunHome = join(process.env.HOME ?? "", ".bun", "bin", "bun");
  if (existsSync(bunHome)) return { exec: bunHome, args: [entry] };
  if (basename(process.execPath).startsWith("bun")) return { exec: process.execPath, args: [entry] };

  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsx)) {
    throw new Error(`paw: ${tsx} is missing — run \`pnpm install\` in ${root}, or install bun.`);
  }
  return { exec: nodeBin(), args: [tsx, entry] };
}

function nodeBin(): string {
  const self = basename(process.execPath);
  if (self === "node" || self === "node.exe") return process.execPath;
  const found = NODE_CANDIDATES.find((p) => p && existsSync(p));
  if (found) return found;
  throw new Error(
    "paw: could not resolve an absolute `node` to run the paw CLI under tsx — install bun, " +
      "or set PAW_BIN to an executable paw launcher.",
  );
}

/** Run paw with `argv`, inheriting this terminal. Resolves with the child's exit code. */
function runPaw(argv: readonly string[]): Promise<number> {
  const root = pawRoot();
  const { exec, args } = pawExec(root);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(exec, [...args, ...argv], { stdio: "inherit" });

    // The child shares this terminal's foreground process group, so Ctrl-C already reaches it
    // directly — paw's own SIGINT handling (chat's REPL, the pty attach client) must be the one
    // that runs. A no-op handler here only stops THIS process from dying before the child does.
    const ignore = (): void => {};
    const forward = (sig: NodeJS.Signals) => (): void => {
      child.kill(sig);
    };
    const onInt = ignore;
    const onTerm = forward("SIGTERM");
    const onHup = forward("SIGHUP");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);

    const cleanup = (): void => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
    };

    child.once("error", (e) => {
      cleanup();
      reject(new Error(`paw: could not run ${exec}: ${e.message}`));
    });
    child.once("close", (code, signal) => {
      cleanup();
      // A signalled child has no exit code; report it the way a shell does.
      resolvePromise(signal ? 128 + signalNumber(signal) : (code ?? 1));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const n = (globalThis.process as unknown as { constants?: { signals?: Record<string, number> } }).constants?.signals?.[
    signal
  ];
  return typeof n === "number" ? n : 15;
}

const pawCommand: Command = {
  kind: "command",
  name: "paw",
  summary: "warm claude-code agents on the mesh, one per folder (paw)",
  usage: "cotal paw <verb> [args…]   ·   `cotal paw` alone lists paw's verbs",
  positionals: "<verb> [args…]",
  // Everything after `paw` belongs to paw's own dispatcher — cotal must not parse a single token
  // of it, or `cotal paw dm agent "--watch it burn"` would become a flag error.
  rawArgs: true,

  async run(args: ParsedArgs): Promise<void> {
    const argv = [...args.raw];
    if (argv.length === 0) {
      // Bare `cotal paw`: paw's own help IS the verb list, so print it rather than keeping a second
      // copy here that could drift. One line of framing, because paw prints `usage: paw <command>`.
      console.log("cotal paw <verb> [args…] — every verb below is paw's own, invoked as `cotal paw <verb>`:\n");
    }
    const code = await runPaw(argv);
    // paw already printed whatever it had to say (including its fail-loud line for an unknown verb).
    // Propagate the status without wrapping it in a second error message.
    if (code !== 0) process.exit(code);
  },
};

registry.register(pawCommand);

export { pawCommand };
