/**
 * Broker store hygiene: find the spaces whose streams are still on the broker but nothing runs them
 * any more (leftover test spaces, mostly), and delete them — never the live space, never a space with
 * a running daemon, never one that was active recently.
 *
 * Why it exists (beads-eic): every "isolated" test run that set only PAW_HOME/PAW_SPACE shared the
 * operator's LIVE broker, and `paw down` + `removeMesh` drop the processes and the registry entry but
 * not the space's ~20 JetStream streams. By 2026-10-14 the live :4222 carried 272 spaces / 2273
 * streams for ONE live space — thousands of stream dirs in the store whose disk-full latch (#1356)
 * took presence down twice that week.
 *
 * Deletion goes through cotal's own `deleteSpace` (the one list of everything a space owns). This
 * module only decides WHICH spaces, from the stream names it can attribute — a stream it cannot
 * attribute is reported and never touched.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  aclBucket,
  artifactBucket,
  channelBucket,
  chatStream,
  deleteSpace,
  deliveryBucket,
  dlvStream,
  dmStream,
  endpointPlaneStreamNames,
  inboxStream,
  isTransferStream,
  managerBucket,
  membersBucket,
  membershipBucket,
  objectStoreStream,
  presenceBucket,
  taskStream,
} from "@cotal-ai/core";
import { loadMeshes, removeMesh } from "@cotal-ai/workspace";
import { DEFAULT_SPACE, resolveSpace } from "./space.ts";

/** Every non-transfer stream a space owns — the list cotal's `deleteSpace` deletes, in the same order.
 *  Kept as a mirror (cotal exports the helpers, not the list); a family cotal adds later shows up as an
 *  UNOWNED stream in the plan, never as a silent partial delete. */
export function spaceStreamNames(space: string): string[] {
  return [
    chatStream(space),
    dmStream(space),
    taskStream(space),
    inboxStream(space),
    dlvStream(space),
    `KV_${presenceBucket(space)}`,
    `KV_${channelBucket(space)}`,
    `KV_${membersBucket(space)}`,
    `KV_${aclBucket(space)}`,
    `KV_${membershipBucket(space)}`,
    `KV_${deliveryBucket(space)}`,
    `KV_${managerBucket(space)}`,
    ...endpointPlaneStreamNames(space),
    objectStoreStream(artifactBucket(space)),
  ];
}

const PROBE = "zzpawprobezz";
/** Stream-name prefixes, longest first, so `EPT_REQ_x` is space `x`'s EPT_REQ stream, never space `REQ_x`'s EPT. */
const FAMILY_PREFIXES = spaceStreamNames(PROBE)
  .map((n) => {
    if (!n.endsWith(PROBE)) throw new Error(`paw: stream family "${n}" does not end in its space token — cotal changed its naming; update src/prune.ts`);
    return n.slice(0, -PROBE.length);
  })
  .sort((a, b) => b.length - a.length);
const XFER_PREFIX = objectStoreStream("cotal_xfer_");

export interface StreamRow {
  name: string;
  bytes: number;
  msgs: number;
  consumers: number;
  /** ms epoch; the stream's creation time. */
  created: number;
  /** ms epoch of the newest message, 0 when the stream never held one. */
  lastTs: number;
}

export interface SpaceRow {
  space: string;
  streams: StreamRow[];
  bytes: number;
  msgs: number;
  consumers: number;
  /** Newest of every stream's creation and last message — the last sign anything touched the space. */
  lastActive: number;
}

/** Group streams by the space that owns them. Pure. */
export function attributeStreams(rows: StreamRow[]): { spaces: Map<string, SpaceRow>; unowned: StreamRow[] } {
  const spaces = new Map<string, SpaceRow>();
  const unowned: StreamRow[] = [];
  const add = (space: string, r: StreamRow): void => {
    let s = spaces.get(space);
    if (!s) spaces.set(space, (s = { space, streams: [], bytes: 0, msgs: 0, consumers: 0, lastActive: 0 }));
    s.streams.push(r);
    s.bytes += r.bytes;
    s.msgs += r.msgs;
    s.consumers += r.consumers;
    s.lastActive = Math.max(s.lastActive, r.created, r.lastTs);
  };
  const transfers: StreamRow[] = [];
  for (const r of rows) {
    if (r.name.startsWith(XFER_PREFIX)) {
      transfers.push(r);
      continue;
    }
    const prefix = FAMILY_PREFIXES.find((p) => r.name.startsWith(p) && r.name.length > p.length);
    if (prefix) add(r.name.slice(prefix.length), r);
    else unowned.push(r);
  }
  // A transfer stream's name is `<space token>_<instance>`, ambiguous on its own: attribute it only
  // when exactly one known space claims it.
  for (const r of transfers) {
    const owners = [...spaces.keys()].filter((s) => isTransferStream(s, r.name));
    if (owners.length === 1) add(owners[0]!, r);
    else unowned.push(r);
  }
  return { spaces, unowned };
}

export interface PrunePlan {
  remove: SpaceRow[];
  keep: Array<{ row: SpaceRow; reason: string }>;
  unowned: StreamRow[];
}

/**
 * Decide which spaces to delete. Pure. A space is KEPT when it is protected (live / registered /
 * running — see {@link gatherProtected}), when anything touched it within `minIdleMs`, or when
 * deleting it would also delete a stream attributed to a kept space (`deleteSpace("REQ_x")` names
 * `EPT_REQ_x`, which is space `x`'s). That last check runs to a fixpoint.
 */
export function planPrune(
  spaces: Map<string, SpaceRow>,
  unowned: StreamRow[],
  protect: Map<string, string>,
  now: number,
  minIdleMs: number,
): PrunePlan {
  const keep = new Map<string, string>();
  for (const row of spaces.values()) {
    const why = protect.get(row.space);
    if (why) keep.set(row.space, why);
    else if (now - row.lastActive < minIdleMs) keep.set(row.space, `active ${fmtAge(now - row.lastActive)} ago (< --min-idle)`);
  }
  for (let changed = true; changed; ) {
    changed = false;
    const kept = new Map<string, string>();
    for (const s of keep.keys()) for (const r of spaces.get(s)!.streams) kept.set(r.name, s);
    for (const row of spaces.values()) {
      if (keep.has(row.space)) continue;
      const hit = spaceStreamNames(row.space).find((n) => kept.has(n));
      if (hit) {
        keep.set(row.space, `deleting it would also delete ${hit}, which belongs to kept space "${kept.get(hit)}"`);
        changed = true;
      }
    }
  }
  const remove = [...spaces.values()].filter((r) => !keep.has(r.space)).sort((a, b) => a.lastActive - b.lastActive);
  return {
    remove,
    keep: [...keep].map(([space, reason]) => ({ row: spaces.get(space)!, reason })).sort((a, b) => a.row.space.localeCompare(b.row.space)),
    unowned,
  };
}

/** Every `--space <s>` / `--space=<s>` on a running process's command line. Pure. */
export function spacesInArgv(psOutput: string): Set<string> {
  const out = new Set<string>();
  for (const m of psOutput.matchAll(/--space(?:=|\s+)(\S+)/g)) out.add(m[1]!);
  return out;
}

/** The spaces nothing may prune, each with the reason. */
export function gatherProtected(extra: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const put = (s: string, why: string): void => {
    if (!out.has(s)) out.set(s, why);
  };
  put(DEFAULT_SPACE, "paw's default (live) space");
  put(resolveSpace(), "the current space (PAW_SPACE)");
  for (const s of extra) put(s, "--keep");
  for (const m of loadMeshes()) put(m.space, "in the mesh registry (~/.cotal/meshes)");
  const spacesDir = join(process.env.PAW_HOME?.trim() || join(homedir(), ".paw"), "spaces");
  if (existsSync(spacesDir)) for (const s of readdirSync(spacesDir)) put(s, `has state under ${spacesDir}`);
  const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const s of spacesInArgv(ps)) put(s, "a running process names it (--space)");
  return out;
}

const nanosToMs = (iso: string | undefined): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  // An empty stream reports last_ts as the zero time (0001-01-01), which parses negative.
  return Number.isFinite(t) && t > 0 ? t : 0;
};

/** Read every stream on the broker (read-only: one STREAM.LIST walk). */
export async function readBroker(server: string): Promise<StreamRow[]> {
  const nc = await connect({ servers: server, timeout: 5000, reconnect: false, maxReconnectAttempts: 0 });
  try {
    const jsm = await jetstreamManager(nc);
    const rows: StreamRow[] = [];
    for await (const si of jsm.streams.list()) {
      rows.push({
        name: si.config.name,
        bytes: si.state.bytes,
        msgs: si.state.messages,
        consumers: si.state.consumer_count,
        created: nanosToMs(si.created),
        lastTs: nanosToMs(si.state.last_ts),
      });
    }
    return rows;
  } finally {
    await nc.close();
  }
}

function assertOpenMesh(verb: string): void {
  if (process.env.PAW_AUTH === "1") throw new Error(`paw ${verb}: only an OPEN mesh can be pruned (PAW_AUTH=1 is set — an authed broker holds one space)`);
}

/** Delete every space in the plan, then re-read the broker and fail loud if any of their streams survived. */
export async function executePrune(server: string, plan: PrunePlan, onSpace?: (s: SpaceRow) => void): Promise<void> {
  assertOpenMesh("spaces prune");
  const failed: string[] = [];
  for (const row of plan.remove) {
    try {
      await deleteSpace({ servers: server, space: row.space });
      onSpace?.(row);
    } catch (e) {
      failed.push(`${row.space}: ${(e as Error).message}`);
    }
  }
  const gone = new Set(plan.remove.map((r) => r.space));
  const { spaces } = attributeStreams(await readBroker(server));
  const left = [...spaces.values()].filter((s) => gone.has(s.space)).map((s) => `${s.space} (${s.streams.map((r) => r.name).join(", ")})`);
  if (failed.length || left.length)
    throw new Error(`paw spaces prune: incomplete —${failed.length ? `\n  delete failed: ${failed.join("\n  delete failed: ")}` : ""}${left.length ? `\n  still on the broker: ${left.join("; ")}` : ""}`);
}

/**
 * Test teardown: delete a TEST space's streams from the broker it used and drop its registry entry.
 * The landmine this removes: `removeMesh` alone left every test space's ~20 streams on the operator's
 * live broker forever. Refuses paw's default space and any space a running process still names.
 */
export async function purgeTestSpace(space: string, server: string): Promise<void> {
  assertOpenMesh("purgeTestSpace");
  if (space === DEFAULT_SPACE) throw new Error(`purgeTestSpace: refusing to delete "${space}" — that is the operator's live space`);
  const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (spacesInArgv(ps).has(space)) throw new Error(`purgeTestSpace: a running process still names --space ${space} — stop its daemons first`);
  await deleteSpace({ servers: server, space });
  removeMesh(space);
}

export function fmtAge(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** `30m`, `1h`, `7d`, `0` → ms. Fails loud on anything else. */
export function parseDuration(v: string): number {
  const m = /^(\d+)(s|m|h|d)?$/.exec(v.trim());
  if (!m) throw new Error(`paw: "${v}" is not a duration (e.g. 0, 90s, 30m, 1h, 7d)`);
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"]!;
  return n * unit;
}
