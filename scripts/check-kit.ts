/**
 * Hermetic checks for kit agents (docs/notes/kit.md): no broker, no manager, no kit binary run.
 *
 *  - kitLaunch: `kit run` argv + env from the manager's LaunchOpts and the persona — the assigned
 *    identity (actor + lifecycle uid), `--session-id` before the transcript exists and `--resume`
 *    after, model/variant precedence, channels, a minimal env with the paw stamps; refusals for what
 *    kit can't carry (auth creds, no assigned identity, a prompt, shared MCP servers, no pin);
 *  - readKitPersona: provider required + validated, model/variant/body/pin read from the persona;
 *  - kitBrief: names the human peer and kit's own tools, carries the shared sections, and none of
 *    claude's (cotal_inbox, Monitor);
 *  - the connector wiring: name, no event plane, fresh starts; the buildLaunch writes the brief file;
 *  - paw log reads kit transcripts: writesClaudeTranscript("kit"), and a kit turn of cotal envelopes
 *    renders as wake + the message itself.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pawkit-"));
process.env.PAW_HOME = home;
process.env.PAW_BEADS_DIR = join(home, "beads");
process.env.HOME = join(home, "h"); // claude's store (~/.claude/projects) — the session-storage section plants transcripts here
process.env.KIT_HOME = join(home, "k"); // kit's own store (<KIT_HOME>/sessions)

const { kitLaunch, readKitPersona, kitBrief, kitConnector, kitBinPath, KIT_AGENT } = await import("../src/kit.ts");
const { isClaudeHarness, writesClaudeTranscript, transcriptRoots, personaTranscriptRoots, readKitStorage, transcriptPath, transcriptPaths, claudeProjectsRoot, kitSessionsRoot } = await import("../src/session.ts");
const { agentTranscriptFile, chooseTranscriptId } = await import("../src/log.ts");
const { liveTurn } = await import("../src/status.ts");
const { turnState } = await import("../src/transcript.ts");
const { applyAgentType, checkAgentSpec, folderToName, personaFilePath, registerInstance } = await import("../src/addressing.ts");
const { readResumeId, readAgentType, personaValue, readShareTools } = await import("../src/session.ts");
const { kitViewSession } = await import("../src/open.ts");
const { claudeProjectDir } = await import("../src/adopt.ts");
const { parseArgs: parseChatArgs } = await import("../src/chat.ts");
const { TranscriptParser } = await import("../src/transcript.ts");
const { HUMAN_PEER } = await import("../src/names.ts");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const throws = (f: () => unknown, re: RegExp) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};
const flag = (args: string[], f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const PIN = "0b6e2f4c-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const persona = (front: string, body = "You review evals.") => {
  const f = join(home, `p-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, `---\nname: evals-reviewer\n${front}\n---\n${body}\n`);
  return f;
};

// ── readKitPersona ────────────────────────────────────────────────────────────────────────────
const full = persona(`agent: kit\nprovider: codex\nmodel: gpt-6.1-sol\nvariant: high\nresume: ${PIN}\ncwd: /w`);
const p = readKitPersona(full);
ok("persona: provider, model, variant, pin, body", p.provider === "codex" && p.model === "gpt-6.1-sol" && p.variant === "high" && p.pin === PIN && p.body === "You review evals.", JSON.stringify(p));
ok("persona without provider throws", throws(() => readKitPersona(persona(`agent: kit\nresume: ${PIN}`)), /no `provider:`/));
ok("persona with an unknown provider throws", throws(() => readKitPersona(persona(`agent: kit\nprovider: claude\nresume: ${PIN}`)), /kit drives codex or grok/));
ok("grok and fake:codex are accepted", readKitPersona(persona(`provider: grok\nresume: ${PIN}`)).provider === "grok" && readKitPersona(persona(`provider: fake:codex\nresume: ${PIN}`)).provider === "fake:codex");
ok("no persona file throws", throws(() => readKitPersona(undefined), /needs its persona file/));

// ── kitLaunch ─────────────────────────────────────────────────────────────────────────────────
const opts = { space: "kit-test-1", name: "evals-reviewer", id: "ACTORX", lifecycleUid: "uid123", servers: "nats://127.0.0.1:4999", subscribe: ["general", "evals"], configPath: full };
const env = { PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "nope", KIT_HOME: "/k", TERM: "xterm" };
const deps = (exists: boolean) => ({ bin: "/b/kit", brief: "/s/system.md", sessionExists: (id: string) => exists && id === PIN, env });
const first = kitLaunch(opts, p, deps(false));
const a = first.args;
ok("command is the kit binary, verb run", first.command === "/b/kit" && a[0] === "run");
ok("cwd is the runtime's (the manager owns it)", flag(a, "--cwd") === ".");
ok("name/space/server from the launch opts", flag(a, "--name") === "evals-reviewer" && flag(a, "--space") === "kit-test-1" && flag(a, "--server") === "nats://127.0.0.1:4999");
ok("the manager-assigned identity is the mesh identity", flag(a, "--actor") === "ACTORX" && flag(a, "--lifecycle-uid") === "uid123");
ok("provider/model/effort from the persona", flag(a, "--provider") === "codex" && flag(a, "--model") === "gpt-6.1-sol" && flag(a, "--effort") === "high");
ok("channels from the resolved access policy", flag(a, "--channels") === "general,evals");
ok("brief file passed", flag(a, "--append-system-prompt-file") === "/s/system.md");
ok("first boot CREATES the pinned session (--session-id)", flag(a, "--session-id") === PIN && !a.includes("--resume"));
const again = kitLaunch(opts, p, deps(true)).args;
ok("later boots RESUME it (--resume)", flag(again, "--resume") === PIN && !again.includes("--session-id"));
ok("no MCP config, no claude flags", !a.some((x) => /mcp|--plugin-dir|--permission-mode|dangerously/.test(x)));
const e = first.env!;
ok("env: OS allow-list only (no manager secrets)", e.PATH === "/bin" && e.HOME === "/h" && e.KIT_HOME === "/k" && !("AWS_SECRET_ACCESS_KEY" in e));
ok("env: COTAL_NAME/SPACE stamps + BEADS", e.COTAL_NAME === "evals-reviewer" && e.COTAL_SPACE === "kit-test-1" && e.BEADS_ACTOR === "evals-reviewer" && e.BEADS_DIR === join(home, "beads"));
ok("env: operator envAllow forwarded", kitLaunch({ ...opts, envAllow: ["AWS_SECRET_ACCESS_KEY"] }, p, deps(false)).env!.AWS_SECRET_ACCESS_KEY === "nope");
ok("explicit --model / variant beat the persona", (() => {
  const x = kitLaunch({ ...opts, model: "gpt-x", variant: "low" }, p, deps(false)).args;
  return flag(x, "--model") === "gpt-x" && flag(x, "--effort") === "low";
})());
const bare = readKitPersona(persona(`provider: grok\nresume: ${PIN}`));
ok("no model/variant ⇒ no flag (kit's default)", (() => {
  const x = kitLaunch(opts, bare, deps(false)).args;
  return !x.includes("--model") && !x.includes("--effort");
})());
ok("no channels ⇒ an empty --channels (joins none)", flag(kitLaunch({ ...opts, subscribe: undefined }, p, deps(false)).args, "--channels") === "");
ok("refuses auth creds", throws(() => kitLaunch({ ...opts, creds: "/c" }, p, deps(false)), /open-mode/));
ok("refuses a launch without an assigned identity", throws(() => kitLaunch({ ...opts, id: undefined }, p, deps(false)), /manager-assigned identity/));
ok("refuses an initial prompt", throws(() => kitLaunch({ ...opts, prompt: "hi" }, p, deps(false)), /no initial prompt/));
ok("refuses shared MCP servers", throws(() => kitLaunch({ ...opts, mcpServers: { x: { command: "y" } } }, p, deps(false)), /no MCP client/));
ok("empty mcpServers is fine", kitLaunch({ ...opts, mcpServers: {} }, p, deps(false)).command === "/b/kit");
ok("refuses a cotal fork/continue handle", throws(() => kitLaunch({ ...opts, resume: "x" }, p, deps(false)), /cotal session handles/));
ok("refuses a pinless persona", throws(() => kitLaunch(opts, { ...p, pin: undefined }, deps(false)), /no `resume:` pin/));

// ── brief ─────────────────────────────────────────────────────────────────────────────────────
const b = kitBrief("evals-reviewer");
ok("brief names the agent, the human peer and kit's tools", b.includes('"evals-reviewer"') && b.includes(`cotal_dm("${HUMAN_PEER}"`) && b.includes("cotal_send") && b.includes("cotal_roster"));
ok("brief carries the shared sections (channels, wake, tasks)", b.includes("CHANNELS ARE DIFFERENT") && b.includes('cotal_dm("global", "wake <name>")') && b.includes("bd create"));
ok("brief has none of claude's tools", !/cotal_inbox|cotal_anycast|Monitor tool|run_in_background|cotal_join/.test(b));

// ── connector ─────────────────────────────────────────────────────────────────────────────────
ok("connector: name kit, kind connector", kitConnector.name === "kit" && KIT_AGENT === "kit" && kitConnector.kind === "connector");
ok("connector: no event plane (paw spawns it events:false)", kitConnector.eventChannel === undefined);
ok("connector: fresh starts + variants declared, no prompt", kitConnector.supportsFreshStart === true && kitConnector.supportsModelVariant === true && !kitConnector.supportsPrompt);
ok("kitBinPath: KIT_BIN wins, else $PAW_HOME/bin/kit", kitBinPath({ KIT_BIN: "/x/kit" }) === "/x/kit" && kitBinPath({ PAW_HOME: "/ph" }) === "/ph/bin/kit");
ok("buildLaunch fails loud without a binary", throws(() => kitConnector.buildLaunch({ ...opts, configPath: full }), /no kit binary/));
mkdirSync(join(home, "bin"), { recursive: true });
writeFileSync(join(home, "bin", "kit"), "");
delete process.env.KIT_BIN;
const built = kitConnector.buildLaunch({ ...opts, configPath: full });
const briefFile = flag(built.args, "--append-system-prompt-file")!;
ok("buildLaunch writes persona body + brief to the agent's dir", briefFile === join(home, "spaces", "kit-test-1", "kit", "evals-reviewer", "system.md") && existsSync(briefFile) && readFileSync(briefFile, "utf8").startsWith("You review evals.\n\nYou are \"evals-reviewer\""));

// ── paw log ───────────────────────────────────────────────────────────────────────────────────
ok("kit writes a claude transcript, but is not the claude harness", writesClaudeTranscript("kit") && !isClaudeHarness("kit") && writesClaudeTranscript(undefined) && !writesClaudeTranscript("codex"));
const parser = new TranscriptParser();
const turn = JSON.stringify({
  type: "user",
  message: { role: "user", content: '<channel source="cotal" kind="dm" from="you" from_id="local.a" msg_id="m1">\nremember PELICAN\n</channel>\n\n<channel source="cotal" kind="channel" channel="general" from="bob" from_id="local.b" msg_id="m2">\nhi\n</channel>' },
});
const blocks = parser.feed(turn);
ok(
  "a kit turn renders wake + the message, per envelope",
  JSON.stringify(blocks) === JSON.stringify([{ kind: "wake", from: "you", via: "dm" }, { kind: "incoming", text: "remember PELICAN" }, { kind: "wake", from: "bob", via: "#general" }, { kind: "incoming", text: "hi" }]),
  JSON.stringify(blocks),
);
const claudeWake = parser.feed(JSON.stringify({ type: "user", message: { role: "user", content: '<channel source="cotal" kind="dm" from="you">📨 new mail</channel>' } }));
ok("claude's own wake (no msg_id) is unchanged", JSON.stringify(claudeWake) === JSON.stringify([{ kind: "wake", from: "you", via: "dm" }]), JSON.stringify(claudeWake));

// ── session storage (kit branch feat/session-storage-modes; docs/paw-session-storage.md there) ──
const claudeRoot = claudeProjectsRoot();
const kitRoot = kitSessionsRoot();
ok("stores: claude under HOME, kit under KIT_HOME", claudeRoot === join(home, "h", ".claude", "projects") && kitRoot === join(home, "k", "sessions"));
ok("roots: kit agent (default store) = kit's, then claude's", JSON.stringify(transcriptRoots("kit")) === JSON.stringify([kitRoot, claudeRoot]));
ok("roots: kit agent with storage: claude = claude's alone", JSON.stringify(transcriptRoots("kit", "claude")) === JSON.stringify([claudeRoot]));
ok("roots: claude/codex agents never look in kit's store", [undefined, "claude", "codex"].every((t) => JSON.stringify(transcriptRoots(t)) === JSON.stringify([claudeRoot])));
const kitDefault = persona(`agent: kit\nprovider: codex\nresume: ${PIN}\ncwd: /w`);
const kitOnClaude = persona(`agent: kit\nprovider: codex\nstorage: claude\nresume: ${PIN}\ncwd: /w`);
const claudeP = persona(`resume: ${PIN}\ncwd: /w`);
ok("persona roots follow agent: + storage:", personaTranscriptRoots(kitDefault)[0] === kitRoot && personaTranscriptRoots(kitOnClaude).length === 1 && personaTranscriptRoots(claudeP).length === 1);
ok("storage: kit is the explicit default", readKitStorage(persona(`agent: kit\nstorage: kit`)) === "kit" && readKitStorage(kitDefault) === "kit");
ok("storage: a typo throws (never silently forks)", throws(() => readKitStorage(persona(`agent: kit\nstorage: claud`)), /expected kit .* or claude/));
ok("readKitPersona carries storage", readKitPersona(kitOnClaude).storage === "claude" && readKitPersona(kitDefault).storage === "kit");
ok("storage: claude ⇒ kit run --overwrite", kitLaunch(opts, readKitPersona(kitOnClaude), deps(false)).args.includes("--overwrite") && !kitLaunch(opts, readKitPersona(kitDefault), deps(false)).args.includes("--overwrite"));

// Plant: the claude original at /w's slug, and (later) kit's fork of the same id.
const slug = "-w";
const plant = (root: string, id: string, text: string) => {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, `${id}.jsonl`), text);
  return join(root, slug, `${id}.jsonl`);
};
const KITONLY = "11111111-2222-4333-8444-555555555555";
const BOTH = PIN;
const CLAUDEONLY = "99999999-8888-4777-8666-555555555555";
const kitOnlyFile = plant(kitRoot, KITONLY, "kit-only\n");
const claudeOrig = plant(claudeRoot, BOTH, "claude original\n");
const claudeOnlyFile = plant(claudeRoot, CLAUDEONLY, "claude only\n");
// buildLaunch: a kit-only transcript must RESUME (kit refuses --session-id for an id it can find).
const launchFor = (pin: string, storage = "") => {
  const f = persona(`agent: kit\nprovider: codex\n${storage}resume: ${pin}\ncwd: /w`);
  return kitConnector.buildLaunch({ ...opts, configPath: f }).args;
};
ok("kit-only pin ⇒ --resume (default store)", flag(launchFor(KITONLY), "--resume") === KITONLY);
ok("claude-only pin ⇒ --resume (kit forks it on resume)", flag(launchFor(CLAUDEONLY), "--resume") === CLAUDEONLY);
ok("fresh pin ⇒ --session-id", flag(launchFor("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), "--session-id") === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
ok("storage: claude ignores a kit-only fork ⇒ --session-id --overwrite", (() => {
  const x = launchFor(KITONLY, "storage: claude\n");
  return flag(x, "--session-id") === KITONLY && x.includes("--overwrite");
})());
ok("storage: claude + claude pin ⇒ --resume --overwrite", (() => {
  const x = launchFor(CLAUDEONLY, "storage: claude\n");
  return flag(x, "--resume") === CLAUDEONLY && x.includes("--overwrite");
})());
// Lookups before kit forked BOTH: everyone sees the claude original.
ok("before the fork: kit lookup finds the claude original", transcriptPath(BOTH, transcriptRoots("kit")) === claudeOrig);
const kitFork = plant(kitRoot, BOTH, "kit continuation\n");
ok("after the fork: kit lookup prefers kit's continuation", transcriptPath(BOTH, transcriptRoots("kit")) === kitFork);
ok("after the fork: claude lookup still sees the original", transcriptPath(BOTH) === claudeOrig && transcriptPath(BOTH, transcriptRoots("kit", "claude")) === claudeOrig);
const many = [BOTH, KITONLY, CLAUDEONLY, "x1", "x2"];
ok("transcriptPaths (batched) = transcriptPath per id, per store", (() => {
  const k = transcriptPaths(many, transcriptRoots("kit"));
  const c = transcriptPaths(many);
  return k.get(BOTH) === kitFork && k.get(KITONLY) === kitOnlyFile && k.get(CLAUDEONLY) === claudeOnlyFile && !k.has("x1") && c.get(BOTH) === claudeOrig && !c.has(KITONLY) && c.get(CLAUDEONLY) === claudeOnlyFile;
})());
// paw log / web trace: the cwd-local claude file must not shadow kit's continuation.
const localDir = join(claudeRoot, slug);
ok("log: kit agent shows kit's continuation, not the cwd-local claude original", agentTranscriptFile(localDir, BOTH, transcriptRoots("kit")) === kitFork);
ok("log: claude agent shows the original", agentTranscriptFile(localDir, BOTH) === claudeOrig && agentTranscriptFile(localDir, BOTH, transcriptRoots("kit", "claude")) === claudeOrig);
ok("log: a kit-only pin is not 'missing' for a kit agent", chooseTranscriptId("k", localDir, KITONLY, "kit", transcriptRoots("kit")) === KITONLY);
ok("log: a kit-only pin IS missing for a claude-store agent (fail loud)", throws(() => chooseTranscriptId("k", localDir, KITONLY, "kit", transcriptRoots("kit", "claude")), /no transcript yet/));
// paw attach (kit's view): paw hands it the store-aware path.
ok("attach: kit view gets --session <kit continuation>", JSON.stringify(kitViewSession(kitDefault)) === JSON.stringify(["--session", kitFork]));
ok("attach: storage: claude view gets the claude original", JSON.stringify(kitViewSession(kitOnClaude)) === JSON.stringify(["--session", claudeOrig]));
const unbornClaude = persona(`agent: kit\nprovider: codex\nstorage: claude\nresume: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\ncwd: /w`);
ok("attach: storage: claude, no transcript yet ⇒ watch claude's path", flag(kitViewSession(unbornClaude), "--session") === join(claudeProjectDir("/w"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"));
ok("attach: kit store, no transcript yet ⇒ kit's own default", kitViewSession(persona(`agent: kit\nprovider: codex\nresume: cccccccc-cccc-4ccc-8ccc-cccccccccccc\ncwd: /w`)).length === 0);

// ── busy: a kit agent is judged by its presence ───────────────────────────────────────────────
// A kit turn ends right after its reply cotal_dm: last record = the tool_result, no turn_duration.
const kitTail = [
  JSON.stringify({ type: "user", timestamp: "2026-10-06T00:00:00Z", message: { role: "user", content: "hi" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-10-06T00:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "cotal_dm", input: { to: "you", text: "hello" } }] } }),
  JSON.stringify({ type: "user", timestamp: "2026-10-06T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sent" }] } }),
].join("\n");
const kitRead = { mtimeMs: Date.now(), turn: () => turnState(kitTail) };
ok("the kit tail reads as in flight to the transcript inference (the bug's cause)", turnState(kitTail).inFlight === true, JSON.stringify(turnState(kitTail)));
ok("kit + presence idle ⇒ NOT busy", liveTurn(kitRead, "idle", "kit").busy === false);
ok("kit + presence working ⇒ busy", liveTurn(kitRead, "working", "kit").busy === true);
ok("kit + idle, fresh mtime, no markers ⇒ still not busy (no mtime heuristic)", liveTurn({ mtimeMs: Date.now(), turn: () => ({ inFlight: undefined }) }, "idle", "kit").busy === false);
ok("claude keeps the transcript inference (same tail ⇒ busy)", liveTurn(kitRead, "idle", undefined).busy === true);

// ── paw chat --agent ──────────────────────────────────────────────────────────────────────────
const SPACE = "kit-test-chat";
const folder = mkdtempSync(join(tmpdir(), "pawkit-folder-"));
ok("checkAgentSpec: kit defaults to codex", JSON.stringify(checkAgentSpec({ agent: "kit" })) === JSON.stringify({ agent: "kit", provider: "codex" }));
ok("checkAgentSpec: unknown harness throws", throws(() => checkAgentSpec({ agent: "gpt" }), /unknown harness/));
ok("checkAgentSpec: --provider on codex throws", throws(() => checkAgentSpec({ agent: "codex", provider: "grok" }), /kit's/));
ok("checkAgentSpec: bad kit provider throws", throws(() => checkAgentSpec({ agent: "kit", provider: "claude" }), /codex or grok/));
const kname = folderToName(SPACE, folder);
const kfile = applyAgentType(SPACE, kname, { agent: "kit", provider: "grok", model: "grok-5" });
ok(
  "birth: agent kit, provider, model, shareTools none, fresh pin, cwd, body",
  readAgentType(kfile) === "kit" && personaValue(kfile, "provider") === "grok" && personaValue(kfile, "model") === "grok-5" && readShareTools(kfile) === "none" &&
    /^[0-9a-f-]{36}$/.test(readResumeId(kfile) ?? "") && personaValue(kfile, "cwd") === folder && /You are the paw agent/.test(readFileSync(kfile, "utf8")),
  readFileSync(kfile, "utf8"),
);
ok("born kit persona loads as a kit persona", readKitPersona(kfile).provider === "grok" && readKitPersona(kfile).storage === "kit");
const pinBefore = readResumeId(kfile);
ok("again with the same harness ⇒ targets it (pin unchanged)", applyAgentType(SPACE, kname, { agent: "kit" }) === kfile && readResumeId(kfile) === pinBefore);
ok("a different harness on an existing agent fails loud", throws(() => applyAgentType(SPACE, kname, { agent: "codex" }), /runs on kit, not codex/));
ok("a different kit provider fails loud", throws(() => applyAgentType(SPACE, kname, { agent: "kit", provider: "codex" }), /provider grok, not codex/));
const cname = registerInstance(SPACE, folder, "cx");
const cfile = applyAgentType(SPACE, cname, { agent: "codex", model: "gpt-6" });
ok("--agent codex births agent: codex (no provider, no shareTools)", readAgentType(cfile) === "codex" && personaValue(cfile, "provider") === undefined && readShareTools(cfile) === undefined && personaValue(cfile, "model") === "gpt-6");
const clname = registerInstance(SPACE, folder, "cl");
const clfile = applyAgentType(SPACE, clname, { agent: "claude", model: "opus" });
ok("--agent claude births paw's default (no agent:, model stays a spawn flag)", readAgentType(clfile) === undefined && personaValue(clfile, "model") === undefined && !!readResumeId(clfile));
ok("an existing claude agent refuses --agent kit", throws(() => applyAgentType(SPACE, clname, { agent: "kit" }), /runs on claude, not kit/));
ok("personaFilePath is where it was born", personaFilePath(SPACE, kname) === kfile);
const parsed = parseChatArgs([".", "--agent", "kit", "--provider", "grok", "--model", "m", "--name", "n"]);
ok("chat parses --agent/--provider/--model/--name", parsed.agent === "kit" && parsed.provider === "grok" && parsed.model === "m" && parsed.name === "n" && parsed.target === ".");
ok("chat: --agent without a value throws", throws(() => parseChatArgs([".", "--agent"]), /needs a value/));

if (fails) {
  console.error(`\n${fails} kit check(s) failed`);
  process.exit(1);
}
console.log("\nall kit checks passed 🐾");
