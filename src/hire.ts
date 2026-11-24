/**
 * `paw hire "<task>" [--agent claude|kit|grok|codex]` — a new agent for one task, in one command. It
 * births an EXTRA agent at the current folder under a temporary name (`hire-<hex>`), DMs it the task
 * verbatim under a short preamble (pick a 1–2 word name from the operator's own words, `paw rename
 * <name>` yourself, end the turn; you are woken under the new name to do the task), then drops into
 * `paw chat @<name> --only`. The chat follows the rename through the rename trail (src/rename-trail.ts).
 * grok and codex are kit with that model; kit alone is kit's defaults (provider codex).
 */
import { randomBytes } from "node:crypto";
import { registry, type Command } from "@cotal-ai/core";
import { agentRecord, applyAgentType, canonicalDir, ensureAgentSpawned, registerInstance, type AgentTypeSpec } from "./addressing.ts";
import { sendAsYou } from "./dm.ts";
import { ensure, resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { renamedSince } from "./rename-trail.ts";
import { pawServer } from "./server.ts";

export const HIRE_AGENTS = ["claude", "kit", "grok", "codex"] as const;
export type HireAgent = (typeof HIRE_AGENTS)[number];

/** The harness each `--agent` word means. undefined = paw's default claude. */
export const HIRE_HARNESS: Readonly<Record<HireAgent, AgentTypeSpec | undefined>> = {
  claude: undefined,
  kit: { agent: "kit" },
  grok: { agent: "kit", provider: "grok", model: "grok-4.7" },
  codex: { agent: "kit", provider: "codex", model: "gpt-6.1-sol" },
};

export type HireArgs = { prompt: string; agent: HireAgent; space?: string };

export function parseHireArgs(argv: string[]): HireArgs {
  let prompt: string | undefined;
  let agent: HireAgent = "claude";
  let space: string | undefined;
  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") {
      const v = value(a, argv[++i]);
      if (!(HIRE_AGENTS as readonly string[]).includes(v)) throw new Error(`paw: --agent "${v}" — hire takes ${HIRE_AGENTS.join(", ")}`);
      agent = v as HireAgent;
    } else if (a === "--space") space = value(a, argv[++i]);
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${HIRE_USAGE}`);
    else if (prompt !== undefined) throw new Error(`paw: hire takes ONE task — quote it: paw hire "<task>"`);
    else prompt = a;
  }
  if (prompt === undefined || !prompt.trim()) throw new Error(`paw: hire needs the task — ${HIRE_USAGE}`);
  return { prompt, agent, ...(space !== undefined ? { space } : {}) };
}

/** The new hire's first message: the preamble, then the operator's words untouched. */
export function hireBrief(prompt: string): string {
  return [
    "You were just hired with `paw hire`. Before anything else:",
    "1. Pick a really short name for yourself that matches the task below: 1–2 words, lowercase, kebab-case (e.g. `login-redirect`). Reuse the operator's own words from the task verbatim wherever you can.",
    "2. Rename yourself: run `paw rename <name>` (one argument — inside an agent it renames you). If it says the name is taken, pick another and run it again.",
    "3. Then END THIS TURN with a one-line reply. The rename lands when your turn ends: paw restarts you under the new name on this same conversation and wakes you with a DM — start the task then.",
    "",
    "The task, in the operator's words:",
    "",
    prompt,
  ].join("\n");
}

function tempName(): string {
  return `hire-${randomBytes(3).toString("hex")}`;
}

export const HIRE_USAGE = `hire "<task>" [--agent ${HIRE_AGENTS.join("|")}] [--space s]   (a new agent here for the task: it names itself from your words via \`paw rename\`, then works on it; you drop into \`paw chat @<it> --only\`, which follows the rename. grok = kit -m grok-4.7, codex = kit -m gpt-6.1-sol)`;

async function hire(argv: string[]): Promise<void> {
  const { prompt, agent, space: spaceArg } = parseHireArgs(argv);
  const space = spaceArg ?? resolveSpace();
  const folder = canonicalDir(".");
  // Up only once the argv is known good: a typo must not boot daemons (the mailbox too — the DM below sends as you).
  await ensure({ needMesh: true, needManager: true, space });
  const temp = tempName();
  if (agentRecord(space, temp)) throw new Error(`paw: the temporary name "${temp}" is taken in space ${space} — run hire again`);
  const name = registerInstance(space, folder, temp);
  const spec = HIRE_HARNESS[agent];
  if (spec) applyAgentType(space, name, spec);
  await withEnsuredManager(space, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder }));
  await sendAsYou({ space, server: pawServer(space), target: name, byName: true, text: hireBrief(prompt) });
  console.error(`paw: hired "${name}" (${agent}) in ${folder} — it renames itself from your words, then starts`);

  // It may already have renamed itself while we sent: chat the name it has now.
  const current = renamedSince(space, name, performance.timeOrigin) ?? name;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`hired ${current}#${space} — talk to it: paw chat @${current} --only --space ${space}  (it renames itself shortly; \`paw status --space ${space}\` shows the new name)`);
    return;
  }
  await import("./chat.ts");
  const chat = registry.all<Command>("command").find((c) => c.name === "chat");
  if (!chat) throw new Error("paw: the chat command did not register — can't drop into the chat");
  await chat.run({ values: {}, positionals: [], raw: [`@${current}`, "--only", "--space", space] });
}

const hireCommand: Command = {
  kind: "command",
  name: "hire",
  group: "Mesh",
  summary: 'hire a new agent for a task: it names itself from your words, starts, and you chat with it — hire "<task>" [--agent claude|kit|grok|codex]',
  usage: HIRE_USAGE,
  run: (a) => hire([...a.raw]),
};

registry.register(hireCommand);
