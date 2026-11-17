/**
 * Hermetic check for the GitHub → paw relay (src/github-relay.ts, docs/notes/messaging.md#github).
 * 2026-11-17: new comments on a PR woke nobody; the agent working the PR had to poll `gh` itself.
 *
 * A throwaway PAW_HOME holds personas; a fake `gh api graphql` answers from an in-memory GitHub, and a
 * fake send records DMs. Asserted:
 *   1. PR refs parse from a URL, owner/repo#N and #N in the repo; junk fails loud; bodies are cleaned;
 *   2. who follows: the checked-out branch (not the default branch, not a fork's), the persona's
 *      `github:` login (author), `paw github watch`; another machine's or a teleported agent is skipped;
 *   3. a PR seen first is baselined (nothing sent); an unchanged PR costs no detail read;
 *   4. a new comment reaches every follower, minus the follower's own login; the shared-account note;
 *   5. reviews: bot label, verdict, inline comments; pending reviews skipped; a review started BEFORE a
 *      later comment but submitted after it is still sent;
 *   6. CI: once per settled head (pending says nothing, a rerun that changes the verdict says it again);
 *   7. a failed send stays queued and goes out next tick; dropped after MAX_ATTEMPTS;
 *   8. a mute silences one follower; a merge reaches the rest (no separate "closed"), then the PR, its
 *      watches and mutes are gone;
 *   9. a GitHub failure is logged once while unchanged; two sweeps at once → the second is a no-op.
 * Run: pnpm check:github-relay
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-github-"));
process.env.PAW_HOME = home;
const R = await import("../src/github-relay.ts");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const throws = (f: () => unknown, re: RegExp) => {
  try {
    f();
    return "did not throw";
  } catch (e) {
    return re.test((e as Error).message) ? "" : (e as Error).message;
  }
};

// ── 1. refs + bodies ──
ok("URL", R.parsePrRef("https://github.com/o/r/pull/12/files") === "o/r#12");
ok("owner/repo#N", R.parsePrRef("o/r.git#5") === "o/r#5");
ok("#N in the repo", R.parsePrRef("#3", "o/r") === "o/r#3");
ok("#N outside a GitHub repo fails loud", throws(() => R.parsePrRef("3"), /names no repo/) === "");
ok("junk fails loud", throws(() => R.parsePrRef("hello"), /is not a PR/) === "");
const cleaned = R.cleanBody("<!-- hidden -->\n<details><summary>Walkthrough</summary>\n\nbody   \n\n\n\nend</details>");
ok("bodies lose HTML comments and tags, blank runs fold", cleaned === "Walkthrough\n\nbody\n\nend", JSON.stringify(cleaned));
ok("long bodies are capped with a count", R.cleanBody("x".repeat(50), 10) === "xxxxxxxxxx … (+40 chars)");

// ── fake GitHub ──
type Node = Record<string, unknown>;
interface Pr {
  repo: string;
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  head: string;
  cross?: boolean;
  author: string;
  sha: string;
  rollup?: string;
  contexts: Node[];
  timeline: Node[];
}
const gh = { viewer: "op", defaults: { "o/r": "main" } as Record<string, string>, prs: [] as Pr[], down: false, calls: [] as string[] };
const light = (p: Pr) => ({
  number: p.number,
  url: `https://github.com/${p.repo}/pull/${p.number}`,
  title: p.title,
  state: p.state,
  updatedAt: p.updatedAt,
  isCrossRepository: !!p.cross,
  headRefName: p.head,
  repository: { nameWithOwner: p.repo },
  commits: { nodes: [{ commit: { oid: p.sha, statusCheckRollup: p.rollup ? { state: p.rollup } : null } }] },
});
const find = (repo: string, n: number) => gh.prs.find((p) => p.repo === repo && p.number === n);
const fakeGh: import("../src/github-relay.ts").Gh = async (query) => {
  gh.calls.push(query);
  if (gh.down) throw new Error("gh api graphql failed: HTTP 502");
  const data: Record<string, unknown> = {};
  for (const line of query.split("\n")) {
    let m: RegExpMatchArray | null;
    if (line.includes("viewer { login }")) data.viewer = { login: gh.viewer };
    if ((m = line.match(/^(?:query \{ )?(b\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ defaultBranchRef \{ name \} pullRequests\(headRefName: "([^"]+)"/))) {
      const repo = `${m[2]}/${m[3]}`;
      data[m[1]!] = { defaultBranchRef: { name: gh.defaults[repo] }, pullRequests: { nodes: gh.prs.filter((p) => p.repo === repo && p.head === m![4] && p.state === "OPEN").map(light) } };
    } else if ((m = line.match(/^(?:query \{ )?(u\d+): search\(query: "is:pr is:open author:([^"]+)"/))) {
      data[m[1]!] = { nodes: gh.prs.filter((p) => p.author.toLowerCase() === m![2] && p.state === "OPEN").map(light) };
    } else if ((m = line.match(/^(?:query \{ )?(k\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/))) {
      const p = find(`${m[2]}/${m[3]}`, Number(m[4]));
      data[m[1]!] = { pullRequest: p ? light(p) : null };
    } else if ((m = line.match(/^(?:query \{ )?(d\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/))) {
      const p = find(`${m[2]}/${m[3]}`, Number(m[4]))!;
      const pr: Node = {};
      if (line.includes("timelineItems(")) pr.timelineItems = { nodes: p.timeline.slice(-25) };
      if (line.includes("contexts(")) pr.commits = { nodes: [{ commit: { oid: p.sha, statusCheckRollup: p.rollup ? { state: p.rollup, contexts: { nodes: p.contexts } } : null } }] };
      data[m[1]!] = { pullRequest: pr };
    }
  }
  return { data };
};

let clock = Date.parse("2026-11-17T10:00:00Z");
const tick = () => new Date((clock += 1000)).toISOString().replace(/\.\d+Z$/, "Z");
const comment = (id: string, login: string, body: string, assoc = "MEMBER", bot = false): Node => ({
  __typename: "IssueComment",
  id,
  createdAt: tick(),
  url: `https://github.com/o/r/pull/7#issuecomment-${id}`,
  body,
  author: { __typename: bot ? "Bot" : "User", login },
  authorAssociation: assoc,
});
const touch = (p: Pr) => (p.updatedAt = tick());

// ── personas ──
const SPACE = "test-gh";
const HERE = "test-mini";
const persona = (name: string, fields: Record<string, string> = {}) => {
  const dir = join(home, "spaces", SPACE, "personas");
  mkdirSync(dir, { recursive: true });
  const folder = join(home, "folders", name);
  mkdirSync(folder, { recursive: true });
  const fm = Object.entries({ cwd: folder, ...fields }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${fm.join("\n")}\n---\n${name}\n`);
  return folder;
};
const checkouts = new Map<string, { repo: string; branch: string }>();
checkouts.set(persona("fixer", { github: "fixer-gh" }), { repo: "o/r", branch: "feat-x" });
checkouts.set(persona("mainline"), { repo: "o/r", branch: "main" });
checkouts.set(persona("forked"), { repo: "o/r", branch: "fork-branch" });
persona("author", { github: "@Author-Bot" });
persona("watcher");
checkouts.set(persona("remote", { machine: "aleks-macbook" }), { repo: "o/r", branch: "feat-x" });
checkouts.set(persona("gone", { teleported: "fly:app" }), { repo: "o/r", branch: "feat-x" });

const pr7: Pr = { repo: "o/r", number: 7, title: "feat x", state: "OPEN", updatedAt: tick(), head: "feat-x", author: "op", sha: "abc1234def", contexts: [], timeline: [comment("c1", "op", "old news")] };
pr7.updatedAt = tick();
const pr8: Pr = { repo: "o/r", number: 8, title: "from a fork", state: "OPEN", updatedAt: tick(), head: "fork-branch", cross: true, author: "x", sha: "f00", contexts: [], timeline: [] };
const pr9: Pr = { repo: "o/r", number: 9, title: "by the bot", state: "OPEN", updatedAt: tick(), head: "bot-branch", author: "author-bot", sha: "999", contexts: [], timeline: [comment("c9", "op", "before")] };
gh.prs.push(pr7, pr8, pr9);
R.updateStore((s) => void s.watches.push({ space: SPACE, agent: "watcher", pr: "o/r#7", by: "operator", at: 0 }));

const sent: { agent: string; text: string }[] = [];
const logs: string[] = [];
let failFor: string | undefined;
const deps = {
  gh: fakeGh,
  send: async (_space: string, agent: string, text: string) => {
    if (agent === failFor) throw new Error("mesh down");
    sent.push({ agent, text });
  },
  machineOf: () => HERE,
  log: (l: string) => logs.push(l),
  checkout: (folder: string) => checkouts.get(folder),
};
const sweep = async () => {
  sent.length = 0;
  gh.calls.length = 0;
  return R.githubSweep(deps);
};
const to = (agent: string) => sent.filter((s) => s.agent === agent);

// ── 2 + 3. who follows; baseline ──
await sweep();
const st = R.readStore();
const subs7 = (st.prs["o/r#7"]?.subs ?? []).map((s) => `${s.agent}:${s.why}`).sort().join(",");
ok("o/r#7 followed by its branch's agent and its watcher (not remote, not teleported, not the default branch)", subs7 === "fixer:branch,watcher:watch", subs7);
ok("o/r#9 followed by author login (case and @ ignored)", (st.prs["o/r#9"]?.subs ?? []).map((s) => `${s.agent}:${s.why}`).join() === "author:author");
ok("a fork's PR on the same branch name is not followed", !st.prs["o/r#8"]);
ok("first sight sends nothing (baseline)", sent.length === 0, sent.map((s) => s.text).join("|"));
ok("baseline starts from the PR's last update", st.prs["o/r#7"]?.cursor === pr7.updatedAt, st.prs["o/r#7"]?.cursor);
await sweep();
ok("nothing moved: one cheap query, no detail read, nothing sent", gh.calls.length === 1 && sent.length === 0, `${gh.calls.length} calls`);

// ── 4. comments ──
pr7.timeline.push(comment("c2", "alice", "please rename foo"), comment("c3", "fixer-gh", "done"), comment("c4", "op", "lgtm from the shared account"));
touch(pr7);
await sweep();
const f = to("fixer")[0]?.text ?? "";
const w = to("watcher")[0]?.text ?? "";
ok("one DM per follower", to("fixer").length === 1 && to("watcher").length === 1, `${sent.length} sent`);
ok("the DM names the PR, the author and role, the body and the link", f.startsWith('🐙 github · o/r#7 "feat x"') && f.includes("💬 alice (member) commented:\n   please rename foo") && f.includes("#issuecomment-c2"), f);
ok("the follower's own login is not sent back to it", !f.includes("done") && w.includes("fixer-gh (member) commented"), f);
ok("old comments stay unsent", !f.includes("old news"));
ok("why + how to stop", f.includes("because your folder has its branch checked out") && f.includes("paw github unwatch o/r#7") && w.includes("you ran `paw github watch`"));
ok("a follower with no github: login is told the shared account is paw's reader", w.includes("[op is also the account paw reads GitHub with") && !f.includes("[op is also"), w);
ok("the outbox is empty after a good send", R.readStore().outbox.length === 0);

// ── 5. reviews ──
const started = tick(); // a review begun now, submitted after the next comment
pr7.timeline.push(
  { __typename: "PullRequestReview", id: "r1", submittedAt: null, state: "PENDING", url: "u", body: "draft", author: { __typename: "User", login: "alice" }, authorAssociation: "MEMBER", comments: { totalCount: 0, nodes: [] }, createdAt: started },
);
pr7.timeline.push(comment("c5", "bob", "first"));
pr7.timeline.splice(pr7.timeline.length - 1, 0, {
  __typename: "PullRequestReview",
  id: "r2",
  submittedAt: tick(),
  state: "CHANGES_REQUESTED",
  url: "https://github.com/o/r/pull/7#pullrequestreview-r2",
  body: "<!-- coderabbit -->Actionable comments posted: 2",
  author: { __typename: "Bot", login: "coderabbitai" },
  authorAssociation: "NONE",
  comments: { totalCount: 7, nodes: [{ path: "src/a.ts", line: 12, body: "rename\nthis" }, { path: "src/b.ts", line: null, originalLine: 3, body: "nit" }] },
});
touch(pr7);
await sweep();
const rv = to("fixer")[0]?.text ?? "";
ok("a bot review: label, verdict, body, inline comments, the rest counted", rv.includes("📝 coderabbitai (bot) requested changes:\n   Actionable comments posted: 2") && rv.includes("   · src/a.ts:12 — rename this") && rv.includes("   · src/b.ts:3 — nit") && rv.includes("… 5 more inline"), rv);
ok("a pending review is not sent", !rv.includes("draft"));
ok("a comment after the review's start is sent too", rv.includes("bob"));
pr7.timeline.push({ __typename: "PullRequestReview", id: "r3", submittedAt: tick(), state: "APPROVED", url: "u3", body: "", author: { __typename: "User", login: "carol" }, authorAssociation: "COLLABORATOR", comments: { totalCount: 0, nodes: [] } });
touch(pr7);
await sweep();
ok("an approval with no body", (to("fixer")[0]?.text ?? "").includes("📝 carol (collaborator) approved\n   u3"), to("fixer")[0]?.text);

// ── 6. CI ──
pr7.rollup = "PENDING";
await sweep();
ok("pending CI says nothing", sent.length === 0);
pr7.rollup = "FAILURE";
pr7.contexts = [
  { __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/tests" },
  { __typename: "CheckRun", name: "Lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/lint" },
  { __typename: "StatusContext", context: "Vercel", state: "ERROR", targetUrl: "https://vercel" },
];
await sweep();
const ci = to("fixer")[0]?.text ?? "";
ok("a failed head is told once, with what failed", ci.includes("❌ CI failed at abc1234: Tests (failure) https://ci/tests\n   Vercel (error) https://vercel") && !ci.includes("Lint"), ci);
ok("CI reaches every follower", to("watcher").length === 1);
await sweep();
ok("the same verdict is not told again", sent.length === 0);
pr7.rollup = "SUCCESS";
pr7.contexts = [{ __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "SUCCESS" }];
await sweep();
ok("a rerun that passes is told", (to("fixer")[0]?.text ?? "").includes("✅ CI passed at abc1234 (1 check)"));
pr7.sha = "fff0000";
pr7.rollup = "SUCCESS";
await sweep();
ok("a new head that passes is told", (to("fixer")[0]?.text ?? "").includes("✅ CI passed at fff0000"));

// ── 7. failed sends ──
failFor = "watcher";
pr7.timeline.push(comment("c6", "dave", "ping"));
touch(pr7);
await sweep();
const queued = R.readStore().outbox;
ok("a failed send stays queued with its error", queued.length === 1 && queued[0]!.agent === "watcher" && queued[0]!.attempts === 1 && queued[0]!.lastError === "mesh down");
ok("the other follower still got it", to("fixer").length === 1);
failFor = undefined;
await sweep();
ok("it goes out on the next tick", to("watcher").length === 1 && to("watcher")[0]!.text.includes("dave") && R.readStore().outbox.length === 0);
failFor = "watcher";
pr7.timeline.push(comment("c7", "dave", "ping again"));
touch(pr7);
for (let i = 0; i < R.MAX_ATTEMPTS; i++) await sweep();
ok("dropped after MAX_ATTEMPTS, logged", R.readStore().outbox.length === 0 && logs.some((l) => l.includes("NOT delivered to watcher")));
failFor = undefined;

// ── 8. mute, merge ──
R.updateStore((s) => void s.mutes.push({ space: SPACE, agent: "fixer", pr: "o/r#7" }));
pr7.timeline.push(comment("c8", "erin", "muted?"));
touch(pr7);
await sweep();
ok("a muted follower hears nothing; the rest do", to("fixer").length === 0 && to("watcher").length === 1);
pr7.state = "MERGED";
pr7.timeline.push({ __typename: "MergedEvent", id: "m1", createdAt: tick(), actor: { __typename: "User", login: "op" } }, { __typename: "ClosedEvent", id: "x1", createdAt: tick(), actor: { __typename: "User", login: "op" } });
touch(pr7);
await sweep();
const mg = to("watcher")[0]?.text ?? "";
ok("a merge is told to who followed it, once (no separate closed)", mg.includes("🟣 op merged") && !mg.includes("closed"), mg);
ok("the muted follower stays muted", to("fixer").length === 0);
const after = R.readStore();
ok("the merged PR, its watch and its mute are gone", !after.prs["o/r#7"] && !after.watches.some((x) => x.pr === "o/r#7") && !after.mutes.some((x) => x.pr === "o/r#7"));
ok("other PRs keep being followed", !!after.prs["o/r#9"]);

// ── 8b. a mute ends once nothing would follow the PR anyway ──
R.updateStore((s) => void s.mutes.push({ space: SPACE, agent: "watcher", pr: "o/r#9" }));
await sweep();
ok("a mute that silences nobody is dropped", !R.readStore().mutes.some((m) => m.pr === "o/r#9"));
R.updateStore((s) => void s.mutes.push({ space: SPACE, agent: "author", pr: "o/r#9" }));
await sweep();
ok("a mute that silences a follower stays, and the PR is no longer followed by it", R.readStore().mutes.some((m) => m.agent === "author" && m.pr === "o/r#9") && !R.readStore().prs["o/r#9"]);

// ── 9. GitHub down; concurrent sweeps ──
gh.down = true;
logs.length = 0;
await sweep();
await sweep();
ok("a GitHub failure is logged once while unchanged", logs.filter((l) => l.includes("HTTP 502")).length === 1, logs.join(" | "));
gh.down = false;
const both = await Promise.all([R.githubSweep(deps), R.githubSweep(deps)]);
ok("two sweeps at once: the second is a no-op", both.filter((x) => x === undefined).length === 1);

console.log(failures ? `\n${failures} check(s) failed` : "\nall github relay checks passed 🐙");
process.exit(failures ? 1 : 0);
