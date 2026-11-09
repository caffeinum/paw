/**
 * `paw start --boot` — the login fleet job (`paw launchd`'s `dev.cotal.paw`): bring back every space this
 * machine hosts, not just the one baked into the plist (team2027 stayed down after the 2026-11-07 mini reboot
 * and the 2026-11-01 mac one — see src/boot-live.ts).
 *
 * Per space, who comes back:
 *  - the plist's own space (`--space`): the BAKED names (unchanged — what `paw launchd install` captured or was
 *    told) ∪ its live record;
 *  - every other space: its live record (`spaces/<s>/live.json`, what this machine's manager ran before the
 *    reboot) — nothing else. A space with no record starts NOTHING: never "everything registered" (the herd
 *    that took the machine down), said in the log with the command to start them by hand.
 * Then, per name: an agent recorded ASLEEP stays asleep (its stand-in wakes it on a DM); a teleported one is
 * skipped; on a REMOTE space the persona must be here and carry `machine:` = this machine's name on that space
 * (src/host-stamp.ts) — another machine's agent, or one with no stamp, is skipped and named, never guessed.
 *
 * Spaces run one after another, the plist's first. A space whose start throws (a remote broker that doesn't
 * answer, a manager that won't come up) is retried {@link BOOT_RETRY_DELAYS_MS}, each failure logged; after the
 * last it is reported loud with the exact `paw start … --space` to finish, the other spaces still run, and the
 * job exits non-zero. Never a silent skip.
 */
import { existsSync } from "node:fs";
import { personaFilePath } from "./addressing.ts";
import { readLiveRecord, restampLiveRecord, spaceDirs, type LiveRecord } from "./boot-live.ts";
import { machineName } from "./host-stamp.ts";
import { isRemoteSpace } from "./server.ts";
import { personaValue } from "./session.ts";
import { isAsleep } from "./sleep-state.ts";
import { readTeleported } from "./teleport-plan.ts";

/** Waits between attempts at one space: 6 tries over ~7.5 min, then it is reported down. */
export const BOOT_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 240_000];

export type Skip = { name: string; why: string };

export interface AgentFacts {
  remote: boolean;
  localMachine: string;
  personaHere: (name: string) => boolean;
  machineOf: (name: string) => string | undefined;
  asleep: (name: string) => boolean;
  teleportedTo: (name: string) => string | undefined;
}

/** Pure: who of `wanted` comes back in a space, and who doesn't (with why). */
export function planSpace(wanted: string[], f: AgentFacts): { start: string[]; skip: Skip[] } {
  const start: string[] = [];
  const skip: Skip[] = [];
  for (const name of [...new Set(wanted)]) {
    if (f.asleep(name)) {
      skip.push({ name, why: "asleep — stays asleep, a DM wakes it" });
      continue;
    }
    const to = f.teleportedTo(name);
    if (to) {
      skip.push({ name, why: `teleported to ${to}` });
      continue;
    }
    if (f.remote) {
      if (!f.personaHere(name)) {
        skip.push({ name, why: "no persona on this machine" });
        continue;
      }
      const m = f.machineOf(name);
      if (!m) {
        skip.push({ name, why: "its persona has no machine: stamp, so paw can't tell it is hosted here" });
        continue;
      }
      if (m !== f.localMachine) {
        skip.push({ name, why: `hosted on ${m}, not ${f.localMachine}` });
        continue;
      }
    }
    start.push(name);
  }
  return { start, skip };
}

/** The live facts for {@link planSpace}. */
export function agentFacts(space: string): AgentFacts {
  const persona = (n: string) => personaFilePath(space, n);
  return {
    remote: isRemoteSpace(space),
    localMachine: machineName(space),
    personaHere: (n) => existsSync(persona(n)),
    machineOf: (n) => (existsSync(persona(n)) ? personaValue(persona(n), "machine")?.replace(/^["']|["']$/g, "") || undefined : undefined),
    asleep: (n) => isAsleep(space, n),
    teleportedTo: (n) => readTeleported(persona(n))?.to,
  };
}

/** Pure: the names hosted here with no record to go by — for the log line, never started. */
export function hostedWithoutRecord(names: string[], f: Pick<AgentFacts, "remote" | "localMachine" | "machineOf">): string[] {
  return f.remote ? names.filter((n) => f.machineOf(n) === f.localMachine) : names;
}

/** What one space's start reported (the shape of src/start.ts startAgents). */
export interface StartResult {
  started: string[];
  alive: string[];
  skipped: string[];
  stuck: string[];
}

export interface BootDeps {
  spaces: () => string[];
  record: (space: string) => LiveRecord | undefined;
  facts: (space: string) => AgentFacts;
  /** Personas registered in a space (for the no-record line). */
  registered: (space: string) => string[];
  start: (space: string, names: string[]) => Promise<StartResult>;
  restamp: (space: string) => void;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  delays?: number[];
}

export interface SpaceOutcome {
  space: string;
  wanted: string[];
  result?: StartResult;
  skip: Skip[];
  error?: string;
}

/** One space, with the bounded retry. */
async function bootSpace(space: string, wanted: string[], d: BootDeps): Promise<SpaceOutcome> {
  const { start, skip } = planSpace(wanted, d.facts(space));
  for (const s of skip) d.log(`  ${space}: not starting ${s.name} — ${s.why}`);
  if (!start.length) {
    d.log(`  ${space}: nothing to bring back`);
    return { space, wanted, skip, result: { started: [], alive: [], skipped: [], stuck: [] } };
  }
  d.log(`  ${space}: bringing back ${start.join(", ")}`);
  const delays = d.delays ?? BOOT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return { space, wanted: start, skip, result: await d.start(space, start) };
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (attempt >= delays.length) {
        d.log(`✗ ${space}: gave up after ${attempt + 1} attempts — ${msg}`);
        return { space, wanted: start, skip, error: msg };
      }
      d.log(`  ${space}: attempt ${attempt + 1}/${delays.length + 1} failed — ${msg}; retrying in ${delays[attempt] / 1000}s`);
      await d.sleep(delays[attempt]);
    }
  }
}

/**
 * The whole boot. `primary` + `baked` come from the plist. Returns every space's outcome; throws at the end
 * when any space failed or left an agent stuck, after every space was tried.
 */
export async function runBoot(primary: string, baked: string[], d: BootDeps): Promise<SpaceOutcome[]> {
  const others = d.spaces().filter((s) => s !== primary);
  const outcomes: SpaceOutcome[] = [];
  for (const space of [primary, ...others]) {
    const rec = d.record(space);
    if (space !== primary && !rec) {
      const hosted = hostedWithoutRecord(d.registered(space), d.facts(space));
      if (hosted.length)
        d.log(`  ${space}: no live record (spaces/${space}/live.json) — not starting its ${hosted.length} agent(s) hosted here (${hosted.join(", ")}); the keeper writes one every 60s while its manager runs. By hand: paw start ${hosted.join(" ")} --space ${space}`);
      continue;
    }
    if (rec) d.log(`  ${space}: live before the reboot (recorded ${rec.at}): ${rec.names.join(", ") || "(nobody)"}`);
    const wanted = [...(space === primary ? baked : []), ...(rec?.names ?? [])];
    const o = await bootSpace(space, wanted, d);
    outcomes.push(o);
    if (rec) d.restamp(space);
  }
  const failed = outcomes.filter((o) => o.error);
  const stuck = outcomes.flatMap((o) => (o.result?.stuck ?? []).map((s) => `${o.space}: ${s}`));
  if (failed.length || stuck.length) {
    const lines = [
      ...failed.map((o) => `${o.space}: did not come up (${o.error}) — NOT started: ${o.wanted.join(", ")}; once it answers: paw start ${o.wanted.join(" ")} --space ${o.space}`),
      ...stuck,
    ];
    throw new Error(`paw start --boot — ${failed.length} space(s) down, ${stuck.length} agent(s) stuck:\n  ${lines.join("\n  ")}`);
  }
  return outcomes;
}

export const realBootDeps = (start: BootDeps["start"], registered: BootDeps["registered"]): BootDeps => ({
  spaces: spaceDirs,
  record: readLiveRecord,
  facts: agentFacts,
  registered,
  start,
  restamp: (s) => restampLiveRecord(s),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (l) => console.log(l),
});
