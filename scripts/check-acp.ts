/**
 * check:acp — paw's wiring of the cotal-connector-acp plugin (hermetic: throwaway PAW_HOME, no mesh).
 *  - checkAgentSpec / applyAgentType: --model refused, no birth without acpCommand, no model key written
 *  - pawAcpConnector.buildLaunch: paw brief + beads env, no TMPDIR override, permission allow unless named
 *  - seat host: the Rust binary at $PAW_HOME/bin by default (missing → the install command, no node fallback),
 *    persona acpHost: /abs overrides, acpHost: ts = the plugin's node host, a spawn host option wins
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { acpHostBinPath } = await import("../src/acp-host.ts");
const hostBin = acpHostBinPath();
ok("host: a missing default binary fails loud with the install command", throws(() => pawAcpConnector.buildLaunch(opts(born)), /no Rust ACP seat host .*paw acp-host install/));
function fakeExe(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}
fakeExe(hostBin);
/** The seat command under paw's `/usr/bin/nice -n <n>` wrapper. */
const seat = (spec: { command: string; args?: string[] }) =>
  spec.command === "/usr/bin/nice" ? { command: spec.args![2], args: spec.args!.slice(3) } : { command: spec.command, args: spec.args ?? [] };
const launched = (o: LaunchOpts) => seat(pawAcpConnector.buildLaunch(o));
const onDefault = pawAcpConnector.buildLaunch(opts(born));
ok("host: the Rust binary by default (under nice)", onDefault.command === "/usr/bin/nice" && seat(onDefault).command === hostBin && seat(onDefault).args.length === 0);

const custom = fakeExe(join(home, "other-host"));
const withHost = (value: string) => {
  const f = join(home, `host-${value.replace(/\W/g, "_")}.md`);
  writeFileSync(f, `---\nname: fxbot\nagent: acp\nacpCommand: '["/usr/bin/true"]'\nacpHost: ${value}\n---\n`);
  return f;
};
ok("host: persona acpHost: /abs overrides", launched(opts(withHost(custom))).command === custom);
const ts = launched(opts(withHost("ts")));
ok("host: acpHost: ts = node + the plugin's host.js", ts.command === process.execPath && ts.args?.length === 1 && /cotal-connector-acp\/dist\/host\.js$/.test(ts.args[0]));
ok("host: acpHost: relative is refused by the plugin", throws(() => pawAcpConnector.buildLaunch(opts(withHost("cotal-acp-host"))), /absolute path/));
ok("host: a spawn host option wins over the persona", launched(opts(withHost("ts"), { host: custom })).command === custom);
rmSync(hostBin);
ok("host: acpHost: ts needs no Rust binary", launched(opts(withHost("ts"))).command === process.execPath);
fakeExe(hostBin);

const env = onDefault.env!;
ok("launch: permission defaults to allow (paw is bypass)", env.COTAL_ACP_PERMISSION === "allow");
ok("launch: no TMPDIR override (the seat inherits the daemon's durable TMPDIR)", env.TMPDIR === process.env.TMPDIR);
ok("launch: paw brief + beads", /paw agent/.test(env.COTAL_ACP_INSTRUCTIONS ?? "") && !!env.BEADS_DIR && env.BEADS_ACTOR === "fxbot");

const rejecting = join(home, "rejecting.md");
writeFileSync(rejecting, `---\nname: fxbot\nagent: acp\nacpCommand: '["/usr/bin/true"]'\nacpPermission: reject\n---\nbody\n`);
ok("launch: a persona acpPermission wins", pawAcpConnector.buildLaunch(opts(rejecting)).env!.COTAL_ACP_PERMISSION === "reject");
ok("launch: a spawn permission option wins", pawAcpConnector.buildLaunch(opts(born, { permission: "reject" })).env!.COTAL_ACP_PERMISSION === "reject");

console.log(fails ? `\n${fails} FAILED` : "\ncheck:acp passed");
process.exit(fails ? 1 : 0);
