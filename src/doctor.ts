/**
 * `paw doctor [--fix] [--space <s> | --all] [--offline] [--verbose] [--json]` — paw's health on THIS
 * machine: machine-wide state plus every space under $PAW_HOME/spaces, one line per fact, in ux.ts's
 * vocabulary. `--fix` applies only the repairs that touch no live agent and lose no data (class A, see
 * src/doctor-checks.ts), then checks everything again; anything else is printed as the exact command for
 * the operator and never run. It starts nothing: no mesh, manager or hub (bin/paw.ts gates
 * neither NEEDS_MESH nor NEEDS_MANAGER for it, and injects no --space: a machine checkup must not narrow
 * to the shell's PAW_SPACE). docs/notes/cli.md#paw-doctor.
 *
 * CLI-only: nothing here is in the manager fingerprint (src/manager-fingerprint.ts), so it is live the
 * moment it is merged — no restart.
 */
import { registry, type Command } from "@cotal-ai/core";
import { join } from "node:path";
import { gatherCtx, machineChecks, spaceChecks, spaceServer, tildeOf, type DoctorCtx, type Row } from "./doctor-checks.ts";
import { localSpaces } from "./namespace.ts";
import { DEFAULT_SPACE } from "./space.ts";
import { writeJson, writeOut } from "./stdout.ts";
import { FAIL, OK, WARN } from "./ux.ts";
import { displayWidth, fitWidth, sliceWidth } from "./width.ts";

export const DOCTOR_USAGE = "doctor [--fix] [--space <s> | --all] [--offline] [--verbose] [--json]";

export interface DoctorArgs {
  fix: boolean;
  space?: string;
  offline: boolean;
  verbose: boolean;
  json: boolean;
}

/** Pure. `--space` with `--all`, a stray word or an unknown flag is a usage error. */
export function parseDoctorArgs(argv: string[]): DoctorArgs {
  const out: DoctorArgs = { fix: false, offline: false, verbose: false, json: false };
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--fix") out.fix = true;
    else if (a === "--all") all = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--json") out.json = true;
    else if (a === "--space" || a.startsWith("--space=")) {
      const v = a === "--space" ? argv[++i] : a.slice("--space=".length);
      if (!v || v.startsWith("-")) throw new Error(`paw doctor: --space needs a space — ${DOCTOR_USAGE}`);
      if (out.space !== undefined) throw new Error(`paw doctor: one --space at most — ${DOCTOR_USAGE}`);
      out.space = v;
    } else if (a.includes("#")) throw new Error(`paw doctor: no <agent>#<space> here — doctor checks spaces, not agents (--space <s>) — ${DOCTOR_USAGE}`);
    else throw new Error(`paw doctor: unexpected "${a}" — ${DOCTOR_USAGE}`);
  }
  if (all && out.space !== undefined) throw new Error(`paw doctor: --space and --all don't go together — ${DOCTOR_USAGE}`);
  return out;
}

export interface FixResult {
  id: string;
  space?: string;
  did?: string;
  error?: string;
}

export interface Report {
  host: string;
  pawHome: string;
  cotalHome: string;
  home: string;
  envSpace?: string;
  spaces: string[];
  servers: Record<string, { server: string; remote: boolean }>;
  network: "checked" | "skipped";
  fix: boolean;
  fixed: FixResult[];
  rows: Row[];
}

/** paw first, then the shell's PAW_SPACE, then the rest alphabetically. */
export function orderSpaces(all: string[], envSpace: string | undefined): string[] {
  const rank = (s: string): number => (s === DEFAULT_SPACE ? 0 : s === envSpace ? 1 : 2);
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface DoctorDeps {
  /** Builds a fresh context (a new process snapshot) — called before the checks and again after fixes. */
  makeCtx?: (o: { offline: boolean; spaces: string[] }) => DoctorCtx;
}

async function collect(ctx: DoctorCtx): Promise<Row[]> {
  const [machine, ...spaces] = await Promise.all([machineChecks(ctx), ...ctx.spaces.map((s) => spaceChecks(ctx, s))]);
  return [...machine!, ...spaces.flat()];
}

/** Gather, check, (fix, re-check). Never exits; returns the report. */
export async function runDoctor(args: DoctorArgs, deps: DoctorDeps = {}): Promise<Report> {
  const env = process.env;
  const make = deps.makeCtx ?? ((o) => gatherCtx(o));
  const probe = make({ offline: args.offline, spaces: [] });
  const tilde = tildeOf(probe.home);
  const here = localSpaces(probe.pawHome);
  if (args.space !== undefined && !here.includes(args.space)) {
    throw new Error(`paw doctor: no space "${args.space}" under ${tilde(join(probe.pawHome, "spaces"))} (spaces here: ${here.join(", ") || "none"})`);
  }
  const envSpace = env.PAW_SPACE?.trim() || undefined;
  const spaces = args.space !== undefined ? [args.space] : orderSpaces(here, envSpace);
  let ctx = make({ offline: args.offline, spaces });
  let rows = await collect(ctx);
  const fixed: FixResult[] = [];
  if (args.fix) {
    for (const r of rows) {
      if (!r.fix) continue;
      try {
        fixed.push({ id: r.id, ...(r.space ? { space: r.space } : {}), did: await r.fix.run() });
      } catch (e) {
        fixed.push({ id: r.id, ...(r.space ? { space: r.space } : {}), error: (e as Error).message || String(e) });
      }
    }
    ctx = make({ offline: args.offline, spaces });
    rows = await collect(ctx);
  }
  const servers: Report["servers"] = {};
  for (const s of spaces) {
    try {
      const { server, remote } = spaceServer(s);
      servers[s] = { server, remote: !!remote };
    } catch {
      /* an unreadable record is its own ✕ row (spaceChecks) */
    }
  }
  return {
    host: ctx.host,
    pawHome: ctx.pawHome,
    cotalHome: ctx.cotalHome,
    home: ctx.home,
    ...(envSpace ? { envSpace } : {}),
    spaces,
    servers,
    network: args.offline ? "skipped" : "checked",
    fix: args.fix,
    fixed,
    rows,
  };
}

const GLYPH = { ok: OK, warn: WARN, fail: FAIL } as const;
const COLOR = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" } as const;
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function summary(r: Report): { ok: number; warn: number; fail: number; fixable: number } {
  const n = (s: Row["status"]) => r.rows.filter((x) => x.status === s).length;
  return { ok: n("ok"), warn: n("warn"), fail: n("fail"), fixable: r.rows.filter((x) => x.fix).length };
}

/** The exit code: 1 when any ✕ row is left or any fix failed. */
export function exitCode(r: Report): number {
  return r.rows.some((x) => x.status === "fail") || r.fixed.some((f) => f.error !== undefined) ? 1 : 0;
}

/**
 * `head + text` word-wrapped to `cols`, every following line indented to `head`'s width. A word wider
 * than the line is split. What the operator must type is wrapped, never cut. Pure.
 */
export function wrapLine(head: string, text: string, cols: number): string[] {
  const indent = " ".repeat(displayWidth(head));
  const room = Math.max(10, cols - displayWidth(head));
  const out: string[] = [];
  let line = "";
  for (let tok of text.match(/\S+\s*/g) ?? []) {
    while (displayWidth(tok.trimEnd()) > room) {
      if (line.trim()) out.push(line.trimEnd());
      const cut = sliceWidth(tok, room);
      out.push(cut);
      tok = tok.slice(cut.length);
      line = "";
    }
    if (line && displayWidth(line + tok.trimEnd()) > room) {
      out.push(line.trimEnd());
      line = "";
    }
    line += tok;
  }
  if (line.trim() || !out.length) out.push(line.trimEnd());
  return out.map((l, i) => (i === 0 ? head : indent) + l);
}

/** The report as the terminal shows it. Pure. */
export function renderReport(r: Report, o: { tty: boolean; verbose: boolean; columns?: number }): string {
  const tilde = tildeOf(r.home);
  const cols = o.tty && o.columns ? o.columns : undefined;
  const fit = (s: string): string => (cols ? fitWidth(s, cols) : s);
  let elided = false;
  const lines: string[] = [];
  const n = r.spaces.length;
  lines.push(fit(`paw doctor${r.fix ? " --fix" : ""} · ${r.host} · ${tilde(r.pawHome)} · ${n} ${n === 1 ? "space" : "spaces"}`));
  const rowLine = (status: Row["status"], label: string, text: string): string => {
    const full = `  ${GLYPH[status]} ${label.padEnd(16)} ${text}`;
    const plain = fit(full);
    if (plain !== full) elided = true;
    if (!o.tty) return plain;
    // Colour after eliding: the glyph keeps its hue, the id is dim.
    const body = plain.slice(`  ${GLYPH[status]} `.length);
    const idPart = body.slice(0, Math.min(body.length, label.padEnd(16).length));
    return `  ${COLOR[status]}${GLYPH[status]}${RESET} ${DIM}${idPart}${RESET}${body.slice(idPart.length)}`;
  };
  // A line the operator acts on (`you:`, `--fix:`) wraps; it is never cut.
  const sub = (head: string, text: string): string[] => (cols ? wrapLine(`      ${head}`, text, cols) : [`      ${head}${text}`]);
  if (r.fix) {
    lines.push("", "fixed");
    if (!r.fixed.length) lines.push("  nothing to fix — no safe repair applies");
    for (const f of r.fixed) {
      const label = f.space ? `${f.space}/${f.id}` : f.id;
      if (f.error === undefined) lines.push(rowLine("ok", label, f.did ?? ""));
      else lines.push(rowLine("fail", label, "fix failed"), ...sub("", f.error));
    }
  }
  const section = (title: string, rows: Row[]): void => {
    lines.push("", fit(title));
    for (const x of rows) {
      lines.push(rowLine(x.status, x.id, x.fact));
      // --verbose is where the full text lives: a cut fact is shown whole (unless an item already
      // carries it), and items are never cut.
      const items = o.verbose ? (x.items ?? []) : [];
      if (o.verbose && cols && displayWidth(`  ${GLYPH[x.status]} ${x.id.padEnd(16)} ${x.fact}`) > cols && !items.some((i) => i.includes(x.fact))) lines.push(...sub("", x.fact));
      if (x.status !== "ok") {
        if (x.fix) lines.push(...sub("--fix: ", x.fix.action));
        else if (x.skipped) lines.push(...sub("--fix: ", `skipped${x.skipped.startsWith("(") ? " " : " — "}${x.skipped}`));
        else if (x.command) lines.push(...sub("you: ", x.command));
      }
      for (const i of items) lines.push(`      ${i}`);
    }
  };
  section("machine", r.rows.filter((x) => x.space === undefined));
  for (const s of r.spaces) {
    const sv = r.servers[s];
    const where = sv ? ` · ${sv.remote ? "remote" : "local"} ${sv.server}` : "";
    section(`space ${s}${where}${r.envSpace === s ? " · PAW_SPACE" : ""}`, r.rows.filter((x) => x.space === s));
  }
  const t = summary(r);
  let foot = `${t.fail} ${FAIL} · ${t.warn} ${WARN} · ${t.ok} ${OK}`;
  if (t.fixable > 0 && !r.fix) foot += ` · paw doctor --fix repairs ${t.fixable} (no agent is touched)`;
  if (r.rows.some((x) => x.status !== "ok" && x.command)) foot += " · the rest need you (commands above)";
  if (r.network === "skipped") foot += " · network not checked (--offline)";
  if (elided && !o.verbose) foot += " · --verbose shows cut lines whole";
  // The footer says what to run next: wrapped, never cut.
  lines.push("", ...(cols ? wrapLine("", foot, cols) : [foot]));
  return lines.join("\n") + "\n";
}

/** The `--json` document. */
export function reportJson(r: Report): unknown {
  return {
    host: r.host,
    pawHome: r.pawHome,
    cotalHome: r.cotalHome,
    spaces: r.spaces,
    network: r.network,
    fixed: r.fixed.map((f) => ({ id: f.id, space: f.space ?? null, ...(f.error !== undefined ? { error: f.error } : { did: f.did ?? "" }) })),
    checks: r.rows.map((x) => ({
      id: x.id,
      space: x.space ?? null,
      status: x.status,
      fact: x.fact,
      fix: x.fix?.action ?? null,
      command: x.command ?? null,
      skipped: x.skipped ?? null,
      items: x.items ?? [],
    })),
    summary: summary(r),
  };
}

async function doctor(argv: string[]): Promise<void> {
  const args = parseDoctorArgs(argv);
  const report = await runDoctor(args);
  if (args.json) writeJson(reportJson(report));
  else writeOut(renderReport(report, { tty: process.stdout.isTTY === true, verbose: args.verbose, columns: process.stdout.columns }));
  // Probes abandoned at their cap must not keep the process alive.
  process.exit(exitCode(report));
}

const doctorCommand: Command = {
  kind: "command",
  name: "doctor",
  group: "Lifecycle",
  summary: "check paw's health on this machine; --fix repairs only what touches no agent (prints the rest)",
  usage: DOCTOR_USAGE,
  run: (a) => doctor([...a.raw]),
};

registry.register(doctorCommand);
