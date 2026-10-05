package toolmap

import (
	"encoding/json"
	"fmt"

	"paw/lean/conv"
)

// Grok maps to xAI's own coding-agent tool set (grok-cli, the client the SuperGrok OAuth scope
// `grok-cli:access` is issued for):
//
//	bash               {command}
//	view_file          {path, start_line?, end_line?}
//	create_file        {path, content}
//	str_replace_editor {path, old_str, new_str, replace_all?}
//
// There is no patch tool: an apply_patch call already in history (written by a codex-backed run
// of the same session) has no faithful equivalent and is flattened to text by the provider.
type Grok struct{}

func (Grok) Family() string { return "xai" }

func (Grok) Specs(enabled []string) []Spec {
	var out []Spec
	for _, t := range enabled {
		switch t {
		case conv.ToolBash:
			out = append(out, Spec{Name: "bash", Description: "Execute a bash command in a persistent shell (cwd and exported variables carry over). Returns combined stdout/stderr.",
				Params: schema(`"command":{"type":"string"},"timeout_ms":{"type":"number","description":"default 120000"}`, "command")})
		case conv.ToolRead:
			out = append(out, Spec{Name: "view_file", Description: "View a text file with line numbers, optionally a line range.",
				Params: schema(`"path":{"type":"string"},"start_line":{"type":"number"},"end_line":{"type":"number"}`, "path")})
		case conv.ToolWrite:
			out = append(out, Spec{Name: "create_file", Description: "Create or overwrite a file with the given content.",
				Params: schema(`"path":{"type":"string"},"content":{"type":"string"}`, "path", "content")})
		case conv.ToolEdit:
			out = append(out, Spec{Name: "str_replace_editor", Description: "Replace old_str with new_str in a file. old_str must match exactly and be unique unless replace_all is true. View the file first.",
				Params: schema(`"path":{"type":"string"},"old_str":{"type":"string"},"new_str":{"type":"string"},"replace_all":{"type":"boolean"}`, "path", "old_str", "new_str")})
		case conv.ToolCotalDM, conv.ToolCotalSend, conv.ToolCotalRoster:
			out = append(out, cotalSpecs[t])
		}
	}
	return out
}

func (Grok) EncodeCall(call conv.Block) (string, string, bool, bool) {
	if n, a, ok := encodeCotal(call); ok {
		return n, a, false, true
	}
	j := func(name string, v any) (string, string, bool, bool) {
		b, _ := json.Marshal(v)
		return name, string(b), false, true
	}
	switch call.Tool {
	case conv.ToolBash:
		var in conv.BashInput
		mustUnmarshal(call.Input, &in)
		cmd := in.Command
		if in.Workdir != "" {
			cmd = "cd " + shQuote(in.Workdir) + " && " + cmd
		}
		m := map[string]any{"command": cmd}
		if in.TimeoutMs > 0 {
			m["timeout_ms"] = in.TimeoutMs
		}
		return j("bash", m)
	case conv.ToolRead:
		var in conv.ReadInput
		mustUnmarshal(call.Input, &in)
		m := map[string]any{"path": in.Path}
		if in.Offset > 0 {
			m["start_line"] = in.Offset
		}
		if in.Limit > 0 {
			m["end_line"] = max(in.Offset, 1) + in.Limit - 1
		}
		return j("view_file", m)
	case conv.ToolWrite:
		var in conv.WriteInput
		mustUnmarshal(call.Input, &in)
		return j("create_file", map[string]any{"path": in.Path, "content": in.Content})
	case conv.ToolEdit:
		var in conv.EditInput
		mustUnmarshal(call.Input, &in)
		m := map[string]any{"path": in.Path, "old_str": in.OldString, "new_str": in.NewString}
		if in.ReplaceAll {
			m["replace_all"] = true
		}
		return j("str_replace_editor", m)
	}
	return "", "", false, false
}

func (Grok) EncodeResult(_, result conv.Block) string { return result.Text }

func (Grok) DecodeCall(name, args string) (string, json.RawMessage, error) {
	if t, in, ok, err := decodeCotal(name, args); ok {
		return t, in, err
	}
	var a map[string]any
	if err := json.Unmarshal([]byte(args), &a); err != nil {
		return "", nil, fmt.Errorf("%s: arguments are not JSON: %w", name, err)
	}
	s := func(k string) string { v, _ := a[k].(string); return v }
	n := func(k string) int { v, _ := a[k].(float64); return int(v) }
	switch name {
	case "bash":
		return conv.ToolBash, conv.MustJSON(conv.BashInput{Command: s("command"), TimeoutMs: n("timeout_ms")}), nil
	case "view_file":
		in := conv.ReadInput{Path: s("path"), Offset: n("start_line")}
		if e := n("end_line"); e > 0 {
			in.Limit = e - max(in.Offset, 1) + 1
		}
		return conv.ToolRead, conv.MustJSON(in), nil
	case "create_file":
		return conv.ToolWrite, conv.MustJSON(conv.WriteInput{Path: s("path"), Content: s("content")}), nil
	case "str_replace_editor":
		ra, _ := a["replace_all"].(bool)
		return conv.ToolEdit, conv.MustJSON(conv.EditInput{Path: s("path"), OldString: s("old_str"), NewString: s("new_str"), ReplaceAll: ra}), nil
	}
	return "", nil, fmt.Errorf("unknown tool %q", name)
}

// Canonical exposes the engine's tools under their canonical names (the fake provider uses it).
type Canonical struct{}

func (Canonical) Family() string { return "canonical" }
func (Canonical) Specs(enabled []string) []Spec {
	var out []Spec
	for _, t := range enabled {
		out = append(out, Spec{Name: t, Params: schema(``)})
	}
	return out
}
func (Canonical) EncodeCall(c conv.Block) (string, string, bool, bool) {
	if c.Tool == "" {
		return "", "", false, false
	}
	return c.Tool, string(c.Input), false, true
}
func (Canonical) EncodeResult(_, r conv.Block) string { return r.Text }
func (Canonical) DecodeCall(name, args string) (string, json.RawMessage, error) {
	for _, t := range conv.AllTools {
		if t == name {
			return t, json.RawMessage(args), nil
		}
	}
	return "", nil, fmt.Errorf("unknown tool %q", name)
}
