/**
 * Smoke check for `paw log`'s transcript resolution (chooseTranscriptId) plus the opencode/codex
 * harness readers. A PINNED claude agent's transcript is authoritative — when it's missing (booted,
 * no turns) we fail loud instead of falling back to the folder's newest session. Non-claude agents
 * never fall back to a sibling claude jsonl. Pure/no daemons. Run: pnpm check:log
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Isolate PAW_HOME BEFORE importing addressing (folders.json lives under it) so the registry tests
// below run against a throwaway registry, not the real one.
process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-log-home-"));
process.env.PAW_SPACE = "logtest";

const { chooseTranscriptId, agentNameForFolder, openAgentLog, blocksForAgent } = await import("../src/log.js");
const { latestOpencodeSession, blocksFromOpencodeRows, pathsMatch } = await import("../src/opencode-log.js");
const { findCodexSessionFile, parseCodexJsonl } = await import("../src/codex-log.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
const touch = (dir: string, id: string, mtimeSec: number): void => {
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
  utimesSync(join(dir, `${id}.jsonl`), mtimeSec, mtimeSec);
};

const dir = mkdtempSync(join(tmpdir(), "paw-log-proj-"));

// Pinned agent whose transcript EXISTS → resolves to the pin.
touch(dir, "pinned-aaaa", 1000);
assert(chooseTranscriptId("a", dir, "pinned-aaaa") === "pinned-aaaa", "pinned + transcript present → the pinned id");

// Pinned agent whose transcript is MISSING → fail loud (NOT a fallback to another session).
touch(dir, "unrelated-live", 9999); // newer, simulates the human's live session
assert(throws(() => chooseTranscriptId("aleks", dir, "no-such-pin")), "pinned + transcript missing → throws (no fallback to the folder's newest)");

// Unpinned agent → falls back to the newest session in the dir.
assert(chooseTranscriptId("a", dir, undefined) === "unrelated-live", "unpinned → newest session in the dir");
assert(
  chooseTranscriptId("a", dir, undefined, "claude") === "unrelated-live",
  "unpinned claude → newest session in the dir",
);

// Unpinned NON-claude agent must NOT fall back — that would print a sibling's claude session
// (`paw log personal-grok` → `personal`'s perkmal-55 in the same folder).
assert(
  throws(() => chooseTranscriptId("personal-grok", dir, undefined, "opencode")),
  "unpinned opencode → throws (never the folder's newest claude session)",
);
assert(
  throws(() => chooseTranscriptId("codex1", dir, undefined, "codex")),
  "unpinned codex → throws",
);

// Unpinned agent with no sessions at all → fail loud.
const empty = mkdtempSync(join(tmpdir(), "paw-log-empty-"));
assert(throws(() => chooseTranscriptId("a", empty, undefined)), "unpinned + no sessions → throws");

// agentNameForFolder: an UNregistered folder whose basename is a DIFFERENT folder's registered agent
// name must FAIL LOUD, never borrow that agent's name (→ its pin) — the github-clone vs local-checkout
// basename-collision footgun (`paw log .` in ~/Github/.../noninteractive read the clone agent's pin but
// looked for its transcript under the local folder → misleading "no transcript yet").
const space = "logtest";
const clone = "/Users/aleks/.paw/repos/team2027/noninteractive";
const local = "/Users/aleks/Github/team2027/noninteractive"; // different folder, same basename
mkdirSync(join(process.env.PAW_HOME as string, "spaces", space), { recursive: true });
writeFileSync(join(process.env.PAW_HOME as string, "spaces", space, "folders.json"), JSON.stringify({ [clone]: "noninteractive" }));

assert(agentNameForFolder(space, clone) === "noninteractive", "registered folder → its registered name");
assert(throws(() => agentNameForFolder(space, local)), "unregistered folder whose basename belongs to a DIFFERENT folder → throws (no name/pin borrow)");
assert(agentNameForFolder(space, "/Users/aleks/Github/unique-proj-xyz") === "unique-proj-xyz", "unregistered folder with a free basename → its basename (no throw)");

assert(pathsMatch("/tmp/foo", "/tmp/foo"), "pathsMatch exact");
assert(pathsMatch("/tmp/foo/../bar", "/tmp/bar"), "pathsMatch resolve");

function writePersona(name: string, agent: string): void {
  const dir = join(process.env.PAW_HOME as string, "spaces", space, "personas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\nagent: ${agent}\n---\n`);
}

function seedOpencodeDb(path: string, rows: Array<{ id: string; directory: string; parts: Array<{ role: string; part: unknown }> }>): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  let t = 1000;
  for (const s of rows) {
    db.prepare("INSERT INTO session (id, directory, title, time_updated) VALUES (?, ?, ?, ?)").run(s.id, s.directory, s.id, t);
    for (const p of s.parts) {
      t += 1;
      const mid = `m-${t}`;
      const pid = `p-${t}`;
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(mid, s.id, t, t, JSON.stringify({ role: p.role }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(pid, mid, s.id, t, t, JSON.stringify(p.part));
    }
    t += 10;
  }
  db.close();
}

const ocFolder = join(mkdtempSync(join(tmpdir(), "paw-oc-folder-")), "proj");
mkdirSync(ocFolder);
const ocOther = join(mkdtempSync(join(tmpdir(), "paw-oc-other-")), "other");
mkdirSync(ocOther);
const ocDb = join(mkdtempSync(join(tmpdir(), "paw-oc-db-")), "opencode.db");
seedOpencodeDb(ocDb, [
  {
    id: "ses_right",
    directory: ocFolder,
    parts: [
      { role: "user", part: { type: "text", text: "OPENCODE_FIXTURE_TURN" } },
      { role: "assistant", part: { type: "step-finish", reason: "stop" } },
      { role: "assistant", part: { type: "text", text: "opencode says hi" } },
      {
        role: "assistant",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" },
        },
      },
      {
        role: "assistant",
        part: {
          type: "tool",
          tool: "cotal_dm",
          state: { status: "completed", input: { to: "you", text: "done" }, output: "DM sent to you." },
        },
      },
      {
        role: "assistant",
        part: { type: "tool", tool: "cotal_roster", state: { status: "completed", input: {}, output: "[]" } },
      },
    ],
  },
  {
    id: "ses_wrong",
    directory: ocOther,
    parts: [{ role: "user", part: { type: "text", text: "WRONG_FOLDER_TURN" } }],
  },
]);

assert(latestOpencodeSession(ocDb, ocFolder)?.id === "ses_right", "opencode latest session is the matching folder, not a newer other-cwd");
assert(latestOpencodeSession(ocDb, ocOther)?.id === "ses_wrong", "opencode other folder resolves to its own session");
assert(latestOpencodeSession(ocDb, "/no/such/folder") === undefined, "opencode missing folder → no session");

const ocBlocks = blocksFromOpencodeRows([
  { part: { type: "text", text: "OPENCODE_FIXTURE_TURN" }, message: { role: "user" } },
  { part: { type: "step-finish", reason: "stop" }, message: { role: "assistant" } },
  { part: { type: "text", text: "opencode says hi" }, message: { role: "assistant" } },
  { part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" } }, message: { role: "assistant" } },
  { part: { type: "tool", tool: "cotal_dm", state: { status: "completed", input: { to: "you", text: "done" }, output: "DM sent" } }, message: { role: "assistant" } },
]);
assert(ocBlocks.some((b) => b.kind === "user" && b.text === "OPENCODE_FIXTURE_TURN"), "opencode user text → user block");
assert(ocBlocks.some((b) => b.kind === "assistant" && b.markdown === "opencode says hi"), "opencode assistant text → assistant block");
assert(ocBlocks.every((b) => b.kind !== "user" || b.text !== "WRONG_FOLDER_TURN"), "injected rows have no wrong-folder turn");
assert(ocBlocks.some((b) => b.kind === "tool" && b.display === "Bash"), "opencode bash → Bash tool block");
assert(ocBlocks.some((b) => b.kind === "result"), "opencode completed tool carries a result");
assert(ocBlocks.some((b) => b.kind === "reply" && b.to === "you" && b.text === "done"), "opencode cotal_dm → reply");
assert(!ocBlocks.some((b) => b.kind === "tool" && String((b as { name?: string }).name).includes("roster")), "opencode cotal_roster is hidden");

writePersona("oc1", "opencode");
const prevOc = process.env.OPENCODE_DB;
process.env.OPENCODE_DB = ocDb;
try {
  const got = blocksForAgent(space, "oc1", ocFolder, { tail: 50 });
  assert(got.blocks.some((b) => b.kind === "user" && b.text === "OPENCODE_FIXTURE_TURN"), "blocksForAgent opencode → this folder's session");
  assert(!got.blocks.some((b) => b.kind === "user" && b.text === "WRONG_FOLDER_TURN"), "blocksForAgent opencode ignores a different-cwd session");
  assert(
    throws(() => blocksForAgent(space, "oc1", "/no/such/opencode-folder", { tail: 5 })),
    "opencode missing session → throws (never a sibling claude id)",
  );
} finally {
  if (prevOc === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = prevOc;
}

const emptyOc = join(mkdtempSync(join(tmpdir(), "paw-oc-empty-")), "opencode.db");
seedOpencodeDb(emptyOc, []);
assert(latestOpencodeSession(emptyOc, ocFolder) === undefined, "empty opencode db → no session");

const codexHome = mkdtempSync(join(tmpdir(), "paw-codex-home-"));
const codexFolder = join(mkdtempSync(join(tmpdir(), "paw-codex-folder-")), "proj");
mkdirSync(codexFolder);
const otherCodex = join(mkdtempSync(join(tmpdir(), "paw-codex-other-")), "other");
mkdirSync(otherCodex);
const goodRoll = join(codexHome, "sessions", "2026", "09", "09");
const badRoll = join(codexHome, "sessions", "2026", "09", "08");
mkdirSync(goodRoll, { recursive: true });
mkdirSync(badRoll, { recursive: true });
const goodFile = join(goodRoll, "rollout-2026-09-09T00-00-00-aaaa.jsonl");
const badFile = join(badRoll, "rollout-2026-09-08T00-00-00-bbbb.jsonl");
writeFileSync(
  goodFile,
  [
    JSON.stringify({ type: "session_meta", payload: { cwd: codexFolder, session_id: "aaaa" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system dump" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "CODEX_FIXTURE_TURN" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex says hi" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "echo hi"] }), call_id: "c1" } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "hi\n", metadata: { exit_code: 0 } }) } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "cotal_dm", arguments: JSON.stringify({ to: "you", text: "done" }), call_id: "c2" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "duplicate event, ignore" } }),
  ].join("\n") + "\n",
);
writeFileSync(
  badFile,
  [
    JSON.stringify({ type: "session_meta", payload: { cwd: otherCodex, session_id: "bbbb" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "WRONG_CODEX_TURN" }] } }),
  ].join("\n") + "\n",
);
utimesSync(goodFile, 2000, 2000);
utimesSync(badFile, 9999, 9999); // newer, but wrong cwd

assert(findCodexSessionFile(codexFolder, [join(codexHome, "sessions")]) === goodFile, "codex picks matching cwd, not a newer other-cwd file");
assert(findCodexSessionFile("/no/such/codex-folder", [join(codexHome, "sessions")]) === undefined, "codex missing folder → no file");

const cxBlocks = parseCodexJsonl(
  [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "CODEX_FIXTURE_TURN" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex says hi" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "cotal_dm", arguments: JSON.stringify({ to: "you", text: "done" }), call_id: "c2" } }),
  ].join("\n"),
);
assert(cxBlocks.some((b) => b.kind === "user" && b.text === "CODEX_FIXTURE_TURN"), "codex user text → user block");
assert(cxBlocks.some((b) => b.kind === "assistant" && b.markdown === "codex says hi"), "codex assistant text → assistant block");
assert(cxBlocks.some((b) => b.kind === "reply" && b.to === "you"), "codex cotal_dm → reply");
assert(!cxBlocks.some((b) => b.kind === "user" && b.text.includes("environment_context")), "codex environment_context-only user is dropped");

writePersona("cx1", "codex");
const prevCx = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;
try {
  const got = blocksForAgent(space, "cx1", codexFolder, { tail: 50 });
  assert(got.blocks.some((b) => b.kind === "user" && b.text === "CODEX_FIXTURE_TURN"), "blocksForAgent codex → this folder's session");
  assert(!got.blocks.some((b) => b.kind === "user" && b.text === "WRONG_CODEX_TURN"), "blocksForAgent codex ignores a different-cwd session");
  assert(
    throws(() => blocksForAgent(space, "cx1", "/no/such/codex-folder", { tail: 5 })),
    "codex missing session → throws (never a sibling claude id)",
  );
} finally {
  if (prevCx === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCx;
}

writePersona("hermes1", "hermes");
assert(
  throws(() => openAgentLog(space, "hermes1", ocFolder)),
  "hermes → throws (unsupported harness)",
);
try {
  openAgentLog(space, "hermes1", ocFolder);
  assert(false, "hermes should have thrown");
} catch (e) {
  const msg = (e as Error).message;
  assert(msg.includes("hermes") && msg.includes("does not read hermes sessions yet"), `hermes error names the harness: ${msg}`);
}

{
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const reader = readFileSync(join(src, "sqlite-readonly.ts"), "utf8") + readFileSync(join(src, "opencode-log.ts"), "utf8");
  assert(
    !reader.includes('from "node:sqlite"') && !reader.includes("from 'node:sqlite'"),
    "opencode reader must not static-import node:sqlite (bun has no such builtin)",
  );
}

if (failures > 0) {
  console.error(`\n${failures} paw log check(s) failed`);
  process.exit(1);
}
console.log("\nall paw log checks passed 🐾");
