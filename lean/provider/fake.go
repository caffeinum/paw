package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"paw/lean/conv"
	"paw/lean/toolmap"
)

// Fake is an offline, deterministic provider for tests. It runs the SAME history mapping and call
// decoding as a real provider of the mapper's family (so `fake:openai` exercises the codex tool
// mapping end to end), driven by a script in the prompt:
//
//	FAKE: [{"name":"shell_command","args":"{\"command\":\"ls\"}"}, …]
//
// First step: emit those calls (model-facing names). Once their results are in: DM the sender
// (from="…" in the inbound envelope) a digest of the results, then end the turn.
type Fake struct {
	Map   toolmap.Mapper
	Calls int
}

func (p *Fake) Name() string  { return "fake" }
func (p *Fake) Model() string { return "fake-" + p.Map.Family() }

var (
	fakeScript = regexp.MustCompile(`(?m)^FAKE: (\[.*\])\s*$`)
	fakeFrom   = regexp.MustCompile(`from="([^"]+)"`)
)

func (p *Fake) Turn(_ context.Context, req Request, onText func(string)) (conv.Message, error) {
	p.Calls++
	items := history(req.Messages, p.Map, p.Name()) // exercised for its errors/panics on real history
	info := &conv.TurnInfo{Provider: "fake", Model: p.Model(), ResponseID: fmt.Sprintf("fake-%d", p.Calls), Usage: conv.Usage{Input: conv.ApproxTokens(req.Messages), Output: 10}}
	out := conv.Message{Role: conv.Assistant, Turn: info}
	if strings.Contains(req.System, "COMPACTION") {
		out.Blocks = []conv.Block{conv.TextBlock(fmt.Sprintf("FAKE SUMMARY of %d messages", len(req.Messages)))}
		info.StopReason = "end_turn"
		return out, nil
	}
	// find the last prompt (user text) and whether calls since then have been answered
	last := -1
	for i := len(req.Messages) - 1; i >= 0; i-- {
		m := req.Messages[i]
		if m.Role == conv.User && m.PlainText() != "" && len(m.Calls()) == 0 && !hasResult(m) {
			last = i
			break
		}
	}
	if last < 0 {
		return conv.Message{}, fmt.Errorf("fake: no prompt in %d messages (%d history items)", len(req.Messages), len(items))
	}
	prompt := req.Messages[last].PlainText()
	from := "you"
	if m := fakeFrom.FindStringSubmatch(prompt); m != nil {
		from = m[1]
	}
	var results []string
	for _, m := range req.Messages[last+1:] {
		for _, b := range m.Blocks {
			if b.Kind == conv.ToolResult {
				results = append(results, b.Text)
			}
		}
	}
	answeredDM := false
	for _, m := range req.Messages[last+1:] {
		for _, c := range m.Calls() {
			if c.Tool == conv.ToolCotalDM {
				answeredDM = true
			}
		}
	}
	sc := fakeScript.FindStringSubmatch(prompt)
	switch {
	case answeredDM:
		out.Blocks = []conv.Block{conv.TextBlock("done")}
	case sc != nil && sc[1] != "[]" && len(results) == 0:
		var calls []struct{ Name, Args string }
		if err := json.Unmarshal([]byte(sc[1]), &calls); err != nil {
			return conv.Message{}, fmt.Errorf("fake: bad script: %w", err)
		}
		for i, c := range calls {
			out.Blocks = append(out.Blocks, decodeCall(p.Map, fmt.Sprintf("call_fake_%d_%d", p.Calls, i), c.Name, c.Args))
		}
	default:
		digest := fmt.Sprintf("FAKE-REPLY history_items=%d results=%d", len(items), len(results))
		for _, l := range strings.Split(prompt, "\n") {
			if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "FAKE:") && !strings.HasPrefix(l, "<") {
				digest += " echo=" + l
			}
		}
		for _, r := range results {
			digest += "\n---\n" + trimTo(r, 300)
		}
		name, args, _, _ := p.Map.EncodeCall(conv.Block{Kind: conv.ToolCall, Tool: conv.ToolCotalDM, Input: conv.MustJSON(conv.CotalDMInput{To: from, Text: digest})})
		out.Blocks = []conv.Block{decodeCall(p.Map, fmt.Sprintf("call_fake_%d_dm", p.Calls), name, args)}
	}
	if onText != nil {
		onText(out.PlainText())
	}
	info.StopReason = stopReason(out.Blocks, false)
	return out, nil
}

func hasResult(m conv.Message) bool {
	for _, b := range m.Blocks {
		if b.Kind == conv.ToolResult {
			return true
		}
	}
	return false
}

func trimTo(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
