/**
 * The folder-trust race at spawn (2026-10-03), reproduced hermetically and proven fixed.
 *
 * The race: paw pre-trusts a folder in ~/.claude.json just before spawning, a claude already booting
 * rewrites the file from its stale copy and erases the entry, the new claude meets its trust dialog
 * (default "No, exit"), and paw's readiness nudge — a BLIND Enter — picks "No, exit". Against a real
 * claude that blind Enter exits 1 (checked by hand; the dialog text below is captured from it).
 *
 * Here a fake claude (same dialog text, same default, same keys) runs in a PRIVATE tmux server under a
 * temp HOME, so nothing touches the operator's tmux or ~/.claude.json:
 *   BEFORE  the old behaviour (Enter every poll) → the fake quits at the dialog       (the bug)
 *   AFTER   startupWatch: answers "Yes, I trust this folder", then the dev-channels gate → ready
 *   PTY     no terminal to type into: the re-written entry alone saves a claude that reads it late
 *   POLICY  a folder paw does NOT pre-trust: nothing is sent, the log and cause() say why
 *   OTHER   an unrecognised prompt: nothing is sent, logged with its last lines
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pawtrust-")));
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
process.env.PAW_HOME = join(root, "paw");
delete process.env.PAW_ROOT;
const tmuxDir = mkdtempSync("/tmp/pawtrx-"); // short: tmux socket paths are capped
const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: "" };
const { classifyStartupScreen } = await import("../src/native-attach.ts");
const { startupWatch } = await import("../src/addressing.ts");
const { pretrustFolder, isFolderTrusted } = await import("../src/cwd.ts");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms: number) => {
  for (let t = 0; t < ms && !cond(); t += 100) await sleep(100);
  return cond();
};

// ── classification, against the screen a real claude shows ──────────────────────────────────────
const REAL_TRUST = `────────────────────────────────────────
 Accessing workspace:
 /private/tmp/pawtrustprobe.XS1f
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
const t = classifyStartupScreen(REAL_TRUST);
ok("real trust dialog: cursor on 'No, exit' → Down, Enter", t.kind === "trust" && t.keys?.join() === "Down,Enter", JSON.stringify(t));
const t2 = classifyStartupScreen(" ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm");
ok("cursor already on Yes → Enter only", t2.kind === "trust" && t2.keys?.join() === "Enter");
const t3 = classifyStartupScreen("   No, exit\n   Yes, I trust this folder\n");
ok("no cursor visible → no keys (send nothing)", t3.kind === "trust" && t3.keys === undefined);
ok("dev-channels gate recognised", classifyStartupScreen("WARNING: Loading development channels\nEnter to confirm").kind === "dev-channels");
const idle = classifyStartupScreen("╭───╮\n│ > │\n╰───╯\n ⏵⏵ bypass permissions on");
ok("an idle claude is 'ready'", idle.kind === "ready");
// The screen behind the 2026-10-05 noise ("unrecognised prompt … bypass permissions on"): claude's idle
// input box, with a dialog's leftover "Enter to confirm" still higher up the pane.
const IDLE_REAL = ` Enter to confirm · Esc to cancel

 ✻ Welcome back!
────────────────────────────────────────
❯
────────────────────────────────────────
  🐾 perkmal (Opus 5.5)
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
ok("the real idle box + footer is 'ready' (logs nothing), despite leftover dialog text above", classifyStartupScreen(IDLE_REAL).kind === "ready");
ok("a footer alone, without the input line, is not 'ready'", classifyStartupScreen("Pick one\nEnter to confirm\n bypass permissions on").kind === "other");
const odd = classifyStartupScreen("Update available. Install now? (y/n)");
ok("an unknown y/n question is an unrecognised prompt", odd.kind === "other" && odd.prompt);

// ── the race, end to end, in a private tmux server ───────────────────────────────────────────────
const fake = join(root, "fake-claude.mjs");
writeFileSync(
  fake,
  `import { readFileSync, realpathSync, writeFileSync } from "node:fs";
const mode = process.env.FAKE_MODE ?? "claude";
const cwd = realpathSync(process.cwd());
const mark = (m) => writeFileSync(process.env.FAKE_OUT, m);
const show = (s) => process.stdout.write("\\x1b[2J\\x1b[H" + s + "\\n");
let state, cursor = 0;
const dialog = () => show(" Accessing workspace:\\n " + cwd + "\\n Quick safety check: Is this a project you created or one you trust?\\n" + (cursor === 0 ? " ❯ No, exit\\n   Yes, I trust this folder" : "   No, exit\\n ❯ Yes, I trust this folder") + "\\n Enter to confirm · Esc to cancel");
const gate = () => { state = "gate"; mark("gate"); show(" WARNING: Loading development channels\\n Enter to confirm · Esc to cancel"); };
const start = () => {
  if (mode === "other") { state = "other"; mark("other"); return show(" Telemetry opt-in? Enter to confirm · Esc to cancel"); }
  let trusted = false;
  try { trusted = JSON.parse(readFileSync(process.env.HOME + "/.claude.json", "utf8")).projects?.[cwd]?.hasTrustDialogAccepted === true; } catch {}
  if (trusted) return gate();
  state = "trust"; mark("trust"); dialog();
};
process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  const k = d.toString();
  if (state === "trust") {
    if (k === "\\x1b[B") { cursor = 1; dialog(); }
    else if (k === "\\x1b[A") { cursor = 0; dialog(); }
    else if (k === "\\r") { if (cursor === 0) { mark("exited"); process.exit(1); } gate(); }
  } else if (state === "gate" && k === "\\r") { state = "ready"; mark("ready"); show(" ready ⏵⏵ bypass permissions on"); }
});
setTimeout(start, Number(process.env.FAKE_DELAY ?? 0));
`,
);
const space = "trx";
const tmux = (...a: string[]) => spawnSync("tmux", a, { env: tmuxEnv, encoding: "utf8" });
tmux("new-session", "-d", "-s", `cotal-${space}`, "-n", "shell");

/** Run one boot: pre-trust, the concurrent clobber, the fake claude, and a 500ms poll loop. */
async function boot(name: string, opts: { poll: () => void; mode?: string; delayMs?: number; ms?: number; until: (s: string) => boolean }) {
  const folder = realpathSync(mkdtempSync(join(root, `${name}-`)));
  pretrustFolder(folder); // what paw does right before the spawn
  writeFileSync(join(process.env.HOME!, ".claude.json"), JSON.stringify({ projects: {} })); // a booting claude's stale rewrite
  const out = join(root, `${name}.state`);
  tmux("new-window", "-d", "-t", `cotal-${space}`, "-n", name, "-c", folder, `FAKE_OUT='${out}' FAKE_MODE='${opts.mode ?? "claude"}' FAKE_DELAY='${opts.delayMs ?? 0}' HOME='${process.env.HOME}' '${process.execPath}' '${fake}'; sleep 30`);
  const state = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
  const t0 = Date.now();
  while (Date.now() - t0 < (opts.ms ?? 8000) && !opts.until(state())) {
    opts.poll();
    await sleep(500);
  }
  return { state: state(), folder };
}

// BEFORE: the old blind Enter (exactly what nudgeTmuxConfirm sent on every poll)
{
  const r = await boot("before", { poll: () => void tmux("send-keys", "-t", `cotal-${space}:before`, "Enter"), until: (s) => s === "exited" || s === "ready" });
  ok("BEFORE: an erased entry + the blind Enter = claude quits at the trust dialog (the bug, reproduced)", r.state === "exited", r.state);
}

// AFTER: startupWatch on tmux
{
  const logs: string[] = [];
  const folder = realpathSync(mkdtempSync(join(root, "after2-")));
  pretrustFolder(folder);
  writeFileSync(join(process.env.HOME!, ".claude.json"), JSON.stringify({ projects: {} }));
  const out = join(root, "after2.state");
  const w = startupWatch(space, "after2", folder, { runtime: "tmux", tmuxEnv, log: (l) => logs.push(l) });
  tmux("new-window", "-d", "-t", `cotal-${space}`, "-n", "after2", "-c", folder, `FAKE_OUT='${out}' HOME='${process.env.HOME}' '${process.execPath}' '${fake}'; sleep 30`);
  const state = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
  // Let claude read the erased file and draw its dialog BEFORE paw's first poll — the tmux half of
  // the fix is what's under test here (the PTY case below covers the re-write winning the race).
  ok("AFTER: claude is at the trust dialog before paw polls", await waitFor(() => state() === "trust", 5000), state());
  for (let t0 = Date.now(); Date.now() - t0 < 10000 && state() !== "ready" && state() !== "exited"; await sleep(500)) w.poll();
  ok("AFTER: startupWatch answers the dialog 'Yes' and clears the dev-channels gate — claude boots", state() === "ready", state());
  ok("AFTER: the erased trust entry was re-written", isFolderTrusted(folder));
  ok("AFTER: the log names the erased entry and the answered dialog", logs.some((l) => /lost the trust entry/.test(l)) && logs.some((l) => /answered "Yes, I trust this folder"/.test(l)), logs.join(" | "));
}

// PTY: nothing can type, but a claude that reads ~/.claude.json after the re-write never sees the dialog
{
  const folder = realpathSync(mkdtempSync(join(root, "pty-")));
  pretrustFolder(folder);
  writeFileSync(join(process.env.HOME!, ".claude.json"), JSON.stringify({ projects: {} }));
  const out = join(root, "pty.state");
  const w = startupWatch(space, "pty", folder, { runtime: "pty", tmuxEnv, log: () => {} });
  tmux("new-window", "-d", "-t", `cotal-${space}`, "-n", "pty", "-c", folder, `FAKE_OUT='${out}' FAKE_DELAY=1500 HOME='${process.env.HOME}' '${process.execPath}' '${fake}'; sleep 30`);
  const state = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
  for (let t0 = Date.now(); Date.now() - t0 < 5000 && !state(); await sleep(500)) w.poll();
  ok("PTY: re-writing the entry during the wait means a late-reading claude never sees the dialog", state() === "gate", state());
  ok("PTY: nothing was typed (pty runtime)", state() !== "ready");
}

// POLICY: a folder outside PAW_ROOT is not paw's to trust — nothing is sent, and the cause says so
{
  process.env.PAW_ROOT = join(root, "elsewhere");
  mkdirSync(process.env.PAW_ROOT, { recursive: true });
  const folder = realpathSync(mkdtempSync(join(root, "policy-")));
  writeFileSync(join(process.env.HOME!, ".claude.json"), JSON.stringify({ projects: {} }));
  const out = join(root, "policy.state");
  const logs: string[] = [];
  const w = startupWatch(space, "policy", folder, { runtime: "tmux", tmuxEnv, log: (l) => logs.push(l) });
  tmux("new-window", "-d", "-t", `cotal-${space}`, "-n", "policy", "-c", folder, `FAKE_OUT='${out}' HOME='${process.env.HOME}' '${process.execPath}' '${fake}'; sleep 30`);
  for (let t0 = Date.now(); Date.now() - t0 < 4000; await sleep(500)) w.poll();
  const st = existsSync(out) ? readFileSync(out, "utf8") : "";
  ok("POLICY: an untrusted-by-policy folder's dialog gets NO keypress (claude stays at it)", st === "trust", st);
  ok("POLICY: and paw did not write a trust entry for it", !isFolderTrusted(folder));
  ok("POLICY: the log says it was left for a human", logs.some((l) => /does NOT pre-trust/.test(l)), logs.join(" | "));
  ok("POLICY: cause() names it for the timeout error", /does not pre-trust/.test(w.cause()), w.cause());
  delete process.env.PAW_ROOT;
}

// OTHER: an unrecognised prompt gets nothing, and is logged with what it showed
{
  const folder = realpathSync(mkdtempSync(join(root, "other-")));
  const out = join(root, "other.state");
  const logs: string[] = [];
  const w = startupWatch(space, "other", folder, { runtime: "tmux", tmuxEnv, log: (l) => logs.push(l) });
  tmux("new-window", "-d", "-t", `cotal-${space}`, "-n", "other", "-c", folder, `FAKE_OUT='${out}' FAKE_MODE=other HOME='${process.env.HOME}' '${process.execPath}' '${fake}'; sleep 30`);
  for (let t0 = Date.now(); Date.now() - t0 < 3000; await sleep(500)) w.poll();
  const pane = tmux("capture-pane", "-p", "-t", `cotal-${space}:other`).stdout;
  ok("OTHER: an unrecognised prompt gets no keypress", /Telemetry opt-in/.test(pane) && readFileSync(out, "utf8") === "other");
  ok("OTHER: logged with what was on screen", logs.some((l) => /unrecognised prompt.*Telemetry opt-in/.test(l)), logs.join(" | "));
  ok("OTHER: cause() quotes it", /unrecognised prompt/.test(w.cause()), w.cause());
}

tmux("kill-server");
console.log(fails ? `\n${fails} FAILED` : "\nall trust checks passed");
process.exit(fails ? 1 : 0);
