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
 */
export interface StartupSteps<I, E> {
  /** ensure(); calls `meshUp` once the broker can be dialled (it may never call it on a failure). */
  ensure(meshUp: () => void): Promise<void>;
  openInbox(): Promise<I>;
  releaseInbox(inbox: I): Promise<void>;
  startEndpoint(inbox: I): Promise<E>;
  stopEndpoint(ep: E): Promise<void>;
  /** Where a failed release is said (stderr in chat). */
  report(message: string): void;
}

export async function concurrentStartup<I, E>(steps: StartupSteps<I, E>): Promise<{ inbox: I; endpoint: E }> {
  let inbox: I | undefined;
  let endpoint: E | undefined;
  let chain: Promise<void> | undefined;
  const startChain = (): void => {
    chain ??= (async () => {
      inbox = await steps.openInbox();
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
  const failed = ensureError ?? chainError;
  if (!failed) return { inbox: inbox as I, endpoint: endpoint as E };
  if (endpoint !== undefined) await steps.stopEndpoint(endpoint).catch((e: Error) => steps.report(`paw: chat endpoint didn't stop cleanly: ${e.message}`));
  if (inbox !== undefined) await steps.releaseInbox(inbox).catch((e: Error) => steps.report(e.message));
  throw failed.e;
}
