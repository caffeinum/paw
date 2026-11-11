/**
 * Secret handoff FROM a sandboxed agent (2026-11-10). The `handoff` skill script writes a secret into
 * the recipient's `<folder>/.handoff/NAME` (0600, read once with `handoff pop`). It finds that folder
 * through `~/.paw/spaces/<s>/personas/<agent>.md`. Inside a `sandbox: container` VM neither the
 * personas nor other agents' folders are mounted (by design: docs/notes/sandbox.md), so a sandboxed
 * sender could never deliver. betterstack had to ask the operator to copy a token by hand.
 *
 * The sender's OWN folder is mounted read-write at the same path on the host, so it is the outbox. In
 * a VM, `handoff --to <agent>[#space] NAME` writes a request dir `<own folder>/.handoff/.outbox/<id>/`
 * (`to`, `name`, `value`, optional `force`, committed by renaming `.tmp-<id>` to `<id>`) and waits for
 * a receipt. The mailbox (one host daemon per space) runs this relay every second. It claims each
 * request, resolves the recipient from the host's personas, stores the value as the script would,
 * deletes the request and leaves `<id>.ok` / `<id>.err` with one line of text (never the value).
 *
 * Who sent it is the agent whose folder holds the outbox: no other VM can write there. A folder shared
 * by two sandboxed agents is refused, since the sender would be a guess. The value never travels over
 * the mesh, chat or logs: the mailbox log gets `sender → agent#space NAME (N bytes)` only.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listAgents, personaFilePath } from "./addressing.ts";
import { personaValue } from "./session.ts";
import { readTeleported } from "./teleport-plan.ts";

/** Under the sender's folder. Dot-named so `handoff ls/pop` in that folder never sees it. */
export const OUTBOX = join(".handoff", ".outbox");
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const AGENT_OR_SPACE = /^[A-Za-z0-9_-]+$/;
/** A receipt nobody collected (the sender gave up) is removed after this long. */
const RECEIPT_TTL_MS = 10 * 60_000;

export interface Sender {
  name: string;
  folder: string;
}

/** Sandboxed agents of `space` whose seat runs on this machine, by folder; a folder two of them share is in `shared`. */
export function sandboxedSenders(space: string, machine: string): { senders: Sender[]; shared: string[] } {
  const mine = listAgents(space).filter((a) => {
    const file = personaFilePath(space, a.name);
    if (!personaValue(file, "sandbox")) return false;
    if (readTeleported(file)) return false;
    const on = personaValue(file, "machine");
    return !on || on === machine;
  });
  const byFolder = new Map<string, Sender[]>();
  for (const a of mine) byFolder.set(a.folder, [...(byFolder.get(a.folder) ?? []), { name: a.name, folder: a.folder }]);
  const senders = [...byFolder.values()].filter((s) => s.length === 1).map((s) => s[0]!);
  const shared = [...byFolder.entries()].filter(([, s]) => s.length > 1).map(([f]) => f);
  return { senders, shared };
}

export type Delivery = { ok: true; name: string; where: string; bytes: number } | { ok: false; error: string };

/** The receipt / log text: never the value. */
export const deliveryLine = (d: Delivery): string => (d.ok ? `stored ${d.name} → ${d.where} (${d.bytes} bytes)` : d.error);

const readField = (dir: string, field: string): string | undefined => {
  const p = join(dir, field);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
};

/**
 * Store one claimed request in its recipient's `.handoff/`: same name rules, modes and no-overwrite
 * default as the `handoff` script. Refuses (never guesses) when the recipient can't be found here.
 */
export function deliver(space: string, machine: string, req: string): Delivery {
  const to = readField(req, "to");
  const name = readField(req, "name");
  const force = existsSync(join(req, "force"));
  const value = join(req, "value");
  if (!to) return { ok: false, error: "request has no recipient (`to`)" };
  if (!name || !SECRET_NAME.test(name)) return { ok: false, error: `bad secret name ${JSON.stringify(name ?? "")} (want ^[A-Za-z_][A-Za-z0-9_.-]*$)` };
  if (!existsSync(value)) return { ok: false, error: "request has no value" };
  const [agent, toSpace = space] = to.split("#");
  if (!agent || !AGENT_OR_SPACE.test(agent) || !AGENT_OR_SPACE.test(toSpace)) return { ok: false, error: `bad recipient "${to}" (want agent or agent#space)` };
  const where = `${agent}#${toSpace}`;
  const persona = personaFilePath(toSpace, agent);
  if (!existsSync(persona)) return { ok: false, error: `no agent "${where}" on this machine (no persona)` };
  if (readTeleported(persona)) return { ok: false, error: `"${where}" was teleported to another machine; hand it over there` };
  const on = personaValue(persona, "machine");
  if (on && on !== machine) return { ok: false, error: `"${where}" runs on ${on}, not here; cross-machine handoff isn't supported` };
  const folder = listAgents(toSpace).find((a) => a.name === agent)?.folder;
  if (!folder) return { ok: false, error: `"${where}" has no folder (no cwd: in its persona)` };
  if (!existsSync(folder)) return { ok: false, error: `"${where}"'s folder ${folder} doesn't exist` };
  const store = join(folder, ".handoff");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  chmodSync(store, 0o700);
  const target = join(store, name);
  if (existsSync(target) && !force) return { ok: false, error: `"${name}" is already waiting in ${where}'s handoff (send with -f to replace it)` };
  const tmp = join(store, `.relay.${process.pid}.${name}`);
  copyFileSync(value, tmp);
  chmodSync(tmp, 0o600);
  try {
    if (force) renameSync(tmp, target);
    else linkSync(tmp, target);
  } catch (e) {
    return { ok: false, error: `couldn't store "${name}" for ${where}: ${(e as Error).message}` };
  } finally {
    rmSync(tmp, { force: true });
  }
  excludeFromGit(folder);
  return { ok: true, name, where, bytes: statSync(target).size };
}

/** The script's rule: a `.handoff/` inside a git work tree goes into the repo's LOCAL exclude, never committed. */
function excludeFromGit(folder: string): void {
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  if (git("rev-parse", "--is-inside-work-tree") !== "true") return;
  if (git("check-ignore", "-q", ".handoff") !== undefined) return;
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return;
  const exclude = join(common, "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, ".handoff/\n");
}

/** One pass over every sandboxed sender's outbox. Returns how many requests it handled. */
export function relayTick(space: string, machine: string, log: (line: string) => void, now = Date.now()): number {
  const { senders, shared } = sandboxedSenders(space, machine);
  const boxes = [...senders.map((s) => ({ folder: s.folder, sender: s.name as string | undefined })), ...shared.map((folder) => ({ folder, sender: undefined }))];
  let handled = 0;
  for (const { folder, sender } of boxes) {
    const box = join(folder, OUTBOX);
    if (!existsSync(box)) continue;
    for (const entry of readdirSync(box)) {
      const path = join(box, entry);
      if (/\.(ok|err)$/.test(entry)) {
        if (now - statSync(path).mtimeMs > RECEIPT_TTL_MS) rmSync(path, { force: true });
        continue;
      }
      if (entry.startsWith(".") || !statSync(path).isDirectory()) continue;
      const claimed = join(box, `.claimed-${entry}`);
      try {
        renameSync(path, claimed);
      } catch {
        continue; // the sender withdrew it a moment ago
      }
      let result: Delivery;
      try {
        result = sender ? deliver(space, machine, claimed) : { ok: false, error: `${folder} is shared by several sandboxed agents, so who sent this would be a guess; not relayed` };
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }
      writeFileSync(join(box, `${entry}.${result.ok ? "ok" : "err"}`), `${deliveryLine(result)}\n`, { mode: 0o600 });
      rmSync(claimed, { recursive: true, force: true });
      log(result.ok ? `[handoff] ${sender} → ${result.where} ${result.name} (${result.bytes} bytes)` : `[handoff] ${sender ?? folder}: not delivered — ${result.error}`);
      handled++;
    }
  }
  return handled;
}

/** The mailbox's relay loop: one pass a second, never overlapping, never fatal. Returns its stop. */
export function startHandoffRelay(space: string, machine: string, log: (line: string) => void, everyMs = 1000): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      relayTick(space, machine, log);
    } catch (e) {
      log(`[handoff] relay pass failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
