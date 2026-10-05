package toolmap

import (
	"encoding/json"
	"fmt"
	"strings"

	"paw/lean/conv"
)

// Codex maps to the tools OpenAI's codex model family is tuned on. The ChatGPT codex backend's
// model catalogue (GET /backend-api/codex/models) declares, for every current model,
// shell_type "shell_command" and apply_patch_tool_type "freeform":
//
//	shell_command {command: string, workdir?: string, timeout_ms?: number}
//	apply_patch   freeform (custom tool) — the raw patch text, constrained by a Lark grammar
//
// There is no read/write/edit tool in this family: the model reads with the shell and edits with
// apply_patch. Claude history is mapped accordingly — a Read becomes the equivalent numbered
// `nl -ba` shell call, an Edit an Update-File patch hunk, a Write an Add-File patch.
type Codex struct{}

func (Codex) Family() string { return "openai" }

const patchGrammar = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

func (Codex) Specs(enabled []string) []Spec {
	var out []Spec
	for _, t := range enabled {
		switch t {
		case conv.ToolBash:
			out = append(out, Spec{Name: "shell_command", Description: "Run a shell command in a persistent bash session (cwd and exported variables carry over between calls) and return its output. Use it to read files too (cat, nl -ba, sed -n, rg).",
				Params: schema(`"command":{"type":"string","description":"the shell script to run"},"workdir":{"type":"string","description":"directory to run in (default: the current one)"},"timeout_ms":{"type":"number","description":"kill after this many ms (default 120000)"}`, "command")})
		case conv.ToolApplyPatch:
			out = append(out, Spec{Name: "apply_patch", Description: "Create, update, move or delete files with a patch in the *** Begin Patch / *** End Patch format. Use this for every file edit.", Grammar: patchGrammar})
		case conv.ToolCotalDM, conv.ToolCotalSend, conv.ToolCotalRoster:
			out = append(out, cotalSpecs[t])
		}
	}
	return out
}

func (Codex) EncodeCall(call conv.Block) (string, string, bool, bool) {
	if n, a, ok := encodeCotal(call); ok {
		return n, a, false, true
	}
	shell := func(cmd, workdir string, timeout int) (string, string, bool, bool) {
		m := map[string]any{"command": cmd}
		if workdir != "" {
			m["workdir"] = workdir
		}
		if timeout > 0 {
			m["timeout_ms"] = timeout
		}
		b, _ := json.Marshal(m)
		return "shell_command", string(b), false, true
	}
	switch call.Tool {
	case conv.ToolBash:
		var in conv.BashInput
		mustUnmarshal(call.Input, &in)
		return shell(in.Command, in.Workdir, in.TimeoutMs)
	case conv.ToolRead:
		var in conv.ReadInput
		mustUnmarshal(call.Input, &in)
		cmd := "nl -ba -w6 " + shQuote(in.Path)
		if in.Offset > 0 || in.Limit > 0 {
			from := max(in.Offset, 1)
			to := "$"
			if in.Limit > 0 {
				to = fmt.Sprint(from + in.Limit - 1)
			}
			cmd += fmt.Sprintf(" | sed -n '%d,%sp'", from, to)
		}
		return shell(cmd, "", 0)
	case conv.ToolWrite:
		var in conv.WriteInput
		mustUnmarshal(call.Input, &in)
		return "apply_patch", "*** Begin Patch\n*** Add File: " + in.Path + "\n" + prefixLines("+", in.Content) + "*** End Patch\n", true, true
	case conv.ToolEdit:
		var in conv.EditInput
		mustUnmarshal(call.Input, &in)
		return "apply_patch", "*** Begin Patch\n*** Update File: " + in.Path + "\n@@\n" + prefixLines("-", in.OldString) + prefixLines("+", in.NewString) + "*** End Patch\n", true, true
	case conv.ToolApplyPatch:
		var in conv.ApplyPatchInput
		mustUnmarshal(call.Input, &in)
		return "apply_patch", in.Patch, true, true
	}
	return "", "", false, false
}

// EncodeResult renders shell results the way codex frames them ("Exit code / Output").
func (Codex) EncodeResult(call, result conv.Block) string {
	if call.Tool != conv.ToolBash && call.Tool != conv.ToolRead {
		return result.Text
	}
	code := "0"
	if result.IsError {
		code = "1"
	}
	return "Exit code: " + code + "\nOutput:\n" + result.Text
}

func (Codex) DecodeCall(name, args string) (string, json.RawMessage, error) {
	if t, in, ok, err := decodeCotal(name, args); ok {
		return t, in, err
	}
	switch name {
	case "shell_command", "shell":
		var a struct {
			Command   json.RawMessage `json:"command"`
			Workdir   string          `json:"workdir"`
			TimeoutMs int             `json:"timeout_ms"`
		}
		if err := json.Unmarshal([]byte(args), &a); err != nil {
			return "", nil, fmt.Errorf("%s: %w", name, err)
		}
		cmd, err := commandString(a.Command)
		if err != nil {
			return "", nil, err
		}
		return conv.ToolBash, conv.MustJSON(conv.BashInput{Command: cmd, Workdir: a.Workdir, TimeoutMs: a.TimeoutMs}), nil
	case "apply_patch":
		patch := args
		// the function-call form wraps the patch as {"input": "..."}
		var w struct {
			Input string `json:"input"`
		}
		if json.Unmarshal([]byte(args), &w) == nil && w.Input != "" {
			patch = w.Input
		}
		return conv.ToolApplyPatch, conv.MustJSON(conv.ApplyPatchInput{Patch: patch}), nil
	}
	return "", nil, fmt.Errorf("unknown tool %q", name)
}

// commandString accepts codex's string form and the older argv form (["bash","-lc","…"]).
func commandString(raw json.RawMessage) (string, error) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil
	}
	var argv []string
	if err := json.Unmarshal(raw, &argv); err != nil || len(argv) == 0 {
		return "", fmt.Errorf("shell command is neither a string nor an argv array: %s", raw)
	}
	if len(argv) == 3 && (argv[0] == "bash" || argv[0] == "sh" || argv[0] == "zsh") && (argv[1] == "-lc" || argv[1] == "-c") {
		return argv[2], nil
	}
	q := make([]string, len(argv))
	for i, a := range argv {
		q[i] = shQuote(a)
	}
	return strings.Join(q, " "), nil
}
