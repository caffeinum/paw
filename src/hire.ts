/**
 * `paw hire "<task>" [--agent claude|kit|grok|codex]` — a new agent for one task, in one command. It
 * births an EXTRA agent at the current folder under a temporary name (`hire-<hex>`), DMs it the task
 * verbatim under a short preamble (pick a 1–2 word name from the operator's own words, `paw rename
 * <name>` yourself, end the turn; you are woken under the new name to do the task), then drops into
 * `paw chat @<name> --only`. The chat follows the rename through the rename trail (src/rename-trail.ts).
 * grok is kit with grok-4.7; codex is kit on its codex provider with kit's default model (kit alone is the same
 * today: kit's default provider is codex). Not `paw chat --agent codex`, which is cotal's codex connector.
 * Bare `paw hire` (no task) on a terminal asks for the task on one line (`hire › `), then does the same.
 * `paw hire @name ["<task>"]` names it up front: born as `name` (kebab-case, free — else fail loud), its brief
 * has no self-rename step; a bare `@name` asks for the task the same way. `--` before an `@…` task keeps it text.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { registry, type Command } from "@cotal-ai/core";
import { agentRecord, applyAgentType, canonicalDir, ensureAgentSpawned, registerInstance, type AgentTypeSpec } from "./addressing.ts";
import { sendAsYou } from "./dm.ts";
import { ensure, withEnsuredManager } from "./lifecycle.ts";
import { spaceWasChosen } from "./space.ts";
import { renamedSince } from "./rename-trail.ts";
import { pawServer } from "./server.ts";

export const HIRE_AGENTS = ["claude", "kit", "grok", "codex"] as const;
export type HireAgent = (typeof HIRE_AGENTS)[number];

/** The harness each `--agent` word means. undefined = paw's default claude. */
export const HIRE_HARNESS: Readonly<Record<HireAgent, AgentTypeSpec | undefined>> = {
  claude: undefined,
  kit: { agent: "kit" },
  grok: { agent: "kit", provider: "grok", model: "grok-4.7" },
  codex: { agent: "kit", provider: "codex" },
};

/** prompt undefined = bare `paw hire`: the task is typed at the prompt (see {@link hireTask}).
 *  name = a leading `@name`: the agent is born under it and never renames itself. */
export type HireArgs = { prompt?: string; name?: string; agent: HireAgent; space?: string };

/** A hire's own name: lowercase kebab-case, as the self-naming brief asks for. */
export function checkHireName(typed: string): string {
  const name = typed.slice(1);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
    throw new Error(`paw: "${typed}" isn't a usable name — lowercase kebab-case, e.g. @login-redirect (a task that starts with @: paw hire -- "${typed}")`);
  return name;
}

export function parseHireArgs(argv: string[]): HireArgs {
  let prompt: string | undefined;
  let name: string | undefined;
  let agent: HireAgent = "claude";
  let space: string | undefined;
  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith("-")) throw new Error(`paw: ${flag} needs a value`);
    return v;
  };
  const take = (a: string): void => {
    if (prompt !== undefined) throw new Error(`paw: hire takes ONE task — quote it: paw hire "<task>"`);
    prompt = a;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      // Everything after `--` is the task, even one that starts with `-`.
      for (const rest of argv.slice(i + 1)) take(rest);
      break;
    }
    if (a === "--agent") {
      const v = value(a, argv[++i]);
      if (!(HIRE_AGENTS as readonly string[]).includes(v)) throw new Error(`paw: --agent "${v}" — hire takes ${HIRE_AGENTS.join(", ")}`);
      agent = v as HireAgent;
    } else if (a === "--space") space = value(a, argv[++i]);
    else if (a.startsWith("-") && !/\s/.test(a)) throw new Error(`paw: unknown flag "${a}" (a task that starts with "-": paw hire -- "<task>") — ${HIRE_USAGE}`);
    else if (a.startsWith("@") && !/\s/.test(a) && prompt === undefined) {
      // The agent's name, before the task (`paw hire @coach`, 2026-11-25: the whole "@coach" became the task).
      if (name !== undefined) throw new Error(`paw: hire takes ONE @name — got @${name} and ${a} (a task that starts with @: paw hire @${name} -- "${a}")`);
      name = checkHireName(a);
    } else take(a); // a quoted task with spaces is the task even when it starts with "-"
  }
  if (prompt !== undefined && !prompt.trim()) throw new Error(`paw: hire needs the task — ${HIRE_USAGE}`);
  return { ...(prompt !== undefined ? { prompt } : {}), ...(name !== undefined ? { name } : {}), agent, ...(space !== undefined ? { space } : {}) };
}

/** The new hire's first message: the preamble, then the operator's words untouched. With `name` the operator
 *  already named it — no self-rename step. */
export function hireBrief(prompt: string, name?: string): string {
  if (name !== undefined)
    return [`You were just hired with \`paw hire\` as "${name}" — the operator named you, so keep that name (no \`paw rename\`).`, "", "The task, in the operator's words:", "", prompt].join("\n");
  return [
    "You were just hired with `paw hire`. Before anything else:",
    "1. Pick a really short name for yourself that matches the task below: 1–2 words, lowercase, kebab-case (e.g. `login-redirect`). Reuse the operator's own words from the task verbatim wherever you can.",
    "2. Rename yourself: run `paw rename <name>` (one argument — inside an agent it renames you). If it says the name is taken, pick another and run it again.",
    "3. Then END THIS TURN at once with one short line (e.g. `renaming to <name>`). Do NOT run `paw status` or check whether the rename landed: it only lands after your turn ends, so until then everything still shows your old name. paw then restarts you under the new name on this same conversation and wakes you with a DM — start the task in that turn.",
    "4. If the task is unclear, do NOT ask now. Rename first, end the turn, and ask your question in the turn that begins with the wake DM.",
    "",
    "The task, in the operator's words:",
    "",
    prompt,
  ].join("\n");
}

function tempName(): string {
  return `hire-${randomBytes(3).toString("hex")}`;
}

export const HIRE_USAGE = `hire [@name] ["<task>"] [--agent ${HIRE_AGENTS.join("|")}] [--space s] [-- "<task>"]   (a new agent here for the task: @name names it, else it names itself from your words via \`paw rename\`, then works on it; you drop into \`paw chat @<it> --only\`, which follows the rename. no task on a terminal: type it at the prompt; grok = kit -m grok-4.7; codex = kit on its codex provider, kit's default model — not chat's --agent codex connector)`;

/** Everything hire reaches outside this module — real by default, stubbed by check:hire. */
export interface HireDeps {
  ensure: (space: string) => Promise<void>;
  isTaken: (space: string, name: string) => boolean;
  register: (space: string, folder: string, name: string) => string;
  applyType: (space: string, name: string, spec: AgentTypeSpec) => void;
  spawn: (space: string, name: string, folder: string) => Promise<void>;
  send: (space: string, name: string, text: string) => Promise<void>;
  renamedTo: (space: string, name: string) => string | undefined;
  tty: () => boolean;
  /** One typed line, or undefined when the operator aborted (Ctrl-C / Ctrl-D). */
  ask: (prompt: string) => Promise<string | undefined>;
  chat: (raw: string[]) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** readline's question, as paw's y/n confirms use it — but Ctrl-C and Ctrl-D end it as an abort, not a hang. */
async function askLine(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  rl.on("close", () => abort.abort());
  try {
    return await rl.question(prompt, { signal: abort.signal });
  } catch (e) {
    if (abort.signal.aborted) return undefined;
    throw e;
  } finally {
    rl.close();
  }
}

const realDeps: HireDeps = {
  ensure: async (space) => {
    await ensure({ needMesh: true, needManager: true, space });
  },
  isTaken: (space, name) => agentRecord(space, name) !== undefined,
  register: registerInstance,
  applyType: applyAgentType,
  spawn: (space, name, folder) => withEnsuredManager(space, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd: folder })).then(() => undefined),
  send: async (space, name, text) => {
    await sendAsYou({ space, server: pawServer(space), target: name, byName: true, text });
  },
  renamedTo: (space, name) => renamedSince(space, name, performance.timeOrigin),
  tty: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  ask: askLine,
  chat: async (raw) => {
    await import("./chat.ts");
    const chat = registry.all<Command>("command").find((c) => c.name === "chat");
    if (!chat) throw new Error("paw: the chat command did not register — can't drop into the chat");
    await chat.run({ values: {}, positionals: [], raw });
  },
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

/** The hire itself: register an extra here under a temp name, set its harness, spawn it, DM it the brief,
 *  then chat with it (or, off a terminal, print how to). Returns the name it had when hire finished. */
export async function hireIn(space: string, folder: string, prompt: string, agent: HireAgent, d: HireDeps = realDeps, named?: string): Promise<string> {
  // Taken is a fact on disk: refused before anything boots.
  if (named !== undefined && d.isTaken(space, named)) throw new Error(`paw: the name "${named}" is already used in space ${space} — pick another (\`paw status --space ${space}\` lists them)`);
  // Up only once the argv is known good: a typo must not boot daemons (the mailbox too — the DM below sends as you).
  await d.ensure(space);
  const temp = named ?? tempName();
  if (named === undefined && d.isTaken(space, temp)) throw new Error(`paw: the temporary name "${temp}" is taken in space ${space} — run hire again`);
  const name = d.register(space, folder, temp);
  const spec = HIRE_HARNESS[agent];
  if (spec) d.applyType(space, name, spec);
  await d.spawn(space, name, folder);
  await d.send(space, name, hireBrief(prompt, named));
  d.err(`paw: hired "${name}" (${agent}) in ${folder} — ${named !== undefined ? "it starts on the task" : "it renames itself from your words, then starts"}`);

  // It may already have renamed itself while we sent: chat the name it has now.
  const current = d.renamedTo(space, name) ?? name;
  if (!d.tty()) {
    // The chat follows the whole rename trail for a name that is no longer registered, so this line stays good after the rename.
    d.out(`hired ${current}#${space} — talk to it: paw chat @${current} --only --space ${space}${named !== undefined ? "" : "  (it renames itself shortly; the chat follows it to the new name)"}`);
    return current;
  }
  await d.chat([`@${current}`, "--only", "--space", space]);
  return current;
}

/** The task: the one on argv, else (bare `paw hire`, on a terminal) the line typed at `hire › `, verbatim. */
export async function hireTask(prompt: string | undefined, d: Pick<HireDeps, "tty" | "ask" | "err">): Promise<string> {
  if (prompt !== undefined) return prompt;
  if (!d.tty()) throw new Error(`paw hire needs a task (or a terminal to type one) — ${HIRE_USAGE}`);
  const typed = await d.ask("hire › ");
  if (typed === undefined) throw new Error("paw: hire aborted — no agent created");
  if (!typed.trim()) throw new Error("paw: hire needs a task — nothing was typed, no agent created");
  d.err("creating agent…");
  return typed;
}

async function hire(argv: string[]): Promise<void> {
  const args = parseHireArgs(argv);
  const { agent, space: spaceArg } = args;
  const prompt = await hireTask(args.prompt, realDeps);
  // A defaulted space yields to the calling agent's own (COTAL_SPACE), as archive's does — an agent on team2027
  // hiring must hire into team2027. (Not a CALLER_SPACE_VERBS entry: see archiveSpace.)
  const { archiveSpace } = await import("./archive.ts");
  const space = archiveSpace(spaceArg, spaceWasChosen(), process.env);
  await hireIn(space, canonicalDir("."), prompt, agent, realDeps, args.name);
}

const hireCommand: Command = {
  kind: "command",
  name: "hire",
  group: "Mesh",
  summary: 'hire a new agent for a task: @name names it (else it names itself from your words), it starts, and you chat with it — hire [@name] "<task>" [--agent claude|kit|grok|codex]',
  usage: HIRE_USAGE,
  run: (a) => hire([...a.raw]),
};

registry.register(hireCommand);
