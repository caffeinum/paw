/**
 * The namespace owner (src/namespace.ts) and every verb moved onto it. Pure cases for the state model and
 * the one-line renderings, then a fixture PAW_HOME that replicates the 2026-11-11 tracepaper incident:
 * a remote space `team2027` holding a TELEPORTED persona for the folder, the old local space `paw` with
 * its moved-to copy, a gone-folder `tracepaper-fx` and a legacy folders.json, transcripts on disk, and
 * `PAW_SPACE=team2027` in the env. Every refused verb must leave the persona bytes untouched.
 * Hermetic: temp HOME + PAW_HOME, no mesh, no manager. Run: pnpm check:namespace
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-ns-home-")));
process.env.HOME = home;
process.env.PAW_HOME = home;
process.env.PAW_SPACE = "team2027";
delete process.env.COTAL_SPACE;
delete process.env.PAW_MACHINE;

import type { Command } from "@cotal-ai/core";
const ns = await import("../src/namespace.ts");
const space = await import("../src/space.ts");
const addressing = await import("../src/addressing.ts");
const { renameAgentOnDisk, noAgentNamed } = await import("../src/rename.ts");
const { parseMoveArgs } = await import("../src/move.ts");
const { assertSafeRepin, notThisMachineRefusal, sessionAgeLine, pickSession } = await import("../src/adopt.ts");
const { resolveRemoval } = await import("../src/rm.ts");
const { registry } = await import("@cotal-ai/core");
const adoptCmd = registry.resolve<Command>("command", "adopt");
const runAdopt = (argv: string[]) => adoptCmd.run({ values: {}, positionals: [], raw: argv });

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function errOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
async function errOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

// ── 1. pure: the state model ────────────────────────────────────────────────────────────────────────
{
  const base = { name: "x", extra: false, folderExists: true };
  assert(ns.classify({ ...base, cwd: "/f" }).kind === "local", "classify: persona here, folder exists → local");
  assert(ns.classify({ ...base, cwd: "/f", folderExists: false }).kind === "folder-gone", "classify: folder missing → folder-gone");
  const t = ns.classify({ ...base, cwd: "/f", teleported: { to: "ssh:mini", at: "2026-10-23T17:04:15Z" } });
  assert(t.kind === "teleported" && t.to === "ssh:mini", "classify: marker wins over everything → teleported");
  assert(ns.classify({ ...base, cwd: "/f", folderExists: false, teleported: { to: "ssh:mini" } }).kind === "teleported", "classify: a teleported copy whose folder is gone is still teleported (it runs elsewhere)");

  const facts: import("../src/namespace.ts").SpaceFacts[] = [
    { space: "paw", remote: false, ledger: [], personas: [{ name: "tp", cwd: "/f", extra: false, folderExists: true }] },
    { space: "team2027", remote: true, ledger: ["ghost"], personas: [{ name: "tp", cwd: "/f", extra: false, folderExists: true, teleported: { to: "ssh:mini" } }, { name: "orph", extra: false, folderExists: false }] },
  ];
  const r1 = ns.resolvePure({ name: "tp" }, { space: "team2027", how: "env" }, facts);
  assert(r1.inChosen.length === 1 && r1.inChosen[0]!.where.kind === "teleported" && r1.elsewhere[0]!.space === "paw", "name: chosen space split from every other local space");
  const r2 = ns.resolvePure({ folder: "/f" }, { space: "paw", how: "default" }, facts);
  assert(r2.inChosen[0]!.where.kind === "local" && r2.elsewhere[0]!.where.kind === "teleported", "folder: every space's persona at that folder, with its state");
  const r3 = ns.resolvePure({ name: "ghost" }, { space: "paw", how: "flag" }, facts);
  assert(r3.elsewhere.length === 1 && r3.elsewhere[0]!.where.kind === "seen", "name: a remote space's ledger-only name → seen (another machine's)");
  assert(ns.resolvePure({ name: "orph" }, { space: "team2027", how: "flag" }, facts).inChosen.length === 0, "an orphan persona (no cwd, no marker) is nobody");
  const both = ns.resolvePure({ folder: "/f" }, { space: "team2027", how: "flag" }, [
    { space: "team2027", remote: true, ledger: [], personas: [{ name: "tp", cwd: "/f", extra: false, folderExists: true, teleported: { to: "ssh:mini" } }, { name: "tp-mac", cwd: "/f", extra: false, folderExists: true }] },
  ]);
  assert(both.inChosen[0]!.name === "tp-mac", "folder: this machine's own default ranks before a teleported frozen copy");
}

// ── 2. pure: renderings ─────────────────────────────────────────────────────────────────────────────
{
  const tele: import("../src/namespace.ts").Identity = { space: "team2027", name: "tracepaper", folder: "/f", extra: false, where: { kind: "teleported", to: "ssh:mini", at: "2026-10-23T17:04:15Z" } };
  const env = ns.elsewhereClause("tracepaper", { space: "paw", how: "env" }, [tele], "rename");
  assert(env.includes("from PAW_SPACE") && env.includes("runs on ssh:mini") && !env.includes("add --space"), `elsewhere clause: names provenance + state, never "add --space" for a record not this machine's (${env})`);
  const addr = ns.elsewhereClause("tracepaper", { space: "paw", how: "address" }, [tele], "rename");
  assert(addr.includes("`paw chat @tracepaper#team2027`") && !addr.includes("PAW_SPACE"), "address-chosen: no env note; message it is the only command offered");
  const local = ns.elsewhereClause("web", { space: "paw", how: "flag" }, [{ space: "lab", name: "web", folder: "/w", extra: false, where: { kind: "local" } }], "rename");
  assert(local.includes("`paw rename web#lab`"), "a local record elsewhere → the exact command there");
  const refuse = ns.mutableHereRefusal(tele, "rename") ?? "";
  assert(refuse.includes("frozen copy") && refuse.includes("paw teleport tracepaper#team2027 --back") && !refuse.includes("\n"), "mutableHereRefusal: one line, names the frozen copy and the way back");
  assert(ns.mutableHereRefusal({ ...tele, where: { kind: "local" } }, "rename") === undefined, "a local identity is mutable here");
  assert((ns.mutableHereRefusal({ ...tele, where: { kind: "seen" } }, "rename") ?? "").includes("another machine's agent"), "a seen identity is another machine's");
  assert(ns.ago(Date.now() - 18 * 86400_000) === "18d ago" && ns.ago(Date.now() - 3 * 3600_000) === "3h ago" && ns.ago(Date.now()) === "just now", "ago(): coarse ages");

  const a = notThisMachineRefusal({ away: tele, how: "env", target: ".", suggest: "tracepaper-aleks-macbook", altSpace: "paw", session: "2ac38184 (last written 18d ago; 12 sessions here — `paw sessions .`)" });
  assert(a.startsWith(`paw: this folder's agent "tracepaper" (space team2027, from PAW_SPACE) runs on ssh:mini (teleported 2026-10-23)`), `adopt Case A: first line names the space, its provenance and the state (${a.split("\n")[0]})`);
  assert(a.includes("paw adopt . --name tracepaper-aleks-macbook --space team2027") && a.includes("paw adopt . --space paw") && a.includes("18d ago"), "adopt Case A: the exact commands for a LOCAL agent, and the session's age");

  const note = ns.folderNotHereLine({ ids: [tele], newest: { id: "2ac38184-6e52", mtimeMs: Date.now() - 18 * 86400_000 }, suggest: "tracepaper-aleks-macbook" });
  assert(note === "this folder has no agent on this machine — session 2ac38184 here (18d ago) isn't running as an agent · `paw adopt . --name tracepaper-aleks-macbook` makes one", `chat banner: the folder's session isn't the agent (${note})`);
  assert(ns.folderNotHereLine({ ids: [tele, { ...tele, name: "mine", where: { kind: "local" } }], suggest: "x" }) === undefined, "chat banner: silent when a local agent owns the folder");

  const sc = (o: Partial<Parameters<typeof space.spaceChoiceOf>[0]>) => space.spaceChoiceOf({ space: "s", flag: false, address: false, verb: "adopt", env: {}, ...o }).how;
  assert(sc({ flag: true, env: { PAW_SPACE: "x" } }) === "flag" && sc({ address: true }) === "address" && sc({ env: { PAW_SPACE: "x" } }) === "env", "spaceChoiceOf: flag > address > env");
  assert(sc({ verb: "chat", env: { COTAL_SPACE: "t" } }) === "caller" && sc({ verb: "adopt", env: { COTAL_SPACE: "t" } }) === "default" && sc({}) === "default", "spaceChoiceOf: caller only for caller-space verbs; else default");
  space.noteSpaceChoice({ space: "q", how: "env" });
  assert(space.spaceWasChosen() && space.spaceChoice("q").how === "env" && space.spaceChoice("other").how === "flag", "spaceChoice: the noted choice for its space only; PAW_SPACE counts as chosen (never auto-yields)");
  space.noteSpaceChoice({ space: "q", how: "default" });
  assert(!space.spaceWasChosen(), "a defaulted space was not chosen (relocate may yield)");
}

// ── 3. move: a second bare word reads as a new name ─────────────────────────────────────────────────
{
  const m = errOf(() => parseMoveArgs(["tracepaper", "tracepaper-macbook", "--space", "paw"]));
  assert(m.includes("paw rename tracepaper#paw tracepaper-macbook") && m.includes("--as tracepaper-macbook"), `move with 2 positionals → rename / --as hint (${m.split("\n")[0]})`);
}

// ── 4. the incident fixture ─────────────────────────────────────────────────────────────────────────
const folder = join(home, "Github", "caffeinum", "tracepaper");
mkdirSync(folder, { recursive: true });
const spaces = join(home, "spaces");
const sp = (s: string, ...p: string[]) => join(spaces, s, ...p);
for (const s of ["paw", "team2027"]) mkdirSync(sp(s, "personas"), { recursive: true });
for (const s of ["paw", "team2027"]) writeFileSync(sp(s, "registry.v2"), "x\n");
writeFileSync(sp("team2027", "remote-mesh.json"), JSON.stringify({ space: "team2027", server: "tls://2027-cotal.fly.dev:4222", root: join(home, "remote", "team2027"), human: "aleks-macbook", ts: "2026-10-19T00:00:00Z" }));
const marker = sp("team2027", "personas", "tracepaper.md");
const markerText = (pin: string) =>
  `---\nname: tracepaper\nagent: kit\nprovider: grok\nstorage: claude\ncwd: ${folder}\nresume: ${pin}\nteleported: ssh:mini\nteleportedAt: 2026-10-23T17:04:15Z\nteleportedWhat: session,repo,memory,claude-md\n---\nYou are the paw agent for the "paper-mcp" folder.\n`;
writeFileSync(marker, markerText("975b994a-8f06-4151-90bc-658a84001619"));
writeFileSync(sp("paw", "personas", "tracepaper-fx.md"), `---\nname: tracepaper-fx\ncwd: ${join(home, "Github", "caffeinum", "paper-mcp")}\npaw-extra: "true"\nagent: acp\n---\n`);
mkdirSync(sp("paw", "moved-to-team2027"), { recursive: true });
writeFileSync(sp("paw", "moved-to-team2027", "tracepaper.md"), `---\nname: tracepaper\ncwd: ${join(home, "Github", "caffeinum", "paper-mcp")}\nresume: 975b994a-8f06-4151-90bc-658a84001619\n---\n`);
writeFileSync(sp("paw", "folders.json"), JSON.stringify({ [join(home, "Github", "caffeinum", "paper-mcp")]: "tracepaper" }));
writeFileSync(sp("team2027", "peers.json"), JSON.stringify({ "U-mini-1": { name: "tracepaper", first: 1, last: 2 }, "U-mini-2": { name: "evals", first: 1, last: 2 } }));
const pdir = ns.claudeProjectDir(folder);
mkdirSync(pdir, { recursive: true });
const day = 86400;
const now = Date.now() / 1000;
for (const [id, age] of [["2ac38184-6e52-4eb9-a6d3-d3539a98c438", 18], ["11111111-old", 30]] as const) {
  writeFileSync(join(pdir, `${id}.jsonl`), JSON.stringify({ cwd: folder, type: "user" }) + "\n");
  utimesSync(join(pdir, `${id}.jsonl`), now - age * day, now - age * day);
}
space.noteSpaceChoice({ space: "team2027", how: "env" });

{
  // the resolver's view of the incident
  const byFolder = ns.resolve({ folder }, space.spaceChoice("team2027"));
  assert(byFolder.inChosen.length === 1 && byFolder.inChosen[0]!.where.kind === "teleported" && byFolder.elsewhere.length === 0, "incident: `.` in team2027 → only the teleported frozen copy; nothing local");
  const byName = ns.resolve({ name: "tracepaper" }, { space: "paw", how: "address" });
  assert(byName.inChosen.length === 0 && byName.elsewhere[0]?.space === "team2027" && byName.elsewhere[0]?.where.kind === "teleported", "incident: tracepaper#paw → none in paw, teleported in team2027 (moved-to-* copies are never identities)");
  assert(ns.resolve({ name: "tracepaper-fx" }, { space: "paw", how: "flag" }).inChosen[0]?.where.kind === "folder-gone", "incident: tracepaper-fx → folder-gone");
  assert(!existsSync(sp("paw", "personas", "tracepaper.md")) && !existsSync(join(spaces, "paw", "personas", "removed")), "the resolver never writes (no persona minted, no dirs made)");

  // folder ownership: a teleported persona never owns the folder for a create
  assert(addressing.lookupOwnedFolderName("team2027", folder) === undefined, "lookupOwnedFolderName skips the teleported copy");
  assert(addressing.lookupFolderName("team2027", folder) === "tracepaper", "lookupFolderName still finds it when it is all there is (talk verbs message it)");
  const claim = errOf(() => addressing.folderToName("team2027", folder));
  assert(claim.includes(`"tracepaper"`) && claim.includes("runs on ssh:mini") && claim.includes("--name"), `folderToName: a name held by a teleported copy fails loud, never hash-suffixed (${claim})`);
  assert(!existsSync(sp("team2027", "personas", `tracepaper-${createHash("sha256").update(folder).digest("hex").slice(0, 6)}.md`)), "…and mints no hash-suffixed persona");
}

// rename: refused before any write, with the real state (no "add --space")
{
  const before = sha(marker);
  const mtime = statSync(marker).mtimeMs;
  const r = errOf(() => renameAgentOnDisk("team2027", folder, "tracepaper-macbook", "tracepaper"));
  assert(r.includes("frozen copy") && sha(marker) === before && statSync(marker).mtimeMs === mtime && !existsSync(sp("team2027", "personas", "tracepaper-macbook.md")), "rename: a teleported record is refused, persona bytes + mtime unchanged");
  space.noteSpaceChoice({ space: "paw", how: "address" });
  const nf = noAgentNamed("paw", "tracepaper");
  assert(nf.includes("runs on ssh:mini") && !nf.includes("add --space"), `rename tracepaper#paw: says where it runs, never "add --space team2027" (${nf})`);
  space.noteSpaceChoice({ space: "team2027", how: "env" });
}

// rm: the marker is not deleted silently (it's what `teleport --back` needs)
{
  const id = ns.identityIn("team2027", "tracepaper")!;
  assert((ns.mutableHereRefusal(id, "rm") ?? "").includes("frozen copy") && resolveRemoval("team2027", "tracepaper").name === "tracepaper", "rm: resolves the record, and the guard refuses it (rm() adds --frozen-copy as the explicit way)");
  const none = errOf(() => resolveRemoval("paw", "tracepaper"));
  assert(none.includes("runs on ssh:mini"), `rm tracepaper#paw: names the teleported record in team2027 (${none})`);
}

// adopt: the incident's step 1, then the two ways to get the local agent that was wanted
{
  const before = sha(marker);
  const a = await errOfAsync(() => runAdopt([folder, "--space", "team2027", "--no-start"]));
  assert(a.includes(`this folder's agent "tracepaper" (space team2027, from PAW_SPACE) runs on ssh:mini`), `adopt .: refused, naming space + provenance + state (${a.split("\n")[0]})`);
  assert(a.includes("--name tracepaper-aleks-macbook --space team2027") && a.includes(`paw adopt ${folder} --space paw`) && a.includes("18d ago"), "adopt .: offers the exact commands, and the picked session's age");
  assert(sha(marker) === before, "adopt .: the teleported persona's bytes are untouched (resume: still 975b994a)");

  const named = await errOfAsync(() => runAdopt([folder, "--space", "team2027", "--name", "tracepaper", "--no-start"]));
  assert(named.includes("frozen copy") && sha(marker) === before, "adopt --name <the teleported name>: refused, nothing written");

  const ledger = await errOfAsync(() => runAdopt([folder, "--space", "team2027", "--name", "evals", "--no-start"]));
  assert(ledger.includes(`"evals" is another machine's agent on the team2027 mesh`) && !existsSync(sp("team2027", "personas", "evals.md")), "adopt --name <a name another machine holds on the shared mesh>: refused, nothing minted");

  const ok = await errOfAsync(() => runAdopt([folder, "--space", "team2027", "--name", "tracepaper-aleks-macbook", "--no-start"]));
  const mine = addressing.agentRecord("team2027", "tracepaper-aleks-macbook");
  assert(ok === "" && mine?.folder === folder && mine.extra === false, `adopt . --name <new>: a NEW local default for the folder in team2027 (${ok})`);
  assert(sha(marker) === before, "…and the teleported copy keeps its cwd and pin (setFolderName never strips it)");
  assert(addressing.lookupFolderName("team2027", folder) === "tracepaper-aleks-macbook" && addressing.resolveFolderAgent("team2027", folder) === "tracepaper-aleks-macbook", "`chat .` now reaches the local agent, not the mini's");

  const inPaw = await errOfAsync(() => runAdopt([folder, "--space", "paw", "--resume", "11111111-old", "--no-start"]));
  assert(inPaw === "" && addressing.agentRecord("paw", "tracepaper")?.folder === folder, `adopt . --space paw: a local agent "tracepaper" in paw (${inPaw})`);

  // Case D: the damage as it is on the operator's disk — the frozen copy pins the local session
  writeFileSync(marker, markerText("2ac38184-6e52-4eb9-a6d3-d3539a98c438"));
  const d = await errOfAsync(() => runAdopt([folder, "--space", "paw", "--name", "tp2", "--resume", "2ac38184-6e52-4eb9-a6d3-d3539a98c438", "--no-start"]));
  assert(d.includes("frozen copy") && d.includes("runs on ssh:mini") && !d.includes("paw rm") && !existsSync(sp("paw", "personas", "tp2.md")), `Case D: a pin held by a teleported copy is named as such (never "paw rm" it), nothing registered (${d.split("\n")[0]})`);
}

// Case C: a bare adopt never swaps an existing pin to the newest transcript silently
{
  const line = sessionAgeLine({ id: "2ac38184-6e52", mtimeMs: Date.now() - 18 * 86400_000, count: 12 }, ".");
  const c = errOf(() =>
    assertSafeRepin({ sessionId: "2ac38184-6e52", explicitResume: false, name: "tp", planKind: "folder-default", prevPin: "975b", replace: false, target: ".", pinnedBy: [], autoPicked: line }),
  );
  assert(c.includes("won't swap it silently") && c.includes("--resume 2ac38184-6e52 --replace") && c.includes("18d ago"), "Case C: bare re-pin of an existing pin → refused with the exact command + age");
  assert(errOf(() => assertSafeRepin({ sessionId: "s", explicitResume: false, name: "tp", planKind: "folder-default", prevPin: undefined, replace: false, target: ".", pinnedBy: [], autoPicked: line })) === "", "Case C: a first adopt (no pin yet) still takes the latest");
  const pick = pickSession(pdir, folder, () => false);
  assert(pick?.id === "2ac38184-6e52-4eb9-a6d3-d3539a98c438" && pick.count === 2 && pick.holderPid === undefined, "pickSession: newest by mtime when no live claude holds one");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ sessionId: "11111111-old", cwd: folder, pid: 4242, updatedAt: 1 }));
  const held = pickSession(pdir, folder, (pid) => pid === 4242);
  assert(held?.id === "11111111-old" && held.holderPid === 4242, "pickSession: a session a LIVE claude holds here beats a newer dead transcript");
}

// wake gate backstop: the teleported branch reports `elsewhere`, never a bare {spawned:false}
{
  const src = readFileSync(new URL("../src/addressing.ts", import.meta.url), "utf8");
  assert(/if \(id\) return \{ spawned: false, id, elsewhere: \{ how: "teleported"/.test(src), "ensureAgentSpawned: a teleported peer live elsewhere returns `elsewhere`, not \"already running here\"");
}

rmSync(home, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} namespace check(s) FAILED`);
  process.exit(1);
}
console.log("\nall namespace checks passed 🐾");
