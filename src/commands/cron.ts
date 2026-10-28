/**
 * `paw cron` — durable scheduled wake-ups for agents, a cron any agent can call from Bash:
 *
 *   paw cron add [<agent>[#space]] "<m h dom mon dow>" "<prompt>"   recurring, local time
 *   paw cron add [<agent>[#space]] "<cron>" "<prompt>" --once        next match only, then deleted
 *   paw cron add [<agent>[#space]] --in 20m|--at 09:30 "<prompt>"    one-shot, then deleted
 *   paw cron ls [--all]  ·  paw cron rm <id>  ·  paw cron tick
 *
 * The agent defaults to the caller (COTAL_NAME, which cotal stamps into every agent's tools). A fire is
 * ONLY a message: the prompt is DM'd to the agent as "you" through the same path as `paw dm`
 * (src/dm.ts sendAsYou), so a stopped or sleeping registered agent wakes the way a DM wakes it, and
 * nothing ever restarts, stops or interrupts a live one. Firing rides the global keeper's 60s tick
 * (`paw global`, src/global.ts), which runs `cronSweep` over every space with a store; `paw cron tick`
 * runs the same sweep by hand. Jobs only fire for agents this machine hosts (src/hosted.ts).
 */
import { existsSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { folderForName, personaFilePath } from "../addressing.ts";
import {
  claimDue,
  CRON_BOOL_FLAGS,
  CRON_VALUE_FLAGS,
  cronAddHasAgent,
  fireText,
  newJobId,
  nextDue,
  nextFire,
  parseAt,
  parseCron,
  parseIn,
  readStore,
  scheduleLabel,
  settle,
  spacesWithCron,
  updateStore,
  type CronJob,
} from "../cron.ts";
import { runsElsewhere } from "../hosted.ts";
import { resolveSpace } from "../space.ts";

const USAGE =
  'cron add [<agent>[#space]] "<m h dom mon dow>" "<prompt>" [--once] · cron add [<agent>] --in 20m|--at HH:MM "<prompt>" · cron ls [--all] · cron rm <id> · cron tick   [--space s]';

export interface CronArgs {
  sub?: string;
  positionals: string[];
  space?: string;
  in?: string;
  at?: string;
  once: boolean;
  all: boolean;
}

export function parseCronArgs(argv: string[]): CronArgs {
  const out: CronArgs = { positionals: [], once: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (CRON_VALUE_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`paw cron: ${a} needs a value — ${USAGE}`);
      if (a === "--space") out.space = v;
      else if (a === "--in") out.in = v;
      else if (a === "--at") out.at = v;
    } else if (CRON_BOOL_FLAGS.includes(a)) {
      if (a === "--once") out.once = true;
      else out.all = true;
    } else if (a.startsWith("--")) throw new Error(`paw cron: unknown flag "${a}" — ${USAGE}`);
    else out.positionals.push(a);
  }
  out.sub = out.positionals.shift();
  return out;
}

/** Why `agent` can't be scheduled from this machine in `space`, or undefined when it can. */
export function unfireable(space: string, agent: string): string | undefined {
  if (!folderForName(space, agent)) return `"${agent}" is not a registered agent in space "${space}" (\`paw status\` lists them)`;
  const away = runsElsewhere(space, agent);
  if (away) return `"${agent}" runs on ${away.where} — schedule it there`;
  if (!existsSync(personaFilePath(space, agent))) return `"${agent}" has no persona in space "${space}" on this machine`;
  return undefined;
}

/** The job an `add` describes. Pure apart from `now`; `self` is the calling agent (COTAL_NAME). */
export function buildJob(a: CronArgs, o: { space: string; self?: string; now: number; id: string }): CronJob {
  const timed = a.in !== undefined || a.at !== undefined;
  if (a.in !== undefined && a.at !== undefined) throw new Error("paw cron: give --in OR --at, not both");
  if (timed && a.once) throw new Error("paw cron: --once is for a cron expression; --in/--at are already one-shots");
  const rest = [...a.positionals];
  const named = cronAddHasAgent(rest.length, timed);
  if (!named && rest.length !== (timed ? 1 : 2)) throw new Error(`paw cron: wrong arguments for add — ${USAGE}`);
  const agentArg = named ? rest.shift()!.replace(/^@/, "") : undefined;
  const agent = agentArg ?? o.self;
  if (!agent) throw new Error('paw cron: no agent given and not run from inside an agent — `paw cron add <agent> "<cron>" "<prompt>"`');
  const prompt = rest.pop()!.trim();
  if (!prompt) throw new Error("paw cron: empty prompt");
  const base = { id: o.id, agent, prompt, createdAt: o.now, createdBy: o.self ?? "operator" };
  if (a.in !== undefined) return { ...base, at: o.now + parseIn(a.in) };
  if (a.at !== undefined) return { ...base, at: parseAt(a.at, o.now) };
  const expr = rest[0].trim().replace(/\s+/g, " ");
  parseCron(expr);
  const first = nextFire(expr, o.now); // fails loud on an expression that never fires
  return a.once ? { ...base, at: first } : { ...base, cron: expr };
}

/** The calling agent's name, when `paw cron` runs inside an agent of `space`. */
function selfIn(space: string): string | undefined {
  const name = process.env.COTAL_NAME?.trim();
  if (!name) return undefined;
  const s = process.env.COTAL_SPACE?.trim();
  return !s || s === space ? name : undefined;
}

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function add(a: CronArgs, space: string): void {
  const now = Date.now();
  const job = buildJob(a, { space, self: selfIn(space), now, id: newJobId() });
  const why = unfireable(space, job.agent);
  if (why) throw new Error(`paw cron: ${why}`);
  updateStore(space, (s) => void s.jobs.push(job));
  console.log(`✓ cron ${job.id} → ${job.agent}: ${scheduleLabel(job)} — next ${fmt(nextDue(job))}`);
}

export function formatJobs(jobs: Array<CronJob & { space?: string }>, now: number): string {
  if (!jobs.length) return "no cron jobs";
  return jobs
    .map((j) => {
      const next = (() => {
        try {
          const t = nextDue(j);
          return t <= now ? "due now" : fmt(t);
        } catch (e) {
          return `✕ ${(e as Error).message}`;
        }
      })();
      const where = j.space ? `${j.agent}#${j.space}` : j.agent;
      const err = j.lastError ? `\n    ⚠ last fire failed: ${j.lastError}` : "";
      return `${j.id}  ${where}  ${scheduleLabel(j)}  next ${next}  (by ${j.createdBy})\n    ${j.prompt}${err}`;
    })
    .join("\n");
}

function ls(a: CronArgs, space: string): void {
  const spaces = a.all ? spacesWithCron() : [space];
  const jobs = spaces.flatMap((s) => readStore(s).jobs.map((j) => (a.all ? { ...j, space: s } : j)));
  console.log(formatJobs(jobs, Date.now()));
}

function rm(a: CronArgs, space: string): void {
  const id = a.positionals[0];
  if (!id || a.positionals.length > 1) throw new Error(`paw cron: rm takes one job id — ${USAGE}`);
  const gone = updateStore(space, (s) => {
    const i = s.jobs.findIndex((j) => j.id === id);
    return i < 0 ? undefined : s.jobs.splice(i, 1)[0];
  });
  if (!gone) throw new Error(`paw cron: no job "${id}" in space "${space}" (\`paw cron ls --all\`)`);
  console.log(`✓ removed cron ${id} (${gone.agent}: ${scheduleLabel(gone)})`);
}

/**
 * Fire every due job in every space with a store. A fire is a DM — nothing else. Due jobs are claimed
 * under the store lock first (so overlapping ticks can't double-fire, and a recurring job's missed
 * occurrences collapse into one), then delivered outside the lock, then settled. Every fire and every
 * failure is a log line; a failure never stops the sweep.
 */
export async function cronSweep(now = Date.now(), log: (line: string) => void = (l) => console.error(l)): Promise<{ fired: string[]; failed: string[] }> {
  const fired: string[] = [];
  const failed: string[] = [];
  for (const space of spacesWithCron()) {
    let claimed: CronJob[];
    try {
      claimed = updateStore(space, (s) => claimDue(s, now));
    } catch (e) {
      log(`paw cron: space ${space}: ${(e as Error).message}`);
      continue;
    }
    if (!claimed.length) continue;
    const { ensure } = await import("../lifecycle.ts");
    const { sendAsYou } = await import("../dm.ts");
    const { pawServer } = await import("../server.ts");
    let meshUp: string | undefined;
    for (const job of claimed) {
      let error = unfireable(space, job.agent);
      if (!error && meshUp === undefined) {
        try {
          await ensure({ needMesh: true, needManager: true, space });
          meshUp = "";
        } catch (e) {
          meshUp = `mesh/manager for "${space}" not up: ${(e as Error).message}`;
        }
      }
      if (!error && meshUp) error = meshUp;
      if (!error) {
        try {
          await sendAsYou({ space, server: pawServer(space), target: job.agent, text: fireText(job), byName: true });
        } catch (e) {
          error = (e as Error).message;
        }
      }
      const outcome = updateStore(space, (s) => settle(s, job.id, error));
      const tag = `${job.id} → ${job.agent}#${space}`;
      if (error) {
        failed.push(job.id);
        log(`paw cron: ${tag} NOT delivered (${outcome === "dropped" ? "one-shot dropped after retries" : outcome === "kept" && job.at !== undefined ? "will retry" : "next occurrence still scheduled"}): ${error}`);
      } else {
        fired.push(job.id);
        log(`paw cron: fired ${tag}${outcome === "removed" ? " (one-shot, removed)" : ""}`);
      }
    }
  }
  return { fired, failed };
}

async function cron(argv: string[]): Promise<void> {
  const a = parseCronArgs(argv);
  const space = a.space ?? resolveSpace();
  switch (a.sub) {
    case "add":
      return add(a, space);
    case "ls":
    case "list":
      return ls(a, space);
    case "rm":
    case "delete":
      return rm(a, space);
    case "tick": {
      const r = await cronSweep(Date.now(), (l) => console.log(l));
      if (!r.fired.length && !r.failed.length) console.log("nothing due");
      if (r.failed.length) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`paw cron: ${a.sub ? `unknown subcommand "${a.sub}"` : "missing subcommand"} — ${USAGE}`);
  }
}

const cronCommand: Command = {
  kind: "command",
  name: "cron",
  group: "Mesh",
  summary: "schedule wake-ups for an agent (recurring cron or one-shot) — a fire DMs it the prompt",
  usage: USAGE,
  run: (a) => cron([...a.raw]),
};

registry.register(cronCommand);
