package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestShellPersistsStateAndTimesOut(t *testing.T) {
	dir := t.TempDir()
	sh, err := NewShell(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sh.Close()
	if r, _ := sh.Run("export FOO=bar; mkdir -p sub; cd sub", "", 0); r.ExitCode != 0 {
		t.Fatalf("setup: %+v", r)
	}
	r, _ := sh.Run("echo $FOO; pwd; echo err >&2; false", "", 0)
	if !strings.Contains(r.Output, "bar") || !strings.Contains(r.Output, filepath.Join(dir, "sub")) || !strings.Contains(r.Output, "err") || r.ExitCode != 1 {
		t.Fatalf("state/exit not kept: %+v", r)
	}
	r, _ = sh.Run("sleep 5", "", 300*time.Millisecond)
	if !r.TimedOut {
		t.Fatalf("expected timeout: %+v", r)
	}
	r, _ = sh.Run("pwd", "", 0)
	if !strings.Contains(r.Output, "sub") {
		t.Fatalf("cwd not restored after restart: %+v", r)
	}
	r, _ = sh.Run("exit 3", "", 0)
	if r.Note == "" {
		t.Fatalf("exit should restart the shell: %+v", r)
	}
	if r, _ = sh.Run("echo alive", "", 0); r.Output != "alive" {
		t.Fatalf("shell not usable after exit: %+v", r)
	}
}

func TestApplyPatch(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644)
	out, err := ApplyPatch(dir, dir, `*** Begin Patch
*** Update File: a.txt
@@
 one
-two
+TWO
 three
*** Add File: b/new.txt
+hello
+world
*** End Patch`)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	b, _ := os.ReadFile(filepath.Join(dir, "b/new.txt"))
	if string(a) != "one\nTWO\nthree\n" || string(b) != "hello\nworld\n" || !strings.Contains(out, "M ") {
		t.Fatalf("got a=%q b=%q out=%q", a, b, out)
	}
	if _, err := ApplyPatch(dir, dir, "*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+x\n*** End Patch"); err == nil {
		t.Fatal("a non-matching hunk must fail")
	}
	if a2, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(a2) != string(a) {
		t.Fatal("a failed patch must not write")
	}
}

func TestConfinement(t *testing.T) {
	root := t.TempDir()
	if _, err := Resolve(root, root, "/etc/passwd"); err == nil {
		t.Fatal("absolute path outside root must be refused")
	}
	if _, err := Resolve(root, root, "../x"); err == nil {
		t.Fatal("relative escape must be refused")
	}
	if p, err := Resolve(root, root, "sub/new.txt"); err != nil || p != filepath.Join(root, "sub/new.txt") {
		t.Fatalf("inside path refused: %v", err)
	}
	if _, err := ApplyPatch(root, root, "*** Begin Patch\n*** Add File: /tmp/lean-escape.txt\n+x\n*** End Patch"); err == nil {
		t.Fatal("a patch outside root must be refused")
	}
}

func TestEditUniqueness(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	os.WriteFile(p, []byte("x x"), 0o644)
	if _, err := Edit(p, "x", "y", false); err == nil {
		t.Fatal("ambiguous edit must fail")
	}
	if _, err := Edit(p, "x", "y", true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "y y" {
		t.Fatalf("got %q", b)
	}
}
