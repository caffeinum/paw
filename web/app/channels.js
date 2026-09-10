/**
 * Channels as agent folders.
 *
 * The operator's ask (2026-09-03): a channel row should unfold into the agents that are IN it — click
 * the channel to message the channel, click an agent under it to DM that agent. The shape is Slack's
 * channel-members list, folded into the sidebar row itself.
 *
 * WHERE MEMBERSHIP COMES FROM, honestly: on an OPEN cotal mesh there is no membership registry paw can
 * read — `channelMembers()` and `readMembership()` both answer empty (probed live 2026-09-03: the
 * members KV is manager-written on authed meshes and the membership feed needs the delivery daemon,
 * neither of which an open mesh has). What paw CAN know is who has SPOKEN in a channel (the retained
 * backlog plus the live tap), and that every paw-spawned persona subscribes to #general. So a channel's
 * members are "agents seen posting here", and #general is every registered agent. Stated in the UI
 * as such — a list that claims more than paw knows would be the lie this sidebar is built not to tell.
 *
 * The open/closed state of each channel is a view preference, per space, like folds and archive.
 */

export const GENERAL = "general";

/** Which agents to list under a channel. `members` is the server's name → authors map (what has been
 *  seen posting), `rows` the roster (every registered agent, with liveness). #general lists the whole
 *  roster; any other channel lists its authors that are agents on the roster, plus authors paw does
 *  not know as agents (a human or an endpoint that posted) — shown but not clickable-as-agent. */
export function channelMembersFor(channel, members, rows) {
  const byName = new Map((rows ?? []).map((r) => [r.name, r]));
  const live = (r) => !!r && r.mesh !== "offline";
  if (channel === GENERAL) {
    return (rows ?? []).map((r) => ({ name: r.name, agent: true, live: live(r) }));
  }
  const seen = (members && members[channel]) ?? [];
  return seen.map((name) => ({ name, agent: byName.has(name), live: live(byName.get(name)) }));
}

/** Sort: live agents first, then offline agents, then non-agents; alphabetical within a group. */
export function sortMembers(list) {
  const rank = (m) => (m.agent ? (m.live ? 0 : 1) : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const KEY = (space) => `paw.chopen.${space}`;

/** Which channels are unfolded. A corrupt value reads as NONE open — a shut row is recoverable with one
 *  click; a row silently stuck open is not a failure you notice. */
export function loadOpen(space) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(space)) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveOpen(space, open) {
  try {
    localStorage.setItem(KEY(space), JSON.stringify(open));
  } catch {
    /* storage may be unavailable; the fold still works for this page */
  }
}

/** Toggle one channel's open state; returns the new map (pure). */
export function toggleOpen(open, channel) {
  const next = { ...open };
  if (next[channel]) delete next[channel];
  else next[channel] = true;
  return next;
}

/* ── channel unread: "has anything landed since I last looked at this channel" ─────────────────────
 * The DM cursor is one number for the whole inbox and there is no channel equivalent, so channels keep
 * their OWN per-channel "last seen" stamp, client-side and per space (like read-state and archive). The
 * server counts messages after that stamp (`/api/channel-unread`); the client only decides when a
 * channel counts as looked at: focused AND the tab visible+focused — the same rule DMs use, because a
 * background tab rendering a channel is not you reading it. */

const SEEN_KEY = (space) => `paw.chseen.${space}`;

/** Corrupt storage → nothing seen → everything unread: too much mail, never hidden mail. */
export function loadSeen(space) {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY(space)) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out = {};
    for (const [k, t] of Object.entries(v)) if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
    return out;
  } catch {
    return {};
  }
}

export function saveSeen(space, seen) {
  try {
    localStorage.setItem(SEEN_KEY(space), JSON.stringify(seen));
  } catch {
    /* storage may be unavailable; the state still holds for this page */
  }
}

/** Forward-only: a stale poll can never move "seen" backwards and resurrect read messages as unread. */
export function markSeen(seen, channel, ts) {
  if (!Number.isFinite(ts)) return seen;
  if ((seen[channel] ?? 0) >= ts) return seen;
  return { ...seen, [channel]: ts };
}

/** Unread count for a row: the server's count after `seen`, or 0 when the server knows nothing yet
 *  (a channel the daemon has not scanned is "unknown", and unknown must not light up as unread). */
export function channelUnread(activity, channel) {
  const a = activity && activity[channel];
  return a && Number.isFinite(a.unread) ? a.unread : 0;
}
