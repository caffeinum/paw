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
ok("brief explains actual image attachments and local image viewing", b.includes("kit attaches its image bytes") && b.includes("view_image") && !b.includes("attachment you cannot view"));
ok("brief does not claim failed attachments were seen", b.includes("If kit reports an attachment error, you have not seen that image"));

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

// ── kitArgs: kit's own flags, verbatim ────────────────────────────────────────────────────────
{
  const { checkKitArgs, preflightKitArgs } = await import("../src/kit.ts");
  const { readKitArgs } = await import("../src/session.ts");
  const ka = persona(`agent: kit\nresume: ${PIN}\nkitArgs: ["-m","grok-4.7","-e","high"]`);
  ok("readKitArgs: the JSON array", JSON.stringify(readKitArgs(ka)) === '["-m","grok-4.7","-e","high"]');
  ok("readKitArgs: malformed JSON throws", throws(() => readKitArgs(persona(`kitArgs: -m grok`)), /not valid JSON/));
  ok("readKitArgs: a non-string element throws", throws(() => readKitArgs(persona(`kitArgs: ["-m",4]`)), /array of strings/));
  const kp = readKitPersona(ka);
  ok("a -m in kitArgs stands in for provider:", kp.provider === undefined && kp.kitArgs.length === 4);
  ok("-P in kitArgs stands in for provider: too", readKitPersona(persona(`resume: ${PIN}\nkitArgs: ["-P","grok"]`)).provider === undefined);
  ok("no provider: and no -m/-P throws", throws(() => readKitPersona(persona(`resume: ${PIN}\nkitArgs: ["-e","high"]`)), /no `provider:` and no -m\/-P/));
  const la = kitLaunch(opts, kp, deps(true)).args;
  ok("kitLaunch: no --provider without provider:, kitArgs appended LAST, verbatim", !la.includes("--provider") && la.slice(-6).join(" ") === `--resume ${PIN} -m grok-4.7 -e high`, la.join(" "));
  const both = kitLaunch(opts, { ...p, kitArgs: ["-e", "low"] }, deps(true)).args;
  ok("kitLaunch: kitArgs come after the persona's flags (Go keeps the last)", both.indexOf("--effort") < both.lastIndexOf("-e"));
  ok("checkKitArgs: names model/provider/effort in every Go form", JSON.stringify(checkKitArgs(["--model=x", "-P", "grok", "--e", "high"], "t")) === '{"model":true,"provider":true,"effort":true}');
  ok("checkKitArgs: a value is never read as a flag", JSON.stringify(checkKitArgs(["--compact-keep", "-1"], "t")) === '{"model":false,"provider":false,"effort":false}');
  for (const f of ["--resume", "-session-id", "--overwrite", "--name=x", "--actor", "--cwd", "--channels", "--append-system-prompt-file", "--server", "--space", "--session", "--lifecycle-uid"])
    ok(`checkKitArgs: paw-owned ${f} refused`, throws(() => checkKitArgs([f, "v"], "t"), /paw's to set/));
  const stub = (name: string, body: string) => {
    const f = join(home, name);
    writeFileSync(f, `#!/bin/sh\necho "$*" > ${f}.argv\n${body}\n`, { mode: 0o755 });
    return f;
  };
  const yes = stub("kit-yes", "exit 0");
  preflightKitArgs(yes, ["-m", "grok-4.7"], "t");
  ok("preflight asks `kit run <args> -h`", readFileSync(`${yes}.argv`, "utf8").trim() === "run -m grok-4.7 -h");
  ok("preflight: kit's own parse error is the message", throws(() => preflightKitArgs(stub("kit-unk", "echo 'kit: unknown flag -x' >&2; exit 2"), ["-x", "1"], "t"), /does not accept.*kit: unknown flag -x/));
  ok("preflight: an unread -h (bare word / --) is named", throws(() => preflightKitArgs(stub("kit-pos", "echo 'kit: --cwd required' >&2; exit 1"), ["high"], "t"), /stopped reading flags/));
  ok("preflight: no kitArgs ⇒ nothing run", (() => {
    preflightKitArgs("/nonexistent/kit", [], "t");
    return true;
  })());
  const addr = readFileSync(join(import.meta.dirname, "..", "src", "addressing.ts"), "utf8");
  const kitBlock = addr.slice(addr.indexOf("if (kit) {"), addr.indexOf("// Hermes publishes no AG-UI"));
  ok("spawn: a kit agent always selects NO shared MCP servers (no silent post-accept refusal)", /args\.shareTools = \[\];/.test(kitBlock));
  ok("spawn: the kit persona + kitArgs are checked CLI-side, before the manager", kitBlock.includes("readKitPersona(config)") && kitBlock.includes("preflightKitArgs("));
}

// ── planSwap: `paw restart <agent> --agent kit|claude` ────────────────────────────────────────
{
  const { planSwap } = await import("../src/swap.ts");
  const claudeP = { file: "/p/evals.md", pin: PIN, kitArgs: [], claudeArgs: [], claudeTranscript: "/h/.claude/projects/x/p.jsonl" };
  const s1 = planSwap("evals", claudeP, { agent: "kit", kitArgs: ["-m", "grok-4.7"] });
  ok(
    "claude → kit: agent kit, kitArgs verbatim, storage claude; undo names --agent claude",
    s1.summary === 'persona evals: agent: kit, kitArgs: ["-m","grok-4.7"], storage: claude' && s1.undo === "paw restart evals --agent claude" && s1.set.agent === "kit" && s1.set.storage === "claude",
    s1.summary,
  );
  ok("claude → kit: says the transcript it keeps appending to", s1.notes.some((n) => n.includes("storage: claude set") && n.includes(claudeP.claudeTranscript)));
  ok("claude → kit with no transcript yet says so", planSwap("evals", { ...claudeP, claudeTranscript: undefined }, { agent: "kit", kitArgs: ["-P", "grok"] }).notes.some((n) => /no transcript at resume/.test(n)));
  ok("claude → kit: --model is kitArgs' head", planSwap("evals", claudeP, { agent: "kit", model: "grok-4.7" }).set.kitArgs === '["--model","grok-4.7"]');
  ok("claude → kit: --model + kit flags", planSwap("evals", claudeP, { agent: "kit", model: "grok-4.7", kitArgs: ["-e", "high"] }).set.kitArgs === '["--model","grok-4.7","-e","high"]');
  ok("claude → kit: no pin fails loud", throws(() => planSwap("evals", { ...claudeP, pin: undefined }, { agent: "kit", kitArgs: ["-m", "x"] }), /no `resume:` pin/));
  ok("claude → kit: no model/provider fails loud", throws(() => planSwap("evals", claudeP, { agent: "kit" }), /kit needs a model or provider/));
  ok("claude → kit: a claude model: line fails loud", throws(() => planSwap("evals", { ...claudeP, model: "opus" }, { agent: "kit", kitArgs: ["-m", "x"] }), /pins model: opus/));
  ok("--model twice fails loud", throws(() => planSwap("evals", claudeP, { agent: "kit", model: "a", kitArgs: ["-m", "b"] }), /say it once/));
  ok("a paw-owned kit flag fails loud", throws(() => planSwap("evals", claudeP, { agent: "kit", kitArgs: ["-m", "x", "--overwrite"] }), /storage: claude/));
  ok("unknown / other harnesses fail loud", throws(() => planSwap("evals", claudeP, { agent: "codex" }), /between claude and kit/) && throws(() => planSwap("evals", { ...claudeP, agent: "hermes" }, { agent: "kit" }), /runs on hermes/));
  ok("`--` with --agent claude fails loud", throws(() => planSwap("evals", claudeP, { agent: "claude", kitArgs: [] }), /is not kit/));
  const kitP = { file: "/p/tp.md", agent: "kit", pin: PIN, provider: "grok", model: "grok-4.7", variant: "high", storage: "claude", kitArgs: [], claudeArgs: [] };
  const s2 = planSwap("tp", kitP, { agent: "kit", kitArgs: ["-m", "grok-4.8"] });
  ok(
    "kit → kit: the new -m drops model:/provider: (one record says it), variant stays; undo restores them",
    s2.summary === 'persona tp: kitArgs: ["-m","grok-4.8"], removed model: grok-4.7, provider: grok' && s2.set.variant === undefined && !("variant" in s2.set) && s2.undo === "paw restart tp --agent kit --, and put back provider: grok, model: grok-4.7, variant: high in /p/tp.md",
    `${s2.summary} | ${s2.undo}`,
  );
  ok("kit → kit: -e drops variant:", "variant" in planSwap("tp", kitP, { agent: "kit", kitArgs: ["-e", "low"] }).set);
  ok("kit → kit with nothing given changes nothing", Object.keys(planSwap("tp", kitP, { agent: "kit" }).set).length === 0);
  const s3 = planSwap("tp", { ...kitP, kitArgs: ["-e", "low"], storage: undefined, kitTranscript: "/k/s/p.jsonl" }, { agent: "claude" });
  ok(
    "kit → claude: removes agent/kitArgs/provider/model/variant, keeps the pin",
    ["agent", "kitArgs", "provider", "model", "variant"].every((k) => k in s3.set && s3.set[k] === undefined) && !("resume" in s3.set) && s3.notes.some((n) => n.includes(`resume: ${PIN} kept`)),
    s3.summary,
  );
  ok("kit → claude from kit's own store warns its kit turns stay behind", s3.notes.some((n) => n.includes("/k/s/p.jsonl") && /without them/.test(n)));
  ok("kit → claude: undo names the old kit flags + keys", s3.undo === "paw restart tp --agent kit -- -e low, and put back provider: grok, model: grok-4.7, variant: high in /p/tp.md", s3.undo);
  ok("kit → claude: removes storage: claude too", "storage" in planSwap("tp", kitP, { agent: "claude" }).set);
  ok("claude → claude: nothing to change", Object.keys(planSwap("evals", claudeP, { agent: "claude" }).set).length === 0);
  ok("claude --model is persisted in claudeArgs, replacing a previous --model", planSwap("evals", { ...claudeP, claudeArgs: ["--model", "sonnet", "--add-dir", "/x"] }, { agent: "claude", model: "opus" }).set.claudeArgs === '["--add-dir","/x","--model","opus"]');
  ok("an unchanged swap says unchanged (the restart still runs)", /already kit with these flags, unchanged$/.test(planSwap("tp", kitP, { agent: "kit" }).summary));
}

// ── manager features: the RUNNING manager's code decides what a kit persona may say ─────────────
{
  const { codeRootFromCommand, codeRootFeatures, assertManagerFeature, describeCodeRoot, KIT_ARGS_FEATURE, MANAGER_FEATURES_FILE } = await import("../src/manager-features.ts");
  const { releasesDir, REPO_ROOT } = await import("../src/release.ts");
  const rel = join(releasesDir(), "7b8139964144");
  ok(
    "the manager's code root comes from its command line",
    codeRootFromCommand(`/n/node ${rel}/bin/cotald.ts supervise --space paw --server nats://127.0.0.1:4222 --runtime tmux`) === rel,
  );
  ok("…a command with no cotald.ts names no root", codeRootFromCommand("node something-else.ts supervise") === undefined);
  ok("this checkout supports kit-args", codeRootFeatures(REPO_ROOT).includes(KIT_ARGS_FEATURE));
  mkdirSync(join(rel, "src"), { recursive: true });
  ok("a root with no features file (a release older than the contract) supports nothing", codeRootFeatures(rel).length === 0);
  ok("a release root is described by its id", describeCodeRoot(rel) === "release 7b8139964144", describeCodeRoot(rel));
  let msg = "";
  try {
    assertManagerFeature("paw", KIT_ARGS_FEATURE, "restart ccswitch --agent kit", { running: () => rel });
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(
    "an old running manager refuses kit-args up front, naming its release and the fix",
    msg.includes("release 7b8139964144") && msg.includes("predates it") && msg.includes("nothing was changed") && msg.includes("`paw release`, then `paw restart --space paw`"),
    msg,
  );
  let none = "";
  try {
    assertManagerFeature("paw", KIT_ARGS_FEATURE, "x", { running: () => undefined, next: () => rel });
  } catch (e) {
    none = (e as Error).message;
  }
  ok("with no manager running, the release ensure() would start is the one judged", none.includes("would start runs release 7b8139964144"), none);
  let passed = true;
  try {
    assertManagerFeature("paw", KIT_ARGS_FEATURE, "x", { running: () => REPO_ROOT });
  } catch {
    passed = false;
  }
  ok("a manager on this checkout passes", passed);
  writeFileSync(join(rel, MANAGER_FEATURES_FILE), "{nope");
  let bad = "";
  try {
    codeRootFeatures(rel);
  } catch (e) {
    bad = (e as Error).message;
  }
  ok("a malformed features file fails loud", /not valid JSON/.test(bad), bad);
}

if (fails) {
  console.error(`\n${fails} kit check(s) failed`);
  process.exit(1);
}
console.log("\nall kit checks passed 🐾");
