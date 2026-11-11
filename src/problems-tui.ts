/**
 * `paw top --problems` on a tty: the problems view (src/problems.ts) live, with a cursor and one key per
 * action. Every action is an EXISTING paw verb run as a child process with the terminal handed over — paw's
 * own guards (wake gate, two-writer guard, assertMutableHere) stay in force; this file touches no agent.
 *
 * The operator's go: `r` (restart) and `u` (unstick) always ask `[y/N]` naming `name#space`, and exactly
 * one LATER key decides — keys that arrived in the same read as the one that raised the question are
 * discarded (type-ahead never consents, the rule chat-consent.ts applies to restart consent).
 * {@link problemsKey} is the pure reducer; {@link runProblemsTui} is the loop around it.
 */
import { spawn } from "node:child_process";
import {
  dismissKey,
  inboxFact,
  problemId,
  problemLines,
  spaceErrorLine,
  type Action,
  type Problem,
  type ProblemsReport,
} from "./problems.ts";
import { ago } from "./status.ts";
import { FAIL, LOADER, OK, presenceWord, reasonOf } from "./ux.ts";

export type Key = { k: string; chunk: number };

export type Mode =
  | { kind: "list" }
  | { kind: "confirm"; verb: "restart" | "unstick"; text: string; argv: string[]; chunk: number }
  | { kind: "dm"; target: string; draft: string };

export interface TuiState {
  report?: ProblemsReport;
  reading: boolean;
  refreshedAt?: number;
  cursor: number;
  /** The selected row's `name#space` — the cursor follows it across refreshes. */
  selected?: string;
  dismissed: ReadonlySet<string>;
  /** queued+unread per inbox row at the last refresh, and how much it rose since the one before. */
  lag: ReadonlyMap<string, number>;
  grew: ReadonlyMap<string, number>;
  mode: Mode;
  note?: string;
}

export type Effect =
  | { kind: "none" }
  | { kind: "run"; argv: string[]; waitKey: boolean }
  | { kind: "confirm"; text: string; argv: string[] }
  | { kind: "prompt"; what: "dm"; target: string }
  | { kind: "show"; text: string }
  | { kind: "refresh" }
  | { kind: "quit" };

export const initialState = (): TuiState => ({ reading: false, cursor: 0, dismissed: new Set(), lag: new Map(), grew: new Map(), mode: { kind: "list" } });

const VERB: Record<NonNullable<Action["key"]>, string> = { s: "start", w: "wake", r: "restart", u: "unstick", o: "open", l: "log", d: "dm", t: "tidy-ask" };
const KEY_ORDER: Array<NonNullable<Action["key"]>> = ["s", "w", "u", "r", "t", "o", "l", "d"];
const NONE: Effect = { kind: "none" };

/** The rows on screen: the report's, minus the dismissed. */
export function visible(state: TuiState): Problem[] {
  return (state.report?.problems ?? []).filter((p) => !state.dismissed.has(dismissKey(p)));
}

function select(state: TuiState, cursor: number): TuiState {
  const rows = visible(state);
  const c = Math.max(0, Math.min(rows.length - 1, cursor));
  return { ...state, cursor: rows.length ? c : 0, selected: rows.length ? problemId(rows[c]!) : undefined };
}

/** Keep the cursor on the same `name#space` when it still has a row, else at the same height. */
function follow(state: TuiState): TuiState {
  const rows = visible(state);
  const at = state.selected ? rows.findIndex((p) => problemId(p) === state.selected) : -1;
  return select(state, at >= 0 ? at : state.cursor);
}

const lagTotal = (p: Problem): number | undefined => (p.row?.inbox.kind === "lag" ? p.row.inbox.queued + p.row.inbox.unread : undefined);

/** Pure: a fresh report lands. Inbox growth is measured against the previous refresh only. */
export function problemsRefreshed(state: TuiState, report: ProblemsReport, now: number): TuiState {
  const lag = new Map<string, number>();
  const grew = new Map<string, number>();
  for (const p of report.problems) {
    if (p.reason !== "inbox") continue;
    const total = lagTotal(p);
    if (total === undefined) continue;
    const id = problemId(p);
    lag.set(id, total);
    const prev = state.lag.get(id);
    if (prev !== undefined && total > prev) grew.set(id, total - prev);
  }
  return follow({ ...state, report, reading: false, refreshedAt: now, lag, grew });
}

function confirmText(verb: "restart" | "unstick", p: Problem, now: number): string {
  const id = problemId(p);
  if (verb === "unstick") {
    const t = p.row?.tool;
    const what = t ? `${t.name}${t.startedMs !== undefined ? ` ${ago(t.startedMs, now)}` : ""}` : "its tool";
    return `unstick ${id}? Esc into its running tool (${what}) [y/N]`;
  }
  const row = p.row;
  if (row?.live) {
    const word = row.busy || row.mesh === "working" ? "working" : presenceWord(row.mesh);
    return `restart ${id}? it is live (${word}) — its turn is cut and it resumes from its pin [y/N]`;
  }
  return `restart ${id}? it is not live — this despawns any seat and starts it [y/N]`;
}

/** Is this row another machine's — every local action is text there? */
export const remoteRow = (p: Problem): boolean => p.where?.here === false || p.actions.some((a) => a.key && a.key !== "d" && !a.here);

/** Pure: one key → the next state and what the loop must do. */
export function problemsKey(state: TuiState, key: Key, now: number): { state: TuiState; effect: Effect } {
  const { k } = key;
  const mode = state.mode;
  if (mode.kind === "confirm") {
    // Type-ahead never consents: a key from the same read that raised the question is discarded.
    if (key.chunk === mode.chunk) return { state, effect: NONE };
    const back = { ...state, mode: { kind: "list" } as Mode };
    if (k === "y" || k === "Y") return { state: { ...back, note: undefined }, effect: { kind: "run", argv: mode.argv, waitKey: true } };
    const text = `${FAIL} not ${mode.verb === "restart" ? "restarted" : "unstuck"}`;
    return { state: { ...back, note: text }, effect: { kind: "show", text } };
  }
  if (mode.kind === "dm") {
    const back = { ...state, mode: { kind: "list" } as Mode };
    if (k === "esc" || k === "ctrl-c") return { state: back, effect: NONE };
    if (k === "enter") {
      const text = mode.draft.trim();
      return text ? { state: back, effect: { kind: "run", argv: ["dm", mode.target, text], waitKey: true } } : { state: back, effect: NONE };
    }
    if (k === "backspace") return { state: { ...state, mode: { ...mode, draft: [...mode.draft].slice(0, -1).join("") } }, effect: NONE };
    if ([...k].length === 1 && k >= " ") return { state: { ...state, mode: { ...mode, draft: mode.draft + k } }, effect: NONE };
    return { state, effect: NONE };
  }
  const s = { ...state, note: undefined };
  const rows = visible(s);
  const p = rows[s.cursor];
  switch (k) {
    case "up":
    case "k":
      return { state: select(s, s.cursor - 1), effect: NONE };
    case "down":
    case "j":
      return { state: select(s, s.cursor + 1), effect: NONE };
    case "q":
    case "ctrl-c":
      return { state: s, effect: { kind: "quit" } };
    case "R":
      return { state: s, effect: { kind: "refresh" } };
    case "x": {
      if (!p) return { state: s, effect: NONE };
      return { state: follow({ ...s, dismissed: new Set([...s.dismissed, dismissKey(p)]), selected: undefined }), effect: NONE };
    }
    case "X":
      return { state: follow({ ...s, dismissed: new Set() }), effect: NONE };
  }
  if (!["s", "w", "r", "u", "o", "l", "d", "t"].includes(k) || !p) return { state: s, effect: NONE };
  const action = p.actions.find((a) => a.key === k);
  const id = problemId(p);
  // Another machine's agent: every local key prints the command for THAT machine and runs nothing (paw never sshes).
  if (k !== "d" && (action ? !action.here : remoteRow(p))) {
    const cmd = (action ?? p.primary)?.cmd;
    const text = cmd ? `on ${p.where?.label ?? "another machine"}: ${cmd}` : `${id} runs on ${p.where?.label ?? "another machine"} — only d works from here`;
    return { state: { ...s, note: text }, effect: { kind: "show", text } };
  }
  if (!action) {
    const text = `${VERB[k as keyof typeof VERB]} isn't offered for ${id}`;
    return { state: { ...s, note: text }, effect: { kind: "show", text } };
  }
  if (k === "d") return { state: { ...s, mode: { kind: "dm", target: action.argv![1]!, draft: "" } }, effect: { kind: "prompt", what: "dm", target: action.argv![1]! } };
  if (action.confirm) {
    const verb = k === "u" ? "unstick" : "restart";
    const text = confirmText(verb, p, now);
    return { state: { ...s, mode: { kind: "confirm", verb, text, argv: action.argv!, chunk: key.chunk } }, effect: { kind: "confirm", text, argv: action.argv! } };
  }
  return { state: s, effect: { kind: "run", argv: action.argv!, waitKey: k !== "o" } };
}

/** Raw terminal input → key names (`up` `down` `enter` `esc` `backspace` `ctrl-c`, or the character). */
export function parseKeys(data: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length; ) {
    const rest = data.slice(i);
    const seq = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
    if (seq) {
      const last = seq[0].slice(-1);
      if (last === "A") out.push("up");
      else if (last === "B") out.push("down");
      i += seq[0].length;
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    i += ch.length;
    if (ch === "\x1b") out.push("esc");
    else if (ch === "\r" || ch === "\n") out.push("enter");
    else if (ch === "\x7f" || ch === "\b") out.push("backspace");
    else if (ch === "\x03") out.push("ctrl-c");
    else out.push(ch);
  }
  return out;
}

// ---------- the screen (pure) ----------

const paint = (on: boolean, code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
const fit = (s: string, w: number) => (s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`);

function footerOf(state: TuiState, p: Problem | undefined, width: number): string[] {
  const mode = state.mode;
  if (mode.kind === "confirm") return [mode.text];
  if (mode.kind === "dm") return [`dm ${mode.target} › ${mode.draft}`];
  const nav = "↑↓ move · R refresh · q quit";
  const lines: string[] = [];
  if (p) {
    const id = problemId(p);
    if (remoteRow(p)) {
      const label = p.where?.label ?? "another machine";
      const would = p.primary && !p.primary.here && p.primary.class !== "shown" ? ` · on ${label}: ${p.primary.cmd}` : "";
      lines.push(`${id} · runs on ${label} · d dm · x dismiss${would}`);
    } else {
      const keys = KEY_ORDER.filter((k) => p.actions.some((a) => a.key === k && a.here)).map((k) => `${k} ${VERB[k]}`);
      const shown = p.actions.find((a) => a.class === "shown");
      const left = [id, ...keys, "x dismiss", ...(shown ? [shown.cmd] : [])].join(" · ");
      lines.push(left.length + 4 + nav.length <= width ? `${left}${" ".repeat(Math.max(4, width - left.length - nav.length))}${nav}`.trimEnd() : left);
      if (left.length + 4 + nav.length > width) lines.push(nav);
    }
  } else lines.push(nav);
  if (state.dismissed.size) lines.push(`${state.dismissed.size} dismissed · X shows them`);
  if (state.note) lines.push(state.note);
  return lines;
}

/** Pure: the whole screen for `state`, `height` rows tall at most. */
export function renderTui(state: TuiState, o: { width: number; height: number; now: number; tty: boolean }): string {
  const r = state.report;
  const rows = visible(state);
  const dim = paint(o.tty, "2");
  const head: string[] = [];
  if (!r) head.push(`${LOADER} reading…`);
  else {
    const read = r.spaces.map((s) => s.space).join(" · ");
    const when = state.reading ? `${LOADER} reading…` : state.refreshedAt !== undefined ? `refreshed ${ago(state.refreshedAt, o.now)} ago` : "";
    head.push(`problems on ${r.machine}${read ? ` · ${read}` : ""} · ${rows.length} ${rows.length === 1 ? "needs" : "need"} attention${when ? ` · ${when}` : ""}`);
    for (const s of r.spaces) if (s.read === "error") head.push(`${spaceErrorLine(s)} · R retries`);
    for (const e of r.errors) head.push(dim(fit(e, o.width)));
  }
  head.push("");
  const p = rows[state.cursor];
  const footer = ["──", ...footerOf(state, p, o.width)];
  let body: string[];
  if (r && !rows.length) body = [`${paint(o.tty, "32")(OK)} nothing needs attention${state.dismissed.size ? " (dismissed rows hidden)" : ""}`];
  else {
    const lines = problemLines(rows, {
      width: o.width - 2,
      now: o.now,
      tty: o.tty,
      doColumn: false,
      fact: (q) => (q.reason === "inbox" && q.row ? inboxFact(q.row.inbox, state.grew.get(problemId(q))) : q.fact),
    });
    const sel = p ? problemId(p) : undefined;
    const selAt = lines.findIndex((l) => l.id !== undefined && l.id === sel);
    const room = Math.max(1, o.height - head.length - footer.length);
    const start = selAt < 0 ? 0 : Math.max(0, Math.min(selAt - Math.floor(room / 2), lines.length - room));
    body = lines.slice(start, start + room).map((l, i) => {
      const mine = start + i === selAt;
      const text = fit(`${mine ? "▸ " : "  "}${l.text}`, o.width + (l.text.length - l.text.replace(/\x1b\[[0-9;]*m/g, "").length));
      return mine && o.tty ? `\x1b[7m${text}\x1b[0m` : text;
    });
  }
  const all = [...head, ...body, ...footer.map((l, i) => (i === 0 ? dim(l) : fit(l, o.width)))];
  return all.slice(0, o.height).join("\n");
}

// ---------- the loop ----------

export interface TuiOptions {
  collect: () => Promise<ProblemsReport>;
  /** Run `paw <argv…>` with the terminal handed over; resolves to its exit code. */
  run?: (argv: string[]) => Promise<number>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  refreshMs?: number;
}

/** The real runner: this same paw (runtime, release, PAW_HOME/PAW_SPACE/PAW_RELEASE inherited), the tty handed over. */
export function runPaw(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...argv], { stdio: "inherit", env: process.env });
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

const ENTER = "\x1b[?1049h\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?1049l";
const cmdLine = (argv: string[]) => `paw ${argv.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;

/** Drive the TUI until `q`. Resolves to the exit code (0). */
export function runProblemsTui(o: TuiOptions): Promise<number> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const run = o.run ?? runPaw;
  const refreshMs = o.refreshMs ?? 5000;
  const tty = !process.env.NO_COLOR;
  let state = initialState();
  let chunk = 0;
  let busy = false;
  let done = false;
  let restored = true;

  const paintScreen = () => {
    if (busy || done) return;
    const screen = renderTui(state, { width: stdout.columns ?? 100, height: stdout.rows ?? 30, now: Date.now(), tty });
    stdout.write(`\x1b[H${screen.split("\n").map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
  };
  const enter = () => {
    stdout.write(ENTER);
    stdin.setRawMode?.(true);
    stdin.resume();
    restored = false;
  };
  const leave = () => {
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write(LEAVE);
    restored = true;
  };
  const onExit = () => {
    if (!restored) stdout.write(LEAVE);
  };
  process.once("exit", onExit);

  let reading: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (reading || done) return reading ?? Promise.resolve();
    state = { ...state, reading: true };
    paintScreen();
    reading = o
      .collect()
      .then(
        (report) => {
          state = problemsRefreshed(state, report, Date.now());
        },
        (e: Error) => {
          state = { ...state, reading: false, note: `${FAIL} couldn't read (${reasonOf(e.message)}) · R retries` };
        },
      )
      .finally(() => {
        reading = undefined;
        paintScreen();
      });
    return reading;
  };

  return new Promise<number>((resolve) => {
    const timer = setInterval(() => void refresh(), refreshMs);
    const onResize = () => paintScreen();
    stdout.on("resize", onResize);

    const quit = () => {
      done = true;
      clearInterval(timer);
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      leave();
      process.off("exit", onExit);
      resolve(0);
    };

    const anyKey = () =>
      new Promise<void>((res) => {
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.once("data", () => {
          stdin.pause();
          res();
        });
      });

    const runAction = async (argv: string[], waitKey: boolean) => {
      busy = true;
      stdin.off("data", onData);
      leave();
      stdout.write(`\x1b[2m$ ${cmdLine(argv)}\x1b[0m\n`);
      const code = await run(argv);
      stdout.write(code === 0 ? `${OK} done\n` : `${FAIL} exited ${code}\n`);
      if (waitKey) {
        stdout.write("\x1b[2mpress any key\x1b[0m");
        await anyKey();
        stdout.write("\n");
      }
      busy = false;
      enter();
      stdin.on("data", onData);
      await refresh();
    };

    function onData(data: Buffer | string) {
      if (busy || done) return;
      chunk++;
      for (const k of parseKeys(data.toString())) {
        const r = problemsKey(state, { k, chunk }, Date.now());
        state = r.state;
        const e = r.effect;
        if (e.kind === "quit") return quit();
        if (e.kind === "refresh") void refresh();
        if (e.kind === "run") {
          void runAction(e.argv, e.waitKey); // the rest of this read is type-ahead into a child's terminal — dropped
          return;
        }
      }
      paintScreen();
    }

    enter();
    stdin.on("data", onData);
    void refresh();
  });
}
