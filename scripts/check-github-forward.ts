/**
 * Hermetic check for GitHub team tags by push (src/github-forward.ts, docs/notes/messaging.md#github-forward).
 * Nothing reaches github.com: a stub `gh` stands in for `gh webhook forward` — it prints gh's "Forwarding…" line,
 * then POSTs the fixture deliveries dropped in its queue dir to the receiver, signed with the `--secret` it was
 * given (or a wrong one), and exits when told to (as a websocket drop does). Asserted:
 *   1. `paw github forward on|off|status`: refused without an org; on makes the secret 0600 and records the space;
 *   2. the stub is run with --org, the five events, a 127.0.0.1 URL and the secret; the status says up;
 *   3. a delivery with a bad signature is rejected (401, logged) and DMs nobody;
 *   4. a team tag in an issue comment, a review body and a review comment each DMs the agent ONCE (the poller's
 *      text); a redelivery of the same comment sends nothing;
 *   5. a tag by the agent's own bot or `github:` login is skipped; a team no agent here owns is ignored;
 *   6. the poller and the push share one seen set: what the push sent, a later poll does not resend; what the
 *      poll sent, a later push does not resend;
 *   7. while the forwarder is up the keeper polls only to reconcile; when gh exits it is said once, the status
 *      goes down, the keeper polls at the 2-min pace again (logged), and gh is started again with backoff;
 *   8. "a hook already exists" is said plainly and the status says conflict;
 *   9. the secret never appears in a log line; `forward off` stops the stub;
 *  10. 👀 on a delivered tag: an issue comment, a review comment and an issue body each hit their own reactions
 *      endpoint; a review gets none (said); the agent's App bot reacts with its token when it has one, else the
 *      operator's gh; a tag found by the poll reacts after its outbox send; once per comment + team; a failed
 *      reaction is said once and the DM still goes; `paw github react off` = no call;
 *  11. gh-webhook's exit (cobra: `Error: …` then the whole usage) is logged as its error line, not the usage.
 * Run: pnpm check:github-forward
 */
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-ghfwd-")));
process.env.PAW_HOME = home;
delete process.env.PAW_GITHUB_TEAM_POLL_MS;
const A = await import("../src/github-app.ts");
const R = await import("../src/github-relay.ts");
const F = await import("../src/github-forward.ts");
const S = await import("../src/github-forward-status.ts");
const C = await import("../src/commands/github.ts");

let failures = 0;
const ok = (label: string, cond: boolean, detail: unknown = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
};
const until = async (cond: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

const SPACE = `test-ghfwd-${process.pid}`;
const persona = (name: string, fields: Record<string, string> = {}) => {
  const dir = join(home, "spaces", SPACE, "personas");
  mkdirSync(dir, { recursive: true });
  const folder = join(home, "folders", name);
  mkdirSync(folder, { recursive: true });
  const fm = Object.entries({ cwd: folder, ...fields }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${fm.join("\n")}\n---\n${name}\n`);
};
persona("evals-intern", { github: "intern-human" });
persona("pm");

// ── the stub gh ──
const stubDir = join(home, "stub");
const queue = join(stubDir, "queue");
mkdirSync(queue, { recursive: true });
const stub = join(stubDir, "gh");
writeFileSync(
  stub,
  `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const dir = ${JSON.stringify(stubDir)};
const arg = (k) => process.argv.find((a) => a.startsWith("--" + k + "="))?.slice(k.length + 3);
fs.appendFileSync(path.join(dir, "runs.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync(path.join(dir, "conflict"))) {
  process.stderr.write("error creating webhook: HTTP 422: Validation Failed (https://api.github.com/orgs/acme/hooks)\\nHook already exists on this organization\\n");
  process.exit(1);
}
const url = arg("url"), secret = arg("secret");
process.stderr.write("Forwarding Webhook events from GitHub...\\n");
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  if (fs.existsSync(path.join(dir, "exit"))) {
    fs.rmSync(path.join(dir, "exit"));
    process.stderr.write("Error: error receiving json event: websocket: close 1006 (abnormal closure): unexpected EOF\\nUsage:\\n  forward --events=<types> [--url=<url>] [flags]\\n\\nExamples:\\n# create a dev webhook\\n\\n$ gh webhook forward --events=issues --org=github --url=\\"http://localhost:9999/webhooks\\"\\n\\nFlags:\\n  -R, --repo string          Name of the repo where the webhook is installed\\n  -S, --secret string        Webhook secret for incoming events\\n  -U, --url string           Address of the local server to receive events.\\n");
    process.exit(1);
  }
  for (const f of fs.readdirSync(path.join(dir, "queue")).sort()) {
    const p = path.join(dir, "queue", f);
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    fs.rmSync(p);
    const body = JSON.stringify(d.payload);
    const sig = "sha256=" + crypto.createHmac("sha256", d.badSig ? "not-the-secret" : secret).update(body).digest("hex");
    const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": d.event, "x-hub-signature-256": sig } });
    fs.appendFileSync(path.join(dir, "answers.jsonl"), JSON.stringify({ f, status: r.status }) + "\\n");
  }
  busy = false;
}, 40);
`,
);
chmodSync(stub, 0o755);
let seq = 0;
const deliver = (event: string, payload: unknown, badSig = false) => writeFileSync(join(queue, `${String(++seq).padStart(4, "0")}.json`), JSON.stringify({ event, payload, badSig }));
const answers = () => (existsSync(join(stubDir, "answers.jsonl")) ? readFileSync(join(stubDir, "answers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { f: string; status: number }) : []);
const runs = () => (existsSync(join(stubDir, "runs.jsonl")) ? readFileSync(join(stubDir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const drained = () => until(() => readdirSync(queue).length === 0 && answers().length === seq);

// ── fake REST (team list + the poller's search) ──
const restState = { comments: [] as { id: number; body: string; user: string; at: string }[], searches: 0, reactions: [] as string[], failReact: false };
const botReactions: string[] = [];
const fakeHttp: import("../src/github-app.ts").Http = async (method, path, auth, body) => {
  botReactions.push(`${method} ${path} ${auth} ${JSON.stringify(body)}`);
  return {};
};
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const fakeRest: import("../src/github-teams.ts").Rest = async (method, path, fields) => {
  if (method === "POST" && path.endsWith("/reactions")) {
    if (restState.failReact) throw new Error("gh api POST reactions failed: HTTP 403 Resource not accessible");
    restState.reactions.push(`${path} ${JSON.stringify(fields)}`);
    return {};
  }
  if (method === "GET" && path.startsWith("orgs/acme/teams?")) return path.endsWith("page=1") ? [{ name: "evals-intern", slug: "evals-intern" }, { name: "pm", slug: "pm" }, { name: "nobody", slug: "nobody" }] : [];
  if (method === "GET" && path.startsWith("search/issues?")) {
    restState.searches++;
    const team = decodeURIComponent(path).match(/team:acme\/(\S+)/)![1];
    return { items: team === "evals-intern" && restState.comments.length ? [{ id: 900, number: 5, html_url: "https://github.com/acme/evals/pull/5", repository_url: "https://api.github.com/repos/acme/evals", body: "", user: { login: "op" }, created_at: "2020-01-01T00:00:00Z", pull_request: {} }] : [] };
  }
  if (method === "GET" && /^repos\/acme\/evals\/issues\/5\/comments/.test(path))
    return restState.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user }, html_url: `https://github.com/acme/evals/pull/5#issuecomment-${c.id}`, updated_at: c.at, created_at: c.at }));
  if (method === "GET" && /^repos\/acme\/evals\/pulls\/5\/(comments|reviews)/.test(path)) return [];
  throw new Error(`fake gh: unexpected ${method} ${path}`);
};

// ── 1. the command ──
const lines: string[] = [];
const out = (l: string) => lines.push(l);
let threw = "";
try {
  C.forward({ positionals: ["on"] }, SPACE, out, () => {});
} catch (e) {
  threw = (e as Error).message;
}
ok("forward on without an org fails loud", /paw github org <org>/.test(threw), threw);
A.updateConfig((c) => {
  c.org = "acme";
  c.apps["evals-intern"] = { space: SPACE, appId: "1", installationId: "2", slug: "acme-evals-intern", botId: 9, where: "host" };
});
A.writeToken("evals-intern", A.readConfig().apps["evals-intern"]!, { token: "BOT_TOKEN", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
C.forward({ positionals: ["on"] }, SPACE, out, () => {});
const secret = readFileSync(F.secretPath(), "utf8").trim();
ok("forward on records the space and makes a 0600 secret", A.readConfig().forward?.space === SPACE && (statSync(F.secretPath()).mode & 0o777) === 0o600 && /^[0-9a-f]{64}$/.test(secret));
ok("forward on never prints the secret", !lines.join("\n").includes(secret));
lines.length = 0;
C.forward({ positionals: ["status"] }, SPACE, out, () => {});
ok("status before the mailbox ran: on, never ran, not healthy", lines[0]!.startsWith("on: the mailbox of space") && /never ran/.test(lines[1]!) && /not healthy/.test(lines[2]!), lines);

// ── 2. the supervisor with the stub ──
let now = Date.now();
const sent: { agent: string; text: string }[] = [];
const logs: string[] = [];
const log = (l: string) => logs.push(l);
const deps = {
  send: async (_s: string, agent: string, text: string) => void sent.push({ agent, text }),
  log,
  machineOf: () => "here",
  gh: () => stub,
  rest: () => fakeRest,
  http: fakeHttp,
  now: () => now,
  rescanMs: 100,
  beatMs: 100,
  backoffMinMs: 150,
  backoffMaxMs: 400,
};
const stop = F.startGithubForward(SPACE, deps);
ok("the forwarder comes up", await until(() => S.readForwardStatus()?.state === "up"), S.readForwardStatus());
const argv = runs()[0] ?? [];
const url = argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "";
ok("gh is run as `webhook forward --org=acme` with the five events, a loopback URL and the secret", argv[0] === "webhook" && argv[1] === "forward" && argv.includes("--org=acme") && argv.includes("--events=issue_comment,pull_request_review,pull_request_review_comment,issues,pull_request") && /^http:\/\/127\.0\.0\.1:\d+\/github$/.test(url) && argv.includes(`--secret=${secret}`), argv);
ok("healthy: the status file says up for acme", S.forwardHealthy("acme", now));

// ── 3. bad signature ──
const repo = { full_name: "acme/evals", owner: { login: "acme" } };
const comment = (id: number, body: string, user: string) => ({ id, body, user: { login: user }, html_url: `https://github.com/acme/evals/pull/5#issuecomment-${id}` });
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(1, "@acme/evals-intern forged", "mallory") }, true);
await drained();
ok("a bad signature is rejected (401) and DMs nobody", answers().at(-1)?.status === 401 && sent.length === 0 && logs.some((l) => /REJECTED: bad or missing signature/.test(l)), { a: answers(), sent });
const direct = await new Promise<number>((resolve) => {
  const req = request(url, { method: "POST", headers: { "x-github-event": "issue_comment" } }, (res) => resolve(res.statusCode ?? 0));
  req.end("{}");
});
ok("an unsigned POST is rejected too", direct === 401);

// ── 4/5. tags ──
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(2, "can you look, @acme/evals-intern?", "caffeinum") });
deliver("pull_request_review", { action: "submitted", repository: repo, pull_request: { number: 5 }, review: { id: 3, body: "@ACME/evals-intern approve when green", user: { login: "rev" }, html_url: "https://github.com/acme/evals/pull/5#pullrequestreview-3" } });
deliver("pull_request_review_comment", { action: "created", repository: repo, pull_request: { number: 5 }, comment: { id: 4, body: "nit — @acme/pm and @acme/evals-intern", user: { login: "caffeinum" }, html_url: "https://github.com/acme/evals/pull/5#discussion_r4" } });
deliver("issue_comment", { action: "edited", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(2, "can you look, @acme/evals-intern? (edited)", "caffeinum") });
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(6, "done @acme/evals-intern", "acme-evals-intern[bot]") });
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(7, "done @acme/evals-intern", "intern-human") });
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(8, "cc @acme/nobody @acme/evals-intern-two", "caffeinum") });
await drained();
await until(() => sent.length >= 4, 2_000);
await new Promise((r) => setTimeout(r, 200));
const ei = sent.filter((s) => s.agent === "evals-intern").map((s) => s.text);
ok("an issue comment tag → one DM", ei.filter((t) => t === "you were tagged by caffeinum in acme/evals#5\nhttps://github.com/acme/evals/pull/5#issuecomment-2").length === 1, ei);
ok("a review body tag → one DM", ei.filter((t) => t === "you were tagged by rev in acme/evals#5\nhttps://github.com/acme/evals/pull/5#pullrequestreview-3").length === 1, ei);
ok("a review comment tag → one DM to each tagged agent", ei.filter((t) => t.endsWith("#discussion_r4")).length === 1 && sent.filter((s) => s.agent === "pm" && s.text.endsWith("#discussion_r4")).length === 1, sent);
ok("the edit of a sent comment, the agent's own bot, its github: login and a team nobody here owns send nothing", sent.length === 4, sent);

// ── 10a. 👀 on what was delivered ──
const eyes = JSON.stringify({ content: "eyes" });
ok("an issue comment tag → the bot reacts on issues/comments/{id} with its own token", botReactions.filter((c) => c === `POST /repos/acme/evals/issues/comments/2/reactions BOT_TOKEN ${eyes}`).length === 1, botReactions);
ok("a review comment tag → pulls/comments/{id}: the bot for evals-intern, the operator's gh for pm (no App)", botReactions.includes(`POST /repos/acme/evals/pulls/comments/4/reactions BOT_TOKEN ${eyes}`) && restState.reactions.filter((c) => c === `repos/acme/evals/pulls/comments/4/reactions ${eyes}`).length === 1, { botReactions, rest: restState.reactions });
ok("a review gets no reaction, and that is said", !botReactions.some((c) => /reviews|\/3\//.test(c)) && logs.some((l) => /no 👀 on .*pullrequestreview-3: GitHub has no reactions on a review/.test(l)), logs);
ok("nothing reacted for the skipped tags (edit, own bot, own login, foreign team)", botReactions.length === 2 && restState.reactions.length === 1, { botReactions, rest: restState.reactions });
deliver("issues", { action: "opened", repository: repo, issue: { id: 777, number: 9, body: "@acme/pm please triage", user: { login: "caffeinum" }, html_url: "https://github.com/acme/evals/issues/9" } });
await drained();
ok("an issue body tag → issues/{number}/reactions", await until(() => restState.reactions.includes(`repos/acme/evals/issues/9/reactions ${eyes}`), 2_000), restState.reactions);
const R2 = await import("../src/github-react.ts");
const before10 = restState.reactions.length;
await R2.reactToTag({ tag: "is:acme/evals#9/pm", kind: "is", ref: 9, repo: "acme/evals", number: 9, url: "u" }, "pm", { log, rest: () => fakeRest });
ok("once per comment + team: the same tag again makes no call", restState.reactions.length === before10);
restState.failReact = true;
const sentBefore = sent.length;
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(30, "@acme/pm look", "caffeinum") });
await drained();
await until(() => sent.length > sentBefore, 2_000);
await new Promise((r) => setTimeout(r, 200));
ok("a failed reaction: the DM still goes, the failure is said once", sent.some((x) => x.agent === "pm" && x.text.endsWith("#issuecomment-30")) && logs.filter((l) => /👀 on .*issuecomment-30 as the operator's gh FAILED: .*HTTP 403/.test(l)).length === 1, logs);
restState.failReact = false;
C.react({ positionals: ["off"] }, out);
ok("react off is recorded", A.readConfig().react === false);
const calls = botReactions.length + restState.reactions.length;
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(31, "@acme/evals-intern with reactions off", "caffeinum") });
await drained();
await until(() => sent.some((x) => x.text.endsWith("#issuecomment-31")), 2_000);
await new Promise((r) => setTimeout(r, 200));
ok("off: the DM goes, no reaction call", sent.some((x) => x.text.endsWith("#issuecomment-31")) && botReactions.length + restState.reactions.length === calls);
C.react({ positionals: ["on"] }, out);
ok("react on removes the key (default on)", A.readConfig().react === undefined);
lines.length = 0;
C.react({ positionals: ["status"] }, out);
ok("react status says on", lines.some((l) => l.startsWith("on: a delivered team tag puts 👀")), lines);

// ── 6. one seen set with the poller ──
const store = R.readStore();
ok("the pushed ids are in the poller's seen set", ["ic:2/evals-intern", "rv:3/evals-intern", "rc:4/evals-intern", "rc:4/pm"].every((id) => store.teams?.seen.includes(id)), store.teams?.seen);
const sweepDeps = {
  gh: async () => ({ data: {} }),
  rest: fakeRest,
  now: () => now,
  send: deps.send,
  machineOf: () => "here",
  log,
  checkout: () => undefined,
  http: fakeHttp,
};
const sweep = async () => void (await R.githubSweep(sweepDeps));
/** Move the fake clock, then let the forwarder write a heartbeat at the new time (it beats every 100 ms). */
const advance = async (ms: number) => {
  now += ms;
  await new Promise((r) => setTimeout(r, 300));
};
await sweep(); // baselines every team's cursor
await advance(31 * 60_000);
restState.comments.push({ id: 2, body: "can you look, @acme/evals-intern?", user: "caffeinum", at: iso(now - 5_000) });
restState.comments.push({ id: 20, body: "the poll finds this one @acme/evals-intern", user: "caffeinum", at: iso(now - 4_000) });
const before = sent.length;
await sweep();
const polled = sent.slice(before).map((s) => s.text);
ok("a later poll does not resend what the push sent, and sends what only it found", polled.length === 1 && polled[0]!.endsWith("#issuecomment-20"), polled);
deliver("issue_comment", { action: "created", repository: repo, issue: { number: 5, pull_request: {} }, comment: comment(20, "the poll finds this one @acme/evals-intern", "caffeinum") });
await drained();
await new Promise((r) => setTimeout(r, 200));
ok("a later push does not resend what the poll sent", sent.length === before + 1, sent.slice(before));
ok("a tag found by the poll reacts after its outbox send, once (the later push adds none)", botReactions.filter((c) => c.startsWith("POST /repos/acme/evals/issues/comments/20/reactions BOT_TOKEN")).length === 1, botReactions);

// ── 7. cadence follows health; gh exiting falls back to polling ──
ok("while up, the keeper said it polls only to reconcile", logs.some((l) => /arrive by webhook push; polling every \d+ min only to reconcile/.test(l)), logs);
restState.searches = 0;
await advance(3 * 60_000);
await sweep();
ok("while up, no poll 3 min after the last (the 2-min pace is off)", restState.searches === 0);
writeFileSync(join(stubDir, "exit"), "");
ok("gh exiting: the status goes down", await until(() => S.readForwardStatus()?.state === "down"), S.readForwardStatus());
ok("gh exiting is said once, naming why", logs.filter((l) => /webhook forwarder DOWN: gh webhook forward exited \(exit 1\): error receiving json event: websocket: close 1006 \(abnormal closure\): unexpected EOF;/.test(l)).length === 1, logs);
ok("…as gh's error line, not its flag usage", !logs.some((l) => /--secret string|Usage:|Flags:/.test(l)), logs.filter((l) => /DOWN/.test(l)));
ok("ghExitReason without an Error: line keeps the last non-usage lines", F.ghExitReason("boom: dial tcp: i/o timeout\nUsage:\n  -S, --secret string  x") === "boom: dial tcp: i/o timeout");
await sweep();
ok("down: the keeper polls again at the 2-min pace, and says so", restState.searches > 0 && logs.some((l) => /no webhook forwarder streams acme — team tags are polled every 2 min/.test(l)), { searches: restState.searches });
ok("gh is started again with backoff and comes back up", await until(() => runs().length >= 2 && S.readForwardStatus()?.state === "up"), runs().length);
ok("coming back is said", logs.some((l) => /is back up after 1 failed start/.test(l)), logs);

// ── 8. another forward already active ──
writeFileSync(join(stubDir, "conflict"), "");
writeFileSync(join(stubDir, "exit"), "");
ok("a hook that already exists: status conflict", await until(() => S.readForwardStatus()?.state === "conflict"), S.readForwardStatus());
ok("…said plainly", logs.some((l) => /another `gh webhook forward` is already active for acme \(GitHub allows one per org\)/.test(l)), logs);
lines.length = 0;
C.forward({ positionals: ["status"] }, SPACE, out, () => {});
ok("forward status shows it and says not healthy", lines.some((l) => /conflict since/.test(l)) && lines.some((l) => /not healthy/.test(l)), lines);
rmSync(join(stubDir, "conflict"));

// ── 9. off; secrets ──
ok("back up after the conflict clears", await until(() => S.readForwardStatus()?.state === "up"));
lines.length = 0;
C.forward({ positionals: ["off"] }, SPACE, out, () => {});
ok("forward off stops it (status off)", await until(() => S.readForwardStatus()?.state === "off") && A.readConfig().forward === undefined, S.readForwardStatus());
await stop();
ok("the secret appears in no log line", !logs.some((l) => l.includes(secret)));

rmSync(home, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} github forward check(s) failed`);
  process.exit(1);
}
console.log("\nall github forward checks passed 🐙");
process.exit(0);
