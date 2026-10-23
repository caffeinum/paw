/**
 * `paw teleport <agent> --to fly:<app> | ssh:<host> [what] [--dry-run] [--yes]` — move an agent to
 * another box: its persona (always), and by checkmark its session chain, repo, skills, memory and
 * ~/.claude/CLAUDE.md. `paw teleport <agent> --back` returns it over the transport recorded at the time.
 * docs/notes/teleport.md has the design; the pure half is src/teleport-plan.ts, the shell half
 * src/teleport-shell.ts.
 *
 * The cutover never has two writers: preflight (reachable, paw there, the space joined, logins, folder
 * confinement, conflicts) → plan with sizes (`--dry-run` stops) → confirm → copy → stop here → copy what
 * changed during the copy → persona there → the target's own `paw start <name>` → wait until a NEW copy
 * is present on the mesh → mark this persona `teleported:` so no wake path here respawns it. A failed
 * start or wait restarts it here, loudly. Logins are never copied: a missing one refuses up front.
 *
 * `paw __teleport probe|manifest|stop|mark` (hidden) are the source-side steps `--back` runs on the
 * target's paw; a forward teleport calls the same functions in-process.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { registry, type Command, type CotalEndpoint } from "@cotal-ai/core";
import { ensureAgentSpawned, personaFilePath, psRowAlive, setPersonaKeys, stopAgent, SESSION_RELEASE_MS, type PsRow } from "./addressing.ts";
import { withManagerControl } from "./control.ts";
import { observerEndpoint } from "./feed.ts";
import { readForeground } from "./foreground.ts";
import { hosting } from "./hosted.ts";
import { ensureSpaceFor, resolveSpace, withEnsuredManager } from "./lifecycle.ts";
import { liveSessionProcs } from "./named.ts";
import { readRemoteMesh } from "./remote-mesh.ts";
import { readCwd, readResumeId } from "./session.ts";
import { pawServer } from "./server.ts";
import {
  buildManifest,
  changedSince,
  destFolder,
  placeRepo,
  remapRel,
  rewriteCwdFiles,
  transcriptRels,
  type DestFolder,
  checklistKey,
  checklistLines,
  fmtBytes,
  formatPlan,
  filesToSend,
  newChecklist,
  ORIGIN,
  parseTeleportArgs,
  parseTransport,
  readTeleported,
  teleportBlockers,
  TELEPORT_USAGE,
  transportLabel,
  withPersonaKey,
  WHAT,
  type DestFacts,
  type FileEntry,
  type Manifest,
  type TeleportArgs,
  type Transport,
  type What,
} from "./teleport-plan.ts";
import {
  checkFlyMachines,
  copyFiles,
  localSide,
  moveRepo,
  pawScript,
  probe,
  probeEnv,
  remoteSide,
  run,
  said,
  writePersonaScript,
  type Side,
} from "./teleport-shell.ts";

/** 2: the agents folder, remapped project dirs, `rewrite-cwd` (a v1 target can't take a moved folder). */
export const TELEPORT_PROTOCOL = "paw-teleport 2";
const PRESENT_MS = 180_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(s);
const loud = (s: string) => console.error(process.stderr.isTTY ? `\x1b[1;31m${s}\x1b[0m` : s);

/** Who carries the agent's name on the mesh right now, as this machine sees it. */
type MeshView = { ep: CotalEndpoint; peerId?: string; hereRow?: PsRow; hereAnswered: boolean };

async function meshView(space: string, name: string): Promise<MeshView> {
  const ep = await observerEndpoint(space, pawServer(space), { watchPresence: true });
  ep.on("error", () => {});
  await ep.start();
  const deadline = Date.now() + 3000;
  while (ep.getRoster().length === 0 && Date.now() < deadline) await sleep(100);
  const peerId = presentId(ep, name);
  let hereRow: PsRow | undefined;
  let hereAnswered = false;
  try {
    const ps = await withManagerControl(space, pawServer(space), (ctl) => ctl.ps(), { resolveMs: 5000 });
    hereAnswered = ps.ok;
    hereRow = ps.ok ? ((ps.data as PsRow[]) ?? []).find((r) => r.name === name) : undefined;
  } catch {
    hereAnswered = false;
  }
  return { ep, ...(peerId ? { peerId } : {}), ...(hereRow ? { hereRow } : {}), hereAnswered };
}

function presentId(ep: CotalEndpoint, name: string, not?: string): string | undefined {
  const want = name.toLowerCase();
  return ep.getRoster().find((p) => p.card.name.toLowerCase() === want && p.status !== "offline" && p.card.id !== not)?.card.id;
}

/** The mesh half of preflight: an agent another machine runs is that machine's to move. */
function meshBlockers(space: string, name: string, v: MeshView): string[] {
  const runningHere = v.hereRow !== undefined && psRowAlive(v.hereRow);
  if (runningHere) {
    const h = hosting(space, name, v.hereRow);
    return h.here ? [] : [`"${name}" is not this machine's to move (${h.why})`];
  }
  if (v.peerId && v.hereAnswered) return [`"${name}" is present on the mesh (${v.peerId}) but this machine's manager does not run it — it runs elsewhere; teleport it from there`];
  if (v.peerId) return [`"${name}" is present on the mesh (${v.peerId}) and this machine's manager isn't answering — can't tell where it runs`];
  return [];
}

async function waitPresent(ep: CotalEndpoint, name: string, oldId: string | undefined, ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const id = presentId(ep, name, oldId);
    if (id) return id;
    if (Date.now() >= deadline) return undefined;
    await sleep(500);
  }
}

/** Stop the agent here and wait for its claude to let go of the session file. */
export async function stopHere(space: string, name: string, pin: string | undefined): Promise<{ wasLive: boolean; released: boolean }> {
  const wasLive = await withEnsuredManager(space, (ctl) => stopAgent(ctl, name), { ensureSpace: ensureSpaceFor(space) });
  const deadline = Date.now() + SESSION_RELEASE_MS;
  while (pin && liveSessionProcs(pin).length && Date.now() < deadline) await sleep(1000);
  return { wasLive, released: !pin || liveSessionProcs(pin).length === 0 };
}

async function startHere(space: string, name: string, cwd: string): Promise<void> {
  const r = await withEnsuredManager(space, (ctl) => ensureAgentSpawned(ctl, { space, name, cwd, reuseUnmanaged: false, restartLive: "allow" }), { ensureSpace: ensureSpaceFor(space) });
  if (r.stuck) throw new Error(`paw: "${name}" is stuck starting here: ${r.stuck}`);
}

/** Did `paw start`'s summary list `name` as started (or already live)? It exits 0 when it skips one. */
export function startedLine(out: string, name: string): boolean {
  return out.split("\n").some((l) => {
    const m = /^\s*(started|already live):\s+(.*)$/.exec(l);
    return m !== null && m[2].split(/,\s*/).some((n) => n.split(" ")[0] === name);
  });
}

function fail(msg: string): never {
  throw new Error(msg);
}

function pawHomeDir(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.teleport-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** The checklist on a tty; nothing given on a pipe refuses (a script must say what it moves). */
async function askWhat(): Promise<What[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`paw: say what moves — --all, or any of ${WHAT.map((w) => `--${w}`).join(" ")} (no terminal to ask on)`);
  let s = newChecklist();
  const draw = (first: boolean) => {
    const lines = checklistLines(s);
    if (!first) process.stdout.write(`\x1b[${lines.length}A`);
    for (const l of lines) process.stdout.write(`\x1b[2K${l}\n`);
  };
  draw(true);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    await new Promise<void>((resolve) => {
      const onData = (d: Buffer) => {
        s = checklistKey(s, d.toString("utf8"));
        draw(false);
        if (s.done || s.cancelled) {
          stdin.off("data", onData);
          resolve();
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  if (s.cancelled) throw new Error("paw: teleport cancelled — nothing was copied");
  return WHAT.filter((w) => s.on[w]);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(question, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** The persona text that lands on the destination. Without --session the destination keeps ITS pin
 *  (a copy it ran before) or gets a fresh one — never the source's id with no transcript behind it. */
function destPersona(m: Manifest, what: What[], destPersonaText: string | undefined): { text: string; note?: string } {
  if (what.includes("session") || !m.pin) return { text: m.persona };
  const theirs = destPersonaText?.match(/^---\n[\s\S]*?^resume:\s*(\S+)/m)?.[1]?.replace(/^["']|["']$/g, "");
  const pin = theirs ?? randomUUID();
  return { text: withPersonaKey(m.persona, "resume", pin), note: `resume: ${pin} (${theirs ? "the copy there kept its own session" : "a fresh session — --session not moved"})` };
}

/** One line per moved group: where it landed (the group's common dir, at its destination path), how many
 *  files, how big. */
function groupLines(home: string, m: Manifest, sent: Set<string>, cwd: string): string[] {
  return Object.entries(m.groups)
    .map(([group, fs]) => [group, fs.filter((f) => sent.has(f.rel)).map((f) => ({ ...f, rel: remapRel(f.rel, m, cwd) }))] as const)
    .filter(([, fs]) => fs.length)
    .map(([group, fs]) => {
      const parts = fs.map((f) => f.rel.split("/"));
      const common: string[] = [];
      for (let i = 0; parts.every((p) => p.length > i + 1 && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
      const where = fs.length === 1 ? fs[0].rel : `${common.join("/")}/`;
      return `    ${group.padEnd(9)} ${home}/${where}  ${fs.length} file(s), ${fmtBytes(fs.reduce((n, f) => n + f.bytes, 0))}`;
    });
}

// ── the source side, local or over the transport ───────────────────────────────────────────────────

/** The source-side steps. Here: in-process. On `--back`: the target's `paw __teleport …`. */
type Source = {
  side: Side;
  manifest(what: What[]): Promise<Manifest>;
  stop(pin: string | undefined): Promise<{ wasLive: boolean; released: boolean }>;
  restart(m: Manifest): Promise<void>;
  /** After a successful cutover: this copy must never wake again. `cwd` = the folder it runs in there. */
  markGone(to: string, what: What[], cwd: string): Promise<string>;
};

function localSource(space: string, name: string, label: string): Source {
  const file = personaFilePath(space, name);
  return {
    side: localSide(label),
    manifest: async (what) => buildManifest({ space, name, personaFile: file, what }),
    stop: (pin) => stopHere(space, name, pin),
    restart: (m) => startHere(space, name, m.cwd),
    markGone: async (to, what, cwd) => {
      const keys = { teleported: to, teleportedAt: new Date().toISOString(), teleportedWhat: what.join(","), teleportedCwd: cwd };
      setPersonaKeys(space, name, keys);
      return `${file}: ${Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join(", ")}`;
    },
  };
}

function remoteSource(t: Transport, space: string, name: string): Source {
  const side = remoteSide(t);
  const paw = async (args: string[]) => {
    const r = await run(side, pawScript(args));
    if (r.code !== 0) throw new Error(`paw: \`paw ${args.join(" ")}\` on ${side.label} failed: ${said(r) || `exit ${r.code}`}`);
    return r.stdout.toString("utf8");
  };
  const json = <T>(out: string): T => JSON.parse(out.trim().split("\n").pop()!) as T;
  return {
    side,
    manifest: async (what) => json<Manifest>(await paw(["__teleport", "manifest", name, "--what", what.join(","), "--space", space])),
    stop: async () => json(await paw(["__teleport", "stop", name, "--space", space])),
    restart: async () => void (await paw(["start", name, "--space", space])),
    markGone: async (to) => (await paw(["__teleport", "mark", name, "--to", to, "--space", space])).trim(),
  };
}

// ── the destination side ───────────────────────────────────────────────────────────────────────────

type Dest = {
  side: Side;
  env(): Promise<{ home: string; pawHome: string }>;
  facts(m: Manifest, what: What[], folder: DestFolder): Promise<DestFacts>;
  /** `mkdir` = the agents folder to create first. */
  writePersona(text: string, mkdir?: string): Promise<string>;
  /** Rewrite the `cwd` fields of these HOME-relative transcripts there; returns the lines changed. */
  rewriteCwd(rels: string[], from: string, to: string): Promise<number>;
  start(cwd: string): Promise<void>;
  /** Rollback: the copy there must not run (best effort, reported). */
  standDown(): Promise<string>;
};

function remoteDest(t: Transport, space: string, name: string): Dest {
  const side = remoteSide(t);
  const paw = (args: string[]) => run(side, pawScript(args));
  return {
    side,
    env: () => probeEnv(side),
    facts: (m, what, folder) => probe(side, m, what, folder),
    writePersona: async (text, mkdir) => {
      const r = await run(side, writePersonaScript(space, name, mkdir), text);
      if (r.code !== 0) throw new Error(`paw: writing the persona on ${side.label} failed: ${said(r) || `exit ${r.code}`}`);
      return r.stdout.toString("utf8").trim();
    },
    rewriteCwd: async (rels, from, to) => {
      const r = await run(side, pawScript(["__teleport", "rewrite-cwd", "--from", from, "--to", to, "--space", space]), rels.join("\n") + "\n");
      if (r.code !== 0) throw new Error(`paw: rewriting transcript cwds on ${side.label} failed: ${said(r) || `exit ${r.code}`}`);
      return (JSON.parse(r.stdout.toString("utf8").trim().split("\n").pop()!) as { changed: number }).changed;
    },
    start: async () => {
      const r = await paw(["start", name, "--space", space]);
      process.stdout.write(r.stdout.toString("utf8").replace(/^(?=.)/gm, `  [${side.label}] `));
      if (r.code !== 0) throw new Error(`paw: \`paw start ${name}\` on ${side.label} failed: ${said(r) || `exit ${r.code}`}`);
      const out = r.stdout.toString("utf8");
      if (!startedLine(out, name)) throw new Error(`paw: \`paw start ${name}\` on ${side.label} did not start it:\n${out.trim()}`);
    },
    standDown: async () => {
      const stop = await paw(["stop", name, "--space", space]);
      const mark = await paw(["__teleport", "mark", name, "--to", ORIGIN, "--space", space]);
      return `stop: ${stop.code === 0 ? "ok" : said(stop) || `exit ${stop.code}`}; mark: ${mark.code === 0 ? "ok" : said(mark) || `exit ${mark.code}`}`;
    },
  };
}

function localDest(space: string, name: string, label: string): Dest {
  const side = localSide(label);
  const file = personaFilePath(space, name);
  return {
    side,
    env: async () => ({ home: homedir(), pawHome: pawHomeDir() }),
    facts: async (m, what, folder) => ({ ...(await probe(side, m, what, folder)), paw: process.argv[1], teleportSupport: true }),
    writePersona: async (text, mkdir) => {
      if (mkdir) mkdirSync(mkdir, { recursive: true });
      writeFileAtomic(file, text);
      return file;
    },
    rewriteCwd: async (rels, from, to) => rewriteCwdFiles(homedir(), rels, from, to),
    start: (cwd) => startHere(space, name, cwd),
    standDown: async () => {
      const r = await stopHere(space, name, undefined);
      return `stop: ${r.wasLive ? "stopped" : "was not running"}`;
    },
  };
}

// ── the cutover ────────────────────────────────────────────────────────────────────────────────────

type Cutover = {
  space: string;
  name: string;
  what: What[];
  source: Source;
  dest: Dest;
  /** Where the agent goes, as the source's marker says it (a transport, or `origin`). */
  markTo: string;
  /** Printed as the way back. */
  undo: string;
  back: boolean;
  dryRun: boolean;
  yes: boolean;
  /** `--back`: put this machine's persona (and its marker) back if the start here fails. */
  restoreDestPersona?: () => void;
  /** `--back`: the folder it left from (this persona's `cwd:`). */
  original?: string;
};

async function cutover(c: Cutover, transport: Transport): Promise<void> {
  const { space, name, what } = c;
  const m = await c.source.manifest(what);
  const proposed = destFolder(m, what, await c.dest.env(), c.original);
  const facts = await c.dest.facts(m, what, proposed);
  const placed = placeRepo(m, what, proposed, facts);
  const folder = placed.folder;
  const moved = folder.cwd !== m.cwd;
  const pairs = (man: Manifest, fs: FileEntry[]) => fs.map((f) => ({ src: f.rel, dst: remapRel(f.rel, man, folder.cwd) }));
  /** Send files, then point their transcripts' cwd at the new folder. */
  const send = async (man: Manifest, fs: FileEntry[]) => {
    await copyFiles(c.source.side, c.dest.side, pairs(man, fs));
    const rels = transcriptRels(fs, man).map((r) => remapRel(r, man, folder.cwd));
    if (moved && rels.length) log(`  rewrote ${await c.dest.rewriteCwd(rels, man.cwd, folder.cwd)} cwd field(s) in ${rels.length} transcript(s): ${man.cwd} → ${folder.cwd}`);
  };
  const view = await meshView(space, name);
  try {
    const ctx = { what, dest: facts, folder, ...(c.back ? {} : { transport }), back: c.back, sourceServer: readRemoteMesh(space)?.server };
    const blockers = [...placed.blockers, ...teleportBlockers(m, ctx), ...(c.back ? [] : meshBlockers(space, name, view))];
    const persona = destPersona(m, what, facts.personaText);
    for (const l of formatPlan(m, { ...ctx, from: c.source.side.label })) log(l);
    if (persona.note) log(`  pin        ${persona.note}`);
    log(`  cutover    stop ${name} on ${c.source.side.label} → \`paw start ${name}\` on ${c.dest.side.label} → wait until present → mark ${c.source.side.label}'s persona teleported`);
    if (blockers.length) {
      log("");
      log(`blocked — ${blockers.length} thing(s) to fix first:`);
      for (const b of blockers) log(`  ✗ ${b}`);
      throw new Error(`paw: teleport ${name} is blocked (${blockers.length}) — nothing was copied`);
    }
    if (c.dryRun) {
      log("");
      log("dry run — preflight passed; nothing was copied, stopped or started");
      return;
    }
    if (!c.yes) {
      if (!process.stdin.isTTY) throw new Error("paw: no terminal to confirm on — pass --yes to teleport unattended");
      if (!(await confirm(`teleport ${name} to ${c.dest.side.label}? [y/N] `))) throw new Error("paw: teleport cancelled — nothing was copied");
    }

    const files = filesToSend(m, facts);
    log(`→ copying ${files.length} file(s), ${fmtBytes(files.reduce((n, f) => n + f.bytes, 0))} …`);
    await send(m, files);
    let repoLine: string | undefined;
    if (m.repo && what.includes("repo")) {
      log(`→ mirroring ${m.repo.top} to ${folder.top} …`);
      repoLine = await moveRepo(c.source.side, c.dest.side, m.repo, folder);
    }

    log(`→ stopping ${name} on ${c.source.side.label} …`);
    const stopped = await c.source.stop(m.pin);
    if (!stopped.released) {
      await c.source.restart(m).catch((e: Error) => loud(`  and restarting it there failed too: ${e.message}`));
      throw new Error(`paw: ${name}'s claude on ${c.source.side.label} still held session ${m.pin} ${SESSION_RELEASE_MS / 1000}s after the stop — restarted it there; nothing moved over`);
    }

    // What the agent wrote while the bulk copy ran.
    let after: Manifest;
    try {
      after = await c.source.manifest(what);
    } catch (e) {
      await rollback(c, m, `re-reading ${name} after the stop failed: ${(e as Error).message}`, false);
      throw e;
    }
    const delta = changedSince(files, filesToSend(after, facts));
    if (delta.length) {
      log(`→ copying ${delta.length} file(s) written during the copy …`);
      await send(after, delta);
    }
    if (after.repo && what.includes("repo") && after.repo.head !== m.repo?.head) {
      log(`→ ${name} committed during the copy — mirroring ${after.repo.head.slice(0, 12)} …`);
      repoLine = await moveRepo(c.source.side, c.dest.side, after.repo, folder);
    }

    const text = withPersonaKey(destPersona(after, what, facts.personaText).text, "cwd", folder.cwd);
    const written = await c.dest.writePersona(text, folder.how === "agents" ? folder.cwd : undefined);
    log(`→ starting ${name} on ${c.dest.side.label} in ${folder.cwd} …`);
    try {
      await c.dest.start(folder.cwd);
    } catch (e) {
      await rollback(c, after, (e as Error).message, true);
      throw new Error(`paw: teleport ${name} failed at the start on ${c.dest.side.label} — it runs on ${c.source.side.label} again`);
    }
    log(`→ waiting until ${name} is present on the mesh (up to ${PRESENT_MS / 1000}s) …`);
    const id = await waitPresent(view.ep, name, view.peerId, PRESENT_MS);
    if (!id) {
      await rollback(c, after, `${name} did not appear on the mesh within ${PRESENT_MS / 1000}s`, true);
      throw new Error(`paw: teleport ${name} failed — it never came up on ${c.dest.side.label}; it runs on ${c.source.side.label} again`);
    }
    const marked = await c.source.markGone(c.markTo, what, folder.cwd);

    log("");
    log(`✓ teleported ${name}: ${c.source.side.label} → ${c.dest.side.label} (present on the mesh as ${id})`);
    log(`  written on ${c.dest.side.label}:`);
    log(`    persona   ${written}${moved ? `  (cwd: ${folder.cwd})` : ""}`);
    if (folder.how === "agents") log(`    folder    ${folder.cwd}  (created; ${m.cwd} stays here)`);
    for (const l of groupLines(facts.home, after, new Set([...files, ...delta].map((f) => f.rel)), folder.cwd)) log(l);
    if (repoLine) log(`    repo      ${folder.top}  ${after.repo!.url} → ${repoLine}`);
    log(`  written on ${c.source.side.label}:`);
    log(`    ${marked}`);
    log(`  stopped on ${c.source.side.label}: ${stopped.wasLive ? name : `${name} (it was not running)`} — its transcript and files there are left as they were`);
    log(`  undo: ${c.undo}`);
  } finally {
    await view.ep.stop().catch(() => {});
  }
}

/** A start or presence wait failed: the destination copy stands down, the source copy comes back. */
async function rollback(c: Cutover, m: Manifest, why: string, destTouched: boolean): Promise<void> {
  loud(`✗ teleport ${c.name}: ${why}`);
  if (destTouched) {
    const r = await c.dest.standDown().catch((e: Error) => `failed: ${e.message}`);
    loud(`  ${c.dest.side.label}: ${r}`);
  }
  c.restoreDestPersona?.();
  try {
    await c.source.restart(m);
    loud(`  restarted ${c.name} on ${c.source.side.label} — it runs on ${c.source.side.label} again`);
  } catch (e) {
    loud(`  restarting ${c.name} on ${c.source.side.label} FAILED: ${(e as Error).message} — start it by hand: paw start ${c.name} --space ${c.space}`);
  }
}

function whatFlags(what: What[]): string {
  return what.length === WHAT.length ? "--all" : what.map((w) => `--${w}`).join(" ");
}

export async function teleport(a: TeleportArgs): Promise<void> {
  const space = a.space?.trim() || resolveSpace();
  const name = a.name;
  const file = personaFilePath(space, name);
  if (!existsSync(file)) throw new Error(`paw: no agent "${name}" in space "${space}" (\`paw status\` lists them)`);
  const record = readRemoteMesh(space);
  if (!record)
    throw new Error(
      `paw: "${name}" is on space "${space}", which only this machine serves — teleport v1 moves agents on a space the target's paw joins too (a remote mesh: \`paw mesh ls\`)`,
    );
  if (readForeground(space, name)) throw new Error(`paw: "${name}" is a foreground \`paw claude\` in a terminal here — close it first`);
  const mark = readTeleported(file);

  if (a.back) {
    if (!mark) throw new Error(`paw: "${name}" was not teleported from here (no \`teleported:\` in ${file}) — nothing to bring back`);
    if (mark.to === ORIGIN) throw new Error(`paw: "${name}" here is the copy it was brought back FROM (teleported: ${ORIGIN}) — run --back on the machine that sent it`);
    const transport = parseTransport(mark.to);
    checkFlyMachines(transport);
    const probed = await run(remoteSide(transport), pawScript(["__teleport", "probe"]));
    if (!probed.stdout.toString("utf8").includes(TELEPORT_PROTOCOL))
      throw new Error(`paw: ${mark.to}'s paw does not answer \`paw __teleport probe\` (${said(probed) || `exit ${probed.code}`}) — --back needs paw teleport there`);
    const original = readFileSync(file, "utf8");
    const what = mark.what.length ? mark.what : [];
    await cutover(
      {
        space,
        name,
        what,
        source: remoteSource(transport, space, name),
        dest: localDest(space, name, "this machine"),
        markTo: ORIGIN,
        undo: `paw teleport ${name} --to ${mark.to}${what.length ? ` ${whatFlags(what)}` : ""}`,
        back: true,
        dryRun: a.dryRun,
        yes: a.yes,
        restoreDestPersona: () => writeFileAtomic(file, original),
        original: readCwd(file) ?? fail(`paw: ${file} has no \`cwd:\` — where it came from is unknown, so --back has nowhere to put it`),
      },
      transport,
    );
    return;
  }

  if (mark) throw new Error(`${`paw: "${name}" already left — teleported to ${mark.to}${mark.at ? ` at ${mark.at}` : ""}`}; \`paw teleport ${name} --back\` first`);
  const transport = a.to!;
  checkFlyMachines(transport);
  const what = a.what ?? (await askWhat());
  const label = transportLabel(transport);
  await cutover(
    {
      space,
      name,
      what,
      source: localSource(space, name, "this machine"),
      dest: remoteDest(transport, space, name),
      markTo: label,
      undo: `paw teleport ${name} --back`,
      back: false,
      dryRun: a.dryRun,
      yes: a.yes,
    },
    transport,
  );
}

// ── hidden: the source-side steps `--back` runs here, from the other machine ───────────────────────

export async function teleportRemoteOp(argv: string[]): Promise<void> {
  const [op, ...rest] = argv;
  if (op === "probe") return void console.log(TELEPORT_PROTOCOL);
  let name: string | undefined;
  let space: string | undefined;
  let what: What[] = [];
  let to: string | undefined;
  let from: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x === "--space") space = rest[++i];
    else if (x === "--what") what = (rest[++i] ?? "").split(",").filter((w): w is What => (WHAT as readonly string[]).includes(w));
    else if (x === "--to") to = rest[++i];
    else if (x === "--from") from = rest[++i];
    else if (!x.startsWith("-") && !name) name = x;
    else throw new Error(`paw: __teleport ${op}: unexpected "${x}"`);
  }
  if (op === "rewrite-cwd") {
    if (!from || !to) throw new Error("paw: __teleport rewrite-cwd needs --from and --to");
    const rels = readFileSync(0, "utf8").split("\n").filter(Boolean);
    return void console.log(JSON.stringify({ changed: rewriteCwdFiles(homedir(), rels, from, to) }));
  }
  if (!name) throw new Error(`paw: __teleport ${op} needs an agent name`);
  const sp = space?.trim() || resolveSpace();
  const file = personaFilePath(sp, name);
  if (op === "manifest") return void console.log(JSON.stringify(buildManifest({ space: sp, name, personaFile: file, what })));
  if (op === "stop") {
    if (!existsSync(file)) throw new Error(`paw: no agent "${name}" in space "${sp}"`);
    return void console.log(JSON.stringify(await stopHere(sp, name, readResumeId(file))));
  }
  if (op === "mark") {
    if (!to) throw new Error("paw: __teleport mark needs --to");
    if (!existsSync(file)) throw new Error(`paw: no agent "${name}" in space "${sp}"`);
    const keys = { teleported: to, teleportedAt: new Date().toISOString() };
    setPersonaKeys(sp, name, keys);
    return void console.log(`${file}: ${Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  throw new Error(`paw: __teleport: unknown op "${op}"`);
}

const teleportCommand: Command = {
  kind: "command",
  name: "teleport",
  group: "Lifecycle",
  summary: "move an agent to another box (fly:<app> | ssh:<host>) — persona + chosen session/repo/skills/memory/CLAUDE.md; --back returns it",
  usage: TELEPORT_USAGE,
  run: (a) => teleport(parseTeleportArgs([...a.raw])),
};

const teleportOpCommand: Command = {
  kind: "command",
  name: "__teleport",
  group: "Lifecycle",
  hidden: true,
  summary: "teleport's source-side steps, run over the transport by the other machine's `paw teleport --back`",
  usage: "__teleport probe | manifest <name> --what a,b | stop <name> | mark <name> --to <where> | rewrite-cwd --from <dir> --to <dir> (HOME-relative transcripts on stdin)",
  run: (a) => teleportRemoteOp([...a.raw]),
};

registry.register(teleportCommand);
registry.register(teleportOpCommand);
