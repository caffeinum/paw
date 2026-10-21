import { randomUUID } from "node:crypto";
/**
 * `paw restart <agent> --agent kit|claude [--model M] [-- <kit flags>]` — switch the harness an
 * EXISTING agent runs on, by editing its persona, before the restart picks it up (docs/notes/kit.md
 * "Swapping a harness"). Transparent by rule: the kit flags after `--` are stored VERBATIM as
 * `kitArgs:` (never renamed or translated), every key written or removed is printed, and so is the
 * command that undoes it.
 *
 *   claude → kit   needs the `resume:` pin, and sets `storage: claude` (kit `--overwrite`): the agent
 *                  keeps appending to ITS claude transcript instead of forking it into kit's store.
 *   kit → kit      replaces `kitArgs:`; a persona `provider:`/`model:`/`variant:` that the new flags
 *                  also set is removed (kit keeps the last of two copies; one record must say it).
 *   kit → claude   removes the kit keys (`agent:`, `kitArgs:`, `provider:`, `storage:`, `model:`,
 *                  `variant:`), keeps the pin.
 *
 * `--model` is the one flag both harnesses share: for kit it is `--model M` at the head of `kitArgs`,
 * for claude `--model M` in `claudeArgs` (the persisted claude flags, src/claude.ts). planSwap is pure.
 */
import { existsSync } from "node:fs";
import { personaFilePath, setPersonaKeys } from "./addressing.ts";
import { checkKitArgs, ensureKitBinary, KIT_AGENT, preflightKitArgs } from "./kit.ts";
import {
  claudeProjectsRoot,
  isClaudeHarness,
  kitSessionsRoot,
  personaValue,
  readAgentType,
  readClaudeArgs,
  readKitArgs,
  readModel,
  readResumeId,
  readShareTools,
  transcriptPath,
} from "./session.ts";

export const SWAP_AGENTS = ["claude", KIT_AGENT] as const;

/** `kitArgs` undefined = no `--` on the command line (keep what the persona has). */
export type SwapRequest = { agent: string; model?: string; kitArgs?: string[] };

/** What the persona says now. `claudeTranscript` / `kitTranscript`: the pin's file in each store, if any. */
export type SwapPersona = {
  file: string;
  agent?: string;
  pin?: string;
  storage?: string;
  kitArgs: string[];
  claudeArgs: string[];
  provider?: string;
  model?: string;
  variant?: string;
  shareTools?: string;
  claudeTranscript?: string;
  kitTranscript?: string;
};

/** The persona keys to write (undefined = remove), a one-line summary, extra lines to print, the undo. */
export type SwapPlan = { set: Record<string, string | undefined>; summary: string; notes: string[]; undo: string };

const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const argsLine = (args: string[]) => args.map(q).join(" ");

/** `claudeArgs` with any `--model X` / `--model=X` replaced by `--model <model>`. */
function withClaudeModel(args: string[], model: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") i++;
    else if (!args[i].startsWith("--model=")) out.push(args[i]);
  }
  return [...out, "--model", model];
}

export function planSwap(name: string, cur: SwapPersona, req: SwapRequest): SwapPlan {
  const want = req.agent.trim();
  if (!(SWAP_AGENTS as readonly string[]).includes(want))
    throw new Error(`paw: restart --agent "${req.agent}" — a restart swaps an agent between ${SWAP_AGENTS.join(" and ")}; any other harness is a persona edit (${cur.file})`);
  const from = isClaudeHarness(cur.agent) ? "claude" : cur.agent!;
  if (from !== "claude" && from !== KIT_AGENT)
    throw new Error(`paw: "${name}" runs on ${from}; restart --agent swaps between claude and kit only — edit its persona (${cur.file})`);
  if (req.model !== undefined && !req.model.trim()) throw new Error("paw: --model needs a value");
  const set: Record<string, string | undefined> = {};
  const notes: string[] = [];
  const removed: string[] = [];
  const drop = (key: keyof SwapPersona & string, label = key) => {
    if (cur[key] === undefined || label in set) return;
    set[label] = undefined;
    removed.push(`${label}: ${Array.isArray(cur[key]) ? JSON.stringify(cur[key]) : cur[key]}`);
  };

  if (want === "claude") {
    if (req.kitArgs !== undefined)
      throw new Error("paw: `--` passes flags to kit, and --agent claude is not kit — claude's own flags are `paw claude <flags>` (persisted as claudeArgs)");
    let undo = from === KIT_AGENT ? kitUndo(name, cur) : "";
    if (from === KIT_AGENT) {
      set.agent = undefined;
      removed.push(`agent: ${KIT_AGENT}`);
      if (cur.kitArgs.length) drop("kitArgs");
      drop("provider");
      drop("storage");
      drop("model");
      drop("variant");
      if (cur.storage !== "claude" && cur.kitTranscript)
        notes.push(
          `it ran on kit's own store: its kit turns are in ${cur.kitTranscript}; claude resumes the claude original` +
            (cur.claudeTranscript ? ` (${cur.claudeTranscript})` : "") + " without them",
        );
      if (cur.shareTools === "none") notes.push("shareTools: none stays — this claude gets no shared MCP servers (`paw mcp share` changes that)");
    }
    if (req.model !== undefined) {
      const next = withClaudeModel(cur.claudeArgs, req.model.trim());
      set.claudeArgs = JSON.stringify(next);
      if (!undo) undo = cur.claudeArgs.length ? `edit claudeArgs back to ${JSON.stringify(cur.claudeArgs)} in ${cur.file}` : `remove claudeArgs from ${cur.file}`;
    }
    if (!Object.keys(set).length) return { set, summary: `persona ${name}: already claude, unchanged`, notes, undo: "" };
    if (cur.pin) notes.push(`resume: ${cur.pin} kept — claude resumes that session`);
    return { set, summary: summarize(name, set, removed), notes, undo };
  }

  // → kit
  // No pin = nothing to continue (claude never had a durable session). Mint one, so kit starts a FRESH,
  // pinned session instead of refusing — the swap must work when claude can't run at all.
  if (!cur.pin) {
    set.resume = randomUUID();
    notes.push(
      `no \`resume:\` pin — kit starts a FRESH session ${set.resume} (pinned); to continue an earlier claude ` +
        `session instead: \`paw adopt <folder> --resume <id> --no-start\`, then swap`,
    );
  }
  const given = req.model !== undefined || req.kitArgs !== undefined;
  const kitArgs = given ? [...(req.model !== undefined ? ["--model", req.model.trim()] : []), ...(req.kitArgs ?? [])] : cur.kitArgs;
  const named = checkKitArgs(req.kitArgs ?? [], "the kit args after `--`");
  if (req.model !== undefined && named.model) throw new Error("paw: --model and a -m/--model after `--` both name the model — say it once");
  const all = checkKitArgs(kitArgs, "the kit args");
  if (from === "claude") set.agent = KIT_AGENT; // first, so the printed summary leads with the harness
  if (given && JSON.stringify(kitArgs) !== JSON.stringify(cur.kitArgs)) set.kitArgs = kitArgs.length ? JSON.stringify(kitArgs) : undefined;
  if (given && !kitArgs.length && cur.kitArgs.length) removed.push(`kitArgs: ${JSON.stringify(cur.kitArgs)}`);

  if (from === "claude") {
    // A claude persona's model:/variant: name a CLAUDE model; kit would read them as its own.
    for (const k of ["model", "variant"] as const)
      if (cur[k] !== undefined)
        throw new Error(`paw: "${name}"'s persona pins ${k}: ${cur[k]} (claude's) — kit would launch with it; remove that line from ${cur.file}, then swap`);
    if (!all.model && !all.provider && !cur.provider)
      throw new Error(`paw: kit needs a model or provider — \`paw restart ${name} --agent kit -- -m grok-4.7\` (or --model <m>, or -- -P codex|grok)`);
    set.storage = "claude";
    notes.push(
      cur.claudeTranscript
        ? `storage: claude set — kit appends to ${name}'s claude transcript ${cur.claudeTranscript} (kit --overwrite), so the session doesn't fork`
        : `storage: claude set — no transcript at resume: ${set.resume ?? cur.pin} yet; kit creates it in claude's store, where claude will find it again`,
    );
    if (cur.shareTools && cur.shareTools !== "none") notes.push(`shareTools: ${cur.shareTools} kept for claude — kit has no MCP client, so it gets no shared servers`);
    return { set, summary: summarize(name, set, removed), notes, undo: `paw restart ${name} --agent claude` };
  }

  // kit → kit: the new flags win; a persona key saying the same thing goes, so ONE record says it.
  const undo = kitUndo(name, cur);
  if (given) {
    if (all.model) {
      drop("model");
      drop("provider");
    }
    if (all.provider) drop("provider");
    if (all.effort) drop("variant");
  }
  const provider = "provider" in set ? undefined : cur.provider;
  if (!all.model && !all.provider && !provider)
    throw new Error(`paw: kit needs a model or provider — add -m <model> or -P codex|grok after \`--\``);
  if (!Object.keys(set).length) return { set, summary: `persona ${name}: already kit with these flags, unchanged`, notes, undo: "" };
  return { set, summary: summarize(name, set, removed), notes, undo };
}

/** The persona as {@link planSwap} reads it. A registered agent always has its persona file. */
export function readSwapPersona(space: string, name: string): SwapPersona {
  const file = personaFilePath(space, name);
  if (!existsSync(file)) throw new Error(`paw: "${name}" has no persona file (${file}) — nothing to swap`);
  const pin = readResumeId(file);
  const scalar = (k: string) => personaValue(file, k)?.replace(/^["']|["']$/g, "") || undefined;
  return {
    file,
    agent: readAgentType(file),
    pin,
    storage: scalar("storage"),
    kitArgs: readKitArgs(file),
    claudeArgs: readClaudeArgs(file),
    provider: scalar("provider"),
    model: readModel(file),
    variant: scalar("variant"),
    shareTools: readShareTools(file),
    claudeTranscript: pin ? transcriptPath(pin, [claudeProjectsRoot()]) : undefined,
    kitTranscript: pin ? transcriptPath(pin, [kitSessionsRoot()]) : undefined,
  };
}

/**
 * Plan, check with the kit binary itself (it must parse every flag, else nothing is written), save,
 * and print exactly what was saved plus the undo. Returns false when nothing changed.
 */
export function applySwap(space: string, name: string, req: SwapRequest, log: (line: string) => void): boolean {
  const cur = readSwapPersona(space, name);
  const plan = planSwap(name, cur, req);
  const kitArgs = plan.set.kitArgs !== undefined ? (JSON.parse(plan.set.kitArgs) as string[]) : "kitArgs" in plan.set ? [] : cur.kitArgs;
  if (req.agent.trim() === KIT_AGENT) preflightKitArgs(ensureKitBinary(), kitArgs, `"${name}"`);
  if (!Object.keys(plan.set).length) {
    log(plan.summary);
    return false;
  }
  setPersonaKeys(space, name, plan.set);
  log(`${plan.summary} (saved; undo: ${plan.undo})`);
  for (const n of plan.notes) log(`  ${n}`);
  return true;
}

/** The command (or edit) that restores this kit persona's harness settings. */
function kitUndo(name: string, cur: SwapPersona): string {
  const keys = (["provider", "model", "variant"] as const).filter((k) => cur[k] !== undefined).map((k) => `${k}: ${cur[k]}`);
  const cmd = `paw restart ${name} --agent kit --${cur.kitArgs.length ? ` ${argsLine(cur.kitArgs)}` : ""}`;
  return keys.length ? `${cmd}, and put back ${keys.join(", ")} in ${cur.file}` : cmd;
}

function summarize(name: string, set: Record<string, string | undefined>, removed: string[]): string {
  const written = Object.entries(set).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  const parts = [...written, ...(removed.length ? [`removed ${removed.join(", ")}`] : [])];
  return `persona ${name}: ${parts.join(", ")}`;
}
