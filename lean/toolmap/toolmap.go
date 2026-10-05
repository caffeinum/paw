// Package toolmap translates between the engine's canonical tools (conv.Tool*) and the tool set a
// given model family is tuned on. Models are trained against specific tool names and argument
// shapes — OpenAI's codex models against `shell_command` + a freeform `apply_patch` grammar, xAI's
// Grok against grok-cli's `bash` / `view_file` / `create_file` / `str_replace_editor` — and do
// noticeably better when they get them. A Mapper owns, for one family:
//
//   - Specs: the model-facing tool definitions;
//   - EncodeCall / EncodeResult: how a canonical call already in the conversation (including
//     Claude Code's Bash/Read/Edit/Write records, which the session loader canonicalised) is
//     shown to this model in history; ok=false means "no faithful equivalent — flatten to text";
//   - DecodeCall: the model's call → a canonical call the engine executes.
package toolmap

import (
	"encoding/json"
	"fmt"
	"strings"

	"paw/lean/conv"
)

type Spec struct {
	Name        string
	Description string
	Params      json.RawMessage // JSON schema; nil for a freeform tool
	// Grammar makes the tool FREEFORM (OpenAI "custom" tool): the model emits raw text matching
	// this Lark grammar instead of JSON arguments.
	Grammar string
}

type Mapper interface {
	Family() string
	Specs(enabled []string) []Spec
	EncodeCall(call conv.Block) (name, args string, freeform, ok bool)
	EncodeResult(call, result conv.Block) string
	DecodeCall(name, args string) (tool string, input json.RawMessage, err error)
}

func schema(props string, required ...string) json.RawMessage {
	req, _ := json.Marshal(required)
	if required == nil {
		req = []byte("[]")
	}
	return json.RawMessage(fmt.Sprintf(`{"type":"object","properties":{%s},"required":%s,"additionalProperties":false}`, props, req))
}

// The cotal tools are the same for every family: they are paw's own, not something any model was
// tuned on, and they mirror the names Claude agents on the mesh use (mcp__cotal__cotal_dm …).
var cotalSpecs = map[string]Spec{
	conv.ToolCotalDM: {Name: "cotal_dm", Description: "Send a direct message to a peer on the cotal mesh, by name (e.g. \"you\" is the human operator) or by id. This is the ONLY way your words reach anyone: plain assistant text is not delivered.",
		Params: schema(`"to":{"type":"string","description":"peer name or id"},"text":{"type":"string"}`, "to", "text")},
	conv.ToolCotalSend: {Name: "cotal_send", Description: "Post a message to a cotal channel (e.g. general). Everyone subscribed sees it.",
		Params: schema(`"channel":{"type":"string"},"text":{"type":"string"}`, "channel", "text")},
	conv.ToolCotalRoster: {Name: "cotal_roster", Description: "List the peers currently online on the cotal mesh (name, id, status).",
		Params: schema(``)},
}

func decodeCotal(name, args string) (string, json.RawMessage, bool, error) {
	var tool string
	switch name {
	case "cotal_dm":
		tool = conv.ToolCotalDM
	case "cotal_send":
		tool = conv.ToolCotalSend
	case "cotal_roster":
		return conv.ToolCotalRoster, json.RawMessage(`{}`), true, nil
	default:
		return "", nil, false, nil
	}
	if !json.Valid([]byte(args)) {
		return "", nil, true, fmt.Errorf("%s: arguments are not JSON", name)
	}
	return tool, json.RawMessage(args), true, nil
}

func encodeCotal(call conv.Block) (string, string, bool) {
	s, ok := cotalSpecs[call.Tool]
	if !ok {
		return "", "", false
	}
	return s.Name, string(call.Input), true
}

func mustUnmarshal(raw json.RawMessage, v any) {
	if err := json.Unmarshal(raw, v); err != nil {
		panic(fmt.Sprintf("canonical input does not decode: %v", err))
	}
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// prefixLines turns text into patch body lines with a one-char prefix.
func prefixLines(prefix, s string) string {
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return prefix + "\n"
	}
	var b strings.Builder
	for _, l := range strings.Split(s, "\n") {
		b.WriteString(prefix + l + "\n")
	}
	return b.String()
}

func For(family string) (Mapper, error) {
	switch family {
	case "openai":
		return Codex{}, nil
	case "xai":
		return Grok{}, nil
	case "canonical":
		return Canonical{}, nil
	}
	return nil, fmt.Errorf("no tool mapping for %q", family)
}
