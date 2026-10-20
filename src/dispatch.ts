/**
 * paw's CLI dispatch helpers — pure + unit-tested so routing regressions can't slip through.
 *
 * The endpoint-native rewrite shrank this to two helpers: every paw verb is now a paw-owned
 * command (no upstream verb renames to alias over, no flags-only cotal `stop` to positional-ize,
 * and there IS no top-level `send` to footgun — bin/paw.ts errors on it with a pointer instead).
 *
 * withDefaultSpace injects paw's default --space so the operator never types it. stripCotalNamespace
 * peels the `paw cotal <cmd>` escape-hatch prefix so bin can route the remainder to the cotald
 * subprocess. hoistAddressSpace turns `<agent>#<space>` into `<agent> --space <space>`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readRemoteMesh } from "./remote-mesh.ts";
import { DEFAULT_SPACE, resolveSpace } from "./space.ts";

/**
 * `paw cotal <cmd> …` → strip the namespace word; bin spawns the remainder against bin/cotald.ts
 * (the raw cotal CLI composition root) as a subprocess. Stripping happens FIRST so the passthrough
 * still gets mesh gating + --space injection. Pure, so check:dispatch covers it.
 */
export function stripCotalNamespace(argv: string[]): string[] {
  return argv[0] === "cotal" ? argv.slice(1) : argv;
}

/**
 * The stderr note for `paw cotal send dm|ask` without `--creds`, else undefined.
 *
 * cotal's one-shot `send` connects as a FRESH principal every run (`connectOrThrow` mints
 * `newIdentity()` on an auth mesh; an open mesh self-mints) and binds no inbox, so an agent that
 * replies to the sender — which the mesh brief tells it to do — stores the reply on a subject nobody
 * will ever read. It shows in `paw history` as `agent → <login>@<host>` and nowhere else; a headless
 * `cotal join` on the same machine is a DIFFERENT principal and never sees it (team2027, 2026-10-19).
 * `--creds` of a session that holds an inbox (a running join) makes the sender that principal, so
 * replies reach it. `msg` is not flagged: channel replies go to the channel. Pure; check:dispatch.
 */
export function oneShotReplyNote(argv: string[]): string | undefined {
  if (argv[0] !== "send" || (argv[1] !== "dm" && argv[1] !== "ask")) return undefined;
  const end = argv.indexOf("--");
  const mine = end === -1 ? argv : argv.slice(0, end);
  if (mine.some((a) => a === "--creds" || a.startsWith("--creds="))) return undefined;
  return (
    "paw: note — `cotal send` speaks from a one-shot identity with no inbox: a reply to it reaches nobody " +
    "(it shows only in `paw history`). For a reply you can read, use `paw dm <agent> \"…\"` (replies land in " +
    "`paw inbox`), or pass --creds of a session that holds an inbox (e.g. a running `cotal join`)."
  );
}

/**
 * Append `--space <space>` as a TRAILING flag (parseArgs collects flags from anywhere, so a command
 * that reads its subcommand from the FIRST positional — e.g. cotal's `history clear` via the
 * passthrough — still sees it; injecting at the front would shadow that subcommand). Skip injection
 * only when the operator passed a REAL `--space` flag — a `--space` token that has a following
 * value, or `--space=…` — never a bare `--space` word sitting as the final token of a message body.
 */
export function withDefaultSpace(argv: string[], space: string): string[] {
  // A `--` terminator ends PAW's arguments: everything after it belongs to something else (the MCP
  // server's own command line in `paw mcp add x -- npx -y pkg`). Appending to the very end put paw's
  // `--space paw` INSIDE that command — the server was configured to run `npx -y pkg --space paw`,
  // silently, which is precisely the leak the terminator exists to prevent. So the injection goes
  // BEFORE the terminator, and an operator `--space` is only recognised before it too: one written
  // after `--` is the child's argument, not an answer to paw's question.
  const end = argv.indexOf("--");
  const mine = end === -1 ? argv : argv.slice(0, end);
  const operatorPassedSpace = mine.some(
    (a, i) => (a === "--space" && i < mine.length - 1) || a.startsWith("--space="),
  );
  if (operatorPassedSpace) return argv;
  return end === -1 ? [...argv, "--space", space] : [...argv.slice(0, end), "--space", space, ...argv.slice(end)];
}

/**
 * Expand `--space=<v>` / `--server=<v>` into their two-token forms. withDefaultSpace recognizes
 * the `=` form as operator-provided (and skips injecting), but every paw command's hand parser
 * reads only the two-token form — without this, `paw ps --space=main` would pass the injection
 * skip and then be rejected by the command. Only these two flags: never touch positionals or
 * message bodies. Pure, so check:dispatch covers it.
 */
export function expandEqFlags(argv: string[]): string[] {
  return argv.flatMap((a) => {
    for (const flag of ["--space", "--server"]) {
      if (a.startsWith(flag + "=")) return [flag, a.slice(flag.length + 1)];
    }
    return [a];
  });
}

/**
 * A raw cotal verb aimed at a REMOTE space (`paw mesh add`), rewritten so cotal can resolve it.
 *
 * cotal resolves a mesh by `--space` against ITS registry, and a remote paw space is not in it
 * (`cotal meshes add --mode auth` refuses a signer-only root — remote-mesh.md "cotal gaps"). So:
 *  - `--space <s>` with `--server` and no registry entry is cotal's raw OPEN arm: a bare connect, no
 *    credentials, and every control verb then dies on the authed broker;
 *  - `--space <s>` without `--server` is "no mesh named <s> is running";
 *  - `--creds <file>` is a raw cred with no endpoint-caller triple, which every control call refuses
 *    ("this control call has no endpoint-caller triple …").
 * What works is `--server <record server>` with NO `--space`, run with cwd = the record root: cotal's
 * resolver then takes the folder's `.cotal/auth` (the stripped signer — `loadSpaceAuth` accepts it),
 * names the space from it, and mints the one-shot instrument itself. This drops the operator's
 * `--space`/`--server`/`--creds` (before any `--`) and appends the record's server; the caller sets
 * the cwd. `droppedCreds` lets it say so. Pure, so check:remote covers it.
 */
export function remoteCotalArgv(argv: string[], server: string): { argv: string[]; droppedCreds: boolean } {
  const x = expandEqFlags(argv);
  const end = x.indexOf("--");
  const mine = end === -1 ? x : x.slice(0, end);
  const out: string[] = [];
  let droppedCreds = false;
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    if (a === "--space" || a === "--server" || a === "--creds") {
      if (a === "--creds") droppedCreds = true;
      if (i + 1 < mine.length && !mine[i + 1].startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--creds=")) {
      droppedCreds = true;
      continue;
    }
    out.push(a);
  }
  out.push("--server", server);
  return { argv: end === -1 ? out : [...out, ...x.slice(end)], droppedCreds };
}

/** The operator's explicit `--space <s>` / `--space=<s>` (before any `--` terminator), else undefined. */
export function explicitSpace(args: string[]): string | undefined {
  const argv = expandEqFlags(args);
  const end = argv.indexOf("--");
  const mine = end === -1 ? argv : argv.slice(0, end);
  const i = mine.indexOf("--space");
  const v = i >= 0 ? mine[i + 1] : undefined;
  return v && !v.startsWith("-") ? v : undefined;
}

/**
 * The space `paw down` tears down: `--space <s>` / `--space=<s>`, else `fallback` (resolveSpace —
 * PAW_SPACE or the default). `down` used to ignore its args entirely, so `paw down --space test-x`
 * with no PAW_SPACE in the env stopped the LIVE `paw` space's manager, mailbox and hub (2026-10-05).
 * Anything else on the line is refused: a teardown verb never guesses what a stray word meant.
 */
export function downSpace(args: string[], fallback: () => string): string {
  const argv = expandEqFlags(args);
  if (argv.length === 0) return fallback();
  if (argv.length === 2 && argv[0] === "--space" && argv[1] && !argv[1].startsWith("-")) return argv[1];
  throw new Error(`paw down: unexpected arguments ${JSON.stringify(args)} — usage: paw down [--space <s>]`);
}

/**
 * One-letter short forms (`paw a` = `paw attach`), for the verbs typed dozens of times a day.
 *
 * An explicit TABLE, not prefix matching. A prefix that's unique today goes ambiguous the day a verb
 * is added (`paw re` means release until someone adds `rescan`), so a script or a finger that worked
 * yesterday breaks without anything having changed for it. And `a` isn't a unique prefix anyway —
 * attach, adopt and ask all start with it — so the letters have to be chosen, and choosing is a table.
 *
 * Nothing destructive gets a letter: `rm`, `stop`, `restart`, `down` stay spelled out, one typo from
 * each other being exactly the case a short form would make worse.
 */
export const SHORT_FORMS: Readonly<Record<string, string>> = {
  a: "attach",
  c: "chat",
  s: "status",
  l: "log",
  d: "dm",
  i: "inbox",
  w: "web",
};

/** The real verb for `word` — a short form expanded, anything else returned as typed. */
export function expandShortForm(word: string | undefined): string | undefined {
  return word !== undefined && Object.hasOwn(SHORT_FORMS, word) ? SHORT_FORMS[word] : word;
}

/**
 * `<agent>#<space>` — shorthand for `<agent> --space <space>`, accepted wherever an agent (or, for
 * chat/msg/history, a channel) is named. THE one parser: bin/paw.ts hoists it into `--space` before
 * the mesh gate and the default-space injection; the one-space surfaces (chat's REPL, paw web) call
 * `sameSpaceAddress`. Precedence, first match wins:
 *   1. no `#`                         → untouched
 *   2. `http(s)://…`, `web:…`         → untouched (`#` is the URL fragment)
 *   3. `github:…`, `gh:…`             → the FIRST `#` (gh's `@`) is the BRANCH, as always; a later
 *                                       `#<known space>` fails loud — a branch may itself contain `#`,
 *                                       so paw won't guess. Use `--space` with a handle.
 *   4. `#chan` (leading `#`)          → a channel, untouched; `#chan#space` → `#chan` on `space`
 *   5. an EXISTING path with `#` in it → that folder, untouched — unless the suffix is also a known
 *                                       space, which fails loud (both readings are real)
 *   6. else split on the LAST `#`     → name / folder / `repo@branch`, plus the space, which must
 *                                       exist (the current or default space, a local space dir, or a
 *                                       `paw mesh add` record) or it fails loud. Agent names
 *                                       (`[A-Za-z0-9_-]`) and space names never contain `#`, so a
 *                                       second `#` fails loud.
 */
export interface AddressDeps {
  isKnownSpace: (space: string) => boolean;
  knownSpaces: () => string[];
  pathExists: (path: string) => boolean;
}

const SPACE_NAME = /^[A-Za-z0-9_-]+$/;

function stateRoot(): string {
  return process.env.PAW_HOME?.trim() || join(homedir(), ".paw");
}

/** The real-filesystem AddressDeps: a space is known when it is the current/default one, has a state
 *  dir under `$PAW_HOME/spaces/`, or has a remote-mesh record. */
export function addressDeps(): AddressDeps {
  const spacesDir = join(stateRoot(), "spaces");
  const knownSpaces = (): string[] => {
    const dirs = existsSync(spacesDir) ? readdirSync(spacesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    return [...new Set([resolveSpace(), DEFAULT_SPACE, ...dirs])].filter((s) => SPACE_NAME.test(s)).sort();
  };
  return {
    knownSpaces,
    isKnownSpace: (s) => SPACE_NAME.test(s) && (s === resolveSpace() || s === DEFAULT_SPACE || existsSync(join(spacesDir, s)) || readRemoteMesh(s) !== undefined),
    pathExists: (p) => existsSync(p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : resolve(p)),
  };
}

export function splitAddressSpace(token: string, deps: AddressDeps = addressDeps()): { target: string; space?: string } {
  const hash = token.lastIndexOf("#");
  if (hash === -1) return { target: token };
  if (/^https?:\/\//.test(token) || token.startsWith("web:")) return { target: token };
  if (token.startsWith("github:") || token.startsWith("gh:")) {
    const handle = token.startsWith("gh:") ? token.replace("@", "#") : token;
    const last = handle.lastIndexOf("#");
    const suffix = handle.slice(last + 1);
    if (handle.indexOf("#") !== last && deps.isKnownSpace(suffix))
      throw new Error(
        `paw: "${token}" is ambiguous — in a github handle the first "#" is the branch and a branch may contain "#", ` +
          `so "#${suffix}" could be either. Pass the space as a flag: --space ${suffix}`,
      );
    return { target: token };
  }
  const channel = token.startsWith("#");
  if (channel && hash === 0) return { target: token };
  const space = token.slice(hash + 1);
  if (deps.pathExists(token)) {
    if (deps.isKnownSpace(space))
      throw new Error(
        `paw: "${token}" is ambiguous — it is an existing folder AND <name>#<space> for space "${space}". ` +
          "Rename the folder, or address it by its agent name.",
      );
    return { target: token };
  }
  const target = token.slice(0, hash);
  const name = channel ? target.slice(1) : target;
  if (name.includes("#"))
    throw new Error(`paw: "${token}" has more than one "#" — agent, channel and space names never contain "#"; write <name>#<space>`);
  if (name === "" || name === "@") throw new Error(`paw: "${token}" names nothing before "#${space}"`);
  if (space === "") throw new Error(`paw: "${token}" has an empty space after "#" — write <name>#<space>`);
  if (!SPACE_NAME.test(space)) throw new Error(`paw: "${token}": space "${space}" must be letters, digits, '-' or '_'`);
  if (!deps.isKnownSpace(space)) {
    const known = deps.knownSpaces();
    throw new Error(
      `paw: unknown space "${space}" in "${token}" — known: ${known.length ? known.join(", ") : "(none)"} ` +
        "(`paw mesh add` registers a remote one)",
    );
  }
  return { target, space };
}

/** For a surface bound to ONE space (chat's REPL, paw web): `name#<that space>` → `name`; another
 *  space fails loud instead of silently addressing the wrong mesh. */
export function sameSpaceAddress(token: string, space: string, surface: string, deps: AddressDeps = addressDeps()): string {
  const r = splitAddressSpace(token, deps);
  if (r.space !== undefined && r.space !== space)
    throw new Error(`paw: "${token}" is on space "${r.space}", but this ${surface} is on "${space}" — reach it from that space (\`paw chat ${r.target}#${r.space}\`, \`paw web --space ${r.space}\`)`);
  return r.target;
}

/** Which argv slots of a command name an agent (or a channel), so `#space` is only ever read THERE —
 *  never in a message body (`paw dm a "see #12"`). `values` = the command's flags that take a value
 *  (skipped; or, when also in `names`, read as an address). `slots` = which positionals: "all", a list
 *  of indices, or `{ from: n }`. `atOnly`: the slot counts only when `@`-prefixed and scanning stops at
 *  the first positional (type's bare first word may be the text itself). */
export interface AddressSpec {
  values: string[];
  names?: string[];
  slots: "all" | number[] | { from: number };
  atOnly?: boolean;
}

const V = ["--space", "--server"];
export const ADDRESS_ARGS: Readonly<Record<string, AddressSpec>> = {
  chat: { values: [...V, "--model", "--agent", "--provider", "--name", "--personality"], names: ["--name"], slots: [0] },
  dm: { values: [...V, "--model", "--name"], names: ["--name"], slots: [0] },
  open: { values: [...V, "--model", "--name"], names: ["--name"], slots: [0] },
  attach: { values: [...V, "--model", "--name"], names: ["--name"], slots: [0] },
  log: { values: [...V, "--tail", "-n"], slots: [0] },
  sessions: { values: V, slots: [0] },
  stop: { values: [...V, "--name"], names: ["--name"], slots: [0] },
  rm: { values: V, slots: [0] },
  rename: { values: V, slots: "all" },
  adopt: { values: [...V, "--resume", "--session", "--name"], names: ["--name"], slots: [0] },
  status: { values: V, slots: "all" },
  start: { values: V, slots: "all" },
  sleep: { values: [...V, "--after"], slots: "all" },
  inbox: { values: [...V, "--limit", "-n"], slots: "all" },
  restart: { values: [...V, "--agent", "--model"], slots: [0] },
  unstick: { values: V, slots: [0] },
  type: { values: V, slots: [0], atOnly: true },
  nice: { values: V, slots: [0] },
  persona: { values: V, slots: [0] },
  optimize: { values: [...V, "--since"], slots: "all" },
  top: { values: [...V, "--sort"], slots: "all" },
  tidy: { values: [...V, "--older", "--min-mb"], slots: "all" },
  launchd: { values: [...V, "--web-port"], slots: { from: 1 } },
  ask: { values: V, slots: [0] },
  msg: { values: V, slots: [0] },
  history: { values: [...V, "--limit", "-n"], slots: [0] },
  claude: { values: V, names: ["--name"], slots: [] },
};

const bareAddress = (token: string, deps: AddressDeps): boolean => {
  try {
    return splitAddressSpace(token, deps).space !== undefined;
  } catch {
    return false;
  }
};

/** `paw claude`'s own boolean flags (src/claude.ts peelArgs) — anything else begins claude's args. */
const CLAUDE_PAW_FLAGS = ["--fg", "--foreground", "--no-attach"];

const inSlot = (slots: AddressSpec["slots"], i: number): boolean =>
  slots === "all" ? true : Array.isArray(slots) ? slots.includes(i) : i >= slots.from;

/**
 * Rewrite a command's argv so every `<x>#<space>` in an address slot becomes `<x>` plus ONE
 * `--space <space>`. Several addresses must agree, and an explicit `--space` that disagrees fails loud
 * — paw never picks one. `paw claude` gets the flag FIRST (its parser stops at the first claude arg);
 * everything else gets it where withDefaultSpace puts it. Unlisted commands pass through untouched.
 */
export function hoistAddressSpace(cmd: string, args: string[], deps: AddressDeps = addressDeps()): string[] {
  const spec = Object.hasOwn(ADDRESS_ARGS, cmd) ? ADDRESS_ARGS[cmd] : undefined;
  if (!spec || !args.some((a) => a.includes("#"))) return args;
  const out = [...args];
  const found: Array<{ token: string; space: string }> = [];
  const take = (i: number, prefix = ""): void => {
    const token = out[i].slice(prefix.length);
    const r = splitAddressSpace(token, deps);
    if (r.space === undefined) return;
    found.push({ token, space: r.space });
    out[i] = prefix + r.target;
  };
  const end = out.indexOf("--") === -1 ? out.length : out.indexOf("--");
  let pos = 0;
  for (let i = 0; i < end; i++) {
    const a = out[i];
    const eqName = spec.names?.find((f) => a.startsWith(`${f}=`));
    if (eqName) take(i, `${eqName}=`);
    else if (spec.names?.includes(a)) {
      if (i + 1 < end) take(i + 1);
      i++;
    } else if (spec.values.includes(a)) {
      i++;
    } else if (a.startsWith("-")) {
      if (cmd === "claude" && !CLAUDE_PAW_FLAGS.includes(a)) break; // the first non-paw flag starts claude's own args
    } else {
      if (cmd === "claude") break;
      const slot = pos++;
      if (spec.atOnly) {
        if (a.startsWith("@") && inSlot(spec.slots, slot)) take(i);
        else if (i + 1 < end && bareAddress(a, deps))
          throw new Error(`paw: "${a}" looks like <agent>#<space> — an agent is \`@\`-prefixed here: \`paw ${cmd} @${a} …\``);
        break;
      }
      if (inSlot(spec.slots, slot)) take(i);
    }
  }
  if (!found.length) return args;
  const spaces = [...new Set(found.map((f) => f.space))];
  if (spaces.length > 1)
    throw new Error(`paw: ${found.map((f) => `"${f.token}"`).join(", ")} name different spaces (${spaces.join(", ")}) — one command acts on one space`);
  const space = spaces[0];
  const explicit = explicitSpace(args);
  if (explicit !== undefined && explicit !== space)
    throw new Error(`paw: "${found[0].token}" says space "${space}" but --space says "${explicit}" — drop one; paw won't pick`);
  if (explicit !== undefined) return out;
  return cmd === "claude" ? ["--space", space, ...out] : withDefaultSpace(out, space);
}
