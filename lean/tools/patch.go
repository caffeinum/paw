package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ApplyPatch applies a patch in the codex `apply_patch` envelope format (the edit format OpenAI's
// codex models are trained to emit):
//
//	*** Begin Patch
//	*** Add File: path        (+lines)
//	*** Delete File: path
//	*** Update File: path
//	*** Move to: newpath      (optional)
//	@@ optional context header
//	 context / -removed / +added lines
//	*** End of File           (optional)
//	*** End Patch
//
// Every hunk of an Update must match the file; nothing is written unless the whole patch applies.
func ApplyPatch(root, cwd, patch string) (string, error) {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(patch), "\r\n", "\n"), "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[0]) != "*** Begin Patch" || strings.TrimSpace(lines[len(lines)-1]) != "*** End Patch" {
		return "", errors.New("patch must start with '*** Begin Patch' and end with '*** End Patch'")
	}
	type op struct {
		kind, path, moveTo, content string
		del                         bool
	}
	var ops []op
	pending := map[string]string{} // path → new content, so two hunks on one file compose
	read := func(p string) (string, error) {
		if s, ok := pending[p]; ok {
			return s, nil
		}
		b, err := os.ReadFile(p)
		return string(b), err
	}
	body := lines[1 : len(lines)-1]
	for i := 0; i < len(body); {
		l := body[i]
		switch {
		case strings.HasPrefix(l, "*** Add File: "):
			p, err := Resolve(root, cwd, strings.TrimSpace(strings.TrimPrefix(l, "*** Add File: ")))
			if err != nil {
				return "", err
			}
			i++
			var sb strings.Builder
			for i < len(body) && !strings.HasPrefix(body[i], "*** ") {
				if !strings.HasPrefix(body[i], "+") {
					return "", fmt.Errorf("Add File %s: line %q must start with '+'", p, body[i])
				}
				sb.WriteString(body[i][1:] + "\n")
				i++
			}
			pending[p] = sb.String()
			ops = append(ops, op{kind: "add", path: p, content: sb.String()})
		case strings.HasPrefix(l, "*** Delete File: "):
			p, err := Resolve(root, cwd, strings.TrimSpace(strings.TrimPrefix(l, "*** Delete File: ")))
			if err != nil {
				return "", err
			}
			if _, err := os.Stat(p); err != nil {
				return "", fmt.Errorf("Delete File %s: %w", p, err)
			}
			ops = append(ops, op{kind: "delete", path: p, del: true})
			i++
		case strings.HasPrefix(l, "*** Update File: "):
			p, err := Resolve(root, cwd, strings.TrimSpace(strings.TrimPrefix(l, "*** Update File: ")))
			if err != nil {
				return "", err
			}
			i++
			moveTo := ""
			if i < len(body) && strings.HasPrefix(body[i], "*** Move to: ") {
				mv, err := Resolve(root, cwd, strings.TrimSpace(strings.TrimPrefix(body[i], "*** Move to: ")))
				if err != nil {
					return "", err
				}
				moveTo = mv
				i++
			}
			src, err := read(p)
			if err != nil {
				return "", fmt.Errorf("Update File %s: %w", p, err)
			}
			for i < len(body) && !strings.HasPrefix(body[i], "*** Add File: ") && !strings.HasPrefix(body[i], "*** Delete File: ") && !strings.HasPrefix(body[i], "*** Update File: ") {
				if strings.HasPrefix(body[i], "@@") || body[i] == "*** End of File" {
					i++
					continue
				}
				var old, nw []string
				for i < len(body) && !strings.HasPrefix(body[i], "@@") && !strings.HasPrefix(body[i], "*** ") {
					l := body[i]
					switch {
					case l == "":
						old, nw = append(old, ""), append(nw, "")
					case l[0] == ' ':
						old, nw = append(old, l[1:]), append(nw, l[1:])
					case l[0] == '-':
						old = append(old, l[1:])
					case l[0] == '+':
						nw = append(nw, l[1:])
					default:
						return "", fmt.Errorf("Update File %s: line %q must start with ' ', '-' or '+'", p, l)
					}
					i++
				}
				if src, err = replaceHunk(src, old, nw); err != nil {
					return "", fmt.Errorf("Update File %s: %w", p, err)
				}
			}
			pending[p] = src
			ops = append(ops, op{kind: "update", path: p, moveTo: moveTo, content: src})
		default:
			return "", fmt.Errorf("unexpected patch line %q", l)
		}
	}
	if len(ops) == 0 {
		return "", errors.New("patch has no file operations")
	}
	var done []string
	for _, o := range ops {
		switch o.kind {
		case "delete":
			if err := os.Remove(o.path); err != nil {
				return "", err
			}
			done = append(done, "D "+o.path)
		default:
			dst := o.path
			if o.moveTo != "" {
				dst = o.moveTo
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return "", err
			}
			if err := os.WriteFile(dst, []byte(o.content), 0o644); err != nil {
				return "", err
			}
			if o.moveTo != "" {
				os.Remove(o.path)
			}
			done = append(done, map[string]string{"add": "A ", "update": "M "}[o.kind]+dst)
		}
	}
	return "Success. Updated the following files:\n" + strings.Join(done, "\n"), nil
}

// replaceHunk finds old (as whole lines) in src exactly once — exact first, then ignoring
// trailing whitespace — and replaces it with nw.
func replaceHunk(src string, old, nw []string) (string, error) {
	lines := strings.Split(src, "\n")
	trailingNL := strings.HasSuffix(src, "\n")
	if trailingNL {
		lines = lines[:len(lines)-1]
	}
	if len(old) == 0 { // pure addition: append at end of file
		lines = append(lines, nw...)
		return join(lines, trailingNL || len(lines) > 0), nil
	}
	for _, eq := range []func(a, b string) bool{
		func(a, b string) bool { return a == b },
		func(a, b string) bool { return strings.TrimRight(a, " \t") == strings.TrimRight(b, " \t") },
		func(a, b string) bool { return strings.TrimSpace(a) == strings.TrimSpace(b) },
	} {
		at := -1
		for s := 0; s+len(old) <= len(lines); s++ {
			ok := true
			for k := range old {
				if !eq(lines[s+k], old[k]) {
					ok = false
					break
				}
			}
			if ok {
				if at != -1 {
					return "", fmt.Errorf("hunk matches more than once:\n%s", strings.Join(old, "\n"))
				}
				at = s
			}
		}
		if at != -1 {
			out := append(append(append([]string{}, lines[:at]...), nw...), lines[at+len(old):]...)
			return join(out, trailingNL), nil
		}
	}
	return "", fmt.Errorf("hunk does not match the file:\n%s", strings.Join(old, "\n"))
}

func join(lines []string, nl bool) string {
	s := strings.Join(lines, "\n")
	if nl {
		s += "\n"
	}
	return s
}
