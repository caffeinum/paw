/**
 * 👀 on a delivered team tag (2026-11-25): once paw has handed a tag DM to the mesh (src/github-forward.ts by
 * push, src/github-teams.ts by poll), it puts an `eyes` reaction on the comment that tagged the agent, so the
 * human sees it was received.
 *
 *   - who reacts: the tagged agent's own GitHub App bot when one is registered (`paw github app`), with the
 *     installation token the keeper keeps fresh; otherwise the operator's `gh`;
 *   - at most once per tag (comment + team, the {@link seenId} id), claimed in the store before the call, so a
 *     team seated in two spaces, a redelivery or an outbox retry never reacts twice — and nothing is retried;
 *   - a review cannot carry a reaction (GitHub has no endpoint for it): skipped, said once per review;
 *   - a failure is one log line and never touches the DM;
 *   - `paw github react off` (config `react: false`) turns it off; on by default.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { botLogin, githubHttp, readConfig, tokenDir, tokenExpiry, type GithubConfig, type Http } from "./github-app.ts";
import { updateStore } from "./github-relay.ts";
import { SEEN_MAX, type Rest, type TagKind } from "./github-teams.ts";

export const REACTION = "eyes";

/** What was tagged: enough to name the reaction endpoint. `ref` is the comment/review id (unused for an issue body). */
export interface ReactTarget {
  /** The tag's dedupe id ({@link seenId}): one reaction per comment + team. */
  tag: string;
  kind: TagKind;
  ref: number;
  repo: string;
  number: number;
  url: string;
}

/** The REST path that reacts to `t`, or undefined for a review (reviews take no reactions). */
export function reactionPath(t: Pick<ReactTarget, "kind" | "ref" | "repo" | "number">): string | undefined {
  if (t.kind === "ic") return `repos/${t.repo}/issues/comments/${t.ref}/reactions`;
  if (t.kind === "rc") return `repos/${t.repo}/pulls/comments/${t.ref}/reactions`;
  if (t.kind === "is") return `repos/${t.repo}/issues/${t.number}/reactions`;
  return undefined;
}

export interface ReactDeps {
  log: (line: string) => void;
  /** The operator's `gh api`; absent = an agent without an App gets no reaction (said). */
  rest?: () => Rest;
  /** The App bot's HTTP (tests replace it). */
  http?: Http;
  config?: () => GithubConfig;
  now?: () => number;
}

/** The bot's installation token on disk; a missing or expired one throws (the keeper mints it every tick). */
function botToken(agent: string, c: GithubConfig, now: number): string {
  const app = c.apps[agent]!;
  const exp = tokenExpiry(agent, app);
  const file = join(tokenDir(agent, app.where).host, "token");
  if (exp === undefined || !existsSync(file)) throw new Error(`${botLogin(app)} has no token yet (the keeper mints it)`);
  if (exp <= now) throw new Error(`${botLogin(app)}'s token expired at ${new Date(exp).toISOString()} (the keeper re-mints it)`);
  return readFileSync(file, "utf8").trim();
}

/** React 👀 to the comment behind a tag just delivered to `agent`. Never throws. */
export async function reactToTag(t: ReactTarget, agent: string, deps: ReactDeps): Promise<void> {
  try {
    const c = (deps.config ?? readConfig)();
    if (c.react === false) return;
    const first = updateStore((s) => {
      const done = s.reacted ?? [];
      if (done.includes(t.tag)) return false;
      s.reacted = [...done, t.tag].slice(-SEEN_MAX);
      return true;
    });
    if (!first) return;
    const path = reactionPath(t);
    if (!path) return deps.log(`github: no 👀 on ${t.url}: GitHub has no reactions on a review`);
    const app = c.apps[agent];
    const who = app ? botLogin(app) : "the operator's gh";
    try {
      if (app) await (deps.http ?? githubHttp)("POST", `/${path}`, botToken(agent, c, (deps.now ?? Date.now)()), { content: REACTION });
      else if (deps.rest) await deps.rest()("POST", path, { content: REACTION });
      else throw new Error("no gh to react with");
    } catch (e) {
      deps.log(`github: 👀 on ${t.url} as ${who} FAILED: ${(e as Error).message} (not retried; the DM is delivered)`);
    }
  } catch (e) {
    deps.log(`github: 👀 on ${t.url} skipped: ${(e as Error).message}`);
  }
}
