#!/usr/bin/env node
/**
 * Hard removal of a sandboxed agent's VM (docs/notes/sandbox.md#a-wedged-vm). `container stop` and
 * `container delete --force` both go through the guest's vminitd, so a guest wedged by memory exhaustion
 * (team2027 vercel, 2026-11-06: `page allocation failure`, no OOM kill, every `container exec` hanging)
 * never answers them: the stop hung for minutes, the VM outlived its launcher, and each relaunch blocked on
 * the leftover's delete past the manager's startup window. The VM's HOST process —
 * `container-runtime-linux start … --uuid <id>` — always dies to SIGKILL, so that is the last step.
 *
 *   node paw-sandbox-kill.mjs --container <bin> --log <f> --stop <id>   (the launcher's detached reaper)
 *
 * Plain node ESM, no dependencies: imported by bin/paw-sandbox-run.mjs (manager's node) and src/sandbox.ts.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DELETE_TIMEOUT_MS = 10_000;

/** The ids of `ids` that `container ls --all` still lists. Throws when ls itself fails (never "gone"). */
export function stillListed(bin, ids) {
  const r = spawnSync(bin, ["ls", "--all", "--format", "json"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  if (r.status !== 0) throw new Error(`\`container ls\` failed (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()})`);
  const rows = JSON.parse(r.stdout || "[]");
  if (!Array.isArray(rows)) throw new Error("`container ls --format json` did not print a list");
  const listed = new Set(rows.map((c) => c.configuration?.id));
  return ids.filter((id) => listed.has(id));
}

/** Host pids of the VM processes for `id`: `container-runtime-linux start … --uuid <id>` (exact token). */
export function runtimePids(psText, id) {
  const pids = [];
  for (const line of psText.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].includes("container-runtime-linux")) continue;
    const args = m[2].split(/\s+/);
    const at = args.indexOf("--uuid");
    if (at !== -1 && args[at + 1] === id) pids.push(Number(m[1]));
  }
  return pids;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hostPs() {
  const r = spawnSync("/bin/ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) throw new Error(`ps failed (${(r.stderr || r.error?.message || "").trim()})`);
  return r.stdout;
}

/**
 * Remove `ids` for certain: `delete --force` (bounded), then SIGKILL the VM process of any that are still
 * listed, then `delete --force` again. Returns `{ killed }` (host pids SIGKILLed); throws, naming the ids,
 * when one is STILL listed — never reports a VM gone that isn't.
 */
export function forceRemoveContainers(bin, ids, o = {}) {
  const note = o.note ?? (() => {});
  const timeout = o.deleteTimeoutMs ?? DELETE_TIMEOUT_MS;
  const ps = o.ps ?? hostPs;
  const kill = o.kill ?? ((pid) => process.kill(pid, "SIGKILL"));
  const del = (which) => spawnSync(bin, ["delete", "--force", ...which], { stdio: "ignore", timeout, killSignal: "SIGKILL" });
  if (!ids.length) return { killed: [] };
  del(ids);
  let left = stillListed(bin, ids);
  if (!left.length) return { killed: [] };
  const table = ps();
  const killed = [];
  for (const id of left) {
    const pids = runtimePids(table, id);
    if (!pids.length) note(`${id} survived \`container delete --force\` (${timeout / 1000}s) and no container-runtime-linux process for it was found`);
    for (const pid of pids) {
      note(`${id} survived \`container delete --force\` (${timeout / 1000}s) — its guest is not answering; SIGKILL to its VM process ${pid}`);
      try {
        kill(pid);
        killed.push(pid);
      } catch (e) {
        if (e.code !== "ESRCH") throw new Error(`couldn't SIGKILL ${id}'s VM process ${pid}: ${e.message}`);
      }
    }
  }
  // The container service notices its VM process died on its own schedule: give it a moment, then delete.
  for (const end = Date.now() + (o.settleMs ?? 5_000); Date.now() < end && (left = stillListed(bin, left)).length; ) sleepSync(250);
  if (left.length) del(left);
  left = stillListed(bin, left);
  if (left.length) throw new Error(`container(s) ${left.join(" ")} still listed after \`delete --force\` and a SIGKILL of their VM process(es) ${killed.join(" ") || "(none found)"}`);
  return { killed };
}

// CLI: the launcher's detached reaper — it must outlive the manager's SIGKILL of the launcher.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const val = (k) => {
    const i = a.indexOf(k);
    if (i === -1 || !a[i + 1]) {
      process.stderr.write(`paw-sandbox-kill: missing ${k}\n`);
      process.exit(2);
    }
    return a[i + 1];
  };
  const bin = val("--container");
  const log = val("--log");
  const id = val("--stop");
  const note = (msg) => appendFileSync(log, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  // A graceful stop first (the guest flushes); bounded — a wedged guest never answers it.
  spawnSync(bin, ["stop", "--time", "2", id], { stdio: "ignore", timeout: 8_000, killSignal: "SIGKILL" });
  try {
    const { killed } = forceRemoveContainers(bin, [id], { note });
    if (killed.length) note(`removed ${id} by killing its VM process`);
  } catch (e) {
    note(`FAILED to remove ${id}: ${e.message} — remove it by hand: container delete --force ${id}`);
    process.exit(1);
  }
}
