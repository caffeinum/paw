/**
 * `paw runtime [<pty|tmux|cmux>]` + `paw restart [<pty|tmux|cmux>]` — make the manager runtime an
 * explicit, discoverable surface instead of the hidden `PAW_RUNTIME` env var.
 *
 *   paw runtime            — LOCAL: show the sticky preference + the last-started runtime marker.
 *   paw runtime <r>        — set the sticky preference, then ensure() (restarts the manager on a switch).
 *   paw restart [<r>]      — force-bounce the paw-owned manager (optionally set the preference first).
 *
 * These self-ensure AFTER writing the preference, so they're deliberately OUT of bin/paw.ts's
 * NEEDS_MANAGER/NEEDS_MESH gating — pre-ensuring would boot the manager under the STALE runtime and
 * defeat the switch. `paw runtime` (no arg) is a pure local read; it needs no mesh at all.
 */
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import { existsSync } from "node:fs";
import {
  ensureAgentSpawned,
  folderForName,
  psRowAlive,
  restartAgent,
  type PsRow,
} from "../addressing.js";
import { withManagerControl } from "../control.js";
import { awaitSpawnHeadroom } from "../pacing.js";
import {
  RUNTIMES,
  type Runtime,
  actualManagerRuntime,
  agentSelfName,
  assertRuntimeUsable,
  ensure,
  finishDetachedRestart,
  readRuntimePreference,
  resolveSpace,
  restartLogPath,
  restartManager,
  spawnDetachedRestart,
  writeRuntimePreference,
} from "../lifecycle.js";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), green: wrap("32"), yellow: wrap("33") };

/** Parse `[<runtime>] [--space s]`: at most one positional (the runtime), validated against RUNTIMES. */
function parseArgs(argv: string[], verb: string): { space?: string; runtime?: Runtime; agent?: string } {
  const out: { space?: string; runtime?: Runtime; agent?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${verb} [<${RUNTIMES.join("|")}>] [--space s]`);
    else {
      if (out.runtime !== undefined || out.agent !== undefined)
        throw new Error(`paw: ${verb} takes a single target — got "${out.runtime ?? out.agent}" and "${a}"`);
      if ((RUNTIMES as readonly string[]).includes(a)) out.runtime = a as Runtime;
      // `paw restart <agent>` bounces ONE agent; `paw restart <runtime>` bounces the manager. The two
      // sets are disjoint and tiny, so the word itself says which is meant — and an agent that happens
      // to be NAMED `tmux` is caught by the runtime branch above and reported by the caller, never
      // silently restarted as the wrong thing.
      else if (verb === "restart") out.agent = a;
      else throw new Error(`paw: "${a}" is not a runtime — expected ${RUNTIMES.join(", ")}`);
    }
  }
  return out;
}

/** The names of agents live under the manager RIGHT NOW (reachable ps rows) — captured before a
 *  bounce so we can bring exactly them back, not the whole registry. Empty if the manager's down:
 *  with no manager the ps control request gets "no responders", which just means "nobody live to
 *  revive" — so `paw restart` from a cold state STARTS a manager rather than aborting here. */
async function liveAgentNames(space: string): Promise<string[]> {
  try {
    return await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
      const ps = await ctl.ps();
      if (!ps.ok) return [];
      return ((ps.data as PsRow[]) ?? []).filter(psRowAlive).map((r) => r.name);
    });
  } catch {
    return [];
  }
}

/** Re-spawn `names` (from paw's folder→name registry) under the current manager — the "bring
 *  everyone back" step a manager restart otherwise leaves to a lazy `dm`/`chat`. Idempotent:
 *  ensureAgentSpawned reuses an already-live agent, so this is safe even when nothing bounced. A
 *  name with no folder mapping (registry-less, e.g. a raw `cotal start`) or a vanished folder is
 *  skipped — reported, never fabricated. Each agent resumes its pinned session, so it comes back warm. */
async function reviveAgents(space: string, names: string[]): Promise<{ revived: string[]; skipped: string[] }> {
  const revived: string[] = [];
  const skipped: string[] = [];
  if (!names.length) return { revived, skipped };
  await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
    for (const name of names) {
      const folder = folderForName(space, name);
      if (!folder || !existsSync(folder)) {
        skipped.push(name);
        continue;
      }
      // Anti-thundering-herd: a revival after a load-induced lease loss must not deepen the
      // starvation that caused it. Bounded — after the cap the spawn proceeds regardless.
      const headroom = await awaitSpawnHeadroom({
        onWait: (load, thr) => console.log(c.dim(`  load ${load.toFixed(0)} > ${thr} — pausing revival until the machine has headroom…`)),
      });
      if (headroom === "gave-up") console.log(c.dim(`  still loaded after the wait cap — spawning ${name} anyway`));
      try {
        await ensureAgentSpawned(ctl, { space, name, cwd: folder });
        revived.push(name);
      } catch {
        skipped.push(name); // a spawn failure (e.g. two-writer guard) — reported, not fatal to the rest
      }
    }
  });
  return { revived, skipped };
}

/** One line summarising a revive pass, or nothing when there was nobody to bring back. */
function reportRevival(before: string[], revived: string[], skipped: string[]): void {
  if (!before.length) return;
  const tail = skipped.length ? c.dim(` (skipped: ${skipped.join(", ")})`) : "";
  console.log(c.dim(`  brought back ${revived.length}/${before.length} agent(s)${tail}`));
}

/** `paw runtime` (no arg): the preference + what the manager is ACTUALLY running (live process
 *  cmdline, never the spawn-time marker — a stale marker is exactly the drift this must expose). */
function show(space: string): void {
  const pref = readRuntimePreference(space);
  const actual = actualManagerRuntime(space);
  console.log(`preferred: ${pref ? c.bold(pref) : c.dim("pty (default)")}`);
  console.log(`running:   ${actual ? c.bold(actual) : c.dim("none — no paw-owned manager alive")}`);
  if (actual !== undefined && (pref ?? "pty") !== actual) {
    console.log(c.yellow(`  drift: preferred ${pref ?? "pty"} ≠ running ${actual} — run \`paw runtime ${pref ?? "pty"}\` (or \`paw restart\`) to apply`));
  }
}

async function runtime(argv: string[]): Promise<void> {
  const { space: spaceArg, runtime: r } = parseArgs(argv, "runtime");
  const space = spaceArg ?? resolveSpace();
  if (r === undefined) {
    show(space);
    return;
  }
  assertRuntimeUsable(r); // refuse cmux-without-a-surface BEFORE writing the preference or bouncing the manager
  const before = actualManagerRuntime(space); // live-process truth — a stale marker must not fake "already running"
  const liveBefore = await liveAgentNames(space); // capture who's up so a switch brings them back
  writeRuntimePreference(space, r);
  // ensure() resolves the NEW preference; ensureManagerUp restarts on a mismatch (with the rollback net).
  await ensure({ needMesh: true, needManager: true, space });
  console.log(c.green(`✓ runtime set to ${r}`));
  if (before === r) console.log(c.dim(`  manager already running ${r} — no restart`));
  else if (before === undefined) console.log(c.dim(`  manager started (${r})`));
  else console.log(c.dim(`  manager restarted ${before} → ${r}`));
  // A switch bounced the manager and dropped its agents — bring the previously-live ones back (in the
  // NEW runtime). No-op when nothing bounced (ensureAgentSpawned reuses live agents).
  const { revived, skipped } = await reviveAgents(space, liveBefore);
  reportRevival(liveBefore, revived, skipped);
}

async function restart(argv: string[]): Promise<void> {
  const { space: spaceArg, runtime: r, agent } = parseArgs(argv, "restart");
  const space = spaceArg ?? resolveSpace();

  // `paw restart <agent>` — bounce ONE agent, leaving the manager and every other agent alone. There
  // was no verb for this: `paw restart` means the MANAGER, and the only way to cycle a single agent was
  // `paw stop` followed by `paw chat`/`paw start`. It matters most right after a config change an agent
  // only reads at startup (a new MCP server, an edited persona), which is exactly when bouncing the
  // whole fleet would be the wrong tool.
  if (agent !== undefined) {
    const folder = folderForName(space, agent);
    if (!folder)
      throw new Error(
        `paw: "${agent}" is neither a runtime (${RUNTIMES.join(", ")}) nor a registered agent — \`paw status\` lists the agents`,
      );
    if (!existsSync(folder)) throw new Error(`paw: "${agent}" is registered at ${folder}, which no longer exists`);
    await ensure({ needMesh: true, needManager: true, space });
    await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
      const res = await restartAgent(ctl, { space, name: agent, cwd: folder });
      console.log(
        res.restarted
          ? `${c.green("✓")} restarted ${agent} ${c.dim("— it resumes its pinned session, so it keeps its context")}`
          : `${c.green("✓")} started ${agent} ${c.dim("(it wasn't running)")}`,
      );
    });
    return;
  }
  const detachedChild = process.env.PAW_WAKE_AGENT !== undefined; // set only on the detached child we spawn
  const selfAgent = detachedChild ? undefined : agentSelfName(space);

  // Run from INSIDE the agent this bounce will kill (COTAL_NAME set) → the synchronous path can't finish
  // (revive kills its own caller mid-command → half-restart / stacked managers, 2026-07-13). Hand off to
  // a detached child that outlives us, completes the bounce+revive, and wakes us back into a turn. The
  // child has COTAL_* stripped, so it isn't seen as an agent and falls through to the synchronous path.
  if (selfAgent) {
    if (r !== undefined) {
      assertRuntimeUsable(r); // fail loud NOW (synchronously) if the runtime is unusable — before detaching
      writeRuntimePreference(space, r);
    }
    const launched = spawnDetachedRestart(space, r, selfAgent);
    console.log(
      launched
        ? c.green("⟳ restarting detached") +
            c.dim(` — bouncing the manager, reviving, and resuming ${selfAgent}; progress in ${restartLogPath(space)}`)
        : c.yellow("⟳ a restart is already in flight — not stacking another"),
    );
    return;
  }

  if (r !== undefined) {
    assertRuntimeUsable(r); // refuse cmux-without-a-surface before writing the preference / bouncing
    writeRuntimePreference(space, r);
  }
  const liveBefore = await liveAgentNames(space); // capture who's up so the bounce brings them back
  await restartManager({ space });
  const now = actualManagerRuntime(space) ?? readRuntimePreference(space) ?? "pty";
  console.log(c.green(`✓ manager restarted (${now})`));
  // The bounce dropped every agent — re-spawn the ones that were live (each resumes its session), so
  // `paw restart` brings everyone back without a manual `dm`/`chat` probe.
  const { revived, skipped } = await reviveAgents(space, liveBefore);
  reportRevival(liveBefore, revived, skipped);

  // If WE are the detached child, the bounce + revive are done — wake the agent that launched us so it
  // resumes its task (a respawned session is idle until it gets a turn), then clear the in-flight pidfile.
  if (detachedChild) finishDetachedRestart(space, process.env.PAW_WAKE_AGENT!);
}

const runtimeCommand: Command = {
  kind: "command",
  name: "runtime",
  group: "Lifecycle",
  summary: "show or set the manager runtime (pty/tmux/cmux) — a sticky per-space preference",
  usage: "runtime [<pty|tmux|cmux>] [--space s]",
  run: (a) => runtime([...a.raw]),
};

const restartCommand: Command = {
  kind: "command",
  name: "restart",
  group: "Lifecycle",
  summary: "restart ONE agent (`restart <agent>`), or force-restart the manager (optionally switching runtime)",
  usage: "restart [<agent>|<pty|tmux|cmux>] [--space s]",
  run: (a) => restart([...a.raw]),
};

registry.register(runtimeCommand);
registry.register(restartCommand);
