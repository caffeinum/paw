/**
 * Archiving agents out of the sidebar.
 *
 * A paw mesh accumulates agents — 56 in this space — and most of them are finished work. The roster is
 * the list you navigate by, so a list that only ever grows stops being navigable, and the ones that
 * matter today sit below the fold under a dozen that don't.
 *
 * The rule the operator asked for is the whole design: **archived agents stay archived until one of
 * them says something.** A new message is the only signal that an agent is live work again, and it is
 * a signal the operator does not have to maintain by hand — which is what makes this different from a
 * hide list you must remember to prune.
 *
 * State is a NAME → archived-at timestamp, not a set of names. A bare set could only answer "is this
 * hidden", and the un-archive rule needs "has anything arrived SINCE you hid it" — with a set, the
 * message that un-archived an agent would immediately re-archive it on the next poll, or never
 * un-archive it at all, depending on which side you evaluated first.
 *
 * Client-side and per space, like drafts and read-state: this is a view preference for THIS surface,
 * not a fact about the mesh. Two browsers disagreeing about what is tidied away is fine; a browser
 * quietly hiding an agent from the CLI's `paw status` would not be.
 */

const KEY = (space) => `paw.archive.${space}`;

/** Read the archive map. A corrupt or absent value reads as EMPTY — a storage glitch must show too
 *  many agents, never hide one. Hiding is the failure you cannot see, so it is the one to refuse. */
export function loadArchive(space) {
  try {
    const raw = localStorage.getItem(KEY(space));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, ts] of Object.entries(parsed)) if (typeof ts === "number" && Number.isFinite(ts)) out[name] = ts;
    return out;
  } catch {
    return {};
  }
}

export function saveArchive(space, archive) {
  try {
    localStorage.setItem(KEY(space), JSON.stringify(archive));
  } catch {
    /* storage full or blocked — a lost archive shows more agents, which is the safe direction */
  }
}

/**
 * Which archived agents have spoken since they were archived, and so are live work again.
 *
 * Only INBOUND messages count. Your own send to an archived agent is you talking to something you
 * filed away — it does not mean the agent has come back, and un-archiving on it would make the archive
 * impossible to keep tidy while you clear a backlog.
 */
export function wokenSince(archive, messages) {
  const woken = [];
  for (const [name, since] of Object.entries(archive)) {
    if (messages.some((m) => m.dir !== "out" && m.from === name && Number(m.ts) > since)) woken.push(name);
  }
  return woken;
}

/** Drop the woken agents, returning a NEW map (and whether anything changed, so the caller can avoid a
 *  pointless write on every poll — this runs at 2s and localStorage writes are synchronous). */
export function pruneArchive(archive, messages) {
  const woken = wokenSince(archive, messages);
  if (!woken.length) return { archive, changed: false, woken };
  const next = { ...archive };
  for (const name of woken) delete next[name];
  return { archive: next, changed: true, woken };
}

/**
 * Split the roster into what to show and what is filed away.
 *
 * The FOCUSED agent is never hidden, even if archived: the view you are looking at must appear in the
 * list that navigates it, or the selection points at a row that isn't there. Archiving the open
 * conversation is a legitimate act ("done with this") — it just takes effect when you leave.
 *
 * A SEARCH also overrides the archive. If you typed a name, you are looking for it, and a search that
 * silently refuses to find something you know exists is worse than a tidy list.
 */
export function partitionRoster(rows, archive, { focus = null, filter = "" } = {}) {
  const searching = filter.trim() !== "";
  const visible = [];
  const archived = [];
  for (const r of rows) {
    if (archive[r.name] === undefined || searching || r.name === focus) visible.push(r);
    else archived.push(r);
  }
  return { visible, archived };
}
