/**
 * check:acp — paw's wiring of the cotal-connector-acp plugin (hermetic: throwaway PAW_HOME, no mesh).
 *  - checkAgentSpec / applyAgentType: --model refused, no birth without acpCommand, no model key written
 *  - pawAcpConnector.buildLaunch: paw brief + beads env, no TMPDIR override, permission allow unless named
 *  - seat host: the Rust binary at $PAW_HOME/bin by default (missing → the install command, no node fallback),
 *    persona acpHost: /abs overrides, acpHost: ts = the plugin's node host, a spawn host option wins
 *  - the host pin: binary named by ACP_HOST_REV, ACP_PLUGIN_INTEGRITY = the lock's tgz, install refuses a
 *    checkout without the pinned commit, `paw acp-host` agrees with the spawn gate on a non-executable
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LaunchOpts } from "@cotal-ai/core";

const home = mkdtempSync(join(tmpdir(), "pawacp-"));
process.env.PAW_HOME = home;
const temps = [home];

const { applyAgentType, checkAgentSpec, personaFilePath, setFolderName } = await import("../src/addressing.ts");
const { personaValue, readAgentType } = await import("../src/session.ts");
const { pawAcpConnector } = await import("../src/acp.ts");

let fails = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
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
temps.push(folder);
setFolderName("s1", folder, "fxbot");
ok("birth without acpCommand fails loud", throws(() => applyAgentType("s1", "fxbot", { agent: "acp" }), /needs its command first/));

const file = personaFilePath("s1", "fxbot");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `---\nname: fxbot\nacpCommand: '["/usr/bin/true"]'\n---\n`);
const born = applyAgentType("s1", "fxbot", { agent: "acp" });
ok("birth with acpCommand: agent acp, shareTools none, no model", readAgentType(born) === "acp" && personaValue(born, "shareTools") === "none" && personaValue(born, "model") === undefined);

const opts = (configPath: string, launchOptions?: Record<string, unknown>) =>
  ({ space: "s1", name: "fxbot", configPath, launchOptions }) as LaunchOpts;
const { ACP_HOST_REV, ACP_PLUGIN_INTEGRITY, acpHostBinPath, installAcpHost } = await import("../src/acp-host.ts");
const hostBin = acpHostBinPath();
ok("pin: the binary's name carries the pinned plugin commit", /^[0-9a-f]{40}$/.test(ACP_HOST_REV) && hostBin === join(home, "bin", `cotal-acp-host-${ACP_HOST_REV.slice(0, 12)}`));
const lock = readFileSync(resolve(import.meta.dirname, "..", "pnpm-lock.yaml"), "utf8");
const lockIntegrity = lock.match(/cotal-connector-acp@file:vendor\/[^:]+:\n\s+resolution: \{integrity: (\S+?),/)?.[1];
ok("pin: ACP_PLUGIN_INTEGRITY is the vendored tgz in pnpm-lock.yaml (a re-pack must bump ACP_HOST_REV)", lockIntegrity === ACP_PLUGIN_INTEGRITY, lockIntegrity);
const emptyRepo = mkdtempSync(join(tmpdir(), "pawacp-repo-"));
temps.push(emptyRepo);
execFileSync("git", ["init", "-q", emptyRepo]);
process.env.COTAL_ACP_REPO = emptyRepo;
ok("pin: install refuses a checkout without the pinned commit", throws(() => installAcpHost(), new RegExp(`commit ${ACP_HOST_REV} isn't in`)));
delete process.env.COTAL_ACP_REPO;
const status = () => execFileSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "..", "bin", "paw.ts"), "acp-host"], { encoding: "utf8", env: { ...process.env, PAW_HOME: home } });
mkdirSync(hostBin, { recursive: true });
ok("status: a directory at the host path reads missing, like the spawn gate", /^✗ .*missing or not executable/.test(status()) && throws(() => pawAcpConnector.buildLaunch(opts(born)), /no Rust ACP seat host/));
rmSync(hostBin, { recursive: true });
writeFileSync(hostBin, "#!/bin/sh\nexit 0\n");
ok("status: a non-executable file reads missing, like the spawn gate", /^✗ /.test(status()) && throws(() => pawAcpConnector.buildLaunch(opts(born)), /no Rust ACP seat host/));
rmSync(hostBin);
ok("host: a missing default binary fails loud with the install command", throws(() => pawAcpConnector.buildLaunch(opts(born)), /no Rust ACP seat host .*paw acp-host install/));
function fakeExe(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}
fakeExe(hostBin);
ok("status: an executable host reads installed, with its commit", status().startsWith(`✓ ${hostBin} (cotal-connector-acp ${ACP_HOST_REV.slice(0, 12)})`));
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

{
  // A remote space on a private CA: the seat host dials the broker itself, so it needs the CA env too
  // (found by e2e:teleport — the seat died on "self-signed certificate" while claude seats connected).
  const { writeRemoteMesh, removeRemoteMesh } = await import("../src/remote-mesh.ts");
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = join(home, "ca.pem");
  writeRemoteMesh({ space: "s1", server: "tls://127.0.0.1:1", root: home, ts: new Date().toISOString() });
  ok("launch: a remote space's seat inherits NODE_EXTRA_CA_CERTS", pawAcpConnector.buildLaunch(opts(born)).env!.NODE_EXTRA_CA_CERTS === join(home, "ca.pem"));
  removeRemoteMesh("s1");
  ok("launch: a local space's seat gets no CA env added", pawAcpConnector.buildLaunch(opts(born)).env!.NODE_EXTRA_CA_CERTS === undefined);
  if (ca === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = ca;
}

for (const dir of temps) rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\ncheck:acp passed");
process.exit(fails ? 1 : 0);
