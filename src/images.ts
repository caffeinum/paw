/**
 * Image attachments for `paw chat` / `paw dm` — the "[Image #1]" flow.
 *
 * You drag an image onto the terminal (or Cmd-V one in a terminal that supports it) and the terminal
 * inserts its PATH as ordinary keystrokes. This module peels those paths out of the typed line,
 * replaces each with a `[Image #N]` placeholder, and stages the file so the path stays alive.
 *
 * WHY A TEXT CARRIER, NOT A DATA PART: the claude connector flattens every inbound message with
 * `parts.map(p => p.kind === "text" ? p.text : JSON.stringify(p.data))` (connector-claude-code's
 * `toInboxItem`) — that ONE line is the only channel the model ever reads. So a `{kind:"data"}`
 * FileEntry would reach the agent as ~150 chars of raw JSON per image (strictly worse than a clean
 * path), and a `{kind:"ai.cotal.image"}` EXTENSION part is worse still: it's legal on the wire
 * (it passes core's `isMessagePart`) but `JSON.stringify(undefined)` makes it flatten to the EMPTY
 * STRING — simultaneously valid and invisible, in every reader that hasn't been taught about it.
 * paw has four independent copies of that same flattener (chat/inbox/history/watch), so any new part
 * kind would silently vanish or leak JSON in three of them. A plain absolute path in the text hits
 * every surface correctly with no new part kind at all — and it's the route the Telegram bridge
 * already proves in production (it DMs `📎 <name> saved to <abs path>`).
 *
 * If paw ever does need structure here, it MUST be `kind:"data"` + the EXISTING `ai.cotal.file`
 * proto (see src/commands/files.ts) — never a new proto, never an extension kind.
 *
 * Pure helpers are exported for `scripts/check-images.ts`; the only I/O is path resolution + staging.
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The extensions we call an IMAGE. Deliberately exactly claude's Read-renderable set — promising a
 *  picture for a `.heic`/`.svg` the agent's Read can't display would be a lie, so those attach as
 *  plain files instead (see {@link attachKind}). */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** One resolved attachment on an outgoing message. `path` is ABSOLUTE, canonical, exists, and is
 *  durable (staged if the source was in a reaped temp dir). */
export interface Attachment {
  n: number; // 1-based WITHIN one message (resets per send — matches Claude Code)
  placeholder: string; // `[Image #1]` / `[File #1]`
  path: string;
  name: string;
  image: boolean; // true ⇒ claude's Read can render it
  size?: number;
}

/** What {@link peelLine} pulled out of a typed line. */
export interface Peeled {
  /** The line with each attachment token replaced in place by its placeholder. */
  body: string;
  /** Canonical absolute source paths, first-appearance order, deduped. NOT yet staged. */
  paths: string[];
}

/** A token plus the exact source span it occupied, so the body can be rebuilt with placeholders. */
export interface Token {
  value: string;
  start: number;
  end: number;
}

/**
 * Split a line into shell-ish tokens, covering every quoting convention a macOS terminal uses when
 * it inserts a dragged path: BACKSLASH-escaped spaces (ghostty, cmux, wezterm, Terminal.app),
 * SINGLE quotes (VS Code, kitty at a prompt), and double quotes. Spans are kept so
 * {@link peelLine} can substitute placeholders without re-serializing the rest of the line.
 */
export function tokenizeLine(line: string): Token[] {
  const re = /'([^']*)'|"([^"]*)"|((?:\\.|[^\s\\])+)/g;
  const out: Token[] = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    // One left-to-right pass consumes `\\` as a unit, so `a\\b` → `a\b` and `a\ b` → `a b`.
    const value = m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, "$1");
    out.push({ value, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Normalize one token into an absolute filesystem path, or undefined if it isn't one.
 * Accepts `file://` URLs and a leading `~`; REFUSES anything relative — a bare `logo.png` is
 * ambiguous (relative to YOUR cwd, or the agent's folder?) and every terminal checked inserts an
 * absolute path, so resolving it would be guessing. Existence is checked by the caller.
 */
export function resolveImagePath(value: string, home: string = homedir()): string | undefined {
  let v = value;
  if (v.startsWith("file://")) {
    try {
      v = fileURLToPath(v);
    } catch {
      return undefined; // a malformed file:// URL is not a path — never fabricate one
    }
  } else if (v === "~") {
    return undefined;
  } else if (v.startsWith("~/")) {
    v = join(home, v.slice(2));
  }
  return isAbsolute(v) ? v : undefined;
}

/** Does this path carry a renderable-image extension? (vs. an attachable-but-not-viewable file.) */
export function attachKind(path: string): { image: boolean } {
  return { image: IMAGE_EXT.test(path) };
}

/**
 * Peel attachment paths out of a typed line: every token that resolves to an EXISTING absolute file
 * is replaced in the body by its `[Image #N]` placeholder and returned in `paths`.
 *
 * A token that LOOKS like a path but doesn't exist is left completely alone — no warning, no throw.
 * `write the chart to /tmp/out.png` is ordinary prose about a file that doesn't exist yet, and it
 * must send as typed; the absence of the 📷 confirmation is already the signal that nothing attached.
 */
export function peelLine(line: string, home?: string, startAt = 1): Peeled {
  const tokens = tokenizeLine(line);
  const order: string[] = [];
  const numberOf = new Map<string, number>();
  const hits: Array<{ tok: Token; n: number }> = [];

  for (const tok of tokens) {
    const cand = resolveImagePath(tok.value, home);
    if (!cand) continue;
    let real: string;
    try {
      real = realpathSync(cand);
      if (!statSync(real).isFile()) continue;
    } catch {
      continue; // doesn't exist / unreadable ⇒ it's prose, not an attachment
    }
    let n = numberOf.get(real);
    if (n === undefined) {
      order.push(real);
      // `startAt` continues the numbering across lines: an image staged on a previous (path-only)
      // line is already #1, so this line's first image must be #2 — not a second #1.
      n = startAt + order.length - 1;
      numberOf.set(real, n);
    }
    hits.push({ tok, n });
  }

  // Substitute right-to-left so earlier spans keep their indices.
  let body = line;
  for (let i = hits.length - 1; i >= 0; i--) {
    const { tok, n } = hits[i];
    body = body.slice(0, tok.start) + `[Image #${n}]` + body.slice(tok.end);
  }
  return { body: body.trim(), paths: order };
}

/**
 * Peel attachments from ALREADY-SHELL-SPLIT argv (the `paw dm` path). The shell has done the
 * unquoting, so each word is a finished path — running the tokenizer again would re-split a name
 * containing spaces. Same classifier, no tokenizing.
 */
export function peelWords(words: string[], home?: string): Peeled {
  const order: string[] = [];
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const w of words) {
    const cand = resolveImagePath(w, home);
    let real: string | undefined;
    if (cand) {
      try {
        const r = realpathSync(cand);
        if (statSync(r).isFile()) real = r;
      } catch {
        /* prose, not a path */
      }
    }
    if (!real) {
      out.push(w);
      continue;
    }
    let n = seen.get(real);
    if (n === undefined) {
      order.push(real);
      n = order.length;
      seen.set(real, n);
    }
    out.push(`[Image #${n}]`);
  }
  return { body: out.join(" ").trim(), paths: order };
}

/** Roots whose contents a terminal/OS is expected to REAP. Matched on a path BOUNDARY so `/tmp`
 *  matches `/tmp/x` but never `/tmpfoo` (same class of bug as lifecycle.ts's space-exact regexes). */
function ephemeralRoots(): string[] {
  return [...new Set(["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", tmpdir()])];
}

/**
 * Is this path somewhere that gets cleaned up behind our back? cmux — the terminal where Cmd-V of
 * image DATA produces a path at all — writes the pasted image to a temp file and later reaps it
 * (`cleanupTransferredTemporaryImageFiles`), so announcing that path could hand an agent a file
 * that's already gone. Files anywhere else (your repo, your Desktop) are read IN PLACE, so later
 * edits are picked up rather than frozen at send time.
 */
export function isEphemeralPath(p: string): boolean {
  return ephemeralRoots().some((r) => p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`));
}

/** A filesystem-safe leaf name for a staged copy: no separators, no traversal, length-capped. */
export function sanitizeImageName(name: string): string {
  const leaf = basename(name).replace(/[/\\]/g, "");
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  const safe = cleaned.length > 0 ? cleaned : "image";
  return safe.length > 80 ? safe.slice(-80) : safe;
}

/** Where staged copies live — per space, next to paw's other bookkeeping. */
export function imagesDir(space: string): string {
  const root = process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
  return join(root, "spaces", space, "images");
}

/** A sortable, collision-resistant stamp for a staged filename. */
function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}`
  );
}

/**
 * Make an attachment's path DURABLE. A source under an ephemeral root is copied into the space's
 * images dir and the COPY goes on the wire; anything else is used in place. Fails loud if the copy
 * fails — never falls back to announcing a path that's about to be reaped.
 */
export function stageAttachment(space: string, src: string, n: number, now: Date = new Date()): Attachment {
  const name = basename(src);
  const { image } = attachKind(src);
  let path = src;
  if (isEphemeralPath(src)) {
    const dir = imagesDir(space);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${stamp(now)}-${n}-${sanitizeImageName(name)}`);
    try {
      copyFileSync(src, dest);
    } catch (e) {
      throw new Error(
        `paw: couldn't stage "${src}" into ${dir} (${(e as Error).message}) — it's in a temp dir the ` +
          `terminal reaps, so sending the original path would hand the agent a file that's already gone.`,
      );
    }
    path = dest;
  }
  let size: number | undefined;
  try {
    size = statSync(path).size;
  } catch {
    /* staged copy just written; a stat failure is not worth failing the send over */
  }
  return { n, placeholder: `[${image ? "Image" : "File"} #${n}]`, path, name, image, size };
}

/** The `[Image #3]` / `[File #3]` placeholder, as substituted into a message body. */
export const PLACEHOLDER_RE = /\[(?:Image|File) #\d+\]/g;

/**
 * Does this peeled body carry anything BEYOND attachment placeholders? Dragging a file in and
 * hitting Enter peels to a body of exactly `[Image #1]` — which is non-empty, so a naive emptiness
 * check would send a message whose entire content is a placeholder (and a multi-file drop, which
 * arrives as several separate lines, would send one such message PER file). Callers stage instead
 * of sending when this is false.
 */
export function hasProse(body: string): boolean {
  return body.replace(PLACEHOLDER_RE, "").trim().length > 0;
}

/** The marker that prefixes each attachment line on the wire (and in paw's own echo). */
export const ATTACH_ICON = "📷";
const FILE_ICON = "📎";

/**
 * The wire form: the body, then one `📷 [Image #1] /abs/path` line per attachment. Pure text — see
 * the module header for why. Receivers print it verbatim; paw NEVER re-parses its own emitted text
 * back into structure (that would make every renderer a parser of untrusted strings, and let a human
 * who literally types `📷 [Image #1] /x.png` forge an attachment).
 */
export function composeMessage(body: string, attachments: Attachment[]): string {
  if (!attachments.length) return body;
  const lines = attachments.map((a) => `${a.image ? ATTACH_ICON : FILE_ICON} ${a.placeholder} ${a.path}`);
  return body ? `${body}\n${lines.join("\n")}` : lines.join("\n");
}

/** Human-readable byte size; "?" when unknown — never a fabricated 0. (Mirrors files.ts.) */
export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Warn above this — a big image burns a lot of the agent's context when it Reads it. */
const BIG_BYTES = 5 * 1024 * 1024;
export function isBig(a: Attachment): boolean {
  return a.size !== undefined && a.size > BIG_BYTES;
}

/** Does this path exist right now? (Used to re-check a pending attachment at flush time.) */
export function stillThere(path: string): boolean {
  return existsSync(path);
}

/**
 * May the staged attachments ride THIS message?
 *
 * `stagedFor` is set only when a `@name` send failed with attachments staged: the sticky target is
 * still the previous agent, so the next plain line would otherwise carry an image meant for one agent
 * to a different one — silently (reported 2026-08-17). Binding them makes that impossible rather than
 * merely announced.
 *
 * Unbound attachments (the normal case — drop a file, type a message) always ride: they were never
 * meant for anyone in particular, so holding them back would break the ordinary path to fix the rare one.
 */
export function attachmentsRide(stagedFor: string | undefined, target: string | undefined): boolean {
  if (stagedFor === undefined) return true;
  if (target === undefined) return true; // no target to compare against — don't strand them on a guess
  return target === stagedFor;
}
