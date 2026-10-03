# DRAFT cotal_feedback — not filed (operator files, AI-disclosed)

**Title:** pty runtime: no way to answer (or even see) claude's folder-trust dialog — a booting seat
can sit at it forever

**What happens.** Claude Code shows a per-folder trust dialog ("Yes, I trust this folder" / default
"No, exit") when `~/.claude.json` has no `hasTrustDialogAccepted` for the cwd. A launcher can
pre-trust the folder, but claude rewrites `~/.claude.json` without any lock, so on a busy box another
claude's rewrite can erase a just-written entry (observed: 3 of 5 runs spawning three agents in a
row). Under the tmux runtime the launcher can read the pane and answer. Under **pty** nothing outside
the manager can see or type into the seat's terminal: the seat sits at the dialog, never reaches MCP,
and reads as `starting…` indefinitely; only the manager can tell. (`scheduleConfirm` handles the
connector's dev-channels `confirm` text only, 1s…5s after open.)

**Ask (any one helps):**
1. A connector-declared list of prompts the runtime may answer while a seat boots — e.g.
   `confirm: [{ match: "Loading development channels", keys: ["Enter"] },
   { match: "Yes, I trust this folder", keys: ["Down","Enter"], when: "cwdTrusted" }]` — scanning the
   pty output for the whole boot window, not only 1s…5s.
2. Or expose a seat's recent screen text in `inspect` (or a "waiting at prompt: «…»" field in `ps`),
   so a launcher can at least NAME the stall instead of timing out blind.
3. Or have the claude connector refuse to start a seat whose cwd isn't trusted, with an explicit
   error, instead of launching into a dialog nothing can answer.

Workaround in paw (fix/trust-race): re-assert the trust entry on every readiness poll (any runtime),
answer the dialog on tmux only for folders the launcher's own policy trusts, and name the cause in the
timeout error.

_This feedback was written by an AI agent (Claude) at the operator's request._
