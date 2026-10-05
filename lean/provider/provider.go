// Package provider is the model backend layer: neutral conversation + enabled canonical tools in,
// one streamed assistant message (text + canonical tool calls) out. Each provider owns its wire
// format and composes a toolmap.Mapper for the tool names its models are tuned on, so the engine
// never sees a provider-specific name.
package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"paw/lean/conv"
	"paw/lean/toolmap"
)

type Request struct {
	System   string
	Messages []conv.Message
	Tools    []string // canonical tools the engine can run; the mapper picks its subset
	// CacheKey keeps one conversation on one prompt cache (the session id).
	CacheKey string
}

type Provider interface {
	Name() string
	Model() string
	// Turn runs one model call. onText receives streamed text deltas (may be nil). The returned
	// message has Role assistant, canonical tool calls, and Turn set.
	Turn(ctx context.Context, req Request, onText func(string)) (conv.Message, error)
}

// item is the wire-neutral history step a provider renders into its own format.
type item struct {
	role     conv.Role
	kind     string // text | call | result | reasoning
	text     string
	callID   string
	name     string
	args     string
	freeform bool
	opaque   json.RawMessage
}

const maxResultChars = 40000

func clipResult(s string) string {
	if len(s) <= maxResultChars {
		return s
	}
	return s[:maxResultChars*3/4] + fmt.Sprintf("\n… [%d chars omitted] …\n", len(s)-maxResultChars) + s[len(s)-maxResultChars/4:]
}

func flattenCall(b conv.Block) string {
	in := string(b.Input)
	if len(in) > 2000 {
		in = in[:2000] + "…"
	}
	return fmt.Sprintf("[earlier tool call %s %s]", b.Name(), in)
}

// history maps the neutral conversation through a Mapper into wire-neutral items. A call is shown
// as a native tool call only if the mapper has an equivalent AND its result is in the history;
// otherwise the call and its result are flattened to text in place (an unfinished call left by
// an interrupted session, a foreign MCP call, an apply_patch shown to a family without one).
// Reasoning is replayed only to the provider that produced it.
func history(msgs []conv.Message, m toolmap.Mapper, provider string) []item {
	answered := map[string]bool{}
	calls := map[string]conv.Block{}
	for _, msg := range msgs {
		for _, b := range msg.Blocks {
			if b.Kind == conv.ToolResult {
				answered[b.CallID] = true
			}
		}
	}
	native := map[string]bool{}
	var out []item
	for _, msg := range msgs {
		for _, b := range msg.Blocks {
			switch b.Kind {
			case conv.Text:
				if strings.TrimSpace(b.Text) != "" {
					out = append(out, item{role: msg.Role, kind: "text", text: b.Text})
				}
			case conv.ToolCall:
				calls[b.CallID] = b
				if name, args, ff, ok := m.EncodeCall(b); ok && answered[b.CallID] && b.Tool != "" {
					native[b.CallID] = true
					out = append(out, item{role: msg.Role, kind: "call", callID: b.CallID, name: name, args: args, freeform: ff})
				} else {
					out = append(out, item{role: msg.Role, kind: "text", text: flattenCall(b)})
				}
			case conv.ToolResult:
				if native[b.CallID] {
					c := calls[b.CallID]
					_, _, ff, _ := m.EncodeCall(c)
					out = append(out, item{role: msg.Role, kind: "result", callID: b.CallID, text: clipResult(m.EncodeResult(c, b)), freeform: ff})
				} else {
					out = append(out, item{role: msg.Role, kind: "text", text: "[result of earlier tool call]\n" + clipResult(b.Text)})
				}
			case conv.Reasoning:
				if b.Provider == provider {
					out = append(out, item{role: msg.Role, kind: "reasoning", opaque: b.Opaque})
				}
			}
		}
	}
	return out
}

// decode turns the model's raw calls into canonical blocks; an undecodable call becomes a
// canonical-less block the engine answers with an error result (the model sees why).
func decodeCall(m toolmap.Mapper, id, name, args string) conv.Block {
	tool, in, err := m.DecodeCall(name, args)
	if err != nil {
		return conv.Block{Kind: conv.ToolCall, CallID: id, Foreign: name, Input: conv.MustJSON(map[string]string{"raw": args, "decode_error": err.Error()})}
	}
	return conv.Block{Kind: conv.ToolCall, CallID: id, Tool: tool, Input: in}
}

// stopReason derives the neutral stop reason from the content.
func stopReason(blocks []conv.Block, truncated bool) string {
	if truncated {
		return "max_tokens"
	}
	for _, b := range blocks {
		if b.Kind == conv.ToolCall {
			return "tool_use"
		}
	}
	return "end_turn"
}
