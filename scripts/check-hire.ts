/**
 * `paw hire` (src/hire.ts): argv parsing, the --agent → harness map (grok/codex are kit with a model),
 * and the first message — the preamble that asks for a self-rename, then the task VERBATIM.
 * Pure — isolated PAW_HOME, no mesh/daemons. Run: pnpm check:hire
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-home-"));

const { parseHireArgs, HIRE_HARNESS, HIRE_AGENTS, hireBrief } = await import("../src/hire.ts");
const { checkAgentSpec } = await import("../src/addressing.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throwsMsg(fn: () => unknown, re: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

const task = "fix the login redirect — it loops on /auth when the cookie's stale";

// argv
const plain = parseHireArgs([task]);
assert(plain.prompt === task && plain.agent === "claude" && plain.space === undefined, "default: claude, the task kept as typed");
assert(parseHireArgs(["--agent", "grok", task]).agent === "grok", "--agent before the task");
assert(parseHireArgs([task, "--agent", "codex", "--space", "s1"]).space === "s1", "--agent/--space after the task");
assert(throwsMsg(() => parseHireArgs([]), /needs the task/), "no task → fails loud");
assert(throwsMsg(() => parseHireArgs(["   "]), /needs the task/), "a blank task → fails loud");
assert(throwsMsg(() => parseHireArgs(["fix", "the", "bug"]), /ONE task — quote it/), "an unquoted multi-word task → fails loud, says quote it");
assert(throwsMsg(() => parseHireArgs([task, "--agent", "gpt"]), /hire takes claude, kit, grok, codex/), "an unknown --agent → fails loud with the list");
assert(throwsMsg(() => parseHireArgs([task, "--agent"]), /--agent needs a value/), "--agent with no value → fails loud");
assert(throwsMsg(() => parseHireArgs([task, "--fresh"]), /unknown flag "--fresh"/), "an unknown flag → fails loud");
const dashed = "-v flag is broken";
assert(parseHireArgs([dashed]).prompt === dashed, "a quoted task that starts with - (it has spaces) is the task, verbatim");
assert(parseHireArgs(["--", "-v"]).prompt === "-v", "-- then a task that starts with - → the task");
assert(parseHireArgs(["--agent", "kit", "--space", "s2", "--", dashed]).agent === "kit", "flags before --, the task after");
assert(parseHireArgs([dashed, "--space", "s3"]).space === "s3", "the injected trailing --space still parses after a dashed task");
const sp = parseHireArgs(["--agent", "grok", "--space", "s4", "--", "--agent codex"]);
assert(sp.prompt === "--agent codex" && sp.agent === "grok" && sp.space === "s4", "after -- nothing is a flag");
assert(throwsMsg(() => parseHireArgs(["--", "a", "b"]), /ONE task/), "-- with two words unquoted → ONE task");
assert(throwsMsg(() => parseHireArgs(["-v"]), /unknown flag "-v".*paw hire -- /), "a lone -v → unknown flag, with the -- hint");

// harness map
assert(HIRE_HARNESS.claude === undefined, "claude → paw's default harness (no agent: key)");
assert(HIRE_HARNESS.kit?.agent === "kit" && HIRE_HARNESS.kit.model === undefined, "kit → kit, its own defaults");
assert(HIRE_HARNESS.grok?.agent === "kit" && HIRE_HARNESS.grok.provider === "grok" && HIRE_HARNESS.grok.model === "grok-4.7", "grok → kit, provider grok, -m grok-4.7");
assert(HIRE_HARNESS.codex?.agent === "kit" && HIRE_HARNESS.codex.provider === "codex" && HIRE_HARNESS.codex.model === undefined, "codex → kit, provider codex, kit's default model (no pinned id to go stale)");
for (const a of HIRE_AGENTS) {
  const spec = HIRE_HARNESS[a];
  let ok = true;
  try {
    if (spec) checkAgentSpec(spec);
  } catch {
    ok = false;
  }
  assert(ok, `--agent ${a}: its spec passes checkAgentSpec (what chat --agent validates)`);
}

// the first message
const brief = hireBrief(task);
assert(brief.endsWith(`\n${task}`), "brief: the task is the last thing, verbatim");
assert(/`paw rename <name>`/.test(brief), "brief: tells it to rename itself with `paw rename <name>`");
assert(/1–2 words/.test(brief) && /own words from the task verbatim/.test(brief), "brief: a really short name, from the operator's own words");
assert(/END THIS TURN/.test(brief), "brief: end the turn so the rename can land");
const odd = "line one\n  `code` $HOME \"quoted\"\n";
assert(hireBrief(odd).endsWith(odd), "brief: newlines, backticks, $ and quotes survive untouched");

// the flow (hireIn): ensure → register → harness → spawn → DM → re-read the name → chat, all stubbed
{
  const { hireIn } = await import("../src/hire.ts");
  type Call = [string, ...unknown[]];
  const fake = (o: { tty: boolean; renamedTo?: string; taken?: boolean }) => {
    const calls: Call[] = [];
    const out: string[] = [];
    const deps = {
      ensure: async (space: string) => void calls.push(["ensure", space]),
      isTaken: (_s: string, n: string) => (calls.push(["isTaken", n]), o.taken === true),
      register: (space: string, folder: string, n: string) => (calls.push(["register", space, folder, n]), n),
      applyType: (_s: string, n: string, spec: unknown) => void calls.push(["applyType", n, spec]),
      spawn: async (_s: string, n: string, folder: string) => void calls.push(["spawn", n, folder]),
      send: async (_s: string, n: string, text: string) => void calls.push(["send", n, text]),
      renamedTo: (_s: string, n: string) => (calls.push(["renamedTo", n]), o.renamedTo),
      tty: () => o.tty,
      chat: async (raw: string[]) => void calls.push(["chat", ...raw]),
      out: (l: string) => void out.push(l),
      err: () => undefined,
    };
    return { calls, out, deps };
  };
  const steps = (calls: Call[]) => calls.map((c) => c[0]).join(" → ");

  const a = fake({ tty: true });
  const got = await hireIn("hs", "/w/app", task, "claude", a.deps);
  assert(/^hire-[0-9a-f]{6}$/.test(got), `flow: a temp name hire-<hex> (${got})`);
  assert(steps(a.calls) === "ensure → isTaken → register → spawn → send → renamedTo → chat", `flow (claude, tty): ${steps(a.calls)}`);
  assert(a.calls.find((c) => c[0] === "send")?.[2] === hireBrief(task), "flow: the DM is the brief with the task verbatim");
  const chatCall = a.calls.find((c) => c[0] === "chat")!;
  assert(JSON.stringify(chatCall.slice(1)) === JSON.stringify([`@${got}`, "--only", "--space", "hs"]), `flow: drops into paw chat @<name> --only --space <s> (${chatCall.slice(1).join(" ")})`);
  assert(JSON.stringify(a.calls.find((c) => c[0] === "register")?.slice(1, 3)) === JSON.stringify(["hs", "/w/app"]), "flow: registers in this space at this folder");

  const g = fake({ tty: true });
  await hireIn("hs", "/w/app", task, "grok", g.deps);
  const applied = g.calls.find((c) => c[0] === "applyType");
  assert(steps(g.calls).includes("register → applyType → spawn"), "flow (grok): the harness is set after register, before spawn");
  assert(JSON.stringify(applied?.[2]) === JSON.stringify(HIRE_HARNESS.grok), "flow (grok): the kit/grok spec is applied");
  for (const ag of ["kit", "codex"] as const) {
    const k = fake({ tty: true });
    await hireIn("hs", "/w/app", task, ag, k.deps);
    assert(JSON.stringify(k.calls.find((c) => c[0] === "applyType")?.[2]) === JSON.stringify(HIRE_HARNESS[ag]), `flow (${ag}): its kit spec is applied`);
  }

  const r = fake({ tty: true, renamedTo: "login-redirect" });
  await hireIn("hs", "/w/app", task, "claude", r.deps);
  assert(r.calls.find((c) => c[0] === "chat")?.[1] === "@login-redirect", "flow: already renamed by the time the DM went → chat the new name");

  const n = fake({ tty: false });
  const nm = await hireIn("hs", "/w/app", task, "claude", n.deps);
  assert(!n.calls.some((c) => c[0] === "chat"), "flow (no tty): no chat");
  assert(n.out.length === 1 && n.out[0].includes(`paw chat @${nm} --only --space hs`), `flow (no tty): prints the chat command (${n.out[0]})`);

  const t = fake({ tty: true, taken: true });
  let threw = "";
  try {
    await hireIn("hs", "/w/app", task, "claude", t.deps);
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/temporary name .* is taken/.test(threw) && !t.calls.some((c) => c[0] === "register"), "flow: a taken temp name fails loud before anything is registered");
}

if (failures > 0) {
  console.error(`\n${failures} paw hire check(s) failed`);
  process.exit(1);
}
console.log("\nall paw hire checks passed 🐾");
