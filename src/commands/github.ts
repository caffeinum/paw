/**
 * `paw github` — which pull requests an agent follows (src/github-relay.ts):
 *
 *   paw github watch <pr> [<agent>]     follow a PR: its comments, reviews, CI and merge arrive as DMs from "github"
 *   paw github unwatch <pr> [<agent>]   stop: drops a watch, or mutes a PR followed by branch or author
 *   paw github ls                       what this machine follows, for whom and why, and what waits to be sent
 *   paw github tick                     one sweep now (the global keeper runs one every 60s)
 *
 * `<pr>` is the PR's URL, `owner/repo#N`, or `#N` inside the repo. The agent defaults to the caller
 * (COTAL_NAME, which cotal stamps into every agent's tools); `<agent>#<space>` names another space.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import {
  ghGraphql,
  githubSweep,
  GITHUB_SENDER,
  discoveryQuery,
  folderCheckout,
  parsePrRef,
  readDiscovery,
  readStore,
  updateStore,
  type SweepDeps,
} from "../github-relay.ts";
import { unfireable } from "./cron.ts";
import { callerSpace } from "../space.ts";

const USAGE = "github watch <pr> [<agent>[#space]] · github unwatch <pr> [<agent>[#space]] · github ls · github tick   (<pr> = URL, owner/repo#N, or #N in the repo)";

interface Args {
  sub?: string;
  positionals: string[];
  space?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--space") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`paw github: --space needs a value — ${USAGE}`);
      out.space = v;
    } else if (a.startsWith("--")) throw new Error(`paw github: unknown flag "${a}" — ${USAGE}`);
    else out.positionals.push(a);
  }
  out.sub = out.positionals.shift();
  return out;
}

/** The agent and space a watch/unwatch is for: `<agent>[#space]`, else the calling agent. */
function whoFor(arg: string | undefined, space: string): { agent: string; space: string } {
  if (arg !== undefined) {
    const [agent, s] = arg.replace(/^@/, "").split("#") as [string, string | undefined];
    if (!agent) throw new Error(`paw github: empty agent name — ${USAGE}`);
    return { agent, space: s || space };
  }
  const self = process.env.COTAL_NAME?.trim();
  const selfSpace = process.env.COTAL_SPACE?.trim();
  if (!self || (selfSpace && selfSpace !== space)) throw new Error(`paw github: no agent given and not run from inside an agent of space "${space}" — \`paw github watch <pr> <agent>\``);
  return { agent: self, space };
}

/** The `gh` binary on the daemon PATH (launchd's PATH is bare), or a loud error. */
export function findGh(env: NodeJS.ProcessEnv): string {
  const pinned = process.env.PAW_GH_BIN?.trim();
  if (pinned) return pinned;
  const hit = (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "gh")).find((p) => existsSync(p));
  if (!hit) throw new Error("no `gh` on PATH (nor PAW_GH_BIN): GitHub PR activity is NOT relayed — install gh and `gh auth login`");
  return hit;
}

async function liveGh() {
  const { daemonEnv } = await import("../lifecycle.ts");
  const env = daemonEnv();
  return ghGraphql(env, findGh(env));
}

async function watch(a: Args, space: string): Promise<void> {
  const [ref, agentArg, extra] = a.positionals;
  if (!ref || extra !== undefined) throw new Error(`paw github: watch takes a PR and an optional agent — ${USAGE}`);
  const pr = parsePrRef(ref, folderCheckout(process.cwd())?.repo);
  const who = whoFor(agentArg, space);
  const why = unfireable(who.space, who.agent);
  if (why) throw new Error(`paw github: ${why.replace(/scheduled there/g, "followed there").replace(/schedule it there/g, "watch it there")}`);
  const d = { checkouts: [], logins: [], known: [pr] };
  const found = readDiscovery(d, await (await liveGh())(discoveryQuery(d)));
  const light = found.known.get(pr);
  if (!light) throw new Error(`paw github: GitHub has no PR ${pr} this account can read${found.errors.length ? ` (${found.errors.join("; ")})` : ""}`);
  if (light.state !== "OPEN") throw new Error(`paw github: ${pr} is ${light.state.toLowerCase()} — nothing more will happen on it`);
  const added = updateStore((s) => {
    s.mutes = s.mutes.filter((m) => !(m.space === who.space && m.agent === who.agent && m.pr === pr));
    if (s.watches.some((w) => w.space === who.space && w.agent === who.agent && w.pr === pr)) return false;
    s.watches.push({ space: who.space, agent: who.agent, pr, by: process.env.COTAL_NAME?.trim() || "operator", at: Date.now() });
    return true;
  });
  console.log(
    `${added ? "✓" : "✓ already"} ${who.agent}#${who.space} follows ${pr} "${light.title}" — comments, reviews, CI results and the merge arrive as DMs from "${GITHUB_SENDER}" (from the next keeper tick; what is already there is not sent)`,
  );
}

function unwatch(a: Args, space: string): void {
  const [ref, agentArg, extra] = a.positionals;
  if (!ref || extra !== undefined) throw new Error(`paw github: unwatch takes a PR and an optional agent — ${USAGE}`);
  const pr = parsePrRef(ref, folderCheckout(process.cwd())?.repo);
  const who = whoFor(agentArg, space);
  const same = (f: { space: string; agent: string; pr: string }) => f.space === who.space && f.agent === who.agent && f.pr === pr;
  const r = updateStore((s) => {
    const watched = s.watches.some(same);
    s.watches = s.watches.filter((w) => !same(w));
    const auto = s.prs[pr]?.subs.find((x) => same(x) && x.why !== "watch");
    // A watch alone just ends; a PR followed by branch or author (or not yet followed) needs a mute.
    if ((auto || !watched) && !s.mutes.some(same)) s.mutes.push({ space: who.space, agent: who.agent, pr });
    return { watched, auto: auto?.why };
  });
  const how = r.auto ? ` (it followed it by ${r.auto === "branch" ? "its checked-out branch" : "author"}: muted)` : r.watched ? "" : " (it did not follow it yet: muted, so it won't)";
  console.log(`✓ ${who.agent}#${who.space} no longer follows ${pr}${how}`);
}

function ls(): void {
  const s = readStore();
  const prs = Object.entries(s.prs);
  if (!prs.length && !s.watches.length) console.log("no PRs followed on this machine");
  const muted = (x: { space: string; agent: string; pr: string }) => s.mutes.some((m) => m.space === x.space && m.agent === x.agent && m.pr === x.pr);
  const dropped = (x: { space: string; agent: string; pr: string; why: string }) => x.why === "watch" && !s.watches.some((w) => w.space === x.space && w.agent === x.agent && w.pr === x.pr);
  for (const [key, st] of prs) {
    const subs = st.subs.filter((x) => !muted(x) && !dropped(x));
    console.log(`${key}  "${st.title}"\n    ${subs.length ? subs.map((x) => `${x.agent}#${x.space} (${x.why})`).join(", ") : "nobody any more (dropped at the next keeper tick)"}`);
  }
  const waiting = s.watches.filter((w) => !s.prs[w.pr]?.subs.some((x) => x.space === w.space && x.agent === w.agent));
  for (const w of waiting) console.log(`${w.pr}  watch by ${w.agent}#${w.space}, not followed yet (next keeper tick)`);
  for (const m of s.mutes) console.log(`muted: ${m.pr} for ${m.agent}#${m.space}`);
  for (const o of s.outbox) console.log(`waiting to send: ${o.pr} → ${o.agent}#${o.space}${o.lastError ? ` (${o.attempts} failed: ${o.lastError})` : ""}`);
  if (s.said) console.log(`last sweep said:\n${s.said.split("\n").map((l) => `  ${l}`).join("\n")}`);
}

/** The relay as the keeper runs it: real gh, real DMs from "github" (the `paw dm` path, which wakes a sleeper). */
export async function liveSweepDeps(log: (line: string) => void): Promise<SweepDeps> {
  const { ensure } = await import("../lifecycle.ts");
  const { sendAsYou } = await import("../dm.ts");
  const { pawServer } = await import("../server.ts");
  const { machineName } = await import("../host-stamp.ts");
  const meshUp = new Map<string, string>();
  let gh: SweepDeps["gh"];
  try {
    gh = await liveGh();
  } catch (e) {
    const why = (e as Error).message;
    gh = () => Promise.reject(new Error(why));
  }
  return {
    gh,
    machineOf: machineName,
    log,
    send: async (space, agent, text) => {
      if (!meshUp.has(space)) {
        try {
          await ensure({ needMesh: true, needManager: true, space });
          meshUp.set(space, "");
        } catch (e) {
          meshUp.set(space, `mesh/manager for "${space}" not up: ${(e as Error).message}`);
        }
      }
      if (meshUp.get(space)) throw new Error(meshUp.get(space));
      await sendAsYou({ space, server: pawServer(space), target: agent, text, byName: true, sender: GITHUB_SENDER });
    },
  };
}

/** The keeper's call (src/global.ts): one sweep, logged to the keeper's stderr. */
export async function githubKeeperSweep(): Promise<void> {
  const log = (l: string) => console.error(`paw keeper: ${l}`);
  await githubSweep(await liveSweepDeps(log));
}

async function tick(): Promise<void> {
  const deps = await liveSweepDeps((l) => console.log(l));
  const r = await githubSweep(deps);
  if (!r) return console.log("another sweep is running — nothing done");
  console.log(`followed ${r.followed} PR(s); ${r.queued} new DM(s); sent ${r.sent}${r.failed ? `, ${r.failed} failed (kept for the next tick)` : ""}`);
  if (r.failed) process.exitCode = 1;
}

async function github(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const space = a.space ?? callerSpace();
  switch (a.sub) {
    case "watch":
      return watch(a, space);
    case "unwatch":
      return unwatch(a, space);
    case "ls":
    case "list":
      return ls();
    case "tick":
      return tick();
    default:
      throw new Error(`paw github: ${a.sub ? `unknown subcommand "${a.sub}"` : "missing subcommand"} — ${USAGE}`);
  }
}

const githubCommand: Command = {
  kind: "command",
  name: "github",
  group: "Mesh",
  summary: "follow pull requests: their comments, reviews, CI and merges reach the agent as DMs from \"github\"",
  usage: USAGE,
  run: (a) => github([...a.raw]),
};

registry.register(githubCommand);
