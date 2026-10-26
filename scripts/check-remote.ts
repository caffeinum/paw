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

assert(parseMeshArgs(["add", "team", "--server", "tls://h:4222", "--root", "/r", "--as", "aleks-mac-mini"]).human === "aleks-mac-mini", "add --as <name> parsed");
const st = parseMeshArgs(["set", "team", "--as", "bob"]);
assert(st.verb === "set" && st.space === "team" && st.human === "bob", "set <space> --as <name> parsed");
throws(() => parseMeshArgs(["set", "team"]), /needs --as/, "set without --as refused");
throws(() => parseMeshArgs(["rm", "team", "--as", "bob"]), /--as belongs/, "--as on rm refused");
throws(() => parseMeshArgs(["set", "team", "--as", "bad name"]), /human name/, "--as with a space refused");
throws(() => parseMeshArgs(["set", "team", "--as", "a/b"]), /human name/, "--as with a slash refused");

console.log("human peer name per space");
const { HUMAN_PEER, humanPeer } = await import("../src/names.ts");
assert(HUMAN_PEER === "you" && humanPeer("remotetest-local") === "you", "local space (no record) ⇒ \"you\"");
rm.writeRemoteMesh({ space: "remotetest-h", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
assert(humanPeer("remotetest-h") === "you", "remote record without human ⇒ \"you\" (existing records unchanged)");
rm.writeRemoteMesh({ space: "remotetest-h", server: "tls://127.0.0.1:14322", root, human: "aleks-mac-mini", ts: new Date().toISOString() });
assert(humanPeer("remotetest-h") === "aleks-mac-mini" && rm.readRemoteMesh("remotetest-h")?.human === "aleks-mac-mini", "remote record human ⇒ that name");
assert(humanPeer("remotetest-local") === "you", "…and other spaces keep \"you\"");
for (const bad of ["", "-x", "a b", "a/b", "x".repeat(65)]) throws(() => rm.checkHumanName(bad), /human name/, `checkHumanName refuses ${JSON.stringify(bad.slice(0, 8))}`);
assert(rm.checkHumanName("aleks.mac_mini-2") === "aleks.mac_mini-2", "checkHumanName accepts letters/digits/._-");
writeFileSync(rm.remoteMeshPath("remotetest-h"), JSON.stringify({ space: "remotetest-h", server: "tls://h:1", root, human: "bad name", ts: "x" }));
throws(() => humanPeer("remotetest-h"), /human name.*paw mesh set/, "a record with a bad human fails loud, never falls back to \"you\"");
const { meshBrief } = await import("../src/connector.ts");
const { kitBrief } = await import("../src/kit.ts");
const { hermesBrief } = await import("../src/hermes.ts");
const { acpBrief } = await import("../src/acp.ts");
assert(meshBrief("a").includes('cotal_dm("you"') && kitBrief("a").includes('cotal_dm("you"') && hermesBrief("a").includes('"you"') && acpBrief("a").includes('"you"'), "briefs default to \"you\"");
assert(meshBrief("a", undefined, "aleks-mac-mini").includes('peer "aleks-mac-mini", e.g. cotal_dm("aleks-mac-mini"') && !meshBrief("a", undefined, "aleks-mac-mini").includes('"you"'), "claude brief names the custom human");
assert(kitBrief("a", undefined, "aleks-mac-mini").includes('cotal_dm("aleks-mac-mini"') && hermesBrief("a", undefined, "aleks-mac-mini").includes('"aleks-mac-mini"') && acpBrief("a", "aleks-mac-mini").includes('"aleks-mac-mini"'), "kit/hermes/acp briefs name the custom human");
rm.removeRemoteMesh("remotetest-h");

console.log("CLI routing");
const { explicitSpace } = await import("../src/dispatch.ts");
assert(explicitSpace(["x", "--space", "team"]) === "team" && explicitSpace(["--space=team"]) === "team", "explicitSpace reads --space / --space=");
assert(explicitSpace(["x", "--", "--space", "team"]) === undefined && explicitSpace(["x"]) === undefined, "explicitSpace ignores args after -- and absence");
{
  // `paw cotal <verb>` / `paw attach` on a remote space: no --space/--creds for cotal, the record's server.
  const { remoteCotalArgv } = await import("../src/dispatch.ts");
  const srv = "tls://127.0.0.1:14322";
  const r1 = remoteCotalArgv(["attach", "--name", "evals", "--space", "team", "--server", "tls://other:1", "--creds", "/x.creds"], srv);
  assert(JSON.stringify(r1.argv) === JSON.stringify(["attach", "--name", "evals", "--server", srv]) && r1.droppedCreds, "remoteCotalArgv drops --space/--server/--creds, appends the record's server");
  const r2 = remoteCotalArgv(["ps", "--space=team", "--creds=/x"], srv);
  assert(JSON.stringify(r2.argv) === JSON.stringify(["ps", "--server", srv]) && r2.droppedCreds, "…the = forms too");
  const r3 = remoteCotalArgv(["send", "--to", "a", "--", "--space", "kept"], srv);
  assert(JSON.stringify(r3.argv) === JSON.stringify(["send", "--to", "a", "--server", srv, "--", "--space", "kept"]) && !r3.droppedCreds, "…never touches args after --");
  const { cotalAttachInvocation } = await import("../src/open.ts");
  rm.writeRemoteMesh({ space: "remotetest-r", server: srv, root, ts: new Date().toISOString() });
  const ra = cotalAttachInvocation("remotetest-r", "evals");
  assert(ra.remote && ra.cwd === root && JSON.stringify(ra.argv) === JSON.stringify(["attach", "--name", "evals", "--server", srv]), "remote attach: cwd = record root, --server, no --space");
  const la = cotalAttachInvocation("remotetest-local", "evals");
  assert(!la.remote && la.cwd === homedir() && JSON.stringify(la.argv) === JSON.stringify(["attach", "--name", "evals", "--space", "remotetest-local", "--server", DEFAULT_SERVER]), "local attach: --space + local broker, cwd = pawCotalRoot");
  rm.removeRemoteMesh("remotetest-r");
}
const { remoteTlsEnv } = await import("../src/connector.ts");
process.env.NODE_EXTRA_CA_CERTS = "/ca.pem";
rm.writeRemoteMesh({ space: "remotetest-r", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
const lo = { space: "remotetest-local" } as Parameters<typeof remoteTlsEnv>[0];
const ro = { space: "remotetest-r" } as Parameters<typeof remoteTlsEnv>[0];
assert(remoteTlsEnv(lo).envAllow === undefined, "a local seat's launch env is untouched");
assert(remoteTlsEnv(ro).envAllow?.includes("NODE_EXTRA_CA_CERTS") === true, "a remote seat inherits NODE_EXTRA_CA_CERTS");
rm.removeRemoteMesh("remotetest-r");
delete process.env.NODE_EXTRA_CA_CERTS;

console.log("TLS is REQUIRED on every remote dial");
const { pawConnector } = await import("../src/connector.ts");
const { natsTls } = await import("../src/server.ts");
const { probePresenceWrites } = await import("../src/presence-health.ts");
const { createServer } = await import("node:net");
const seatRoot = mkdtempSync(join(tmpdir(), "paw-remote-seat-"));
rm.writeRemoteMesh({ space: "remotetest-r", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
const seatEnv = (space: string) => {
  const persona = join(seatRoot, `${space}.md`);
  writeFileSync(persona, "---\nname: seat\n---\n");
  return pawConnector.buildLaunch({ space, name: "seat", configPath: persona, workspaceRoot: seatRoot, servers: pawServer(space) }).env ?? {};
};
assert(seatEnv("remotetest-r").COTAL_TLS === "1", "a remote seat's cotal MCP gets COTAL_TLS=1 (its only TLS knob)");
assert(seatEnv("remotetest-local").COTAL_TLS === undefined, "a local seat gets no COTAL_TLS");
assert(JSON.stringify(natsTls("remotetest-r")) === '{"tls":{}}' && Object.keys(natsTls("remotetest-local")).length === 0, "natsTls: {tls:{}} remote, {} local");
// A PLAINTEXT NATS listener (INFO without tls_required) at the remote address: a TLS-required probe must
// refuse it before CONNECT — the line that would carry the creds.
const heard: string[] = [];
const plain = createServer((s) => {
  s.on("data", (b) => heard.push(b.toString()));
  s.on("error", () => {});
  s.write(`INFO {"server_id":"plain","version":"2.10.0","proto":1,"max_payload":1048576,"headers":true,"auth_required":true}\r\n`);
});
const plainPort = await new Promise<number>((r) => plain.listen(0, "127.0.0.1", () => r((plain.address() as { port: number }).port)));
const h = await probePresenceWrites("remotetest-r", `tls://127.0.0.1:${plainPort}`, undefined, 2000);
await new Promise((r) => setTimeout(r, 100));
plain.close();
assert(h.kind === "unknown" && /tls/i.test(h.message), `the presence probe refuses a plaintext broker for a remote space — ${h.kind === "unknown" ? h.message : h.kind}`);
assert(!heard.join("").includes("CONNECT"), "…and never sent CONNECT to it");
rm.removeRemoteMesh("remotetest-r");
rmSync(seatRoot, { recursive: true, force: true });

console.log("an agent belongs to one space");
const { assertOneSpace, personaFilePath } = await import("../src/addressing.ts");
const sid = "11111111-2222-3333-4444-555555555555";
writeFileSync(personaFilePath("remotetest-local", "a"), `---\nname: a\nresume: ${sid}\n---\n`);
writeFileSync(personaFilePath("remotetest-local2", "b"), `---\nname: b\nresume: ${sid}\n---\n`);
assertOneSpace("remotetest-local2", sid);
assert(true, "two LOCAL spaces sharing a pin: unchanged (no new refusal)");
rm.writeRemoteMesh({ space: "remotetest-r", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
writeFileSync(personaFilePath("remotetest-r", "c"), `---\nname: c\nresume: ${sid}\n---\n`);
throws(() => assertOneSpace("remotetest-r", sid), /already belongs to "a" in space "remotetest-local"/, "a remote agent on a session another space pins is refused");
throws(() => assertOneSpace("remotetest-local", sid), /in space "remotetest-r"/, "and the local side refuses the remote's session too");
assertOneSpace("remotetest-r", "99999999-0000-0000-0000-000000000000");
assert(true, "an unshared session passes");
rm.removeRemoteMesh("remotetest-r");

console.log("chat's inbox bind failure is named, never a bare 'consumer not found'");
{
  const { describeInboxBindFailure } = await import("../src/human-inbox.ts");
  const bare = new Error("consumer not found");
  rm.writeRemoteMesh({ space: "remotetest-r", server: "tls://127.0.0.1:14322", root, ts: new Date().toISOString() });
  const remote = describeInboxBindFailure("remotetest-r", "abc123", bare).message;
  assert(/remote space "remotetest-r"/.test(remote) && /abc123/.test(remote) && /paw inbox --space remotetest-r/.test(remote), `remote: ${remote.slice(0, 90)}…`);
  rm.removeRemoteMesh("remotetest-r");
  assert(/space "remotetest-local"/.test(describeInboxBindFailure("remotetest-local", undefined, bare).message), "local: names the space");
  const other = new Error("timeout");
  assert(describeInboxBindFailure("remotetest-local", undefined, other) === other, "any other error passes through untouched");
}

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
{
  // What `cotal attach` (run by paw from the record root) resolves: --server and NO --space ⇒ the root's
  // stripped signer, mode auth ⇒ attach mints a session-caller cred. Naming the unregistered space instead
  // is "no mesh named …" — why remoteCotalArgv drops it.
  chmodSync(signerFile, 0o600);
  const { resolveMeshTarget } = await import("@cotal-ai/workspace");
  const t = resolveMeshTarget(sroot, { server: "tls://127.0.0.1:14322" });
  assert(t.space === "remotetest-s" && t.mode === "auth" && t.auth?.account?.signingSeed !== undefined, "cotal resolves the record root's signer from --server alone (mode auth, signing seed present)");
  throws(() => resolveMeshTarget(sroot, { server: "tls://127.0.0.1:14322", space: "remotetest-s" }), /no mesh named/, "…but --space on an unregistered space resolves nothing");
}
chmodSync(signerFile, 0o600);

console.log("paw's narrow remote creds (status lag, sleep host)");
const rc = await import("../src/remote-creds.ts");
const { credsClaims, idFromCreds, newIdentity, DEV_OWNER, unicastRecvFilter, unicastSubject } = await import("@cotal-ai/core");
const { statSync, readFileSync: readF } = await import("node:fs");
rm.writeRemoteMesh({ space: "remotetest-s", server: "tls://127.0.0.1:14322", root: sroot, ts: new Date().toISOString() });
const lag = await rc.lagReaderCreds("remotetest-s");
const lagClaims = credsClaims(lag);
const lagPub = lagClaims.nats?.pub?.allow ?? [];
const lagSub = lagClaims.nats?.sub?.allow ?? [];
assert(JSON.stringify(lagPub) === JSON.stringify(["$JS.API.CONSUMER.INFO.DM_remotetest-s.*"]), `inbox-lag cred publishes ONLY consumer INFO on the DM stream — ${lagPub.join(",")}`);
assert(JSON.stringify(lagSub) === JSON.stringify([`_INBOX_${idFromCreds(lag)}.>`]), "…and subscribes only its own reply inbox");
const { fromSeed } = await import("@nats-io/nkeys");
const signingPub = fromSeed(new TextEncoder().encode(full.account.signingSeed)).getPublicKey();
assert(lagClaims.iss === signingPub && (lagClaims as { nats?: { issuer_account?: string } }).nats?.issuer_account === full.account.pub, "signed by the account's signing key, issued for the space account");
assert(typeof lagClaims.exp === "number" && Math.abs(lagClaims.exp - (Date.now() / 1000 + rc.LAG_TTL_SEC)) < 60, "it expires (24h), never unbounded");
assert((statSync(rc.lagCredsPath("remotetest-s")).mode & 0o777) === 0o600, "cached 0600 under $PAW_HOME");
assert((await rc.lagReaderCreds("remotetest-s")) === lag, "a fresh cached cred is reused");
writeFileSync(rc.lagCredsPath("remotetest-s"), await rc.signScopedCreds("remotetest-s", "inbox-lag", newIdentity(), rc.lagGrants("remotetest-s"), 60), { mode: 0o600 });
const renewed = await rc.lagReaderCreds("remotetest-s");
assert(rc.credsSecondsLeft(renewed) > rc.RENEW_BEFORE_SEC && readF(rc.lagCredsPath("remotetest-s"), "utf8") === renewed, "a cred inside its last hour is re-signed and re-cached");
const fStand = unicastRecvFilter("remotetest-s", DEV_OWNER, "USTAND");
const fOld = unicastRecvFilter("remotetest-s", DEV_OWNER, "UOLD");
const names = [rc.watchConsumerName("remotetest-s", "a", "host", 0), rc.watchConsumerName("remotetest-s", "a", "host", 1)];
const wg = rc.watchGrants("remotetest-s", [fStand, fOld], names);
assert(wg.sub.length === 2 && wg.sub.includes(fStand) && wg.sub.includes(fOld), "sleep-watch subscribes exactly the stand-in's and the old seat's DM subjects");
assert(wg.pub.every((p) => !/MSG\.NEXT\.DM_[^.]+\.\*|MSG\.NEXT\.DM_[^.]+\.>|CONSUMER\.CREATE\.DM_[^.]+$|CONSUMER\.CREATE\.DM_[^.]+\.\*/.test(p)), "…its consumer rows are name-pinned (no stream-wide MSG.NEXT/CREATE that could drain an agent's durable)");
assert(wg.pub.includes(`$JS.API.CONSUMER.CREATE.DM_remotetest-s.${names[0]}.${fStand}`), "…and each CREATE row pins its filter");
assert(rc.watchConsumerName("remotetest-s", "a", "cli", 0) !== names[0], "the CLI's count and the host's reads never share a consumer name");
const fwd = rc.forwardGrants([unicastSubject("remotetest-s", DEV_OWNER, "UNEW", DEV_OWNER, "USENDER")]);
assert(fwd.pub.length === 1 && fwd.sub.length === 0, "sleep-forward publishes to exactly the woken seat's subjects from the backlog's senders");

console.log("paw chat / paw web on a remote space: no space-wide tap");
const own = await import("../src/chat-own.ts");
const ME = own.principalOfId("local.UME");
assert(ME.owner === "local" && ME.actor === "UME", "\"you\"'s principal comes from the endpoint's dot-form id (owner.actor)");
throws(() => own.principalOfId("UME"), /not an <owner>\.<actor> principal/, "a bare id fails loud rather than guessing an owner");
const subj = own.ownSendSubjects("remotetest-s", ME);
assert(subj.chat === "cotal.remotetest-s.chat.local.UME.>" && subj.dm === "cotal.remotetest-s.inst.*.*.local.UME", `chat's echo taps only "you"'s own send subjects — ${subj.chat} ${subj.dm}`);
const human = { allowSubscribe: [">"] };
const { permissionsFor, subjectMatches, mintLifecycleUid: mlu } = await import("@cotal-ai/core");
const agentSub = (permissionsFor("agent", "remotetest-s", { owner: DEV_OWNER, actor: "UME", connId: "UMEconn00", lifecycleUid: mlu() }, human) as { sub?: { allow?: string[] } }).sub?.allow ?? [];
assert(agentSub.some((a) => subjectMatches(a, subj.chat.replace(/>$/, "general"))) && !agentSub.some((a) => a === "cotal.remotetest-s.>"), "…the channel half rides chat's own `agent` cred (its chat.*.*.> grant), which has no space wildcard");
const echo = await rc.signScopedCreds("remotetest-s", "chat-echo", newIdentity(), rc.echoGrants(subj.dm), rc.ECHO_TTL_SEC);
const echoClaims = credsClaims(echo);
assert(JSON.stringify(echoClaims.nats?.sub?.allow) === JSON.stringify([`_INBOX_${idFromCreds(echo)}.>`, subj.dm]) && (echoClaims.nats?.pub?.allow ?? []).length === 0, "the chat-echo cred subscribes ONLY \"you\"'s outbound DMs (+ its reply inbox) and publishes nothing");
assert(typeof echoClaims.exp === "number" && Math.abs(echoClaims.exp - (Date.now() / 1000 + rc.ECHO_TTL_SEC)) < 60, "…and expires (24h)");
const convF = own.ownConversationFilters("remotetest-s", ME);
assert(convF.length === 2 && convF[0] === unicastRecvFilter("remotetest-s", DEV_OWNER, "UME") && convF[1] === subj.dm, "the tasks-view seed reads DMs to and from \"you\" only");
const hn = own.historyConsumerNames("remotetest-s", ME, "n1", 2);
const hg = rc.filteredReadGrants("remotetest-s", convF, hn);
assert(hg.sub.length === 0 && hg.pub.includes(`$JS.API.CONSUMER.CREATE.DM_remotetest-s.${hn[0]}.${convF[0]}`) && hg.pub.every((p) => !/MSG\.NEXT\.DM_[^.]+\.[*>]|CONSUMER\.CREATE\.DM_[^.]+(\.[*>])?$/.test(p)), "…through name- and filter-pinned consumers, no live subscribe");
assert(own.historyConsumerNames("remotetest-s", ME, "n2", 1)[0] !== hn[0], "…named per read (two chats never share a consumer)");
const { webTapSubjects } = await import("../src/web.ts");
assert(JSON.stringify(webTapSubjects("remotetest-s", false)) === JSON.stringify([undefined]), "paw web taps the whole space on an open mesh (unchanged)");
const wt = webTapSubjects("remotetest-s", true) as string[];
const adminSub = (permissionsFor("admin", "remotetest-s", { owner: DEV_OWNER, actor: "UME", connId: "UMEconn00" }, {}) as { sub?: { allow?: string[] } }).sub?.allow ?? [];
assert(wt.length === 3 && wt.every((t) => adminSub.includes(t)), `…and on a remote space each plane its admin observer may read — ${wt.join(" ")}`);

// The operator's 2026-10-19 `paw chat @evals --space team2027` printed `Permissions Violation for
// Subscription to "cotal.team2027.>"`: a CLI checkout from before chat-own.ts, whose chat.ts called
// `ep.tap(handler)` with no subject (= cotal's space wildcard). Guard both halves: chat itself taps
// nothing directly, and on a remote space every tap tapOwnSends places names a subject.
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const srcDir = new URL("../src/", import.meta.url);
  const direct = readdirSync(srcDir).filter((f) => /^chat.*\.ts$/.test(f) && f !== "chat-own.ts").filter((f) => /\bep\.tap\(/.test(readFileSync(new URL(f, srcDir), "utf8")));
  assert(direct.length === 0, `chat's taps all go through chat-own.ts (no direct ep.tap) — ${direct.join(" ") || "none"}`);
  const taps: Array<{ subject?: string } | undefined> = [];
  const fakeEp = { card: { id: "local.UME" }, tap: (_h: unknown, o?: { subject?: string }) => void taps.push(o) } as unknown as Parameters<typeof own.tapOwnSends>[0];
  // The echo dial goes to a dead port and fails; only the taps placed before it matter here.
  await own.tapOwnSends(fakeEp, "remotetest-s", "tls://127.0.0.1:9", () => {}, () => {}).then((stop) => stop(), () => {});
  assert(taps.length >= 1 && taps.every((o) => !!o?.subject && o.subject !== "cotal.remotetest-s.>"), `remote: tapOwnSends never taps the space wildcard — ${JSON.stringify(taps)}`);
}

console.log("hosted here (one machine of several on a remote space)");
const { hostingOf, hosting, localManagerInstanceId } = await import("../src/hosted.ts");
const { createManagerInstanceIdentity } = await import("@cotal-ai/workspace");
const { hostedLagTargets } = await import("../src/status.ts");
const { standInRefusal, forwardSubjects } = await import("../src/sleep-host.ts");
const { ManagerControl } = await import("../src/control.ts");
const ctlNoMgr = new ManagerControl("remotetest-s", "tls://127.0.0.1:9");
const psNoMgr = await ctlNoMgr.ps(1000, 1000);
await ctlNoMgr.close();
assert(!psNoMgr.ok && /no manager of this machine has registered in remote space/.test(psNoMgr.error ?? ""), `before this machine's manager registered, control refuses to address any manager — ${psNoMgr.error}`);
assert(localManagerInstanceId("remotetest-s") === undefined, "no local instance id before a manager registered");
const LOCAL = "a".repeat(26);
createManagerInstanceIdentity(sroot, "remotetest-s", { instanceId: LOCAL, serveIdentity: newIdentity() });
assert(localManagerInstanceId("remotetest-s") === LOCAL, "the local instance id is cotal's persisted manager identity under the record root");
const ours = { name: "a", id: "UAAA", instanceId: LOCAL, lifecycleUid: "b".repeat(26) };
const theirs = { name: "x", id: "UXXX", instanceId: "c".repeat(26), lifecycleUid: "d".repeat(26) };
assert(hostingOf({ name: "a", personaHere: true, row: ours, localInstanceId: LOCAL }).here, "our manager's seat + our persona → hosted here");
assert(!hostingOf({ name: "x", personaHere: true, row: theirs, localInstanceId: LOCAL }).here, "another instance's seat → not here, even with a same-named persona");
assert(!hostingOf({ name: "a", personaHere: false, row: ours, localInstanceId: LOCAL }).here, "no persona here → not here");
assert(!hostingOf({ name: "a", personaHere: true, row: undefined, localInstanceId: LOCAL }).here, "not in our ps → not here");
assert(!hostingOf({ name: "a", personaHere: true, row: { ...ours, instanceId: undefined }, localInstanceId: LOCAL }).here, "a ps row without an instance id is never assumed ours");
assert(hosting("remotetest-local", "anything", undefined).here, "local spaces: every agent is hosted here");
const targets = hostedLagTargets([ours, theirs, { name: "y", id: "UYYY", instanceId: LOCAL }], LOCAL);
assert(targets.length === 1 && targets[0]!.name === "a" && targets[0]!.durable === `dm_local-UAAA-${"b".repeat(26)}`, `lag is claimed only for our instance's seats, by exact durable — ${JSON.stringify(targets)}`);
assert(hostedLagTargets([ours], undefined).length === 0, "no local instance → no lag claimed");
const { bangNoFolderReason } = await import("../src/hosted.ts");
const bangFar = bangNoFolderReason({ name: "evals", remote: true, personaHere: false, host: "mini.local", localHost: "laptop" });
assert(bangFar === '"evals" is hosted on another machine (mini.local) — !cmd runs only for agents hosted here', `!cmd for another machine's agent says so, naming its host — ${bangFar}`);
assert(bangNoFolderReason({ name: "evals", remote: true, personaHere: false, localHost: "laptop" }) === '"evals" is hosted on another machine — !cmd runs only for agents hosted here', "…and omits the host when its card reports none");
assert(/runs on this host but not under this paw/.test(bangNoFolderReason({ name: "evals", remote: true, personaHere: false, host: "laptop", localHost: "laptop" })), "…never claims \"another machine\" when the card's host is this one");
assert(/^no registered folder for "a"/.test(bangNoFolderReason({ name: "a", remote: false, personaHere: false, localHost: "laptop" })), "open mesh: the old message (every agent is hosted here)");
assert(/^no registered folder for "a"/.test(bangNoFolderReason({ name: "a", remote: true, personaHere: true, localHost: "laptop" })), "remote, persona here but no folder: the registry message, not \"another machine\"");
const { elsewhereOf, elsewhereBang, elsewhereFiles, elsewhereBanner, elsewhereLabel } = await import("../src/hosted.ts");
const tele = elsewhereOf({ teleported: { to: "ssh:mini", cwd: "/Users/a/.paw/repos/o/tp" }, remote: true, personaHere: true, localHost: "laptop" });
assert(tele?.how === "teleported" && elsewhereLabel(tele) === "ssh:mini · /Users/a/.paw/repos/o/tp", "teleported: where + the folder there");
assert(elsewhereLabel(elsewhereOf({ teleported: { to: "ssh:mini" }, remote: true, personaHere: true, localHost: "laptop" })!) === "ssh:mini", "…the host alone when the folder there was never recorded");
assert(elsewhereOf({ teleported: { to: "origin" }, remote: true, personaHere: true, localHost: "laptop" })?.where === "the machine it came from", "a brought-back copy names no fake host");
assert(elsewhereOf({ remote: true, personaHere: false, host: "mini.local", localHost: "laptop" })?.where === "mini", "another machine's agent (no persona here): its card's host, by its first label");
assert(elsewhereOf({ remote: true, personaHere: false, host: "683e51da039598", machine: "fly-agents", localHost: "laptop" })?.where === "fly-agents", "…or by the machine name its card carries (the fly box)");
assert(elsewhereOf({ remote: true, personaHere: false, localHost: "laptop" })?.where === "another machine", "…or 'another machine' when its card reports none");
assert(elsewhereOf({ remote: true, personaHere: false, host: "laptop", localHost: "laptop" }) === undefined, "same host (another paw on this box): its files are here, not elsewhere");
assert(elsewhereOf({ remote: true, personaHere: true, localHost: "laptop" }) === undefined && elsewhereOf({ remote: false, personaHere: false, localHost: "laptop" }) === undefined, "hosted here / open mesh: not elsewhere");
assert(elsewhereBang("tracepaper", tele!) === "!cmd runs on this machine, not on ssh:mini where tracepaper works", "!cmd refusal names where it works");
assert(elsewhereFiles("tracepaper", tele!, ["[Image #1]"]) === "not sent — tracepaper runs on ssh:mini and can't open [Image #1] (a file on this machine)", "a local path to a remote agent is refused");
assert(elsewhereBanner(tele!) === "logs, ctx, !cmd and files are on ssh:mini — from here you message it over the mesh", "chat banner line");
const sRec = { name: "a", folder: "/x", since: 0, cursorSeq: 1, reason: "", instanceId: LOCAL };
assert(standInRefusal({ remote: true, rec: sRec, localInstanceId: LOCAL, personaHere: true }) === undefined, "the host stands in for a record slept by this machine");
assert(/another machine/.test(standInRefusal({ remote: true, rec: { ...sRec, instanceId: "c".repeat(26) }, localInstanceId: LOCAL, personaHere: true }) ?? ""), "…never for one slept from another manager instance");
assert(!!standInRefusal({ remote: true, rec: { ...sRec, instanceId: undefined }, localInstanceId: LOCAL, personaHere: true }), "…nor one that names no instance");
assert(!!standInRefusal({ remote: true, rec: sRec, localInstanceId: LOCAL, personaHere: false }), "…nor one whose persona is not here");
assert(standInRefusal({ remote: false, rec: { ...sRec, instanceId: undefined }, personaHere: false }) === undefined, "open mesh: unchanged");
const fs2 = forwardSubjects("remotetest-s", { owner: DEV_OWNER, actor: "UNEW" }, [`cotal.remotetest-s.inst.local.USTAND.local.US1`, `cotal.remotetest-s.inst.local.UOLD.local.US1`, `cotal.remotetest-s.inst.local.USTAND.local.US2`]);
assert(fs2.length === 2 && fs2.every((s) => s.startsWith("cotal.remotetest-s.inst.local.UNEW.local.US")), "forward subjects: the new seat, once per original sender");

console.log("the stand-in's identity on a remote space");
const { standInEndpointAuth, standInPrincipal } = await import("../src/sleep-dial.ts");
const { isStandIn } = await import("../src/roster.ts");
assert(!isStandIn("remotetest-s", "a", "local.whatever"), "no stand-in minted yet → nothing reads as one");
const sp = standInPrincipal("remotetest-s", "a");
const spPath = join(process.env.PAW_HOME!, "spaces", "remotetest-s", "sleep", "a.standin.nkey");
assert(sp.owner === DEV_OWNER && sp.actor.startsWith("U") && (statSync(spPath).mode & 0o777) === 0o600, "a persisted 0600 nkey of its own (never the agent's seat identity)");
assert(standInPrincipal("remotetest-s", "a").actor === sp.actor, "stable across calls (a re-raised stand-in keeps its DM subject)");
assert(isStandIn("remotetest-s", "a", `local.${sp.actor}`), "the roster recognises the remote stand-in by its nkey");
const sAuth = await standInEndpointAuth("remotetest-s", "a");
assert(!!sAuth.creds && idFromCreds(sAuth.creds) === sp.actor && sAuth.tls === true && !!sAuth.lifecycleUid, "its presence cred is cotal's `agent` for the stand-in nkey, TLS required");
assert(sAuth.kind === "endpoint", "…registered as kind `endpoint` (an authed `agent` presence must prove a provisioned dm_ durable; a stand-in consumes nothing)");
assert(!(credsClaims(sAuth.creds!).nats?.pub?.allow ?? []).some((p) => p.includes(".chat.")), "…with no channel publish rows");
rm.removeRemoteMesh("remotetest-s");

for (const d of [process.env.PAW_HOME!, process.env.COTAL_HOME!, root, sroot]) rmSync(d, { recursive: true, force: true });
if (failures) {
  console.error(`\ncheck:remote — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:remote — all ok");
