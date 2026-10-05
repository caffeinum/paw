package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Resolve makes a model-supplied path absolute against the shell's cwd and, when root is set,
// refuses a path outside it. This matters more than it looks: a model continuing a session
// recorded in another project reaches for that project's absolute paths (seen live with both
// gpt-6-luna and grok-build-0.1), which would edit the original checkout. The file tools are
// confined; the shell is NOT (no sandbox) — see docs/notes/lean-harness-poc.md.
func Resolve(root, cwd, p string) (string, error) {
	if p == "" {
		return "", nil
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(cwd, p)
	}
	p = filepath.Clean(p)
	if root == "" {
		return p, nil
	}
	if within(realish(root), realish(p)) {
		return p, nil
	}
	return "", fmt.Errorf("%s is outside this agent's working directory %s — file tools are confined to it", p, root)
}

func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// realish resolves symlinks on the longest existing prefix (so /var/… and /private/var/… compare
// equal on macOS even for a file that does not exist yet).
func realish(p string) string {
	rest := ""
	for cur := p; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// Read returns numbered lines (`%6d\t`), the convention every coding model is tuned on.
func Read(path string, offset, limit int) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if offset < 1 {
		offset = 1
	}
	if limit <= 0 {
		limit = 2000
	}
	lines := strings.Split(string(b), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return "(empty file)", nil
	}
	if offset > len(lines) {
		return "", fmt.Errorf("offset %d is past the end of the file (%d lines)", offset, len(lines))
	}
	end := offset - 1 + limit
	if end > len(lines) {
		end = len(lines)
	}
	var sb strings.Builder
	for i := offset - 1; i < end; i++ {
		l := lines[i]
		if len(l) > 2000 {
			l = l[:2000] + "… [line truncated]"
		}
		fmt.Fprintf(&sb, "%6d\t%s\n", i+1, l)
	}
	if end < len(lines) {
		fmt.Fprintf(&sb, "… %d more lines (read with offset %d)\n", len(lines)-end, end+1)
	}
	return sb.String(), nil
}

func Write(path, content string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	_, statErr := os.Stat(path)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	if statErr == nil {
		return "updated " + path, nil
	}
	return "created " + path, nil
}

// Edit replaces old with new; old must occur exactly once unless replaceAll.
func Edit(path, old, new string, replaceAll bool) (string, error) {
	if old == "" {
		return "", errors.New("old_string is empty — use write to create a file")
	}
	if old == new {
		return "", errors.New("old_string and new_string are identical")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := string(b)
	n := strings.Count(s, old)
	switch {
	case n == 0:
		return "", fmt.Errorf("old_string not found in %s", path)
	case n > 1 && !replaceAll:
		return "", fmt.Errorf("old_string occurs %d times in %s — add context to make it unique, or set replace_all", n, path)
	}
	if replaceAll {
		s = strings.ReplaceAll(s, old, new)
	} else {
		s = strings.Replace(s, old, new, 1)
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("edited %s (%d replacement(s))", path, map[bool]int{true: n, false: 1}[replaceAll]), nil
}
