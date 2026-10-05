/**
 * END-TO-END company pages (docs/notes/company-spec.md §9) on a FULLY ISOLATED stack: its own
 * nats-server, PAW_HOME, space, cotal root and beads db, two cheap REAL claude agents, and the real
 * `paw web` daemon spoken to over HTTP exactly as the browser does.
 *
 *   1  /api/companies → one epic: label company:<slug> only, metadata.org = picked agents, assignee = lead
 *   2  #slug registry card (description + brief), one invite DM each, the "invited @…" line, kickoff;
 *      both agents join and speak in the channel
 *   4  a bead for beta → label inherited, parent = epic, exactly ONE nudge; beta CLAIMS it from the nudge
 *   12 an operator bead (no DM) + a `blocks` dep → "on you" count 2 (page + sidebar); close → 0
 *   13 milestone done/total over its subtree; a DM to the lead round-trips (its PONG comes back)
 *   14 an agent↔agent DM and a #slug post in /api/dialog/<agent>
 *   8  unknown slug → 404; a duplicate root → 409 naming both ids
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=company-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) \
 *   PAW_BEADS_DIR=<dir>/.beads node scripts/e2e-company.ts        (bd init the beads dir first)
 *
 * PAW_E2E_HOLD=1 keeps the stack up after the checks (prints `HOLD <url>`) until SIGTERM — the
 * browser checks (python playwright) run against it, then this tears everything down.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMesh } from "@cotal-ai/workspace";
import { readChannelRegistry } from "@cotal-ai/core";

const space = process.env.PAW_SPACE ?? "";
const beads = process.env.PAW_BEADS_DIR ?? "";
if (!process.env.PAW_HOME || !space.startsWith("company-test") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !beads)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=company-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
if (beads.replace(/\/$/, "").endsWith("/.beads") && beads.startsWith(process.env.HOME + "/.beads")) throw new Error("PAW_BEADS_DIR must not be the live ~/.beads");
if (!existsSync(beads)) throw new Error(`PAW_BEADS_DIR=${beads} does not exist — bd init it first`);
const REPO = fileURLToPath(new URL("..", import.meta.url));

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const natsPort = await freePort();
const webPort = await freePort();
process.env.PAW_SERVER = `nats://127.0.0.1:${natsPort}`;
process.env.PAW_MODEL ??= "haiku";
process.env.PAW_OPERATOR = "operator";
process.env.BEADS_DIR = beads; // our own direct bd calls below
const nats = spawn("nats-server", ["-js", "-p", String(natsPort), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "pawcojs-"))], { stdio: "ignore" });

const { ManagerControl } = await import("../src/control.ts");
const { ensureAgentSpawned, setFolderName } = await import("../src/addressing.ts");
const { ensure, stop } = await import("../src/lifecycle.ts");
const { pawServer } = await import("../src/server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const bd = (...args: string[]): unknown => JSON.parse(execFileSync("bd", [...args, "--json"], { env: { ...process.env, BEADS_DIR: beads }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const bdRaw = (...args: string[]) => execFileSync("bd", args, { env: { ...process.env, BEADS_DIR: beads }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const show = (id: string) => {
  const r = bd("show", id) as unknown;
  return (Array.isArray(r) ? r[0] : r) as { labels?: string[]; metadata?: unknown; assignee?: string; parent?: string; status?: string; description?: string };
};
/** bd re-orders JSON object keys, so compare key-sorted. */
const sortedJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const base = `http://127.0.0.1:${webPort}`;
const H = { Origin: base, "content-type": "application/json" };
const get = async (p: string) => {
  const r = await fetch(base + p, { headers: H });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const until = async <T>(what: string, fn: () => Promise<T | undefined>, ms: number): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await sleep(2000);
  }
  console.log(`  (gave up waiting for ${what} after ${ms / 1000}s)`);
  return undefined;
};

const names = ["alpha", "beta"];
let web: ChildProcess | undefined;
async function teardown() {
  web?.kill("SIGTERM");
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  removeMesh(space);
  nats.kill("SIGTERM");
}
process.on("SIGTERM", () => void teardown().then(() => process.exit(fails ? 1 : 0)));

try {
  const { connect } = await import("node:net");
  const natsUp = await until("nats-server", () => new Promise<true | undefined>((r) => {
    const c = connect(natsPort, "127.0.0.1", () => (c.end(), r(true)));
    c.on("error", () => r(undefined));
  }), 20_000);
  if (!natsUp) throw new Error(`nats-server never came up on ${natsPort}`);
  await ensure({ needMesh: true, needManager: true, space });
  const ctl = new ManagerControl(space, pawServer());
  for (const n of names) {
    const d = mkdtempSync(join(tmpdir(), `pawco-${n}-`));
    setFolderName(space, d, n);
    await ensureAgentSpawned(ctl, { space, name: n, cwd: d });
  }
  web = spawn(process.execPath, [join(REPO, "bin/paw.ts"), "web", "--port", String(webPort), "--no-open"], { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  await until("paw web", async () => (await fetch(`${base}/api/status`, { headers: H })).ok || undefined, 60_000);
  await until("both agents in the roster", async () => {
    const s = await get("/api/status");
    return names.every((n) => (s.body.rows as Array<{ name: string; live: boolean }>).some((r) => r.name === n && r.live)) || undefined;
  }, 120_000);

  // 1 ─ create (lead chosen; roster in metadata; label only)
  const created = await post("/api/companies", { name: "Test Co", slug: "test-co", mission: "prove the loop", members: ["alpha", "beta"], lead: "alpha" });
  ok("1 create answers 200 with the epic id", created.status === 200 && typeof created.body.epic === "string", JSON.stringify(created.body));
  const epic = created.body.epic as string;
  const roots = bd("list", "--metadata-field", "company=test-co", "--all", "-n", "0") as Array<{ id: string }>;
  ok("1 exactly one epic carries metadata.company=test-co", roots.length === 1 && roots[0].id === epic);
  const e = show(epic);
  ok("1 epic: label company:test-co ONLY", JSON.stringify(e.labels) === JSON.stringify(["company:test-co"]), JSON.stringify(e.labels));
  ok("1 epic: metadata.org = the picked agents (no operator), assignee = chosen lead, mission = description", sortedJson((e.metadata as { org?: unknown })?.org) === sortedJson({ alpha: {}, beta: {} }) && e.assignee === "alpha" && e.description === "prove the loop", JSON.stringify(e.metadata));
  ok("1 no channel/invite failure reported", !created.body.channelError && !(created.body.failed ?? []).length, JSON.stringify(created.body));

  // 2 ─ channel card + invites + kickoff
  const reg = await readChannelRegistry({ servers: pawServer(), space });
  const card = reg.channels?.["test-co"];
  ok("2 #test-co registry card: description = mission, instructions = the brief", card?.description === "prove the loop" && !!card?.instructions?.includes("only alpha escalates to operator"), JSON.stringify(card).slice(0, 200));
  const outs = async () => ((await get("/api/inbox?sent=1&limit=1000")).body.messages as Array<{ dir?: string; to?: string; text: string }>).filter((m) => m.dir === "out");
  ok("2 each member got exactly one invite DM", (await outs()).filter((m) => m.text.includes('cotal_join("test-co")')).length === 2);
  const chTexts = async () => ((await get("/api/channel/test-co?limit=300")).body.messages as Array<{ from: string; text: string }>);
  ok("2 the channel shows the invite line and the kickoff", (await chTexts()).some((m) => m.text.includes("invited @alpha, @beta")) && (await chTexts()).some((m) => m.text.includes("#test-co is the Test Co company")));
  const joined = await until("both agents to post in #test-co", async () => {
    const authors = new Set((await chTexts()).map((m) => m.from));
    return authors.has("alpha") && authors.has("beta") ? true : undefined;
  }, 240_000);
  ok("2 both agents JOINED and spoke in #test-co", !!joined);

  // 4 ─ a bead for beta: label inherited, parent = epic, ONE nudge; beta claims it
  const iss = await post("/api/company/test-co", { op: "issue-create", title: "Write a one-line README.md in your folder", assignee: "beta" });
  const issue = iss.body.id as string;
  ok("4 bead created for beta and beta nudged", iss.status === 200 && iss.body.nudged === "beta", JSON.stringify(iss.body));
  const is = show(issue);
  ok("4 bead: company label, parent = epic, assignee beta", !!is.labels?.includes("company:test-co") && is.parent === epic && is.assignee === "beta", JSON.stringify(is).slice(0, 200));
  await sleep(1500);
  const nudges = async (id: string) => (await outs()).filter((m) => m.text.includes(`you've been assigned ${id}`));
  ok("4 beta got exactly ONE assignment DM", (await nudges(issue)).length === 1);
  const claimed = await until("beta to claim its bead", async () => (["in_progress", "closed"].includes(show(issue).status ?? "") ? true : undefined), 300_000);
  ok("4 beta CLAIMED the bead from the nudge (bd: in_progress/closed)", !!claimed, show(issue).status);

  // 12 ─ blocked on the operator
  const op = await post("/api/company/test-co", { op: "issue-create", title: "Decide: ship README or not", assignee: "operator" });
  const opId = op.body.id as string;
  ok("12 an operator bead is created with NO nudge", op.status === 200 && !op.body.nudged && !op.body.nudgeError, JSON.stringify(op.body));
  const waiter = await post("/api/company/test-co", { op: "issue-create", title: "Publish README", assignee: "beta" });
  bdRaw("dep", "add", waiter.body.id as string, opId);
  const p12 = await get("/api/company/test-co?fresh=1");
  ok("12 'on you' = the operator bead + the bead waiting on it (count 2)", p12.body.onYou?.count === 2 && p12.body.onYou.assigned.includes(opId) && p12.body.onYou.waiting.some((w: { id: string; blocker: string }) => w.id === waiter.body.id && w.blocker === opId), JSON.stringify(p12.body.onYou));
  ok("12 the sidebar list carries the count", ((await get("/api/companies")).body.companies as Array<{ slug: string; onYou: number }>).find((c) => c.slug === "test-co")?.onYou === 2);
  await sleep(1000);
  ok("12 no DM ever went to the operator", (await outs()).every((m) => m.to !== "operator") && (await nudges(opId)).length === 0);
  const closed = await post("/api/tasks", { op: "close", id: opId, reason: "ship it" });
  const p12b = await get("/api/company/test-co?fresh=1");
  ok("12 closing the operator bead → count 0, the waiter leaves 'waiting on you'", closed.status === 200 && p12b.body.onYou?.count === 0, JSON.stringify(p12b.body.onYou));

  // 13 ─ milestones count over the whole subtree (closed included); the lead chat round-trips
  const ms = bdRaw("create", "Milestone one", "-t", "epic", "--parent", epic, "-l", "goal", "--silent");
  const c1 = bdRaw("create", "child one", "--parent", ms, "--silent");
  bdRaw("create", "child two", "--parent", ms, "--silent");
  bdRaw("close", c1, "--reason", "done");
  const p13 = await get("/api/company/test-co?fresh=1");
  const { milestones } = await import("../web/app/company-model.js");
  const row = milestones(p13.body.issues, epic).find((m) => m.id === ms);
  ok("13 milestone shows 1/2 after closing one child (closed counted from the company list)", row?.done === 1 && row?.total === 2, JSON.stringify(row && { done: row.done, total: row.total }));
  const dm = await post("/api/dm", { to: "alpha", text: "operator here — please reply to me with just the word PONG." });
  ok("13 a message typed for the lead is delivered as a DM to alpha", dm.status === 200, JSON.stringify(dm.body));
  const pong = await until("alpha's reply in the operator's conversation", async () => ((await get("/api/inbox?sent=1&limit=1000")).body.messages as Array<{ dir?: string; from: string; text: string }>).some((m) => m.dir !== "out" && m.from === "alpha" && /pong/i.test(m.text)) || undefined, 240_000);
  ok("13 the lead's reply arrives in the conversation the home page renders", !!pong);

  // 14 ─ dialog: an agent↔agent DM, not involving the operator, plus a #slug post by the agent
  await post("/api/dm", { to: "alpha", text: 'please send beta a direct message (cotal_dm to "beta") that says exactly: hello beta from alpha. no need to reply to me.' });
  const dlg = await until("an alpha→beta DM in beta's dialog", async () => {
    const d = await get("/api/dialog/beta?limit=500&channel=test-co");
    const msgs = d.body.messages as Array<{ from: string; to?: string; channel?: string; text: string }>;
    return msgs.some((m) => m.from === "alpha" && m.to === "beta") ? d.body : undefined;
  }, 240_000);
  ok("14 beta's dialog shows an alpha→beta DM (agent↔agent)", !!dlg, dlg ? "" : JSON.stringify((await get("/api/dialog/beta?limit=50&channel=test-co")).body).slice(0, 300));
  const dlg2 = await get("/api/dialog/beta?limit=500&channel=test-co");
  ok("14 …and beta's own #test-co post, tagged with the channel", (dlg2.body.messages as Array<{ from: string; channel?: string }>).some((m) => m.from === "beta" && m.channel === "test-co"));
  ok("14 no dialog read error on this open mesh", !dlg2.body.error, String(dlg2.body.error ?? ""));

  // R2 ─ a member whose folder is gone; retry redoes ONLY what failed; remove from company
  const ghostDir = mkdtempSync(join(tmpdir(), "pawco-ghost-"));
  setFolderName(space, ghostDir, "ghost");
  rmSync(ghostDir, { recursive: true, force: true }); // the reboot that wiped /tmp
  bdRaw("update", epic, "--metadata", JSON.stringify({ ...(show(epic).metadata as object), org: { alpha: {}, beta: {}, ghost: {} } }));
  const invitesTo = async () => (await outs()).filter((m) => m.text.includes('cotal_join("test-co")')).length;
  const invBefore = await invitesTo();
  const retry = await post("/api/company/test-co", { op: "retry-channel", names: ["ghost", "beta"] });
  await sleep(1500);
  const after = await invitesTo();
  ok("R2 retry re-invites ONLY the named members (beta: +1; alpha not re-DM'd)", retry.status === 200 && after - invBefore === 1 && (retry.body.invited as string[]).join() === "beta", JSON.stringify(retry.body).slice(0, 300));
  ok("R2 the gone folder is said in plain words, flagged gone", (retry.body.failed as Array<{ name: string; error: string; gone?: boolean }>).some((f) => f.name === "ghost" && f.gone && f.error.includes("no longer exists")), JSON.stringify(retry.body.failed));
  ok("R2 retry with nothing named is refused (never a blanket re-run)", (await post("/api/company/test-co", { op: "retry-channel" })).status === 400);
  const pg = await get("/api/company/test-co?fresh=1");
  ok("R2 the page payload marks the member's folder gone", (pg.body.members as Array<{ name: string; gone?: string }>).some((m) => m.name === "ghost" && m.gone === ghostDir), JSON.stringify(pg.body.members));
  const rm = await post("/api/company/test-co", { op: "member-remove", name: "ghost" });
  ok("R2 member-remove drops it from metadata.org, other keys kept", rm.status === 200 && sortedJson((show(epic).metadata as { org?: unknown }).org) === sortedJson({ alpha: {}, beta: {} }) && (show(epic).metadata as { company?: string }).company === "test-co");
  ok("R2 the lead can't be removed", (await post("/api/company/test-co", { op: "member-remove", name: "alpha" })).status === 400);

  // S ─ status controls + attribution
  const sb = (await post("/api/company/test-co", { op: "issue-create", title: "Status probe", assignee: "beta" })).body.id as string;
  await sleep(1000);
  const st1 = await post("/api/company/test-co", { op: "status", id: sb, to: "blocked" });
  ok("S status → blocked", st1.status === 200 && show(sb).status === "blocked", JSON.stringify(st1.body));
  const blk2 = (await post("/api/company/test-co", { op: "issue-create", title: "Blocker of the probe" })).body.id as string;
  bdRaw("dep", "add", sb, blk2);
  const refusedDone = await post("/api/company/test-co", { op: "status", id: sb, to: "done", reason: "tried" });
  ok("S Done on a bead with an open blocker is refused with bd's words; not closed (the agent may move it itself)", refusedDone.status !== 200 && /block/i.test(String(refusedDone.body.error)) && show(sb).status !== "closed", JSON.stringify(refusedDone.body));
  bdRaw("dep", "remove", sb, blk2);
  const done = await post("/api/company/test-co", { op: "status", id: sb, to: "not-needed", reason: "superseded" });
  const cmts = bd("comments", sb) as Array<{ author: string; text: string }>;
  ok("S 'not needed' + reason closes with that reason AND comments it, as the operator", done.status === 200 && show(sb).status === "closed" && cmts.some((c) => c.author === "operator" && c.text.includes("superseded")), JSON.stringify(cmts));
  ok("S its holder (beta) got exactly one DM about the close", done.body.nudged === "beta" && (await outs()).filter((m) => m.text.includes(`closed ${sb}`)).length === 1, JSON.stringify(done.body));
  const reopened = await post("/api/company/test-co", { op: "status", id: sb, to: "open" });
  ok("S a closed bead can be reopened", reopened.status === 200 && show(sb).status === "open");
  await post("/api/company/test-co", { op: "comment", id: sb, text: "from the operator" });
  ok("S a page comment is attributed to the operator, not git's user.name", (bd("comments", sb) as Array<{ author: string; text: string }>).some((c) => c.author === "operator" && c.text === "from the operator"));
  const opClose = await post("/api/company/test-co", { op: "issue-create", title: "Mine", assignee: "operator" });
  const opDone = await post("/api/company/test-co", { op: "status", id: opClose.body.id, to: "done" });
  ok("S a bead created on the page names the operator as its creator", (bd("show", sb) as Array<{ created_by?: string }>)[0]?.created_by === "operator" || (bd("show", sb) as { created_by?: string }).created_by === "operator", JSON.stringify(bd("show", sb)).slice(0, 200));
  ok("S closing the operator's OWN bead DMs nobody", opDone.status === 200 && !opDone.body.nudged);

  // P ─ a PR linked to a bead (bd --external-ref, as the brief tells agents)
  bdRaw("update", sb, "--external-ref", "https://github.com/cli/cli/pull/1");
  const pp = await get("/api/company/test-co?fresh=1");
  ok("P the page payload carries the bead's external_ref", (pp.body.issues as Array<{ id: string; externalRef?: string }>).some((i) => i.id === sb && i.externalRef === "https://github.com/cli/cli/pull/1"));
  const pi = await get("/api/pr-info?url=" + encodeURIComponent("https://github.com/cli/cli/pull/1"));
  ok("P /api/pr-info answers for a GitHub PR (state when gh can see it, null otherwise)", pi.status === 200 && "pr" in pi.body, JSON.stringify(pi.body).slice(0, 160));
  ok("P the brief tells members to link PRs", String((await readChannelRegistry({ servers: pawServer(), space })).channels?.["test-co"]?.instructions).includes("--external-ref <PR url>"));

  // 8 ─ unknown + duplicate
  const nope = await get("/api/company/nope");
  ok("8 unknown slug → 404 'no company'", nope.status === 404 && /no company "nope"/.test(String(nope.body.error)));
  const dup = bdRaw("create", "Dup Co", "-t", "epic", "--metadata", JSON.stringify({ company: "test-co", org: {} }), "--silent");
  const d8 = await get("/api/company/test-co?fresh=1");
  ok("8 a duplicate root fails LOUD naming both ids", d8.status === 409 && String(d8.body.error).includes(epic) && String(d8.body.error).includes(dup), JSON.stringify(d8.body));
  bdRaw("update", dup, "--unset-metadata", "company");
  ok("8 …and recovers once the duplicate is unset", (await get("/api/company/test-co?fresh=1")).status === 200);
  const before = (bd("list", "--all", "-n", "0") as unknown[]).length;
  const hijack = await post("/api/companies", { name: "General", slug: "general", members: ["alpha"], lead: "alpha" });
  const hijack2 = await post("/api/companies", { name: "Again", slug: "test-co", members: ["alpha"], lead: "alpha" });
  ok("R1 a slug that is an existing channel is refused (409) and files nothing", hijack.status === 409 && hijack2.status === 409 && (bd("list", "--all", "-n", "0") as unknown[]).length === before, JSON.stringify(hijack.body));
} catch (e) {
  fails++;
  console.error("✗ e2e threw:", (e as Error).stack);
}

console.log(fails ? `\n${fails} company e2e check(s) failed` : "\nall company e2e checks passed");
if (process.env.PAW_E2E_HOLD === "1") {
  console.log(`HOLD ${base}`);
  await new Promise(() => {});
}
await teardown();
process.exit(fails ? 1 : 0);
