/**
 * `paw adopt [folder] [--resume <id|name>]` — bring a PAST or RUNNING claude session back as a paw
 * mesh agent, in one step.
 *
 * A session you ran in a plain terminal isn't on the mesh (no cotal tools, no presence), so it can't
 * be messaged. Adopt re-files it as paw's persona for the folder with a `resume:` id: the connector
 * then launches it with `--resume <id>` + the mesh wiring, so the conversation continues as a live,
 * addressable peer. Adopt then BRINGS IT UP — `ensure({needMesh,needManager})` + `ensureAgentSpawned`,
 * confirmed live over the manager's ps — unless you pass `--no-start`, which is the pin-only/local
 * path. (This header used to claim adopt was LOCAL and "never touches the mesh"; that stopped being
 * true when the spawn moved in here, and the stale sentence outlived the behaviour by months.)
 *
 * Safety: a session is stored under `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, but that encoding
 * is lossy (e.g. `my.repo` and `my-repo` collide), so adopt VERIFIES the transcript's recorded `cwd`
 * matches the folder before resuming — never resume the wrong project.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER, registry, type Command } from "@cotal-ai/core";
import {
  assertUnambiguousTarget,
  ensureAgentSpawned,
  folderToName,
  lookupFolderName,
  registerInstance,
  personaFilePath,
  restartAgent,
  setFolderName,
  stopAgent,
  waitForMeshLive,
} from "./addressing.js";
import { withManagerControl } from "./control.js";
import { readResumeId } from "./session.js";
import { adoptInFlight, adoptLogPath, ensure, finishDetachedAdopt, resolveSpace, spawnDetachedAdopt } from "./lifecycle.js";
import { isSelfAncestor, liveSessionProcs, namesForFolder, resolveNamedSession, selfSessionProc } from "./named.js";
import { tailRead } from "./transcript.js";
import { resolveExistingFolderArg } from "./address.js";
import { attachResolved } from "./open.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Find which folder a session id belongs to by scanning every claude project dir — so adopt can point
 *  you at the right folder when you give an id recorded under a different worktree. */
function locateSession(sessionId: string): string | undefined {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return undefined;
  for (const d of readdirSync(projects)) {
    if (existsSync(join(projects, d, `${sessionId}.jsonl`))) return transcriptCwd(join(projects, d), sessionId);
  }
  return undefined;
}

/** claude stores a folder's sessions under `~/.claude/projects/<encoded-cwd>/`, where the cwd is
 *  encoded by replacing every non-`[A-Za-z0-9_]` char with `-` (underscores kept). */
export function claudeProjectDir(canonical: string): string {
  return join(homedir(), ".claude", "projects", canonical.replace(/[^A-Za-z0-9_]/g, "-"));
}

/** The most-recently-modified session id (jsonl basename) in a project dir, or undefined. */
export function latestSession(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { id: string; mtime: number } | undefined;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const mtime = statSync(join(dir, f)).mtimeMs;
    if (!best || mtime > best.mtime) best = { id: f.slice(0, -".jsonl".length), mtime };
  }
  return best?.id;
}

/** The `cwd` a transcript was recorded at (first record that carries one), for the verify step. */
export function transcriptCwd(dir: string, sessionId: string): string | undefined {
  const file = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as { cwd?: unknown };
      if (typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
    } catch {
      // skip non-JSON / partial lines
    }
  }
  return undefined;
}

/**
 * Pin a durable `resume: <sessionId>` into the folder-agent's persona — the single write both `adopt`
 * and `paw claude` (src/claude.ts) share, so an agent later brought up via the manager resumes the
 * SAME session. Upserts into an existing persona (keeping its body/frontmatter) or mints a fresh
 * minimal one; never clobbers a hand-customized body (personaWithResume handles both). Pure disk I/O.
 */
export function pinSession(space: string, name: string, sessionId: string): void {
  const file = personaFilePath(space, name);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  writeFileSync(file, personaWithKey(existing, name, "resume", sessionId));
}

/**
 * Persist the extra claude flags a MANAGED agent should launch with, so a restart reproduces the
 * claude the operator asked for rather than a default one. Stored as JSON (see
 * {@link import("./session.js").readClaudeArgs}); an empty list REMOVES the key rather than writing
 * `[]`, so "no extra flags" and "never asked for any" are the same state on disk.
 */
export function pinClaudeArgs(space: string, name: string, args: string[]): void {
  const file = personaFilePath(space, name);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  writeFileSync(file, personaWithKey(existing, name, "claudeArgs", args.length ? JSON.stringify(args) : undefined));
}

/** Set/replace one frontmatter key in an existing persona (preserving the rest), or build a fresh
 *  minimal persona. Keeps a hand-customized persona body intact across re-adoption. `value`
 *  undefined REMOVES the key. */
function personaWithKey(existing: string | undefined, name: string, key: string, value: string | undefined): string {
  if (existing) {
    // Normalize CRLF so the frontmatter regex (LF-anchored) matches a Windows-authored persona —
    // otherwise it would fall through and silently discard the body.
    const normalized = existing.replace(/\r\n/g, "\n");
    const fm = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fm) {
      const lines = fm[1].split("\n").filter((l) => !l.trimStart().startsWith(`${key}:`));
      if (!lines.some((l) => l.trimStart().startsWith("name:"))) lines.unshift(`name: ${name}`);
      if (value !== undefined) lines.push(`${key}: ${value}`);
      return `---\n${lines.join("\n")}\n---\n${fm[2]}`;
    }
    // Existing content with no parseable frontmatter — never clobber it: keep it as the persona body
    // and prepend the frontmatter (name + resume) above it.
    const head = value === undefined ? `name: ${name}` : `name: ${name}\n${key}: ${value}`;
    return `---\n${head}\n---\n${normalized.trim()}\n`;
  }
  const head = value === undefined ? `name: ${name}` : `name: ${name}\n${key}: ${value}`;
  return `---\n${head}\n---\nYou are the paw agent for the "${name}" folder, resumed from a prior session — a peer on the cotal mesh.\n`;
}

/**
 * Find a transcript in `dir` whose recorded name matches — claude writes `custom-title` (a `/rename`)
 * and `agent-name` records into the file itself, so the name survives the session ending.
 *
 * Reads only each file's TAIL: these records are rewritten as the session goes, so the newest copy is
 * near the end, and the transcripts here reach tens of MB. Newest file first, so a name reused across
 * sessions resolves to the one you last worked in.
 */
export function findSessionByRecordedName(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of files) {
    let tail: string;
    try {
      tail = tailRead(join(dir, f), 256 * 1024);
    } catch {
      continue; // an unreadable transcript is not a match, and not a reason to stop looking
    }
    for (const line of tail.split("\n")) {
      if (!line.includes(name)) continue; // cheap pre-filter before parsing a large record
      try {
        const rec = JSON.parse(line) as { type?: string; customTitle?: string; agentName?: string };
        if ((rec.type === "custom-title" && rec.customTitle === name) || (rec.type === "agent-name" && rec.agentName === name))
          return f.replace(/\.jsonl$/, "");
      } catch {
        /* a truncated line proves nothing */
      }
    }
  }
  return undefined;
}

export function parseArgs(argv: string[]): { space?: string; session?: string; target?: string; noStart?: boolean; force?: boolean; name?: string; noAttach?: boolean } {
  const out: { space?: string; session?: string; target?: string; noStart?: boolean; force?: boolean; name?: string; noAttach?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = argv[++i];
    else if (a === "--resume" || a === "--session") out.session = argv[++i]; // --resume is the friendly name (--session kept as an alias)
    else if (a === "--no-start") out.noStart = true; // pin the resume but don't spawn (stays local)
    else if (a === "--force") out.force = true; // TAKE OVER a session open elsewhere: stop the holder, then resume
    else if (a === "--name") out.name = argv[++i]; // override the agent name (else the session/folder name)
    else if (a === "--no-attach") out.noAttach = true; // skip the auto-attach after a takeover (the detached child passes this)
    else if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — adopt takes [<folder>] [--resume <id|name>] [--name <n>] [--no-start] [--force] [--no-attach] [--space <s>]`);
    else if (out.target === undefined) out.target = a;
    else throw new Error(`paw: unexpected argument "${a}" — adopt takes a single folder`);
  }
  return out;
}

/** Clean a --name to paw's safe agent charset the way setFolderName does, so adopt can FAIL LOUD on a
 *  name that sanitizes to empty (setFolderName would otherwise silently fall back to the folder name). */
export function sanitizeAdoptName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Decide what a desired agent name means for this folder. Adopt used to route EVERY desired name
 *  through setFolderName, which REPLACES the folder's default mapping — so adopting a named session
 *  ("aws") into a folder whose default agent is "research" RENAMED research and deleted its persona,
 *  and when the name lookup failed it silently RE-PINNED research to the new session (the 2026-08-31
 *  incident: research lost its 366MB session pointer). Now: a desired name that differs from an
 *  EXISTING default becomes an EXTRA instance (agents.json) beside it — the default keeps its pin;
 *  adopt never renames (that's `paw rename`'s job). */
export type AdoptNamePlan =
  | { kind: "folder-default" }            // no desired name — the folder's default agent (registered if absent)
  | { kind: "register-default"; name: string } // desired name, folder unregistered — first registration wins
  | { kind: "repin-default"; name: string }    // desired name IS the default — re-pin it
  | { kind: "extra"; name: string };           // desired name differs from the default — its own agent
export function planAdoptName(desired: string | undefined, oldName: string | undefined): AdoptNamePlan {
  if (desired === undefined) return { kind: "folder-default" };
  const cleaned = sanitizeAdoptName(desired);
  if (!cleaned) throw new Error(`paw: name "${desired}" is empty after cleaning to the safe charset; pick a name with letters/digits`);
  if (oldName === undefined) return { kind: "register-default", name: cleaned };
  if (cleaned === oldName) return { kind: "repin-default", name: oldName };
  return { kind: "extra", name: cleaned };
}

async function adopt(argv: string[]): Promise<void> {
  const { space: spaceArg, session, target, noStart, force, name: nameFlag, noAttach } = parseArgs(argv);
  // --resume takes a session id OR a named session (`claude --session-name`/`/rename`). Both are bare
  // tokens; reject anything else BEFORE it touches the filesystem — `join(dir, x + ".jsonl")` would
  // otherwise let `../x` escape the project dir.
  if (session !== undefined && !/^[A-Za-z0-9_-]+$/.test(session)) {
    throw new Error(`paw: invalid --resume "${session}" — a session id or name is letters, digits, _ or -`);
  }
  if (nameFlag !== undefined && sanitizeAdoptName(nameFlag) === "") {
    throw new Error(`paw: --name "${nameFlag}" is empty after sanitizing — give a name with letters or digits`);
  }
  const inFlightChild = process.env.PAW_ADOPT_INFLIGHT !== undefined; // we ARE the detached self-adopt child
  const space = spaceArg ?? resolveSpace();
  assertUnambiguousTarget(space, target); // a bare token that's BOTH a known name and a folder here → fail loud
  const folder = resolveExistingFolderArg(target); // <repo>@<branch> worktree or a plain folder; a URL/gh:/web: handle fails loud (adopt never clones/mints)

  const dir = claudeProjectDir(folder);
  if (!existsSync(dir)) {
    throw new Error(`paw: no claude sessions found for ${folder} (looked in ${dir})`);
  }
  let sessionId: string;
  let resolvedSessionName: string | undefined; // --resume <name> that resolved by NAME — the name the user typed IS the session's name
  if (session) {
    // Explicit --resume: a transcript id (`<id>.jsonl` exists) OR a named session resolved via the
    // ~/.claude/sessions index (the name lives there, the transcript file stays UUID-named).
    if (existsSync(join(dir, `${session}.jsonl`))) {
      sessionId = session;
    } else {
      // The live index first, then the transcripts themselves. The index under ~/.claude/sessions is
      // keyed by PID and only describes sessions that are RUNNING — so a name that belongs to a
      // session you are not currently in resolves to nothing there, which is exactly the case
      // `--resume <name>` exists for. The name is also written INTO the transcript (`custom-title` /
      // `agent-name`), and that copy outlives the process.
      const resolved = resolveNamedSession(folder, session) ?? findSessionByRecordedName(dir, session);
      if (!resolved) {
        const elsewhere = locateSession(session); // a real id, but recorded under a different folder?
        throw new Error(
          elsewhere && elsewhere !== folder
            ? `paw: session "${session}" belongs to ${elsewhere}, not ${folder} — run \`paw adopt ${elsewhere} --resume ${session}\``
            : `paw: session "${session}" not found for ${folder} — not a transcript id, and no named session by that name was recorded here (\`paw sessions\` to list)`,
        );
      }
      if (!existsSync(join(dir, `${resolved}.jsonl`))) {
        throw new Error(`paw: named session "${session}" → ${resolved}, but no transcript ${resolved}.jsonl in ${dir}`);
      }
      console.error(`paw: resolved name "${session}" → session ${resolved}`);
      sessionId = resolved;
      resolvedSessionName = session;
    }
  } else {
    // No explicit --resume: prefer OUR OWN session when we're running INSIDE a live claude for this
    // folder (selfSessionProc — the session whose holder is an ancestor of us), so `paw adopt .` inside
    // a claude adopts THAT session authoritatively, not a guessed "latest". Otherwise auto-pick the
    // folder's NEWEST session — INCLUDING one a live claude holds; the two-writer guard below then
    // refuses + proposes `--force` (or, for a self-held session, the detached SELF-ADOPT takeover)
    // rather than silently grabbing an OLDER session and leaving the running claude behind. The detached
    // child always got its id via --resume, so it never reaches this branch (inFlightChild → skip self).
    const self = inFlightChild ? undefined : selfSessionProc(folder);
    const latest = self?.sessionId ?? latestSession(dir);
    if (!latest) throw new Error(`paw: no sessions in ${dir} to adopt`);
    sessionId = latest;
  }

  // Verify the transcript was recorded at this folder — the project-dir encoding is lossy, so this
  // guards against resuming a different project's session. Absent cwd → can't verify; warn, proceed.
  const tcwd = transcriptCwd(dir, sessionId);
  if (tcwd) {
    const real = existsSync(tcwd) ? realpathSync(tcwd) : tcwd;
    if (real !== folder) {
      throw new Error(
        `paw: session ${sessionId} was recorded at ${tcwd}, not ${folder} — refusing to resume the wrong project`,
      );
    }
  } else {
    console.error(`paw: couldn't read a cwd from session ${sessionId} — adopting unverified`);
  }

  // Live standalone claudes holding this session — the two-writer hazard, and what a takeover kills.
  const foreign = liveSessionProcs(sessionId).filter((p) => !p.mesh);
  const foreignPids = foreign.map((p) => p.pid).join(", ");
  // Are we running INSIDE one of those holders? (An ancestor — killing it inline would kill this command.)
  const selfHolder = inFlightChild ? undefined : foreign.find((p) => isSelfAncestor(p.pid));

  // ── SELF-ADOPT: `paw adopt .` from inside the very claude that holds this session. We can't kill our
  //    own ancestor inline, so hand the make-before-break takeover to a detached child that outlives us.
  //    No --force needed: adopting the session you typed the command in is unambiguous.
  if (selfHolder && !noStart) {
    if (adoptInFlight(space)) {
      console.log(`⟳ an adopt is already in flight for space ${space} — not stacking another (progress: ${adoptLogPath(space)})`);
      return;
    }
    const desiredName = nameFlag ?? namesForFolder(folder).get(sessionId); // child re-derives the folder default if undefined
    const launched = spawnDetachedAdopt(space, folder, sessionId, desiredName);
    console.log(
      launched
        ? `⟳ adopting this session onto the mesh (detached) — once the new agent is live, THIS terminal's claude ends.\n` +
            `  open a NEW terminal and run \`paw attach ${target ?? "."}\` to continue the conversation there.\n` +
            `  progress: ${adoptLogPath(space)}`
        : `⟳ an adopt is already in flight — not stacking another.`,
    );
    return;
  }

  // Name the agent after --name, else the session if it's named (`/rename`/`--session-name`), else the
  // folder basename. The user-typed `--resume <name>` beats the sessions-index lookup: the index maps
  // sessionId→name from ~/.claude/sessions pid files, and a paw mesh agent that once held this session
  // leaves an entry under the AGENT's name — trusting it re-pins the wrong agent (the aws/research mixup).
  // A desired name that differs from an EXISTING default agent becomes an EXTRA instance beside it
  // (planAdoptName above); adopt never renames or silently replaces the default's pin.
  const sessionName = resolvedSessionName ?? namesForFolder(folder).get(sessionId);
  const desired = nameFlag ?? sessionName; // --name wins, else the session's name
  const oldName = lookupFolderName(space, folder);
  const plan = planAdoptName(desired, oldName);
  const name =
    plan.kind === "folder-default" ? folderToName(space, folder)
    : plan.kind === "register-default" ? setFolderName(space, folder, desired!).name
    : plan.kind === "extra" ? registerInstance(space, folder, desired!)
    : plan.name;

  // Two-writers refuse: a foreign standalone claude holds this session and we're NOT taking it over —
  // resuming it as a paw agent would put two writers on one transcript and can corrupt it. (A self-held
  // session already took the detached SELF-ADOPT path above; --force / the detached child fall through
  // to the make-before-break takeover below.) Mesh agents (paw's own) don't count.
  if (foreign.length && !noStart && !force) {
    throw new Error(
      `paw: session ${sessionId} is open in another process (pid ${foreignPids}) — resuming it as a ` +
        `paw agent would put two writers on one transcript and can corrupt it.\n` +
        `  close it first:    kill ${foreignPids}\n` +
        `  take it over:      paw adopt ${target ?? "."} --force   (paw brings the new agent up, then stops the holder)\n` +
        `  or, from INSIDE that claude session, just run \`paw adopt .\` — it hands off and takes over on its own`,
    );
  }

  const file = personaFilePath(space, name);
  const prevPin = existsSync(file) ? readResumeId(file) : undefined;
  const pinChanged = prevPin !== sessionId; // re-adopting the same session?
  if (prevPin !== undefined && pinChanged) {
    console.error(`paw: note — "${name}" was pinned to ${prevPin}; undo with \`paw adopt ${target ?? "."} --resume ${prevPin}\``);
  }
  pinSession(space, name, sessionId);

  // --no-start: just pin the resume (fully local, no mesh). Otherwise bring the agent live now.
  if (noStart) {
    if (foreign.length) {
      console.error(`paw: note — session ${sessionId} is open in pid ${foreignPids}; kill it before bringing this agent live.`);
    }
    console.log(`✓ adopted "${name}" ← session ${sessionId} (pinned, not started)`);
    console.log(`  run \`paw chat ${target ?? "."}\` (or \`paw open\`) to resume it on the mesh`);
    return;
  }

  const { server } = await ensure({ needMesh: true, needManager: true, space });

  // MAKE-BEFORE-BREAK: when a foreign claude still holds the session (--force, or the detached child),
  // bring the new mesh agent up and CONFIRM its mesh link is live FIRST, then kill the holder — a failed
  // spawn never strands the operator with a dead session (the holder is untouched until we're sure). We
  // lift paw's two-writer guard (allowForeignWriter) ONLY for the brief window between the new agent
  // connecting and the holder dying: we kill the instant its mesh link is up, so the deliberate overlap is
  // seconds, not the full confirm timeout — the tradeoff the operator asked for. Residual: if the adopted
  // name has QUEUED DMs the new agent may take a turn (and write the transcript) inside that window; in the
  // self-adopt case the old claude is idle (blocked on THIS command), so a true concurrent write is rare.
  // Confirmation is over the manager's ps (waitForMeshLive), NOT the control endpoint's roster — that
  // endpoint has watchPresence:false so its roster is always empty. Plain adopt (no holder) skips the kill.
  const takeover = foreign.length > 0;
  const r = await withManagerControl(space, server, async (ctl) => {
    const spawnOpts = { space, name, cwd: folder, allowForeignWriter: takeover };
    const res = pinChanged
      ? await restartAgent(ctl, spawnOpts)
      : await ensureAgentSpawned(ctl, spawnOpts).then((x) => ({ ...x, restarted: false }));
    if (takeover) {
      const live = await waitForMeshLive(ctl, name, 30000);
      if (!live) {
        // The new agent never connected — stop it so it can't become a SECOND writer, and leave the old
        // claude alone. Now the holder is genuinely the sole writer; nothing was lost.
        await stopAgent(ctl, name).catch(() => {});
        throw new Error(
          `paw: the new "${name}" didn't connect to the mesh in time — stopped it and left your running ` +
            `session (pid ${foreignPids}) alone. Check \`paw status\` and retry; nothing was lost.`,
        );
      }
    }
    return res;
  });

  if (takeover) {
    // New agent confirmed live — NOW retire the old claude(s) holding the session. GUARD: never SIGTERM a
    // process we're running INSIDE. isSelfAncestor is best-effort (a transient `ps` failure reads false),
    // so a self-held session could slip past the early SELF-ADOPT detection and reach here; re-check right
    // before the kill. If a holder is our ancestor, killing it would kill this very command — the new agent
    // is already live, so hand the kill to the operator instead of self-destructing.
    const holdersNow = liveSessionProcs(sessionId).filter((p) => !p.mesh);
    const selfNow = inFlightChild ? undefined : holdersNow.find((p) => isSelfAncestor(p.pid));
    if (selfNow) {
      console.log(`✓ adopted "${name}" ← session ${sessionId} — the new agent is live on the mesh.`);
      console.log(
        `  ⚠ couldn't safely stop THIS claude from inside it (pid ${selfNow.pid}) — exit this session ` +
          `(or \`kill ${selfNow.pid}\`), then \`paw attach ${target ?? "."}\`. The mesh agent is already up.`,
      );
      return;
    }
    console.error(`paw: "${name}" is live — retiring the previous session holder (pid ${foreignPids})…`);
    for (const p of foreign) { try { process.kill(p.pid, "SIGTERM"); } catch { /* already gone */ } }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && liveSessionProcs(sessionId).some((p) => !p.mesh)) await sleep(250);
    for (const p of liveSessionProcs(sessionId).filter((p) => !p.mesh)) {
      try { process.kill(p.pid, "SIGKILL"); } catch { /* gone between checks */ }
    }
  }

  const how = plan.kind === "extra"
    ? ` — new agent beside "${oldName}" (its session untouched), resumed & live`
    : takeover
      ? " — took over the running session, resumed & live on the mesh"
      : r.restarted
        ? " — resumed & live (restarted to apply the new session)"
        : r.spawned
          ? " — resumed & live on the mesh"
          : " — already live, left it running";
  console.log(`✓ adopted "${name}" ← session ${sessionId}${how}`);

  // Auto-attach in place after a takeover when we own a real terminal (the Case-B operator flow: adopt a
  // running claude from a plain shell and drop into it here). The detached child passes --no-attach.
  if (takeover && !noAttach && process.stdout.isTTY) {
    await attachResolved(space, name, { folder });
  } else {
    console.log(`  \`paw chat ${target ?? "."}\` to talk to it · \`paw open ${target ?? "."}\` for its terminal`);
  }

  // The detached self-adopt child's last act: drop the in-flight pidfile so a later adopt isn't blocked.
  if (inFlightChild) finishDetachedAdopt(space);
}

const adoptCommand: Command = {
  kind: "command",
  name: "adopt",
  group: "Mesh",
  summary: "adopt a past (or running) claude session for a folder and bring it live — adopt [<folder>] [--resume <id|name>] [--name <n>] [--no-start] [--force]",
  usage: "adopt [<folder>] [--resume <id|name>] [--name <n>] [--no-start] [--force] [--no-attach]   (default: latest session; from INSIDE a live claude, `paw adopt .` takes over THAT session onto the mesh automatically — no --force needed; --resume takes a session id or a named session; --name overrides the agent name; --no-start pins without spawning; --force TAKES OVER a running claude from another terminal — brings the new agent up, then stops the holder; --session aliases --resume)",
  run: (a) => adopt([...a.raw]),
};

registry.register(adoptCommand);
