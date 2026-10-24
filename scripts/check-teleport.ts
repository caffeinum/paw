/**
 * `paw teleport` hermetic checks (src/teleport-plan.ts, src/teleport-shell.ts, the wake-gate refusal in
 * src/addressing.ts): argument and transport parsing, the checklist reducer, the continued-in chain on
 * fixture transcripts, the manifest (session sidecars, memory, skills, CLAUDE.md, repo), the dirty-repo
 * refusal, the probe parse, the blockers, the plan, the persona keys, and that a teleported persona is
 * refused by every wake path. The pack/unpack and repo scripts run for real between two temp HOMEs, and
 * the beads move for real (bd export → bd import → bd close) between two temp beads dbs.
 *
 * Isolated: HOME, PAW_HOME and PAW_BEADS_DIR are temp dirs — never the real ~/.beads. No mesh, no
 * manager, no network.
 * Run: pnpm check:teleport
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-home-")));
process.env.HOME = home;
process.env.PAW_HOME = join(home, ".paw");
process.env.PAW_ALLOW_ANY_CWD = "1";
delete process.env.PAW_ROOT;
delete process.env.KIT_HOME;

const plan = await import("../src/teleport-plan.ts");
const shell = await import("../src/teleport-shell.ts");
const { ensureAgentSpawned, personaFilePath, setPersonaKeys } = await import("../src/addressing.ts");
const { startedLine, beadsOn, importBeads, closeBeads, importedOpen } = await import("../src/teleport.ts");
const beads = await import("../src/teleport-beads.ts");

/** A fresh beads db in its own temp dir (bd init writes editor files next to .beads — never in HOME). */
function bdDb(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `paw-teleport-bd-${prefix}-`)));
  execFileSync("bd", ["init", "--non-interactive", "-p", prefix, "-q"], { cwd: dir, stdio: "ignore", env: { ...process.env, BEADS_DIR: join(dir, ".beads") } });
  return join(dir, ".beads");
}
const bd = (db: string, args: string[], actor = "aleks") =>
  execFileSync("bd", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, BEADS_DIR: db, BEADS_ACTOR: actor } }).trim();
const srcBeads = bdDb("src");
process.env.PAW_BEADS_DIR = srcBeads;
const blocker = bd(srcBeads, ["create", "blocker", "-a", "other", "--silent"]);
const mine1 = bd(srcBeads, ["create", "mine one", "-a", "proj", "-d", "body", "--silent"]);
const mine2 = bd(srcBeads, ["create", "mine two", "-a", "proj", "--silent"]);
bd(srcBeads, ["dep", "add", mine2, blocker]);
bd(srcBeads, ["dep", "add", mine1, mine2]);
bd(srcBeads, ["comment", mine1, "a comment that travels"]);
const done = bd(srcBeads, ["create", "mine done", "-a", "proj", "--silent"]);
bd(srcBeads, ["close", done, "--reason", "done"]);
bd(srcBeads, ["create", "filed for someone", "-a", "other", "--silent"], "proj");
bd(srcBeads, ["create", "filed for no one", "--silent"], "proj");

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
  const noRepo = plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--no-repo"]).what!;
  assert(noRepo.join() === "session,skills,memory,claude-md,beads", "--no-repo alone = everything but the repo");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--all", "--no-repo", "--no-skills"]).what!.join() === "session,memory,claude-md,beads", "--all --no-repo --no-skills");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--all"]).what!.includes("beads"), "--all includes beads");
  assert(!plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--no-beads"]).what!.includes("beads"), "--no-beads turns it off");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--beads"]).what!.join() === "beads", "--beads alone");
  throws(() => plan.parseTeleportArgs(["x", "--to", "ssh:b", "--repo", "--no-repo"]), /contradict/, "--repo with --no-repo refused");
  throws(() => plan.parseTeleportArgs(["x", "--to", "ssh:b", "--session", "--no-repo"]), /not both/, "checkmarks with --no-<one> refused");
  throws(() => plan.parseTeleportArgs(["x", "--back", "--no-repo"]), /no --all/, "--back refuses --no-<one>");
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
// Its remote is a GitHub URL (teleport places repos by owner/repo), served by a local bare repo through
// url.insteadOf — written to every HOME this suite runs git in.
const bare = join(home, "remote.git");
const URL = "https://github.com/e2e/proj.git";
const gitconfig = `[url "${bare}"]\n\tinsteadOf = ${URL}\n`;
writeFileSync(join(home, ".gitconfig"), gitconfig);
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
mkdirSync(cwd, { recursive: true });
git(["init", "-q", "-b", "main"], cwd);
git(["remote", "add", "origin", URL], cwd);
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
  assert(m.repo?.url === URL && m.repo.branch === "main" && m.repo.unpushed === 1 && m.repo.top === realpathSync(cwd), "repo: url, branch, 1 unpushed commit");
  assert(!m.persona.includes("teleported"), "persona text without teleport keys");
  const noSession = plan.buildManifest({ space, name, personaFile, what: ["memory"] });
  assert(noSession.groups.session === undefined && noSession.repo === undefined, "unchecked groups are absent");
  assert(plan.contentHash(skillSrc) === m.skills[0].hash, "a dir hash is stable through the symlink");
  const b = m.beads!;
  assert(b.dir === srcBeads && b.ids.length === 2 && b.ids.includes(mine1) && b.ids.includes(mine2), `beads: the 2 open ones assigned to proj (${b.ids.join()})`);
  assert(!b.ids.includes(done), "…not its closed one");
  assert(b.createdStaying === 2, `beads it created for someone else / no one stay (${b.createdStaying})`);
  assert(b.outsideDeps.length === 1 && b.outsideDeps[0] === `${mine2} -> ${blocker}`, `a dependency on a bead that stays is listed, one inside the move is not (${b.outsideDeps.join()})`);
  assert(b.lines.some((l) => l.includes("a comment that travels")), "the export lines carry the comments");
  assert(noSession.beads === undefined, "no --beads, no bd call");
}

console.log("dirty repo");
{
  writeFileSync(join(cwd, "loose.txt"), "untracked\n");
  writeFileSync(join(cwd, "a.txt"), "edited\n");
  throws(() => plan.buildManifest({ space, name, personaFile, what: ["repo"] }), /2 uncommitted change\(s\)[\s\S]*M a\.txt[\s\S]*\?\? loose\.txt[\s\S]*--no-repo/, "refused, listing the files and the way out (--no-repo)");
  for (let i = 0; i < 40; i++) writeFileSync(join(cwd, `junk-${i}.txt`), "x");
  try {
    plan.buildManifest({ space, name, personaFile, what: ["repo"] });
  } catch (e) {
    const msg = (e as Error).message;
    const listed = msg.split("\n").filter((l) => /^  (\?\?| M) /.test(l)).length;
    assert(listed === plan.DIRTY_SHOWN && /… and 32 more/.test(msg) && /42 uncommitted/.test(msg), `a big dirty tree lists ${plan.DIRTY_SHOWN} paths, then "… and N more" (listed ${listed})`);
  }
  for (let i = 0; i < 40; i++) rmSync(join(cwd, `junk-${i}.txt`));
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
    "teleport\tpaw-teleport 2",
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
  const emptyBeads = "dir\t/data/home/.beads\nbd\t/usr/bin/bd\nallowstale\t1\nend\t1\n--export--\n";
  ok.beads = beads.parseBeadsSide("box", emptyBeads);
  assert(ok.teleportSupport && ok.claudeLogin?.loggedIn === true && ok.spaceRecord?.server === "tls://h:4222", "parsed: protocol, login, record");
  const fullFolder = plan.destFolder(m, [...plan.WHAT], { home: "/data/home", pawHome: "/data/home/.paw" });
  assert(
    fullFolder.how === "repo" && fullFolder.clone === "/data/home/.paw/repos/e2e/proj" && fullFolder.cwd === fullFolder.clone && fullFolder.worktree === "/data/home/.paw/repos/e2e/proj.worktrees/proj-main",
    `--repo: the target's paw clone <PAW_HOME>/repos/<owner>/<repo>, never the source path (${JSON.stringify(fullFolder)})`,
  );
  const ctx = (dest: typeof ok) => ({ what: [...plan.WHAT], dest, folder: fullFolder, transport: { kind: "fly", app: "a" } as const, back: false });
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
    ]).replace("teleport\tpaw-teleport 2", "teleport\tpaw-teleport 1").replace(b64('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}'), b64('{"loggedIn": false}')).replace("mount\t/data", "mount\t/").replace("lsremote\tok", `lsremote\t${b64("fatal: could not read Username")}`),
  );
  const bl = plan.teleportBlockers(m, ctx(bad)).join("\n");
  assert(/predates this `paw teleport` \(paw-teleport 2\)/.test(bl), "a v1 paw there (no agents folder / rewrite-cwd)");
  assert(/already has an agent "proj"/.test(bl), "a different agent of that name there");
  assert(/claude is not logged in.*claude auth login/.test(bl), "no claude login → the command to run there");
  assert(plan.teleportBlockers(m, { ...ctx(bad), folder: { cwd: "/Users/x/proj", how: "original" }, back: true }).some((b) => /PAW_ROOT=\/data\/repos/.test(b)), "--back to a folder outside PAW_ROOT blocks");
  assert(/Fly resets on every deploy/.test(bl), "fly: the folder on the ephemeral root fs");
  assert(plan.placeRepo(m, [...plan.WHAT], fullFolder, bad).blockers.some((b) => /a clone of https:\/\/elsewhere/.test(b)), "an existing clone of another remote");
  assert(/can't read .*could not read Username/.test(bl), "the target can't read the remote");
  assert(/different ~\/\.claude\/CLAUDE\.md/.test(bl), "a different CLAUDE.md is never overwritten");
  assert(/different skill "echo"/.test(bl), "a different skill is never overwritten");
  const teleportedCopy = shell.parseProbe("box", probeOut([`persona\t${b64("---\nname: proj\nteleported: origin\n---\nbody\n")}`]));
  assert(!plan.teleportBlockers(m, ctx(teleportedCopy)).some((b) => /already has an agent/.test(b)), "a teleported-away copy there may be replaced");
  const noRecord = shell.parseProbe("box", probeOut([]).replace(/^record\t.*\n/m, ""));
  assert(plan.teleportBlockers(m, ctx(noRecord)).some((b) => /does not join space "tele-test"/.test(b)), "a target not on the space");
  const agents = plan.destFolder(m, ["session"], { home: "/data/home", pawHome: "/data/home/.paw" });
  assert(agents.how === "agents" && agents.cwd === "/data/home/.paw/agents/proj" && agents.top === undefined, "without --repo: <dest PAW_HOME>/agents/<name>");
  const confined = shell.parseProbe("box", probeOut(["pawroot\t/data/repos"]));
  assert(plan.teleportBlockers(m, { ...ctx(confined), what: ["session"], folder: agents }).length === 0, "the agents folder is paw-managed: no PAW_ROOT blocker, and it need not exist yet");
  assert(!plan.teleportBlockers(m, { ...ctx(confined), folder: fullFolder }).some((b) => /PAW_ROOT/.test(b)), "the paw clone is paw-managed too: no PAW_ROOT blocker");
  const back = plan.destFolder(m, ["session"], { home, pawHome: join(home, ".paw") }, cwd);
  assert(back.how === "original" && back.cwd === cwd, "--back: the folder it left from");
  assert(plan.teleportBlockers(m, { ...ctx(ok), what: ["session"], folder: back, back: true }).some((b) => /the folder it left from, is gone/.test(b)), "--back to a folder that is gone blocks");
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
  assert(
    lines.includes("  beads      2 open, assigned to proj → box's /data/home/.beads · 2 it created (assigned elsewhere) stay here"),
    `the plan's beads line: count, where, what stays (${lines.split("\n").find((l) => l.includes("beads  "))})`,
  );
  assert(lines.includes(`closed here after the cutover, reason "teleported to fly:a"`), "…the ownership marker it will leave here");
  assert(lines.includes(`1 dependency link(s) to beads that stay here are not carried: ${mine2} -> ${blocker}`), "…and the links bd drops");
  const noBeads = plan.formatPlan(m, { ...ctx(ok), what: ["session"], from: "this machine" }).join("\n");
  assert(/  beads      — not moved/.test(noBeads), "--no-beads: the plan says so");

  const bx = (rows: object[], extra = "allowstale\t1\n") =>
    beads.parseBeadsSide("box", `dir\t/b\nbd\t/usr/bin/bd\n${extra}end\t1\n--export--\n${rows.map((r) => JSON.stringify({ _type: "issue", ...r })).join("\n")}\n`);
  const bb = (d: ReturnType<typeof bx> | undefined) => beads.beadsBlockers(m.beads!, d, "box").join("\n");
  assert(/no `bd` on PATH/.test(bb(beads.parseBeadsSide("box", "dir\t/b\nend\t1\n"))), "no bd there blocks");
  assert(/not readable: Error: no beads database found.*bd init/.test(bb(beads.parseBeadsSide("box", "dir\t/b\nbd\t/x/bd\nerr\tError: no beads database found \nend\t1\n"))), "an unreachable db there blocks, with the fix");
  assert(/1 bead id\(s\) already exist .*not teleported copies: .*overwrite/.test(bb(bx([{ id: mine1, title: "x", status: "open" }]))), "an id already there (live) is a collision — refused, never overwritten");
  assert(/already exist/.test(bb(bx([{ id: mine1, title: "x", status: "closed", close_reason: "done" }]))), "…a closed one that is not a teleported copy too");
  const copy = bx([{ id: mine1, title: "x", status: "closed", close_reason: "teleported to origin" }]);
  assert(bb(copy) === "", "its own earlier teleported copy may be reopened");
  assert(beads.staleIds(m.beads!, copy).join() === mine1, "…via --allow-stale");
  assert(/--allow-stale/.test(bb(bx([{ id: mine1, title: "x", status: "closed", close_reason: "teleported to ssh:mini" }], ""))), "a bd there without --allow-stale can't reopen it: blocks");
  assert(/was not probed/.test(bb(undefined)), "an unprobed target blocks (never assumed fine)");
  assert(plan.teleportBlockers({ ...m, beads: undefined }, ctx(ok)).some((x) => /predates teleporting beads/.test(x)), "a source paw that read no beads (old --back target) blocks");
  throws(() => beads.parseBeadsSide("box", "dir\t/b\n"), /did not finish/, "a beads probe cut short throws");
  throws(() => beads.parseBeadsSide("box", "dir\t/b\nend\t1\n--export--\nnot json\n"), /not JSON/, "a garbled export line throws");
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
  const dstHome = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-dst-")));
  const at = (h: string) => ({ ...shell.localSide(h), spawn: (script: string) => shell.localSide(h).spawn(`HOME=${shell.sq(h)}; export HOME; unset PAW_HOME\n${script}`) });
  const src = at(srcHome);
  const dst = at(dstHome);
  await shell.copyFiles(src, dst, plan.manifestFiles(m).map((f) => ({ src: f.rel, dst: f.rel })));
  assert(readFileSync(join(dstHome, ".claude", "projects", slug, `${C}.jsonl`), "utf8").includes(C), "a transcript lands at the same HOME-relative path");
  assert(readFileSync(join(dstHome, ".claude", "skills", "echo", "SKILL.md"), "utf8").includes("echo"), "a linked skill lands as a real dir");
  assert(spawnSync("test", ["-L", join(dstHome, ".claude", "skills", "echo")]).status !== 0, "…not as a link");
  const facts = await shell.probe(dst, m, [...plan.WHAT], plan.destFolder(m, [...plan.WHAT], await shell.probeEnv(dst)));
  assert(facts.home === dstHome && facts.claudeMdHash === m.claudeMdHash && facts.skillHashes.echo === m.skills[0].hash, "the probe's hashes match the source's after a copy");
  // repo: placed in the target's paw clone, then a worktree for another branch
  writeFileSync(join(dstHome, ".gitconfig"), gitconfig);
  const dstEnv = await shell.probeEnv(dst);
  const look = async (man: typeof m) => {
    const f0 = plan.destFolder(man, ["repo"], dstEnv);
    const placed = plan.placeRepo(man, ["repo"], f0, await shell.probe(dst, man, ["repo"], f0));
    return placed;
  };
  const fresh = await look(m);
  assert(fresh.folder.how === "repo" && fresh.blockers.length === 0, "nothing there yet: clone into the paw clone");
  const clone = fresh.folder.clone!;
  const viaBundle = await shell.moveRepo(src, dst, m.repo!, fresh.folder);
  assert(viaBundle === `${m.repo!.head} main` && clone === join(dstEnv.pawHome, "repos", "e2e", "proj"), `a fresh clone + the bundle reaches the unpushed HEAD on main (${viaBundle})`);
  assert(git(["rev-parse", "--abbrev-ref", "main@{upstream}"], clone) === "origin/main", "…tracking origin/main");
  const again = await look(m);
  assert(again.folder.how === "repo" && again.blockers.length === 0, `the clone on the same branch is reused (${again.blockers.join(" | ")})`);
  writeFileSync(join(clone, "dirt.txt"), "x");
  assert((await look(m)).blockers.some((b) => /uncommitted changes[\s\S]*dirt\.txt/.test(b)), "a dirty clone there blocks");
  await rejects(shell.moveRepo(src, dst, m.repo!, fresh.folder), /uncommitted changes/, "…and the apply script refuses it too");
  rmSync(join(clone, "dirt.txt"));
  git(["commit", "-q", "--allow-empty", "-m", "target-only"], clone);
  await rejects(shell.moveRepo(src, dst, m.repo!, fresh.folder), /refusing to drop them/, "a target branch ahead of the source is never moved back");
  git(["reset", "-q", "--hard", "HEAD~1"], clone);
  // another agent works in the clone, which is behind the source: moving it would change its files
  mkdirSync(join(dstEnv.pawHome, "spaces", "other", "personas"), { recursive: true });
  writeFileSync(join(dstEnv.pawHome, "spaces", "other", "personas", "neighbour.md"), `---\nname: neighbour\ncwd: ${clone}\n---\n`);
  git(["reset", "-q", "--hard", "HEAD~1"], clone);
  assert((await look(m)).blockers.some((b) => /other\/neighbour runs in .*would change their files/.test(b)), "another agent in a clone that would move blocks");
  git(["merge", "-q", "--ff-only", m.repo!.head], clone);
  assert((await look(m)).blockers.length === 0, "…but not when its checkout is already the source HEAD (nothing moves)");
  // the agent on another branch: a worktree beside the clone, the clone (and its neighbour) untouched
  git(["checkout", "-q", "-b", "feature/x"], cwd);
  git(["commit", "-q", "--allow-empty", "-m", "feature work"], cwd);
  const mf = plan.buildManifest({ space, name, personaFile, what: ["repo"] });
  const wt = await look(mf);
  assert(wt.folder.how === "worktree" && wt.folder.top === `${clone}.worktrees/proj-feature-x` && wt.blockers.length === 0, `a clone on another branch: a worktree (${wt.folder.top} ${wt.blockers.join(" | ")})`);
  const wtLine = await shell.moveRepo(src, dst, mf.repo!, wt.folder);
  assert(wtLine === `${mf.repo!.head} feature/x` && git(["symbolic-ref", "--short", "HEAD"], clone) === "main", `the worktree is on feature/x, the clone still on main (${wtLine})`);
  const wtAgain = await look(mf);
  assert(wtAgain.folder.how === "worktree" && wtAgain.blockers.length === 0, "the worktree is reused next time");
  git(["worktree", "add", "-q", join(dstHome, "third"), "-b", "held"], clone);
  git(["checkout", "-q", "-b", "held"], cwd);
  const held = await look(plan.buildManifest({ space, name, personaFile, what: ["repo"] }));
  assert(held.blockers.some((b) => /branch held is checked out at .*third/.test(b)), "a branch checked out in a third worktree blocks");
  git(["checkout", "-q", "main"], cwd);
  throws(() => plan.destFolder({ ...m, repo: { ...m.repo!, url: "git@gitlab.com:o/r.git" } }, ["repo"], dstEnv), /not a GitHub remote.*--no-repo/, "a non-GitHub remote fails loud (no invented path)");
  assert(plan.githubRepoOf("git@github.com:caffeinum/paw.git").repo === "paw" && plan.githubRepoOf("https://github.com/caffeinum/paw").owner === "caffeinum", "owner/repo from git@ and https remotes");
  // beads: export → import → verify → close, then --back the same way round
  const dstBeads = bdDb("dst");
  const withDb = (side: typeof src, db: string) => ({ ...side, spawn: (script: string) => side.spawn(`PAW_BEADS_DIR=${shell.sq(db)}; export PAW_BEADS_DIR\n${script}`) });
  const bsrc = withDb(src, srcBeads);
  const bdst = withDb(dst, dstBeads);
  const bm = beads.beadsManifest(await beadsOn(bsrc), name);
  const rowsOf = async (side: typeof src) => new Map((await beadsOn(side)).rows.map((r) => [r.id, r]));
  const brokenDst = withDb(dst, join(dstHome, "no-such-db", ".beads"));
  await rejects(importBeads(brokenDst, bm, name, await beadsOn(bdst)), /bd import.* failed|did not verify/, "an import that fails rejects");
  const untouched = await rowsOf(bsrc);
  assert(bm.ids.every((id) => untouched.get(id)?.status === "open"), "…and the source copies stay open (nothing closed before a verified import)");
  const before = await beadsOn(bdst);
  assert(beads.beadsBlockers(bm, before, "dst").length === 0, "an empty db there: no blockers");
  const summary = await importBeads(bdst, bm, name, before);
  const there = await rowsOf(bdst);
  assert(/^2 imported, 1 dependency link\(s\) dropped$/.test(summary), `the import summary (${summary})`);
  assert(bm.ids.every((id) => there.get(id)?.status === "open" && there.get(id)?.assignee === name), "the beads are there, same ids, open, assigned");
  assert(there.get(mine1)?.dependencies?.some((d) => d.depends_on_id === mine2) === true, "a dependency inside the move survives");
  assert((JSON.parse(bd(dstBeads, ["show", mine1, "--json"])) as Array<{ description?: string }>)[0].description === "body" && bd(dstBeads, ["comments", mine1]).includes("a comment that travels"), "description and comments survive");
  const partialDb = bdDb("partial");
  const partial = await importedOpen(withDb(dst, partialDb), bm);
  rmSync(join(partialDb, ".."), { recursive: true, force: true });
  assert(partial.ids.length === 0, "a rollback after an import that landed nothing closes nothing there");
  assert((await importedOpen(bdst, bm)).ids.length === 2, "…after a full import it closes every imported bead");
  const stillOpen = await rowsOf(bsrc);
  assert(bm.ids.every((id) => stillOpen.get(id)?.status === "open"), "the import alone closes nothing here (the close waits for the cutover)");
  assert(beads.beadsBlockers(bm, await beadsOn(bdst), "dst").some((x) => /already exist/.test(x)), "a second teleport onto the live copies is a collision");
  bd(srcBeads, ["comment", mine2, "late note here"]);
  const closed = await closeBeads(bsrc, bm, beads.teleportedReason("ssh:mini"));
  const after = await rowsOf(bsrc);
  assert(bm.ids.every((id) => after.get(id)?.status === "closed" && after.get(id)?.close_reason === "teleported to ssh:mini"), "the source copies are closed with reason \"teleported to ssh:mini\" (kept, not deleted)");
  assert(closed.changed.join() === mine2, `a bead changed here after the export is reported (${closed.changed.join()})`);
  assert(after.get(blocker)?.status === "open", "a bead that stayed is untouched");
  // --back: the target's open copies come home and reopen the closed ones
  bd(dstBeads, ["comment", mine1, "written on the target"], name);
  const back = beads.beadsManifest(await beadsOn(bdst), name);
  const home0 = await beadsOn(bsrc);
  assert(beads.beadsBlockers(back, home0, "here").length === 0 && beads.staleIds(back, home0).length === 2, "--back: its teleported copies here are no collision; they reopen");
  await importBeads(bsrc, back, name, home0);
  const reopened = await rowsOf(bsrc);
  assert(back.ids.every((id) => reopened.get(id)?.status === "open"), "--back: open here again");
  assert(bd(srcBeads, ["comments", mine1]).includes("written on the target"), "--back: what was written there comes along");
  await closeBeads(bdst, back, beads.teleportedReason(plan.ORIGIN));
  const left = await rowsOf(bdst);
  assert(back.ids.every((id) => left.get(id)?.status === "closed" && left.get(id)?.close_reason === "teleported to origin"), "--back: the target's copies close as \"teleported to origin\"");
  rmSync(join(dstBeads, ".."), { recursive: true, force: true });

  const written = await shell.run(dst, shell.writePersonaScript(space, name), m.persona);
  assert(written.code === 0 && readFileSync(written.stdout.toString().trim(), "utf8") === m.persona, "the persona is written atomically under the target's PAW_HOME");
  rmSync(dstHome, { recursive: true, force: true });
}

console.log("the folder moves (no --repo, other HOMEs)");
{
  const sub = { ...m, repo: { ...m.repo!, sub: "pkg/web" }, cwd: join(m.repo!.top, "pkg/web") };
  const subF = plan.destFolder(sub, ["repo"], { home: "/data/home", pawHome: "/data/home/.paw" });
  assert(subF.cwd === "/data/home/.paw/repos/e2e/proj/pkg/web", "a folder inside the repo keeps its place in the clone");
  assert(plan.destFolder(sub, ["repo"], { home: "/x", pawHome: "/x/.paw" }, "/Users/a/proj/pkg/web").top === "/Users/a/proj", "--back: the original top, from the folder it left");
  const to = "/home/u/.paw/agents/proj";
  const toSlug = plan.projectSlug(to);
  assert(plan.remapRel(`.claude/projects/${slug}/${C}.jsonl`, m, to) === `.claude/projects/${toSlug}/${C}.jsonl`, "a transcript follows the folder into its project dir");
  assert(plan.remapRel(`.claude/projects/${slug}/${A}/tool-results/t1.txt`, m, to) === `.claude/projects/${toSlug}/${A}/tool-results/t1.txt`, "…sidecars too");
  assert(plan.remapRel(`.claude/projects/${slug}/memory/MEMORY.md`, m, to) === `.claude/projects/${toSlug}/memory/MEMORY.md`, "memory goes to the new project's memory");
  assert(plan.remapRel(".claude/skills/echo/SKILL.md", m, to) === ".claude/skills/echo/SKILL.md" && plan.remapRel(`.claude/file-history/${B}/x@v1`, m, to) === `.claude/file-history/${B}/x@v1`, "skills and file-history keep their paths");
  assert(plan.remapRel(`.kit/sessions/${slug}/k.jsonl`, { projectDirs: [`.kit/sessions/${slug}`] }, to) === `.kit/sessions/${toSlug}/k.jsonl`, "kit's store follows too");

  const from = "/Users/aleks/Github/team2027";
  const line = (o: object) => JSON.stringify(o);
  const src = [
    line({ type: "user", cwd: from, sessionId: "s", message: { content: `cd ${from} && ls; "cwd":"${from}"` } }),
    line({ type: "assistant", cwd: `${from}/evals`, sessionId: "s" }),
    line({ type: "user", cwd: "/elsewhere", sessionId: "s" }),
    line({ type: "user", cwd: `${from}-other`, sessionId: "s" }),
    line({ type: "user", cwd: 'C:\\odd "quoted"', sessionId: "s" }),
  ].join("\n") + "\n";
  const r = plan.rewriteCwdText(src, from, to);
  const rows = r.text.trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; message?: { content: string } });
  assert(r.changed === 2 && rows[0].cwd === to && rows[1].cwd === `${to}/evals`, "cwd = the folder or under it is rewritten");
  assert(rows[2].cwd === "/elsewhere" && rows[3].cwd === `${from}-other` && rows[4].cwd === 'C:\\odd "quoted"', "other cwds (a sibling prefix, an escaped value) untouched");
  assert(rows[0].message!.content.includes(`cd ${from}`) && rows[0].message!.content.includes(`"cwd":"${from}"`), "only the field: message text keeps the old path (escaped quotes never match)");
  assert(r.text.split("\n").length === src.split("\n").length && plan.rewriteCwdText(r.text, from, to).changed === 0, "line count kept; a second pass changes nothing");
  assert(plan.rewriteCwdText(line({ cwd: `${from}/x` }), from, `${from}/x`).changed === 0, "a target under the source is not rewritten twice");

  // a real move between two HOMEs: copy with the remap, then rewrite there
  const dstHome = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-dst2-")));
  const at = (h: string) => ({ ...shell.localSide(h), spawn: (script: string) => shell.localSide(h).spawn(`HOME=${shell.sq(h)}; export HOME; unset PAW_HOME\n${script}`) });
  const folder = plan.destFolder(m, ["session", "memory"], await shell.probeEnv(at(dstHome)));
  assert(folder.cwd === join(dstHome, ".paw", "agents", "proj"), `probeEnv + destFolder: ${folder.cwd}`);
  const mv = plan.buildManifest({ space, name, personaFile, what: ["session", "memory"] });
  const files = plan.manifestFiles(mv);
  await shell.copyFiles(at(home), at(dstHome), files.map((f) => ({ src: f.rel, dst: plan.remapRel(f.rel, mv, folder.cwd) })));
  const newDir = join(dstHome, ".claude", "projects", plan.projectSlug(folder.cwd));
  assert(existsSync(join(newDir, `${C}.jsonl`)) && existsSync(join(newDir, A, "tool-results", "t1.txt")) && existsSync(join(newDir, "memory", "MEMORY.md")), "transcripts, sidecars and memory land in the NEW folder's project dir");
  assert(!existsSync(join(dstHome, ".claude", "projects", slug)), "nothing lands under the old slug");
  const rels = plan.transcriptRels(files, mv).map((r2) => plan.remapRel(r2, mv, folder.cwd));
  assert(rels.length === 4 && rels.every((r2) => r2.endsWith(".jsonl")), `the transcripts to rewrite: the chain + a subagent (${rels.length})`);
  const changed = plan.rewriteCwdFiles(dstHome, rels, mv.cwd, folder.cwd);
  const cwds = readFileSync(join(newDir, `${C}.jsonl`), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { cwd?: string }).cwd);
  assert(changed === 2 && cwds[0] === folder.cwd, `cwd fields now name the new folder (${changed} changed)`);
  const w = await shell.run(at(dstHome), shell.writePersonaScript(space, name, folder.cwd), plan.withPersonaKey(mv.persona, "cwd", folder.cwd));
  assert(w.code === 0 && existsSync(folder.cwd) && /^cwd: .*\.paw\/agents\/proj$/m.test(readFileSync(w.stdout.toString().trim(), "utf8")), "the agents folder is created and the persona points at it");

  const env = await shell.probeEnv(at(dstHome));
  const lines = plan.formatPlan(mv, { what: ["session", "memory"], dest: { ...shell.parseProbe("x", probeOut([])), home: env.home, pawHome: env.pawHome }, folder, back: false, from: "this machine" }).join("\n");
  assert(lines.includes(`folder     ${cwd} → ${folder.cwd}  (no --repo: a fresh folder paw owns there — nothing in ${cwd} moves)`), "the plan names the folder move");
  assert(lines.includes(`→ ${dstHome}/.claude/projects/${plan.projectSlug(folder.cwd)}/, cwd fields rewritten`) && lines.includes(`memory/`), "…and where the session and memory land");
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
rmSync(join(srcBeads, ".."), { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall teleport checks passed");
