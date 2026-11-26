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
assert(parseHireArgs([]).prompt === undefined, "no task → bare hire (the task is typed at the prompt)");
const bareFlags = parseHireArgs(["--agent", "kit", "--space", "s0"]);
assert(bareFlags.prompt === undefined && bareFlags.agent === "kit" && bareFlags.space === "s0", "bare hire keeps --agent/--space");
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

// @name: the agent's name, up front (team2027, 2026-11-25: `paw hire @coach` briefed the agent with the task "@coach")
const named = parseHireArgs(["@coach", task]);
assert(named.name === "coach" && named.prompt === task, "@name then the task → named coach, the task kept");
const bareNamed = parseHireArgs(["@coach"]);
assert(bareNamed.name === "coach" && bareNamed.prompt === undefined, "a bare @name → named, the task is typed at the prompt");
const flagged = parseHireArgs(["--agent", "kit", "@login-redirect", task, "--space", "s5"]);
assert(flagged.name === "login-redirect" && flagged.agent === "kit" && flagged.space === "s5" && flagged.prompt === task, "@name among flags");
assert(parseHireArgs(["--", "@coach"]).prompt === "@coach" && parseHireArgs(["--", "@coach"]).name === undefined, "-- @coach → a literal task, no name");
assert(parseHireArgs(["@coach", "--", "@me"]).name === "coach" && parseHireArgs(["@coach", "--", "@me"]).prompt === "@me", "@name, then -- and a task that starts with @");
assert(parseHireArgs(["@coach help me"]).prompt === "@coach help me", "a quoted task with spaces that starts with @ stays the task");
assert(throwsMsg(() => parseHireArgs([task, "@x"]), /ONE task/), "an @word AFTER the task is not a name → ONE task");
assert(throwsMsg(() => parseHireArgs(["@Coach"]), /isn't a usable name — lowercase kebab-case.*paw hire -- "@Coach"/), "@Coach (caps) → fails loud, with the -- hint");
assert(throwsMsg(() => parseHireArgs(["@coach_bot"]), /isn't a usable name/), "@coach_bot (underscore) → fails loud");
assert(throwsMsg(() => parseHireArgs(["@-coach"]), /isn't a usable name/), "@-coach → fails loud");
assert(throwsMsg(() => parseHireArgs(["@"]), /isn't a usable name/), "a lone @ → fails loud");
assert(throwsMsg(() => parseHireArgs(["@a", "@b"]), /ONE @name/), "two @names → fails loud");

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
assert(/Do NOT run `paw status`/.test(brief) && /only lands after your turn ends/.test(brief), "brief: don't check paw status — the rename lands after the turn");
assert(/one short line/.test(brief), "brief: end the turn with one short line");
assert(/do NOT ask now/.test(brief) && /ask your question in the turn that begins with the wake DM/.test(brief), "brief: a question waits for the wake-DM turn, after the rename");
assert(brief.indexOf("paw rename <name>") < brief.indexOf("do NOT ask now"), "brief: rename first, the question after");
const namedBrief = hireBrief(task, "coach");
assert(namedBrief.endsWith(`\n${task}`) && /as "coach"/.test(namedBrief), "named brief: says its name, the task verbatim last");
assert(!/run `paw rename/.test(namedBrief) && /no `paw rename`/.test(namedBrief), "named brief: no self-rename step");

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
      ask: async () => undefined,
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

  const nmd = fake({ tty: true });
  const gotN = await hireIn("hs", "/w/app", task, "claude", nmd.deps, "coach");
  assert(gotN === "coach", "flow (@name): born as coach");
  assert(steps(nmd.calls) === "isTaken → ensure → register → spawn → send → renamedTo → chat", `flow (@name): taken checked before anything boots (${steps(nmd.calls)})`);
  assert(nmd.calls.find((c) => c[0] === "register")?.[3] === "coach", "flow (@name): registered under its name, no temp name");
  assert(nmd.calls.find((c) => c[0] === "send")?.[2] === hireBrief(task, "coach"), "flow (@name): the brief skips the self-rename");
  assert(nmd.calls.find((c) => c[0] === "chat")?.[1] === "@coach", "flow (@name): chats @coach");
  const nmt = fake({ tty: true, taken: true });
  let takenMsg = "";
  try {
    await hireIn("hs", "/w/app", task, "claude", nmt.deps, "coach");
  } catch (e) {
    takenMsg = (e as Error).message;
  }
  assert(/the name "coach" is already used in space hs/.test(takenMsg) && steps(nmt.calls) === "isTaken", `flow (@name): a taken name fails loud before ensure/register (${steps(nmt.calls)})`);

  const t = fake({ tty: true, taken: true });
  let threw = "";
  try {
    await hireIn("hs", "/w/app", task, "claude", t.deps);
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/temporary name .* is taken/.test(threw) && !t.calls.some((c) => c[0] === "register"), "flow: a taken temp name fails loud before anything is registered");
}

// bare `paw hire`: the prompt reader (hireTask), stubbed
{
  const { hireTask, hireIn } = await import("../src/hire.ts");
  const prompter = (o: { tty: boolean; typed?: string }) => {
    const asked: string[] = [];
    const errs: string[] = [];
    const d = {
      tty: () => o.tty,
      ask: async (p: string) => (asked.push(p), o.typed),
      err: (l: string) => void errs.push(l),
    };
    return { asked, errs, d };
  };
  const rejects = async (p: Promise<unknown>, re: RegExp): Promise<boolean> => {
    try {
      await p;
      return false;
    } catch (e) {
      return re.test((e as Error).message);
    }
  };

  const given = prompter({ tty: true, typed: "nope" });
  assert((await hireTask(task, given.d)) === task && given.asked.length === 0, "bare: a task on argv → no prompt");

  const noTty = prompter({ tty: false, typed: task });
  assert(await rejects(hireTask(undefined, noTty.d), /^paw hire needs a task \(or a terminal to type one\)/), "bare, no tty → fails loud");
  assert(noTty.asked.length === 0, "bare, no tty → never reads stdin");

  const empty = prompter({ tty: true, typed: "   " });
  assert(await rejects(hireTask(undefined, empty.d), /nothing was typed/), "bare: empty input → fails loud");
  assert(!empty.errs.some((l) => l.includes("creating agent")), "bare: empty input → no 'creating agent'");

  const aborted = prompter({ tty: true, typed: undefined });
  assert(await rejects(hireTask(undefined, aborted.d), /hire aborted/), "bare: Ctrl-C / Ctrl-D → fails loud");

  const typed = "  fix the -v flag: it's `broken` $HOME  ";
  const ok = prompter({ tty: true, typed });
  const got = await hireTask(undefined, ok.d);
  assert(ok.asked[0] === "hire › ", `bare: prompts "hire › " (${ok.asked[0]})`);
  assert(got === typed, "bare: the typed task comes back verbatim (not trimmed)");
  assert(ok.errs.includes("creating agent…"), "bare: says 'creating agent…' once the task is in");

  const sent: string[] = [];
  const chatted: string[][] = [];
  const name = await hireIn("hs", "/w/app", got, "claude", {
    ensure: async () => undefined,
    isTaken: () => false,
    register: (_s, _f, n) => n,
    applyType: () => undefined,
    spawn: async () => undefined,
    send: async (_s, _n, text) => void sent.push(text),
    renamedTo: () => undefined,
    tty: () => true,
    ask: async () => {
      throw new Error("hireIn never prompts");
    },
    chat: async (raw) => void chatted.push(raw),
    out: () => undefined,
    err: () => undefined,
  });
  assert(sent.length === 1 && sent[0] === hireBrief(typed) && sent[0].endsWith(`\n${typed}`), "bare: the typed task reaches the new hire verbatim");
  assert(JSON.stringify(chatted) === JSON.stringify([[`@${name}`, "--only", "--space", "hs"]]), "bare: then drops into paw chat @<name> --only");
}

if (failures > 0) {
  console.error(`\n${failures} paw hire check(s) failed`);
  process.exit(1);
}
console.log("\nall paw hire checks passed 🐾");
