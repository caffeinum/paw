/**
 * Hermetic checks for hermes agents (src/hermes.ts, docs/notes/agents.md#hermes): no broker, no
 * manager, no Hermes run — cotal's buildLaunch is replaced by a recording stub.
 *
 *  - the profile: paw's own `$PAW_HOME/hermes/profiles/<space>-<name>` (a legal Hermes profile id, a
 *    digest when the name needed changing), or the persona's `hermesHome:`;
 *  - readHermesPersona: provider required; hermesHome must be absolute and excludes model/provider/baseUrl;
 *  - hermesLaunch: config.yaml + SOUL.md written for paw's profile, nothing written for an adopted one;
 *    a login provider with no login refuses with the command to run; the env points cotal's launcher at
 *    the profile (adopt mode), paw's venv, a short TMPDIR; the agent file handed over is frontmatter only;
 *  - checkAgentSpec / applyAgentType: hermes needs --provider, births shareTools none;
 *  - status: liveTurn is presence-only; the SESSION cell names the harness;
 *  - paw log fails loud, naming the profile.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchOpts, LaunchSpec } from "@cotal-ai/core";

const home = mkdtempSync(join(tmpdir(), "pawhermes-"));
process.env.PAW_HOME = home;
process.env.PAW_BEADS_DIR = join(home, "beads");

const { hermesLaunch, readHermesPersona, hermesConfigYaml, hasHermesLogin, pawHermesConnector } = await import("../src/hermes.ts");
const { hermesProfileId, hermesHomeFor, hermesRoot, HERMES_AGENT } = await import("../src/hermes-profile.ts");
const { applyAgentType, checkAgentSpec, setFolderName } = await import("../src/addressing.ts");
const { readAgentType, readShareTools, personaValue } = await import("../src/session.ts");
const { liveTurn, sessionRef } = await import("../src/status.ts");
const { openAgentLog } = await import("../src/log.ts");

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
const persona = (front: string, body = "You watch the deploys.") => {
  const f = join(home, `p-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, `---\nname: herm\n${front}\n---\n${body}\n`);
  return f;
};
const calls: LaunchOpts[] = [];
const stub = (o: LaunchOpts): LaunchSpec => {
  calls.push(o);
  return { command: "/node", args: ["launch.js"], env: { COTAL_NAME: o.name, COTAL_SPACE: o.space, ...(o.configPath ? { COTAL_AGENT_FILE: o.configPath } : {}) } };
};
const opts = (configPath: string, extra: Partial<LaunchOpts> = {}): LaunchOpts => ({ space: "s1", name: "herm", configPath, servers: "nats://127.0.0.1:1", model: "grok-4.7", ...extra });

// ── profile placement ─────────────────────────────────────────────────────────────────────────
ok("profile id: <space>-<name> when legal", hermesProfileId("paw", "hermes") === "paw-hermes");
const odd = hermesProfileId("paw", "Big.Name");
ok("profile id: an illegal name is cleaned + digested", /^paw-big-name-[0-9a-f]{8}$/.test(odd) && odd !== hermesProfileId("paw", "big-name"), odd);
ok("paw's profile lives under $PAW_HOME/hermes/profiles", hermesHomeFor(undefined, "paw", "hermes") === join(home, "hermes", "profiles", "paw-hermes"));
ok("hermesHome: in the persona wins", hermesHomeFor(persona("agent: hermes\nhermesHome: /x/profiles/mesh"), "paw", "hermes") === "/x/profiles/mesh");

// ── readHermesPersona ─────────────────────────────────────────────────────────────────────────
const full = persona("agent: hermes\nprovider: xai-oauth\nmodel: grok-4.7\ncwd: /w");
const p = readHermesPersona(full, "s1", "herm");
ok("persona: owned profile, provider, body, cwd", p.owned && p.provider === "xai-oauth" && p.body === "You watch the deploys." && p.cwd === "/w" && p.home === join(hermesRoot(), "profiles", "s1-herm"), JSON.stringify(p));
ok("persona without provider throws", throws(() => readHermesPersona(persona("agent: hermes\nmodel: m"), "s1", "herm"), /no `provider:`/));
ok("relative hermesHome throws", throws(() => readHermesPersona(persona("agent: hermes\nhermesHome: profiles/mesh"), "s1", "herm"), /absolute/));
ok("hermesHome + provider throws", throws(() => readHermesPersona(persona("agent: hermes\nhermesHome: /h\nprovider: xai-oauth"), "s1", "herm"), /drop provider/));
ok("hermesHome + model throws", throws(() => readHermesPersona(persona("agent: hermes\nhermesHome: /h\nmodel: grok-4.7"), "s1", "herm"), /drop model/));

// ── hermesLaunch: paw's own profile ───────────────────────────────────────────────────────────
ok("login provider with no login refuses, naming the command", throws(() => hermesLaunch(opts(full), p, stub), /needs a login.*auth add xai-oauth/s));
mkdirSync(p.home, { recursive: true });
writeFileSync(join(p.home, "auth.json"), JSON.stringify({ version: 1, credential_pool: { "xai-oauth": [{ id: "x" }] } }));
ok("hasHermesLogin: a pooled credential counts", hasHermesLogin(p.home, "xai-oauth") && !hasHermesLogin(p.home, "nous"));
const spec = hermesLaunch(opts(full), p, stub);
const cfg = readFileSync(join(p.home, "config.yaml"), "utf8");
ok("config.yaml: model + provider, cotal plugin + platform, approvals off, cwd", cfg.includes('default: "grok-4.7"') && cfg.includes('provider: "xai-oauth"') && cfg.includes("enabled: [cotal]") && /cotal:\n\s+enabled: true/.test(cfg) && cfg.includes('mode: "off"') && cfg.includes('cwd: "/w"'), cfg);
ok("config.yaml matches cotal's adopt-mode check (plugin + platform enabled)", /^\s*enabled:.*\bcotal\b/m.test(cfg) && /^\s*cotal:\s*$/m.test(cfg));
const soul = readFileSync(join(p.home, "SOUL.md"), "utf8");
ok("SOUL.md: persona body + brief naming the human peer", soul.startsWith("You watch the deploys.") && soul.includes('"you"') && soul.includes("running on Hermes"));
const env = spec.env ?? {};
ok("env: adopt mode on paw's profile", env.COTAL_HERMES_ADOPT_HOME === p.home);
ok("env: uv venv under paw's hermes root", env.UV_PROJECT_ENVIRONMENT === join(hermesRoot(), "venv"));
ok("env: short per-agent TMPDIR (bridge socket fits 104 bytes)", !!env.TMPDIR && `${env.TMPDIR}/cotal-hermes-bridge-${"x".repeat(32)}.sock`.length <= 104 && existsSync(env.TMPDIR), env.TMPDIR);
ok("env: beads stamps", env.BEADS_ACTOR === "herm" && !!env.BEADS_DIR);
const handed = calls.at(-1)!;
ok("cotal's buildLaunch gets no model (adopt mode ignores it; the profile carries it)", handed.model === undefined);
const agentFile = readFileSync(handed.configPath!, "utf8");
ok("the agent file handed over is frontmatter only (adopt mode refuses a persona body)", agentFile.includes("name: herm") && !agentFile.includes("You watch the deploys."), agentFile);
ok("no model refuses", throws(() => hermesLaunch(opts(full, { model: undefined }), p, stub), /no model/));
ok("a prompt refuses", throws(() => hermesLaunch(opts(full, { prompt: "hi" }), p, stub), /initial prompt/));
const custom = readHermesPersona(persona("agent: hermes\nprovider: custom\nbaseUrl: http://127.0.0.1:9/v1"), "s1", "c1");
hermesLaunch({ ...opts(persona("agent: hermes")), name: "c1", model: "fake" }, custom, stub);
ok("an API/custom provider needs no login; base_url written", readFileSync(join(custom.home, "config.yaml"), "utf8").includes('base_url: "http://127.0.0.1:9/v1"'));
ok("hermesConfigYaml without base_url omits it", !hermesConfigYaml({ model: "m", provider: "nous" }).includes("base_url"));

// ── hermesLaunch: an adopted profile ──────────────────────────────────────────────────────────
const adoptDir = join(home, "op", "profiles", "mesh");
mkdirSync(adoptDir, { recursive: true });
writeFileSync(join(adoptDir, "config.yaml"), "operator: config\n");
writeFileSync(join(adoptDir, "SOUL.md"), "operator soul\n");
const adoptP = readHermesPersona(persona(`agent: hermes\nhermesHome: ${adoptDir}`), "s1", "herm");
const aspec = hermesLaunch(opts(adoptP.home, { model: undefined, configPath: persona(`agent: hermes\nhermesHome: ${adoptDir}`) }), adoptP, stub);
ok("adopted: config.yaml + SOUL.md untouched", readFileSync(join(adoptDir, "config.yaml"), "utf8") === "operator: config\n" && readFileSync(join(adoptDir, "SOUL.md"), "utf8") === "operator soul\n");
ok("adopted: the launcher runs in it", aspec.env?.COTAL_HERMES_ADOPT_HOME === adoptDir);
ok("adopted: a --model override refuses", throws(() => hermesLaunch(opts(persona(`agent: hermes\nhermesHome: ${adoptDir}`)), adoptP, stub), /adopted profile/));

// ── connector wiring ──────────────────────────────────────────────────────────────────────────
ok("connector: named hermes, uv required, fresh starts", pawHermesConnector.name === HERMES_AGENT && pawHermesConnector.requires?.includes("uv") === true && pawHermesConnector.supportsFreshStart === true);
ok("connector: no AG-UI event plane (paw spawns it events:false)", (pawHermesConnector as { eventChannel?: unknown }).eventChannel === undefined);

// ── addressing ────────────────────────────────────────────────────────────────────────────────
ok("checkAgentSpec: hermes needs --provider", throws(() => checkAgentSpec({ agent: "hermes" }), /needs --provider/));
ok("checkAgentSpec: hermes takes any Hermes provider id", JSON.stringify(checkAgentSpec({ agent: "hermes", provider: "xai-oauth" })) === JSON.stringify({ agent: "hermes", provider: "xai-oauth" }));
const folder = mkdtempSync(join(tmpdir(), "pawhermes-folder-"));
setFolderName("s1", folder, "herm2");
const born = applyAgentType("s1", "herm2", { agent: "hermes", provider: "xai-oauth", model: "grok-4.7" });
ok("birth: agent hermes, provider, model, shareTools none", readAgentType(born) === "hermes" && personaValue(born, "provider") === "xai-oauth" && personaValue(born, "model") === "grok-4.7" && readShareTools(born) === "none");
ok("an existing hermes agent on another provider fails loud", throws(() => applyAgentType("s1", "herm2", { agent: "hermes", provider: "nous" }), /hermes agent on provider xai-oauth, not nous/));

// ── status + log ──────────────────────────────────────────────────────────────────────────────
ok("liveTurn: hermes idle presence ⇒ not busy (no transcript to infer from)", liveTurn(undefined, "idle", "hermes").busy === false);
ok("liveTurn: hermes working presence ⇒ busy", liveTurn(undefined, "working", "hermes").busy === true);
ok("SESSION cell names the harness for hermes", sessionRef({ harness: "hermes", pin: "0b6e2f4c-1d2a-4c3b-9e8f-7a6b5c4d3e2f" }) === "(hermes)");
ok("SESSION cell still shows a claude pin", sessionRef({ pin: "0b6e2f4c-1d2a-4c3b-9e8f-7a6b5c4d3e2f" }) === "0b6e2f4c…");
ok("paw log fails loud for hermes, naming the profile", throws(() => openAgentLog("s1", "herm2", folder), new RegExp(`hermes agent .*${hermesHomeFor(undefined, "s1", "herm2").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)));

console.log(fails ? `\n${fails} FAILED` : "\ncheck:hermes passed");
process.exit(fails ? 1 : 0);
