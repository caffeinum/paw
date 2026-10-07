/**
 * Hermetic checks for agent personalities (docs/notes/personalities.md). No broker, no manager.
 *
 *  - the generator: deterministic per (seed, domain), never emits a forbidden (non-style) trait, vibe
 *    ≤120 chars, one single-codepoint emoji, hue 0–359, name-joke overrides; the repo-domain heuristic;
 *  - frontmatter round-trip through paw's line-based writer AND cotal's real YAML loader (a vibe with
 *    `: `, ` #` and quotes survives); malformed values fail loud;
 *  - birth: ensurePersonaFile draws one, keeps a pre-set one / `personality: none`, never re-draws;
 *  - brief rendering: the VOICE line right after the identity line, for claude (meshBrief + the real
 *    buildLaunch file) and kit (kitBrief + readKitPersona); absent when opted out or killed;
 *  - kill switch PAW_PERSONALITY=off (voice gone, glyph stays); `--personality` arg parsing;
 *  - `paw persona`: reroll, --none, backfill dry run leaves files byte-identical, --apply writes
 *    frontmatter only and skips none / existing vibe / hand-written bodies;
 *  - UI: paw status puts the emoji before the name; JSON rows carry emoji + hue.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pawpers-"));
process.env.PAW_HOME = home;
process.env.HOME = join(home, "h");
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(join(process.env.HOME, ".claude.json"), "{}");
process.env.PAW_ROOT = realpathSync(tmpdir());
delete process.env.PAW_PERSONALITY;

const P = await import("../src/personality.ts");
const { setPersonaKeys, ensurePersonaFile, personaFilePath, folderToName } = await import("../src/addressing.ts");
const { meshBrief, pawConnector } = await import("../src/connector.ts");
const { kitBrief, readKitPersona } = await import("../src/kit.ts");
const { loadAgentFile } = await import("@cotal-ai/core");
const { runPersona, planBackfill, parsePersonaArgs } = await import("../src/persona.ts");
const { formatStatus } = await import("../src/status.ts");
const { parseArgs: parseChatArgs } = await import("../src/chat.ts");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const throws = (f: () => unknown, re: RegExp = /./) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};
const quiet = <T>(f: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try {
    return f();
  } finally {
    console.log = log;
  }
};

// ── generator ──────────────────────────────────────────────────────────────────────────────────────
{
  const a = P.drawPersonality("queue", "infra");
  const b = P.drawPersonality("queue", "infra");
  ok("deterministic: same seed + domain → same personality", JSON.stringify(a) === JSON.stringify(b), `${a.emoji} ${a.vibe}`);
  const distinct = new Set(Array.from({ length: 50 }, (_, i) => P.drawPersonality(`s${i}`, "general").vibe));
  ok("different seeds spread out (≥40 distinct vibes of 50)", distinct.size >= 40, `${distinct.size}`);

  let bad: string | undefined;
  for (const domain of P.DOMAINS) {
    for (let i = 0; i < 3000 && !bad; i++) {
      const p = P.drawPersonality(`seed-${i}`, domain, `agent-${i}`);
      const trait = P.forbiddenTrait(p.vibe);
      if (trait) bad = `forbidden "${trait}" in ${p.vibe}`;
      else if (p.vibe.length > P.VIBE_MAX) bad = `too long: ${p.vibe}`;
      else if (!Number.isInteger(p.hue) || p.hue < 0 || p.hue > 359) bad = `hue ${p.hue}`;
      else if ([...p.emoji].length !== 1) bad = `emoji is not one codepoint: ${p.emoji}`;
      else if (throws(() => P.assertVibe(p.vibe, "t"))) bad = `assertVibe refused a draw: ${p.vibe}`;
    }
  }
  ok("21k draws: never a forbidden trait, ≤120 chars, hue 0–359, one single-codepoint emoji", !bad, bad);

  for (const v of ["bold ginger tabby", "a careful siamese", "world-class reviewer cat", "yolo calico; ships fast", "thorough and honest", "never asks before acting"]) {
    ok(`forbiddenTrait catches: "${v}"`, P.forbiddenTrait(v) !== undefined);
  }
  ok("forbiddenTrait: no false hit inside a word (breakfast, boldface-free)", P.forbiddenTrait("breakfast-loving tabby; skipper's log style") === undefined);
  ok("name joke: canary gets 🐤", P.drawPersonality("canary", "infra", "canary").emoji === "🐤");
  ok("name joke keyed on the NAME, not a reroll seed", P.drawPersonality("canary-1a2b3c", "infra", "canary").emoji === "🐤");
}

// ── repo domain ────────────────────────────────────────────────────────────────────────────────────
{
  const sig = (name: string, text = "", files: string[] = [], deps: string[] = []) => ({ name, text, files, deps });
  ok("domain: evals from the name", P.domainFromSignals(sig("evals")) === "evals");
  ok("domain: infra from Dockerfile + fly.toml", P.domainFromSignals(sig("thing", "", ["Dockerfile", "fly.toml"])) === "infra");
  ok("domain: ui from a react dep", P.domainFromSignals(sig("thing", "", ["package.json"], ["react"])) === "ui");
  ok("domain: bot from the readme", P.domainFromSignals(sig("dora", "A telegram bot that answers questions")) === "bot");
  ok("domain: the folder name beats a ui dependency (team2027/evals runs react)", P.domainFromSignals(sig("evals", "", ["package.json"], ["react"])) === "evals");
  ok("domain: a worktree reads its repo's name", P.repoSignals("/nope/evals/.claude/worktrees/agent-abc").name === "agent-abc evals");
  ok("domain: nothing → general",P.domainFromSignals(sig("xyzzy")) === "general");
  ok("domain: a tie → general (never a guess)", P.domainFromSignals(sig("x", "docs telegram")) === "general");
  const repo = mkdtempSync(join(tmpdir(), "pawpers-repo-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", dependencies: { svelte: "1" } }));
  writeFileSync(join(repo, "README.md"), "# x\n\nThe landing site for our design studio.\n");
  ok("repoDomain reads package.json + README", P.repoDomain(repo) === "ui");
  ok("repoDomain: a missing folder is general, not a throw", P.repoDomain(join(repo, "nope")) === "general");
}

// ── frontmatter round-trip ─────────────────────────────────────────────────────────────────────────
const space = "pers";
{
  const name = "rt";
  const file = personaFilePath(space, name);
  writeFileSync(file, `---\nname: rt\ncwd: /tmp\nresume: 0000\nsubscribe: [general]\n---\nHand body line.\n`);
  const vibe = `calm tabby: says "hi" #1, then 'status'; numbers first`;
  const p = { ...P.drawPersonality("rt", "general"), vibe };
  setPersonaKeys(space, name, P.personalityKeys(p));
  const back = P.readPersonality(file);
  ok("round-trip: vibe with `: `, ` #`, quotes survives paw's writer", back.kind === "set" && back.vibe === vibe, JSON.stringify(back));
  ok("round-trip: emoji, hue, seed", back.kind === "set" && back.emoji === p.emoji && back.hue === p.hue && back.seed === "rt");
  const raw = readFileSync(file, "utf8");
  ok("round-trip: body and other keys untouched", raw.endsWith("---\nHand body line.\n") && /resume: 0000/.test(raw) && /cwd: \/tmp/.test(raw));
  const def = loadAgentFile(file);
  ok("cotal's YAML loader reads the same vibe into card meta", def.meta?.vibe === vibe, String(def.meta?.vibe));
  ok("cotal meta carries emoji + hue (broadcast in presence)", def.meta?.emoji === p.emoji && String(def.meta?.hue) === String(p.hue));
  setPersonaKeys(space, name, P.personalityKeys({ ...p, vibe: "quiet ginger; plain words" }));
  ok("rewrite replaces, never duplicates, the keys", (readFileSync(file, "utf8").match(/^vibe:/gm) ?? []).length === 1);

  const bad = (k: string, v: string) => {
    const f = personaFilePath(space, `bad-${k}`);
    writeFileSync(f, `---\nname: bad\nvibe: calm tabby\n${k}: ${v}\n---\nb\n`);
    return f;
  };
  ok("malformed: hue: blue fails loud", throws(() => P.readPersonality(bad("hue", "blue")), /hue/));
  ok("malformed: hue: 400 fails loud", throws(() => P.readPersonality(bad("hue", "400")), /0–359/));
  ok("malformed: a two-emoji emoji fails loud", throws(() => P.readPersonality(bad("emoji", "🐈🐈")), /one emoji/));
  ok("malformed: a letter is not an emoji", throws(() => P.readPersonality(bad("emoji", "x")), /one emoji/));
  ok("malformed: personality: maybe fails loud", throws(() => P.readPersonality(bad("personality", "maybe")), /none/));
  const long = personaFilePath(space, "bad-long");
  writeFileSync(long, `---\nname: x\nvibe: ${"a".repeat(121)}\n---\nb\n`);
  ok("malformed: a vibe over 120 chars fails loud", throws(() => P.readPersonality(long), /≤120/));
  const yolo = personaFilePath(space, "bad-yolo");
  writeFileSync(yolo, `---\nname: x\nvibe: reckless tabby who ships\n---\nb\n`);
  ok("a hand-edited vibe with a behaviour trait fails loud at spawn", throws(() => pawConnector.buildLaunch({ space: "demo", workspaceRoot: home, name: "x", configPath: yolo }), /STYLE only/));
  ok("…and the UI reader reports it instead of throwing", P.personaGlyph(yolo).error?.includes("reckless") === true);
}

// ── birth ──────────────────────────────────────────────────────────────────────────────────────────
{
  const folder = mkdtempSync(join(tmpdir(), "pawpers-evals-"));
  writeFileSync(join(folder, "README.md"), "# e\n\nThe eval leaderboard and scoring rules.\n");
  const name = folderToName(space, realpathSync(folder));
  const file = ensurePersonaFile(space, name);
  const got = P.readPersonality(file);
  const want = P.drawPersonality(name, P.repoDomain(realpathSync(folder)), name);
  ok("birth draws a personality seeded by the name, tilted by the repo", got.kind === "set" && got.vibe === want.vibe && got.emoji === want.emoji && got.hue === want.hue, got.kind === "set" ? got.vibe : got.kind);
  ok("birth repo domain is evals here", P.repoDomain(realpathSync(folder)) === "evals");
  setPersonaKeys(space, name, { vibe: undefined });
  ensurePersonaFile(space, name);
  ok("a born persona is never re-drawn by a later spawn", P.readPersonality(file).kind === "unset");

  setPersonaKeys(space, "twin", { cwd: "/tmp/twin", ...P.NO_PERSONALITY_KEYS });
  ensurePersonaFile(space, "twin");
  ok("birth keeps personality: none", P.readPersonality(personaFilePath(space, "twin")).kind === "none");

  setPersonaKeys(space, "lit", { cwd: "/tmp/lit", ...P.personalityFor(P.parsePersonalityArg("dreamy studio cat; short and visual"), "lit", "/tmp/lit") });
  ensurePersonaFile(space, "lit");
  const lit = P.readPersonality(personaFilePath(space, "lit"));
  ok("birth keeps an operator-written vibe", lit.kind === "set" && lit.vibe === "dreamy studio cat; short and visual");
}

// ── brief rendering ────────────────────────────────────────────────────────────────────────────────
{
  const file = personaFilePath(space, "voiced");
  writeFileSync(file, `---\nname: voiced\nsubscribe: [general]\nallowSubscribe: [">"]\nallowPublish: [">"]\nresume: 11111111-1111-4111-8111-111111111111\nagent: kit\nprovider: codex\n---\nBody.\n`);
  setPersonaKeys(space, "voiced", P.personalityKeys({ vibe: "unhurried night-shift tabby; status in one line", emoji: "🐈", hue: 212, seed: "voiced" }));
  const voice = P.voiceLineFor(file)!;
  ok("voice line: style-only framing, aeon's cats, the vibe", /^VOICE \(style only\): you are one of aeon's cats — unhurried night-shift tabby/.test(voice));
  ok("voice line: personality everywhere incl. agent DMs, code/commits/PRs/bd plain", /to humans and to other agents/.test(voice) && /code, commits, PR bodies, bd task text/.test(voice));
  ok("voice line: never changes care/thoroughness/honesty", /never how careful, thorough, honest/.test(voice));
  ok("voice line: ≲ 80 words (the ~60-token budget plus the vibe)", voice.split(/\s+/).length <= 80, `${voice.split(/\s+/).length} words`);

  const mb = meshBrief("voiced", voice);
  ok("claude brief: VOICE right after the identity line", mb.startsWith(`You are "voiced", a paw agent rooted at this folder and a peer on the cotal mesh. VOICE (style only)`));
  ok("claude brief: no voice → no VOICE", !meshBrief("voiced").includes("VOICE"));
  const kb = kitBrief("voiced", readKitPersona(file).voice);
  ok("kit brief: VOICE right after kit's identity paragraph", /a teammate by their agent name\. VOICE \(style only\): you are one of aeon's cats/.test(kb));
  ok("kit brief: no voice → no VOICE", !kitBrief("voiced").includes("VOICE"));

  const claudeFile = personaFilePath(space, "voiced-claude");
  writeFileSync(claudeFile, readFileSync(file, "utf8").replace("agent: kit\nprovider: codex\n", ""));
  const args = pawConnector.buildLaunch({ space: "demo", workspaceRoot: home, name: "voiced-claude", configPath: claudeFile }).args;
  const merged = readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8");
  ok("real claude launch: the system-prompt file carries the VOICE line", merged.includes("VOICE (style only): you are one of aeon's cats — unhurried night-shift tabby"));

  process.env.PAW_PERSONALITY = "off";
  ok("kill switch: PAW_PERSONALITY=off drops the voice line", P.voiceLineFor(file) === undefined);
  const argsOff = pawConnector.buildLaunch({ space: "demo", workspaceRoot: home, name: "voiced-claude", configPath: claudeFile }).args;
  ok("kill switch: the real launch has no VOICE", !readFileSync(argsOff[argsOff.indexOf("--append-system-prompt-file") + 1], "utf8").includes("VOICE"));
  ok("kill switch: UI glyph stays", P.personaGlyph(file).emoji === "🐈" && P.personaGlyph(file).hue === 212);
  process.env.PAW_PERSONALITY = "sometimes";
  ok("kill switch: an unknown value fails loud", throws(() => P.voiceLineFor(file), /PAW_PERSONALITY/));
  delete process.env.PAW_PERSONALITY;

  setPersonaKeys(space, "voiced", P.NO_PERSONALITY_KEYS);
  ok("opt-out: personality: none → no voice line", P.voiceLineFor(file) === undefined);
  ok("opt-out: no glyph (UI falls back to the name hash)", JSON.stringify(P.personaGlyph(file)) === "{}");
  ok("opt-out: keys cleared", !/^(vibe|emoji|hue|personality-seed):/m.test(readFileSync(file, "utf8")));
}

// ── args ───────────────────────────────────────────────────────────────────────────────────────────
{
  ok("--personality none", P.parsePersonalityArg("none").kind === "none");
  ok("--personality <word> is a seed", JSON.stringify(P.parsePersonalityArg("queue")) === JSON.stringify({ kind: "seed", seed: "queue" }));
  ok("--personality \"with spaces\" is a vibe", P.parsePersonalityArg("calm tabby; brief").kind === "vibe");
  ok("--personality vibe with a behaviour trait is refused", throws(() => P.parsePersonalityArg("bold tabby who skips tests"), /STYLE only/));
  ok("paw chat parses --personality", parseChatArgs(["--fresh", ".", "--personality", "queue"]).personality === "queue");
  ok("paw persona: --apply without --backfill refused", throws(() => parsePersonaArgs(["--apply"]), /--backfill/));
  ok("paw persona: <name> --reroll <seed>", parsePersonaArgs(["x", "--reroll", "s1"]).seed === "s1");
}

// ── paw persona: reroll / none / backfill ──────────────────────────────────────────────────────────
{
  const s2 = "pers2";
  const mk = (name: string, fm: string, body: string) => writeFileSync(personaFilePath(s2, name), `---\nname: ${name}\ncwd: /tmp/${name}\n${fm}---\n${body}`);
  mk("plain", "", `You are the paw agent for the "plain" folder — a peer on the cotal mesh, acting unattended on this repository.\n`);
  mk("twin", "", "You are aleks. Write in lowercase, short.\n");
  mk("opted", "personality: none\n", `You are the paw agent for the "opted" folder.\n`);
  mk("has", "vibe: calm tabby\n", `You are the paw agent for the "has" folder.\n`);
  mk("unborn", "", "");
  mk("pr", "paw-kind: pr\n", "You are reviewing PR #3 of x/y.\n");
  const snapshot = () => ["plain", "twin", "opted", "has", "unborn", "pr"].map((n) => readFileSync(personaFilePath(s2, n), "utf8")).join("\0");
  const before = snapshot();
  const plan = planBackfill(s2);
  const act = (n: string) => plan.find((r) => r.name === n);
  ok("backfill: a generic-body agent gets a draw", act("plain")?.action === "draw");
  ok("backfill: a per-kind (pr) brief gets a draw", act("pr")?.action === "draw");
  ok("backfill: hand-written body skipped (aleks-twin)", act("twin")?.action === "skip" && /hand-written/.test(act("twin")!.reason!));
  ok("backfill: personality: none skipped", act("opted")?.action === "skip" && /none/.test(act("opted")!.reason!));
  ok("backfill: existing vibe skipped", act("has")?.action === "skip");
  ok("backfill: unborn skipped (drawn at birth)", act("unborn")?.action === "skip");
  quiet(() => runPersona(["--backfill", "--space", s2]));
  ok("backfill dry run: every persona byte-identical", snapshot() === before);
  quiet(() => runPersona(["--backfill", "--apply", "--space", s2]));
  const plainRaw = readFileSync(personaFilePath(s2, "plain"), "utf8");
  ok("backfill --apply: writes the draw", P.readPersonality(personaFilePath(s2, "plain")).kind === "set");
  ok("backfill --apply: body untouched", plainRaw.endsWith(`---\nYou are the paw agent for the "plain" folder — a peer on the cotal mesh, acting unattended on this repository.\n`));
  ok("backfill --apply: skipped ones untouched", ["twin", "opted", "has", "unborn"].every((n) => before.includes(readFileSync(personaFilePath(s2, n), "utf8"))));

  quiet(() => runPersona(["plain", "--reroll", "fresh-seed", "--space", s2]));
  const rr = P.readPersonality(personaFilePath(s2, "plain"));
  const want = P.drawPersonality("fresh-seed", P.repoDomain("/tmp/plain"), "plain");
  ok("reroll <seed>: deterministic new draw", rr.kind === "set" && rr.vibe === want.vibe && rr.seed === "fresh-seed");
  ok("reroll refuses an opted-out agent", throws(() => quiet(() => runPersona(["opted", "--reroll", "--space", s2])), /opted out/));
  quiet(() => runPersona(["twin", "--none", "--space", s2]));
  ok("--none opts out, body untouched", P.readPersonality(personaFilePath(s2, "twin")).kind === "none" && readFileSync(personaFilePath(s2, "twin"), "utf8").endsWith("---\nYou are aleks. Write in lowercase, short.\n"));
}

// ── UI: paw status ─────────────────────────────────────────────────────────────────────────────────
{
  const NOW = 1_800_000_000_000;
  const row = (name: string, extra = {}) => ({ name, folder: "/x", mesh: "idle", live: true, durable: true, conflictPids: [], inbox: { kind: "none" as const }, activeMs: NOW, harness: undefined, ...extra });
  const out = formatStatus([row("queue", { emoji: "😼", hue: 212 }), row("plainname")], NOW, Number.POSITIVE_INFINITY);
  const lines = out.split("\n");
  ok("status: emoji before the name", lines.some((l) => l.includes("😼 queue")));
  ok("status: a glyph-less row keeps the column (3-cell slot)", lines.some((l) => /^   plainname|^\S*   \S*plainname/.test(l.replace(/\x1b\[[0-9;]*m/g, ""))));
  const none = formatStatus([row("plainname")], NOW, Number.POSITIVE_INFINITY);
  ok("status: no personalities → no glyph slot (unchanged layout)", none.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[1].startsWith("plainname"));
}

console.log(fails ? `\n${fails} FAILED` : "\nall personality checks passed");
process.exit(fails ? 1 : 0);
