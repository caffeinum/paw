/**
 * paw's ONE door to the cotal manager — the v0.4 typed SERVICE rail (`resolveService` →
 * `invokeCommand`), which as of cotal 0.25 is the only door there is.
 *
 * WHY THIS FILE EXISTS AT ALL. Every paw control call used to be
 * `ep.requestControl("manager"|"admin", {op}, timeout)` on a CotalEndpoint — the bespoke
 * `ctl.<tier>.<owner>.<actor>` subjects. cotal's 1d slice DELETED those subjects
 * (`controlCallerPermissions`, verbatim: "the manager `ctl` rail is gone — an operator instrument
 * holds ONLY its v0.4 ep rows"). The call still COMPILES, because `requestControl` is still on the
 * endpoint; it simply addresses a subject nobody serves, so it hangs until its own timeout with no
 * reply. That is exactly what was seen: paw's every control call timing out against the operator's
 * real mesh while `cotal ps` answered instantly on the same broker, in the same space. A rail that
 * type-checks and answers nothing is the worst shape a breaking change can take, and it is why the
 * 0.25 bump passed 20 hermetic suites and was still wrong.
 *
 * THE SHAPE OF THE NEW RAIL, and why the seam is a connection-owning object rather than a free
 * function per call: a call is no longer "publish on a well-known subject". It is (1) connect,
 * (2) DESCRIBE the endpoint, (3) fetch + digest-verify its contract documents from the store,
 * (4) recompile the input/output validators, (5) invoke. Steps 2–4 are `resolveService`, and they
 * cost a round trip and a store read EACH TIME. paw polls `ps` every 500ms while waiting for an
 * agent to reach the mesh, so re-resolving per call would turn one readiness wait into dozens of
 * describes. {@link ManagerControl} therefore resolves ONCE and invokes many times, and every paw
 * command scopes it with {@link withManagerControl} exactly as it used to scope an endpoint.
 *
 * WHAT PAW DELIBERATELY DOES NOT REBUILD HERE: this is a thin, honest port of cotal's own
 * `askManager` (@cotal-ai/cli `lib/control.js`), read rather than guessed at. Where cotal's version
 * carries operator I/O, `--on <instance>` pinning and the user-bearer mode, paw carries none of it —
 * paw drives a LOCAL manager it started itself, one instance per space, and has no user-auth mode.
 * The pieces that ARE copied (the open-mesh caller triple, the `inspect`-then-target resolution for
 * despawn/attach, the reach rule) are copied because getting them wrong fails as a timeout, and a
 * timeout is indistinguishable from the bug this file exists to fix.
 */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  DEV_OWNER,
  EpEnvelopeError,
  invokeCommand,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  resolveService,
  standaloneConnectOpts,
  unansweredRequest,
  type EpCaller,
  type EpVerbTarget,
  type ResolvedService,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { pawCotalRoot } from "./cotal-root.js";

/** A manager reply in paw's shape: `{ok, data, error}`, the same three fields every call site read
 *  off the old `ControlReply`, so the rail swap didn't also become a rewrite of what reads it.
 *  `code` is cotal's machine-readable error code when the responder sent one — carried, never
 *  invented, and never used to paper over a message. */
export type ManagerReply = { ok: boolean; data?: unknown; error?: string; code?: string };

/** How long a `resolveService` may take. Generous because it is not one round trip: a describe, a
 *  store fetch per visible cluster, and a recompile. Matches cotal's own 10s. */
const RESOLVE_MS = 10_000;

/** The two credential tiers cotal splits control across, and the ONE reason paw cares: under
 *  PAW_AUTH the broker grant IS the boundary. `control-caller-privileged` holds the manager reads +
 *  untargeted `spawn` and is structurally barred from cross-agent ops (it holds no any-mode row);
 *  `control-caller-admin` adds the any-mode `despawn`/`attach` rows. On the OPEN mesh (paw's
 *  default) there is no credential system at all and the distinction is inert — see {@link railKey}.
 *
 *  This finally closes a caveat paw carried for two cotal generations: `controlCreds` minted the
 *  PRIVILEGED tier and stopAgent/restartAgent then rode it onto an ADMIN subject, i.e. an
 *  under-privileged call that only ever worked because the open mesh enforces nothing. Here the
 *  tier is chosen by the COMMAND, so an authed stop mints the cred that command actually needs. */
type Tier = "privileged" | "admin";

/** One resolved, connected rail: the connection, the caller triple its credential pins, and the
 *  digest-verified command surface. */
interface Rail {
  nc: NatsConnection;
  caller: EpCaller;
  service: ResolvedService;
}

/** The manager's own row shape as returned by `ps`/`inspect`. `lifecycleUid` is new in v0.4 and is
 *  load-bearing: a targeted command (despawn/attach) addresses an agent by its PRINCIPAL TRIPLE
 *  (owner, actor, lifecycleUid), never by its alias, so the name has to be resolved to one first. */
type AgentRow = { name: string; id: string; lifecycleUid: string };

export class ManagerControl {
  private readonly rails = new Map<string, Promise<Rail>>();

  /**
   * `resolveMs` bounds the DESCRIBE + store fetch, not the command that follows. It is separate
   * because the two answer different questions and one caller needs them to differ: the readiness
   * probe in lifecycle.ts runs in a retry loop against a manager that may not have registered its
   * service yet, and an attempt that waits the full default there would outlive the whole readiness
   * window — one attempt, no retries, and a healthy manager reported as dead. Ordinary callers want
   * the patient default.
   */
  constructor(
    private readonly space: string,
    private readonly server: string,
    private readonly resolveMs: number = RESOLVE_MS,
  ) {}

  /** `ps` — every managed agent's row. paw's most-called control op by a wide margin (every wake
   *  gate, every readiness poll, `paw status`), which is why the resolve is cached. */
  async ps(timeoutMs = 4000): Promise<ManagerReply> {
    return this.invoke("privileged", "ps", undefined, timeoutMs);
  }

  /**
   * `spawn` — create an agent. NOTE THE SEMANTICS CHANGE, it is the sharpest edge in this port:
   * since cotal's P2 item 2 a spawn reply is the ACCEPTANCE, returned as soon as the manager has
   * allocated the identity, NOT when the agent is alive. The old `op:"start"` blocked until
   * readiness.
   *
   * paw takes the acceptance and does its OWN readiness wait rather than calling
   * `submitAndFollowGoal` (which would restore blocking), and the reason is specific rather than
   * stylistic: paw's wait is not passive. It polls `ps` and, on the tmux runtime, presses Enter at
   * claude's one-time dev-channels prompt on every poll (`nudgeStartupPrompt` in addressing.ts) —
   * the prompt appears well after cotal's own 1s…5s nudge window on a cold or loaded machine, and
   * a missed Enter leaves the agent sitting at a question forever with no mesh presence. Blocking
   * inside the spawn call would suspend paw for exactly the window in which its only recovery
   * action needs to run. So: acceptance here, readiness in `ensureAgentSpawned`, which already owns
   * the grace window, the nudge and the loud failure.
   *
   * The reply data also changed shape: it is `{name, owner, actor, uid, goalId, …}`, so the agent's
   * wire principal is now stated outright as `owner`+`actor` instead of being derived from a raw
   * nkey (`wirePrincipal`). See `ensureAgentSpawned`.
   */
  async spawn(args: Record<string, unknown>, timeoutMs = 60_000): Promise<ManagerReply> {
    return this.invoke("privileged", "spawn", args, timeoutMs);
  }

  /** `despawn` — the named terminal (paw's old ADMIN `op:"stop"`). Targeted: resolved to the
   *  agent's principal triple first (see {@link target}). */
  async despawn(name: string, timeoutMs = 8000): Promise<ManagerReply> {
    return this.invokeTargeted("admin", "despawn", name, undefined, timeoutMs);
  }

  /** `attach` — open a terminal session on an agent. In v0.4 this returns a signed §13.6 session
   *  GRANT, not the `ws://` pty URL paw's attach client speaks; `paw open` states that plainly
   *  rather than pretending. Kept here so the one call site has a rail to use if/when paw learns
   *  to redeem a grant. */
  async attach(name: string, timeoutMs = 8000): Promise<ManagerReply> {
    return this.invokeTargeted("admin", "attach", name, undefined, timeoutMs);
  }

  /** `inspect` — one agent's row by name. Also the name→triple resolver every targeted command
   *  needs, which is why it rides the same rail as the command it is resolving FOR: cotal mints
   *  `inspect`'s read row onto the same capability arm as despawn/attach, so resolving on a
   *  different tier's connection would be a grant paw isn't holding. */
  async inspect(name: string, timeoutMs = 8000): Promise<ManagerReply> {
    return this.invoke("privileged", "inspect", { name }, timeoutMs);
  }

  /** Close every rail this control opened. Best-effort: a failed drain must never turn a completed
   *  command into an error the operator sees. */
  async close(): Promise<void> {
    const rails = [...this.rails.values()];
    this.rails.clear();
    for (const p of rails) {
      await p.then((r) => r.nc.drain().catch(() => r.nc.close())).catch(() => {});
    }
  }

  /** Set once a rail has FAILED underneath a command (timeout, no responders, a closed socket). A
   *  long-lived holder (`sharedManagerControl`) reads it to know the cached handle may be pointing at
   *  a manager that has since restarted — the resolved service is per-instance. A refusal
   *  (`ok:false` from the manager) is not staleness; only a transport-level failure sets this. */
  stale = false;

  /** A refusal can ALSO mean the handle is dead: cotal pins a resolved service to the manager's
   *  registration EPOCH, and a re-registration (same instance, epoch+1 — a broker reconnect, a
   *  presence-store rebuild) makes every later command bounce with "the caller bound to epoch N …
   *  not the one it resolved against". That is an `ok:false` from a healthy manager, so the
   *  transport-only rule above left `paw web` wedged for a whole day (2026-09-08, 10k refused
   *  polls). It is staleness by definition — the thing resolved no longer exists. */
  private noteRefusal(r: ManagerReply): ManagerReply {
    if (!r.ok && r.error && isStaleRefusal(r.error)) this.stale = true;
    return r;
  }

  /** Invoke an UNTARGETED command, translating a rail failure into paw's `{ok:false, error}`. */
  private async invoke(tier: Tier, command: string, args: Record<string, unknown> | undefined, deadlineMs: number): Promise<ManagerReply> {
    try {
      const rail = await this.rail(tier);
      const r = await invokeCommand(rail.nc, this.space, rail.service, command, args, { deadlineMs });
      return this.noteRefusal(replyOf(r.reply));
    } catch (e) {
      this.stale = true;
      return railFailure(e);
    }
  }

  /** Invoke a TARGETED command: resolve `name` to its principal triple via `inspect` on the same
   *  rail, then send with the §13.2 target block. A name that can't be resolved is reported as
   *  that — never silently retried untargeted, which would be a different command. */
  private async invokeTargeted(
    tier: Tier,
    command: string,
    name: string,
    args: Record<string, unknown> | undefined,
    deadlineMs: number,
  ): Promise<ManagerReply> {
    try {
      const rail = await this.rail(tier);
      const info = await invokeCommand(rail.nc, this.space, rail.service, "inspect", { name }, { deadlineMs });
      if (info.reply.ok !== true) {
        const r = this.noteRefusal(replyOf(info.reply));
        return { ...r, error: `could not resolve "${name}": ${r.error ?? "inspect failed"}` };
      }
      const r = await invokeCommand(rail.nc, this.space, rail.service, command, args, {
        target: target(rail.caller, info.reply.data as AgentRow),
        deadlineMs,
      });
      return this.noteRefusal(replyOf(r.reply));
    } catch (e) {
      this.stale = true;
      return railFailure(e);
    }
  }

  /** Connect + resolve one tier's rail, once. The promise (not the resolved value) is cached so two
   *  concurrent calls share ONE describe rather than racing two connections into the same space. */
  private rail(tier: Tier): Promise<Rail> {
    const key = railKey(this.space, tier);
    const existing = this.rails.get(key);
    if (existing) return existing;
    const opening = this.openRail(tier);
    this.rails.set(key, opening);
    // A failed open must not be cached — the next call gets a fresh attempt, not a stuck rejection.
    opening.catch(() => this.rails.delete(key));
    return opening;
  }

  private async openRail(tier: Tier): Promise<Rail> {
    const { creds, caller } = await callerFor(this.space, tier);
    const nc = await connect({
      servers: this.server,
      ...standaloneConnectOpts(creds ? { creds, tls: false } : { tls: false }),
      maxReconnectAttempts: 0,
    });
    try {
      const service = await resolveService(nc, this.space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: this.resolveMs });
      return { nc, caller, service };
    } catch (e) {
      await nc.drain().catch(() => nc.close());
      throw e;
    }
  }
}

/** Scope a {@link ManagerControl} to one command, exactly as `withControlEndpoint` scoped an
 *  endpoint: open on first use, always closed. */
const shared = new Map<string, ManagerControl>();

/**
 * One control handle per (space, server) for the LIFETIME of a long-running process — `paw web`,
 * which polls the manager every few seconds. `withManagerControl` is right for a one-shot CLI (open,
 * ask, close, exit), but a daemon that re-runs it per poll re-resolves the service every time:
 * a describe + a contract-store fetch + an Ajv recompile of every validator, a few hundred ms of
 * CPU per poll, and cotal prints its `! schema: compile took ~110ms` advisory for each one — the
 * 2026-08-23 log spam. Resolving once is the point of ManagerControl; this just holds it.
 *
 * A handle that reports {@link ManagerControl.stale} is closed and replaced on the next call, so a
 * manager restart (new instance, new registration) costs one failed poll, not a wedged daemon.
 * Never use from a one-shot command: the open socket keeps the process alive past its last line.
 */
/** Does a manager's refusal say the caller resolved against an incarnation that is gone? Matched on
 *  cotal's own wording (SPEC 13.2: "bound to epoch N … not the one it resolved against"), never on
 *  a generic "error" — an ordinary refusal (unknown agent, bad args) must NOT drop a good handle. */
export function isStaleRefusal(message: string): boolean {
  return /not the one it resolved against|bound to epoch \d+|incarnation is not/i.test(message);
}

/** Drop the shared handle so the NEXT call resolves afresh. For a long-lived holder whose poll
 *  failed for a reason the handle itself could not classify — one re-resolve is a few hundred ms,
 *  a wedged daemon is the alternative. */
export async function dropSharedManagerControl(space: string, server: string): Promise<void> {
  const key = `${space}\0${server}`;
  const cur = shared.get(key);
  if (!cur) return;
  shared.delete(key);
  await cur.close().catch(() => {});
}

export async function sharedManagerControl(space: string, server: string): Promise<ManagerControl> {
  const key = `${space}\0${server}`;
  const cur = shared.get(key);
  if (cur && !cur.stale) return cur;
  if (cur) await cur.close();
  const fresh = new ManagerControl(space, server);
  shared.set(key, fresh);
  return fresh;
}

export async function withManagerControl<T>(
  space: string,
  server: string,
  fn: (ctl: ManagerControl) => Promise<T>,
  opts: { resolveMs?: number } = {},
): Promise<T> {
  const ctl = new ManagerControl(space, server, opts.resolveMs);
  try {
    return await fn(ctl);
  } finally {
    await ctl.close();
  }
}

/** Which rail a tier gets. On an OPEN mesh (no space auth material) there is no credential system:
 *  both tiers connect bare under the same synthesized DEV_OWNER triple, so giving them separate
 *  connections would be two sockets for one identity and no isolation to show for it. Under auth
 *  the tiers hold genuinely different broker rows and must not share. */
function railKey(space: string, tier: Tier): string {
  return hasSpaceAuth(space) ? tier : "open";
}

function hasSpaceAuth(space: string): boolean {
  return loadSpaceAuth(authDir(pawCotalRoot(space)), space) !== undefined;
}

/**
 * The credential + caller triple for one tier.
 *
 * AUTH MESH: mint the tier's one-shot operator instrument against the space's trust material,
 * pinning a fresh lifecycle uid — the ep reply rail names ONE incarnation, so the caller must hand
 * its own uid back in every request subject it builds. Copied from @cotal-ai/workspace's
 * `connectOrExit` instrument branch; a triple that disagrees with the minted cred is refused at the
 * broker, which surfaces as a describe timeout, i.e. as "the manager is down".
 *
 * OPEN MESH: no credential system. The manager registered its service under DEV_OWNER and the
 * broker enforces nothing, so a fresh DEV_OWNER triple over a bare connection is the whole story —
 * this is cotal's own open-mesh path in `askManager`, not a paw shortcut.
 */
async function callerFor(space: string, tier: Tier): Promise<{ creds?: string; caller: EpCaller }> {
  const auth = loadSpaceAuth(authDir(pawCotalRoot(space)), space);
  const identity = newIdentity();
  const uid = mintLifecycleUid();
  if (!auth) return { caller: { owner: DEV_OWNER, actor: identity.id, uid } };
  const profile = tier === "admin" ? "control-caller-admin" : "control-caller-privileged";
  const creds = await mintCreds(auth, identity, profile, { lifecycleUid: uid });
  return { creds, caller: { owner: DEV_OWNER, actor: identity.id, uid } };
}

/**
 * The §13.2 target block for a targeted command, from the `inspect` row.
 *
 * A row's `id` is either a bare actor (a static agent under the caller's own owner) or a composite
 * `owner.actor` principal key — split on the FIRST dot, because an embedded dot would break the
 * subject's arity. Mode: `any` spans owners and is what an operator reach needs; paw always drives
 * a cross-agent stop (it is stopping agents it did not spawn from this process), and on a static
 * mesh that is precisely what the `control-caller-admin` instrument's any-mode row authorizes —
 * the same rule cotal's own `stop` applies for a non-bearer connection.
 */
function target(caller: EpCaller, row: AgentRow): EpVerbTarget {
  const dot = row.id.indexOf(".");
  const [owner, actor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [caller.owner, row.id];
  return { mode: "any", owner, actor, lifecycleUid: row.lifecycleUid };
}

/** An endpoint reply in paw's shape. An `ok:false` reply's message is preferred over its code, and
 *  the last resort is the literal "error" rather than a fabricated explanation. */
function replyOf(reply: { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } }): ManagerReply {
  if (reply.ok === true) return { ok: true, ...(reply.data !== undefined ? { data: reply.data } : {}) };
  return {
    ok: false,
    error: reply.error?.message ?? reply.error?.code ?? "error",
    ...(reply.error?.code ? { code: reply.error.code } : {}),
  };
}

/**
 * Render a thrown rail failure as a reply the call sites already know how to report.
 *
 * The one distinction worth drawing is UNANSWERED (no responder, or the deadline elapsed) versus
 * anything else, because they send an operator to different places: unanswered is "no manager is
 * serving this space" (paw's `explainManagerFailure` then names the cause), while an answered
 * refusal is the manager's own words and must be shown as such. Anything that is not an
 * `EpEnvelopeError` carries no provenance at all, so it gets no verdict — just its message.
 */
function railFailure(e: unknown): ManagerReply {
  if (!(e instanceof EpEnvelopeError)) return { ok: false, error: e instanceof Error ? e.message : String(e) };
  const detail = `${e.code}: ${e.message}`;
  if (unansweredRequest(e)) return { ok: false, error: `no manager answered on the endpoint rails (${detail})`, code: e.code };
  return { ok: false, error: detail, code: e.code };
}
