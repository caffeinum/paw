/**
 * Shell completion — the same two-layer protocol @cotal-ai/cli ships for `cotal` (thin per-shell
 * stub → forwards every <TAB> to a hidden `__complete` dispatcher → live candidates), reimplemented
 * for `paw` since bin/paw.ts owns its own dispatch and never imports @cotal-ai/cli. Reuses core's
 * `CompletionItem`/`CompletionResult` types so the wire format matches exactly.
 *
 *   paw completion zsh|bash            # print the stub to stdout
 *   paw completion install [shell]     # install it persistently (auto-detects $SHELL)
 *   paw __complete <words…>            # internal: candidates for the current cursor position
 *
 * `__complete` is local-only by contract (registry names + folders.json/agents.json — no mesh, no
 * manager), so a <TAB> never blocks on a cold daemon. bin/paw.ts gives `__complete` a dedicated
 * early branch (mirrors `claude`'s passthrough) so withDefaultSpace/expandEqFlags never mangle the
 * half-typed line being completed.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { registry, type Command, type CompletionItem } from "@cotal-ai/core";
import { listAgents } from "../addressing.js";
import { resolveSpace } from "../lifecycle.js";

/** Verbs bin/paw.ts handles inline in its own dispatch (cotal/down/help) — NOT registry Commands
 *  (unlike `claude`, which self-registers in src/claude.ts and so is already in commandSurface()
 *  via the registry), so they're invisible to `registry.all("command")` and need listing here too. */
const EARLY_VERBS: Array<{ name: string; summary: string }> = [
  { name: "cotal", summary: "passthrough to the raw cotal CLI" },
  { name: "down", summary: "stop the daemons paw started for this space" },
  { name: "help", summary: "show the one-screen command list" },
];

/** Commands whose first positional is an agent name (folders.json default ∪ agents.json extra) —
 *  `start` takes any NUMBER of them, the rest take exactly one. Centralized here rather than a
 *  `complete` hook per command file: one map, one behavior, easy to extend as commands are added. */
const AGENT_TARGET_COMMANDS = new Set([
  "dm",
  "chat",
  "open",
  "attach",
  "adopt",
  "rename",
  "rm",
  "sessions",
  "log",
  "stop",
  "start",
]);

function agentNameItems(): CompletionItem[] {
  return listAgents(resolveSpace()).map(({ name }) => ({ value: name }));
}

/** The full top-level surface completion should offer: registered commands (skipping hidden/`__`
 *  internals, same visibility as bin/paw.ts's own help()) plus the early verbs. */
function commandSurface(): Array<{ name: string; summary: string }> {
  const registered = registry
    .all<Command>("command")
    .filter((c) => c.hidden !== true && !c.name.startsWith("__"))
    .map((c) => ({ name: c.name, summary: c.summary }));
  return [...registered, ...EARLY_VERBS].sort((a, b) => a.name.localeCompare(b.name));
}

function emit(items: CompletionItem[], directive: "default" | "nospace" | "nofiles" = "nofiles"): void {
  const lines = items.map((i) => (i.description ? `${i.value}\t${i.description}` : i.value));
  lines.push(`:${directive}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** `paw __complete <words…>` — words are everything typed after `paw`, up to and including the
 *  (possibly empty) word under the cursor. No candidate filtering by prefix here — the shell glue
 *  (compgen -W/_describe) narrows against what's already typed; this always emits the full set for
 *  the current position, exactly like cotal's own dispatcher. */
function complete(argv: string[]): void {
  if (argv.length === 0) {
    emit(commandSurface().map((c) => ({ value: c.name, description: c.summary })), "nofiles");
    return;
  }
  const cmdName = argv[0];
  const cmd = commandSurface().find((c) => c.name === cmdName);
  // Not (yet) a recognized command word: still offer command names (covers the case where the
  // shell hands us a lone partial word with no trailing empty cursor token).
  if (!cmd) {
    emit(commandSurface().map((c) => ({ value: c.name, description: c.summary })), "nofiles");
    return;
  }
  if (AGENT_TARGET_COMMANDS.has(cmdName)) {
    emit(agentNameItems(), "nofiles");
    return;
  }
  // No completion opinion for this command's arguments (flags, free text, …) — offer nothing
  // rather than guess; the shell falls back to its default (e.g. filenames).
  emit([], "default");
}

const completeCommand: Command = {
  kind: "command",
  name: "__complete",
  group: "Internal",
  summary: "(internal) emit completion candidates for the current command line",
  hidden: true,
  run: (a) => {
    complete([...a.raw]);
    return Promise.resolve();
  },
};

// ── `paw completion <shell>` — print or install the stub ─────────────────────────────────────────

function lines(...l: string[]): string {
  return `${l.join("\n")}\n`;
}

const SCRIPTS: Record<string, string> = {
  bash: lines(
    "# paw bash completion - forwards each <TAB> to `paw __complete` (dynamic).",
    "_paw_complete() {",
    "  local cur out line",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  local -a args=("${COMP_WORDS[@]:1:COMP_CWORD}")',
    '  out="$(paw __complete "${args[@]}" 2>/dev/null)" || return',
    "  local -a values=()",
    "  while IFS= read -r line; do",
    '    [ -z "$line" ] && continue',
    '    case "$line" in',
    "      :*) ;;",
    `      *) values+=("\${line%%$'\\t'*}") ;;`,
    "    esac",
    '  done <<< "$out"',
    '  COMPREPLY=($(compgen -W "${values[*]}" -- "$cur"))',
    "}",
    "complete -F _paw_complete paw",
  ),
  zsh: lines(
    "#compdef paw",
    "# paw zsh completion - forwards each <TAB> to `paw __complete` (dynamic).",
    "_paw() {",
    '  local -a args; args=("${(@)words[2,CURRENT]}")',
    "  local out line val desc",
    '  out="$(paw __complete "${args[@]}" 2>/dev/null)"',
    "  local -a descs",
    "  while IFS= read -r line; do",
    '    [[ -z "$line" || "$line" == :* ]] && continue',
    `    val="\${line%%$'\\t'*}"; desc="\${line#*$'\\t'}"`,
    '    if [[ "$desc" != "$line" ]]; then descs+=("$val:$desc"); else descs+=("$val"); fi',
    '  done <<< "$out"',
    "  (( ${#descs} )) && _describe -t paw paw descs",
    "}",
    "compdef _paw paw",
  ),
};

function completionRun(a: { raw: readonly string[] }): void {
  const argv = [...a.raw];
  if (argv[0] === "install") return install(argv[1]);
  const script = argv[0] ? SCRIPTS[argv[0]] : undefined;
  if (!script) {
    console.error("usage: paw completion <bash|zsh | install [shell]>");
    console.error("  enable it now (this shell):  source <(paw completion zsh)");
    console.error("  or install it persistently:  paw completion install");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(script);
}

/** `paw completion install [shell]` — wire the stub into your shell persistently. Opt-in (never run
 *  automatically). Auto-detects from $SHELL when omitted; fails loud on an unsupported one. Writes
 *  the stub to a cached file and sources THAT from the rc (deterministic + no `paw` spawn on every
 *  shell start), and the rc line is added at most once — re-running just refreshes the stub. */
function install(shell?: string): void {
  const sh = shell ?? basename(process.env.SHELL ?? "");
  if (!SCRIPTS[sh]) {
    console.error(`can't install for "${sh || "unknown shell"}" - pass one of: bash, zsh`);
    process.exitCode = 1;
    return;
  }
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "paw");
  const stub = join(dir, `completion.${sh}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stub, SCRIPTS[sh]);
  const rc = sh === "zsh" ? join(process.env.ZDOTDIR || homedir(), ".zshrc") : join(homedir(), ".bashrc");
  const line = `source "${stub}"`;
  let current = "";
  try {
    current = readFileSync(rc, "utf8");
  } catch {
    // rc doesn't exist yet — appendFileSync creates it.
  }
  if (current.includes(line)) {
    console.log(`already installed in ${rc}`);
    console.log(`  refreshed ${stub}`);
    return;
  }
  appendFileSync(rc, `${current && !current.endsWith("\n") ? "\n" : ""}# paw shell completion\n${line}\n`);
  console.log(`✓ installed ${sh} completion`);
  console.log(`  ${stub}\n  appended to ${rc}\n  open a new shell (or: source ${stub})`);
}

const completionCommand: Command = {
  kind: "command",
  name: "completion",
  group: "Setup",
  summary: "shell completion — print a stub or install it persistently (paw completion install)",
  usage: "completion <bash|zsh | install [shell]>",
  run: (a) => {
    completionRun(a);
    return Promise.resolve();
  },
};

registry.register(completeCommand);
registry.register(completionCommand);
