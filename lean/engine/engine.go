// Package engine is the agent loop: inbound mesh messages become a user turn; the model is called;
// canonical tool calls are executed; results go back; repeat until the model stops calling tools.
// Every message is appended to the session store as it happens, so the transcript is always a
// valid, resumable conversation even if the process dies mid-turn.
//
// Queueing: messages that arrive while a turn runs wait in the inbox and are coalesced into ONE
// next turn (the shape paw's headless hub uses). They are acked only once that turn's prompt is
// written to the transcript, so a crash before that redelivers them.
//
// Compaction (naive): before a turn, if the estimated context (chars/4) exceeds CompactAt, the
// model is asked for a summary with no tools; the store records a compaction boundary + summary
// (for Claude Code: compact_boundary + isCompactSummary, which claude --resume honours) and the
// in-memory context restarts from the summary. No preserved tail, no mid-turn compaction.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"paw/lean/conv"
	"paw/lean/provider"
	"paw/lean/session"
	"paw/lean/tools"
	"paw/lean/transport"
)

// Mesh is what the engine needs from the transport.
type Mesh interface {
	Inbox() <-chan *transport.Inbound
	SetStatus(status string) error
	DM(to, text string) (transport.Ref, error)
	Send(channel, text string) error
	Roster() []transport.Peer
	ID() string
}

type Config struct {
	Name      string
	Space     string
	CompactAt int // estimated tokens; 0 = never
	// Root confines the file tools (read/write/edit/apply_patch); "" = unconfined.
	Root     string
	MaxSteps int
	Coalesce time.Duration // wait this long after the first message for more
	Log      io.Writer
}

type Engine struct {
	cfg    Config
	store  session.Store
	prov   provider.Provider
	mesh   Mesh
	shell  *tools.Shell
	conv   []conv.Message
	system string
	// per turn: messages already sent (a model that loops on cotal_dm must not spam its peer)
	sent  map[string]bool
	dups  int
	Turns int
}

func New(cfg Config, store session.Store, prov provider.Provider, mesh Mesh, shell *tools.Shell) (*Engine, error) {
	msgs, err := store.Load()
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", store.Meta().Path, err)
	}
	if cfg.MaxSteps == 0 {
		cfg.MaxSteps = 50
	}
	e := &Engine{cfg: cfg, store: store, prov: prov, mesh: mesh, shell: shell, conv: msgs}
	e.system = systemPrompt(cfg, store.Meta(), prov, mesh.ID())
	e.logf("loaded %s: %d messages (~%d tokens) from %s", store.Meta().Format, len(msgs), conv.ApproxTokens(msgs), store.Meta().Path)
	return e, nil
}

func (e *Engine) logf(f string, a ...any) {
	if e.cfg.Log != nil {
		fmt.Fprintf(e.cfg.Log, "[lean %s] %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(f, a...))
	}
}

func systemPrompt(cfg Config, meta session.Meta, prov provider.Provider, id string) string {
	return strings.Join([]string{
		fmt.Sprintf("You are %q, a coding agent in paw: a fleet of agents on the cotal mesh (space %q). Your mesh id is %s.", cfg.Name, cfg.Space, id),
		fmt.Sprintf("You run headless inside a small harness, driven by %s/%s. Your working directory is %s: use paths relative to it. File tools refuse paths outside it.", prov.Name(), prov.Model(), cfg.Root),
		fmt.Sprintf("The earlier conversation was recorded in %s; paths it mentions may not exist here.", meta.Cwd),
		"The conversation before this point may have been held by another agent harness (Claude Code). Treat it as your own history.",
		"Messages reach you as <channel source=\"cotal\" …> envelopes: DMs from peers or the human operator (named \"you\"), or channel posts.",
		"Nothing you write as plain text is delivered to anyone. To answer, call cotal_dm with the sender's name (or cotal_send for a channel). Reply once, when you have the answer; keep it short.",
		"Use the shell and file tools to inspect and change the workspace. Prefer small, verifiable steps. Do not ask for permission; you run with full access in your working directory.",
	}, "\n")
}

func envelope(m *transport.Inbound) string {
	attrs := fmt.Sprintf(`kind="dm" from=%q from_id=%q msg_id=%q`, m.From.Name, m.From.ID, m.ID)
	if m.Channel != "" {
		attrs = fmt.Sprintf(`kind="channel" channel=%q from=%q from_id=%q msg_id=%q`, m.Channel, m.From.Name, m.From.ID, m.ID)
	}
	return fmt.Sprintf("<channel source=\"cotal\" %s>\n%s\n</channel>", attrs, m.Text)
}

// Run serves the inbox until ctx ends.
func (e *Engine) Run(ctx context.Context) error {
	for {
		var batch []*transport.Inbound
		select {
		case <-ctx.Done():
			return ctx.Err()
		case m := <-e.mesh.Inbox():
			batch = append(batch, m)
		}
		coalesce := time.After(e.cfg.Coalesce)
	more:
		for {
			select {
			case m := <-e.mesh.Inbox():
				batch = append(batch, m)
			case <-coalesce:
				break more
			}
		}
		if err := e.Turn(ctx, batch); err != nil {
			e.logf("turn failed: %v", err)
			for _, m := range batch {
				if m.Channel == "" {
					if _, derr := e.mesh.DM(m.From.ID, "lean harness: this turn failed — "+err.Error()); derr != nil {
						e.logf("could not report the failure to %s: %v", m.From.Name, derr)
					}
				}
			}
		}
	}
}

// Turn runs one user turn built from a batch of inbound messages.
func (e *Engine) Turn(ctx context.Context, batch []*transport.Inbound) error {
	if err := e.mesh.SetStatus("working"); err != nil {
		e.logf("presence: %v", err)
	}
	defer func() {
		if err := e.mesh.SetStatus("idle"); err != nil {
			e.logf("presence: %v", err)
		}
	}()
	if err := e.maybeCompact(ctx); err != nil {
		return fmt.Errorf("compaction: %w", err)
	}
	var parts []string
	for _, m := range batch {
		parts = append(parts, envelope(m))
	}
	prompt := conv.Message{Role: conv.User, Blocks: []conv.Block{conv.TextBlock(strings.Join(parts, "\n\n"))}}
	if err := e.push(prompt); err != nil {
		return err
	}
	for _, m := range batch {
		if err := m.Ack(); err != nil {
			e.logf("ack %s: %v", m.ID, err)
		}
	}
	e.Turns++
	e.sent, e.dups = map[string]bool{}, 0
	e.logf("turn %d: %d inbound message(s)", e.Turns, len(batch))
	for step := 0; step < e.cfg.MaxSteps; step++ {
		t0 := time.Now()
		resp, err := e.prov.Turn(ctx, provider.Request{System: e.system, Messages: e.conv, Tools: conv.AllTools, CacheKey: e.store.Meta().SessionID}, nil)
		if err != nil {
			return err
		}
		u := resp.Turn.Usage
		e.logf("  model %s: %d calls, in=%d (cached %d) out=%d, %s", resp.Turn.Model, len(resp.Calls()), u.Input, u.CacheRead, u.Output, time.Since(t0).Round(time.Millisecond))
		if err := e.push(resp); err != nil {
			return err
		}
		calls := resp.Calls()
		if len(calls) == 0 {
			return nil
		}
		results := conv.Message{Role: conv.User}
		for _, c := range calls {
			r := e.exec(c)
			e.logf("    %s %s → %s", c.Name(), short(string(c.Input), 120), short(r.Text, 120))
			results.Blocks = append(results.Blocks, r)
		}
		if err := e.push(results); err != nil {
			return err
		}
		if e.dups >= 3 {
			e.logf("  ending the turn: the model re-sent identical messages %d times", e.dups)
			return nil
		}
	}
	return fmt.Errorf("tool loop exceeded %d steps", e.cfg.MaxSteps)
}

func (e *Engine) push(m conv.Message) error {
	if err := e.store.Append(m); err != nil {
		return fmt.Errorf("append to %s: %w", e.store.Meta().Path, err)
	}
	e.conv = append(e.conv, m)
	return nil
}

func (e *Engine) maybeCompact(ctx context.Context) error {
	n := conv.ApproxTokens(e.conv)
	if e.cfg.CompactAt <= 0 || n < e.cfg.CompactAt {
		return nil
	}
	e.logf("compacting: ~%d tokens ≥ %d", n, e.cfg.CompactAt)
	ask := append(append([]conv.Message{}, e.conv...), conv.Message{Role: conv.User, Blocks: []conv.Block{conv.TextBlock(
		"Summarize this conversation for your own continuation: the goals, decisions, current state of the work, files touched, open questions and the next steps. Be specific; the earlier messages will be gone.")}})
	resp, err := e.prov.Turn(ctx, provider.Request{System: "COMPACTION: you write a dense, faithful summary of a coding-agent conversation.", Messages: ask, CacheKey: e.store.Meta().SessionID}, nil)
	if err != nil {
		return err
	}
	summary := resp.PlainText()
	if strings.TrimSpace(summary) == "" {
		return fmt.Errorf("the model returned an empty summary")
	}
	if err := e.store.Compact(summary, n); err != nil {
		return err
	}
	e.conv = []conv.Message{{Role: conv.User, Blocks: []conv.Block{conv.TextBlock(conv.CompactPreamble + summary)}}}
	return nil
}

// once refuses an identical message sent twice in one turn (seen live: grok-build-0.1 re-sent the
// same cotal_dm 45 times until the step cap).
func (e *Engine) once(key string) error {
	if e.sent == nil {
		e.sent = map[string]bool{}
	}
	if e.sent[key] {
		e.dups++
		return fmt.Errorf("NOT sent: you already sent this exact message in this turn. It was delivered; do not resend. End your turn now")
	}
	e.sent[key] = true
	return nil
}

func short(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", "⏎")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func (e *Engine) exec(c conv.Block) conv.Block {
	res := conv.Block{Kind: conv.ToolResult, CallID: c.CallID}
	fail := func(err error) conv.Block {
		res.Text, res.IsError = "error: "+err.Error(), true
		return res
	}
	if c.Tool == "" {
		return fail(fmt.Errorf("unknown tool %q (input %s)", c.Foreign, short(string(c.Input), 300)))
	}
	dec := func(v any) error { return json.Unmarshal(c.Input, v) }
	cwd := e.shell.Cwd()
	switch c.Tool {
	case conv.ToolBash:
		var in conv.BashInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		wd, err := tools.Resolve("", cwd, in.Workdir)
		if err != nil {
			return fail(err)
		}
		r, err := e.shell.Run(in.Command, wd, time.Duration(in.TimeoutMs)*time.Millisecond)
		if err != nil {
			return fail(err)
		}
		res.Text = r.Output
		if r.Note != "" {
			res.Text += "\n[" + r.Note + "]"
		}
		if r.ExitCode != 0 && !r.TimedOut {
			res.Text += fmt.Sprintf("\n[exit code %d]", r.ExitCode)
		}
		res.IsError = r.ExitCode != 0 || r.TimedOut
		if res.Text == "" {
			res.Text = "(no output)"
		}
		return res
	case conv.ToolRead:
		var in conv.ReadInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		p, err := tools.Resolve(e.cfg.Root, cwd, in.Path)
		if err != nil {
			return fail(err)
		}
		out, err := tools.Read(p, in.Offset, in.Limit)
		if err != nil {
			return fail(err)
		}
		res.Text = out
	case conv.ToolWrite:
		var in conv.WriteInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		p, err := tools.Resolve(e.cfg.Root, cwd, in.Path)
		if err != nil {
			return fail(err)
		}
		out, err := tools.Write(p, in.Content)
		if err != nil {
			return fail(err)
		}
		res.Text = out
	case conv.ToolEdit:
		var in conv.EditInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		p, err := tools.Resolve(e.cfg.Root, cwd, in.Path)
		if err != nil {
			return fail(err)
		}
		out, err := tools.Edit(p, in.OldString, in.NewString, in.ReplaceAll)
		if err != nil {
			return fail(err)
		}
		res.Text = out
	case conv.ToolApplyPatch:
		var in conv.ApplyPatchInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		out, err := tools.ApplyPatch(e.cfg.Root, cwd, in.Patch)
		if err != nil {
			return fail(err)
		}
		res.Text = out
	case conv.ToolCotalDM:
		var in conv.CotalDMInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		if err := e.once("dm\x00" + in.To + "\x00" + in.Text); err != nil {
			return fail(err)
		}
		r, err := e.mesh.DM(in.To, in.Text)
		if err != nil {
			return fail(err)
		}
		res.Text = fmt.Sprintf("delivered to %s (%s). If that was your answer, stop here: end the turn without more tool calls.", r.Name, r.ID)
	case conv.ToolCotalSend:
		var in conv.CotalSendInput
		if err := dec(&in); err != nil {
			return fail(err)
		}
		if err := e.once("send\x00" + in.Channel + "\x00" + in.Text); err != nil {
			return fail(err)
		}
		if err := e.mesh.Send(in.Channel, in.Text); err != nil {
			return fail(err)
		}
		res.Text = "posted to #" + in.Channel + ". If that was your answer, stop here: end the turn without more tool calls."
	case conv.ToolCotalRoster:
		var lines []string
		for _, p := range e.mesh.Roster() {
			lines = append(lines, fmt.Sprintf("%s\t%s\t%s\t%s", p.Name, p.ID, p.Kind, p.Status))
		}
		res.Text = "name\tid\tkind\tstatus\n" + strings.Join(lines, "\n")
	default:
		return fail(fmt.Errorf("tool %q is not implemented", c.Tool))
	}
	return res
}
