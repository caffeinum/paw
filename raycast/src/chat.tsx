/**
 * `Paw Chat` — the top-level command. It opens straight into the ONE global transcript (every agent's
 * DMs to "you" share an inbox, so there is nothing to pick between); the roster is still fetched
 * because ChatView needs it for the recipient dropdown and for who the first message goes to.
 */
import { Color, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { ChatView } from "./chat-view";
import { AgentRow, fetchStatus, spaceKey } from "./paw";
import { loadRoster, saveRoster } from "./roster-cache";

export default function Chat() {
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | undefined>();
  // A ticking elapsed counter, so the WAIT reports its own duration instead of being guessed at from
  // outside. Every measurement I could take from a shell said this call is ~1.1s while the window
  // showed ~4s, and the two cannot both be right — the number belongs where the waiting happens.
  // It doubles as a build marker: if this counter is absent, the running bundle is not this source.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setWaited((w) => w + 0.1), 100);
    return () => clearInterval(t);
  }, [loading]);

  useEffect(() => {
    let alive = true;
    // Show the LAST roster immediately, then replace it when the real read lands, so a repeat open
    // paints at once instead of holding an empty list behind a spinner while `paw status` runs.
    // The cached copy is stale by definition — names, folders, a slightly old pip — and nothing that
    // must be current reads from it: sending goes through the CLI, which resolves the target itself.
    void loadRoster(spaceKey()).then((cached) => {
      if (!alive || cached.length === 0) return;
      setRows(cached);
      setLoading(false); // there is something real on screen; the spinner would now be a lie
    });
    fetchStatus()
      .then((p) => {
        if (!alive) return;
        setRows(p.rows);
        void saveRoster(spaceKey(), p.rows);
      })
      // A failure only takes over the view when we have NOTHING to show. With a cached roster up, the
      // honest thing is to keep it and let the next poll correct it, rather than replace a usable list
      // with an error because one read failed.
      .catch((e) => alive && setRows((cur) => (cur.length === 0 ? (setFailure((e as Error).message), cur) : cur)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (failure) {
    return (
      <List>
        <List.EmptyView icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }} title="Can't reach paw" description={failure} />
      </List>
    );
  }

  if (loading) return <List isLoading searchBarPlaceholder={`Reading the roster… ${waited.toFixed(1)}s`} />;

  // No live agent means no honest default recipient — say so rather than guessing one and DMing it.
  const live = rows.filter((r) => r.live);
  if (live.length === 0) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Dot}
          title="No agents are live"
          description="`paw chat <folder>` births one; `paw dm <agent>` wakes a pinned one."
        />
      </List>
    );
  }

  return <ChatView recipient={live[0].name} agents={rows} />;
}
