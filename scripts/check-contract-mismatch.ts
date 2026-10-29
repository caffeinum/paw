/**
 * check:contract-mismatch — cotal's "pinned digests … do not match the served contract" refusal on a
 * space whose managers run different cotal versions (src/contract-mismatch.ts), and `paw attach`'s
 * pin to THIS machine's manager when it hosts the seat (localSeatPin in src/open.ts).
 *
 * Hermetic: temp PAW_HOME/COTAL_HOME, no broker; the cotal subprocess is a fake node script printing
 * the exact text cotal 0.100.0 printed live on team2027 (2026-10-28).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-cm-home-"));
process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "paw-cm-cotal-"));
process.env.PAW_SPACE = `test-cm-${process.pid}`;
process.env.PAW_RELEASE = "dev";
process.env.PAW_SERVER = "nats://127.0.0.1:1";

const { parseMismatches, mentionsMismatch, contractMismatchHint } = await import("../src/contract-mismatch.ts");
const { runTeed, runCotalPassthrough } = await import("../src/cotal-tee.ts");
const { localSeatPin, cotalAttachInvocation } = await import("../src/open.ts");
const rm = await import("../src/remote-mesh.ts");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
async function rejects(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
  }
}

const IN = "sha256:1db0472aaee8e6b9d8d3d430ee021a1b6efc559ab7c0b99186898c972c53dd2d";
const V100 = "sha256:3b805cc0a14b4475fce2d5bc5aa8ab1d8aaaa1bd9cc3fa52b194ec5d96917dc5"; // cotal 0.100.0 ps output
const V84 = "sha256:89813cb7126075bcb004a5cc6617eef6ff4a395597a3215d3f5c55d79127f65f"; // cotal 0.81–0.84 ps output
const MINE = "fp7em3ilglv1x8l8w5y9jw3w83uidyz";
const MACBOOK = "gtfd76txq3w1j7znzwgde68psguvvzq";
const ODD = "3tmx3cxq7fnzwr4b2ofrnsnpptpj4q1";
const refusal = (id: string, pinned: string, served: string) =>
  `${id}: pinned digests ${IN}/${pinned} do not match the served contract ${IN}/${served}; a member that cannot honor a pinned digest rejects, never coerces (SPEC 13.7)`;
// `paw attach evals-intern#team2027`, the describe won by the 0.84 manager:
const ATTACH = `✗ could not establish where "evals-intern" is: 0 manager instance(s) answered and none hosts it, but 2 did not answer for themselves, so this is NOT a report that it is gone — it may be running on one of those. 2 refused the read rather than answering (${refusal(MINE, V84, V100)}; ${refusal(MACBOOK, V84, V100)}). To address one directly: \`cotal attach --on <instance>\` (the whole id, as printed).`;
// `paw cotal ps --space team2027`, the describe won by a 0.100 manager:
const PS = `! manager ${ODD} serves a different ps contract; its seats were not listed
✗ Incomplete manager census: 1 of 4 instances did not return seats. Rows above are partial, not a complete list.
  ↳ Managers in this space serve different ps contracts. manager ${ODD}: requested input/output ${IN} / ${V100}; served input/output ${IN} / ${V84}. Align the manager versions and retry.`;

console.log("parse");
const a = parseMismatches(ATTACH);
assert(a.length === 2 && a[0].instanceId === MINE && a[0].pinnedOutput === V84 && a[0].servedOutput === V100 && a[1].instanceId === MACBOOK, "attach refusal list → both instances, pinned 0.84 / served 0.100");
const p = parseMismatches(PS);
assert(p.length === 1 && p[0].instanceId === ODD && p[0].pinnedOutput === V100 && p[0].servedOutput === V84, "ps census remedy → the odd instance, pinned 0.100 / served 0.84");
assert(mentionsMismatch("! manager x serves a different ps contract; its seats were not listed") && parseMismatches("! manager x serves a different ps contract").length === 0, "the digest-free warning still counts as a mismatch");
assert(!mentionsMismatch("✗ no managed agent \"x\" on any of the 2 reachable manager instance(s)") && contractMismatchHint({ space: "s", text: "✗ unrelated", remote: true }) === undefined, "no mismatch → no hint");

console.log("hint");
const h1 = contractMismatchHint({ space: "team2027", text: ATTACH, remote: true, localInstanceId: MINE })!;
assert(/this machine's manager fp7em3il… serves 3b805cc0a14b and is fine/.test(h1) && /answered cotal's describe serves ps contract 89813cb71260/.test(h1), "this machine refused → it is fine, the describe winner is the odd one");
assert(/`paw restart` here does not fix it/.test(h1) && /Upgrade paw on the odd host/.test(h1) && !h1.includes("\n"), "says restart here won't help, names the real fix, one line");
const h2 = contractMismatchHint({ space: "team2027", text: PS, remote: true, localInstanceId: MINE })!;
assert(/3tmx3cxq… \(serves 89813cb71260\)/.test(h2) && /answered describe \(3b805cc0a14b\)/.test(h2), "this machine answered → names the refusing odd instance and its contract");
const h3 = contractMismatchHint({ space: "paw", text: ATTACH, remote: false })!;
assert(/one manager per local space/.test(h3) && /paw restart --space paw/.test(h3), "local space → a leftover manager; restart leaves one");

console.log("attach pin");
const calls: string[] = [];
const deps = (o: { remote: boolean; local?: string; reply: { ok: boolean; data?: unknown; error?: string } }) => ({
  remote: () => o.remote,
  localInstanceId: () => o.local,
  inspect: async (_s: string, n: string) => {
    calls.push(n);
    return o.reply;
  },
});
assert((await localSeatPin("paw", "x", deps({ remote: false, local: MINE, reply: { ok: true } }))) === undefined && calls.length === 0, "local space → no pin, no inspect");
assert((await localSeatPin("team2027", "x", deps({ remote: true, reply: { ok: true } }))) === undefined, "no manager of this machine registered → no pin");
assert((await localSeatPin("team2027", "evals-intern", deps({ remote: true, local: MINE, reply: { ok: true, data: { name: "evals-intern", instanceId: MINE } } }))) === MINE, "this machine's manager hosts it → pin to it");
assert((await localSeatPin("team2027", "evals", deps({ remote: true, local: MINE, reply: { ok: false, error: "no agent" } }))) === undefined, "not hosted here → no pin (cotal locates it)");
await rejects(() => localSeatPin("team2027", "x", deps({ remote: true, local: MINE, reply: { ok: true, data: { instanceId: ODD } } })), /refusing to guess/, "a pinned rail answering for another instance fails loud");

const root = mkdtempSync(join(tmpdir(), "paw-cm-root-"));
const srv = "tls://127.0.0.1:14322";
rm.writeRemoteMesh({ space: "test-cm-r", server: srv, root, ts: new Date().toISOString() });
const ra = cotalAttachInvocation("test-cm-r", "evals-intern", MINE);
assert(JSON.stringify(ra.argv) === JSON.stringify(["attach", "--name", "evals-intern", "--on", MINE, "--server", srv]) && ra.cwd === root, "remote attach with a pin → --on <instance>");
const rn = cotalAttachInvocation("test-cm-r", "evals");
assert(!rn.argv.includes("--on"), "remote attach without a pin → no --on (cotal locates)");
let threw = false;
try {
  cotalAttachInvocation("test-cm-local", "x", MINE);
} catch {
  threw = true;
}
assert(threw, "a pin on a local space fails loud");
rm.removeRemoteMesh("test-cm-r");

console.log("tee + passthrough");
const fake = join(mkdtempSync(join(tmpdir(), "paw-cm-bin-")), "fake-cotal.mjs");
writeFileSync(fake, `process.stderr.write(process.argv[2] ?? ""); process.exit(Number(process.argv[3] ?? 0));\n`);
const t = await runTeed(process.execPath, [fake, ATTACH, "3"]);
assert(t.status === 3 && t.stderr === ATTACH, "runTeed keeps the exit status and the stderr it forwarded");
const written: string[] = [];
const orig = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array) => {
  written.push(String(chunk));
  return true;
}) as typeof process.stderr.write;
const st = await runCotalPassthrough("ps", process.execPath, [fake, PS, "1"], { space: "paw", remote: false });
const st2 = await runCotalPassthrough("ps", process.execPath, [fake, "fine", "0"], { space: "paw", remote: false });
process.stderr.write = orig;
assert(st === 1 && written.some((w) => /^paw: space "paw" has managers serving different cotal contracts/.test(w)), "ps passthrough: mismatch → paw's line after cotal's");
assert(st2 === 0 && !written.some((w) => w.startsWith("paw:") && w.includes("fine")), "ps passthrough: no mismatch → nothing added");

if (failures) {
  console.error(`\ncheck:contract-mismatch — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:contract-mismatch — all passed");
