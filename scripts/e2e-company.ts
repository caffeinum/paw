/**
 * END-TO-END company pages (docs/notes/company-spec.md §9) on a FULLY ISOLATED stack: its own
 * nats-server, PAW_HOME, space, cotal root and beads db, two cheap REAL claude agents, and the real
 * `paw web` daemon spoken to over HTTP exactly as the browser does.
 *
 *   1. /api/companies create → one epic: label company:<slug> only, metadata.org, assignee, mission
 *   2. #slug registry card (description + instructions), invite DMs, the "invited @…" line, kickoff
 *   3. both agents JOIN (post in #slug) — the evidence the page shows as `joined`
 *   4. goal + issue in B's lane → label inherited, parent = goal, assignee B, exactly ONE assignment DM
 *   5. reassign to A → A nudged once, B not re-nudged; status blocked; a refused close shows bd's text
 *   6. untriaged bead → `file` labels it; an unlabelled descendant is flagged and still listed
 *   7. activity has the kickoff + created events + a close with reason; an agent CLAIMS its bead
 *   8. unknown slug → 404 in words; a duplicate root → 409 naming both ids
 *
 *   PAW_HOME=$(mktemp -d) PAW_SPACE=company-test-$$ PAW_RELEASE=dev PAW_COTAL_ROOT=$(mktemp -d) \
 *   PAW_BEADS_DIR=<dir>/.beads node scripts/e2e-company.ts        (bd init the beads dir first)
 *
 * PAW_E2E_HOLD=1 keeps the stack up after the checks (prints `HOLD <url>`) until SIGTERM — the
 * browser checks (python playwright) run against it, then this tears everything down.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
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

  // 1 ─ create
  const created = await post("/api/companies", { name: "Test Co", slug: "test-co", mission: "prove the loop", lead: "alpha", members: [{ name: "alpha", role: "ceo" }, { name: "beta", role: "writer", reportsTo: "alpha" }] });
  ok("create answers 200 with the epic id", created.status === 200 && typeof created.body.epic === "string", JSON.stringify(created.body));
  const epic = created.body.epic as string;
  const roots = bd("list", "--metadata-field", "company=test-co", "--all", "-n", "0") as Array<{ id: string }>;
  ok("exactly one epic carries metadata.company=test-co", roots.length === 1 && roots[0].id === epic);
  const e = show(epic);
  ok("epic: label company:test-co ONLY", JSON.stringify(e.labels) === JSON.stringify(["company:test-co"]), JSON.stringify(e.labels));
  ok("epic: metadata.org = roster, lead = assignee, mission = description", sortedJson((e.metadata as { org?: unknown })?.org) === sortedJson({ alpha: { role: "ceo" }, beta: { role: "writer", reportsTo: "alpha" } }) && e.assignee === "alpha" && e.description === "prove the loop", JSON.stringify(e));
  ok("no channel/invite failure reported", !created.body.channelError && !(created.body.failed ?? []).length, JSON.stringify(created.body));

  // 2 ─ channel card + invites
  const reg = await readChannelRegistry({ servers: pawServer(), space });
  const card = reg.channels?.["test-co"];
  ok("#test-co registry card: description = mission, instructions = the brief", card?.description === "prove the loop" && !!card?.instructions?.includes("company:test-co"), JSON.stringify(card));
  const sent = await get("/api/inbox?sent=1&limit=500");
  const outs = (sent.body.messages as Array<{ dir?: string; to?: string; text: string }>).filter((m) => m.dir === "out");
  ok("each member got an invite DM", names.every((n) => outs.some((m) => m.text.includes('cotal_join("test-co")'))) && outs.filter((m) => m.text.includes('cotal_join("test-co")')).length === 2);
  const ch = await get("/api/channel/test-co?limit=200");
  const chTexts = (ch.body.messages as Array<{ from: string; text: string }>).map((m) => m.text);
  ok("the channel shows the invite line and the kickoff", chTexts.some((t) => t.includes("invited @alpha, @beta")) && chTexts.some((t) => t.includes("#test-co is the Test Co company")));

  // 3 ─ join evidence
  const joined = await until("both agents to post in #test-co", async () => {
    const p = await get("/api/company/test-co?fresh=1");
    return (p.body.members as Array<{ name: string; joined: boolean }>).every((m) => m.joined) ? p.body : undefined;
  }, 240_000);
  ok("both members JOINED (posted in the channel / members registry)", !!joined);

  // 4 ─ goal + issue in beta's lane
  const g = await post("/api/company/test-co", { op: "goal-create", title: "Ship the README" });
  const goal = g.body.id as string;
  ok("goal created", g.status === 200 && !!goal, JSON.stringify(g.body));
  const gs = show(goal);
  ok("goal: company label inherited + goal, NO org metadata", !!gs.labels?.includes("company:test-co") && !!gs.labels?.includes("goal") && !(gs.metadata as { org?: unknown } | undefined)?.org, JSON.stringify(gs));
  const iss = await post("/api/company/test-co", { op: "issue-create", title: "Write a one-line README.md in your folder", parent: goal, assignee: "beta" });
  const issue = iss.body.id as string;
  ok("issue created and beta nudged", iss.status === 200 && iss.body.nudged === "beta", JSON.stringify(iss.body));
  const is = show(issue);
  ok("issue: company label, parent = goal, assignee beta", !!is.labels?.includes("company:test-co") && is.parent === goal && is.assignee === "beta", JSON.stringify(is));
  const nudgesTo = async (who: string, id: string) =>
    ((await get("/api/inbox?sent=1&limit=500")).body.messages as Array<{ dir?: string; to?: string; text: string }>).filter((m) => m.dir === "out" && m.text.includes(`you've been assigned ${id}`) && (m.to === who || m.to === undefined)).length;
  await sleep(1500);
  ok("beta got exactly ONE assignment DM", (await nudgesTo("beta", issue)) === 1);

  // 7a ─ the beads loop: the assignment DM tells beta to claim; wait for it to do so
  const claimed = await until("beta to claim its bead (in_progress)", async () => (show(issue).status === "in_progress" || show(issue).status === "closed" ? true : undefined), 300_000);
  ok("beta CLAIMED the bead from the assignment DM (bd says in_progress/closed)", !!claimed, show(issue).status);

  // 5 ─ reassign, status, refusal
  const second = await post("/api/company/test-co", { op: "issue-create", title: "Second task", parent: goal, assignee: "beta" });
  const two = second.body.id as string;
  const re = await post("/api/company/test-co", { op: "assign", id: two, assignee: "alpha" });
  await sleep(1500);
  ok("reassign → alpha nudged", re.body.nudged === "alpha" && show(two).assignee === "alpha", JSON.stringify(re.body));
  ok("beta was not re-nudged for it", (await nudgesTo("beta", two)) === 1);
  const blk = await post("/api/tasks", { op: "update", id: two, status: "blocked" });
  ok("status → blocked", blk.status === 200 && show(two).status === "blocked");
  const blocker = await post("/api/company/test-co", { op: "issue-create", title: "Blocker", parent: goal });
  bdRaw("dep", "add", two, blocker.body.id as string);
  const refused = await post("/api/tasks", { op: "close", id: two });
  ok("closing a bead with an open blocker is REFUSED with bd's words", refused.status !== 200 && /block/i.test(String(refused.body.error)), JSON.stringify(refused.body));

  // 6 ─ untriaged + unlabelled
  const loose = bdRaw("create", "Loose work of beta", "-a", "beta", "--silent");
  const stray = bdRaw("create", "Stray under the goal", "--parent", goal, "--no-inherit-labels", "--silent");
  const p6 = await get("/api/company/test-co?fresh=1");
  ok("a member's unlabelled bead is UNTRIAGED", (p6.body.untriaged as Array<{ id: string }>).some((t) => t.id === loose));
  ok("an unlabelled descendant is listed AND flagged", (p6.body.issues as Array<{ id: string; unlabelled?: boolean }>).some((t) => t.id === stray && t.unlabelled));
  const filed = await post("/api/company/test-co", { op: "file", ids: [loose, stray] });
  ok("file → both gain the label", filed.status === 200 && !!show(loose).labels?.includes("company:test-co") && !!show(stray).labels?.includes("company:test-co"), JSON.stringify(filed.body));
  ok("filing a parentless bead puts it under the company epic", show(loose).parent === epic);

  // 7 ─ activity sources
  await post("/api/tasks", { op: "close", id: blocker.body.id, reason: "not needed after all" });
  const p7 = await get("/api/company/test-co?fresh=1");
  const closedOne = (p7.body.issues as Array<{ id: string; closedAt?: string; closeReason?: string }>).find((t) => t.id === blocker.body.id);
  ok("the close carries its reason + timestamp (the feed's 'closed:' row)", closedOne?.closeReason === "not needed after all" && !!closedOne?.closedAt);

  // 8 ─ unknown + duplicate
  const nope = await get("/api/company/nope");
  ok("unknown slug → 404 'no company'", nope.status === 404 && /no company "nope"/.test(String(nope.body.error)));
  const dup = bdRaw("create", "Dup Co", "-t", "epic", "--metadata", JSON.stringify({ company: "test-co", org: {} }), "--silent");
  const d8 = await get("/api/company/test-co?fresh=1");
  ok("a duplicate root fails LOUD naming both ids", d8.status === 409 && String(d8.body.error).includes(epic) && String(d8.body.error).includes(dup), JSON.stringify(d8.body));
  bdRaw("update", dup, "--unset-metadata", "company");
  ok("…and recovers once the duplicate is unset", (await get("/api/company/test-co?fresh=1")).status === 200);

  // org edits: cycle refused, unknown keys preserved
  bdRaw("update", epic, "--set-metadata", "note=keep-me");
  const cyc = await post("/api/company/test-co", { op: "member-set", name: "alpha", reportsTo: "beta" });
  ok("member-set refuses making the lead report to a member", cyc.status === 400, JSON.stringify(cyc.body));
  const role = await post("/api/company/test-co", { op: "member-set", name: "beta", role: "docs" });
  const md = show(epic).metadata as { note?: string; org?: Record<string, { role?: string }> };
  ok("member-set rewrites org and KEEPS unknown metadata keys", role.status === 200 && md.org?.beta?.role === "docs" && md.note === "keep-me", JSON.stringify(md));
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
