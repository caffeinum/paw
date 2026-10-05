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

const { kitLaunch, readKitPersona, kitBrief, kitConnector, kitBinPath, KIT_AGENT } = await import("../src/kit.ts");
const { isClaudeHarness, writesClaudeTranscript } = await import("../src/session.ts");
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

if (fails) {
  console.error(`\n${fails} kit check(s) failed`);
  process.exit(1);
}
console.log("\nall kit checks passed 🐾");
