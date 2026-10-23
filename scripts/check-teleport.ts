/**
 * `paw teleport` hermetic checks (src/teleport-plan.ts, src/teleport-shell.ts, the wake-gate refusal in
 * src/addressing.ts): argument and transport parsing, the checklist reducer, the continued-in chain on
 * fixture transcripts, the manifest (session sidecars, memory, skills, CLAUDE.md, repo), the dirty-repo
 * refusal, the probe parse, the blockers, the plan, the persona keys, and that a teleported persona is
 * refused by every wake path. The pack/unpack and repo scripts run for real between two temp HOMEs.
 *
 * Isolated: HOME and PAW_HOME are temp dirs. No mesh, no manager, no network.
 * Run: pnpm check:teleport
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paw-teleport-home-"));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ALLOW_ANY_CWD = "1";
delete process.env.PAW_ROOT;
delete process.env.KIT_HOME;

const plan = await import("../src/teleport-plan.ts");
const shell = await import("../src/teleport-shell.ts");
const { ensureAgentSpawned, personaFilePath, setPersonaKeys } = await import("../src/addressing.ts");
const { startedLine } = await import("../src/teleport.ts");

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
async function rejects(p: Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await p;
    assert(false, `${msg} (did not reject)`);
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
  }
}

console.log("args");
{
  const a = plan.parseTeleportArgs(["evals", "--to", "fly:2027-agents", "--session", "--repo", "--dry-run"]);
  assert(a.name === "evals" && a.to?.kind === "fly" && a.dryRun && !a.yes, "name, --to fly, --dry-run");
  assert(JSON.stringify(a.what) === JSON.stringify(["session", "repo"]), "checkmarks in canonical order");
  assert(plan.parseTeleportArgs(["x", "--to=ssh:me@box", "--all", "-y"]).what?.length === plan.WHAT.length, "--all = every checkmark, --to=, -y");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:box"]).what === undefined, "no checkmark = ask");
  const back = plan.parseTeleportArgs(["x", "--back", "--yes"]);
  assert(back.back && back.to === undefined && back.yes, "--back");
  throws(() => plan.parseTeleportArgs(["x", "--back", "--to", "ssh:b"]), /recorded at teleport time/, "--back refuses --to");
  throws(() => plan.parseTeleportArgs(["x", "--back", "--session"]), /no --all/, "--back refuses checkmarks");
  throws(() => plan.parseTeleportArgs(["x", "--all", "--repo", "--to", "ssh:b"]), /not both/, "--all with a checkmark refused");
  throws(() => plan.parseTeleportArgs(["x"]), /where to/, "no --to refused");
  throws(() => plan.parseTeleportArgs(["--to", "ssh:b"]), /which agent/, "no name refused");
  throws(() => plan.parseTeleportArgs(["x", "--to", "ssh:b", "--memroy"]), /unknown flag "--memroy"/, "a typo'd checkmark is an unknown flag");
  const fm = plan.parseTransport("fly:2027-agents/683e51da039598");
  assert(fm.kind === "fly" && fm.app === "2027-agents" && fm.machine === "683e51da039598", "fly:<app>/<machine>");
  assert(plan.transportLabel(fm) === "fly:2027-agents/683e51da039598", "label round-trips");
  throws(() => plan.parseTransport("box"), /fly:<app>/, "a bare host is refused (transports are literal)");
  throws(() => plan.parseTransport("ssh:-oProxyCommand=x"), /fly:<app>/, "an ssh host can't be a flag");
}

console.log("fly machines");
{
  const one = JSON.stringify([{ id: "a1", state: "started" }]);
  const two = JSON.stringify([{ id: "a1", state: "started" }, { id: "b2", state: "stopped" }]);
  shell.checkFlyMachines({ kind: "fly", app: "x" }, () => one);
  assert(true, "one machine: ok");
  throws(() => shell.checkFlyMachines({ kind: "fly", app: "x" }, () => two), /2 machines.*fly:x\/<machine-id>/, "two machines: say which");
  shell.checkFlyMachines({ kind: "fly", app: "x", machine: "b2" }, () => two);
  assert(true, "two machines + an id: ok");
  throws(() => shell.checkFlyMachines({ kind: "fly", app: "x", machine: "zz" }, () => two), /no machine zz/, "an unknown machine id refused");
}

console.log("checklist");
{
  let s = plan.newChecklist();
  assert(plan.WHAT.every((w) => s.on[w]), "all preselected");
  s = plan.checklistKey(s, "j");
  s = plan.checklistKey(s, " ");
  assert(!s.on.repo && s.on.session, "↓ then space toggles the 2nd (repo)");
  s = plan.checklistKey(s, "\x1b[A");
  assert(s.cursor === 0, "↑ moves back");
  s = plan.checklistKey(s, "a");
  assert(plan.WHAT.every((w) => s.on[w]), "a with one off turns all on");
  s = plan.checklistKey(s, "a");
  assert(plan.WHAT.every((w) => !s.on[w]), "a again turns all off");
  assert(plan.checklistKey(s, "\r").done && plan.checklistKey(s, "q").cancelled, "enter = go, q = cancel");
  assert(plan.checklistLines(s).length === plan.WHAT.length + 1, "one line per checkmark + a header");
}

// ── fixtures: a project dir with a chain A → B → C (C is the pin), an unrelated D, sidecars ──────────
const cwd = join(home, "Github", "proj");
const slug = plan.projectSlug(cwd);
const pdir = join(home, ".claude", "projects", slug);
mkdirSync(pdir, { recursive: true });
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";
const Dd = "dddddddd-0000-0000-0000-000000000004";
const E = "eeeeeeee-0000-0000-0000-000000000005";
const line = (o: object) => JSON.stringify(o) + "\n";
writeFileSync(join(pdir, `${A}.jsonl`), line({ type: "user", sessionId: A, cwd }) + line({ type: "continued-in", sessionId: A, continuedInSessionId: B }));
// B mentions D's continued-in record only INSIDE message text: escaped, so never a link.
writeFileSync(
  join(pdir, `${B}.jsonl`),
  line({ type: "assistant", sessionId: B, message: { content: `{"type":"continued-in","sessionId":"${B}","continuedInSessionId":"${Dd}"}` } }) +
    "x".repeat(3 << 20) + "\n" + // a >1 MB stretch, so the record below crosses the scanner's chunk boundary
    line({ type: "continued-in", sessionId: B, continuedInSessionId: C }),
);
writeFileSync(join(pdir, `${C}.jsonl`), line({ type: "user", sessionId: C, cwd }));
writeFileSync(join(pdir, `${Dd}.jsonl`), line({ type: "user", sessionId: Dd, cwd }));
mkdirSync(join(pdir, C, "subagents"), { recursive: true });
writeFileSync(join(pdir, C, "subagents", "agent-1.jsonl"), line({ type: "user" }));
mkdirSync(join(pdir, A, "tool-results"), { recursive: true });
writeFileSync(join(pdir, A, "tool-results", "t1.txt"), "result");
mkdirSync(join(home, ".claude", "file-history", B), { recursive: true });
writeFileSync(join(home, ".claude", "file-history", B, "x@v1"), "backup");
mkdirSync(join(pdir, "memory"), { recursive: true });
writeFileSync(join(pdir, "memory", "MEMORY.md"), "- a memory\n");
const skillSrc = join(home, "skill-src", "echo");
mkdirSync(skillSrc, { recursive: true });
writeFileSync(join(skillSrc, "SKILL.md"), "---\nname: echo\n---\n");
mkdirSync(join(home, ".claude", "skills", ".trash"), { recursive: true });
symlinkSync(skillSrc, join(home, ".claude", "skills", "echo"));
writeFileSync(join(home, ".claude", "CLAUDE.md"), "# global\n");
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "slack@official": true, "off@x": false } }));

console.log("chain");
{
  assert(JSON.stringify(plan.sessionChain(pdir, C)) === JSON.stringify([A, B, C]), "pin C walks back to B then A, oldest first");
  assert(JSON.stringify(plan.sessionChain(pdir, A)) === JSON.stringify([A, B, C]), "pin A walks forward to B, C");
  assert(JSON.stringify(plan.sessionChain(pdir, Dd)) === JSON.stringify([Dd]), "an escaped record in message text links nothing");
  assert(JSON.stringify(plan.sessionChain(pdir, E)) === JSON.stringify([E]), "a pin with no transcript is its own chain");
  assert(plan.continuedInRecords(join(pdir, `${B}.jsonl`)).length === 1, "a record past the 1 MB chunk boundary is found once");
}

// ── a git repo with a remote (a bare repo) and one unpushed commit ──────────────────────────────────
const git = (args: string[], at: string) => execFileSync("git", args, { cwd: at, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const bare = join(home, "remote.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
mkdirSync(cwd, { recursive: true });
git(["init", "-q", "-b", "main"], cwd);
git(["remote", "add", "origin", bare], cwd);
writeFileSync(join(cwd, "a.txt"), "one\n");
git(["add", "a.txt"], cwd);
git(["commit", "-q", "-m", "one"], cwd);
git(["push", "-q", "-u", "origin", "main"], cwd);
writeFileSync(join(cwd, "b.txt"), "two\n");
git(["add", "b.txt"], cwd);
git(["commit", "-q", "-m", "two (unpushed)"], cwd);

const space = "tele-test";
const name = "proj";
setPersonaKeys(space, name, { cwd, resume: C });
writeFileSync(personaFilePath(space, name), readFileSync(personaFilePath(space, name), "utf8") + "You are proj.\n");
const personaFile = personaFilePath(space, name);

console.log("manifest");
const m = plan.buildManifest({ space, name, personaFile, what: [...plan.WHAT] });
{
  const rels = m.groups.session!.map((f) => f.rel);
  assert(JSON.stringify(m.chain) === JSON.stringify([A, B, C]), "the chain rides the manifest");
  assert(rels.includes(`.claude/projects/${slug}/${A}.jsonl`) && rels.includes(`.claude/projects/${slug}/${C}.jsonl`), "every chain transcript, HOME-relative");
  assert(!rels.some((r) => r.includes(Dd)), "an unrelated session stays");
  assert(rels.includes(`.claude/projects/${slug}/${C}/subagents/agent-1.jsonl`), "subagent transcripts");
  assert(rels.includes(`.claude/projects/${slug}/${A}/tool-results/t1.txt`), "a predecessor's tool-result sidecar");
  assert(rels.includes(`.claude/file-history/${B}/x@v1`), "file-history backups of the chain");
  assert(m.groups.memory!.map((f) => f.rel).includes(`.claude/projects/${slug}/memory/MEMORY.md`), "memory");
  assert(m.skills.map((s) => s.name).join() === "echo" && m.groups.skills![0].rel === ".claude/skills/echo/SKILL.md", "a linked skill under its own name; dot-dirs skipped");
  assert(m.groups["claude-md"]![0].rel === ".claude/CLAUDE.md" && !!m.claudeMdHash, "CLAUDE.md + its hash");
  assert(JSON.stringify(m.plugins) === JSON.stringify(["slack@official"]), "enabled plugins listed (not moved)");
  assert(m.repo?.url === bare && m.repo.branch === "main" && m.repo.unpushed === 1 && m.repo.top === realpathSync(cwd), "repo: url, branch, 1 unpushed commit");
  assert(!m.persona.includes("teleported"), "persona text without teleport keys");
  const noSession = plan.buildManifest({ space, name, personaFile, what: ["memory"] });
  assert(noSession.groups.session === undefined && noSession.repo === undefined, "unchecked groups are absent");
  assert(plan.contentHash(skillSrc) === m.skills[0].hash, "a dir hash is stable through the symlink");
}

console.log("dirty repo");
{
  writeFileSync(join(cwd, "loose.txt"), "untracked\n");
  writeFileSync(join(cwd, "a.txt"), "edited\n");
  throws(() => plan.buildManifest({ space, name, personaFile, what: ["repo"] }), /uncommitted changes[\s\S]*M a\.txt[\s\S]*\?\? loose\.txt/, "refused, listing every file");
  assert(plan.buildManifest({ space, name, personaFile, what: ["session"] }).groups.session!.length > 0, "a dirty tree doesn't block a teleport without --repo");
  git(["checkout", "-q", "a.txt"], cwd);
  rmSync(join(cwd, "loose.txt"));
  throws(() => plan.repoInfo(join(home, ".claude")), /not in a git repo/, "a folder outside git refuses --repo");
}

console.log("harness");
{
  setPersonaKeys(space, "hermy", { cwd, agent: "hermes" });
  throws(() => plan.buildManifest({ space, name: "hermy", personaFile: personaFilePath(space, "hermy"), what: [] }), /moves claude, kit and acp/, "hermes refused in v1");
  setPersonaKeys(space, "acpy", { cwd, agent: "acp", acpCommand: `'["/bin/true"]'` });
  throws(() => plan.buildManifest({ space, name: "acpy", personaFile: personaFilePath(space, "acpy"), what: ["session"] }), /without --session/, "acp: no session to move");
  assert(plan.kitProvider('---\nkitArgs: ["-m","grok/grok-4.7"]\n---\n') === "grok", "kit provider from -m provider/model");
  assert(plan.kitProvider('---\nprovider: codex\nkitArgs: ["-P","grok"]\n---\n') === "codex", "persona provider: wins");
  assert(plan.kitProvider('---\nkitArgs: ["-m","grok-4.7"]\n---\n') === undefined, "a bare model names no provider");
}

console.log("probe parse + blockers");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const probeOut = (extra: string[]) =>
  [
    "home\t/data/home",
    "pawhome\t/data/home/.paw",
    "paw\t/usr/local/bin/paw",
    "teleport\tpaw-teleport 1",
    "allowany\t",
    `record\t${b64(JSON.stringify({ space, server: "tls://h:4222", root: "/r" }))}`,
    `claude\t${b64('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}')}`,
    "git\t/usr/bin/git",
    "mount\t/data",
    "freekb\t99999999",
    "lsremote\tok",
    ...extra,
    "end\t1",
  ].join("\n");
{
  const ok = shell.parseProbe("box", probeOut([]));
  assert(ok.teleportSupport && ok.claudeLogin?.loggedIn === true && ok.spaceRecord?.server === "tls://h:4222", "parsed: protocol, login, record");
  const ctx = (dest: typeof ok) => ({ what: [...plan.WHAT], dest, transport: { kind: "fly", app: "a" } as const, back: false });
  assert(plan.teleportBlockers(m, ctx(ok)).length === 0, `a ready target has no blockers (${plan.teleportBlockers(m, ctx(ok)).join(" | ")})`);
  throws(() => shell.parseProbe("box", "home\t/x\n"), /did not finish/, "a probe cut short throws");
  const bad = shell.parseProbe(
    "box",
    probeOut([
      "pawroot\t/data/repos",
      `persona\t${b64("---\nname: proj\ncwd: /x\n---\nbody\n")}`,
      "claudemd\tdeadbeef",
      "skill\techo cafe",
      "repoexists\t1",
      "isrepo\t1",
      "repourl\thttps://elsewhere/x.git",
    ]).replace("teleport\tpaw-teleport 1", "teleport\t").replace(b64('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}'), b64('{"loggedIn": false}')).replace("mount\t/data", "mount\t/").replace("lsremote\tok", `lsremote\t${b64("fatal: could not read Username")}`),
  );
  const bl = plan.teleportBlockers(m, ctx(bad)).join("\n");
  assert(/predates `paw teleport`/.test(bl), "an old paw there");
  assert(/already has an agent "proj"/.test(bl), "a different agent of that name there");
  assert(/claude is not logged in.*claude auth login/.test(bl), "no claude login → the command to run there");
  assert(/PAW_ROOT=\/data\/repos/.test(bl), "the folder outside the target's PAW_ROOT");
  assert(/Fly resets on every deploy/.test(bl), "fly: the folder on the ephemeral root fs");
  assert(/a clone of https:\/\/elsewhere/.test(bl), "an existing clone of another remote");
  assert(/can't read .*could not read Username/.test(bl), "the target can't read the remote");
  assert(/different ~\/\.claude\/CLAUDE\.md/.test(bl), "a different CLAUDE.md is never overwritten");
  assert(/different skill "echo"/.test(bl), "a different skill is never overwritten");
  const teleportedCopy = shell.parseProbe("box", probeOut([`persona\t${b64("---\nname: proj\nteleported: origin\n---\nbody\n")}`]));
  assert(!plan.teleportBlockers(m, ctx(teleportedCopy)).some((b) => /already has an agent/.test(b)), "a teleported-away copy there may be replaced");
  const noRecord = shell.parseProbe("box", probeOut([]).replace(/^record\t.*\n/m, ""));
  assert(plan.teleportBlockers(m, ctx(noRecord)).some((b) => /does not join space "tele-test"/.test(b)), "a target not on the space");
  const noRepoFlag = { ...ctx(ok), what: ["session" as const] };
  assert(plan.teleportBlockers(m, noRepoFlag).some((b) => /doesn't exist on box — add --repo/.test(b)), "without --repo the folder must already be there");
  assert(plan.gitLoginHint("git@github.com:o/r.git").includes("ssh remote") && plan.gitLoginHint("https://github.com/o/r").includes("gh auth setup-git"), "the login hint fits the URL");
  assert(shell.claudeLoggedIn("noise\n{\"loggedIn\": true}\n") && !shell.claudeLoggedIn("error: unknown command auth"), "claude auth status read from its JSON");

  const all = plan.filesToSend(m, { skillHashes: {} });
  const same = plan.filesToSend(m, { claudeMdHash: m.claudeMdHash, skillHashes: { echo: m.skills[0].hash } });
  assert(all.length === plan.manifestFiles(m).length, "nothing there yet: every file crosses");
  assert(!same.some((f) => f.rel === ".claude/CLAUDE.md" || f.rel.startsWith(".claude/skills/echo/")) && same.length === all.length - 2, "an identical CLAUDE.md and skill there are not re-sent");
  const lines = plan.formatPlan(m, { ...ctx(ok), from: "this machine" }).join("\n");
  assert(/session    aaaaaaaa.* → bbbbbbbb.* → cccccccc.*\d+ files?, /.test(lines), "the plan shows the chain with a size");
  assert(/repo .* main @ [0-9a-f]{12} — clone into .*1 unpushed commit\(s\) as a git bundle/.test(lines), "the plan shows the repo move");
  assert(/plugins NOT moved \(v1\): slack@official/.test(lines), "the plan lists plugins it does not move");
  assert(/logins     never copied/.test(lines), "the plan says logins are not copied");
}

console.log("persona keys + wake gate");
{
  const marked = plan.withPersonaKey(plan.withPersonaKey(m.persona, "teleported", "fly:x"), "teleportedAt", "2026-10-22T00:00:00Z");
  assert(plan.stripTeleportKeys(marked) === m.persona, "strip undoes the marker exactly");
  assert(/^resume: NEW$/m.test(plan.withPersonaKey(m.persona, "resume", "NEW")) && !plan.withPersonaKey(m.persona, "resume", "NEW").includes(C), "a pin is replaced, not duplicated");
  setPersonaKeys(space, name, { teleported: "fly:2027-agents", teleportedAt: "2026-10-22T00:00:00Z", teleportedWhat: "session,repo" });
  const mark = plan.readTeleported(personaFile);
  assert(mark?.to === "fly:2027-agents" && mark.what.join() === "session,repo", "the marker reads back (where, when, what)");
  const calls: string[] = [];
  const ctl = { ps: async () => (calls.push("ps"), { ok: true, data: [] }), spawn: async () => (calls.push("spawn"), { ok: true }) } as unknown as Parameters<typeof ensureAgentSpawned>[0];
  await rejects(ensureAgentSpawned(ctl, { space, name, cwd }), /teleported to fly:2027-agents at 2026-10-22.*paw teleport proj --back/, "the wake gate refuses a teleported agent and points at --back");
  assert(calls.length === 0, "…before asking the manager anything");
  setPersonaKeys(space, name, { teleported: plan.ORIGIN, teleportedWhat: undefined });
  await rejects(ensureAgentSpawned(ctl, { space, name, cwd }), /teleported back to the machine it came from/, "a brought-back copy is refused too");
  setPersonaKeys(space, name, { teleported: undefined, teleportedAt: undefined });
  assert(plan.readTeleported(personaFile) === undefined, "no marker, no refusal");
  assert(startedLine("✓ paw start — 1 started\n  started:      proj (still starting — messages wait in its inbox)\n", "proj"), "paw start's summary: started");
  assert(!startedLine("✓ paw start — 0 started, 1 skipped\n  skipped:      proj (folder gone: /x)\n", "proj"), "paw start's summary: skipped is not started");
  assert(!startedLine("  started:      proj2\n", "proj"), "another name is not this one");
}

console.log("scripts, for real between two HOMEs");
{
  const srcHome = home;
  const dstHome = mkdtempSync(join(tmpdir(), "paw-teleport-dst-"));
  const at = (h: string) => ({ ...shell.localSide(h), spawn: (script: string) => shell.localSide(h).spawn(`HOME=${shell.sq(h)}; export HOME\n${script}`) });
  const src = at(srcHome);
  const dst = at(dstHome);
  await shell.copyFiles(src, dst, plan.manifestFiles(m));
  assert(readFileSync(join(dstHome, ".claude", "projects", slug, `${C}.jsonl`), "utf8").includes(C), "a transcript lands at the same HOME-relative path");
  assert(readFileSync(join(dstHome, ".claude", "skills", "echo", "SKILL.md"), "utf8").includes("echo"), "a linked skill lands as a real dir");
  assert(spawnSync("test", ["-L", join(dstHome, ".claude", "skills", "echo")]).status !== 0, "…not as a link");
  const facts = await shell.probe(dst, m, [...plan.WHAT]);
  assert(facts.home === dstHome && facts.claudeMdHash === m.claudeMdHash && facts.skillHashes.echo === m.skills[0].hash, "the probe's hashes match the source's after a copy");
  // repo: the target's "same absolute path" is a second location here, swapped into the script's TOP=
  const mirror = join(dstHome, "mirror");
  const viaBundle = await shell.moveRepo({ ...src, spawn: (s: string) => src.spawn(s) }, { ...dst, spawn: (s: string) => dst.spawn(s.replace(shell.sq(m.repo!.top), shell.sq(mirror))) }, m.repo!);
  assert(viaBundle === `${m.repo!.head} main`, `a fresh clone + the bundle reaches the unpushed HEAD on main (${viaBundle})`);
  assert(git(["rev-parse", "--abbrev-ref", "main@{upstream}"], mirror) === "origin/main", "…tracking origin/main");
  writeFileSync(join(mirror, "dirt.txt"), "x");
  await rejects(shell.moveRepo(src, { ...dst, spawn: (s: string) => dst.spawn(s.replace(shell.sq(m.repo!.top), shell.sq(mirror))) }, m.repo!), /uncommitted changes/, "a dirty target checkout is refused");
  rmSync(join(mirror, "dirt.txt"));
  git(["commit", "-q", "--allow-empty", "-m", "target-only"], mirror);
  await rejects(shell.moveRepo(src, { ...dst, spawn: (s: string) => dst.spawn(s.replace(shell.sq(m.repo!.top), shell.sq(mirror))) }, m.repo!), /refusing to drop them/, "a target branch ahead of the source is never moved back");
  const written = await shell.run(dst, shell.writePersonaScript(space, name), m.persona);
  assert(written.code === 0 && readFileSync(written.stdout.toString().trim(), "utf8") === m.persona, "the persona is written atomically under the target's PAW_HOME");
  rmSync(dstHome, { recursive: true, force: true });
}

console.log("remote argv");
{
  const [cmd, args] = shell.remoteArgv({ kind: "fly", app: "a", machine: "m1" }, "echo 'hi' \"$HOME\"");
  assert(cmd === "fly" && args.slice(0, 7).join(" ") === "ssh console -a a --machine m1 -C", "fly ssh console -a <app> --machine <id> -C");
  const b64part = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(args[7])?.[1];
  assert(!!b64part && Buffer.from(b64part, "base64").toString().endsWith("echo 'hi' \"$HOME\""), "the script rides base64, untouched by any quoting");
  const out = spawnSync("sh", ["-c", args[7]], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert(out.stdout.startsWith("hi "), "the wrapper evaluates the script in a plain sh");
  const [scmd, sargs] = shell.remoteArgv({ kind: "ssh", host: "me@box" }, "true");
  assert(scmd === "ssh" && sargs.slice(0, 3).join(" ") === "-o BatchMode=yes me@box", "ssh -o BatchMode=yes <host>");
}

rmSync(home, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall teleport checks passed");
