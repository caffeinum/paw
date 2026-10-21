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
import { registry, type Command } from "@cotal-ai/core";
import { existsSync } from "node:fs";
import {
  agentRecord,
  assertUnambiguousTarget,
  ensureAgentSpawned,
  folderForName,
  personaFilePath,
  psRowAlive,
  registerLivePeer,
  resolveAgentFolder,
  restartAgent,
  type PsRow,
} from "../addressing.ts";
import { withManagerControl } from "../control.ts";
import { awaitSpawnHeadroom } from "../pacing.ts";
import {
  RUNTIMES,
  type Runtime,
  actualManagerRuntime,
  agentSelfName,
  assertRuntimeUsable,
  ensure,
  finishDetachedRestart,
  managerProcs,
  readRuntimePreference,
  resolveSpace,
  restartLogPath,
  restartManager,
  spawnDetachedRestart,
  writeRuntimePreference,
} from "../lifecycle.ts";
import { KIT_AGENT } from "../kit.ts";
import { claudeProjectsRoot, kitSessionsRoot, readResumeId, transcriptExists } from "../session.ts";
import { pawServer } from "../server.ts";
import { applySwap, SWAP_AGENTS, type SwapRequest } from "../swap.ts";
import { assertManagerFeature, KIT_ARGS_FEATURE } from "../manager-features.ts";
import { resolveStopName } from "./stop.ts";

const tty = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: wrap("2"), bold: wrap("1"), green: wrap("32"), yellow: wrap("33") };

export type RestartArgs = { space?: string; runtime?: Runtime; agent?: string; swap?: SwapRequest };

/** Parse `[<runtime>] [--space s]`: at most one positional (the runtime), validated against RUNTIMES.
 *  `restart <agent>` also takes the harness swap: `--agent kit|claude`, `--model M`, and after `--`
 *  kit's own flags, kept verbatim (src/swap.ts). Pure; check:commands covers it. */
export function parseArgs(argv: string[], verb: string): RestartArgs {
  const out: RestartArgs = {};
  const end = argv.indexOf("--");
  const mine = end === -1 ? argv : argv.slice(0, end);
  let swapAgent: string | undefined;
  let model: string | undefined;
  const value = (i: number, flag: string) => {
    const v = mine[i];
    if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${flag} needs a value`);
    return v;
  };
  const usage = verb === "restart" ? `restart [<agent> [--agent kit|claude] [--model M] [-- <kit flags>] | <${RUNTIMES.join("|")}>] [--space s]` : `${verb} [<${RUNTIMES.join("|")}>] [--space s]`;
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    if (a === "--space") out.space = value(++i, "--space");
    else if (verb === "restart" && a === "--agent") swapAgent = value(++i, "--agent");
    else if (verb === "restart" && a === "--model") model = value(++i, "--model");
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${usage}`);
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
  const kitArgs = end === -1 ? undefined : argv.slice(end + 1);
  if (swapAgent === undefined) {
    if (model !== undefined) throw new Error("paw: restart --model needs --agent kit|claude — it is saved in the persona as part of the swap");
    if (kitArgs !== undefined) throw new Error("paw: `--` passes flags to kit — it needs --agent kit");
    return out;
  }
  if (out.agent === undefined)
    throw new Error(`paw: --agent swaps ONE agent's harness — name it: \`paw restart <agent> --agent ${swapAgent}\`${out.runtime ? ` ("${out.runtime}" is a runtime)` : ""}`);
  if (!(SWAP_AGENTS as readonly string[]).includes(swapAgent))
    throw new Error(`paw: restart --agent "${swapAgent}" — a restart swaps an agent between ${SWAP_AGENTS.join(" and ")}; any other harness is a persona edit`);
  if (kitArgs !== undefined && swapAgent !== KIT_AGENT)
    throw new Error(`paw: \`--\` passes flags to kit, and --agent ${swapAgent} is not kit — claude's own flags are \`paw claude <flags>\` (claudeArgs)`);
  out.swap = { agent: swapAgent, model, kitArgs };
  return out;
}

/** The names of agents live under the manager RIGHT NOW (reachable ps rows) — captured before a
 *  bounce so we can bring exactly them back, not the whole registry. Empty if the manager's down:
 *  with no manager the ps control request gets "no responders", which just means "nobody live to
 *  revive" — so `paw restart` from a cold state STARTS a manager rather than aborting here. */
async function liveAgentNames(space: string): Promise<string[]> {
  try {
    return await withManagerControl(space, pawServer(space), async (ctl) => {
      const ps = await ctl.ps();
      if (!ps.ok) return [];
      // A live agent paw never spawned (`cotal_spawn`) is registered from its ps row NOW, while its
      // process still names its session — after the bounce the manager forgets it and so would we.
      const live = ((ps.data as PsRow[]) ?? []).filter(psRowAlive);
      for (const row of live) registerLivePeer(space, row);
      return live.map((r) => r.name);
    });
  } catch {
    return [];
  }
}

/** Re-spawn `names` (from paw's folder→name registry) under the current manager — the "bring
 *  everyone back" step a manager restart otherwise leaves to a lazy `dm`/`chat`. Idempotent:
 *  ensureAgentSpawned reuses an already-live agent, so this is safe even when nothing bounced. A
 *  name with no folder (a live peer whose ps row carried no cwd) or a vanished folder is
 *  skipped — reported, never fabricated. Each agent resumes its pinned session, so it comes back warm. */
async function reviveAgents(space: string, names: string[]): Promise<{ revived: string[]; skipped: string[] }> {
  const revived: string[] = [];
  const skipped: string[] = [];
  if (!names.length) return { revived, skipped };
  await withManagerControl(space, pawServer(space), async (ctl) => {
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
  await ensure({ needMesh: true, needManager: true, space, switchRuntime: true });
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
  const { space: spaceArg, runtime: r, agent: target, swap } = parseArgs(argv, "restart");
  const space = spaceArg ?? resolveSpace();
  // `.` or a folder path names that folder's agent, as on stop/attach/log. A bare name stays a name (an
  // unregistered one goes to the manager as-is: a live `cotal_spawn` peer is restartable too).
  let agent: string | undefined;
  if (target !== undefined) {
    assertUnambiguousTarget(space, target);
    agent = resolveStopName(space, target);
  }

  // `paw restart <agent> --agent kit|claude …` — switch its harness in the persona FIRST (printed, with
  // the undo), then the plain restart below boots it on the new one. Done before ensure(): a refused
  // swap must not boot a manager, and the persona is the whole record, so the manager isn't needed.
  if (swap !== undefined) {
    if (!agentRecord(space, agent!))
      throw new Error(`paw: "${agent}" is not a registered agent in space ${space} — \`paw status --space ${space}\` lists them; a swap edits its persona`);
    // A manager older than kit swaps ignores `kitArgs:` and refuses a kit persona with no `provider:`
    // AFTER accepting the spawn, logging nothing: the agent was stopped and never came back while the
    // CLI sat in its readiness wait (ccswitch, 2026-10-20). Ask the manager's own code first; refuse
    // before the persona is touched.
    if (swap.agent.trim() === KIT_AGENT) assertManagerFeature(space, KIT_ARGS_FEATURE, `restart ${agent} --agent kit`);
    if (!applySwap(space, agent!, swap, (line) => console.log(line))) console.log(c.dim(`  restarting ${agent} anyway`));
  }

  // `paw restart <agent>` — bounce ONE agent, leaving the manager and every other agent alone. There
  // was no verb for this: `paw restart` means the MANAGER, and the only way to cycle a single agent was
  // `paw stop` followed by `paw chat`/`paw start`. It matters most right after a config change an agent
  // only reads at startup (a new MCP server, an edited persona), which is exactly when bouncing the
  // whole fleet would be the wrong tool.
  if (agent !== undefined) {
    // Unregistered AND no manager running → it can't be a live cotal peer either. Say so before
    // booting a manager just to find out (a typo used to start one).
    if (!agentRecord(space, agent) && managerProcs(space).length === 0) {
      throw new Error(`paw: "${agent}" is neither a runtime (${RUNTIMES.join(", ")}) nor a known agent — \`paw status\` lists the agents`);
    }
    await ensure({ needMesh: true, needManager: true, space });
    await withManagerControl(space, pawServer(space), async (ctl) => {
      const folder = await resolveAgentFolder(ctl, space, agent); // a live cotal_spawn peer counts too
      if (!folder)
        throw new Error(
          `paw: "${agent}" is neither a runtime (${RUNTIMES.join(", ")}) nor a known agent — \`paw status\` lists the agents`,
        );
      if (!existsSync(folder)) throw new Error(`paw: "${agent}" is registered at ${folder}, which no longer exists`);
      const pin = readResumeId(personaFilePath(space, agent));
      const warm = !!pin && transcriptExists(pin, [claudeProjectsRoot(), kitSessionsRoot()]);
      const res = await restartAgent(ctl, { space, name: agent, cwd: folder, progress: (line) => console.log(c.dim(`  ${line}`)) });
      console.log(
        res.starting
          ? `${c.yellow("…")} ${agent}'s process runs but it hasn't reached the mesh yet ${c.dim("— messages wait in its durable inbox; `paw status` shows when it's up")}`
          : res.restarted
          ? `${c.green("✓")} restarted ${agent} ${c.dim(warm ? "— it resumes its pinned session, so it keeps its context" : "— on a FRESH session (no transcript at its pin yet)")}`
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
  summary: "restart ONE agent (`restart <agent>`, `--agent kit|claude` swaps its harness), or force-restart the manager (optionally switching runtime)",
  usage: "restart [<agent> [--agent kit|claude] [--model M] [-- <kit flags>] | <pty|tmux|cmux>] [--space s]",
  run: (a) => restart([...a.raw]),
};

registry.register(runtimeCommand);
registry.register(restartCommand);
