/**
 * `paw type [@name|folder] <text…>` — type into an agent's terminal without attaching (2026-09-23).
 *
 * For what only the terminal understands: `/model claude-fable-5`, `/compact`, answering a prompt. A DM
 * can't do it — a mesh message reaches claude as ordinary message text, and Claude Code runs a slash
 * command only when it's typed into its own input box.
 *
 * Two modes, told apart by what you wrote:
 *   LINE  `paw type "/model claude-fable-5"` — the text, then Enter. GUARDED: it types only when the
 *         pane shows Claude Code's input box, EMPTY, and no prompt. Keys typed into a permission
 *         prompt ANSWER it (the keeper's Esc rejected canary-env-52's tool call, 2026-09-16), and typed
 *         after someone's half-written line they become part of it. `--force` skips the checks.
 *   KEYS  `paw type "2\n"`, `paw type "\n"`, `paw type --keys Down Down Enter` — exactly what you
 *         wrote, nothing added: `\n` is Enter, `\e` Escape, `\t` Tab; `--keys` takes tmux key names
 *         (Up Down Left Right Enter Escape Tab BSpace C-c …). UNGUARDED on purpose — answering a
 *         prompt is what this mode is for, so refusing when one is showing would defeat it.
 * Either way the pane is printed before and after: the keystroke isn't the evidence, the screen is.
 *
 * Target: `@name`, or a folder (`.`, `./x`, `/abs`, `~/x`); none = this folder's agent, the default
 * `paw chat`/`paw attach` use. A BARE first word is text — unless it names one of your agents, which
 * fails loud ("did you mean @evals?") rather than guess which of the two you meant.
 *
 * tmux only, like `paw unstick`: a pty seat has no terminal paw can reach, a cmux tab is the app's.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { folderForName, personaFilePath } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";
import { readResumeId } from "../session.js";
import { readTurnState } from "../status.js";
import { capturePane, paneInput, paneShowsPrompt, sendKeys, tmuxTarget, type KeyPart } from "../unstick.js";
import { resolveStopName } from "./stop.js";
import { requireTmuxPane } from "./unstick.js";

export type TypeArgs = {
  space?: string;
  /** `@name` or a folder; undefined → this folder's agent. */
  target?: string;
  /** The first word when no target was given — the caller checks it isn't an agent name. */
  bareFirst?: string;
  words: string[];
  keys: boolean;
  force: boolean;
};

/** A folder-looking target: the sigils every paw command treats as a path. */
const isPathish = (w: string) => w === "." || w === ".." || /^(\.{1,2}\/|~)/.test(w) || (w.startsWith("/") && existsSync(w));

export function parseTypeArgs(argv: string[]): TypeArgs {
  let space: string | undefined;
  let target: string | undefined;
  let keys = false;
  let force = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Flags count only BEFORE the text starts — `/model x --fast` must reach claude intact. A literal
    // `--` ends them early, for text that itself starts with a dash.
    if (words.length === 0) {
      if (a === "--") {
        words.push(...argv.slice(i + 1));
        break;
      }
      if (a === "--space") {
        space = argv[++i];
        if (space === undefined) throw new Error("paw: --space needs a value");
        continue;
      }
      if (a === "--force") { force = true; continue; }
      if (a === "--keys") { keys = true; continue; }
      if (a.startsWith("-")) throw new Error(`paw: unknown flag "${a}" — type [@name|folder] <text…> [--keys] [--force]`);
      if (target === undefined && (a.startsWith("@") || isPathish(a))) {
        target = a.startsWith("@") ? a.slice(1) : a;
        if (!target) throw new Error("paw: `@` needs an agent name");
        continue;
      }
    }
    words.push(a);
  }
  // The dispatcher appends `--space <s>` after everything; that pair is paw's, not the text.
  if (words.length >= 2 && words[words.length - 2] === "--space") space ??= words.splice(-2)[1];
  if (!words.length) throw new Error('paw: usage — type [@name|folder] <text…>   e.g. `paw type "/model claude-fable-5"`, `paw type --keys Down Enter`');
  return { space, target, bareFirst: target === undefined ? words[0] : undefined, words, keys, force };
}

/**
 * Text → what to press. `\n` (or `\r`) is Enter, `\e` Escape, `\t` Tab, `\\` a backslash — written as
 * two characters, because that's what a shell hands over for "\n" in quotes. `exact` is true when any
 * escape was used: then the text is a KEY SEQUENCE (sent as written, no Enter added); plain text is a
 * LINE (Enter appended).
 */
export function parseTyped(text: string): { parts: KeyPart[]; exact: boolean } {
  const parts: KeyPart[] = [];
  let lit = "";
  let exact = false;
  const flush = () => {
    if (lit) parts.push({ literal: lit });
    lit = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const nx = text[i + 1];
      const key = nx === "n" || nx === "r" ? "Enter" : nx === "e" ? "Escape" : nx === "t" ? "Tab" : undefined;
      if (key) {
        flush();
        parts.push({ key });
        exact = true;
        i++;
        continue;
      }
      if (nx === "\\") {
        lit += "\\";
        i++;
        continue;
      }
    }
    if (ch === "\n" || ch === "\r") {
      // A REAL newline (e.g. $'2\n') is Enter too.
      flush();
      parts.push({ key: "Enter" });
      exact = true;
      continue;
    }
    lit += ch;
  }
  flush();
  if (!exact) parts.push({ key: "Enter" });
  return { parts, exact };
}

/** tmux key names `--keys` accepts. A typo must fail HERE, not be typed as literal text. */
const KEY_NAME = /^(Up|Down|Left|Right|Enter|Escape|Tab|BTab|BSpace|Space|Home|End|PageUp|PageDown|PPage|NPage|DC|IC|F\d{1,2}|[CMS]-[A-Za-z0-9])$/;

export function parseKeyNames(words: string[]): KeyPart[] {
  const bad = words.filter((w) => !KEY_NAME.test(w));
  if (bad.length) throw new Error(`paw: not a key name: ${bad.map((b) => `"${b}"`).join(", ")} — use Up Down Left Right Enter Escape Tab BSpace Space C-c …`);
  return words.map((key) => ({ key }));
}

/** `model` from ~/.claude/settings.json, or undefined when unset/unreadable — for the /model warning. */
function globalDefaultModel(): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as { model?: unknown }).model;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The last few non-blank lines of a pane — what "what does it show now?" means to a person. */
export function paneTail(pane: string, n = 8): string[] {
  return pane
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

const describe = (parts: KeyPart[]) => parts.map((p) => ("key" in p ? `<${p.key}>` : p.literal)).join("");

async function type(argv: string[]): Promise<void> {
  const args = parseTypeArgs(argv);
  const space = args.space ?? resolveSpace();
  if (args.bareFirst && args.words.length > 1 && folderForName(space, args.bareFirst)) {
    throw new Error(
      `paw: "${args.bareFirst}" is one of your agents — did you mean \`paw type @${args.bareFirst} ${args.words.slice(1).join(" ")}\`? ` +
        `(a bare first word is TEXT, typed into this folder's agent; \`--\` before it if that's what you meant)`,
    );
  }
  const name = resolveStopName(space, args.target ?? ".");
  const { parts, exact } = args.keys ? { parts: parseKeyNames(args.words), exact: true } : parseTyped(args.words.join(" "));
  await requireTmuxPane(space, name, "type", "type into");

  const before = capturePane(space, name);
  if (before === undefined) throw new Error(`paw: can't read "${name}"'s pane (${tmuxTarget(space, name)})`);
  if (!exact && !args.force) {
    const box = paneInput(before);
    const refuse = (why: string): never => {
      throw new Error(`paw: not typing into "${name}" — ${why}. \`paw attach ${name}\` to look; \`--force\` types anyway, or send keys (\`\\n\`, \`--keys\`) to answer it.`);
    };
    if (paneShowsPrompt(before)) refuse("it's showing a permission/confirm prompt, and typed keys would ANSWER it");
    if (!box.visible) refuse("its input box isn't on screen (a menu or dialog has the keyboard)");
    if (box.text) refuse(`its input box already holds "${box.text.slice(0, 60)}" — your text would be appended to it`);
  }
  if (exact) {
    // Keys go in unguarded — so show what they are about to land on first.
    console.log(`${name} pane before:`);
    for (const l of paneTail(before, 6)) console.log(`  │ ${l}`);
  }
  const pin = readResumeId(personaFilePath(space, name));
  if (!exact && pin && readTurnState(pin)?.inFlight) console.log(`note: ${name} is mid-turn — what Claude Code does with a line submitted now is its call; the pane below shows it`);

  await sendKeys(space, name, parts);
  await new Promise((r) => setTimeout(r, 1500)); // let the TUI react before reading it back
  const after = capturePane(space, name);
  console.log(`✓ typed ${describe(parts)} into ${name}`);
  if (after === undefined) {
    console.log("  (couldn't read the pane back to show what it did)");
    return;
  }
  console.log("  pane now:");
  for (const l of paneTail(after)) console.log(`  │ ${l}`);
  // Claude Code's `/model` doesn't only switch THIS session: it also saves the model as the default for
  // every NEW claude session on the machine (~/.claude/settings.json) — so switching one agent quietly
  // switches every agent spawned or restarted after it. Measured 2026-09-23: the confirm printed "Set
  // model to Fable 5 and saved as your default for new sessions" and settings.json changed. paw doesn't
  // undo it behind your back (it's Claude Code's setting, and maybe you wanted it) — it says so, loudly.
  if (/saved as your default for new sessions/i.test(after)) {
    const def = globalDefaultModel();
    console.log(
      `  ⚠ Claude Code also saved this as the DEFAULT for new sessions${def ? ` (~/.claude/settings.json "model": "${def}")` : ""} — ` +
        `every agent started or restarted from now on boots on it. Change it back there if you only meant ${name}.`,
    );
  }
  // A line often opens a dialog rather than finishing (`/model x` asks to confirm). Say so, and how to
  // answer — but never answer it: confirming is the operator's decision, not a side effect of typing.
  if (paneShowsPrompt(after) || !paneInput(after).visible) {
    console.log(`  → ${name} is asking something. \`paw type ${args.target ? `@${name} ` : ""}"\\n"\` presses Enter; \`--keys Down Enter\` picks another option; \`--keys Escape\` cancels.`);
  }
}

const typeCommand: Command = {
  kind: "command",
  name: "type",
  group: "Mesh",
  summary: 'type into an agent\'s terminal without attaching — `paw type "/model claude-fable-5"`, `"2\\n"` or `--keys Down Enter` to answer a prompt (tmux)',
  usage: "type [@name|folder] <text…> [--keys] [--force] [--space s]",
  run: (a) => type([...a.raw]),
};

registry.register(typeCommand);
