/**
 * Hermetic check for agents' GitHub identity (docs/notes/messaging.md#github-teams, #github-apps): a team per
 * agent, team mentions → DMs, and per-agent GitHub Apps. Nothing reaches github.com: teams and mentions run
 * against a fake `gh api` (REST), Apps against a local HTTP stub of api.github.com (PAW_GITHUB_API).
 *
 *   1. org config: unset fails loud; set + read back; a bad name refused;
 *   2. `paw github teams`: dry run creates nothing; --apply makes only the missing ones (closed, the creator's
 *      seat removed, checked empty); existing (any case) left alone; a second run is a no-op; an API error fails
 *      loud naming what was made before it; a leftover member fails loud;
 *   3. mentions: first poll baselines; a review comment, an issue comment and a new issue body tagging the team
 *      each become ONE short DM (who, where, URL); a lookalike team, the agent's own bot and an old comment are
 *      not; the overlap re-read sends nothing twice; the poll interval and the 10-team batch rotate; a failed
 *      search is said and the cursor kept;
 *   4. Apps: the JWT is RS256 over {iat, exp, iss} and verifies with the App's public key; `app set` keeps the key
 *      0600, learns slug + bot id, writes the token files 0600 and the settings, wires claudeArgs `--settings`,
 *      never prints the key; a kit agent, a clashing `--settings`, a wrong App id are refused; `app test` lists
 *      the installation's repos with the TOKEN; the keeper re-mints only near expiry; a sandboxed agent's files go
 *      to its VM home with /root paths;
 *   5. the real git + gh with that env: the credential helper beats an operator helper, ssh remotes become https,
 *      commits are authored by `<slug>[bot]`, `gh auth token` reads the token and follows a re-mint.
 * Run: pnpm check:github-identity
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-ghid-")));
process.env.PAW_HOME = home;
delete process.env.PAW_GITHUB_TEAM_POLL_MS;
const A = await import("../src/github-app.ts");
const T = await import("../src/github-teams.ts");
const R = await import("../src/github-relay.ts");
const C = await import("../src/commands/github.ts");

let failures = 0;
const ok = (label: string, cond: boolean, detail: unknown = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
};
const rejects = async (f: () => Promise<unknown>, re: RegExp) => {
  try {
    await f();
    return "did not throw";
  } catch (e) {
    return re.test((e as Error).message) ? "" : (e as Error).message;
  }
};

const SPACE = "test-ghid";
const persona = (name: string, fields: Record<string, string> = {}) => {
  const dir = join(home, "spaces", SPACE, "personas");
  mkdirSync(dir, { recursive: true });
  const folder = join(home, "folders", name);
  mkdirSync(folder, { recursive: true });
  const fm = Object.entries({ cwd: folder, ...fields }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${fm.join("\n")}\n---\n${name}\n`);
  return join(dir, `${name}.md`);
};

// ── 1. org config ──
ok("no org: teams fail loud with the fix", (await rejects(async () => A.orgOrThrow(), /paw github org <org>/)) === "");
ok("a bad org name is refused", (await rejects(async () => A.assertOrg("-bad/"), /not a GitHub organization/)) === "");
A.updateConfig((c) => void (c.org = "acme"));
ok("org set and read back", A.orgOrThrow() === "acme" && A.orgOrThrow("other") === "other");

// ── fake gh api (REST) ──
interface FakeTeam {
  name: string;
  slug: string;
  privacy: string;
  members: string[];
}
const gh = {
  teams: [{ name: "Evals-Intern", slug: "evals-intern", privacy: "closed", members: ["op"] }] as FakeTeam[],
  calls: [] as string[],
  failCreate: undefined as string | undefined,
  keepMember: false,
  searchDown: false,
  issues: [] as { repo: string; number: number; pr: boolean; body: string; user: string; created_at: string; updated_at: string; id: number; teams: string[] }[],
  comments: [] as { kind: "ic" | "rc" | "rv"; repo: string; number: number; id: number; body: string; user: string; at: string }[],
};
const fakeRest: import("../src/github-teams.ts").Rest = async (method, path, fields) => {
  gh.calls.push(`${method} ${path}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "user") return { login: "op" };
  if (method === "GET" && (m = path.match(/^orgs\/acme\/teams\?per_page=100&page=(\d+)$/))) return Number(m[1]) === 1 ? gh.teams.map(({ name, slug }) => ({ name, slug })) : [];
  if (method === "POST" && path === "orgs/acme/teams") {
    if (fields!.name === gh.failCreate) throw new Error("gh api POST orgs/acme/teams failed: HTTP 422 Validation Failed");
    const t = { name: fields!.name!, slug: fields!.name!.toLowerCase(), privacy: fields!.privacy!, members: ["op"] };
    gh.teams.push(t);
    return { name: t.name, slug: t.slug };
  }
  if (method === "DELETE" && (m = path.match(/^orgs\/acme\/teams\/([^/]+)\/memberships\/(.+)$/))) {
    const t = gh.teams.find((x) => x.slug === m![1])!;
    if (!gh.keepMember) t.members = t.members.filter((x) => x !== m![2]);
    return undefined;
  }
  if (method === "GET" && (m = path.match(/^orgs\/acme\/teams\/([^/]+)\/members/))) return gh.teams.find((x) => x.slug === m![1])!.members.map((login) => ({ login }));
  if (method === "GET" && path.startsWith("search/issues?")) {
    if (gh.searchDown) throw new Error("gh api GET search/issues failed: HTTP 403 rate limited");
    const q = decodeURIComponent(path.match(/q=([^&]+)/)![1]!);
    const team = q.match(/team:acme\/(\S+)/)![1]!;
    const since = q.match(/updated:>=(\S+)/)![1]!;
    return {
      items: gh.issues
        .filter((i) => i.teams.includes(team) && i.updated_at >= since)
        .map((i) => ({ id: i.id, number: i.number, html_url: `https://github.com/${i.repo}/${i.pr ? "pull" : "issues"}/${i.number}`, repository_url: `https://api.github.com/repos/${i.repo}`, body: i.body, user: { login: i.user }, created_at: i.created_at, ...(i.pr ? { pull_request: {} } : {}) })),
    };
  }
  if (method === "GET" && (m = path.match(/^repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)\/(comments|reviews)/))) {
    const kind = m[2] === "issues" ? "ic" : m[4] === "comments" ? "rc" : "rv";
    const since = path.match(/since=([^&]+)/)?.[1];
    const sinceIso = since ? decodeURIComponent(since) : "";
    const frag = kind === "ic" ? "issuecomment" : kind === "rc" ? "discussion_r" : "pullrequestreview";
    return gh.comments
      .filter((c) => c.kind === kind && c.repo === m![1] && c.number === Number(m![3]) && c.at >= sinceIso)
      .map((c) => ({ id: c.id, body: c.body, user: { login: c.user }, html_url: `https://github.com/${c.repo}/pull/${c.number}#${frag}${kind === "rc" ? "" : "-"}${c.id}`, ...(kind === "rv" ? { submitted_at: c.at } : { updated_at: c.at, created_at: c.at }) }));
  }
  throw new Error(`fake gh: unexpected ${method} ${path}`);
};

// ── 2. teams ──
persona("evals-intern");
persona("pm");
persona("devops");
const lines: string[] = [];
const out = (l: string) => lines.push(l);
await C.teams({ positionals: [] }, SPACE, fakeRest, out);
ok("dry run: existing team (other case) left alone, the rest would be created", lines.some((l) => l.startsWith("✓ evals-intern: @acme/evals-intern exists")) && lines.some((l) => l === "+ devops: would create @acme/devops (closed, no members)") && lines.some((l) => l === "+ pm: would create @acme/pm (closed, no members)") && lines.at(-1) === "dry run: 2 team(s) to create — again with --apply", lines);
ok("dry run calls nothing but the team list", gh.calls.every((c) => c.startsWith("GET orgs/acme/teams?")), gh.calls);
gh.calls.length = 0;
lines.length = 0;
gh.failCreate = "pm";
const failed = await rejects(() => C.teams({ positionals: [], apply: true }, SPACE, fakeRest, out), /creating the team for pm failed: .*HTTP 422.*\(created before it: devops\)/);
ok("an API error fails loud, naming what was created before it", failed === "", failed);
gh.failCreate = undefined;
lines.length = 0;
await C.teams({ positionals: [], apply: true }, SPACE, fakeRest, out);
const pm = gh.teams.find((t) => t.slug === "pm")!;
const dv = gh.teams.find((t) => t.slug === "devops")!;
ok("--apply made the missing team closed with no members (creator's seat removed)", pm.privacy === "closed" && pm.members.length === 0 && dv.members.length === 0, gh.teams);
ok("the existing team was not touched (its member stays)", gh.teams.find((t) => t.slug === "evals-intern")!.members.join() === "op");
ok("devops was not made twice", gh.teams.filter((t) => t.slug === "devops").length === 1);
lines.length = 0;
gh.calls.length = 0;
await C.teams({ positionals: [], apply: true }, SPACE, fakeRest, out);
ok("a second --apply is a no-op", lines.at(-1) === "nothing to create" && !gh.calls.some((c) => c.startsWith("POST")), lines);

// --exclude: names and * globs drop agents from the plan; a pattern list that drops everyone fails loud
const skip = C.excludeMatcher("beads-*,agent.browser,pm");
ok("--exclude matches globs and exact names, and escapes regex characters", skip("beads-vbx4-125-3-17") && skip("pm") && !skip("pmx") && !skip("agentxbrowser") && skip("agent.browser") && !skip("devops"));
ok("--exclude refuses an empty pattern", (await rejects(async () => C.excludeMatcher("a,,b"), /empty pattern/)) === "");
const beadsPersona = persona("beads-oowr");
lines.length = 0;
gh.calls.length = 0;
await C.teams({ positionals: [], exclude: "beads-*" }, SPACE, fakeRest, out);
ok("--exclude beads-* leaves the beads agent out of the dry run", lines.includes("- beads-oowr: excluded") && !lines.some((l) => l.startsWith("+ beads-oowr")), lines);
ok("--exclude that leaves nothing fails loud", (await rejects(() => C.teams({ positionals: [], exclude: "*" }, SPACE, fakeRest, out), /leaves no agents/)) === "");
rmSync(beadsPersona);
persona("ops2");
gh.keepMember = true;
ok("a member left behind fails loud", (await rejects(() => C.teams({ positionals: [], apply: true }, SPACE, fakeRest, out), /still has 1 member/)) === "");
gh.keepMember = false;

// ── 3. mentions ──
let now = Date.parse("2026-11-24T10:00:00Z");
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const sent: { agent: string; text: string }[] = [];
const logs: string[] = [];
const cfgOf = () => ({ org: "acme", apps: { "evals-intern": { space: SPACE, appId: "1", installationId: "2", slug: "acme-evals-intern", botId: 9, where: "host" as const } } });
const deps = {
  gh: async () => ({ data: {} }),
  rest: fakeRest,
  config: cfgOf,
  now: () => now,
  send: async (_s: string, agent: string, text: string) => void sent.push({ agent, text }),
  machineOf: () => "here",
  log: (l: string) => logs.push(l),
  checkout: () => undefined,
};
const sweep = async () => {
  sent.length = 0;
  gh.calls.length = 0;
  await R.githubSweep(deps);
};
gh.issues.push({ repo: "acme/evals", number: 5, pr: true, body: "old", user: "op", created_at: iso(now - 86400e3), updated_at: iso(now - 60e3), id: 500, teams: ["evals-intern"] });
gh.comments.push({ kind: "ic", repo: "acme/evals", number: 5, id: 1, body: "@acme/evals-intern old tag", user: "op", at: iso(now - 60e3) });
await sweep();
ok("first poll baselines: no search, nothing sent", sent.length === 0 && !gh.calls.some((c) => c.includes("search/issues")), gh.calls);
const cur = R.readStore().teams!;
ok("every team with an agent has a cursor", ["devops", "evals-intern", "ops2", "pm"].every((s) => cur.cursors[s]), Object.keys(cur.cursors));
now += 30_000;
await sweep();
ok("the poll interval holds (2 min): no call 30s later", !gh.calls.some((c) => c.includes("search/issues")));
now += 120_000;
gh.issues[0]!.updated_at = iso(now - 5_000);
gh.comments.push(
  { kind: "rc", repo: "acme/evals", number: 5, id: 11, body: "nit — @acme/evals-intern can you fix this?", user: "caffeinum", at: iso(now - 5_000) },
  { kind: "ic", repo: "acme/evals", number: 5, id: 12, body: "cc @acme/evals-intern-two", user: "caffeinum", at: iso(now - 5_000) },
  { kind: "ic", repo: "acme/evals", number: 5, id: 13, body: "done @ACME/evals-intern", user: "acme-evals-intern[bot]", at: iso(now - 4_000) },
  { kind: "rv", repo: "acme/evals", number: 5, id: 14, body: "@acme/evals-intern approve when green", user: "rev", at: iso(now - 3_000) },
);
gh.issues.push({ repo: "acme/evals", number: 6, pr: false, body: "please look, @acme/evals-intern", user: "pmuser", created_at: iso(now - 2_000), updated_at: iso(now - 2_000), id: 600, teams: ["evals-intern"] });
await sweep();
const ei = sent.filter((s) => s.agent === "evals-intern").map((s) => s.text);
ok("a review comment → one DM: who, where, URL", ei.includes("you were tagged by caffeinum in acme/evals#5\nhttps://github.com/acme/evals/pull/5#discussion_r11"), ei);
ok("a review body → one DM", ei.includes("you were tagged by rev in acme/evals#5\nhttps://github.com/acme/evals/pull/5#pullrequestreview-14"), ei);
ok("a new issue's body → one DM", ei.includes("you were tagged by pmuser in acme/evals#6\nhttps://github.com/acme/evals/issues/6"), ei);
ok("not: a lookalike team, the agent's own bot, a comment from before the baseline", ei.length === 3, ei);
ok("nobody else is told", sent.every((s) => s.agent === "evals-intern"), sent);
now += 130_000;
await sweep();
ok("the overlap re-read sends nothing twice", sent.length === 0, sent);
// batch rotation: 12 more agents with teams → 16 teams, 10 per poll
for (let i = 0; i < 12; i++) {
  persona(`a${i}`);
  gh.teams.push({ name: `a${i}`, slug: `a${i}`, privacy: "closed", members: [] });
}
R.updateStore((s) => void (s.teams!.listedAt = 0));
now += 130_000;
await sweep(); // baselines the new ones in this batch
now += 130_000;
await sweep(); // …and the rest in the next
ok("a team new to the poll is baselined on its first turn", Object.keys(R.readStore().teams!.cursors).length === 16, Object.keys(R.readStore().teams!.cursors).length);
now += 130_000;
await sweep();
const first = gh.calls.filter((c) => c.includes("search/issues")).length;
now += 130_000;
await sweep();
const second = gh.calls.filter((c) => c.includes("search/issues")).length;
ok(`at most ${T.BATCH} team searches per poll, rotating`, first === T.BATCH && second === T.BATCH, { first, second });
gh.searchDown = true;
logs.length = 0;
const before = JSON.stringify(R.readStore().teams!.cursors);
now += 130_000;
await sweep();
gh.searchDown = false;
ok("a failed search is said, and no cursor moves", logs.some((l) => l.includes("HTTP 403 rate limited")) && JSON.stringify(R.readStore().teams!.cursors) === before, logs);

// ── 4. Apps ──
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pemText = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const download = join(home, "downloads", "acme-evals-intern.2026-11-24.private-key.pem");
mkdirSync(join(home, "downloads"));
writeFileSync(download, pemText, { mode: 0o644 });
const jwtOk = (jwt: string, iss: string | null = "101") => {
  const [h, b, s] = jwt.split(".");
  const head = JSON.parse(Buffer.from(h!, "base64url").toString());
  const body = JSON.parse(Buffer.from(b!, "base64url").toString()) as { iat: number; exp: number; iss: string };
  return head.alg === "RS256" && (iss === null || body.iss === iss) && body.exp - body.iat === 600 && verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s!, "base64url"));
};
let tokenN = 0;
let expiresIn = 3600_000;
const hits: string[] = [];
const server = createServer((req, res) => {
  const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  hits.push(`${req.method} ${req.url}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/app") return jwtOk(auth, null) ? send(200, { id: 101, slug: "acme-evals-intern" }) : send(401, { message: "bad JWT" });
  if (req.method === "POST" && req.url === "/app/installations/202/access_tokens") {
    if (!jwtOk(auth)) return send(401, { message: "bad JWT" });
    return send(201, { token: `ghs_test${++tokenN}`, expires_at: new Date(Date.now() + expiresIn).toISOString() });
  }
  if (req.method === "POST" && req.url?.startsWith("/app/installations/")) return send(404, { message: "Not Found" });
  if (req.method === "GET" && req.url === "/users/acme-evals-intern%5Bbot%5D") return auth.startsWith("ghs_") ? send(200, { id: 424242, login: "acme-evals-intern[bot]" }) : send(401, {});
  if (req.method === "GET" && req.url === "/installation/repositories?per_page=100") return auth.startsWith("ghs_") ? send(200, { total_count: 2, repositories: [{ full_name: "acme/evals" }, { full_name: "acme/canary" }] }) : send(401, { message: "token needed" });
  send(404, { message: `stub: no ${req.method} ${req.url}` });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.PAW_GITHUB_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

ok("the JWT is RS256 {iat, exp, iss} and verifies", jwtOk(A.appJwt("101", A.loadKey(download))));
ok("a non-key file is refused, its content unsaid", (await rejects(async () => A.loadKey(persona("x")), /is not a PEM private key/)) === "");
const kitPersona = persona("kitty", { agent: "kit" });
ok("a kit agent is refused", (await rejects(() => C.appSet({ positionals: [], appId: "101", installationId: "202", key: download }, SPACE, "kitty", A.githubHttp, () => {}), /kit agent — App identities reach claude agents only/)) === "");
void kitPersona;
const otherApp = await rejects(() => C.appSet({ positionals: [], appId: "999", installationId: "202", key: download }, SPACE, "evals-intern", A.githubHttp, () => {}), /belongs to App 101/);
ok("a key of another App is refused", otherApp === "", otherApp);
persona("clash", { claudeArgs: '["--settings","/elsewhere.json"]' });
ok("a clashing --settings is refused", (await rejects(() => C.appSet({ positionals: [], appId: "101", installationId: "202", key: download }, SPACE, "clash", A.githubHttp, () => {}), /already pass --settings \/elsewhere.json/)) === "");
ok("missing --installation-id fails loud", (await rejects(() => C.appSet({ positionals: [], appId: "101", key: download }, SPACE, "evals-intern"), /--installation-id/)) === "");

const evalsPersona = persona("evals-intern", { claudeArgs: '["--model","opus"]' });
const said: string[] = [];
await C.appSet({ positionals: [], appId: "101", installationId: "202", key: download }, SPACE, "evals-intern", A.githubHttp, (l) => said.push(l));
const kept = A.keyPathFor("evals-intern");
const dir = join(home, "github-apps", "evals-intern");
const mode = (p: string) => statSync(p).mode & 0o777;
ok("the key is kept 0600 in a 0700 dir", mode(kept) === 0o600 && mode(join(home, "secrets", "github-apps")) === 0o700 && readFileSync(kept, "utf8") === pemText);
ok("the key is never printed", !said.join("\n").includes("PRIVATE KEY") && !said.join("\n").includes(pemText.split("\n")[1]!), said);
ok("token files are 0600 in a 0700 dir", mode(dir) === 0o700 && ["token", "gh/hosts.yml", "token.json", "claude-settings.json"].every((f) => mode(join(dir, f)) === 0o600));
ok("the token is the minted one; the key is not beside it", readFileSync(join(dir, "token"), "utf8") === "ghs_test1\n" && !readFileSync(join(dir, "claude-settings.json"), "utf8").includes("PRIVATE"));
const cfg = A.readConfig().apps["evals-intern"]!;
ok("config: slug + bot id learned", cfg.slug === "acme-evals-intern" && cfg.botId === 424242 && cfg.where === "host" && cfg.space === SPACE, cfg);
const claudeArgs = readFileSync(evalsPersona, "utf8").match(/^claudeArgs: (.*)$/m)?.[1];
ok("persona claudeArgs keeps its flags and gains --settings", claudeArgs === JSON.stringify(["--model", "opus", "--settings", join(dir, "claude-settings.json")]), claudeArgs);
ok("it says the restart is the operator's", said.some((l) => l.includes("takes effect at its next start") && l.includes("paw never restarts it")), said);
const env = (JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8")) as { env: Record<string, string> }).env;
ok("settings env: gh dir, bot author + committer", env.GH_CONFIG_DIR === join(dir, "gh") && env.GIT_AUTHOR_NAME === "acme-evals-intern[bot]" && env.GIT_COMMITTER_EMAIL === "424242+acme-evals-intern[bot]@users.noreply.github.com", env);
await C.appSet({ positionals: [], appId: "101", installationId: "202", key: kept }, SPACE, "evals-intern", A.githubHttp, () => {});
ok("set again (key already kept): idempotent claudeArgs", readFileSync(evalsPersona, "utf8").match(/^claudeArgs: (.*)$/m)?.[1] === claudeArgs);

const tested: string[] = [];
hits.length = 0;
await C.appTest("evals-intern", A.githubHttp, (l) => tested.push(l));
ok("app test: mints, then lists repos with the token (read-only)", tested[1]?.includes("2 repositories: acme/evals, acme/canary") === true && hits.join() === "POST /app/installations/202/access_tokens,GET /installation/repositories?per_page=100", { tested, hits });
ok("app test of an unregistered agent fails loud", (await rejects(() => C.appTest("pm"), /has no App/)) === "");

hits.length = 0;
let r = await A.refreshTokens();
ok("a fresh token is not re-minted", r.minted.length === 0 && hits.length === 0, r);
r = await A.refreshTokens(A.githubHttp, Date.now() + 50 * 60_000);
ok("within 15 min of expiry it is re-minted and rewritten", r.minted.join() === "evals-intern" && readFileSync(join(dir, "token"), "utf8").startsWith("ghs_test") && readFileSync(join(dir, "gh", "hosts.yml"), "utf8").includes(readFileSync(join(dir, "token"), "utf8").trim()), r);
A.updateConfig((c) => void (c.apps["evals-intern"]!.installationId = "303"));
r = await A.refreshTokens(A.githubHttp, Date.now() + 59 * 60_000);
ok("a failing mint is a problem line, not a throw", r.problems.length === 1 && /NOT refreshed: GitHub POST \/app\/installations\/303\/access_tokens: HTTP 404 Not Found/.test(r.problems[0]!), r);
A.updateConfig((c) => void (c.apps["evals-intern"]!.installationId = "202"));

// sandboxed: files in its VM home, paths under /root
mkdirSync(join(home, "containers", "boxed"), { recursive: true });
const boxed = persona("boxed", { sandbox: "container" });
await C.appSet({ positionals: [], appId: "101", installationId: "202", key: download }, SPACE, "boxed", A.githubHttp, () => {});
const vmDir = join(home, "containers", "boxed", ".paw-github");
const vmEnv = (JSON.parse(readFileSync(join(vmDir, "claude-settings.json"), "utf8")) as { env: Record<string, string> }).env;
ok("sandboxed: the token is in its VM home", readFileSync(join(vmDir, "token"), "utf8").startsWith("ghs_test"));
ok("sandboxed: settings + env use /root paths", readFileSync(boxed, "utf8").includes('"--settings","/root/.paw-github/claude-settings.json"') && vmEnv.GH_CONFIG_DIR === "/root/.paw-github/gh" && vmEnv.GIT_CONFIG_VALUE_1!.includes("'/root/.paw-github/token'"), vmEnv);
let keyInVm = "";
try {
  keyInVm = execFileSync("grep", ["-rl", "PRIVATE KEY", join(home, "containers")], { encoding: "utf8" });
} catch {
  keyInVm = "";
}
ok("sandboxed: no private key anywhere under the VM homes", keyInVm === "", keyInVm);

// ── 5. the real git + gh with that env ──
const scratch = join(home, "scratch");
mkdirSync(scratch);
const fakeHome = join(scratch, "home");
mkdirSync(fakeHome);
writeFileSync(join(fakeHome, ".gitconfig"), `[credential]\n\thelper = "!f() { echo username=operator; echo password=OPERATOR_SECRET; }; f"\n[credential "https://github.com"]\n\thelper = "!f() { echo username=operator; echo password=OPERATOR_GH; }; f"\n`);
const base = { PATH: process.env.PATH!, HOME: fakeHome, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const run = (cmd: string, args: string[], extra: Record<string, string> = env, input?: string) => execFileSync(cmd, args, { cwd: scratch, env: { ...base, ...extra }, encoding: "utf8", ...(input ? { input } : {}) });
const fill = run("git", ["credential", "fill"], env, "protocol=https\nhost=github.com\npath=acme/evals.git\n\n");
const tokenNow = readFileSync(join(dir, "token"), "utf8").trim();
ok("git: the bot's token answers, not the operator's helpers", fill.includes(`password=${tokenNow}`) && fill.includes("username=x-access-token") && !fill.includes("OPERATOR"), fill);
ok("git without that env still asks the operator's (the check is real)", run("git", ["credential", "fill"], {}, "protocol=https\nhost=github.com\n\n").includes("OPERATOR"));
run("git", ["init", "-q", "repo"]);
const repo = join(scratch, "repo");
const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...base, ...env }, encoding: "utf8" }).trim();
g(["remote", "add", "origin", "git@github.com:acme/evals.git"]);
ok("git: an ssh remote is rewritten to https", g(["remote", "get-url", "--push", "origin"]) === "https://github.com/acme/evals.git" || g(["ls-remote", "--get-url", "origin"]) === "https://github.com/acme/evals.git", g(["ls-remote", "--get-url", "origin"]));
g(["commit", "-q", "--allow-empty", "-m", "x"]);
ok("git: commits are authored and committed by the bot", g(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]) === "acme-evals-intern[bot] <424242+acme-evals-intern[bot]@users.noreply.github.com>|acme-evals-intern[bot] <424242+acme-evals-intern[bot]@users.noreply.github.com>");
let ghBin = "";
try {
  ghBin = execFileSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).trim();
} catch {
  ghBin = "";
}
if (!ghBin) ok("gh is installed (needed for the gh half of this check)", false);
else {
  const ghTok = () => run(ghBin, ["auth", "token"]).trim();
  ok("gh: `gh auth token` reads the bot's token", ghTok() === tokenNow, ghTok());
  await A.refreshTokens(A.githubHttp, Date.now() + 59 * 60_000);
  const after = readFileSync(join(dir, "token"), "utf8").trim();
  ok("gh: a re-mint is picked up with no restart, and gh leaves hosts.yml alone", after !== tokenNow && ghTok() === after && readFileSync(join(dir, "gh", "hosts.yml"), "utf8").includes(`oauth_token: ${after}`));
}

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall github identity checks passed 🐙");
process.exit(failures ? 1 : 0);
