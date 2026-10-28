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
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { startedLine, beadsOn, importBeads, closeBeads, importedOpen, meshBlockersOf } = await import("../src/teleport.ts");
const { runsElsewhere } = await import("../src/hosted.ts");
const { openAgentLog } = await import("../src/log.ts");
const { attachResolved } = await import("../src/open.ts");
const { collectStatus, formatStatus } = await import("../src/status.ts");
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
async function rejects(p: Promise<unknown>, re: RegExp, msg: string): Promise<string> {
  try {
    await p;
    assert(false, `${msg} (did not reject)`);
    return "";
  } catch (e) {
    assert(re.test((e as Error).message), `${msg} — ${(e as Error).message.split("\n")[0]}`);
    return (e as Error).message;
  }
}

console.log("args");
{
  const a = plan.parseTeleportArgs(["evals", "--to", "fly:2027-agents", "--session", "--repo", "--dry-run"]);
  assert(a.name === "evals" && a.to?.kind === "fly" && a.dryRun && !a.yes, "name, --to fly, --dry-run");
  assert(JSON.stringify(a.what) === JSON.stringify(["session", "repo"]), "checkmarks in canonical order");
  assert(plan.parseTeleportArgs(["x", "--to=ssh:me@box", "--all", "-y"]).what?.join() === "session,repo,folder,skills,memory,claude-md,beads", "--all = every checkmark but the opt-in env, --to=, -y");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:b", "--all", "--env"]).what!.includes("env"), "--all --env: env is opt-in only");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:b", "--no-repo", "--env"]).what!.join() === "session,folder,skills,memory,claude-md,beads,env", "--no-repo --env");
  const f = plan.parseTeleportArgs(["x", "--to", "ssh:b", "--all", "--force"]);
  assert(f.force && !plan.parseTeleportArgs(["x", "--to", "ssh:b", "--all"]).force, "--force parsed (off by default)");
  throws(() => plan.parseTeleportArgs(["x", "--back", "--force"]), /takes no --force/, "--back refuses --force");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:box"]).what === undefined, "no checkmark = ask");
  const back = plan.parseTeleportArgs(["x", "--back", "--yes"]);
  assert(back.back && back.to === undefined && back.yes, "--back");
  throws(() => plan.parseTeleportArgs(["x", "--back", "--to", "ssh:b"]), /recorded at teleport time/, "--back refuses --to");
  throws(() => plan.parseTeleportArgs(["x", "--back", "--session"]), /no --all/, "--back refuses checkmarks");
  throws(() => plan.parseTeleportArgs(["x", "--all", "--repo", "--to", "ssh:b"]), /not both/, "--all with a checkmark refused");
  throws(() => plan.parseTeleportArgs(["x"]), /where to/, "no --to refused");
  const noRepo = plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--no-repo"]).what!;
  assert(noRepo.join() === "session,folder,skills,memory,claude-md,beads", "--no-repo alone = everything but the repo");
  assert(plan.parseTeleportArgs(["x", "--to", "ssh:mini", "--all", "--no-repo", "--no-skills"]).what!.join() === "session,folder,memory,claude-md,beads", "--all --no-repo --no-skills");
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
  assert(plan.WHAT.every((w) => s.on[w] === (w !== "env")), "all preselected but the opt-in env");
  s = plan.checklistKey(s, "j");
  s = plan.checklistKey(s, " ");
  s = { ...s, on: { ...s.on, env: true } };
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
// claude.ai's skill sync state: machine-local, never a skill teleport moves or compares
mkdirSync(join(home, ".claude", "skills", "synced", "org_acct", "pdf"), { recursive: true });
writeFileSync(join(home, ".claude", "skills", "synced", "org_acct", "manifest.json"), "{}");
writeFileSync(join(home, ".claude", "skills", "synced", ".bucket-org_acct"), "");
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
    "membase\t/data/home/.paw/repos/e2e/proj",
    "memslug\t-data-home--paw-repos-e2e-proj",
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
  const withDeps = shell.parseProbe("box", probeOut(["depsprobed\t1", `settings\t${b64(JSON.stringify({ enabledPlugins: { "artil@x": true } }))}`]));
  const depLines = plan.formatPlan(m, { ...ctx(withDeps), from: "this machine" }).join("\n");
  assert(/needs on box: .*plugin slack@official \(missing\)/.test(depLines) && !/plugins NOT moved/.test(depLines), "a plugin enabled here and missing there is a warning in the plan");
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
  assert(mark?.cwd === undefined, "an older marker has no folder there — none is invented");
  setPersonaKeys(space, name, { teleportedCwd: "/data/home/.paw/repos/o/proj" });
  assert(plan.readTeleported(personaFile)?.cwd === "/data/home/.paw/repos/o/proj", "teleportedCwd reads back as the folder it runs in there");
  assert(!/teleportedCwd/.test(plan.stripTeleportKeys(readFileSync(personaFile, "utf8"))), "teleportedCwd never travels with the persona");

  console.log("a teleported agent, seen from here");
  const away = runsElsewhere(space, name);
  assert(away?.how === "teleported" && away.where === "fly:2027-agents" && away.cwd === "/data/home/.paw/repos/o/proj", "runsElsewhere: where + the folder there");
  throws(() => openAgentLog(space, name, cwd), /no logs for "proj" here — logs live on fly:2027-agents, where it runs — the transcript on this machine stopped when it left/, "paw log / web trace / chat logs refuse the frozen transcript");
  await rejects(attachResolved(space, name, { folder: cwd }), /"proj" runs on fly:2027-agents — attach to it there; from here `paw chat @proj` messages it/, "attach refuses, pointing at chat");
  const now = Date.now();
  const { rows } = await collectStatus(space, undefined, { git: false, ps: new Map(), roster: () => [{ card: { id: "peer-proj", name }, status: "working", ts: now } as never] });
  const row = rows.find((r) => r.name === name)!;
  assert(!!row?.elsewhere && row.live && row.mesh === "working" && !row.unmanaged, "status: live from the roster, never 'unmanaged — paw restart re-adopts it'");
  assert(row?.context === undefined && row.failure === undefined && row.activeMs === undefined && row.inbox.kind === "none", "status: no ctx / failure / last-active / inbox read from this machine");
  assert(row?.busy === true, "status: busy only from the agent's own `working` claim");
  assert(/runs on fly:2027-agents · \/data\/home\/\.paw\/repos\/o\/proj — ctx, logs and folder are there/.test(formatStatus(rows, now, 400)), "status note says where it runs");
  setPersonaKeys(space, name, { teleportedCwd: undefined });
  const calls: string[] = [];
  const ctl = { ps: async () => (calls.push("ps"), { ok: true, data: [] }), spawn: async () => (calls.push("spawn"), { ok: true }) } as unknown as Parameters<typeof ensureAgentSpawned>[0];
  const refusal = await rejects(ensureAgentSpawned(ctl, { space, name, cwd }), /teleported to fly:2027-agents at 2026-10-22.*paw teleport proj --back/, "the wake gate refuses a teleported agent and points at --back");
  assert(refusal.includes(`(start it there: \`fly ssh console -a 2027-agents -C "sh -lc 'paw start proj --space ${space}'"\`)`), `…and prints the exact command that starts it there (${refusal.slice(refusal.indexOf("(start"))})`);
  assert(plan.startThereCommand("proj", "team2027", "ssh:mini") === "ssh mini paw start proj --space team2027", "ssh: target → `ssh <host> paw start <name> --space <space>`");
  assert(plan.startThereCommand("proj", "paw", "fly:app/abc123") === `fly ssh console -a app --machine abc123 -C "sh -lc 'paw start proj --space paw'"`, "fly:<app>/<machine> keeps the machine");
  assert(plan.startThereCommand("proj", "paw", plan.ORIGIN) === undefined, "origin names no transport → no command (text kept)");
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
  const moved0 = await shell.moveRepo(src, dst, m.repo!, fresh.folder);
  const viaBundle = moved0.line;
  assert(viaBundle === `${m.repo!.head} main` && clone === join(dstEnv.pawHome, "repos", "e2e", "proj"), `a fresh clone + the bundle reaches the unpushed HEAD on main (${viaBundle})`);
  assert(git(["rev-parse", "--abbrev-ref", "main@{upstream}"], clone) === "origin/main", "…tracking origin/main");
  const again = await look(m);
  assert(again.folder.how === "repo" && again.blockers.length === 0, `the clone on the same branch is reused (${again.blockers.join(" | ")})`);
  writeFileSync(join(clone, "dirt.txt"), "x");
  assert((await look(m)).blockers.some((b) => /uncommitted changes[\s\S]*dirt\.txt/.test(b)), "a dirty clone there blocks");
  await rejects(shell.moveRepo(src, dst, m.repo!, fresh.folder), /uncommitted changes/, "…and the apply script refuses it too");
  rmSync(join(clone, "dirt.txt"));
  git(["commit", "-q", "--allow-empty", "-m", "target-only"], clone);
  await rejects(shell.moveRepo(src, dst, m.repo!, fresh.folder), /source HEAD [0-9a-f]+ is BEHIND branch main there .*merge --ff-only origin\/main/, "a target branch ahead of a stale source: never moved back, and named as a stale source with the fix");
  const fork = git(["commit-tree", "-p", git(["rev-parse", "HEAD~2"], clone), "-m", "diverged", `${git(["rev-parse", "HEAD"], clone)}^{tree}`], clone);
  git(["reset", "-q", "--hard", fork], clone);
  await rejects(shell.moveRepo(src, dst, m.repo!, fresh.folder), /has commits the source HEAD [0-9a-f]+ lacks — refusing to drop them/, "a diverged target branch is never moved back");
  assert(existsSync(clone), "…and a failed mirror into a clone that was there before leaves it in place");
  git(["reset", "-q", "--hard", m.repo!.head], clone);
  git(["commit", "-q", "--allow-empty", "-m", "target-only again"], clone);
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
  const wtMoved = await shell.moveRepo(src, dst, mf.repo!, wt.folder);
  const wtLine = wtMoved.line;
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
  assert(plan.remapRel(`.claude/projects/${slug}/memory/MEMORY.md`, m, to, "-dest-key") === ".claude/projects/-dest-key/memory/MEMORY.md", "memory goes to the dir the destination keys its memory by");
  throws(() => plan.remapRel(`.claude/projects/${slug}/memory/MEMORY.md`, m, to), /memory probe did not run/, "…and never to a guessed one");
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
  const dmem = shell.parseProbe("x", (await shell.run(at(dstHome), shell.probeScript(mv, ["session", "memory"], folder))).stdout.toString()).memory!;
  assert(dmem.base === folder.cwd && dmem.slug === plan.projectSlug(folder.cwd) && Object.keys(dmem.files).length === 0, `the probe keys the agents folder's memory by the folder itself (${dmem.base})`);
  await shell.copyFiles(at(home), at(dstHome), files.map((f) => ({ src: f.rel, dst: plan.remapRel(f.rel, mv, folder.cwd, dmem.slug) })));
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
  const lines = plan.formatPlan(mv, { what: ["session", "memory"], dest: { ...shell.parseProbe("x", probeOut([])), home: env.home, pawHome: env.pawHome, memory: dmem }, folder, back: false, from: "this machine" }).join("\n");
  assert(lines.includes(`folder     ${cwd} → ${folder.cwd}  (no --repo: a fresh folder paw owns there — nothing in ${cwd} moves)`), "the plan names the folder move");
  assert(lines.includes(`→ ${dstHome}/.claude/projects/${plan.projectSlug(folder.cwd)}/, cwd fields rewritten`) && lines.includes(`memory     1 file, 11 B  → ${dstHome}/.claude/projects/${dmem.slug}/  (keyed by ${folder.cwd})`), "…and where the session and memory land");
  assert(lines.includes(`             1 file(s)  ~/.claude/projects/${slug}/  (its folder — Claude Code's key)`), "…with each source memory dir and its count");
  rmSync(dstHome, { recursive: true, force: true });
}

console.log("force");
{
  const pin2 = "11111111-2222-3333-4444-555555555555";
  const theirs = `---\nname: proj\nagent: claude\ncwd: /data/home/work/proj\nresume: ${pin2}\n---\nbody\n`;
  const own = (extra: string[] = []) => shell.parseProbe("box", probeOut([`persona\t${b64(theirs)}`, ...extra]));
  const what = plan.WHAT.filter((w) => w !== "beads" && w !== "env");
  const folderF = plan.destFolder(m, what, { home: "/data/home", pawHome: "/data/home/.paw" });
  const fctx = (dest: ReturnType<typeof own>, force: boolean) => {
    const replace = force ? plan.replacementOf(m, dest, "20261023T000000Z") : undefined;
    return { what, dest, folder: folderF, transport: { kind: "ssh", host: "mini" } as const, back: false, force, ...(replace ? { replace } : {}) };
  };
  const ok0 = () => shell.parseProbe("box", probeOut([]));
  const live = own(["livepid\t4242"]);
  assert(JSON.stringify(live.livePids) === "[4242]", "the probe reports the live pid holding its session there");
  const refused = plan.teleportBlockers(m, fctx(live, false)).join("\n");
  assert(/already has an agent "proj" .*rename one of them first, or --force to replace it/.test(refused), "without --force: refused, and the refusal names --force");
  const forced = fctx(live, true);
  assert(!plan.teleportBlockers(m, forced).some((b) => /already has an agent/.test(b)), `with --force: no name clash (${plan.teleportBlockers(m, forced).join(" | ")})`);
  assert(/^\d{8}T\d{6}Z$/.test(plan.replaceStamp(new Date("2026-10-23T22:15:00.123Z"))) && plan.replaceStamp(new Date("2026-10-23T22:15:00.123Z")) === "20261023T221500Z", "the backup stamp");
  const r = forced.replace!;
  assert(r.backup === "/data/home/.paw/spaces/tele-test/personas/replaced-by-teleport/proj.20261023T000000Z.md", `its persona is backed up there, never deleted (${r.backup})`);
  const fl = plan.formatPlan(m, { ...forced, from: "this machine" }).join("\n");
  assert(fl.includes(`  replace    --force: box's own "proj" (claude, not a teleported copy) is replaced:`), "the plan: what is replaced");
  assert(fl.includes(`             persona  /data/home/.paw/spaces/tele-test/personas/proj.md → moved to ${r.backup} (never deleted)`), "…its persona and where it goes");
  assert(fl.includes(`             session  resume: ${pin2} — its transcript stays where it is there`), "…its pinned session, transcript kept");
  assert(fl.includes(`             folder   /data/home/work/proj`), "…its folder");
  assert(fl.includes(`             live     yes — pid 4242 holds its session there; stopped there first`), "…and that it is live");
  assert(plan.formatPlan(m, { ...fctx(own(), true), from: "x" }).join("\n").includes("live     no — not running there"), "…or not");
  assert(plan.formatPlan(m, { ...fctx(ok0(), true), from: "x" }).join("\n").includes(`--force: box has no agent "proj" of its own — nothing to replace`), "--force with nothing there: says so");
  // never a bypass: every other blocker stands
  const bad = shell.parseProbe("box", probeOut([`persona\t${b64(theirs)}`, "claudemd\tdeadbeef", "skill\techo cafe"]).replace(b64('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}'), b64('{"loggedIn": false}')));
  const still = plan.teleportBlockers(m, fctx(bad, true)).join("\n");
  assert(/claude is not logged in/.test(still) && /different ~\/\.claude\/CLAUDE\.md/.test(still) && /different skill "echo"/.test(still), "--force does not bypass logins, a different CLAUDE.md or skill");
  const withBeads = own();
  withBeads.beads = beads.parseBeadsSide("box", `dir\t/b\nbd\t/usr/bin/bd\nallowstale\t1\nend\t1\n--export--\n${JSON.stringify({ _type: "issue", id: mine1, title: "x", status: "open" })}\n`);
  assert(plan.teleportBlockers(m, { ...fctx(withBeads, true), what: [...what, "beads"] }).some((b) => /already exist/.test(b)), "--force does not bypass a bead collision");
  throws(() => plan.buildManifest({ space, name, personaFile, what: ["repo"] }, { git: (args, at) => (args[0] === "status" ? { ok: true, out: " M dirty.txt", err: "" } : { ok: true, out: at, err: "" }) }), /uncommitted change/, "--force has no say over a dirty repo (the manifest refuses it first)");
  const memClash = own();
  memClash.memory = { base: "/data/home/.paw/repos/e2e/proj", slug: "-data-home--paw-repos-e2e-proj", files: { "memory/MEMORY.md": "0".repeat(64) } };
  assert(plan.teleportBlockers(m, fctx(memClash, true)).some((b) => /different memory file/.test(b)), "--force does not bypass a memory clash with the replaced agent's memory there");
  // the mesh: only the replaced copy there may be the presence this machine doesn't run
  const mb = (o: Partial<Parameters<typeof meshBlockersOf>[0]>) => meshBlockersOf({ name: "proj", runningHere: false, peerIds: [], hereAnswered: true, ...o }).join("\n");
  const target = (force: boolean, pids = [4242]) => ({ label: "ssh:mini", livePids: pids, force });
  assert(mb({ peerIds: ["p1"], target: target(true) }) === "", "--force: the one presence this machine doesn't run is the live copy there being replaced");
  assert(/it runs elsewhere.*one may be ssh:mini's own "proj" \(pid 4242.*--force replaces it/.test(mb({ peerIds: ["p1"], target: target(false) })), "without --force: blocked, pointing at --force");
  assert(/it runs elsewhere/.test(mb({ peerIds: ["p1"], target: target(true, []) })), "--force, but nothing live there holds its session: the presence runs elsewhere — blocked");
  assert(/another runs elsewhere/.test(mb({ peerIds: ["p1", "p2"], target: target(true) })), "--force: a second presence is a third machine — blocked");
  assert(mb({ runningHere: true, hosted: { here: true }, peerIds: ["h", "p1"], target: target(true) }) === "", "running here + the replaced copy there: both accounted for");
  assert(/present on the mesh 2 times/.test(mb({ runningHere: true, hosted: { here: true }, peerIds: ["h", "p1"] })), "running here and another presence, no --force: blocked");
  assert(/not this machine's to move/.test(mb({ runningHere: true, hosted: { here: false, why: "x" }, peerIds: ["h"], target: target(true) })), "--force never makes another machine's agent movable");
  assert(/isn't answering/.test(mb({ peerIds: ["p1"], hereAnswered: false })), "a silent manager here: can't tell");

  // the scripts, for real: stop there (a stub paw) + move the persona aside; restore
  const dstHome = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-force-")));
  const bin = join(dstHome, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "paw"), '#!/bin/sh\n[ "$1" = stop ] && echo "✓ stopped $2"\n', { mode: 0o755 });
  const side = { ...shell.localSide("box"), spawn: (sc: string) => shell.localSide("box").spawn(`HOME=${shell.sq(dstHome)}; export HOME; unset PAW_HOME; PATH=${shell.sq(bin)}:$PATH; export PATH\n${sc}`) };
  const pdirThere = join(dstHome, ".paw", "spaces", space, "personas");
  mkdirSync(pdirThere, { recursive: true });
  writeFileSync(join(pdirThere, "proj.md"), theirs);
  const backup = plan.replacedPersonaPath(join(dstHome, ".paw"), space, name, "20261023T000000Z");
  const rr = await shell.run(side, shell.replaceScript(space, name, backup));
  assert(rr.code === 0 && rr.stdout.toString() === `stopped 1\n${backup}\n`, `replace: stopped there, persona moved aside (${rr.stdout.toString().trim().replace(/\n/g, " ")} ${rr.stderr.trim()})`);
  assert(!existsSync(join(pdirThere, "proj.md")) && readFileSync(backup, "utf8") === theirs, "…the backup holds it byte for byte, nothing deleted");
  assert(readdirSync(pdirThere).filter((f) => f.endsWith(".md")).length === 0, "…and it is out of the persona listing (a subdir)");
  assert((await shell.run(side, shell.replaceScript(space, name, backup))).code !== 0, "replace again with no persona there refuses");
  writeFileSync(join(pdirThere, "proj.md"), "---\nname: proj\n---\nnew\n");
  assert(/refusing to overwrite a backup/.test((await shell.run(side, shell.replaceScript(space, name, backup))).stderr), "an existing backup is never overwritten");
  const back2 = await shell.run(side, shell.restoreReplacedScript(space, name, backup));
  assert(back2.code === 0 && readFileSync(join(pdirThere, "proj.md"), "utf8") === theirs && !existsSync(backup), "the rollback puts its own persona back (over the one teleport wrote)");
  // the live check: Claude Code's per-process session index there
  mkdirSync(join(dstHome, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(dstHome, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: pin2 }));
  writeFileSync(join(dstHome, ".claude", "sessions", "999999.json"), JSON.stringify({ pid: 999999, sessionId: pin2 }));
  const pf = await shell.probe(side, m, ["session"], plan.destFolder(m, ["session"], await shell.probeEnv(side)));
  assert(JSON.stringify(pf.livePids) === `[${process.pid}]`, `the probe finds the live claude holding its pin there, not a dead pid (${JSON.stringify(pf.livePids)})`);
  rmSync(dstHome, { recursive: true, force: true });
}

console.log("memory (where Claude Code keeps it)");
{
  const mem = await import("../src/teleport-memory.ts");
  const mh = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-mem-")));
  const root = join(mh, "Github", "evals");
  mkdirSync(root, { recursive: true });
  git(["init", "-q", "-b", "main"], root);
  git(["commit", "-q", "--allow-empty", "-m", "one"], root);
  const wt = join(root, ".claude", "worktrees", "feat-x");
  git(["worktree", "add", "-q", wt, "-b", "feat-x"], root);
  assert(mem.claudeMemoryBase(wt) === root, `a worktree's memory is keyed by the main checkout (${mem.claudeMemoryBase(wt)})`);
  assert(mem.claudeMemoryBase(join(root, ".claude")) === root, "a folder inside the repo: the repo root");
  mkdirSync(join(mh, "plain"));
  assert(mem.claudeMemoryBase(join(mh, "plain")) === join(mh, "plain"), "outside git: the folder itself");
  const rootSlug = mem.memorySlug(root)!;
  const wtSlug = mem.memorySlug(wt)!;
  assert(wtSlug === `${rootSlug}--claude-worktrees-feat-x`, "the worktree's own slug (Claude Code's .claude/worktrees layout)");
  assert(mem.memorySlug("/" + "x".repeat(250)) === undefined, "a path Claude Code would hash: no slug (paw can't name it)");
  const P = join(mh, ".claude", "projects");
  const put = (slugDir: string, rel: string, text: string) => {
    mkdirSync(join(P, slugDir, rel, ".."), { recursive: true });
    writeFileSync(join(P, slugDir, rel), text);
  };
  put(rootSlug, "memory/MEMORY.md", "# index\n");
  put(rootSlug, "memory/a.md", "A\n");
  put(rootSlug, "memory/.last-dream", "100\n");
  put(rootSlug, "memory-backup-20260709/MEMORY.md", "# old\n");
  put(wtSlug, "memory/a.md", "A\n");
  put(wtSlug, "memory/b.md", "B\n");
  put(wtSlug, "memory/.last-dream", "200\n");
  put(wtSlug, "s1.jsonl", "{}\n");
  const mm = mem.memoryManifest({ home: mh, cwd: wt, sessionDir: join(P, wtSlug) });
  const inner = mm.files.map((f) => mem.memoryPathOf(f.rel)!.inner).sort();
  assert(mm.base === root && mm.slug === rootSlug, "the agent in a worktree: memory comes from the repo root's dir");
  assert(JSON.stringify(inner) === JSON.stringify(["memory-backup-20260709/MEMORY.md", "memory/.last-dream", "memory/MEMORY.md", "memory/a.md", "memory/b.md"]), `merged: every path once, dream's state included (${inner.join(", ")})`);
  assert(mm.files.find((f) => f.rel.endsWith("memory/.last-dream"))!.rel.includes(wtSlug), "…the newest .last-dream wins");
  assert(mm.clashes.length === 0, "identical files in two dirs are no clash");
  assert(mm.sources.length === 2 && mm.sources[0].dir === `.claude/projects/${rootSlug}` && mm.sources[0].files === 4 && mm.sources[1].files === 3, `each source dir with its count (${JSON.stringify(mm.sources)})`);
  const pl = mem.memoryPlanLines(mm, { base: "/data/home/.paw/repos/x/evals", slug: "-data-home--paw-repos-x-evals", files: {} }, "/data/home", "5 files, 40 B").join("\n");
  assert(pl.includes(`  memory     5 files, 40 B  → /data/home/.claude/projects/-data-home--paw-repos-x-evals/  (keyed by /data/home/.paw/repos/x/evals)`), "the plan: total and where it lands");
  assert(pl.includes(`             4 file(s)  ~/.claude/projects/${rootSlug}/  (the repo root — Claude Code's key)`) && pl.includes(`             3 file(s)  ~/.claude/projects/${wtSlug}/`), "…and each source dir with its file count");
  put(wtSlug, "memory/MEMORY.md", "# a different index\n");
  const clash = mem.memoryManifest({ home: mh, cwd: wt, sessionDir: join(P, wtSlug) });
  assert(clash.clashes.length === 1 && clash.clashes[0].startsWith("memory/MEMORY.md:"), "the same name with other content in two dirs is a clash");
  assert(mem.memoryBlockers(clash, { base: root, slug: rootSlug, files: {} }, "box", false).some((b) => /differ between this agent's memory dirs .*--no-memory[\s\S]*memory\/MEMORY\.md/.test(b)), "…which blocks, loudly, with the way out");
  rmSync(join(P, wtSlug, "memory", "MEMORY.md"));
  const h = (t: string) => createHash("sha256").update(t).digest("hex");
  const there = { base: "/d/evals", slug: "-d-evals", files: { "memory/a.md": h("A\n"), "memory/MEMORY.md": h("theirs\n"), "memory/.last-dream": h("5\n") } };
  const bl = mem.memoryBlockers(mm, there, "box", false).join("\n");
  assert(/box already has 1 different memory file\(s\) .*never overwrites[\s\S]*memory\/MEMORY\.md/.test(bl) && !/last-dream/.test(bl), "a different file there blocks (dream's stamp never does)");
  assert(mem.memoryBlockers(mm, there, "box", true).length === 0, "its own older copy there (--back / a teleported copy) may be overwritten");
  assert(mem.memoryAlreadyThere(mm, there).size === 1, "an identical file there is not re-sent");
  assert(mem.memoryBlockers(mm, undefined, "box", false).some((b) => /not probed/.test(b)), "an unprobed destination blocks");
  assert(mem.memoryBlockers(mm, { base: "/" + "d".repeat(240), slug: "-" + "d".repeat(240), files: {} }, "box", false).some((b) => /can't reproduce/.test(b)), "a destination key paw can't name blocks");
  // the probe's walk, for real: a worktree there is keyed by its main checkout
  const pr = await shell.run(
    { ...shell.localSide("x"), spawn: (sc: string) => shell.localSide("x").spawn(`HOME=${shell.sq(mh)}; export HOME\n${sc}`) },
    `out() { printf '%s\\t%s\\n' "$1" "$2"; }\n${plan.HASH_SH}\n${mem.memoryProbeScript(join(wt, "not-yet"))}`,
  );
  const dm = mem.parseDestMemory(pr.stdout.toString().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)] as const))!;
  assert(dm.base === root && dm.slug === rootSlug && dm.files["memory/a.md"] === h("A\n"), `the probe there: the same key, and the hashes of what is there (${dm.base})`);
  // settings that move memory elsewhere: refused, never silently skipped
  assert(mem.memoryOverride(mh, root, {}) === undefined, "no override: the default layout");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ autoMemoryDirectory: "~/mem" }));
  assert(/autoMemoryDirectory: "~\/mem"/.test(mem.memoryOverride(mh, root, {}) ?? ""), "an autoMemoryDirectory setting is found");
  assert(/CLAUDE_CODE_REMOTE_MEMORY_DIR/.test(mem.memoryOverride(mh, root, { CLAUDE_CODE_REMOTE_MEMORY_DIR: "/x" }) ?? ""), "…and the env overrides");
  rmSync(mh, { recursive: true, force: true });
}

console.log("folder (not a git checkout) + what it needs there");
{
  const deps = await import("../src/teleport-deps.ts");
  const folderMod = await import("../src/teleport-folder.ts");
  assert(JSON.stringify(deps.commandWords("FOO=1 psql -c 'select 1; drop' | head -n 3 && sudo -E aws s3 ls; ./x.sh")) === JSON.stringify(["psql", "head", "aws"]), "commands: past assignments and sudo, split on | && ;, quotes are arguments, ./x is the folder's");
  assert(JSON.stringify(deps.commandWords("cat <<'EOF'\nnotacmd here\nEOF\nsearch q $(jq .x f) # cmt; nope")) === JSON.stringify(["cat", "search", "jq"]), "a heredoc body, a comment: not commands; $( ) is");
  assert(JSON.stringify(deps.commandWords("cd /x && timeout 5 ~/.local/bin/evals run && echo $HOME")) === JSON.stringify(["~/.local/bin/evals"]), "builtins skipped; timeout N unwrapped; a ~ path command");
  assert(JSON.stringify(deps.homeRefs(`a ~/.config/cotal/config.json, "$HOME/Github/e/.env.prod" ${home}/x/y. \${HOME}/z`, home).sort()) === JSON.stringify([".config/cotal/config.json", "Github/e/.env.prod", "x/y", "z"]), "home paths: ~, $HOME, ${HOME}, the literal HOME");
  assert(folderMod.secretLooking("state/secret_openai", 0o644) && folderMod.secretLooking("k/a.key", 0o644) && folderMod.secretLooking(".env.local", 0o644) && folderMod.secretLooking("x.txt", 0o600) && !folderMod.secretLooking("x.txt", 0o644), "secret-looking: secret*, *.key, .env*, mode 0600");

  const arena = join(home, ".cache", "firegoat-ideas", "mcp-arena");
  mkdirSync(join(arena, "state"), { recursive: true, mode: 0o700 });
  chmodSync(join(arena, "state"), 0o700);
  mkdirSync(join(arena, "keys"), { recursive: true });
  writeFileSync(join(arena, "run.sh"), `#!/bin/sh\npsql "$(cat ~/.config/cotal/config.json)"\n. $HOME/Github/team2027/evals/.env.prod\ncat ${arena}/state/x\ncat ~/nope/not-here\n`, { mode: 0o755 });
  writeFileSync(join(arena, "state", "secret_openai"), "sk-THESECRET\n", { mode: 0o600 });
  writeFileSync(join(arena, "keys", "a.key"), "KEYDATA\n");
  writeFileSync(join(arena, ".env"), "TOKEN=hush\n");
  writeFileSync(join(arena, "data.txt"), "data\n");
  symlinkSync("data.txt", join(arena, "link"));
  mkdirSync(join(home, ".config", "cotal"), { recursive: true });
  writeFileSync(join(home, ".config", "cotal", "config.json"), "{}\n");
  mkdirSync(join(home, "Github", "team2027", "evals"), { recursive: true });
  writeFileSync(join(home, "Github", "team2027", "evals", ".env.prod"), "DB=secret\n", { mode: 0o600 });
  const fake = join(home, "fakebin");
  mkdirSync(fake);
  for (const b of ["psql", "aws", "search"]) writeFileSync(join(fake, b), "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = `${fake}:${process.env.PATH}`;
  const apin = "abababab-0000-0000-0000-000000000009";
  const apd = join(home, ".claude", "projects", plan.projectSlug(arena));
  mkdirSync(apd, { recursive: true });
  const bash = (command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  writeFileSync(join(apd, `${apin}.jsonl`), [bash("psql -c 'select 1' | head"), bash("FOO=1 aws s3 ls && search foo"), bash("cd x; ./local.sh"), bash("nonexistent-zzz-cmd --x"), JSON.stringify({ type: "user", message: { content: "psst: run zzz-in-user-text" } })].join("\n") + "\n");
  setPersonaKeys(space, "arena", { cwd: arena, resume: apin });
  const apf = personaFilePath(space, "arena");
  throws(() => plan.buildManifest({ space, name: "arena", personaFile: apf, what: ["repo"] }), /not in a git repo/, "--repo alone on a non-git folder still refuses");
  const am = plan.buildManifest({ space, name: "arena", personaFile: apf, what: ["session", "repo", "folder"] });
  assert(am.repo === undefined && am.notes.some((n) => /not a git checkout — it moves as a folder/.test(n)), "--all on a non-git folder: no repo, it moves as a folder");
  const af = am.folder!;
  assert(af.files.length === 6 && af.files.find((f) => f.rel === "link")?.link === true, `the whole tree, a symlink as a link (${af.files.map((f) => f.rel).join(", ")})`);
  assert(JSON.stringify(af.secrets) === JSON.stringify([".env", "keys/a.key", "state/secret_openai"]), `secret-looking files by name (${af.secrets.join(", ")})`);
  const d = am.hostDeps!;
  assert(JSON.stringify(d.commands) === JSON.stringify(["aws", "head", "psql", "search"]), `commands it ran that resolve here — not a typo, not text (${d.commands.join(", ")})`);
  assert(JSON.stringify(d.files) === JSON.stringify([".config/cotal/config.json"]), `paths outside its folder that exist here (${d.files.join(", ")})`);
  assert(d.env.length === 1 && d.env[0].there === "~/Github/team2027/evals/.env.prod", `a secret file it names is an --env candidate (${d.env.map((e) => e.there).join(", ")})`);
  assert(JSON.stringify(d.selfRefs) === JSON.stringify(["run.sh"]) && JSON.stringify(d.plugins) === JSON.stringify(["slack@official"]), "files naming its own folder; plugins enabled here");
  assert(am.env === undefined, "no --env: no secret moves");
  const awhat: Array<(typeof plan.WHAT)[number]> = ["session", "folder"];
  const afolder = plan.destFolder(am, awhat, { home: "/data/home", pawHome: "/data/home/.paw" });
  assert(afolder.how === "agents" && afolder.cwd === "/data/home/.paw/agents/arena", `it lands in the folder paw owns there (${afolder.cwd})`);
  const adest = shell.parseProbe("box", probeOut(["depsprobed\t1", "cmdmissing\tpsql", "cmdmissing\tsearch", "pathmissing\t.config/cotal/config.json", `settings\t${b64(JSON.stringify({ enabledPlugins: { "artil@x": true } }))}`]));
  const al = plan.formatPlan(am, { what: awhat, dest: adest, folder: afolder, back: false, from: "this machine" }).join("\n");
  assert(al.includes("  needs on box: psql (missing), search (missing), ~/.config/cotal/config.json (missing), plugin slack@official (missing)  — warnings: it used these here"), "the plan's warnings: commands, files, plugins missing there");
  assert(al.includes("NOT moved (opt in with --env; names only): ~/Github/team2027/evals/.env.prod"), "…the secrets it names that stay unless --env");
  assert(al.includes(`  files      6 file(s), `) && al.includes("3 secret-looking (names only, contents never shown): .env, keys/a.key, state/secret_openai"), "…the folder's size and secret names");
  assert(al.includes(`1 of its files name its folder ${arena} by absolute path`), "…files that name its old absolute folder");
  assert(!/sk-THESECRET|KEYDATA|hush|DB=secret/.test(al), "never a secret's contents");
  assert(plan.teleportBlockers(am, { what: awhat, dest: adest, folder: afolder, back: false }).length === 0, `warnings are not blockers (${plan.teleportBlockers(am, { what: awhat, dest: adest, folder: afolder, back: false }).join(" | ")})`);
  const full = shell.parseProbe("box", probeOut(["cwdexists\t1", "cwdnonempty\t1"]));
  assert(plan.teleportBlockers(am, { what: awhat, dest: full, folder: afolder, back: false }).some((b) => /already exists and isn't empty — teleport never merges/.test(b)), "a non-empty destination folder refuses");
  const ownCopy = shell.parseProbe("box", probeOut(["cwdexists\t1", "cwdnonempty\t1", `persona\t${b64("---\nname: arena\nteleported: origin\n---\n")}`]));
  assert(!plan.teleportBlockers(am, { what: awhat, dest: ownCopy, folder: afolder, back: false }).some((b) => /isn't empty/.test(b)), "…unless it is its own earlier copy");
  const em = plan.buildManifest({ space, name: "arena", personaFile: apf, what: ["folder", "env"] });
  assert(em.env?.length === 1, "--env: the secret files move");
  const envDest = shell.parseProbe("box", probeOut(["depsprobed\t1", `envthere\t0 ${"f".repeat(64)}`]));
  assert(plan.teleportBlockers(em, { what: ["folder", "env"], dest: envDest, folder: afolder, back: false }).some((b) => /different ~\/Github\/team2027\/evals\/\.env\.prod — teleport never overwrites a secret/.test(b)), "--env: a different secret there blocks");
  assert(/env        1 secret file\(s\) its files name — moved, names only: ~\/Github\/team2027\/evals\/\.env\.prod/.test(plan.formatPlan(em, { what: ["folder", "env"], dest: adest, folder: afolder, back: false, from: "x" }).join("\n")), "--env: the plan names what moves");

  // for real between two HOMEs: the tree with its modes, the probe's misses, the --env file
  const dstHome = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-folder-")));
  const at = (h: string, path?: string) => ({ ...shell.localSide(h), spawn: (sc: string) => shell.localSide(h).spawn(`HOME=${shell.sq(h)}; export HOME; unset PAW_HOME${path ? `; PATH=${shell.sq(path)}; export PATH` : ""}\n${sc}`) });
  const src = at(home);
  const dst = at(dstHome, "/usr/bin:/bin");
  const realFolder = plan.destFolder(am, awhat, await shell.probeEnv(dst));
  await folderMod.copyFolder(src, dst, arena, realFolder.cwd, undefined, shell.collect);
  const mode = (p: string) => lstatSync(join(realFolder.cwd, p)).mode & 0o777;
  assert(mode("state/secret_openai") === 0o600 && mode("state") === 0o700 && mode("run.sh") === 0o755, `modes kept: 0600 file, 0700 dir, 0755 script (${mode("state/secret_openai").toString(8)} ${mode("state").toString(8)} ${mode("run.sh").toString(8)})`);
  assert(lstatSync(join(realFolder.cwd, "link")).isSymbolicLink() && readFileSync(join(realFolder.cwd, "state", "secret_openai"), "utf8") === "sk-THESECRET\n", "a symlink stays a link; contents intact");
  writeFileSync(join(arena, "data.txt"), "data, changed\n");
  const changed = folderMod.folderChanged(af.files, folderMod.folderManifest(arena, home).files);
  assert(changed.map((f) => f.rel).join() === "data.txt", "the final pass: only what changed during the copy");
  await folderMod.copyFolder(src, dst, arena, realFolder.cwd, changed.map((f) => f.rel), shell.collect);
  assert(readFileSync(join(realFolder.cwd, "data.txt"), "utf8") === "data, changed\n", "…re-sent");
  const probed = await shell.probe(dst, am, awhat, realFolder);
  assert(probed.cwdNonEmpty && probed.deps!.cmdMissing.includes("psql") && probed.deps!.cmdMissing.includes("search") && !probed.deps!.cmdMissing.includes("head"), `the probe there: missing commands, not the ones it has (${probed.deps!.cmdMissing.join(", ")})`);
  assert(JSON.stringify(probed.deps!.pathMissing) === JSON.stringify([".config/cotal/config.json"]) && probed.deps!.plugins === undefined, "…missing files; no settings there = plugins unknown, not 'none'");
  const placed = await shell.copyAbsFiles(src, dst, em.env!.map((e) => ({ src: e.src, dst: deps.envDest(e, realFolder.cwd) })));
  const envThere = join(dstHome, "Github", "team2027", "evals", ".env.prod");
  assert(placed.join() === envThere && (lstatSync(envThere).mode & 0o777) === 0o600 && readFileSync(envThere, "utf8") === "DB=secret\n", "--env: the secret lands at the same HOME-relative path, still 0600");
  const reprobed = await shell.probe(dst, em, ["folder", "env"], realFolder);
  assert(reprobed.deps!.envThere[0] === em.env![0].hash, "…the probe sees it there, identical");
  writeFileSync(envThere, "DB=other\n");
  await rejects(shell.copyAbsFiles(src, dst, em.env!.map((e) => ({ src: e.src, dst: deps.envDest(e, realFolder.cwd) }))), /exists there and differs — not overwritten/, "…and never overwrites a different one");
  rmSync(dstHome, { recursive: true, force: true });

  // a git folder: gitignored files in it that its files name are --env candidates
  const svc = join(home, "Github", "svc");
  mkdirSync(svc, { recursive: true });
  git(["init", "-q", "-b", "main"], svc);
  writeFileSync(join(svc, ".gitignore"), ".env.prod\nbuild/\n");
  writeFileSync(join(svc, "run.sh"), "set -a; . ./.env.prod\n");
  git(["add", ".gitignore", "run.sh"], svc);
  git(["commit", "-q", "-m", "svc"], svc);
  writeFileSync(join(svc, ".env.prod"), "K=v\n");
  mkdirSync(join(svc, "build"));
  writeFileSync(join(svc, "build", "out.js"), "x");
  const sd = deps.hostDeps({ home, cwd: svc, transcripts: [], files: deps.trackedFiles(svc), repoTop: svc, plugins: [], resolve: () => new Set() });
  assert(JSON.stringify(sd.env.map((e) => e.there)) === JSON.stringify(["@/.env.prod"]) && deps.envDest(sd.env[0], "/d/repos/o/svc") === "/d/repos/o/svc/.env.prod", "a gitignored .env.prod its script names: an --env candidate, landing in the folder there");
  for (const p of [arena, svc]) rmSync(p, { recursive: true, force: true });
}

console.log("repo: a stale source, and a failed mirror's clone");
{
  const bare2 = join(home, "stale.git");
  const URL2 = "https://github.com/e2e/stale.git";
  writeFileSync(join(home, ".gitconfig"), `${gitconfig}[url "${bare2}"]\n\tinsteadOf = ${URL2}\n`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare2]);
  const s1 = join(home, "Github", "stale1");
  const s2 = join(home, "Github", "stale2");
  mkdirSync(s1, { recursive: true });
  git(["init", "-q", "-b", "main"], s1);
  git(["remote", "add", "origin", URL2], s1);
  git(["commit", "-q", "--allow-empty", "-m", "one"], s1);
  git(["push", "-q", "-u", "origin", "main"], s1);
  git(["clone", "-q", URL2, s2], home);
  git(["commit", "-q", "--allow-empty", "-m", "two, elsewhere"], s2);
  git(["push", "-q", "origin", "main"], s2);
  git(["fetch", "-q", "origin"], s1);
  const ri = plan.repoInfo(s1);
  assert(ri.behind?.ref === "origin/main" && ri.behind.count === 1 && ri.unpushed === 0, `the source is 1 behind origin/main (${JSON.stringify(ri.behind)})`);
  const sm = { ...m, repo: ri, cwd: s1 };
  const sf = plan.destFolder(sm, ["repo"], { home: "/data/home", pawHome: "/data/home/.paw" });
  const sb = plan.teleportBlockers(sm, { what: ["repo"], dest: shell.parseProbe("box", probeOut([])), folder: sf, back: false }).join("\n");
  assert(/is 1 commit\(s\) BEHIND origin\/main .*never moves the agent to another commit silently; fast-forward here first: `git -C .* merge --ff-only origin\/main`/.test(sb), "preflight: a stale source is named, with the fast-forward");
  git(["commit", "-q", "--allow-empty", "-m", "local"], s1);
  const div = plan.teleportBlockers({ ...sm, repo: plan.repoInfo(s1) }, { what: ["repo"], dest: shell.parseProbe("box", probeOut([])), folder: sf, back: false }).join("\n");
  assert(/has diverged from origin\/main: 1 commit\(s\) only here, 1 only there/.test(div), "…a diverged one too");
  git(["reset", "-q", "--hard", "origin/main"], s1);
  assert(plan.repoInfo(s1).behind === undefined, "fast-forwarded: no blocker");

  const dstHome = realpathSync(mkdtempSync(join(tmpdir(), "paw-teleport-clone-")));
  writeFileSync(join(dstHome, ".gitconfig"), `[url "${bare2}"]\n\tinsteadOf = ${URL2}\n`);
  const at = (h: string) => ({ ...shell.localSide(h), spawn: (sc: string) => shell.localSide(h).spawn(`HOME=${shell.sq(h)}; export HOME; unset PAW_HOME\n${sc}`) });
  const src = at(home);
  const dst = at(dstHome);
  const good = plan.repoInfo(s1);
  const cf = plan.destFolder({ ...sm, repo: good }, ["repo"], await shell.probeEnv(dst));
  const bogus = { ...good, head: "0123456789abcdef0123456789abcdef01234567" };
  await rejects(shell.moveRepo(src, dst, bogus, cf), /is not on .* and was not bundled/, "a mirror that fails after cloning…");
  assert(!existsSync(cf.clone!), "…removes the clone it made itself (no half-made, all-deleted checkout left to block a retry)");
  const made = await shell.moveRepo(src, dst, good, cf);
  assert(made.created?.kind === "clone" && made.created.path === cf.clone, "a clone made by this run is recorded");
  await rejects(shell.moveRepo(src, dst, bogus, cf), /was not bundled/, "a failing mirror into a clone that was there before…");
  assert(existsSync(join(cf.clone!, ".git")), "…never removes it");
  const again = await shell.moveRepo(src, dst, good, cf);
  assert(again.created === undefined, "a reused clone is not 'created'");
  const rm1 = await shell.run(dst, shell.removeCreatedScript(made.created!));
  assert(rm1.code === 0 && !existsSync(cf.clone!), "the rollback removes the clone this run created");
  mkdirSync(join(dstHome, "plain"));
  assert((await shell.run(dst, shell.removeCreatedScript({ kind: "clone", path: join(dstHome, "plain"), clone: join(dstHome, "plain") }))).code !== 0 && existsSync(join(dstHome, "plain")), "…and refuses a path that is not a git checkout");
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
