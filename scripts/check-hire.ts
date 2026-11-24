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

// harness map
assert(HIRE_HARNESS.claude === undefined, "claude → paw's default harness (no agent: key)");
assert(HIRE_HARNESS.kit?.agent === "kit" && HIRE_HARNESS.kit.model === undefined, "kit → kit, its own defaults");
assert(HIRE_HARNESS.grok?.agent === "kit" && HIRE_HARNESS.grok.provider === "grok" && HIRE_HARNESS.grok.model === "grok-4.7", "grok → kit, provider grok, -m grok-4.7");
assert(HIRE_HARNESS.codex?.agent === "kit" && HIRE_HARNESS.codex.provider === "codex" && HIRE_HARNESS.codex.model === "gpt-6.1-sol", "codex → kit, provider codex, -m gpt-6.1-sol");
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

if (failures > 0) {
  console.error(`\n${failures} paw hire check(s) failed`);
  process.exit(1);
}
console.log("\nall paw hire checks passed 🐾");
