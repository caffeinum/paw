/**
 * `pnpm check:images` — the image-attachment helpers (src/images.ts), hermetic: a temp PAW_HOME +
 * real fixture files on disk, no mesh, no daemons.
 *
 * The tokenizer is the risky part: a dragged path arrives quoted THREE different ways depending on
 * the terminal (backslash-escaped — ghostty/cmux/wezterm/Terminal.app; single-quoted — VS Code and
 * kitty at a prompt; bare — kitty not at a prompt), so each convention gets a case with a REAL file
 * whose name contains a space.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachKind,
  attachmentsRide,
  composeMessage,
  formatBytes,
  hasProse,
  imagesDir,
  isEphemeralPath,
  peelLine,
  peelWords,
  resolveImagePath,
  sanitizeImageName,
  stageAttachment,
  tokenizeLine,
} from "../src/images.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "ok " : "FAIL"}  ${label}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

process.env.PAW_HOME = mkdtempSync(join(tmpdir(), "paw-images-"));
const SPACE = "imgcheck";

// A fixture dir OUTSIDE the ephemeral roots — it must NOT be under tmpdir(), or stageAttachment
// would (correctly) copy these and the in-place assertions below would be testing the wrong branch.
// So it lives beside the repo, and is removed at the end.
const home = join(process.cwd(), `.imgcheck-${process.pid}`);
const stable = join(home, "stable");
mkdirSync(stable, { recursive: true });
const spaced = join(stable, "shot 1.png");
const plain = join(stable, "plain.png");
const notImage = join(stable, "notes.txt");
const bigish = join(stable, "big.jpg");
writeFileSync(spaced, "x".repeat(10));
writeFileSync(plain, "y".repeat(20));
writeFileSync(notImage, "hello");
writeFileSync(bigish, "z".repeat(2048));

// ── tokenizeLine: the three real quoting conventions ─────────────────────────────────────────────
{
  const bs = tokenizeLine(String.raw`/a/b\ c.png what?`);
  assert(bs[0].value === "/a/b c.png", "backslash-escaped space unescapes (ghostty/cmux/wezterm/Terminal.app)");
  assert(bs[1].value === "what?", "the rest of the line still tokenizes");

  const sq = tokenizeLine(`'/a/b c.png' what?`);
  assert(sq[0].value === "/a/b c.png", "single-quoted path keeps its space (VS Code, kitty-at-prompt)");

  const dq = tokenizeLine(`"/a/b c.png"`);
  assert(dq[0].value === "/a/b c.png", "double-quoted path keeps its space");

  const bare = tokenizeLine(`/a/plain.png hi`);
  assert(bare[0].value === "/a/plain.png" && bare[1].value === "hi", "bare path tokenizes (kitty not-at-prompt)");

  const esc = tokenizeLine(String.raw`/a/b\\c.png`);
  assert(esc[0].value === String.raw`/a/b\c.png`, "a literal backslash (\\\\) unescapes to one, not zero");

  const spans = tokenizeLine(`ab cd`);
  assert(spans[0].start === 0 && spans[0].end === 2 && spans[1].start === 3, "spans are exact (body rebuild depends on them)");
}

// ── resolveImagePath: absolute-only, file:// and ~ ───────────────────────────────────────────────
{
  assert(resolveImagePath("/x/y.png") === "/x/y.png", "absolute path passes through");
  assert(resolveImagePath("y.png") === undefined, "RELATIVE path is refused (ambiguous: your cwd or the agent's?)");
  assert(resolveImagePath("./y.png") === undefined, "dot-relative path is refused");
  assert(resolveImagePath("~/y.png", "/Users/x") === "/Users/x/y.png", "~ expands against home");
  assert(resolveImagePath("~", "/Users/x") === undefined, "bare ~ is not a file path");
  assert(resolveImagePath("file:///a/b%20c.png") === "/a/b c.png", "file:// URL decodes to a path");
  assert(resolveImagePath("file://not a url") === undefined, "malformed file:// is refused, never fabricated");
  assert(resolveImagePath("https://x.com/a.png") === undefined, "an http URL is not a local path");
}

// ── attachKind: exactly claude's Read-renderable set ─────────────────────────────────────────────
{
  assert(attachKind("/a/x.png").image, "png is an image");
  assert(attachKind("/a/x.JPEG").image, "JPEG is an image (case-insensitive)");
  assert(attachKind("/a/x.webp").image, "webp is an image");
  assert(!attachKind("/a/x.heic").image, "heic is NOT (Read can't render it — don't promise a picture)");
  assert(!attachKind("/a/x.pdf").image, "pdf is not an image");
}

// ── peelLine: substitution, dedupe, numbering, prose-safety ──────────────────────────────────────
{
  const p = peelLine(`${plain} what is this?`);
  assert(p.body === "[Image #1] what is this?", `bare existing path → placeholder (got "${p.body}")`);
  assert(p.paths.length === 1 && p.paths[0].endsWith("plain.png"), "the resolved path is returned");

  const esc = peelLine(`${spaced.replace(/ /g, "\\ ")} hi`);
  assert(esc.body === "[Image #1] hi", `backslash-escaped real file peels (got "${esc.body}")`);
  assert(esc.paths.length === 1, "…and yields exactly one path");

  const sq = peelLine(`'${spaced}' hi`);
  assert(sq.body === "[Image #1] hi", "single-quoted real file peels");

  const two = peelLine(`${plain} and ${bigish}`);
  assert(two.body === "[Image #1] and [Image #2]", `two images number 1,2 (got "${two.body}")`);
  assert(two.paths.length === 2, "…and both paths come back");

  const dup = peelLine(`${plain} vs ${plain}`);
  assert(dup.body === "[Image #1] vs [Image #1]", "the SAME file twice reuses one number");
  assert(dup.paths.length === 1, "…and is staged once");

  const off = peelLine(`${plain} x`, undefined, 3);
  assert(off.body === "[Image #3] x", "startAt continues numbering across lines (no second #1)");

  // The fail-loud rule inverted: prose about a file that doesn't exist must send AS TYPED.
  const prose = peelLine("write the chart to /tmp/definitely-not-here-9times.png");
  assert(prose.body === "write the chart to /tmp/definitely-not-here-9times.png", "a nonexistent path is left alone (it's prose)");
  assert(prose.paths.length === 0, "…and attaches nothing");

  const dir = peelLine(`${stable} hi`);
  assert(dir.paths.length === 0, "a DIRECTORY is not an attachment");

  const txt = peelLine(`${notImage} hi`);
  assert(txt.paths.length === 1, "a non-image FILE still attaches (as a file)");

  const none = peelLine("just a normal sentence");
  assert(none.body === "just a normal sentence" && none.paths.length === 0, "an ordinary line is untouched");

  const verb = peelLine(`@web ${plain} look`);
  assert(verb.body === "@web [Image #1] look", "an @name prefix survives peeling");
}

// ── hasProse: the path-only-line gate (a placeholder is NOT prose) ──────────────────────────────
{
  // Regression: a path-only line peels to the NON-EMPTY body "[Image #1]", so an emptiness check
  // sent a placeholder-only message — and a multi-file drop (several separate lines) sent one PER
  // file, each renumbered #1 because the send cleared the pending list. Caught live 2026-07-24.
  assert(!hasProse(peelLine(plain).body), "a path-ONLY line has no prose (must stage, not send)");
  assert(!hasProse("[Image #1]"), "a bare placeholder is not prose");
  assert(!hasProse("  [Image #1]  [File #2] "), "several placeholders + whitespace is still not prose");
  assert(hasProse(peelLine(`${plain} what is this?`).body), "a path WITH text is prose (sends)");
  assert(hasProse("hello"), "ordinary text is prose");
  assert(!hasProse(""), "an empty body is not prose");
}

// ── peelWords: the paw dm argv path (shell already unquoted) ─────────────────────────────────────
{
  const w = peelWords([spaced, "what", "is", "this?"]);
  assert(w.body === "[Image #1] what is this?", `argv word with spaces peels whole (got "${w.body}")`);
  assert(w.paths.length === 1, "…as one attachment, not two");
  const none = peelWords(["hello", "world"]);
  assert(none.body === "hello world" && none.paths.length === 0, "plain words join unchanged");
}

// ── isEphemeralPath: BOUNDARY matching (the /tmp vs /tmpfoo class of bug) ────────────────────────
{
  assert(isEphemeralPath("/tmp/x.png"), "/tmp/x is ephemeral");
  assert(!isEphemeralPath("/tmpfoo/x.png"), "/tmpfoo is NOT (boundary, not prefix)");
  assert(isEphemeralPath("/private/var/folders/ab/cd/T/x.png"), "macOS per-user temp is ephemeral");
  assert(!isEphemeralPath("/Users/aleks/Github/paw/logo.png"), "a repo file is NOT ephemeral (read in place)");
}

// ── sanitizeImageName ───────────────────────────────────────────────────────────────────────────
{
  assert(sanitizeImageName("../../etc/passwd.png") === "passwd.png", "traversal collapses to the leaf");
  assert(sanitizeImageName("shot 1.png") === "shot-1.png", "spaces become dashes");
  assert(!sanitizeImageName("x".repeat(200)).includes("/"), "a long name stays a single segment");
  assert(sanitizeImageName("x".repeat(200)).length <= 80, "…and is length-capped");
  assert(sanitizeImageName("...") === "image", "a degenerate name falls back to 'image', never empty");
}

// ── stageAttachment: copy iff ephemeral, in place otherwise ──────────────────────────────────────
{
  const inPlace = stageAttachment(SPACE, plain, 1);
  assert(inPlace.path === plain, "a NON-ephemeral file is used in place (later edits are seen)");
  assert(inPlace.placeholder === "[Image #1]", "…with an [Image #N] placeholder");
  assert(inPlace.size === 20, "…and its real size");

  const eph = join(tmpdir(), `paw-eph-${process.pid}.png`);
  writeFileSync(eph, "e".repeat(7));
  const staged = stageAttachment(SPACE, eph, 2);
  assert(staged.path !== eph, "an EPHEMERAL file is COPIED (the terminal reaps the original)");
  assert(staged.path.startsWith(imagesDir(SPACE)), "…into the space's images dir");
  assert(existsSync(staged.path), "…and the copy is really there");
  rmSync(eph, { force: true });
  assert(existsSync(staged.path), "…and SURVIVES the original being reaped");
  assert(readdirSync(imagesDir(SPACE)).length === 1, "exactly one staged copy was written");

  const file = stageAttachment(SPACE, notImage, 1);
  assert(file.placeholder === "[File #1]" && !file.image, "a non-renderable file gets [File #N], not [Image #N]");

  assert(throws(() => stageAttachment(SPACE, join(tmpdir(), "paw-nope-does-not-exist.png"), 1)), "staging a missing ephemeral file throws (never announces a dead path)");
}

// ── composeMessage: the wire form ───────────────────────────────────────────────────────────────
{
  const a = stageAttachment(SPACE, plain, 1);
  const withBody = composeMessage("what is this?", [a]);
  assert(withBody.startsWith("what is this?\n"), "the body comes first");
  assert(withBody.includes(`📷 [Image #1] ${plain}`), "…then a 📷 line with the ABSOLUTE path");
  assert(composeMessage("hi", []) === "hi", "no attachments ⇒ the body is untouched (byte-identical to today)");
  const bodyless = composeMessage("", [a]);
  assert(!bodyless.startsWith("\n"), "an empty body doesn't leave a leading newline");
  const f = stageAttachment(SPACE, notImage, 2);
  assert(composeMessage("", [f]).includes("📎 [File #2]"), "a non-image uses the 📎 marker");
}

// ── formatBytes ─────────────────────────────────────────────────────────────────────────────────
{
  assert(formatBytes(512) === "512 B", "bytes");
  assert(formatBytes(2048) === "2 KB", "kilobytes");
  assert(formatBytes(undefined) === "?", "unknown size is '?', never a fabricated 0");
}

rmSync(process.env.PAW_HOME!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

// ── attachments bound to a failed target ─────────────────────────────────────────────────────────
// A `@name` send that failed leaves its attachments staged while the sticky target is still the
// PREVIOUS agent — so the next plain line carried an image meant for one agent to a different one,
// silently (reported 2026-08-17). Binding makes that impossible rather than merely announced.
{
  assert(attachmentsRide(undefined, "research"), "unbound attachments always ride — that is the ordinary path");
  assert(attachmentsRide(undefined, undefined), "unbound with no target still rides");
  assert(attachmentsRide("canary-env-52", "canary-env-52"), "sending to the agent they were staged for attaches them");
  // THE bug, in one assertion.
  assert(!attachmentsRide("canary-env-52", "research"), "an attachment staged for one agent never rides a message to another");
  assert(!attachmentsRide("canary-env-52", "#general"), "…including a channel broadcast");
  // No target to compare against is not evidence of a mismatch; stranding on a guess is worse.
  assert(attachmentsRide("canary-env-52", undefined), "no target ⇒ not stranded on a guess");
}

if (failures > 0) {
  console.error(`\n${failures} paw image check(s) failed`);
  process.exit(1);
}
console.log("\nall paw image checks passed 🐾");
