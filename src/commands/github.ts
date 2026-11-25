/**
 * `paw github` — which pull requests an agent follows (src/github-relay.ts):
 *
 *   paw github watch <pr> [<agent>]     follow a PR: its comments, reviews, CI and merge arrive as DMs from "github"
 *   paw github unwatch <pr> [<agent>]   stop: drops a watch, or mutes a PR followed by branch or author
 *   paw github ls                       what this machine follows, for whom and why, and what waits to be sent
 *   paw github tick                     one sweep now (the global keeper runs one every 60s)
 *   paw github org [<org>]              the organization agents' teams live in (src/github-app.ts config)
 *   paw github teams [--apply]          a closed, memberless team per agent of the space: @org/<agent> tags reach it
 *   paw github app set <agent> --app-id N --installation-id N --key <pem>   the agent's gh + git act as <slug>[bot]
 *   paw github app test <agent>         mint a token, list the installation's repos (read-only)
 *   paw github app ls                   registered Apps and their tokens' expiry
 *
 * `<pr>` is the PR's URL, `owner/repo#N`, or `#N` inside the repo. The agent defaults to the caller
 * (COTAL_NAME, which cotal stamps into every agent's tools); `<agent>#<space>` names another space.
 */
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { listAgents, personaFilePath, setPersonaKeys } from "../addressing.ts";
import {
  appIdentity,
  assertOrg,
  botEmail,
  botLogin,
  githubHttp,
  keepKey,
  keyPathFor,
  loadKey,
  mintToken,
  orgOrThrow,
  readConfig,
  refreshTokens,
  settingsFile,
  tokenDir,
  tokenExpiry,
  updateConfig,
  withSettingsArg,
  writeToken,
  type AppConfig,
  type Http,
} from "../github-app.ts";
import { createTeam, ghRest, listTeams, planTeams, slugGuess, type Rest } from "../github-teams.ts";
import { personaValue, readAgentType, readClaudeArgs, readSandbox } from "../session.ts";
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

const USAGE =
  "github watch <pr> [<agent>[#space]] · github unwatch <pr> [<agent>[#space]] · github ls · github tick · github org [<org>] · github teams [--apply] [--org <org>] [--exclude <glob,…>] · " +
  "github app set <agent> --app-id N --installation-id N --key <pem> · github app test <agent> · github app ls   (<pr> = URL, owner/repo#N, or #N in the repo)";

interface Args {
  sub?: string;
  positionals: string[];
  space?: string;
  apply?: boolean;
  org?: string;
  appId?: string;
  installationId?: string;
  key?: string;
  exclude?: string;
}

const VALUED = { "--space": "space", "--org": "org", "--app-id": "appId", "--installation-id": "installationId", "--key": "key", "--exclude": "exclude" } as const;

function parseArgs(argv: string[]): Args {
  const out: Args = { positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a in VALUED) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`paw github: ${a} needs a value — ${USAGE}`);
      out[VALUED[a as keyof typeof VALUED]] = v;
    } else if (a === "--apply") out.apply = true;
    else if (a.startsWith("--")) throw new Error(`paw github: unknown flag "${a}" — ${USAGE}`);
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

async function liveRest(): Promise<Rest> {
  const { daemonEnv } = await import("../lifecycle.ts");
  const env = daemonEnv();
  return ghRest(env, findGh(env));
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
  let rest: Rest;
  try {
    gh = await liveGh();
    rest = await liveRest();
  } catch (e) {
    const why = (e as Error).message;
    gh = () => Promise.reject(new Error(why));
    rest = () => Promise.reject(new Error(why));
  }
  return {
    gh,
    rest,
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

/** Re-mint every App token near expiry; a failure is said once while unchanged (the store's `said` is the
 *  relay's, so App problems keep their own last line in memory of this process only — the keeper is one-shot,
 *  so it says them every tick they persist, which is what a broken bot identity deserves). */
async function refreshAppTokens(log: (line: string) => void, http: Http = githubHttp): Promise<void> {
  const r = await refreshTokens(http);
  for (const a of r.minted) log(`github: minted a fresh App token for ${a}`);
  for (const p of r.problems) log(`github: ${p}`);
}

/** The keeper's call (src/global.ts): App tokens first (an agent mid-push needs one), then one sweep. */
export async function githubKeeperSweep(): Promise<void> {
  const log = (l: string) => console.error(`paw keeper: ${l}`);
  await refreshAppTokens(log);
  await githubSweep(await liveSweepDeps(log));
}

async function tick(): Promise<void> {
  await refreshAppTokens((l) => console.log(l));
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
    case "org":
      return org(a);
    case "teams":
      return teams(a, space, await liveRest());
    case "app":
      return app(a, space);
    default:
      throw new Error(`paw github: ${a.sub ? `unknown subcommand "${a.sub}"` : "missing subcommand"} — ${USAGE}`);
  }
}

function org(a: Args): void {
  const [name, extra] = a.positionals;
  if (extra !== undefined) throw new Error(`paw github: org takes one name — ${USAGE}`);
  if (name === undefined) {
    const o = readConfig().org;
    console.log(o ?? "no organization set — `paw github org <org>`");
    return;
  }
  assertOrg(name);
  updateConfig((c) => void (c.org = name));
  console.log(`✓ agents' teams live in ${name}`);
}

/** `--exclude a,beads-*`: comma-separated agent names or `*` globs to leave without a team. */
export function excludeMatcher(spec: string | undefined): (name: string) => boolean {
  if (spec === undefined) return () => false;
  const pats = spec.split(",").map((p) => p.trim());
  if (pats.some((p) => !p)) throw new Error(`paw github: --exclude has an empty pattern in "${spec}"`);
  const res = pats.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return (name) => res.some((r) => r.test(name));
}

/** `paw github teams [--apply]`: a closed, memberless team per agent of the space. Exported for the check. */
export async function teams(a: Args, space: string, rest: Rest, out: (l: string) => void = (l) => console.log(l)): Promise<void> {
  if (a.positionals.length) throw new Error(`paw github: teams takes no arguments — ${USAGE}`);
  const orgName = orgOrThrow(a.org);
  const all = listAgents(space).map((x) => x.name).sort();
  if (!all.length) throw new Error(`paw github: space "${space}" has no agents`);
  const skip = excludeMatcher(a.exclude);
  const agents = all.filter((n) => !skip(n));
  for (const n of all) if (skip(n)) out(`- ${n}: excluded`);
  if (!agents.length) throw new Error(`paw github: --exclude ${a.exclude} leaves no agents`);
  const existing = await listTeams(rest, orgName);
  const plan = planTeams(agents, existing);
  const missing = plan.filter((p) => !p.team);
  for (const p of plan) if (p.team) out(`✓ ${p.agent}: @${orgName}/${p.team.slug} exists — left alone`);
  if (!a.apply) {
    for (const p of missing) out(`+ ${p.agent}: would create @${orgName}/${slugGuess(p.agent)} (closed, no members)`);
    out(missing.length ? `dry run: ${missing.length} team(s) to create — again with --apply` : "nothing to create");
    return;
  }
  if (!missing.length) return out("nothing to create");
  const me = (await rest("GET", "user")) as { login?: string };
  if (!me?.login) throw new Error("paw github: GitHub's GET /user answered without a login — check `gh auth status`");
  const made: string[] = [];
  for (const p of missing) {
    try {
      const t = await createTeam(rest, orgName, p.agent, me.login);
      made.push(t.slug);
      out(`+ ${p.agent}: created @${orgName}/${t.slug} (closed, no members)`);
    } catch (e) {
      throw new Error(`paw github: creating the team for ${p.agent} failed: ${(e as Error).message}${made.length ? ` (created before it: ${made.join(", ")})` : ""} — fix it and run again (existing teams are left alone)`);
    }
  }
  // The relay re-reads the team list on its own every 10 minutes; make the new ones polled from the next tick.
  updateStore((s) => {
    if (s.teams?.org === orgName) s.teams.listedAt = 0;
  });
}

async function app(a: Args, space: string): Promise<void> {
  const [verb, agent, extra] = a.positionals;
  if (extra !== undefined) throw new Error(`paw github: app ${verb} takes one agent — ${USAGE}`);
  if (verb === "ls") return appLs();
  if (!agent) throw new Error(`paw github: app ${verb ?? ""} needs an agent — ${USAGE}`);
  if (verb === "set") return appSet(a, space, agent);
  if (verb === "test") return appTest(agent);
  throw new Error(`paw github: app ${verb ? `"${verb}" is not set|test|ls` : "needs set|test|ls"} — ${USAGE}`);
}

/** `paw github app set`: keep the key, learn the bot, mint the first token, wire the persona. Exported for the check. */
export async function appSet(a: Args, space: string, agent: string, http: Http = githubHttp, out: (l: string) => void = (l) => console.log(l)): Promise<void> {
  if (!a.appId || !/^[1-9]\d*$/.test(a.appId)) throw new Error(`paw github: app set needs --app-id <number> (the App's settings page: "App ID") — ${USAGE}`);
  if (!a.installationId || !/^[1-9]\d*$/.test(a.installationId)) throw new Error(`paw github: app set needs --installation-id <number> (the number at the end of the installation's settings URL) — ${USAGE}`);
  if (!a.key) throw new Error(`paw github: app set needs --key <the downloaded .pem> — ${USAGE}`);
  const persona = personaFilePath(space, agent);
  if (!existsSync(persona)) throw new Error(`paw github: no agent "${agent}" in space "${space}"`);
  const kind = readAgentType(persona) ?? "claude";
  if (kind !== "claude") throw new Error(`paw github: "${agent}" is a ${kind} agent — App identities reach claude agents only (through claude's --settings)`);
  const other = Object.entries(readConfig().apps).find(([n, x]) => n === agent && x.space !== space);
  if (other) throw new Error(`paw github: "${agent}" already has an App in space "${other[1].space}" — one App per agent name on this machine`);
  const where = readSandbox(persona) ? "sandbox" : "host";
  const settings = settingsFile(tokenDir(agent, where)).agent;
  const args = withSettingsArg(readClaudeArgs(persona), settings); // refused here, before anything is minted
  const { slug, botId, minted } = await appIdentity(a.appId, a.installationId, loadKey(a.key), http);
  const keyAt = keepKey(agent, a.key);
  const cfg: AppConfig = { space, appId: a.appId, installationId: a.installationId, slug, botId, where };
  const dir = writeToken(agent, cfg, minted);
  updateConfig((c) => void (c.apps[agent] = cfg));
  setPersonaKeys(space, agent, { claudeArgs: JSON.stringify(args) });
  out(`✓ ${agent}#${space} acts on GitHub as ${botLogin(cfg)} <${botEmail(cfg)}>`);
  out(`  key kept at ${keyAt} (0600) — delete the downloaded copy${resolve(a.key) === keyAt ? "" : ` (${a.key})`}`);
  out(`  token: ${dir.host}/token, expires ${minted.expiresAt}; the keeper re-mints it before that`);
  out(`  persona claudeArgs: --settings ${settings} (gh via GH_CONFIG_DIR, git credential helper + author/committer)`);
  const login = personaValue(persona, "github");
  if (login) out(`  note: persona github: ${login} still names the account whose own PR events are filtered and whose PRs it follows`);
  out(`  takes effect at its next start: \`paw restart ${agent}${space === "paw" ? "" : ` --space ${space}`}\` (paw never restarts it for you)`);
}

/** `paw github app test`: mint a token and list the installation's repositories (read-only). */
export async function appTest(agent: string, http: Http = githubHttp, out: (l: string) => void = (l) => console.log(l)): Promise<void> {
  const cfg = readConfig().apps[agent];
  if (!cfg) throw new Error(`paw github: "${agent}" has no App — \`paw github app set ${agent} --app-id N --installation-id N --key <pem>\``);
  const m = await mintToken(cfg, loadKey(keyPathFor(agent)), http);
  const r = (await http("GET", "/installation/repositories?per_page=100", m.token)) as { total_count?: number; repositories?: { full_name?: string }[] };
  if (!Array.isArray(r?.repositories) || typeof r.total_count !== "number") throw new Error("GitHub's GET /installation/repositories answered without repositories");
  out(`✓ ${botLogin(cfg)} (App ${cfg.appId}, installation ${cfg.installationId}) — token minted, expires ${m.expiresAt}`);
  out(`  ${r.total_count} repositor${r.total_count === 1 ? "y" : "ies"}: ${r.repositories.map((x) => x.full_name).join(", ")}${r.total_count > r.repositories.length ? ", …" : ""}`);
}

function appLs(): void {
  const apps = Object.entries(readConfig().apps);
  if (!apps.length) return console.log("no GitHub Apps registered — `paw github app set <agent> --app-id N --installation-id N --key <pem>`");
  for (const [agent, cfg] of apps) {
    const exp = tokenExpiry(agent, cfg);
    console.log(`${agent}#${cfg.space}  ${botLogin(cfg)}  App ${cfg.appId} · installation ${cfg.installationId} · ${cfg.where} · token ${exp ? `expires ${new Date(exp).toISOString()}` : "none yet (next keeper tick)"}`);
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
