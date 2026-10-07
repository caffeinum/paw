/**
 * `paw persona` — an agent's personality (docs/notes/personalities.md), local and file-only:
 *
 *   paw persona <name>                  show it (emoji, hue, vibe, seed, repo domain, the VOICE line)
 *   paw persona <name> --reroll [seed]  draw a new one (a fresh random seed unless given)
 *   paw persona <name> --none           opt out (`personality: none`: no voice, no glyph)
 *   paw persona --backfill [--apply]    give the existing fleet personalities — DRY RUN unless --apply
 *
 * It only ever writes persona FRONTMATTER (never a body) and NEVER restarts anything: the voice reaches
 * the model at the agent's next natural restart, because the system prompt is read at spawn.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { listAgents, personaFilePath, setPersonaKeys, withRegistryLock } from "./addressing.ts";
import { resolveSpace } from "./lifecycle.ts";
import { NO_PERSONALITY_KEYS, personalityKeys, personalityVoiceOn, drawPersonality, readPersonality, repoDomain, voiceLine } from "./personality.ts";
import { personaValue, readCwd } from "./session.ts";

type Args = { space?: string; name?: string; reroll: boolean; seed?: string; none: boolean; backfill: boolean; apply: boolean };

export function parsePersonaArgs(argv: string[]): Args {
  const out: Args = { reroll: false, none: false, backfill: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--reroll") out.reroll = true;
    else if (a === "--none") out.none = true;
    else if (a === "--backfill") out.backfill = true;
    else if (a === "--apply") out.apply = true;
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — ${USAGE}`);
    else if (out.name === undefined) out.name = a;
    else if (out.reroll && out.seed === undefined) out.seed = a;
    else throw new Error(`paw: unexpected argument "${a}" — ${USAGE}`);
  }
  if (out.backfill && (out.name || out.reroll || out.none)) throw new Error(`paw: --backfill covers the whole fleet — it takes no name, --reroll or --none`);
  if (out.apply && !out.backfill) throw new Error("paw: --apply goes with --backfill");
  if (out.reroll && out.none) throw new Error("paw: --reroll and --none contradict each other");
  if (!out.backfill && !out.name) throw new Error(`paw: which agent? — ${USAGE}`);
  return out;
}

const USAGE = "persona <name> [--reroll [seed] | --none] | persona --backfill [--apply]";
const APPLIES = "applies at its next restart — nothing was restarted";

/** The persona body, without frontmatter. */
function body(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n").match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)?.[1].trim() ?? "";
}

/** Is the body the one paw writes at birth (the generic line, or a per-kind web/pr brief)? A body the
 *  operator wrote may already BE a voice (aleks-twin) — backfill never layers a cat over that. */
function machineBody(file: string): boolean {
  const kind = personaValue(file, "paw-kind");
  return (kind !== undefined && kind !== "folder") || body(file).startsWith(`You are the paw agent for the "`);
}

export type BackfillRow = { name: string; action: "draw" | "skip"; reason?: string; emoji?: string; vibe?: string; domain?: string; keys?: Record<string, string | undefined> };

/** What `--backfill` would do for every registered agent. Pure apart from reading persona files and repos. */
export function planBackfill(space: string): BackfillRow[] {
  return listAgents(space).map(({ name, folder }) => {
    const file = personaFilePath(space, name);
    let current;
    try {
      current = readPersonality(file);
    } catch (e) {
      return { name, action: "skip" as const, reason: `malformed: ${(e as Error).message.replace(/^paw: /, "")}` };
    }
    if (current.kind === "none") return { name, action: "skip" as const, reason: "personality: none" };
    if (current.kind === "set") return { name, action: "skip" as const, reason: "has a vibe" };
    if (!body(file)) return { name, action: "skip" as const, reason: "unborn — drawn at its birth" };
    if (!machineBody(file)) return { name, action: "skip" as const, reason: "hand-written body — `paw persona " + name + " --reroll` or --none" };
    const domain = repoDomain(folder);
    const p = drawPersonality(name, domain, name);
    const keys = personalityKeys({ ...p, emoji: current.emoji ?? p.emoji, hue: current.hue ?? p.hue });
    return { name, action: "draw" as const, emoji: current.emoji ?? p.emoji, vibe: p.vibe, domain, keys };
  });
}

function show(space: string, name: string): void {
  const file = personaFilePath(space, name);
  if (!existsSync(file)) throw new Error(`paw: no agent "${name}" in space "${space}" (\`paw status\` lists them)`);
  const p = readPersonality(file);
  console.log(`${name}  (${file})`);
  if (p.kind === "none") {
    console.log("  personality: none — no voice line, no glyph");
    return;
  }
  if (p.kind === "unset") {
    console.log(`  no personality yet — \`paw persona ${name} --reroll\` draws one (or \`paw persona --backfill\`)`);
    return;
  }
  console.log(`  emoji   ${p.emoji ?? "—"}`);
  console.log(`  hue     ${p.hue ?? "—"}`);
  console.log(`  vibe    ${p.vibe}`);
  console.log(`  seed    ${p.seed ?? "—"}   domain ${repoDomain(readCwd(file))}`);
  console.log(personalityVoiceOn() ? `  brief   ${voiceLine(p)}` : "  brief   (PAW_PERSONALITY=off — no voice line; glyphs stay)");
}

function reroll(space: string, name: string, seed: string | undefined): void {
  const file = personaFilePath(space, name);
  if (!existsSync(file)) throw new Error(`paw: no agent "${name}" in space "${space}" (\`paw status\` lists them)`);
  if (readPersonality(file).kind === "none") {
    throw new Error(`paw: "${name}" opted out (personality: none in ${file}) — delete that line first if it should have one`);
  }
  const s = seed ?? `${name}-${randomBytes(3).toString("hex")}`;
  const p = drawPersonality(s, repoDomain(readCwd(file)), name);
  withRegistryLock(space, () => setPersonaKeys(space, name, personalityKeys(p)));
  console.log(`✓ ${name}: ${p.emoji}  hue ${p.hue}  seed ${s}`);
  console.log(`  ${p.vibe}`);
  console.log(`  ${APPLIES}`);
}

function optOut(space: string, name: string): void {
  const file = personaFilePath(space, name);
  if (!existsSync(file)) throw new Error(`paw: no agent "${name}" in space "${space}" (\`paw status\` lists them)`);
  withRegistryLock(space, () => setPersonaKeys(space, name, NO_PERSONALITY_KEYS));
  console.log(`✓ ${name}: personality: none — ${APPLIES}`);
}

export function formatBackfill(rows: BackfillRow[], apply: boolean): string {
  const width = Math.max(5, ...rows.map((r) => r.name.length));
  const lines = rows.map((r) =>
    r.action === "draw" ? `  ${r.name.padEnd(width)}  ${r.emoji} · ${r.vibe}  [${r.domain}]` : `  ${r.name.padEnd(width)}  — skip: ${r.reason}`,
  );
  const draws = rows.filter((r) => r.action === "draw").length;
  const tail = apply
    ? `✓ wrote personalities for ${draws} agent(s) — frontmatter only; each ${APPLIES}`
    : `dry run: ${draws} agent(s) would get a personality — \`paw persona --backfill --apply\` writes them (frontmatter only, no restarts)`;
  return [...lines, "", tail].join("\n");
}

function backfill(space: string, apply: boolean): void {
  const rows = planBackfill(space);
  if (apply) {
    withRegistryLock(space, () => {
      for (const r of rows) if (r.action === "draw") setPersonaKeys(space, r.name, r.keys!);
    });
  }
  console.log(formatBackfill(rows, apply));
}

export function runPersona(argv: string[]): void {
  const a = parsePersonaArgs(argv);
  const space = a.space?.trim() || resolveSpace();
  if (a.backfill) return backfill(space, a.apply);
  if (a.none) return optOut(space, a.name!);
  if (a.reroll) return reroll(space, a.name!, a.seed);
  show(space, a.name!);
}

const personaCommand: Command = {
  kind: "command",
  name: "persona",
  group: "Mesh",
  summary: "an agent's personality (emoji · hue · vibe) — show, --reroll [seed], --none, or --backfill the fleet (dry run unless --apply); never restarts",
  usage: `${USAGE}   (frontmatter only; takes effect at each agent's next natural restart)`,
  run: async (a) => runPersona([...a.raw]),
};

registry.register(personaCommand);
