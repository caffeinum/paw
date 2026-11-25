/**
 * A GitHub team per agent (2026-11-24), so the operator can tag an agent on GitHub with autocomplete
 * (`@firegoat-ai/evals-intern`) and the tag reaches it as a DM from "github". docs/notes/messaging.md#github-teams.
 *
 *   - `paw github teams [--apply]`: one team per agent of the space, named after it, privacy `closed` (secret
 *     teams don't autocomplete), NO members — GitHub adds the creator as maintainer, which is removed again, so
 *     no seat is used. Existing teams (same name or slug) are left alone. Dry run by default.
 *   - delivery without a webhook: on the keeper tick (src/github-relay.ts calls {@link teamSweep}), at most every
 *     {@link pollEvery} and {@link BATCH} teams at a time, one REST search per team
 *     (`org:<org> team:<org>/<slug> updated:>=<cursor>`, the search bucket, not GraphQL points), then each hit's
 *     issue comments, review comments and reviews since the cursor are scanned for `@<org>/<slug>`. Every new one
 *     is ONE short DM: who tagged it where, and the comment's URL — the agent reads it with gh. Deduped by id.
 *
 * Search DOES see review comments: a mention living only in an inline review comment (firegoat-ai/evals#1837,
 * `@firegoat-ai/mini-cto`, 2026-11-19) is returned by `team:firegoat-ai/mini-cto`. The comment scan covers
 * review comments anyway, since search says which PR, never which comment.
 */
import { execFile } from "node:child_process";

/** Teams polled per sweep; the rest wait their turn (rotation). */
export const BATCH = 10;
/** A hit's search window reaches this far back before the last poll: GitHub's search index lags. */
export const OVERLAP_MS = 10 * 60_000;
/** The org's team list is re-read this often (a team made on github.com is found without a `teams --apply`). */
export const LIST_EVERY_MS = 10 * 60_000;
const SEEN_MAX = 5000;
const GH_TIMEOUT_MS = 45_000;

export const pollEvery = (): number => {
  const v = process.env.PAW_GITHUB_TEAM_POLL_MS;
  if (v === undefined) return 120_000;
  if (!/^\d+$/.test(v)) throw new Error(`PAW_GITHUB_TEAM_POLL_MS=${v} is not a number of ms`);
  return Number(v);
};

/** `gh api` REST with the operator's login: `(method, path, fields?)` → parsed JSON. */
export type Rest = (method: string, path: string, fields?: Record<string, string>) => Promise<unknown>;

export function ghRest(env?: NodeJS.ProcessEnv, bin = "gh"): Rest {
  return (method, path, fields) =>
    new Promise((resolve, reject) => {
      const args = ["api", "-X", method, path, ...Object.entries(fields ?? {}).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
      execFile(bin, args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 32 << 20, env }, (err, stdout, stderr) => {
        if (err) {
          const why = stderr.trim().split("\n").slice(-2).join(" | ") || (err.killed ? `no answer in ${GH_TIMEOUT_MS / 1000}s` : `exit ${err.code}`);
          return reject(new Error(`gh api ${method} ${path.split("?")[0]} failed: ${why}`));
        }
        if (!stdout.trim()) return resolve(undefined);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`gh api ${method} ${path.split("?")[0]}: output is not JSON`));
        }
      });
    });
}

export interface Team {
  name: string;
  slug: string;
}

/** Every team of `org` (100 a page, every page). */
export async function listTeams(rest: Rest, org: string): Promise<Team[]> {
  const out: Team[] = [];
  for (let page = 1; ; page++) {
    const got = (await rest("GET", `orgs/${org}/teams?per_page=100&page=${page}`)) as { name?: string; slug?: string }[];
    if (!Array.isArray(got)) throw new Error(`GitHub listed no teams array for ${org}`);
    for (const t of got) {
      if (!t?.name || !t.slug) throw new Error(`GitHub listed a team of ${org} without name/slug`);
      out.push({ name: t.name, slug: t.slug });
    }
    if (got.length < 100) return out;
  }
}

/** The team that stands for `agent`: same name, or the slug GitHub would give that name. */
export function teamFor(agent: string, teams: Team[]): Team | undefined {
  const lower = agent.toLowerCase();
  return teams.find((t) => t.name.toLowerCase() === lower) ?? teams.find((t) => t.slug === slugGuess(agent));
}

/** GitHub's slug for a team name (lowercase, runs of anything else but [a-z0-9_-] → "-"). Display only:
 *  the real slug is GitHub's answer. Agent names are [A-Za-z0-9_-]+ already. */
export const slugGuess = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export interface TeamPlan {
  agent: string;
  team?: Team;
}

export function planTeams(agents: string[], teams: Team[]): TeamPlan[] {
  return agents.map((agent) => {
    const team = teamFor(agent, teams);
    return team ? { agent, team } : { agent };
  });
}

/**
 * Make the team for `agent`: closed, then the creator's maintainer seat removed and the team checked empty.
 * Every API error throws (the caller says which teams were made before it).
 */
export async function createTeam(rest: Rest, org: string, agent: string, viewer: string): Promise<Team> {
  const made = (await rest("POST", `orgs/${org}/teams`, { name: agent, privacy: "closed", description: `paw agent ${agent}: @-mention to reach it` })) as { name?: string; slug?: string };
  if (!made?.slug || !made.name) throw new Error(`GitHub created team ${agent} but answered without a slug`);
  await rest("DELETE", `orgs/${org}/teams/${made.slug}/memberships/${viewer}`);
  const members = (await rest("GET", `orgs/${org}/teams/${made.slug}/members?per_page=5`)) as unknown[];
  if (!Array.isArray(members)) throw new Error(`GitHub listed no members array for ${org}/${made.slug}`);
  if (members.length) throw new Error(`team ${org}/${made.slug} still has ${members.length} member(s) after removing ${viewer} — remove them on github.com`);
  return { name: made.name, slug: made.slug };
}

// ---------------------------------------------------------------------------------------------------
// Mentions → DMs

export interface TeamCursor {
  /** Mentions updated before this were there before paw looked (baseline): never sent. */
  since: string;
  /** When this team's last search started. */
  polled: string;
}

export interface TeamsState {
  org: string;
  teams: Team[];
  listedAt: number;
  lastPoll: number;
  /** Rotation offset into the polled team list. */
  next: number;
  cursors: Record<string, TeamCursor>;
  /** Comment ids already sent (or baselined): `ic:<id>`, `rc:<id>`, `rv:<id>`, `is:<id>`. */
  seen: string[];
}

export interface Mention {
  id: string;
  slug: string;
  repo: string;
  number: number;
  login: string;
  url: string;
}

export interface TeamTarget {
  slug: string;
  /** Logins whose tags are the agent's own (its App bot, its persona `github:`). */
  self: string[];
}

interface Commentish {
  id?: number;
  body?: string | null;
  html_url?: string;
  user?: { login?: string } | null;
  updated_at?: string;
  submitted_at?: string;
  created_at?: string;
}

const mentions = (body: string | null | undefined, org: string, slug: string): boolean =>
  !!body && new RegExp(`(^|[^A-Za-z0-9_/-])@${org.replace(/[-]/g, "\\-")}/${slug.replace(/[-]/g, "\\-")}(?![A-Za-z0-9_-])`, "i").test(body);

/**
 * One poll of `targets`' teams: search each for issues/PRs touched since its cursor, then scan their comments.
 * Returns the new mentions and the cursors after; throws only for a search that failed (the caller logs it and
 * keeps the old cursor, so nothing is skipped).
 */
export async function pollTeams(rest: Rest, org: string, targets: TeamTarget[], state: Pick<TeamsState, "cursors" | "seen">, now: number): Promise<{ found: Mention[]; cursors: Record<string, TeamCursor>; seen: string[]; errors: string[] }> {
  const cursors = { ...state.cursors };
  const seen = new Set(state.seen);
  const found: Mention[] = [];
  const errors: string[] = [];
  const stamp = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
  for (const t of targets) {
    const cur = cursors[t.slug];
    if (!cur) {
      cursors[t.slug] = { since: stamp, polled: stamp }; // first sight: what is already there is not news
      continue;
    }
    const from = new Date(Math.max(Date.parse(cur.since), Date.parse(cur.polled) - OVERLAP_MS)).toISOString().replace(/\.\d+Z$/, "Z");
    const q = `org:${org} team:${org}/${t.slug} updated:>=${from}`;
    let items: { number?: number; html_url?: string; repository_url?: string; pull_request?: unknown; body?: string | null; user?: { login?: string } | null; created_at?: string; id?: number }[];
    try {
      const r = (await rest("GET", `search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`)) as { items?: typeof items };
      if (!Array.isArray(r?.items)) throw new Error("search answered without items");
      items = r.items;
    } catch (e) {
      errors.push(`team ${org}/${t.slug}: ${(e as Error).message}`);
      continue;
    }
    const self = new Set(t.self.map((s) => s.toLowerCase()));
    const take = (kind: string, repo: string, number: number, c: Commentish, at: string | undefined) => {
      if (typeof c.id !== "number" || !c.html_url || !at || at < cur.since || !mentions(c.body, org, t.slug)) return;
      const id = `${kind}:${c.id}`;
      if (seen.has(id)) return;
      seen.add(id);
      const login = c.user?.login;
      if (!login) return void found.push({ id, slug: t.slug, repo, number, login: "a deleted account", url: c.html_url });
      if (self.has(login.toLowerCase())) return;
      found.push({ id, slug: t.slug, repo, number, login, url: c.html_url });
    };
    let failed = false;
    for (const it of items) {
      const repo = it.repository_url?.match(/\/repos\/([^/]+\/[^/]+)$/)?.[1];
      if (!repo || typeof it.number !== "number") continue;
      take("is", repo, it.number, it as Commentish, it.created_at);
      try {
        const since = encodeURIComponent(from);
        const ic = (await rest("GET", `repos/${repo}/issues/${it.number}/comments?since=${since}&per_page=100`)) as Commentish[];
        for (const c of ic ?? []) take("ic", repo, it.number, c, c.updated_at);
        if (it.pull_request) {
          const rc = (await rest("GET", `repos/${repo}/pulls/${it.number}/comments?since=${since}&per_page=100`)) as Commentish[];
          for (const c of rc ?? []) take("rc", repo, it.number, c, c.updated_at);
          const rv = (await rest("GET", `repos/${repo}/pulls/${it.number}/reviews?per_page=100`)) as Commentish[];
          for (const c of rv ?? []) take("rv", repo, it.number, c, c.submitted_at);
        }
      } catch (e) {
        errors.push(`team ${org}/${t.slug}: reading ${repo}#${it.number}: ${(e as Error).message}`);
        failed = true;
      }
    }
    // A hit that could not be read keeps the old cursor: the next poll reads it again (seen ids stop repeats).
    if (!failed) cursors[t.slug] = { since: cur.since, polled: stamp };
  }
  return { found, cursors, seen: [...seen].slice(-SEEN_MAX), errors };
}

export function mentionText(m: Mention): string {
  return `you were tagged by ${m.login} in ${m.repo}#${m.number}\n${m.url}`;
}
