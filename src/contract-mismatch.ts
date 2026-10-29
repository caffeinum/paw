/**
 * cotal's "pinned digests … do not match the served contract" refusal, read back into one line an
 * operator can act on.
 *
 * WHERE THE DIGEST COMES FROM (verified 2026-10-28 against cotal 0.100.0, docs/notes/agents.md
 * #contract-mismatch): a scattered manager read (`ps`, and `attach`'s seat locate) first `describe`s
 * the manager endpoint on the CLASS route — whichever registered manager instance answers first — and
 * pins THAT instance's per-command contract digests on the request it then sends to every instance.
 * An instance serving a different contract refuses (SPEC 13.7). The digests are a function of the
 * cotal version alone (the manager's static cluster document; 0.81–0.84 = revision 27, ps output
 * `89813c…`; 0.100.0 = revision 37, `3b805c…`), never of paw's connector or release. So a space
 * whose managers run different cotal versions — one per machine on a remote space — flakes per call:
 * the side that wins the describe lists, the other side refuses. Restarting THIS machine's manager
 * changes nothing; the odd host has to upgrade (or, if dead, be deregistered).
 */

const DIGEST = "sha256:[0-9a-f]{64}";

export type Mismatch = { instanceId?: string; pinnedOutput: string; servedOutput: string };

/** Every digest refusal in cotal's output, in both of its shapes:
 *  - the endpoint refusal itself (attach's "refused the read" list, `<id>: pinned digests …`), and
 *  - `ps`'s census remedy (`manager <id>: requested input/output A / B; served input/output C / D`). */
export function parseMismatches(text: string): Mismatch[] {
  const out: Mismatch[] = [];
  const pinned = new RegExp(`(?:([a-z0-9]{8,}): )?pinned digests ${DIGEST}\\/(${DIGEST}) do not match the served contract ${DIGEST}\\/(${DIGEST})`, "g");
  for (const m of text.matchAll(pinned)) out.push({ ...(m[1] ? { instanceId: m[1] } : {}), pinnedOutput: m[2], servedOutput: m[3] });
  const census = new RegExp(`manager ([a-z0-9]{8,}): requested input\\/output ${DIGEST} \\/ (${DIGEST}); served input\\/output ${DIGEST} \\/ (${DIGEST})`, "g");
  for (const m of text.matchAll(census)) out.push({ instanceId: m[1], pinnedOutput: m[2], servedOutput: m[3] });
  return dedupe(out);
}

/** cotal's digest-free warning line (`! manager <id> serves a different ps contract`) — enough to know
 *  a mismatch happened even when the remedy line with the digests was cut. */
export function mentionsMismatch(text: string): boolean {
  return /serves a different ps contract|do not match the served contract|serve different ps contracts/.test(text);
}

const short = (d: string): string => d.replace(/^sha256:/, "").slice(0, 12);
const shortId = (id: string): string => `${id.slice(0, 8)}…`;

/**
 * The one actionable line for a mismatch seen in `text`, or undefined when there is none.
 * `localInstanceId` is THIS machine's manager instance on a remote space (absent on a local space,
 * where paw runs exactly one manager).
 */
export function contractMismatchHint(o: { space: string; text: string; remote: boolean; localInstanceId?: string }): string | undefined {
  const found = parseMismatches(o.text);
  if (!found.length && !mentionsMismatch(o.text)) return undefined;
  if (!o.remote)
    return (
      `paw: space "${o.space}" has managers serving different cotal contracts, but paw runs one manager per local space — ` +
      `a leftover one from another release is answering too. \`paw restart --space ${o.space}\` leaves exactly one.`
    );
  const local = o.localInstanceId ? found.find((m) => m.instanceId === o.localInstanceId) : undefined;
  const pinned = found[0]?.pinnedOutput;
  // A refusal from this machine's manager means the describe was answered by a manager on another
  // version; its served digest is this machine's contract. Otherwise the refusers are the odd ones.
  const ours = local?.servedOutput;
  const odd = ours
    ? `the manager that answered cotal's describe serves ps contract ${short(local!.pinnedOutput)} (another host on a different cotal version); this machine's manager ${shortId(local!.instanceId!)} serves ${short(ours)} and is fine`
    : found.length
      ? `manager(s) ${found.map((m) => `${m.instanceId ? shortId(m.instanceId) : "?"} (serves ${short(m.servedOutput)})`).join(", ")} run a different cotal version than the one that answered describe (${short(pinned!)})`
      : "two managers in the space run different cotal versions";
  return (
    `paw: space "${o.space}" mixes cotal versions across hosts — ${odd}. cotal pins whichever manager answers describe first, ` +
    `so the others refuse at random; \`paw restart\` here does not fix it. Upgrade paw on the odd host (git pull, \`paw release\`, ` +
    `\`paw restart\` there) or deregister it if it is dead. \`paw attach <name>\` pins seats this machine hosts to its own manager.`
  );
}

function dedupe(ms: Mismatch[]): Mismatch[] {
  const seen = new Set<string>();
  return ms.filter((m) => {
    const k = `${m.instanceId ?? ""}\0${m.pinnedOutput}\0${m.servedOutput}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
