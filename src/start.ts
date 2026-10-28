/**
 * `paw start [<name>…]` — COLD-START the fleet: bring up mesh + manager, then spawn every REGISTERED
 * agent (every persona with a folder), each resuming its pinned session (warm). The
 * missing "bring the whole fleet up from cold" verb.
 *
 * Why it's distinct from `paw restart`: restart bounces the manager and revives only the agents that were
 * LIVE (captured from `ps`), so after a reboot / `paw down` there's nothing live to revive and it brings
 * nobody back. `paw start` sources from the REGISTRY (`listAgents`), so it works from truly cold — exactly
 * the "after a restart I can't see or poke my agents" case (see issue #10). `paw start <name…>` starts
 * just those. Idempotent: an already-live agent is reported, not re-spawned. Vanished folders and spawn
 * failures (e.g. the two-writer guard) are reported per-agent, never fatal to the rest.
 */
import { existsSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { elsewhereHint, ensureAgentSpawned, folderForName, listAgents, psRowAlive, stuckWarning, type PsRow } from "./addressing.ts";
import { resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { awaitSpawnHeadroom } from "./pacing.ts";

function parseArgs(argv: string[]): { space?: string; names: string[] } {
  const out: { space?: string; names: string[] } = { names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — start [<name>…] [--space <s>]`);
    else out.names.push(a);
  }
  return out;
}

/** The skip line for a name with no registration here — naming the other local space that holds it. */
export function notRegisteredSkip(space: string, name: string): string {
  const hint = elsewhereHint(space, name);
  return hint ? `${name} (not registered in "${space}"${hint})` : `${name} (not registered)`;
}

async function start(argv: string[]): Promise<void> {
  const { space: spaceArg, names } = parseArgs(argv);
  const space = spaceArg ?? resolveSpace();

  // Resolve the target set: the named agents, or the WHOLE registry. Names are persona filenames, so
  // listAgents needs no dedup; a named target that isn't registered resolves to no folder and is
  // reported (never fabricated).
  const targets = names.length ? names.map((name) => ({ name, folder: folderForName(space, name) })) : listAgents(space);

  if (!targets.length) {
    console.log("paw: no agents registered to start (`paw chat --fresh <folder>` to make one)");
    return;
  }

  const started: string[] = [];
  const alive: string[] = [];
  const skipped: string[] = [];
  const stuck: string[] = [];

  await withEnsuredManager(space, async (ctl) => {
    // One ps read up front so we can report "already live" vs "started" without a spawn round-trip each.
    const ps = await ctl.ps();
    const live = new Set(ps.ok ? ((ps.data as PsRow[]) ?? []).filter(psRowAlive).map((r) => r.name) : []);
    for (const t of targets) {
      if (live.has(t.name)) {
        alive.push(t.name); // live is live, whether or not paw spawned it (a cotal_spawn peer)
        continue;
      }
      if (!t.folder) {
        skipped.push(notRegisteredSkip(space, t.name));
        continue;
      }
      if (!existsSync(t.folder)) {
        skipped.push(`${t.name} (folder gone: ${t.folder})`);
        continue;
      }
      // Anti-thundering-herd: never start a cold-boot burst into a machine with no headroom
      // (the 2026-08-21 swap-death revival — see src/pacing.ts). Bounded, then proceeds anyway.
      const headroom = await awaitSpawnHeadroom({
        onWait: (load, thr) => console.log(`  load ${load.toFixed(0)} > ${thr} — pausing before spawning ${t.name} until the machine has headroom…`),
      });
      if (headroom === "gave-up") console.log(`  still loaded after the wait cap — spawning ${t.name} anyway`);
      try {
        const r = await ensureAgentSpawned(ctl, { space, name: t.name, cwd: t.folder });
        if (r.stuck) {
          stuck.push(stuckWarning(t.name, r.stuck, false));
          continue;
        }
        started.push(r.starting ? `${t.name} (still starting — messages wait in its inbox)` : t.name);
      } catch (e) {
        skipped.push(`${t.name} (${(e as Error).message.split("\n")[0]})`);
      }
    }
  });

  console.log(`✓ paw start — ${started.length} started, ${alive.length} already live, ${skipped.length} skipped`);
  if (started.length) console.log(`  started:      ${started.join(", ")}`);
  if (alive.length) console.log(`  already live: ${alive.join(", ")}`);
  if (skipped.length) console.log(`  skipped:      ${skipped.join(" · ")}`);
  // Nothing to queue a message into here: a stuck seat is a failed start, said loud with a non-zero exit.
  if (stuck.length) throw new Error(`paw start — ${stuck.length} stuck:\n  ${stuck.join("\n  ")}`);
}

const startCommand: Command = {
  kind: "command",
  name: "start",
  group: "Lifecycle",
  summary: "cold-start the fleet — spawn every registered agent (or the named ones), each resuming its session",
  usage: "start [<name>…] [--space <s>]   (from truly cold; use `paw restart` to bounce the manager)",
  run: (a) => start([...a.raw]),
};

registry.register(startCommand);
