/**
 * The chat itself, shared by the `Paw Chat` command and the "Chat" action on the agents list.
 *
 * Raycast has no chat primitive, so this uses the idiomatic substitute: a `List` whose SEARCH BAR is
 * the composer (`filtering={false}` + controlled `searchText`), with the transcript as items, newest
 * first so the latest reply sits under the cursor without scrolling.
 *
 * The transcript is GLOBAL: `paw inbox --json` already returns every DM to "you" from every agent, so
 * this shows all of them and the dropdown only picks who your NEXT message goes to. It opens on a
 * bounded TAIL of the inbox (the whole history would bury the conversation you just started) and then
 * polls for anything newer than the moment it opened.
 *
 * Sending and receiving are asymmetric on purpose, because that's what paw is: `paw dm` is
 * fire-and-forget and the reply lands later in the durable "you" inbox, so the view sends immediately
 * and POLLS the inbox for replies.
 */
import { Action, ActionPanel, Color, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { formatDistanceStrict } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { subscribeInbox, subscribeRoster } from "./feed";
import { AgentRow, InboxMessage, ago, clipboardImagePath, fetchInbox, markInboxRead, sendDm, spaceKey } from "./paw";
import { addReadIds, messageKey, subscribeReadIds } from "./read-state";

/** How much history to open with. Enough to read back a conversation, short enough not to bury it. */
const SEED_TAIL = 30;
/** One failed poll is normal mid-restart; a RUN of them means paw is gone and the user should know. */
const FAILS_BEFORE_ALARM = 3;

interface Line {
  id: string;
  /** The sender's agent name, or "you" — paw's human peer, a name no agent can take. */
  who: string;
  text: string;
  ts: number;
  /** Who a SENT line went to — a focused view must show your half of that conversation and no other. */
  to?: string;
  /** A sent line stays pending until paw's dm call returns, so a failed send is visible, not silent. */
  pending?: boolean;
  failed?: boolean;
}

/**
 * Two modes, one component. Unfocused, this is the whole inbox: every agent's DMs to "you" share one
 * stream, so the default view is all of it. `focus` narrows it to one conversation — that agent's
 * messages plus your own sends to them.
 *
 * The modes are stacked as NAVIGATION rather than toggled in place, so Escape does the obvious thing
 * without paw binding it: a focused chat pops to the full transcript, and that pops to wherever you
 * came from. Binding Escape directly is possible but would take "go back" away from the operator,
 * which is a worse trade than one extra view on the stack.
 */
export function ChatView(props: { recipient: string; agents?: AgentRow[]; focus?: string }) {
  const [target, setTarget] = useState(props.recipient);
  /** Focus is STATE, not just the prop: the prop seeds it when you arrive from the roster, and Enter on
   *  an empty composer toggles it in place. (Escape still widens too — that comes from the view stack.) */
  const [focus, setFocus] = useState(props.focus);
  /** Which row the cursor is on — Enter-to-filter needs to know what you are looking at. */
  const [selectedId, setSelectedId] = useState<string | undefined>();
  /** Whether the first read has come back. Until it has, "no messages" is a LIE — it is "not yet
   *  known" — and flashing an empty state before data arrives reads as a broken chat. */
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [pollFailure, setPollFailure] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());
  /** RAYCAST's OWN read set, PER MESSAGE. Not paw's shared cursor (every paw surface advances that by
   *  merely displaying, so a terminal keeps it past the newest message) and not a local cursor either
   *  (one number for the whole inbox marks other agents' older messages read too). See read-state.ts. */
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  /** Images staged for the NEXT message. The search bar is a text field — there is nothing to paste an
   *  image into — so an explicit action pulls it off the clipboard and it rides with your next send. */
  const [attachments, setAttachments] = useState<string[]>([]);
  /** The roster arrives as a prop but goes STALE the moment an agent wakes or drops — and a red
   *  "offline" dot that is merely out of date is worse than none, so re-read it on a slow cadence.
   *  Slower than the message poll on purpose: presence changes on a human timescale, messages don't. */
  const [agents, setAgents] = useState<AgentRow[]>(props.agents ?? []);

  // The seed covers the history; the poll only has to carry what lands after the view opened.
  const since = useRef(Date.now());
  // Inbox reads are cumulative, so dedupe across the seed and every poll by (ts, from) — paw has no
  // message id here.
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    const off = subscribeReadIds(spaceKey(), (ids) => alive && setReadIds(ids));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Open on the inbox tail. This races the first poll, so it MERGES (older lines in front) instead of
  // replacing, and goes through the same dedupe.
  useEffect(() => {
    let alive = true;
    fetchInbox()
      .then(({ messages }) => {
        if (!alive) return;
        const tail = takeUnseen(seen.current, messages.slice(-SEED_TAIL));
        if (tail.length) setLines((prev) => [...tail.map(agentLine), ...prev]);
      })
      // One-shot, so one failure is the whole story: say it rather than opening a blank-looking chat.
      .catch((e) => {
        if (alive) void showToast({ style: Toast.Style.Failure, title: "Couldn't load history", message: (e as Error).message });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // Presence is decoration here; the chat still works without it, so a failure must not alarm.
    const off = subscribeRoster((p) => alive && setAgents(p.rows));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let fails = 0;
    const off = subscribeInbox(
      ({ messages }) => {
        if (!alive) return;
        setLoaded(true);
        fails = 0;
        setPollFailure(undefined);
        const fresh = takeUnseen(
          seen.current,
          messages.filter((m) => m.ts > since.current),
        );
        if (fresh.length) setLines((prev) => reconcile(prev, fresh));
      },
      (e) => {
        if (!alive) return;
        setLoaded(true); // an error is an answer too — better the empty state than a spinner forever
        // One failed poll is normal mid-restart; a RUN of them means paw is gone and the user should know.
        fails += 1;
        if (fails === FAILS_BEFORE_ALARM) {
          setPollFailure(e.message);
          void showToast({ style: Toast.Style.Failure, title: "Can't reach paw", message: e.message });
        }
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Focused: that agent's messages and your sends TO them. Unfocused: everything.
  const shown = focus ? lines.filter((l) => (l.who === "you" ? l.to === focus : l.who.toLowerCase() === focus.toLowerCase())) : lines;
  // Newest first: Raycast puts the cursor on the top item, so the latest reply is what you land on.
  const ordered = [...shown].reverse();
  const last = shown.length > 0 ? shown[shown.length - 1] : undefined;
  const sending = last?.pending === true;
  /** Your line is unanswered until ANY agent speaks — the only honest "something is happening" signal. */
  const awaiting = last !== undefined && last.who === "you" && !last.failed && !sending;

  // `now` drives every relative timestamp, so it has to keep ticking even when nothing is in flight —
  // otherwise "2 minutes ago" freezes at whatever it said when the last message landed. A second while
  // awaiting (the elapsed counter is the only "something is happening" signal); half a minute otherwise,
  // which is finer than the smallest unit shown and costs a re-render a minute.
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), awaiting ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [awaiting]);

  async function attachFromClipboard() {
    try {
      const path = await clipboardImagePath();
      if (!path) {
        await showToast({ style: Toast.Style.Failure, title: "No image on the clipboard" });
        return;
      }
      setAttachments((prev) => [...prev, path]);
      await showToast({ style: Toast.Style.Success, title: `Attached [Image #${attachments.length + 1}]` });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't attach", message: (e as Error).message });
    }
  }

  /** The agent a row is about: theirs by sender, yours by recipient. */
  function agentOf(l: Line | undefined): string | undefined {
    return l ? (l.who === "you" ? l.to : l.who) : undefined;
  }

  async function submit() {
    const text = input.trim();
    // Enter on an EMPTY composer used to do nothing at all. Spend it on the filter: narrow to the agent
    // whose message you are reading, and Enter again on empty widens back. Sending is unaffected —
    // this branch is only reachable when there is nothing to send.
    if (!text && attachments.length === 0) {
      if (focus) {
        setFocus(undefined);
        return;
      }
      const who = agentOf(lines.find((l) => l.id === selectedId));
      if (who) {
        setFocus(who);
        setTarget(who);
      }
      return;
    }
    const id = `y${Date.now()}`;
    const riding = attachments;
    const body = text || `[${riding.length} image${riding.length === 1 ? "" : "s"}]`;
    setInput("");
    setAttachments([]);
    setLines((prev) => [...prev, { id, who: "you", to: target, text: body, ts: Date.now(), pending: true }]);
    setBusy(true);
    try {
      await sendDm(target, text, riding);
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, pending: false } : l)));
    } catch (e) {
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, pending: false, failed: true } : l)));
      setAttachments(riding); // put them back — a failed send must not silently drop what you staged
      await showToast({ style: Toast.Style.Failure, title: "Send failed", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const live = agents.filter((a) => a.live);
  /** Who is NOT on the mesh right now — an offline sender is why a reply isn't coming. */
  const offline = new Set(agents.filter((a) => !a.live).map((a) => a.name.toLowerCase()));
  // The current recipient stays selectable even when it's offline: `paw dm` wakes it from its pin.
  const names = live.map((a) => a.name);
  const options = names.includes(target) ? names : [target, ...names];

  /** Unread = an AGENT line newer than RAYCAST's read line. Your own sent lines are never "unread". */
  const isUnread = (l: Line) => l.who !== "you" && !l.pending && !readIds.has(messageKey(l.ts, l.who));
  const unread = shown.filter(isUnread).length;

  async function markRead() {
    try {
      // Everything currently VISIBLE — in a focused view that is this conversation, not the whole
      // inbox, which is what "mark all as read" should mean while you are looking at one agent.
      const keys = shown.filter((l) => l.who !== "you" && !l.pending).map((l) => messageKey(l.ts, l.who));
      await addReadIds(spaceKey(), keys); // the store pushes the new set to every view
      await markInboxRead(); // paw's shared cursor too: "I have read these" is true everywhere
      await showToast({ style: Toast.Style.Success, title: unread ? `Marked ${unread} read` : "Nothing unread" });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't mark read", message: (e as Error).message });
    }
  }

  // Enter does one of two things depending on whether you have typed anything; the action panel has to
  // say which, or the filter toggle is a hidden feature nobody finds.
  const idle = !input.trim() && attachments.length === 0;
  const selectedAgent = agentOf(lines.find((l) => l.id === selectedId));
  const primaryTitle = !idle ? "Send" : focus ? "Show All Agents" : selectedAgent ? `Filter to ${selectedAgent}` : "Send";
  const primaryIcon = !idle ? Icon.ArrowRight : focus ? Icon.List : Icon.Filter;

  const markAction = (
    <Action title="Mark All as Read" icon={Icon.Checkmark} shortcut={{ modifiers: ["cmd", "shift"], key: "r" }} onAction={markRead} />
  );
  const attachAction = (
    <Action title="Attach Image from Clipboard" icon={Icon.Image} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={attachFromClipboard} />
  );
  const clearAction =
    attachments.length > 0 ? (
      <Action title="Clear Attachments" icon={Icon.XMarkCircle} shortcut={{ modifiers: ["cmd", "shift"], key: "x" }} onAction={() => setAttachments([])} />
    ) : null;

  return (
    <List
      isLoading={!loaded || busy || awaiting}
      navigationTitle={pollFailure ? "paw unreachable" : `${focus ?? "All agents"}${unread ? ` — ${unread} unread` : ""}`}
      searchText={input}
      onSearchTextChange={setInput}
      filtering={false}
      onSelectionChange={(id) => {
        // Reading a message and then sending to someone else is never what you meant, so the selection
        // sets the recipient: an agent's line targets that agent, your own targets whoever it went to.
        if (!id) return; // deselection (empty list, filtering) — nothing to target
        setSelectedId(id);
        const l = lines.find((x) => x.id === id);
        if (l && l.who !== "you" && !l.pending) {
          const k = messageKey(l.ts, l.who);
          if (!readIds.has(k)) {
            // No setReadIds here — the store notifies every mounted view, this one included.
            addReadIds(spaceKey(), [k]).catch((e: Error) => console.error(`paw: could not persist read state — ${e.message}`));
          }
        }
        if (!l) {
          // Every rendered row sets an explicit `id`, so an unresolvable one means they have drifted
          // apart — exactly the bug that made the recipient ignore the selection. Say so.
          console.error(`paw: selected row "${id}" matches no message — the row id and Line id have drifted`);
          return;
        }
        const who = l.who === "you" ? l.to : l.who;
        if (who && who !== target) setTarget(who);
      }}
      searchBarPlaceholder={attachments.length ? `Message ${target}… (${attachments.length} image${attachments.length === 1 ? "" : "s"} attached)` : `Message ${target}…`}
      // Escape pops a focused chat back to the full transcript — see the component note.
      isShowingDetail={ordered.length > 0}
      searchBarAccessory={
        !focus && options.length > 1 ? (
          <List.Dropdown tooltip="Send next message to" value={target} onChange={setTarget}>
            {options.map((name) => (
              <List.Dropdown.Item key={name} title={`To ${name}`} value={name} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
      actions={
        <ActionPanel>
          <Action title={primaryTitle} icon={primaryIcon} onAction={submit} />
          {attachAction}
          {clearAction}
          {markAction}
        </ActionPanel>
      }
    >
      {ordered.length === 0 && !loaded ? null : ordered.length === 0 ? (
        <List.EmptyView
          icon={Icon.Message}
          title={focus ? `Nothing from ${focus} yet` : "No messages yet"}
          description={
            focus
              ? `Type a message and press Enter. Enter on an empty line (or Escape) shows every agent.`
              : `Type a message and press Enter to send it to ${target}. Replies from any agent land here.`
          }
        />
      ) : (
        ordered.map((l) => (
          <List.Item
            key={l.id}
            id={l.id}
            title={rowTitle(l)}
            icon={leftIcon(l, isUnread(l), offline.has(l.who.toLowerCase()))}
            accessories={
              isUnread(l)
                ? [{ text: "unread" }, { text: statusOf(l, l.id === last?.id && awaiting, now) }]
                : [{ text: statusOf(l, l.id === last?.id && awaiting, now) }]
            }
            detail={<List.Item.Detail markdown={`**${l.who}**\n\n${l.text}`} />}
            actions={
              <ActionPanel>
                <Action title={primaryTitle} icon={primaryIcon} onAction={submit} />
                {attachAction}
                {clearAction}
                {markAction}
                <Action.CopyToClipboard title="Copy Message" content={l.text} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

/** Drop anything already rendered, and remember the rest. Shared by the seed and the poll. */
function takeUnseen(seen: Set<string>, msgs: InboxMessage[]): InboxMessage[] {
  return msgs.filter((m) => {
    const key = `${m.ts}:${m.from}:${m.to ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function agentLine(m: InboxMessage): Line {
  // An "out" message is one of YOURS, read back from the stream — render it on your side of the thread.
  if (m.dir === "out") return { id: `s${m.ts}`, who: "you", to: m.to, text: m.text, ts: m.ts };
  return { id: `a${m.ts}:${m.from}`, who: m.from, text: m.text, ts: m.ts };
}

/**
 * The row's right-hand cell, and the only worded progress the chat has: `sending…` while `paw dm` is in
 * flight, then a live `waiting 12s` until someone replies, then the send time.
 */
/**
 * The left slot carries ONE signal: this is new. A read row gets no icon at all, so the eye lands on
 * what changed instead of scanning a column of identical decoration — an indicator every row has
 * indicates nothing.
 *
 * A failed send keeps its mark regardless: an error must never be the thing that renders as blank.
 * An unread line from an agent that is currently OFFLINE goes red, because that is the case where no
 * reply is coming until something wakes it.
 */
function leftIcon(l: Line, unread: boolean, senderOffline: boolean): { source: Icon; tintColor?: Color } | undefined {
  if (l.failed) return { source: Icon.ExclamationMark, tintColor: Color.Red };
  if (!unread) return undefined;
  return senderOffline ? { source: Icon.CircleFilled, tintColor: Color.Red } : { source: Icon.CircleFilled };
}

/**
 * Fold newly-read messages into the transcript, absorbing the echo of what we sent.
 *
 * A message you send is added OPTIMISTICALLY so the row appears at once with a "sending…" state, and
 * then comes BACK from the stream a couple of seconds later — the same message, a different id.
 * Appending it blindly doubles every line you write. So an inbound "out" message first tries to claim
 * an existing local line with the same recipient and text; only an unclaimed one becomes a new row.
 * Matching CONSUMES the line, so sending the same text twice really does render twice.
 */
function reconcile(prev: Line[], fresh: InboxMessage[]): Line[] {
  const claimed = new Set<string>();
  const added: Line[] = [];
  for (const m of fresh) {
    if (m.dir === "out") {
      const mine = prev.find((l) => l.who === "you" && !claimed.has(l.id) && l.to === m.to && l.text === m.text);
      if (mine) {
        claimed.add(mine.id);
        continue;
      }
    }
    added.push(agentLine(m));
  }
  return added.length ? [...prev, ...added] : prev;
}

/**
 * Who the row is about. An agent's line is just its name; YOUR line names the recipient, because "you"
 * on every outgoing row says nothing — in a transcript that mixes agents, which one you were talking
 * to is the whole point. An unresolved recipient shows its raw id rather than a guess.
 */
function rowTitle(l: Line): string {
  return l.who === "you" ? `you → ${l.to ?? "?"}` : l.who;
}

function statusOf(l: Line, awaiting: boolean, now: number): string {
  if (l.pending) return "sending…";
  if (l.failed) return "failed";
  if (awaiting) return `waiting ${ago(l.ts, now)}`;
  return relative(l.ts, now);
}

/** "3 minutes ago" rather than "07:09 PM" — in a live transcript the question is always how long ago,
 *  and a clock time makes you do that arithmetic yourself. `now` is threaded in (not read from the
 *  clock) so the whole list re-renders off ONE instant and can't disagree with itself mid-render. */
function relative(ts: number, now: number): string {
  return formatDistanceStrict(new Date(ts), new Date(now), { addSuffix: true, roundingMethod: "floor" });
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Opening an agent from the roster should land you IN that conversation, with the full inbox one
 * Escape behind it — the mode switch the operator asked for, expressed as navigation.
 *
 * So this renders the unfocused transcript and immediately pushes the focused one on top. Two views
 * on the stack rather than a toggle, because Escape then means "widen" and then "back" without paw
 * binding a key Raycast reserves for exactly that.
 */
export function ChatEntry(props: { recipient: string; agents?: AgentRow[]; focus: string }) {
  const { push } = useNavigation();
  const pushed = useRef(false);
  useEffect(() => {
    if (pushed.current) return; // StrictMode double-invokes effects; a second push would stack a duplicate
    pushed.current = true;
    push(<ChatView recipient={props.focus} agents={props.agents} focus={props.focus} />);
  }, []);
  return <ChatView recipient={props.recipient} agents={props.agents} />;
}
