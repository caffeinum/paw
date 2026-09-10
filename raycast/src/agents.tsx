/**
 * `Paw Agents` — one row per registered agent, live or not, the same view `paw status` prints.
 *
 * The status column is the point: an agent can be *listed* and still be dead on the mesh, and a
 * presence-"idle" agent can be sitting on undrained DMs (the zombie case paw's inbox-lag detector
 * exists for). Both are surfaced here rather than flattened into "running".
 */
import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { ChatEntry } from "./chat-view";
import { subscribeRoster } from "./feed";
import { AgentRow, ago, inboxLabel, spaceKey, tilde } from "./paw";
import { loadRoster, saveRoster } from "./roster-cache";

export default function Agents() {
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    // Same reason as Paw Chat: paint the LAST roster at once rather than holding an empty list behind a
    // spinner for the ~4s it takes Raycast to start and paw to answer. Replaced by the live read below.
    void loadRoster(spaceKey()).then((cached) => {
      if (!alive || cached.length === 0) return;
      setRows((cur) => (cur.length ? cur : cached)); // never clobber a live read that already landed
      setLoading(false);
    });
    const off = subscribeRoster(
      (p) => {
        if (!alive) return;
        setRows(p.rows);
        setErrors(p.errors ?? []);
        setFailure(undefined);
        setLoading(false);
        void saveRoster(spaceKey(), p.rows);
      },
      (e) => {
        if (!alive) return;
        // Only take the view over when there is NOTHING to show. With a roster on screen — cached or
        // live — replacing it with a full-page error because one poll failed hides working information
        // and makes a blip look like an outage; the next tick corrects it.
        setRows((cur) => {
          if (cur.length === 0) setFailure(e.message);
          return cur;
        });
        setLoading(false);
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    for (const e of errors) void showToast({ style: Toast.Style.Failure, title: "paw", message: e });
  }, [errors]);

  if (failure) {
    return (
      <List>
        <List.EmptyView
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title="Can't reach paw"
          description={failure}
        />
      </List>
    );
  }

  const live = rows.filter((r) => r.live);
  const offline = rows.filter((r) => !r.live);

  return (
    <List isLoading={loading} searchBarPlaceholder="Filter agents…">
      <List.Section title="Live" subtitle={live.length ? String(live.length) : undefined}>
        {live.map((r) => (
          <AgentItem key={r.name} row={r} agents={rows} />
        ))}
      </List.Section>
      <List.Section title="Offline" subtitle={offline.length ? String(offline.length) : undefined}>
        {offline.map((r) => (
          <AgentItem key={r.name} row={r} agents={rows} />
        ))}
      </List.Section>
      {loading ? null : <List.EmptyView icon={Icon.Dot} title="No agents registered" description="`paw chat <folder>` births one." />}
    </List>
  );
}

function AgentItem(props: { row: AgentRow; agents: AgentRow[] }) {
  const r = props.row;
  const stuck = inboxLabel(r.inbox);
  const accessories: List.Item.Accessory[] = [];
  // A live agent that isn't consuming its DMs is the failure worth shouting about — it looks fine
  // everywhere else, and a message sent to it just never gets answered.
  if (stuck && r.live) accessories.push({ tag: { value: stuck, color: Color.Orange }, tooltip: "DMs queued but not consumed" });
  if (r.conflictPids.length) accessories.push({ tag: { value: "2 writers", color: Color.Red }, tooltip: `pids ${r.conflictPids.join(", ")}` });
  // The dot already encodes state by colour, but colour alone is not a label — and "starting" vs
  // "working" vs "waiting" are decisions you make differently. Spell it out.
  accessories.push({ text: r.mesh, tooltip: r.live ? "mesh presence" : "not on the mesh — messaging wakes it" });
  if (r.runtime) accessories.push({ text: r.runtime });
  accessories.push({ text: ago(r.activeMs), tooltip: "last active (transcript mtime)" });

  return (
    <List.Item
      // Explicit and stable: rows re-sort live-first on every roster refresh, and without an id of our
      // own Raycast generates one, so the highlight can jump to a different agent under the cursor.
      id={r.name}
      title={r.name}
      subtitle={tilde(r.folder)}
      icon={statusIcon(r)}
      accessories={accessories}
      actions={
        <ActionPanel>
          <Action.Push title="Chat" icon={Icon.Message} target={<ChatEntry recipient={r.name} focus={r.name} agents={props.agents} />} />
          <Action.CopyToClipboard title="Copy Name" content={r.name} />
          <Action.CopyToClipboard title="Copy Folder" content={r.folder} shortcut={{ modifiers: ["cmd"], key: "." }} />
          <Action.ShowInFinder path={r.folder} shortcut={{ modifiers: ["cmd", "shift"], key: "f" }} />
          {r.sessionName ? <Action.CopyToClipboard title="Copy Session Name" content={r.sessionName} /> : null}
        </ActionPanel>
      }
    />
  );
}

function statusIcon(r: AgentRow): { source: Icon; tintColor: Color } {
  if (r.mesh === "working") return { source: Icon.CircleFilled, tintColor: Color.Yellow };
  if (r.mesh === "waiting") return { source: Icon.CircleFilled, tintColor: Color.Magenta };
  if (r.mesh === "starting") return { source: Icon.CircleProgress50, tintColor: Color.Blue };
  if (r.live) return { source: Icon.CircleFilled, tintColor: Color.Green };
  return { source: Icon.Circle, tintColor: Color.SecondaryText };
}
