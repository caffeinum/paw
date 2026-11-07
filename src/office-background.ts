/**
 * Background work for the office bridge (beads-y1eg): an agent that launched a Workflow, async subagents or a
 * background shell and then ended its turn reads `idle` on the mesh while that work runs. The sleep sweep already
 * knows it ({@link rowActivity}: transcript task records + the process tree); this reads the same thing for the
 * bridge's rows, cheaply enough for its 10s/2s refreshes.
 *
 * Cost: only rows NOT running a turn are read (a working agent shows working anyway); a row's read is reused
 * while its transcript's mtime is unchanged (a task's end lands there as a `<task-notification>`) and for at most
 * {@link MAX_AGE_MS}, since a background shell can exit without a transcript write. One `ps` per refresh at most,
 * and only when some row actually needs a fresh read. An unreadable activity is no background — the row shows
 * what the mesh says, exactly as before — and a failed read is one log line per distinct error, never a throw.
 */
import { personaFilePath } from "./addressing.ts";
import { backgroundLabel, running, type Row } from "./office-bridge.ts";
import { personaTranscriptRoots, transcriptMtime } from "./session.ts";
import { liveInspector, rowActivity, type Activity, type ProcInspector } from "./sleep.ts";

export const MAX_AGE_MS = 60_000;

export type BackgroundRow = Row & { pin?: string };

export interface BackgroundDeps {
  /** Changes whenever the row's transcript does; undefined = no transcript to read. */
  stamp(space: string, row: BackgroundRow): string | undefined;
  activity(space: string, row: BackgroundRow, inspect: ProcInspector): Activity;
  inspector(): ProcInspector;
  now(): number;
}

export const liveBackgroundDeps: BackgroundDeps = {
  stamp: (space, row) => {
    if (!row.pin) return undefined;
    const mtime = transcriptMtime(row.pin, personaTranscriptRoots(personaFilePath(space, row.name)));
    return mtime === undefined ? undefined : `${row.pin}|${mtime}`;
  },
  activity: (space, row, inspect) => rowActivity(space, { name: row.name, pin: row.pin }, inspect),
  inspector: liveInspector,
  now: Date.now,
};

export class BackgroundReader {
  private cache = new Map<string, { stamp: string; at: number; label?: string }>();

  private readonly space: string;
  private readonly log: (line: string) => void;
  private readonly deps: BackgroundDeps;

  constructor(space: string, log: (line: string) => void, deps: BackgroundDeps = liveBackgroundDeps) {
    this.space = space;
    this.log = log;
    this.deps = deps;
  }

  private lastError = new Map<string, string>();
  private failed(name: string, e: unknown): undefined {
    const msg = (e as Error).message?.split("\n")[0] ?? String(e);
    if (this.lastError.get(name) !== msg) this.log(`background work of ${name} unreadable (shown as the mesh says): ${msg}`);
    this.lastError.set(name, msg);
    return undefined;
  }

  /** `rows` with `background` set where an ended turn left work running. A row whose presence already says so
   *  (the patched Stop hook, via withPresence) is kept as is: that is the agent's own word. Never throws. */
  annotate<R extends BackgroundRow>(rows: readonly R[]): R[] {
    let inspect: ProcInspector | undefined;
    const now = this.deps.now();
    return rows.map((row) => {
      if (row.background) return row;
      const rest = row;
      if (!row.live || !row.pin || (row.mesh !== "idle" && row.mesh !== "waiting") || running(row)) return rest as R;
      let stamp: string | undefined;
      try {
        stamp = this.deps.stamp(this.space, row);
      } catch (e) {
        stamp = this.failed(row.name, e);
      }
      if (!stamp) return rest as R;
      const hit = this.cache.get(row.name);
      let label: string | undefined;
      if (hit && hit.stamp === stamp && now - hit.at < MAX_AGE_MS) label = hit.label;
      else {
        try {
          const a = this.deps.activity(this.space, row, (inspect ??= this.deps.inspector()));
          label = a.unknown ? undefined : backgroundLabel(a.kinds ?? []);
          this.lastError.delete(row.name);
        } catch (e) {
          label = this.failed(row.name, e);
        }
        this.cache.set(row.name, { stamp, at: now, label });
      }
      return (label ? { ...rest, background: label } : rest) as R;
    });
  }
}
