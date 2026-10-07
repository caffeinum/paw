/**
 * Agent personalities (docs/notes/personalities.md): every paw agent is one of aeon's cats with its own
 * temperament. Four FLAT persona keys — `vibe`, `emoji`, `hue`, `personality-seed` — or `personality: none`
 * to opt out. Flat because cotal sweeps only scalar frontmatter keys into the card's `meta` (a nested
 * block is dropped), and paw's line-based setPersonaKeys can't edit a block anyway.
 *
 * HARD RULE: a personality varies STYLE only — verbosity, warmth, humour, formality, metaphor, sign-off.
 * Never caution, honesty, thoroughness, competence or autonomy: with bypassPermissions a "bold"/"yolo"
 * vibe is a real hazard, and "world-class X" personas measurably change behaviour. The tables below are
 * curated to that rule and FORBIDDEN guards both them and any operator-written vibe.
 *
 * Seeded and offline: mulberry32(fnv1a(seed)) over the tables, weighted by a cheap repo-domain heuristic.
 * Same seed + domain ⇒ same personality. No LLM call.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { personaValue } from "./session.ts";

export const DOMAINS = ["infra", "evals", "ui", "data", "docs", "bot", "general"] as const;
export type Domain = (typeof DOMAINS)[number];

export type Personality = { vibe: string; emoji: string; hue: number; seed: string };
/** What a persona file says: opted out, a personality, or nothing yet (an unborn / pre-personality agent). */
export type PersonaPersonality = { kind: "none" } | { kind: "set"; vibe: string; emoji?: string; hue?: number; seed?: string } | { kind: "unset"; emoji?: string; hue?: number };

export const VIBE_MAX = 120;

/** Words that move behaviour rather than style. Matched as whole words, case-insensitively. */
const FORBIDDEN = [
  "bold", "boldly", "reckless", "yolo", "fearless", "daring", "hasty", "fast", "quick", "rush", "rushes", "rushed", "impatient",
  "careful", "careless", "cautious", "thorough", "meticulous", "rigorous", "diligent", "sloppy", "lazy", "perfectionist", "paranoid",
  "honest", "dishonest", "truthful", "blunt", "brutal", "brutally", "lies", "fibs",
  "expert", "genius", "senior", "world-class", "10x", "rockstar", "ninja", "guru", "master",
  "autonomous", "autonomy", "independent", "confident", "overconfident", "risk", "risky", "risks", "skip", "skips", "shortcut", "shortcuts",
  "sceptical", "skeptical", "sceptic", "skeptic", "precise", "trusts", "distrusts", "obedient", "rebellious", "defiant", "ignores", "never asks",
];
const FORBIDDEN_RE = new RegExp(`(^|[^a-z0-9-])(${FORBIDDEN.map((w) => w.replace(/[-]/g, "\\-")).join("|")})(?=$|[^a-z0-9-])`, "i");

/** The forbidden trait word a vibe carries, if any. */
export function forbiddenTrait(vibe: string): string | undefined {
  return FORBIDDEN_RE.exec(vibe)?.[2]?.toLowerCase();
}

type W = { t: string; d: readonly Domain[] };
const w = (t: string, ...d: Domain[]): W => ({ t, d });

const TEMPERAMENTS: readonly W[] = [
  w("unhurried", "infra", "data"), w("calm", "infra"), w("deadpan", "infra", "evals"), w("dry-witted", "evals", "general"),
  w("quiet", "infra", "docs"), w("sunny", "ui", "bot"), w("cheerful", "bot", "ui"), w("gentle", "docs", "bot"),
  w("wry", "evals", "general"), w("dreamy", "ui"), w("playful", "ui", "bot"), w("prim", "docs", "evals"),
  w("matter-of-fact", "infra", "data", "evals"), w("chatty", "bot", "general"), w("laconic", "infra"), w("warm", "bot", "docs", "general"),
  w("droll", "general", "data"), w("serene", "data", "docs"), w("whimsical", "ui"), w("tidy-minded", "docs", "data"),
];
const SETTINGS: readonly W[] = [
  w("night-shift", "infra"), w("windowsill", "general", "ui"), w("library", "docs", "evals"), w("boatyard", "infra"),
  w("greenhouse", "data", "ui"), w("bookshop", "docs"), w("observatory", "data", "evals"), w("workshop", "infra", "general"),
  w("studio", "ui"), w("post-office", "bot"), w("lighthouse", "infra"), w("bakery", "bot", "general"), w("archive", "docs", "evals"),
  w("harbour", "infra", "data"), w("rooftop", "general", "ui"),
];
const COATS: readonly string[] = [
  "tabby", "ginger", "tuxedo cat", "calico", "black cat", "siamese", "maine coon", "grey shorthair", "russian blue",
  "tortoiseshell", "ragdoll", "bengal", "scottish fold", "forest cat", "persian", "sphynx", "white cat", "marmalade cat",
  "snowshoe", "burmese",
];
const HABITS: readonly W[] = [
  w("status in one line, numbers first", "infra", "data"),
  w("short sentences, no exclamation marks", "infra", "general", "evals"),
  w("leads with the number, then the story", "evals", "data"),
  w("describes changes as what the screen now shows", "ui"),
  w("thinks in boxes and arrows, short and visual", "ui"),
  w("plain words, one idea per line", "docs", "general"),
  w("writes like a tidy changelog", "docs", "infra"),
  w("warm and brief, greets people by name", "bot", "general"),
  w("dry one-liners, at most one pun per message", "general", "evals"),
  w("speaks in gentle understatement", "general", "infra"),
  w("reaches for weather metaphors", "infra", "data"),
  w("reaches for kitchen metaphors", "general", "bot"),
  w("reaches for garden metaphors", "data", "docs"),
  w("reaches for nautical metaphors", "infra"),
  w("reaches for map-and-compass metaphors", "data", "general"),
  w("talks like a radio operator, brief and clear", "infra", "bot"),
  w("lists before paragraphs", "docs", "data", "evals"),
  w("lowercase and terse, the odd purr", "general"),
  w("cosy and conversational", "bot", "ui"),
  w("formal and courteous, like a ship's log", "infra", "docs"),
];
const SIGNOFFS: readonly string[] = [
  "signs off with a slow blink", "ends with a tail flick", "ends updates with what comes next", "never signs off",
  "ends on a one-word summary", "purrs at good news", "a small meow when things go green", "now and then a tiny haiku",
];
/** Single-codepoint, always-wide emoji only: a ZWJ sequence (🐈‍⬛) or a variation selector makes
 *  readline mis-measure the prompt in `paw chat`, and the cursor lands in the wrong column. */
const EMOJI: readonly string[] = ["🐈", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😾", "🐾", "🦁", "🐯", "🐆", "🐅"];
/** Name jokes the draw honours (the doc's canary): a name that begs for a glyph gets it. */
const NAME_EMOJI: ReadonlyArray<[RegExp, string]> = [
  [/canary/, "🐤"], [/fox/, "🦊"], [/owl/, "🦉"], [/bee(s)?\b|hive/, "🐝"], [/crab|rust/, "🦀"], [/whale|docker/, "🐳"],
  [/octo|github/, "🐙"], [/lion/, "🦁"], [/tiger/, "🐯"], [/mouse/, "🐭"], [/raven|crow/, "🐦"],
];

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted pick: an entry tagged with the repo's domain counts 3, any other 1. */
function pick(rng: () => number, list: readonly W[], domain: Domain): string {
  const weights = list.map((e) => (e.d.includes(domain) ? 3 : 1));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) if ((r -= weights[i]) < 0) return list[i].t;
  return list[list.length - 1].t;
}
const pickPlain = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

/**
 * Draw a personality. Deterministic in (seed, domain, name). Every draw consumes the rng in the same
 * order so a table edit late in the sequence doesn't reshuffle earlier picks for other agents.
 */
export function drawPersonality(seed: string, domain: Domain, name: string = seed): Personality {
  const rng = mulberry32(fnv1a(`${seed}\u0000paw-personality`));
  const temperament = pick(rng, TEMPERAMENTS, domain);
  const setting = rng() < 0.5 ? pick(rng, SETTINGS, domain) : (rng(), undefined);
  const coat = pickPlain(rng, COATS);
  const habit = pick(rng, HABITS, domain);
  const signoff = rng() < 0.6 ? pickPlain(rng, SIGNOFFS) : (rng(), undefined);
  const emojiDraw = pickPlain(rng, EMOJI);
  const hue = Math.floor(rng() * 360);
  const nameEmoji = NAME_EMOJI.find(([re]) => re.test(name.toLowerCase()))?.[1];
  const compose = (withSetting: boolean, withSignoff: boolean) =>
    `${temperament} ${withSetting && setting ? `${setting} ` : ""}${coat}; ${habit}${withSignoff && signoff ? `; ${signoff}` : ""}`;
  const vibe = [compose(true, true), compose(false, true), compose(true, false), compose(false, false)].find((v) => v.length <= VIBE_MAX)!;
  return { vibe, emoji: nameEmoji ?? emojiDraw, hue, seed };
}

// ── repo domain ────────────────────────────────────────────────────────────────────────────────────

export type RepoSignals = { name: string; text: string; files: string[]; deps: string[] };

const DOMAIN_WORDS: Record<Exclude<Domain, "general">, readonly string[]> = {
  evals: ["eval", "evals", "evaluation", "benchmark", "benchmarks", "leaderboard", "scoring", "grader", "judge", "harbor"],
  infra: ["infra", "deploy", "deployment", "queue", "fly", "docker", "kubernetes", "k8s", "terraform", "daemon", "ops", "sre", "pipeline", "worker", "canary", "cluster", "server", "proxy", "nats"],
  ui: ["ui", "frontend", "web", "design", "canvas", "css", "react", "svelte", "vue", "landing", "site", "website", "figma", "paper", "tracepaper", "dashboard"],
  data: ["data", "analytics", "etl", "sql", "dataset", "datasets", "pandas", "notebook", "metrics", "warehouse", "scrape", "scraper"],
  docs: ["docs", "documentation", "blog", "notes", "wiki", "writing", "book", "handbook", "essay", "essays"],
  bot: ["bot", "telegram", "discord", "slack", "assistant", "bridge", "chatbot", "twitter", "social"],
};
const UI_DEPS = ["react", "svelte", "vue", "next", "vite", "tailwindcss", "astro", "@remix-run/react", "solid-js"];
const DATA_DEPS = ["pandas", "numpy", "polars", "duckdb", "jupyter"];
const BOT_DEPS = ["grammy", "telegraf", "discord.js", "@slack/bolt", "node-telegram-bot-api"];

/** Pure: which domain the signals point at. Name hits weigh 4 (the folder name beats a dependency), text 1, file/dep evidence 2–3; a tie or
 *  nothing at all is `general` (never a guess between two). */
export function domainFromSignals(s: RepoSignals): Domain {
  const tokens = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const score: Record<Domain, number> = { infra: 0, evals: 0, ui: 0, data: 0, docs: 0, bot: 0, general: 0 };
  for (const [d, words] of Object.entries(DOMAIN_WORDS) as Array<[Exclude<Domain, "general">, readonly string[]]>) {
    for (const tok of tokens(s.name)) if (words.includes(tok)) score[d] += 4;
    for (const tok of tokens(s.text)) if (words.includes(tok)) score[d] += 1;
  }
  const has = (f: string) => s.files.includes(f);
  if (has("go.mod")) score.infra += 1;
  if (has("Dockerfile") || has("fly.toml") || has("docker-compose.yml")) score.infra += 2;
  if (s.files.some((f) => f.endsWith(".tf"))) score.infra += 2;
  if (has("mkdocs.yml") || s.files.some((f) => f.startsWith("docusaurus.config"))) score.docs += 3;
  if (s.files.some((f) => f.endsWith(".ipynb"))) score.data += 2;
  if (s.deps.some((d) => UI_DEPS.includes(d))) score.ui += 3;
  if (s.deps.some((d) => DATA_DEPS.includes(d))) score.data += 2;
  if (s.deps.some((d) => BOT_DEPS.includes(d))) score.bot += 3;
  const ranked = (DOMAINS.filter((d) => d !== "general") as Domain[]).sort((a, b) => score[b] - score[a]);
  return score[ranked[0]] > 0 && score[ranked[0]] > score[ranked[1]] ? ranked[0] : "general";
}

function firstParagraph(readme: string): string {
  const prose = readme
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("<") && !p.startsWith("![") && !p.startsWith("[!["));
  return (prose[0] ?? "").slice(0, 600);
}

/** Read the cheap signals from a folder: its name, README's first paragraph, package.json, root files.
 *  An unreadable/missing folder gives just its name — a domain is flavour, never worth a failed birth. */
export function repoSignals(cwd: string): RepoSignals {
  const dir = resolve(cwd);
  const files = existsSync(dir) ? safe(() => readdirSync(dir), [] as string[]) : [];
  const readmeFile = files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f));
  const readme = readmeFile ? firstParagraph(safe(() => readFileSync(join(dir, readmeFile), "utf8"), "")) : "";
  let text = readme;
  let deps: string[] = [];
  if (files.includes("package.json")) {
    const pkg = safe(() => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>, {} as Record<string, unknown>);
    const kw = Array.isArray(pkg.keywords) ? pkg.keywords.filter((k): k is string => typeof k === "string") : [];
    text += ` ${kw.join(" ")} ${typeof pkg.description === "string" ? pkg.description : ""}`;
    deps = [pkg.dependencies, pkg.devDependencies].flatMap((d) => (d && typeof d === "object" ? Object.keys(d) : []));
  }
  for (const py of ["requirements.txt", "pyproject.toml"]) {
    if (files.includes(py)) deps.push(...safe(() => readFileSync(join(dir, py), "utf8"), "").toLowerCase().split(/[^a-z0-9_.-]+/));
  }
  // A worktree's folder name is a random slug; the repo it belongs to is what says what the agent does.
  const repoRoot = /^(.*?)\/\.(?:claude\/worktrees|superconductor)\//.exec(dir)?.[1];
  return { name: repoRoot ? `${basename(dir)} ${basename(repoRoot)}` : basename(dir), text, files, deps };
}

function safe<T>(f: () => T, fallback: T): T {
  // Personality is flavour: a README we can't read narrows the domain guess, it must not fail a birth.
  try {
    return f();
  } catch {
    return fallback;
  }
}

export function repoDomain(cwd: string | undefined): Domain {
  return cwd ? domainFromSignals(repoSignals(cwd)) : "general";
}

// ── persona keys ───────────────────────────────────────────────────────────────────────────────────

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Validate an operator-written or persona vibe. Throws with the reason. */
export function assertVibe(vibe: string, where: string): void {
  if (!vibe.trim()) throw new Error(`paw: ${where}: vibe is empty`);
  if (vibe.length > VIBE_MAX) throw new Error(`paw: ${where}: vibe is ${vibe.length} chars — keep it ≤${VIBE_MAX}`);
  if (/[\n\r]/.test(vibe)) throw new Error(`paw: ${where}: vibe must be one line`);
  const bad = forbiddenTrait(vibe);
  if (bad) {
    throw new Error(
      `paw: ${where}: vibe uses "${bad}" — a personality changes STYLE only (verbosity, warmth, humour, formality, metaphor), ` +
        `never caution, honesty, thoroughness, competence or autonomy`,
    );
  }
}
export function assertEmoji(emoji: string, where: string): void {
  if ([...SEGMENTER.segment(emoji)].length !== 1 || /^[\x00-\x7f]+$/.test(emoji)) throw new Error(`paw: ${where}: emoji "${emoji}" must be exactly one emoji`);
}
export function parseHue(raw: string, where: string): number {
  if (!/^\d{1,3}$/.test(raw) || Number(raw) > 359) throw new Error(`paw: ${where}: hue "${raw}" must be a whole number 0–359`);
  return Number(raw);
}

/** A persona value as YAML would read it: a JSON-ish double-quoted string, a single-quoted one, or plain. */
function yamlScalar(raw: string | undefined, where: string): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      throw new Error(`paw: ${where} is not a valid double-quoted string (${raw})`);
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw new Error(`paw: ${where} has an unterminated single quote (${raw})`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw.replace(/\s+#.*$/, "").trim() || undefined;
}

/** Quote a value for paw's line-based writer so cotal's real YAML parser reads it back verbatim: a vibe
 *  is prose and routinely holds `: ` or ` #`, which a plain scalar would turn into a map or a comment. */
export function yamlQuote(v: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) ? v : JSON.stringify(v);
}

/** Read the personality keys from a persona file. Malformed values throw (fail loud at spawn). */
export function readPersonality(configPath: string | undefined): PersonaPersonality {
  if (!configPath || !existsSync(resolve(configPath))) return { kind: "unset" };
  const get = (k: string) => yamlScalar(personaValue(configPath, k), `${configPath} ${k}:`);
  const flag = get("personality");
  if (flag !== undefined) {
    if (flag !== "none") throw new Error(`paw: ${configPath}: personality: "${flag}" — the only value is "none" (opt out)`);
    return { kind: "none" };
  }
  const vibe = get("vibe");
  const emoji = get("emoji");
  const hueRaw = get("hue");
  const seed = get("personality-seed");
  if (emoji !== undefined) assertEmoji(emoji, configPath);
  const hue = hueRaw === undefined ? undefined : parseHue(hueRaw, configPath);
  if (vibe === undefined) return { kind: "unset", emoji, hue };
  assertVibe(vibe, configPath);
  return { kind: "set", vibe, emoji, hue, seed };
}

/** The persona keys for a personality (for setPersonaKeys). Clears an opt-out. */
export function personalityKeys(p: Personality): Record<string, string | undefined> {
  return { personality: undefined, vibe: yamlQuote(p.vibe), emoji: p.emoji, hue: String(p.hue), "personality-seed": yamlQuote(p.seed) };
}
/** The persona keys for an opt-out: no voice, no glyph (the UIs fall back to the name hash). */
export const NO_PERSONALITY_KEYS: Record<string, string | undefined> = { personality: "none", vibe: undefined, emoji: undefined, hue: undefined, "personality-seed": undefined };

/** `--personality <seed|"vibe text"|none>`: words with whitespace are a literal vibe, `none` opts out. */
export type PersonalityArg = { kind: "none" } | { kind: "seed"; seed: string } | { kind: "vibe"; vibe: string };
export function parsePersonalityArg(raw: string): PersonalityArg {
  const v = raw.trim();
  if (!v) throw new Error("paw: --personality needs a value — a seed word, a quoted vibe, or none");
  if (v === "none") return { kind: "none" };
  if (/\s/.test(v)) {
    assertVibe(v, "--personality");
    return { kind: "vibe", vibe: v };
  }
  return { kind: "seed", seed: v };
}

/** Resolve a `--personality` arg (or the birth default, a seed = the name) into persona keys. */
export function personalityFor(arg: PersonalityArg | undefined, name: string, cwd: string | undefined): Record<string, string | undefined> {
  if (arg?.kind === "none") return NO_PERSONALITY_KEYS;
  const domain = repoDomain(cwd);
  if (arg?.kind === "vibe") return personalityKeys({ ...drawPersonality(name, domain, name), vibe: arg.vibe });
  return personalityKeys(drawPersonality(arg?.seed ?? name, domain, name));
}

// ── the brief line ─────────────────────────────────────────────────────────────────────────────────

/** `PAW_PERSONALITY=off` silences the voice line fleet-wide (UI glyphs stay). Any other value but
 *  unset/on fails loud rather than being read as either. */
export function personalityVoiceOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PAW_PERSONALITY?.trim().toLowerCase();
  if (!v || v === "on") return true;
  if (v === "off") return false;
  throw new Error(`paw: PAW_PERSONALITY="${env.PAW_PERSONALITY}" — expected "off" (or unset)`);
}

/** The ≤~70-token VOICE line, or undefined when the agent has none / opted out / the kill switch is on. */
export function voiceLine(p: PersonaPersonality, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (p.kind !== "set" || !personalityVoiceOn(env)) return undefined;
  return (
    `VOICE (style only): you are one of aeon's cats — ${p.vibe}. Write your prose in this voice, to humans and to ` +
    `other agents alike; code, commits, PR bodies, bd task text and tool arguments stay plain and professional, and a ` +
    `message's facts, names, paths and asks stay literal. It changes how you sound, never how careful, thorough, ` +
    `honest or independent you are.`
  );
}

/** The voice line for a persona file (the connectors' one call). Throws on a malformed personality. */
export function voiceLineFor(configPath: string | undefined): string | undefined {
  return voiceLine(readPersonality(configPath));
}

// ── UI glyphs ──────────────────────────────────────────────────────────────────────────────────────

/** What the UIs show for an agent: its emoji and hue (absent = the name-hash colour / no glyph). A
 *  malformed personality is RETURNED as `error` rather than thrown — one bad persona must not take a
 *  whole roster view down; the spawn path (voiceLineFor) is where it fails loud. */
export type Glyph = { emoji?: string; hue?: number; error?: string };
export function personaGlyph(configPath: string | undefined): Glyph {
  try {
    const p = readPersonality(configPath);
    return p.kind === "none" ? {} : { emoji: p.emoji, hue: p.hue };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
}

/** ANSI foreground for a hue, light enough to read on a dark terminal: truecolor when the terminal says
 *  so (COLORTERM), else the nearest xterm-256 cube colour. */
export function hueSgr(hue: number, env: NodeJS.ProcessEnv = process.env): string {
  const [r, g, b] = hslToRgb(hue, 0.6, 0.65);
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return `38;2;${r};${g};${b}`;
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return `38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}`;
}
