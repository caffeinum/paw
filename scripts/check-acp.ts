/**
 * check:acp — paw's wiring of the cotal-connector-acp plugin (hermetic: throwaway PAW_HOME, no mesh).
 *  - checkAgentSpec / applyAgentType: --model refused, no birth without acpCommand, no model key written
 *  - pawAcpConnector.buildLaunch: paw brief + beads env, no TMPDIR override, permission allow unless named
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LaunchOpts } from "@cotal-ai/core";

const home = mkdtempSync(join(tmpdir(), "pawacp-"));
process.env.PAW_HOME = home;

const { applyAgentType, checkAgentSpec, personaFilePath, setFolderName } = await import("../src/addressing.ts");
const { personaValue, readAgentType } = await import("../src/session.ts");
const { pawAcpConnector } = await import("../src/acp.ts");

let fails = 0;
function ok(name: string, cond: boolean): void {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}
function throws(fn: () => unknown, re: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

ok("checkAgentSpec: acp refuses --model", throws(() => checkAgentSpec({ agent: "acp", model: "grok-4.7" }), /put the model in the persona's acpCommand/));
ok("checkAgentSpec: acp alone passes", checkAgentSpec({ agent: "acp" }).agent === "acp");

const folder = mkdtempSync(join(tmpdir(), "pawacp-folder-"));
setFolderName("s1", folder, "fxbot");
ok("birth without acpCommand fails loud", throws(() => applyAgentType("s1", "fxbot", { agent: "acp" }), /needs its command first/));

const file = personaFilePath("s1", "fxbot");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `---\nname: fxbot\nacpCommand: '["/usr/bin/true"]'\n---\n`);
const born = applyAgentType("s1", "fxbot", { agent: "acp" });
ok("birth with acpCommand: agent acp, shareTools none, no model", readAgentType(born) === "acp" && personaValue(born, "shareTools") === "none" && personaValue(born, "model") === undefined);

const opts = (configPath: string, launchOptions?: Record<string, unknown>) =>
  ({ space: "s1", name: "fxbot", configPath, launchOptions }) as LaunchOpts;
const env = pawAcpConnector.buildLaunch(opts(born)).env!;
ok("launch: permission defaults to allow (paw is bypass)", env.COTAL_ACP_PERMISSION === "allow");
ok("launch: no TMPDIR override (the seat inherits the daemon's durable TMPDIR)", env.TMPDIR === process.env.TMPDIR);
ok("launch: paw brief + beads", /paw agent/.test(env.COTAL_ACP_INSTRUCTIONS ?? "") && !!env.BEADS_DIR && env.BEADS_ACTOR === "fxbot");

const rejecting = join(home, "rejecting.md");
writeFileSync(rejecting, `---\nname: fxbot\nagent: acp\nacpCommand: '["/usr/bin/true"]'\nacpPermission: reject\n---\nbody\n`);
ok("launch: a persona acpPermission wins", pawAcpConnector.buildLaunch(opts(rejecting)).env!.COTAL_ACP_PERMISSION === "reject");
ok("launch: a spawn permission option wins", pawAcpConnector.buildLaunch(opts(born, { permission: "reject" })).env!.COTAL_ACP_PERMISSION === "reject");

console.log(fails ? `\n${fails} FAILED` : "\ncheck:acp passed");
process.exit(fails ? 1 : 0);
