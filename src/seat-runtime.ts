/**
 * Which runtime runs ONE agent's seat: its persona `runtime:` (cotal >=0.107 picks a runtime per seat,
 * the manager creates the tmux runtime beside its own) over the space's manager runtime. Every reader
 * that branches on "is there a tmux pane" (attach, status, unstick/type, the startup-prompt watch) asks
 * this, never the space's runtime alone. docs/notes/lifecycle.md#per-seat-runtime
 */
import { personaFilePath } from "./addressing.ts";
import { readSeatRuntime, type SeatRuntime } from "./session.ts";

export function seatRuntimeOf<R extends string>(space: string, name: string, managerRuntime: R | undefined): SeatRuntime | R | undefined {
  return readSeatRuntime(personaFilePath(space, name)) ?? managerRuntime;
}
