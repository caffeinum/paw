/**
 * paw chat's startup, run CONCURRENTLY: ensure() (mesh, manager, mailbox) beside the human inbox and
 * the chat endpoint. They used to run back to back — on a remote space a manager probe, then the
 * inbox's durable provisioning, then the endpoint's connect, each a round trip to the broker — and
 * none of the three needs another's answer, only the broker. So the inbox + endpoint chain starts the
 * moment ensure() says the mesh is up (`onMeshUp`), and everything is awaited before the target is
 * resolved or spawned.
 *
 * A failure anywhere releases whatever the others acquired — the endpoint is stopped, the inbox's
 * remote durables retired — and the FIRST failure in startup order is thrown (ensure's before the
 * chain's: a broker that is down fails both, and ensure's error is the one that names the cause). A
 * release that itself fails is reported, never swallowed, and never replaces the original error.
 *
 * The chat UI is up while this runs, so it can be CANCELLED (`signal`: the operator quit). Nothing in
 * flight is interrupted — a half-made durable is worse than a slow quit: each step settles, then the
 * same release path runs and an AbortError is thrown. An abort seen before a step starts skips it. The
 * inbox's release is registered BEFORE its provisioning starts (`prepareInbox` → `provision`), so a
 * quit mid-provision still retires whatever provisioning made.
 */
export interface StartupSteps<I, E> {
  /** ensure(); calls `meshUp` once the broker can be dialled (it may never call it on a failure). */
  ensure(meshUp: () => void): Promise<void>;
  /** Local work only (no broker): returns the inbox's release, then `provision` makes its footprint. */
  prepareInbox(): Promise<{ release(): Promise<void>; provision(): Promise<I> }>;
  startEndpoint(inbox: I): Promise<E>;
  stopEndpoint(ep: E): Promise<void>;
  /** Where a failed release is said (stderr in chat). */
  report(message: string): void;
  /** The operator quit: skip what hasn't started, settle what has, release, throw AbortError. */
  signal?: AbortSignal;
  /** Which step is now the slow one, for the footer's loader. */
  onPhase?(phase: "inbox" | "endpoint"): void;
}

export class StartupCancelled extends Error {
  override name = "AbortError";
  constructor() {
    super("startup cancelled");
  }
}

export async function concurrentStartup<I, E>(steps: StartupSteps<I, E>): Promise<{ inbox: I; endpoint: E; release(): Promise<void> }> {
  let inbox: I | undefined;
  let endpoint: E | undefined;
  let release: (() => Promise<void>) | undefined;
  let chain: Promise<void> | undefined;
  const aborted = () => steps.signal?.aborted === true;
  const startChain = (): void => {
    if (aborted()) return;
    chain ??= (async () => {
      steps.onPhase?.("inbox");
      const prepared = await steps.prepareInbox();
      release = prepared.release; // registered before the first broker call of provisioning
      if (aborted()) return;
      inbox = await prepared.provision();
      if (aborted()) return;
      steps.onPhase?.("endpoint");
      endpoint = await steps.startEndpoint(inbox);
    })();
    chain.catch(() => {}); // settled below; never an unhandled rejection meanwhile
  };
  let ensureError: { e: unknown } | undefined;
  try {
    await steps.ensure(startChain);
    startChain(); // an ensure() that never signalled still leaves the mesh up once it resolves
  } catch (e) {
    ensureError = { e };
  }
  let chainError: { e: unknown } | undefined;
  if (chain) await chain.catch((e: unknown) => (chainError = { e }));
  const failed = ensureError ?? chainError ?? (aborted() ? { e: new StartupCancelled() } : undefined);
  if (!failed) return { inbox: inbox as I, endpoint: endpoint as E, release: release! };
  if (endpoint !== undefined) await steps.stopEndpoint(endpoint).catch((e: Error) => steps.report(`paw: chat endpoint didn't stop cleanly: ${e.message}`));
  if (release !== undefined) await release().catch((e: Error) => steps.report(e.message));
  throw failed.e;
}
