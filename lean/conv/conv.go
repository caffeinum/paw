// Package conv is the neutral conversation model every other module speaks.
//
// It is deliberately smaller than any one wire format: a conversation is an ordered list of
// user/assistant messages, each a list of blocks. Tool calls carry the ENGINE's canonical tool
// name and input (see Tool* below); a call the engine has no tool for (an MCP call, Agent, …
// recorded by Claude Code) is kept as a Foreign call with its original name and raw input so it
// can be shown to a model as text and written back verbatim. Provider-private state (OpenAI
// encrypted reasoning, Anthropic thinking signatures) rides as an opaque Reasoning block tagged
// with the provider that produced it; other providers drop it.
package conv

import "encoding/json"

type Role string

const (
	User      Role = "user"
	Assistant Role = "assistant"
)

type Kind string

const (
	Text       Kind = "text"
	ToolCall   Kind = "tool_call"
	ToolResult Kind = "tool_result"
	Reasoning  Kind = "reasoning"
)

// Canonical tool names: what the engine executes. Input shapes are the structs in this file.
const (
	ToolBash        = "bash"
	ToolRead        = "read"
	ToolWrite       = "write"
	ToolEdit        = "edit"
	ToolApplyPatch  = "apply_patch"
	ToolCotalDM     = "cotal_dm"
	ToolCotalSend   = "cotal_send"
	ToolCotalRoster = "cotal_roster"
)

// CompactPreamble opens the summary message a compaction leaves in place of the old context.
const CompactPreamble = "This conversation was compacted by the lean harness. Summary of everything before this point:\n\n"

// AllTools is every canonical tool the engine can run, in a stable order.
var AllTools = []string{ToolBash, ToolRead, ToolWrite, ToolEdit, ToolApplyPatch, ToolCotalDM, ToolCotalSend, ToolCotalRoster}

type BashInput struct {
	Command   string `json:"command"`
	TimeoutMs int    `json:"timeout_ms,omitempty"`
	Workdir   string `json:"workdir,omitempty"`
}

type ReadInput struct {
	Path   string `json:"path"`
	Offset int    `json:"offset,omitempty"` // 1-based first line
	Limit  int    `json:"limit,omitempty"`
}

type WriteInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type EditInput struct {
	Path       string `json:"path"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all,omitempty"`
}

type ApplyPatchInput struct {
	Patch string `json:"patch"`
}

type CotalDMInput struct {
	To   string `json:"to"`
	Text string `json:"text"`
}

type CotalSendInput struct {
	Channel string `json:"channel"`
	Text    string `json:"text"`
}

type Block struct {
	Kind Kind   `json:"kind"`
	Text string `json:"text,omitempty"` // Text; ToolResult output

	// ToolCall / ToolResult
	CallID string `json:"call_id,omitempty"`
	// Tool is the canonical tool name; empty for a Foreign call.
	Tool string `json:"tool,omitempty"`
	// Foreign is the original name of a call the engine has no tool for (e.g. "mcp__slack__post").
	Foreign string          `json:"foreign,omitempty"`
	Input   json.RawMessage `json:"input,omitempty"` // canonical input, or the raw foreign input
	IsError bool            `json:"is_error,omitempty"`

	// Reasoning: opaque, replayable only to the provider that produced it.
	Provider string          `json:"provider,omitempty"`
	Opaque   json.RawMessage `json:"opaque,omitempty"`
}

type Message struct {
	Role   Role    `json:"role"`
	Blocks []Block `json:"blocks"`
	// Turn is set on assistant messages the harness produced: which model, how big. Stores use it
	// to fill their native metadata (Claude's message.model / usage / requestId).
	Turn *TurnInfo `json:"turn,omitempty"`
}

type TurnInfo struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	ResponseID string `json:"response_id,omitempty"`
	StopReason string `json:"stop_reason"` // "tool_use" | "end_turn" | "max_tokens"
	Usage      Usage  `json:"usage"`
}

type Usage struct {
	Input     int `json:"input"`
	CacheRead int `json:"cache_read"`
	Output    int `json:"output"`
	Reasoning int `json:"reasoning,omitempty"`
}

// Name is how a call is labelled for humans and for providers that must flatten it to text.
func (b Block) Name() string {
	if b.Tool != "" {
		return b.Tool
	}
	return b.Foreign
}

func TextBlock(s string) Block { return Block{Kind: Text, Text: s} }

// Calls returns the tool calls of a message.
func (m Message) Calls() []Block {
	var out []Block
	for _, b := range m.Blocks {
		if b.Kind == ToolCall {
			out = append(out, b)
		}
	}
	return out
}

// PlainText joins a message's text blocks.
func (m Message) PlainText() string {
	s := ""
	for _, b := range m.Blocks {
		if b.Kind == Text {
			if s != "" {
				s += "\n"
			}
			s += b.Text
		}
	}
	return s
}

// ApproxTokens is a cheap size estimate (4 chars ≈ 1 token) used only for the compaction trigger.
func ApproxTokens(msgs []Message) int {
	n := 0
	for _, m := range msgs {
		for _, b := range m.Blocks {
			n += len(b.Text) + len(b.Input) + len(b.Opaque)/4
		}
	}
	return n / 4
}

func MustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
