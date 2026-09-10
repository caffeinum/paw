/**
 * THE CONTROL-RAIL CHECK: can a paw process that did NOT start the manager actually talk to it?
 *
 * WHY THIS EXISTS, stated plainly because the gap it fills cost a production fleet. paw's 20 hermetic
 * suites pass without a broker, and the one integration check (`check:loop`) never starts a manager at
 * all — it calls `ensure({ needMesh: true })` with no `needManager`, stands up two plain endpoints and
 * asserts a DM round-trip. So when cotal 0.25 DELETED the manager's `ctl.<tier>` control subjects, every
 * paw control call began hanging against a real manager and the whole suite stayed green. The bump
 * shipped, `paw chat` timed out on the operator's live mesh, and nothing in the repo had a chance of
 * catching it, because nothing in the repo had ever made a control call to a manager.
 *
 * The blind spot is specific, and it is what this file targets: the failure only appears from a client
 * that is NOT the process that started the manager. Startup readiness is itself a control call, so a
 * broken rail could in principle be caught there — but a test that starts a manager and immediately
 * asks it something proves only that ONE code path works ONCE, in-process, warm. So the probe here runs
 * in a SEPARATE PROCESS: its own connection, its own `resolveService`, no cached anything. That is the
 * shape of every real paw invocation (`paw chat`, `paw status`, `paw dm` — all talk to a manager some
 * earlier process left running), and it is exactly the shape that was never tested.
 *
 * A HANG, NOT AN ERROR, is the failure mode being guarded: the dead rail returned no reply rather than
 * a refusal, so every assertion here is on a DEADLINE and reports elapsed milliseconds. "It answered"
 * and "it answered in time" are the same claim for a control plane.
 *
 * ISOLATION IS ENFORCED, NOT DOCUMENTED (see {@link assertIsolated}). This check starts daemons; run
 * against the operator's PAW_HOME and space it would be a production change. It refuses rather than
 * trusting the caller to have exported the right variables.
 *
 * Run:  pnpm check:rail          (ps/inspect/despawn over the rail — no claude)
 *       PAW_RAIL_SPAWN=1 pnpm check:rail   (also spawns a REAL claude agent and despawns it)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { removeMesh } from "@cotal-ai/workspace";
import { ManagerControl, withManagerControl } from "../src/control.js";
import { ensure, stop } from "../src/lifecycle.js";

const SETTLE_MS = 3_000; // let the manager finish registering its service before a stranger asks
const PROBE_DEADLINE_MS = 20_000; // generous; the dead rail's symptom was NO reply at all
const SPAWN_READY_MS = 90_000; // a cold claude

/**
 * Refuse to run anywhere that could be the operator's real fleet.
 *
 * Not paranoia, and not a substitute for reading the docs: this check STARTS A MANAGER, and a manager
 * started in space `paw` under the default PAW_HOME joins the machine's real control plane. The rule is
 * therefore checked, not requested. PAW_HOME must be set and must not be the default root; the space
 * must be explicit and must not be `paw`.
 */
function assertIsolated(): { space: string; home: string } {
  const home = process.env.PAW_HOME?.trim();
  const space = process.env.PAW_SPACE?.trim();
  const fail = (why: string): never => {
    throw new Error(
      `check:rail refuses to run: ${why}\n` +
        `  it starts a real mesh manager, so it must never touch the operator's fleet. Run it as:\n` +
        `    PAW_HOME=$(mktemp -d) PAW_SPACE=railprobe-$$ pnpm check:rail`,
    );
  };
  if (!home) fail("PAW_HOME is unset");
  if (home === join(homedir(), ".paw")) fail("PAW_HOME is the default ~/.paw");
  if (!space) fail("PAW_SPACE is unset");
  if (space === "paw") fail(`PAW_SPACE is "paw" — that is the operator's live space`);
  return { space: space!, home: home! };
}

/** One assertion, on a deadline, reporting how long the answer took. */
function ok(label: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "✓" : "✗"} ${label} — ${detail}`);
  if (!pass) failures.push(label);
}
const failures: string[] = [];

// ---------------------------------------------------------------------------------------------
// THE PROBE (child process). Argv-selected so the probe is the SAME code paw ships, reached through
// a fresh process: a separate connection, a separate `resolveService`, nothing inherited from the
// process that started the manager. It prints one JSON line the parent parses.
// ---------------------------------------------------------------------------------------------
if (process.argv[2] === "--probe") {
  const space = process.env.PAW_SPACE!;
  const t0 = Date.now();
  const reply = await withManagerControl(space, DEFAULT_SERVER, (ctl) => ctl.ps(PROBE_DEADLINE_MS));
  const rows = Array.isArray(reply.data) ? (reply.data as Array<{ name?: string }>) : [];
  process.stdout.write(
    JSON.stringify({ ok: reply.ok, error: reply.error, ms: Date.now() - t0, names: rows.map((r) => r.name) }) + "\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// THE CHECK (parent process).
// ---------------------------------------------------------------------------------------------
const { space } = assertIsolated();
process.env.PAW_RUNTIME ??= "pty"; // never take over the operator's tmux/cmux surfaces
const self = fileURLToPath(import.meta.url);
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
let agentFolder: string | undefined;

/** Run the probe in a fresh process and return what it saw — or a timeout, which is the real bug. */
function probe(): { ok: boolean; error?: string; ms: number; names: string[] } {
  try {
    const out = execFileSync(tsx, [self, "--probe"], {
      encoding: "utf8",
      // Longer than the probe's own deadline: the probe must be what gives up, not this, so a hang
      // surfaces as "no reply in Nms" rather than as an opaque killed subprocess.
      timeout: PROBE_DEADLINE_MS + 15_000,
      env: process.env,
    });
    const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
    return JSON.parse(line);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || "probe failed").slice(0, 400), ms: -1, names: [] };
  }
}

try {
  console.log(`space=${space} server=${DEFAULT_SERVER} runtime=${process.env.PAW_RUNTIME}`);

  // 1. Bring up mesh + MANAGER. `ensure` gates on a control call of its own (`managerAnswers`), so a
  //    dead rail can also fail here — that is fine and it is the same bug; the probe below is what
  //    distinguishes "works from the starter" from "works from anyone".
  const t0 = Date.now();
  const { server } = await ensure({ needMesh: true, needManager: true, space });
  console.log(`manager up on ${server} in ${Date.now() - t0}ms`);

  // 2. Let it settle. The manager registers its service endpoint asynchronously after the process
  //    starts; a stranger's `describe` racing that registration is a different (and legitimate)
  //    failure, and conflating the two would make this check flaky for the wrong reason.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // 3. THE ASSERTION THIS FILE EXISTS FOR.
  const first = probe();
  ok(
    "a SEPARATE process can call ps on a manager it did not start",
    first.ok,
    first.ms >= 0 ? `answered in ${first.ms}ms, ${first.names.length} agent(s)` : `NO ANSWER (${first.error})`,
  );

  // 4. Twice, from two more fresh processes. A rail that answers once and then wedges (a durable, a
  //    queue group, a stuck consumer) is a real failure shape and a single call cannot see it.
  for (const n of [2, 3]) {
    const again = probe();
    ok(`ps call #${n} from another fresh process`, again.ok, again.ms >= 0 ? `answered in ${again.ms}ms` : `NO ANSWER (${again.error})`);
  }

  // 5. A REFUSAL must come back as a refusal, promptly — not as silence. This is the half of the rail
  //    that the old one got wrong in the most expensive way: `requestControl` against a subject nobody
  //    served sat until its timeout, so "nobody is there" was indistinguishable from "still thinking".
  await withManagerControl(space, DEFAULT_SERVER, async (ctl) => {
    const t = Date.now();
    const r = await ctl.inspect("no-such-agent-here");
    const ms = Date.now() - t;
    ok("inspect of an unknown agent is REFUSED, not hung", !r.ok && ms < 10_000, `ok=${r.ok} in ${ms}ms (${r.error ?? "no error"})`);

    const t2 = Date.now();
    const d = await ctl.despawn("no-such-agent-here");
    const ms2 = Date.now() - t2;
    ok("despawn of an unknown agent is REFUSED, not hung", !d.ok && ms2 < 10_000, `ok=${d.ok} in ${ms2}ms (${d.error ?? "no error"})`);
  });

  // 6. Optional: with a REAL agent in the space. Off by default because it launches claude — an API
  //    session and ~a minute — but it is the state a live manager is actually in, and a rail that only
  //    works against an empty manager would be a rail that works in tests and nowhere else.
  if (process.env.PAW_RAIL_SPAWN === "1") {
    const { ensureAgentSpawned } = await import("../src/addressing.js");
    const { setFolderName } = await import("../src/addressing.js");
    agentFolder = mkdtempSync(join(tmpdir(), "pawrail-"));
    const name = setFolderName(space, agentFolder, "railagent").name;
    console.log(`spawning a real agent "${name}" in ${agentFolder} (up to ${SPAWN_READY_MS / 1000}s)…`);
    const t = Date.now();
    const ctl = new ManagerControl(space, DEFAULT_SERVER);
    try {
      const r = await ensureAgentSpawned(ctl, { space, name, cwd: agentFolder });
      ok("spawn over the rail brings a real agent to the mesh", r.spawned, `spawned=${r.spawned} id=${r.id ?? "—"} in ${Date.now() - t}ms`);
    } finally {
      await ctl.close();
    }

    // The probe again — now against a manager holding STATE, which is the case the blind spot was
    // hiding: a manager with no agents is the easiest possible thing to answer with.
    const withAgent = probe();
    ok(
      "a separate process sees the spawned agent in ps",
      withAgent.ok && withAgent.names.includes(name),
      withAgent.ms >= 0 ? `answered in ${withAgent.ms}ms with [${withAgent.names.join(", ")}]` : `NO ANSWER (${withAgent.error})`,
    );

    await withManagerControl(space, DEFAULT_SERVER, async (c2) => {
      const d = await c2.despawn(name);
      ok("despawn over the rail stops a real agent", d.ok, d.ok ? "stopped" : `failed: ${d.error}`);
    });
  } else {
    console.log("· skipping the real-agent stage (set PAW_RAIL_SPAWN=1 to include it)");
  }
} finally {
  // Teardown, in the order the daemons depend on each other. `stop` only kills what THIS run started
  // (manager + mailbox by space-exact command signature; the mesh only via a pid marker this run
  // wrote), so adopting an already-running broker leaves it alone.
  await stop({ space }).catch((e) => console.error("teardown stop:", (e as Error).message));
  if (agentFolder) rmSync(agentFolder, { recursive: true, force: true });
  // And the MESH REGISTRY entry. A test that leaves one behind is a landmine: cotal's `up` preflight
  // matches the FIRST entry holding a port, so a stale probe space eventually makes the REAL mesh
  // refuse to start, weeks later, in an unrelated command. (check:loop learned this the hard way.)
  removeMesh(space);
  rmSync(join(process.env.PAW_HOME!, "spaces", space), { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} control-rail assertion(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\ncontrol rail answers strangers 🐾");
