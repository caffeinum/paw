/**
 * END-TO-END: `paw restart <agent> --agent kit|claude` — swapping an existing agent's harness — on a
 * REAL, ISOLATED mesh with HOME isolated too (~/.claude, ~/.kit and cotal's ~/.config are throwaway).
 *
 *   share  0 a kit persona WITHOUT `shareTools: none` comes up, even when the cotal config declares
 *            MCP servers for claude AND for kit (the old silent-refusal gotcha)
 *   swap   1 a claude agent with a pin and a claude transcript → `--agent kit -- -P fake:codex -e high`:
 *            the persona says agent kit + kitArgs verbatim + storage: claude, the output says so with the
 *            undo; `kit run` carries `--overwrite --resume <pin>` and the flags; a DM turn lands in the
 *            SAME claude transcript, nothing in kit's store
 *          2 the kit flags the operator named for real (`-- -m grok-4.7 -e high`) reach `kit run` verbatim
 *            (argv only — no grok login in the throwaway HOME, so no turn is asked of it)
 *   loud   3 refused, persona untouched: unknown --agent, `--` with claude, a paw-owned kit flag, a flag
 *            kit doesn't know, a bare word, --model twice, --agent on a runtime, a mismatched space
 *   back   4 `--agent claude` removes the kit keys, keeps the pin; the manager launches claude (a stub
 *            on PATH — no claude login here) with `--resume <pin>`
 *   nopin  5 a claude agent with no pin → `--agent kit` mints a fresh pin and starts kit on it
 *   addr   6 `paw restart . --agent kit` from the agent's folder resolves the folder's agent; `<name>#<space>`
 *            from another PAW_SPACE reaches it; an unchanged swap still restarts (a new kit process)
 *   old    7 the ccswitch hang (2026-10-20): the manager runs a release older than kit swaps (no
 *            src/manager-features.json; its kit connector requires `provider:`). The swap is REFUSED
 *            before the persona is written and the running agent is left alone. A manager that claims the
 *            feature but refuses after accepting fails BOUNDED: progress lines, then an error naming the
 *            never-launched spawn, the manager's release and its log, never a silent wait
 *
 *   KIT_BIN=~/.paw/bin/kit PAW_HOME=$(mktemp -d) PAW_SPACE=kit-test-$$ PAW_RELEASE=dev \
 *   PAW_COTAL_ROOT=$(mktemp -d) PAW_BEADS_DIR=$(mktemp -d) node scripts/lean/kit/e2e-kit-swap.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const space = process.env.PAW_SPACE ?? "";
if (!process.env.PAW_HOME || !space.startsWith("kit-test-") || process.env.PAW_RELEASE !== "dev" || !process.env.PAW_COTAL_ROOT || !process.env.PAW_BEADS_DIR)
  throw new Error("isolated run only: PAW_HOME, PAW_SPACE=kit-test-*, PAW_RELEASE=dev, PAW_COTAL_ROOT, PAW_BEADS_DIR");
if (!process.env.KIT_BIN) throw new Error("KIT_BIN: the kit binary to run");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "kit-swap-home-")));
process.env.HOME = HOME;
delete process.env.KIT_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.XDG_CONFIG_HOME;
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

// A stand-in `claude`: no claude login exists in the throwaway HOME, so the swap back is checked by
// the argv the manager launches it with. `--version` answers for the harness preflight.
const stubDir = join(HOME, "stub-bin");
const stubLog = join(HOME, "claude-argv.log");
mkdirSync(stubDir);
writeFileSync(join(stubDir, "claude"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.304 (Claude Code)"; exit 0; fi\necho "$*" >> ${stubLog}\nexec sleep 600\n`);
chmodSync(join(stubDir, "claude"), 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH}`;

const port = await new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
process.env.PAW_SERVER = `nats://127.0.0.1:${port}`;
process.env.PAW_RUNTIME = "pty";
delete process.env.PAW_COTAL_HUB;
const nats = spawn("nats-server", ["-js", "-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), "kitjs-"))], { stdio: "ignore" });

const { CotalEndpoint } = await import("@cotal-ai/core");
const { removeMesh } = await import("@cotal-ai/workspace");
const { ensure, stop, managerProcs, mailboxProcs } = await import("../../../src/lifecycle.ts");
const { ensurePersonaFile, personaFilePath, setFolderName, setPersonaKeys } = await import("../../../src/addressing.ts");
const { claudeProjectsRoot, kitSessionsRoot, readAgentType, readKitArgs, readResumeId, personaValue } = await import("../../../src/session.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const until = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, every = 500): Promise<T | undefined> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await fn();
    if (v) return v;
  }
  return undefined;
};
const pawIn = (o: { cwd?: string; env?: Record<string, string> }, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(REPO, "bin/paw.mjs"), ...args], { env: { ...process.env, ...o.env }, cwd: o.cwd, encoding: "utf8", timeout: 300_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const paw = (...args: string[]) => pawIn({}, ...args);
const tail = (s: string, n = 3) => s.trim().split("\n").slice(-n).join(" | ");
const kitProc = (name: string) =>
  execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }))
    .find((p) => p.cmd.includes(" run ") && p.cmd.includes(`--name ${name} `) && p.cmd.includes(`--space ${space} `));
const slug = (dir: string) => dir.replace(/[^A-Za-z0-9_]/g, "-");
const kitFile = (dir: string, pin: string) => join(kitSessionsRoot(), slug(dir), `${pin}.jsonl`);
const claudeFile = (dir: string, pin: string) => join(claudeProjectsRoot(), slug(dir), `${pin}.jsonl`);
const birth = (name: string, keys: Record<string, string | undefined>) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `kit-${name}-`)));
  setFolderName(space, folder, name);
  ensurePersonaFile(space, name, { brief: `You are ${name}, a test agent.` });
  setPersonaKeys(space, name, keys);
  return { folder, pin: readResumeId(personaFilePath(space, name))!, file: personaFilePath(space, name) };
};
const front = (file: string) => readFileSync(file, "utf8").split("---")[1] ?? "";

// MCP servers declared for claude AND for kit: before the fix a kit persona without `shareTools: none`
// was handed kit's declared servers, the connector refused after the manager had ACCEPTED the spawn,
// and `paw start` only timed out.
mkdirSync(join(HOME, ".config", "cotal"), { recursive: true });
writeFileSync(
  join(HOME, ".config", "cotal", "config.json"),
  JSON.stringify({ connectors: { claude: { mcpServers: { cl: { command: "true" } } }, kit: { mcpServers: { kt: { command: "true" } } } } }),
);

const inbox: Array<{ from: string; text: string }> = [];
let prober: InstanceType<typeof CotalEndpoint> | undefined;
try {
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0 || undefined, 10_000, 100);
  await ensure({ needMesh: true, needManager: true, space });
  prober = new CotalEndpoint({ space, servers: process.env.PAW_SERVER!, channels: ["general"], consume: true, registerPresence: true, watchPresence: true, card: { name: "prober", kind: "endpoint", id: "prober" } });
  prober.on("error", () => {});
  prober.on("message", (m: { from?: { name?: string }; parts?: Array<{ text?: string }> }, d: { ack(): void }) => {
    inbox.push({ from: m.from?.name ?? "?", text: (m.parts ?? []).map((p) => p.text ?? "").join(" ") });
    d.ack();
  });
  await prober.start();
  const peer = (n: string) => prober!.getRoster().find((p) => p.card.name === n && p.status !== "offline");
  const dmAndWait = async (to: string, word: string) => {
    const pr = await until(() => {
      const actor = /--actor (\S+)/.exec(kitProc(to)?.cmd ?? "")?.[1];
      const p = peer(to);
      return actor && p?.card.id === `local.${actor}` ? p : undefined;
    }, 60_000, 200);
    if (!pr) return undefined;
    await prober!.unicast(pr.card.id, word);
    return until(() => inbox.find((m) => m.from === to && m.text.includes(word)), 60_000, 200);
  };

  // ── 0 shareTools ───────────────────────────────────────────────────────────────────────────
  const S = "noshare";
  const s0 = birth(S, { agent: "kit", provider: "fake:codex", storage: "claude" });
  ok("kit persona has no shareTools line", personaValue(s0.file, "shareTools") === undefined, front(s0.file));
  const t0 = Date.now();
  const st0 = paw("start", S, "--space", space);
  ok("…paw start brings it up anyway (MCP servers declared for claude and kit)", st0.code === 0 && !!kitProc(S), `${Math.round((Date.now() - t0) / 1000)}s ${tail(st0.out + st0.err)}`);

  // ── 1 claude → kit (the persona was a claude agent; its claude transcript came from a kit turn) ──
  const A = "swapper";
  const a = birth(A, { agent: "kit", provider: "fake:codex", storage: "claude" });
  ok("seed: paw start", paw("start", A, "--space", space).code === 0);
  ok("seed: a DM turn writes the claude transcript", !!(await dmAndWait(A, "SEED-ONE")) && existsSync(claudeFile(a.folder, a.pin)));
  ok("seed: paw stop", paw("stop", A, "--space", space).code === 0);
  setPersonaKeys(space, A, { agent: undefined, provider: undefined, storage: undefined });
  ok("seed: the persona is now a plain claude agent with a pin", readAgentType(a.file) === undefined && readResumeId(a.file) === a.pin, front(a.file));
  const before = readFileSync(claudeFile(a.folder, a.pin), "utf8").length;

  const sw = paw("restart", A, "--agent", "kit", "--space", space, "--", "-P", "fake:codex", "-e", "high");
  ok("restart --agent kit -- -P fake:codex -e high", sw.code === 0, tail(sw.out + sw.err, 5));
  ok(
    "…prints what it saved + the undo",
    sw.out.includes(`persona ${A}: agent: kit, kitArgs: ["-P","fake:codex","-e","high"], storage: claude (saved; undo: paw restart ${A} --agent claude)`),
    sw.out.split("\n")[0],
  );
  ok("…and that storage: claude keeps it on its claude transcript", sw.out.includes("storage: claude set — kit appends to") && sw.out.includes(claudeFile(a.folder, a.pin)));
  ok(
    "persona: agent kit, kitArgs verbatim, storage claude, same pin, no provider:",
    readAgentType(a.file) === "kit" && JSON.stringify(readKitArgs(a.file)) === '["-P","fake:codex","-e","high"]' && personaValue(a.file, "storage") === "claude" && readResumeId(a.file) === a.pin && personaValue(a.file, "provider") === undefined,
    front(a.file),
  );
  const p1 = await until(() => kitProc(A), 30_000);
  ok("kit run: --overwrite --resume <pin> … -P fake:codex -e high (flags last)", !!p1 && p1.cmd.includes("--overwrite") && p1.cmd.includes(`--resume ${a.pin}`) && p1.cmd.endsWith(`--resume ${a.pin} -P fake:codex -e high`), p1?.cmd);
  ok("a DM after the swap gets a reply", !!(await dmAndWait(A, "SWAP-TWO")));
  const claudeNow = readFileSync(claudeFile(a.folder, a.pin), "utf8");
  ok("…in the SAME claude transcript (grew, has both turns)", claudeNow.length > before && claudeNow.includes("SEED-ONE") && claudeNow.includes("SWAP-TWO"));
  ok("…and nothing in kit's store (no fork)", !existsSync(kitFile(a.folder, a.pin)));

  // ── 2 the real flags, argv only ────────────────────────────────────────────────────────────
  const sg = paw("restart", A, "--agent", "kit", "--space", space, "--", "-m", "grok-4.7", "-e", "high");
  ok("restart --agent kit -- -m grok-4.7 -e high (kit → kit)", sg.code === 0 || /never reached the mesh|still starting/.test(sg.err), tail(sg.out + sg.err, 4));
  ok("…prints the replaced kitArgs + an undo back to the previous flags", sg.out.includes(`kitArgs: ["-m","grok-4.7","-e","high"]`) && sg.out.includes(`undo: paw restart ${A} --agent kit -- -P fake:codex -e high`), sg.out.split("\n")[0]);
  ok("persona kitArgs replaced verbatim", JSON.stringify(readKitArgs(a.file)) === '["-m","grok-4.7","-e","high"]' && personaValue(a.file, "storage") === "claude");
  const pg = await until(() => (kitProc(A)?.cmd.includes("grok-4.7") ? kitProc(A) : undefined), 30_000);
  ok("kit run carries -m grok-4.7 -e high verbatim, same pin, --overwrite", !!pg && pg.cmd.endsWith(`--resume ${a.pin} -m grok-4.7 -e high`) && pg.cmd.includes("--overwrite"), pg?.cmd ?? "no kit run process (it may have exited: no grok login here)");
  const sm = paw("restart", A, "--agent", "kit", "--model", "grok-4.7", "--space", space);
  ok("restart --agent kit --model grok-4.7 (kit → kit, --model before --)", sm.code === 0, tail(sm.out + sm.err, 4));
  ok("…kitArgs = [--model, grok-4.7] (replaced)", JSON.stringify(readKitArgs(a.file)) === '["--model","grok-4.7"]', front(a.file));
  const pm = await until(() => (kitProc(A)?.cmd.endsWith("--model grok-4.7") ? kitProc(A) : undefined), 30_000);
  ok("…and kit run ends with --model grok-4.7", !!pm, kitProc(A)?.cmd);

  // flags kit parses but refuses at launch (-P contradicting -m): the error names kit's exit + the flags
  const sx = paw("restart", A, "--agent", "kit", "--space", space, "--", "-P", "codex", "-m", "grok-4.7");
  ok(
    "kit refusing its flags at launch fails loud, naming the exit and the kitArgs",
    sx.code !== 0 && /kit exited at launch \(.*exit code [12]/.test(sx.err) && sx.err.includes('kitArgs: ["-P","codex","-m","grok-4.7"]'),
    tail(sx.err, 2),
  );

  // ── 3 fail loud, persona untouched ─────────────────────────────────────────────────────────
  const snap = readFileSync(a.file, "utf8");
  const refused = (label: string, args: string[], re: RegExp) => {
    const r = paw(...args);
    ok(`refused: ${label}`, r.code !== 0 && re.test(r.err) && readFileSync(a.file, "utf8") === snap, tail(r.err, 2));
  };
  refused("unknown --agent", ["restart", A, "--agent", "gpt", "--space", space], /swaps an agent between claude and kit/);
  refused("--agent codex", ["restart", A, "--agent", "codex", "--space", space], /swaps an agent between claude and kit/);
  refused("`--` with --agent claude", ["restart", A, "--agent", "claude", "--space", space, "--", "-m", "x"], /is not kit/);
  refused("`--` without --agent", ["restart", A, "--space", space, "--", "-m", "x"], /needs --agent kit/);
  refused("a paw-owned kit flag", ["restart", A, "--agent", "kit", "--space", space, "--", "--resume", "abc"], /paw's to set/);
  refused("a flag kit doesn't know", ["restart", A, "--agent", "kit", "--space", space, "--", "-m", "grok-4.7", "-x", "1"], /does not accept.*unknown flag -x/);
  refused("a bare word (kit would stop parsing)", ["restart", A, "--agent", "kit", "--space", space, "--", "-m", "grok-4.7", "high"], /stopped reading flags/);
  refused("--model twice", ["restart", A, "--agent", "kit", "--model", "a", "--space", space, "--", "-m", "b"], /say it once/);
  refused("--agent on a runtime", ["restart", "pty", "--agent", "kit", "--space", space], /name it/);
  refused("a mismatched space", ["restart", `${A}#${space}`, "--agent", "kit", "--space", "paw"], /--space says "paw"/);

  // ── 4 back to claude ───────────────────────────────────────────────────────────────────────
  const bk = paw("restart", A, "--agent", "claude", "--space", space);
  // the stub claude never shows cotal's dev-channels prompt, so its seat is reaped — the persona + argv are the check
  ok("restart --agent claude (stub claude: the seat can't come up)", bk.code === 0 || /never reached the mesh|still starting/.test(bk.err), tail(bk.out + bk.err, 4));
  ok(
    "…prints the removed kit keys + undo",
    bk.out.includes(`persona ${A}: removed agent: kit, kitArgs: ["-P","codex","-m","grok-4.7"], storage: claude (saved; undo: paw restart ${A} --agent kit -- -P codex -m grok-4.7)`),
    bk.out.split("\n")[0],
  );
  ok(
    "persona: no agent/kitArgs/storage, pin kept",
    readAgentType(a.file) === undefined && personaValue(a.file, "kitArgs") === undefined && personaValue(a.file, "storage") === undefined && readResumeId(a.file) === a.pin,
    front(a.file),
  );
  const launched = await until(() => (existsSync(stubLog) ? readFileSync(stubLog, "utf8") : undefined), 30_000);
  ok("the manager launches claude with --resume <pin>", !!launched && launched.includes(`--resume ${a.pin}`), launched?.slice(0, 300));
  ok("…and no kit run is left for it", !kitProc(A));
  paw("stop", A, "--space", space);

  // ── 5 no pin ───────────────────────────────────────────────────────────────────────────────
  const N = "pinless";
  const nfolder = realpathSync(mkdtempSync(join(tmpdir(), "kit-pinless-")));
  setFolderName(space, nfolder, N);
  const np = paw("restart", N, "--agent", "kit", "--space", space, "--", "-P", "fake:codex");
  ok("a claude agent with no resume: pin → swaps, minting a fresh pin", np.code === 0 && np.out.includes("FRESH session"), tail(np.out + np.err, 4));
  const npin = readResumeId(personaFilePath(space, N));
  ok("…the pin is in the persona", !!npin && /^[0-9a-f-]{36}$/.test(npin), npin);
  const kn = await until(() => kitProc(N), 30_000);
  ok("…and kit runs on that pin", !!kn && kn.cmd.includes(npin!), kn?.cmd);

  // ── 6 `.`, <name>#<space>, an unchanged swap ──────────────────────────────────────────────
  const sd = pawIn({ cwd: a.folder }, "restart", ".", "--agent", "kit", "--space", space, "--", "-P", "fake:codex");
  ok("restart . --agent kit (from the agent's folder) swaps THAT agent", sd.code === 0 && sd.out.includes(`persona ${A}: agent: kit`), tail(sd.out + sd.err, 4));
  ok("…printing what it waits on", sd.out.includes(`starting ${A} on kit…`) && sd.out.includes("waiting up to 60s"), tail(sd.out, 4));
  const k6 = await until(() => kitProc(A), 30_000);
  ok("…kit runs it", !!k6 && k6.cmd.endsWith("-P fake:codex"), k6?.cmd);
  const other = `${space}-other`;
  const sh = pawIn({ env: { PAW_SPACE: other } }, "restart", `${A}#${space}`, "--agent", "kit", "--", "-P", "fake:codex");
  ok(
    "restart <name>#<space> from another PAW_SPACE, same flags: unchanged, restarted anyway",
    sh.code === 0 && sh.out.includes("already kit with these flags, unchanged") && sh.out.includes(`restarting ${A} anyway`) && sh.out.includes(`restarted ${A}`),
    tail(sh.out + sh.err, 4),
  );
  const k6b = await until(() => (kitProc(A) && kitProc(A)!.pid !== k6?.pid ? kitProc(A) : undefined), 30_000);
  ok("…a NEW kit process (the restart verb restarts)", !!k6b, `${k6?.pid} → ${kitProc(A)?.pid}`);
  ok("…and nothing was made for the other space", !existsSync(join(process.env.PAW_HOME!, "spaces", other, "personas", `${A}.md`)));
  const nd = pawIn({ cwd: nfolder }, "restart", ".", "--agent", "kit", "--space", space, "--", "-P", "fake:codex");
  ok("restart . resolves to the folder's agent", nd.code === 0 && nd.out.includes(`restarting ${N} anyway`), tail(nd.out + nd.err, 2));
  paw("stop", N, "--space", space);
  const unreg = realpathSync(mkdtempSync(join(tmpdir(), "kit-unreg-")));
  const ud = pawIn({ cwd: unreg }, "restart", ".", "--space", space);
  ok("restart . in a folder with no agent → fails loud", ud.code !== 0 && ud.err.includes(`no agent registered for ${unreg}`), tail(ud.err, 2));

  // ── 7 a manager older than kit swaps (the ccswitch hang) ──────────────────────────────────
  const { createRelease } = await import("../../../src/release.ts");
  const old = createRelease({ root: REPO });
  rmSync(join(old.path, "src", "manager-features.json"));
  const kitTs = join(old.path, "src", "kit.ts");
  const anchor = "  const kitArgs = readKitArgs(configPath);";
  const kitSrc = readFileSync(kitTs, "utf8");
  if (!kitSrc.includes(anchor)) throw new Error(`e2e: can't plant the old kit connector — "${anchor}" is not in ${kitTs}`);
  // release 7b8139964144's readKitPersona: `provider:` required, kitArgs unknown
  const planted = "  if (!provider) throw new Error(`paw: ${configPath} is a kit agent with no provider: (old connector)`);\n";
  writeFileSync(kitTs, kitSrc.replace(anchor, planted + anchor));
  // A kit agent the OLD connector can run (provider:, no kitArgs), live when the manager bounces onto it.
  setPersonaKeys(space, A, { provider: "fake:codex", kitArgs: undefined });
  ok("seed: a provider: kit agent restarts", paw("restart", A, "--space", space).code === 0);
  const bo = pawIn({ env: { PAW_RELEASE: old.id } }, "restart", "--space", space);
  ok(`the manager restarts onto the old release ${old.id}`, bo.code === 0, tail(bo.out + bo.err, 3));
  const k7 = await until(() => kitProc(A), 60_000);
  ok("…and revives the kit agent on it", !!k7, k7?.cmd);
  const snap7 = readFileSync(a.file, "utf8");
  const t7 = Date.now();
  const r7 = paw("restart", A, "--agent", "kit", "--space", space, "--", "-m", "grok-4.7", "-e", "high");
  ok(
    "old manager: the swap is refused up front, naming the release + the fix",
    r7.code !== 0 && r7.err.includes(`release ${old.id}`) && r7.err.includes("predates it") && r7.err.includes("`paw release`, then `paw restart --space"),
    `${Math.round((Date.now() - t7) / 1000)}s ${tail(r7.err, 2)}`,
  );
  ok("…fast (no readiness wait)", Date.now() - t7 < 20_000, `${Date.now() - t7}ms`);
  ok("…persona untouched", readFileSync(a.file, "utf8") === snap7);
  ok("…and the running agent left alone", kitProc(A)?.pid === k7?.pid, `${k7?.pid} → ${kitProc(A)?.pid}`);
  // A manager that CLAIMS the feature but refuses after accepting: bounded, explained, with progress.
  writeFileSync(join(old.path, "src", "manager-features.json"), JSON.stringify({ features: ["kit-args"] }));
  setPersonaKeys(space, A, { provider: undefined, kitArgs: JSON.stringify(["-P", "fake:codex"]) }); // what the swap writes
  const t7b = Date.now();
  const r7b = paw("restart", A, "--space", space);
  const took = Math.round((Date.now() - t7b) / 1000);
  ok(
    "a post-accept connector refusal fails loud, naming the never-launched spawn, the release and the log",
    r7b.code !== 0 && r7b.err.includes("never launched a process") && r7b.err.includes(`the manager runs release ${old.id}`) && r7b.err.includes("manager.log"),
    `${took}s ${tail(r7b.err, 2)}`,
  );
  ok("…bounded", took < 150, `${took}s`);
  ok(
    "…after printing what it was waiting on",
    r7b.out.includes(`starting ${A} on kit…`) && r7b.out.includes("waiting up to 60s") && /still waiting for swapper to reach the mesh \(\d+s of 60s\)/.test(r7b.out),
    tail(r7b.out, 6),
  );
  const back = pawIn({ env: { PAW_RELEASE: "dev" } }, "restart", "--space", space);
  ok("the manager goes back to the checkout", back.code === 0, tail(back.out + back.err, 2));
} finally {
  await prober?.stop().catch(() => {});
  await stop({ space }).catch((e) => console.error("stop:", (e as Error).message));
  await sleep(1000);
  ok("down: manager + mailbox gone", managerProcs(space).length === 0 && mailboxProcs(space).length === 0);
  removeMesh(space);
  nats.kill("SIGTERM");
}
console.log(fails ? `\n${fails} FAILED` : "\ne2e passed");
process.exit(fails ? 1 : 0);
