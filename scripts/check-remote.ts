/**
 * check:remote — per-space REMOTE mesh records (src/remote-mesh.ts, `paw mesh`).
 *
 * Hermetic: a temp PAW_HOME and COTAL_HOME, no broker. Proves a space with no record resolves
 * exactly as before (local broker, local cotal root, no TLS option), a recorded space resolves to its
 * tls:// broker and signer root, conflicting env answers fail loud, malformed records fail loud
 * (never "local"), and `paw mesh add` accepts only a private signer for the right space.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-remote-home-"));
process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "paw-remote-cotal-"));
delete process.env.PAW_SERVER;
delete process.env.PAW_COTAL_ROOT;
process.env.PAW_SPACE = "remotetest-local";

const { DEFAULT_SERVER, createSpaceAuth, stripSpaceAuth } = await import("@cotal-ai/core");
const rm = await import("../src/remote-mesh.ts");
const { pawServer, localServer, isRemoteSpace, meshTls } = await import("../src/server.ts");
const { pawCotalRoot } = await import("../src/cotal-root.ts");
const { parseMeshArgs, checkSignerRoot } = await import("../src/commands/mesh.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
  }
}

console.log("server URL validation");
assert(rm.checkRemoteServer("tls://2027-cotal.fly.dev:4222") === "tls://2027-cotal.fly.dev:4222", "tls://host:port accepted");
throws(() => rm.checkRemoteServer("nats://h:4222"), /tls:\/\/host:port/, "nats:// refused");
throws(() => rm.checkRemoteServer("tls://h"), /explicit port/, "missing port refused");
throws(() => rm.checkRemoteServer("tls://u:p@h:4222"), /credentials/, "embedded creds refused");
throws(() => rm.checkRemoteServer("tls://h:4222/x"), /bare/, "path refused");
throws(() => rm.checkSpaceName("a/b"), /letters/, "space with a slash refused");

console.log("no record ⇒ local, unchanged");
assert(rm.readRemoteMesh("remotetest-local") === undefined, "no record reads as undefined");
assert(pawServer() === DEFAULT_SERVER && pawServer("remotetest-local") === DEFAULT_SERVER, "pawServer = DEFAULT_SERVER");
process.env.PAW_SERVER = "nats://127.0.0.1:14999";
assert(pawServer("remotetest-local") === "nats://127.0.0.1:14999" && localServer() === "nats://127.0.0.1:14999", "PAW_SERVER still wins for a local space");
delete process.env.PAW_SERVER;
assert(!isRemoteSpace("remotetest-local") && Object.keys(meshTls("remotetest-local")).length === 0, "no TLS option for a local space");
assert(pawCotalRoot("remotetest-local") === homedir(), "cotal root falls back to homedir");

console.log("record ⇒ remote broker + signer root");
const root = mkdtempSync(join(tmpdir(), "paw-remote-root-"));
rm.writeRemoteMesh({ space: "remotetest-r", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
assert(pawServer("remotetest-r") === "tls://127.0.0.1:14322", "pawServer(space) = the record's server");
assert(pawServer() === DEFAULT_SERVER, "the CURRENT (local) space is unaffected by another space's record");
process.env.PAW_SPACE = "remotetest-r";
assert(pawServer() === "tls://127.0.0.1:14322", "PAW_SPACE=<remote> routes the default pawServer()");
process.env.PAW_SPACE = "remotetest-local";
assert(isRemoteSpace("remotetest-r") && meshTls("remotetest-r").tls === true, "remote space requires TLS");
assert(pawCotalRoot("remotetest-r") === root, "cotal root = the record's root");
process.env.PAW_SERVER = "nats://127.0.0.1:14999";
assert(pawServer("remotetest-r") === "tls://127.0.0.1:14322" && pawServer("remotetest-local") === "nats://127.0.0.1:14999", "PAW_SERVER moves the local broker only, never a remote space");
delete process.env.PAW_SERVER;
process.env.PAW_COTAL_ROOT = "/elsewhere";
throws(() => pawCotalRoot("remotetest-r"), /PAW_COTAL_ROOT/, "PAW_COTAL_ROOT disagreeing with a remote root fails loud");
delete process.env.PAW_COTAL_ROOT;
assert(rm.listRemoteMeshes().map((r) => r.space).join() === "remotetest-r", "listRemoteMeshes finds it");
mkdirSync(join(process.env.PAW_HOME!, "spaces", "remotetest-bad"), { recursive: true });
writeFileSync(rm.remoteMeshPath("remotetest-bad"), "{nope");
throws(() => pawServer("remotetest-bad"), /not JSON/, "a malformed record fails loud, never reads as local");
writeFileSync(rm.remoteMeshPath("remotetest-bad"), JSON.stringify({ space: "other", server: "tls://h:1", root, ts: "x" }));
throws(() => rm.readRemoteMesh("remotetest-bad"), /malformed/, "a record naming another space fails loud");
rm.removeRemoteMesh("remotetest-bad");
assert(rm.removeRemoteMesh("remotetest-r") && rm.readRemoteMesh("remotetest-r") === undefined, "removeRemoteMesh drops it");

console.log("paw mesh args");
const a = parseMeshArgs(["add", "team", "--server", "tls://h:4222", "--root", "/r", "--space", "paw"]);
assert(a.verb === "add" && a.space === "team" && a.server === "tls://h:4222" && a.root === "/r", "add: positional space beats the injected --space");
assert(parseMeshArgs(["--space", "paw"]).verb === "ls", "bare `paw mesh` lists");
throws(() => parseMeshArgs(["rm", "x", "--server", "tls://h:1"]), /belong to/, "--server on rm refused");
throws(() => parseMeshArgs(["frob"]), /unknown/, "unknown verb refused");

console.log("CLI routing");
const { explicitSpace } = await import("../src/dispatch.ts");
assert(explicitSpace(["x", "--space", "team"]) === "team" && explicitSpace(["--space=team"]) === "team", "explicitSpace reads --space / --space=");
assert(explicitSpace(["x", "--", "--space", "team"]) === undefined && explicitSpace(["x"]) === undefined, "explicitSpace ignores args after -- and absence");
const { remoteTlsEnv } = await import("../src/connector.ts");
process.env.NODE_EXTRA_CA_CERTS = "/ca.pem";
rm.writeRemoteMesh({ space: "remotetest-r", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
const lo = { space: "remotetest-local" } as Parameters<typeof remoteTlsEnv>[0];
const ro = { space: "remotetest-r" } as Parameters<typeof remoteTlsEnv>[0];
assert(remoteTlsEnv(lo).envAllow === undefined, "a local seat's launch env is untouched");
assert(remoteTlsEnv(ro).envAllow?.includes("NODE_EXTRA_CA_CERTS") === true, "a remote seat inherits NODE_EXTRA_CA_CERTS");
rm.removeRemoteMesh("remotetest-r");
delete process.env.NODE_EXTRA_CA_CERTS;

console.log("signer root");
const full = await createSpaceAuth("remotetest-s");
const sroot = mkdtempSync(join(tmpdir(), "paw-remote-signer-"));
mkdirSync(join(sroot, ".cotal", "auth"), { recursive: true });
const signerFile = join(sroot, ".cotal", "auth", "auth.json");
writeFileSync(signerFile, JSON.stringify(stripSpaceAuth(full)), { mode: 0o600 });
assert(checkSignerRoot("remotetest-s", sroot) === sroot, "a stripped `cotal mint --signer` file loads");
throws(() => checkSignerRoot("remotetest-other", sroot), /no signer for space "remotetest-other"/, "a signer for another space is refused");
chmodSync(signerFile, 0o644);
throws(() => checkSignerRoot("remotetest-s", sroot), /readable by other users/, "a world-readable signer is refused");
throws(() => checkSignerRoot("remotetest-s", join(sroot, "nope")), /does not exist/, "a missing root is refused");

for (const d of [process.env.PAW_HOME!, process.env.COTAL_HOME!, root, sroot]) rmSync(d, { recursive: true, force: true });
if (failures) {
  console.error(`\ncheck:remote — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:remote — all ok");
