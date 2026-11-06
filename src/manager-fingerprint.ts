/**
 * The MANAGER FINGERPRINT of a release: one hash over everything the cotal manager process
 * (`bin/cotald.ts supervise`) loads or is launched with, so `paw restart` can tell a paw release that
 * changes the manager (cotal bump, connector edit → every agent must be respawned) from one that
 * doesn't (CLI, chat, web, mailbox, office… → only the mailbox needs the new code, agents keep running).
 *
 * WHAT IT COVERS (conservative: when in doubt, a file is in):
 *   - the static import graph of `bin/cotald.ts` (paw's connector, kit/hermes/acp, sandbox, hub paths
 *     and everything they import), followed through relative `import`/`export … from`/literal `import()`;
 *   - files those modules reach through `new URL("<rel>", import.meta.url)` (the sandbox runner +
 *     Containerfile, …) — a code file is followed as a further graph root;
 *   - the cotal hub (`src/hub/daemon.mjs` graph + `cotal-shim.c`): the connector points agents at it, and
 *     a kept manager means a kept hub; `src/manager-features.json` (what the CLI may ask of the manager);
 *   - HOW paw launches the manager: the top-level declarations of `src/lifecycle.ts` reachable from
 *     `startManagerDaemon` (argv, env shaping, tmux/cmux/gui-session handling), by source text, plus
 *     the file graph of every relative module those declarations import from;
 *   - every dependency: package.json (minus `scripts`/`description`), pnpm-lock.yaml, and the
 *     INSTALLED state `node_modules/.pnpm/lock.yaml` (patch hashes included) — any lock change is a
 *     manager change, CLI-only dep or not.
 *
 * NOT covered: the node binary's version, and the operator's ambient environment (PATH, …). A changed
 * node is a `paw restart --full`.
 *
 * Stored in the release at snapshot time ({@link MANAGER_FINGERPRINT_FILE}); a release without one is
 * computed from its (immutable) tree on demand. A checkout (`PAW_RELEASE=dev`) is mutable — what the
 * manager loaded can't be known — so it never gets a fingerprint and always restarts in full.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MANAGER_FINGERPRINT_FILE = "manager-fingerprint.json";

/** Bumped whenever the inputs below change shape: fingerprints of different versions never compare equal. */
const ALGO = "paw-manager-fingerprint/1";

/** The manager's entry, the hub it pairs with, and launch-time assets no import statement names. */
const GRAPH_ROOTS = ["bin/cotald.ts", "src/hub/daemon.mjs"];
const EXTRA_FILES = ["src/hub/cotal-shim.c", "src/manager-features.json"];
const LAUNCH_FILE = "src/lifecycle.ts";
const LAUNCH_ENTRY = "startManagerDaemon";

export interface ManagerFingerprint {
  fingerprint: string;
  /** Root-relative files hashed (sorted). */
  files: string[];
  /** lifecycle.ts declarations hashed as the manager's launch spec (sorted). */
  launch: string[];
}

const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

const CODE_RE = /\.(?:ts|mts|mjs|js|cjs)$/;

function walkDir(abs: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(abs, e.name);
    if (e.isDirectory()) out.push(...walkDir(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Every file reachable from `roots` (absolute paths) inside `root`: relative imports + `new URL(…, import.meta.url)`. */
export function moduleGraph(root: string, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    if (!inside(file)) throw new Error(`paw: manager fingerprint: ${file} is outside ${root}`);
    if (!existsSync(file)) throw new Error(`paw: manager fingerprint: ${relative(root, file)} is missing`);
    seen.add(file);
    if (!CODE_RE.test(file)) continue;
    const refs = moduleRefs(file, relative(root, file));
    for (const spec of refs.imports) if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
    for (const u of refs.urls) {
      const target = resolve(dirname(file), u);
      if (!existsSync(target)) throw new Error(`paw: manager fingerprint: ${relative(root, file)} names ${u}, which doesn't exist`);
      if (!statSync(target).isDirectory()) stack.push(target);
      // An ANCESTOR directory is the tree root (src/hub/paths.ts' TREE_ROOT) — the files it reads
      // under it are listed in EXTRA_FILES, never the whole tree. Any other directory: every file.
      else if (!file.startsWith(target + sep)) stack.push(...walkDir(target));
    }
  }
  return seen;
}

/** What one module names: relative specifiers it imports (static, `export … from`, literal `import()`,
 *  `import("x")` types) and `new URL("<rel>", import.meta.url)` targets. Parsed, so comments never
 *  count. A non-literal `import()` fails loud — its target can't be known statically. */
export function moduleRefs(file: string, label = file): { imports: string[]; urls: string[] } {
  const t = ts();
  const sf = t.createSourceFile(file, readFileSync(file, "utf8"), t.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const urls: string[] = [];
  const lit = (n: import("typescript").Node | undefined) => (n && (t.isStringLiteral(n) || t.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
  const visit = (n: import("typescript").Node): void => {
    if ((t.isImportDeclaration(n) || t.isExportDeclaration(n)) && n.moduleSpecifier) {
      const s = lit(n.moduleSpecifier);
      if (s !== undefined) imports.push(s);
    } else if (t.isCallExpression(n) && n.expression.kind === t.SyntaxKind.ImportKeyword) {
      const s = lit(n.arguments[0]);
      if (s === undefined) throw new Error(`paw: manager fingerprint: ${label} has a non-literal import() — its target can't be known statically`);
      imports.push(s);
    } else if (t.isImportTypeNode(n) && t.isLiteralTypeNode(n.argument)) {
      const s = lit(n.argument.literal);
      if (s !== undefined) imports.push(s);
    } else if (t.isNewExpression(n) && t.isIdentifier(n.expression) && n.expression.text === "URL" && n.arguments?.length === 2) {
      const s = lit(n.arguments[0]);
      if (s !== undefined && n.arguments[1].getText(sf) === "import.meta.url") urls.push(s);
    }
    t.forEachChild(n, visit);
  };
  visit(sf);
  return { imports, urls };
}

type Ts = typeof import("typescript");
let tsMod: Ts | undefined;
function ts(): Ts {
  tsMod ??= createRequire(import.meta.url)("typescript") as Ts;
  return tsMod;
}

interface ParsedModule {
  sf: import("typescript").SourceFile;
  declOf: Map<string, import("typescript").Node>;
  /** local name → [specifier, imported name ("*" = namespace, "default")]. */
  importOf: Map<string, [string, string]>;
}

function parseModule(file: string): ParsedModule {
  const t = ts();
  const sf = t.createSourceFile(file, readFileSync(file, "utf8"), t.ScriptTarget.Latest, true);
  const declOf = new Map<string, import("typescript").Node>();
  const importOf = new Map<string, [string, string]>();
  for (const st of sf.statements) {
    if (t.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as import("typescript").StringLiteral).text;
      const cl = st.importClause;
      if (cl?.name) importOf.set(cl.name.text, [spec, "default"]);
      const nb = cl?.namedBindings;
      if (nb && t.isNamedImports(nb)) for (const el of nb.elements) importOf.set(el.name.text, [spec, (el.propertyName ?? el.name).text]);
      if (nb && t.isNamespaceImport(nb)) importOf.set(nb.name.text, [spec, "*"]);
    } else if ((t.isFunctionDeclaration(st) || t.isClassDeclaration(st) || t.isEnumDeclaration(st)) && st.name) declOf.set(st.name.text, st);
    else if (t.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (t.isIdentifier(d.name)) declOf.set(d.name.text, st);
    }
  }
  return { sf, declOf, importOf };
}

/**
 * The top-level declarations reachable from `entry` in `file` by identifier reference — FOLLOWED ACROSS
 * relative imports into the declarations they name — keyed `<file>#<name>` with their source text.
 * An import that names no top-level declaration of its module (a re-export, a namespace, a default)
 * puts that whole module in `files` instead. Pure parse, no evaluation.
 */
export function launchClosure(file: string, entry: string): { decls: Map<string, string>; files: Set<string> } {
  const t = ts();
  const mods = new Map<string, ParsedModule>();
  const mod = (f: string): ParsedModule => {
    let m = mods.get(f);
    if (!m) mods.set(f, (m = parseModule(f)));
    return m;
  };
  if (!mod(file).declOf.has(entry)) throw new Error(`paw: manager fingerprint: ${entry} is not a top-level declaration of ${file}`);
  const decls = new Map<string, string>();
  const files = new Set<string>();
  const queue: [string, string][] = [[file, entry]];
  while (queue.length) {
    const [f, name] = queue.pop()!;
    const key = `${f}#${name}`;
    if (decls.has(key)) continue;
    const m = mod(f);
    decls.set(key, m.declOf.get(name)!.getText(m.sf));
    const visit = (n: import("typescript").Node): void => {
      if (t.isIdentifier(n)) {
        const id = n.text;
        if (m.declOf.has(id)) queue.push([f, id]);
        const imp = m.importOf.get(id);
        if (imp && imp[0].startsWith(".")) {
          const target = resolve(dirname(f), imp[0]);
          if (!existsSync(target)) throw new Error(`paw: manager fingerprint: ${f} imports ${imp[0]}, which doesn't exist`);
          if (CODE_RE.test(target) && mod(target).declOf.has(imp[1])) queue.push([target, imp[1]]);
          else files.add(target);
        }
      }
      t.forEachChild(n, visit);
    };
    visit(m.declOf.get(name)!);
  }
  return { decls, files };
}

/** package.json as it bears on what's installed: everything but the run scripts and the blurb. */
function depManifest(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  delete pkg.scripts;
  delete pkg.description;
  return JSON.stringify(Object.keys(pkg).sort().map((k) => [k, pkg[k]]));
}

/** Compute `root`'s manager fingerprint from its files. Throws (naming what) when it can't. */
export function computeManagerFingerprint(root: string): ManagerFingerprint {
  root = resolve(root);
  const launch = launchClosure(join(root, LAUNCH_FILE), LAUNCH_ENTRY);
  const graph = moduleGraph(root, [...GRAPH_ROOTS.map((f) => join(root, f)), ...EXTRA_FILES.map((f) => join(root, f)), ...launch.files]);
  const files = [...graph].map((f) => relative(root, f)).sort();
  const launchDecls = new Map([...launch.decls].map(([k, v]) => [relative(root, k), v]));
  const installed = join(root, "node_modules", ".pnpm", "lock.yaml");
  if (!existsSync(installed)) throw new Error(`paw: manager fingerprint: ${installed} is missing — can't tell which dependencies are installed`);
  const h = createHash("sha256");
  const line = (k: string, v: string) => h.update(`${k}\0${v}\n`);
  line("algo", ALGO);
  for (const f of files) line(`file:${f}`, sha(readFileSync(join(root, f))));
  const names = [...launchDecls.keys()].sort();
  for (const n of names) line(`launch:${n}`, sha(launchDecls.get(n)!));
  line("deps:package.json", sha(depManifest(root)));
  line("deps:pnpm-lock.yaml", sha(readFileSync(join(root, "pnpm-lock.yaml"))));
  line("deps:node_modules/.pnpm/lock.yaml", sha(readFileSync(installed)));
  return { fingerprint: h.digest("hex").slice(0, 16), files, launch: names };
}

/** Write the fingerprint into a release being built (its staging dir). */
export function writeManagerFingerprint(root: string, fp: ManagerFingerprint = computeManagerFingerprint(root)): ManagerFingerprint {
  writeFileSync(join(root, MANAGER_FINGERPRINT_FILE), `${JSON.stringify(fp, null, 2)}\n`);
  return fp;
}

/** The fingerprint stored in a release, or undefined when it has none. A malformed file fails loud. */
export function storedManagerFingerprint(root: string): string | undefined {
  const file = join(root, MANAGER_FINGERPRINT_FILE);
  if (!existsSync(file)) return undefined;
  const v = (JSON.parse(readFileSync(file, "utf8")) as { fingerprint?: unknown }).fingerprint;
  if (typeof v !== "string" || !v) throw new Error(`paw: ${file} has no "fingerprint"`);
  return v;
}

/** A release's fingerprint: the stored one, else computed from its immutable tree. */
export function releaseManagerFingerprint(root: string): { fingerprint: string; stored: boolean } {
  const stored = storedManagerFingerprint(root);
  return stored !== undefined ? { fingerprint: stored, stored: true } : { fingerprint: computeManagerFingerprint(root).fingerprint, stored: false };
}

// ---- the restart decision --------------------------------------------------------------------

/** What `paw restart` (no target) learned before deciding. Gathered impurely by the command. */
export interface RestartFacts {
  /** `--full` given. */
  full: boolean;
  /** `paw restart <runtime>` — always a full restart. */
  runtime?: string;
  /** A failed earlier restart left agents to revive. */
  pendingRevive: boolean;
  managerPids: number[];
  /** The running manager's code root, or why it couldn't be read. */
  managerRoot: string | { error: string };
  runningRuntime?: string;
  preferredRuntime: string;
  /** daemonRoot(): the tree a restart would start daemons from, or why it can't be named. */
  targetRoot: string | { error: string };
  /** `releaseId` of a root under the releases dir, undefined for anything else (the dev checkout). */
  releaseOf: (root: string) => string | undefined;
  fingerprintOf: (root: string) => string;
  /** Does the running manager answer ps? Asked last (a mesh round-trip). */
  managerAnswers: () => Promise<boolean>;
}

export type RestartPlan = { kind: "full"; why: string } | { kind: "keep-manager"; from: string; to: string; fingerprint: string };

/** Keep the manager (and so every agent) only when everything says its code would be identical. */
export async function planRestart(f: RestartFacts): Promise<RestartPlan> {
  const full = (why: string): RestartPlan => ({ kind: "full", why });
  if (f.full) return full("--full");
  if (f.runtime !== undefined) return full(`runtime ${f.runtime} asked for`);
  if (f.pendingRevive) return full("a failed restart left agents to revive");
  if (f.managerPids.length === 0) return full("no manager running");
  if (f.managerPids.length > 1) return full(`${f.managerPids.length} manager processes (pid ${f.managerPids.join(", ")}) — a restart leaves one`);
  if (typeof f.managerRoot !== "string") return full(`can't tell which code the manager runs (${f.managerRoot.error})`);
  if (typeof f.targetRoot !== "string") return full(`can't name the release to restart onto (${f.targetRoot.error})`);
  if ((f.runningRuntime ?? "pty") !== f.preferredRuntime) return full(`the manager runs ${f.runningRuntime ?? "pty"} but this space prefers ${f.preferredRuntime}`);
  const from = f.releaseOf(f.managerRoot);
  const to = f.releaseOf(f.targetRoot);
  if (from === undefined) return full(`the manager runs ${f.managerRoot}, not a release — its loaded code can't be known`);
  if (to === undefined) return full(`the daemons would start from ${f.targetRoot}, not a release`);
  let a: string, b: string;
  try {
    a = f.fingerprintOf(f.managerRoot);
    b = f.fingerprintOf(f.targetRoot);
  } catch (e) {
    return full(`couldn't fingerprint the manager code (${(e as Error).message})`);
  }
  if (a !== b) return full(`manager code changed (release ${from} → ${to})`);
  if (!(await f.managerAnswers())) return full("the manager isn't answering");
  return { kind: "keep-manager", from, to, fingerprint: a };
}
