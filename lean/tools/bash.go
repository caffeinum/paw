// Package tools runs the engine's canonical tools: a persistent shell, file read/write/edit and a
// codex-format patch applier. Model-facing names and argument shapes live in package toolmap.
package tools

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Shell is ONE long-lived bash: cwd, exported variables and functions persist between calls the
// way they do in Claude Code's Bash tool. Each command is written to a script file and sourced,
// followed by a sentinel line carrying its exit status. On a timeout the whole process group is
// killed and a fresh shell started in the last known cwd (state other than cwd is lost; the result
// says so).
type Shell struct {
	mu      sync.Mutex
	cwd     string
	tmp     string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	out     *bufio.Reader
	dead    chan struct{}
	MaxOut  int
	Default time.Duration
}

func NewShell(cwd string) (*Shell, error) {
	tmp, err := os.MkdirTemp("", "lean-sh-")
	if err != nil {
		return nil, err
	}
	s := &Shell{cwd: cwd, tmp: tmp, MaxOut: 30000, Default: 2 * time.Minute}
	return s, s.start()
}

func (s *Shell) start() error {
	cmd := exec.Command("/bin/bash", "--noprofile", "--norc")
	cmd.Dir = s.cwd
	cmd.Env = append(os.Environ(), "PS1=", "PS2=", "TERM=dumb", "GIT_PAGER=cat", "PAGER=cat")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = pw, pw
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	pw.Close()
	s.cmd, s.stdin, s.out = cmd, in, bufio.NewReaderSize(pr, 64<<10)
	s.dead = make(chan struct{})
	go func() { cmd.Wait(); pr.Close(); close(s.dead) }()
	return nil
}

func (s *Shell) restart() error {
	if s.cmd != nil && s.cmd.Process != nil {
		syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
		<-s.dead
	}
	return s.start()
}

type BashResult struct {
	Output   string
	ExitCode int
	Duration time.Duration
	TimedOut bool
	Note     string // e.g. the shell was restarted
}

func token() string {
	var b [8]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Run executes one command in the persistent shell.
func (s *Shell) Run(command, workdir string, timeout time.Duration) (BashResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if timeout <= 0 {
		timeout = s.Default
	}
	select {
	case <-s.dead:
		if err := s.start(); err != nil {
			return BashResult{}, err
		}
	default:
	}
	mark := "__LEAN_DONE_" + token()
	script := filepath.Join(s.tmp, "cmd.sh")
	body := command
	if workdir != "" {
		body = "cd " + strconv.Quote(workdir) + " || return 1\n" + command
	}
	if err := os.WriteFile(script, []byte(body+"\n"), 0o600); err != nil {
		return BashResult{}, err
	}
	// `. script` keeps cwd/env changes; the trailing pwd tracks cwd for a restart after a kill.
	line := fmt.Sprintf(". %s </dev/null 2>&1; __lean_rc=$?; printf '\\n%s %%d %%s\\n' \"$__lean_rc\" \"$PWD\"\n", strconv.Quote(script), mark)
	start := time.Now()
	if _, err := io.WriteString(s.stdin, line); err != nil {
		return BashResult{}, err
	}
	type res struct {
		out string
		rc  int
		err error
	}
	done := make(chan res, 1)
	rd := s.out
	go func() {
		var b strings.Builder
		for {
			l, err := rd.ReadString('\n')
			if strings.HasPrefix(l, mark+" ") {
				f := strings.SplitN(strings.TrimSpace(strings.TrimPrefix(l, mark+" ")), " ", 2)
				rc, _ := strconv.Atoi(f[0])
				if len(f) == 2 {
					s.cwd = f[1]
				}
				done <- res{out: strings.TrimRight(b.String(), "\n"), rc: rc}
				return
			}
			b.WriteString(l)
			if err != nil {
				done <- res{out: b.String(), rc: -1, err: err}
				return
			}
		}
	}()
	select {
	case r := <-done:
		out := clip(r.out, s.MaxOut)
		if r.err != nil {
			// the command ended the shell (exit, exec …): start a fresh one for the next call
			if err := s.restart(); err != nil {
				return BashResult{}, err
			}
			return BashResult{Output: out, ExitCode: -1, Duration: time.Since(start), Note: "the shell exited during this command; a fresh shell was started in " + s.cwd}, nil
		}
		return BashResult{Output: out, ExitCode: r.rc, Duration: time.Since(start)}, nil
	case <-time.After(timeout):
		if err := s.restart(); err != nil {
			return BashResult{}, err
		}
		<-done
		return BashResult{ExitCode: -1, Duration: time.Since(start), TimedOut: true,
			Note: fmt.Sprintf("timed out after %s; the shell was killed and restarted in %s (variables/functions were lost)", timeout, s.cwd)}, nil
	}
}

func (s *Shell) Cwd() string { return s.cwd }

func (s *Shell) Close() error {
	defer os.RemoveAll(s.tmp)
	if s.cmd == nil || s.cmd.Process == nil {
		return nil
	}
	syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	select {
	case <-s.dead:
	case <-time.After(2 * time.Second):
		return errors.New("shell did not exit")
	}
	return nil
}

// clip keeps the head and tail of an oversized output.
func clip(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	h := max * 2 / 3
	t := max - h
	return s[:h] + fmt.Sprintf("\n… [%d bytes omitted] …\n", len(s)-max) + s[len(s)-t:]
}
