// lean — a prototype single-agent harness: one process per agent, no TUI. It continues a Claude
// Code session with a non-Anthropic model on the operator's subscription and talks to the world
// only through the cotal mesh. See docs/notes/lean-harness-poc.md.
//
//	lean run   --session <transcript.jsonl> --cwd <dir> --name <agent> --space <space> --server <nats-url>
//	           --provider openai|xai|fake[:openai|:xai] [--model M] [--effort low|medium|high]
//	           [--channels general] [--state <dir>] [--compact-at <tokens>]
//	lean once  --session … --cwd … --provider … [--model M] "<prompt>"     (one turn, no mesh)
//	lean login openai|xai                                                    (device flow)
//	lean auth                                                                (where tokens come from)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"paw/lean/auth"
	"paw/lean/engine"
	"paw/lean/provider"
	"paw/lean/session"
	"paw/lean/toolmap"
	"paw/lean/tools"
	"paw/lean/transport"
)

func die(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "lean: "+f+"\n", a...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		die("usage: lean run|once|login|auth … (see cmd/lean/main.go)")
	}
	switch os.Args[1] {
	case "run", "once":
		run(os.Args[1], os.Args[2:])
	case "login":
		if len(os.Args) != 3 {
			die("usage: lean login openai|xai")
		}
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := auth.Login(ctx, auth.Home(), os.Args[2], func(s string) { fmt.Println(s) }); err != nil {
			die("%v", err)
		}
	case "auth":
		for _, l := range auth.Status(auth.Home()) {
			fmt.Println(l)
		}
	case "dump": // the neutral conversation as JSON (parity checks against scripts/lean/session.ts)
		if len(os.Args) != 3 {
			die("usage: lean dump <transcript.jsonl>")
		}
		store, err := session.OpenClaude(os.Args[2])
		if err != nil {
			die("%v", err)
		}
		msgs, err := store.Load()
		store.Close()
		if err != nil {
			die("%v", err)
		}
		if err := json.NewEncoder(os.Stdout).Encode(msgs); err != nil {
			die("%v", err)
		}
	default:
		die("unknown command %q", os.Args[1])
	}
}

func newProvider(spec, model, effort string) provider.Provider {
	name, family, _ := strings.Cut(spec, ":")
	switch name {
	case "openai":
		if model == "" {
			model = "gpt-5.6-terra"
		}
		return provider.NewOpenAI(model, effort, &auth.Source{Provider: "openai", Home: auth.Home()})
	case "xai":
		if model == "" {
			model = "grok-build-0.1"
		}
		return provider.NewXAI(model, &auth.Source{Provider: "xai", Home: auth.Home()})
	case "fake":
		if family == "" {
			family = "canonical"
		}
		m, err := toolmap.For(family)
		if err != nil {
			die("%v", err)
		}
		return &provider.Fake{Map: m}
	}
	die("unknown provider %q (openai | xai | fake[:openai|:xai])", spec)
	return nil
}

func run(mode string, args []string) {
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	sessionPath := fs.String("session", "", "Claude Code transcript (.jsonl) to continue — use a COPY, never a live agent's")
	cwd := fs.String("cwd", "", "working directory for the tools (required: never defaulted to the session's project dir)")
	name := fs.String("name", "", "agent name on the mesh")
	space := fs.String("space", os.Getenv("PAW_SPACE"), "cotal space")
	server := fs.String("server", os.Getenv("PAW_SERVER"), "NATS url of the mesh")
	prov := fs.String("provider", "", "openai | xai | fake[:openai|:xai]")
	model := fs.String("model", "", "model id")
	effort := fs.String("effort", "medium", "reasoning effort (openai)")
	channels := fs.String("channels", "general", "comma-separated channels to read")
	state := fs.String("state", "", "state dir (default <LEAN_HOME>/agents/<space>/<name>)")
	compactAt := fs.Int("compact-at", 180000, "compact when the context estimate passes this many tokens (0 = never)")
	fs.Parse(args)
	if *sessionPath == "" || *cwd == "" || *prov == "" {
		die("--session, --cwd and --provider are required")
	}
	if abs, err := filepath.Abs(*cwd); err == nil {
		*cwd = abs
	}
	if st, err := os.Stat(*cwd); err != nil || !st.IsDir() {
		die("--cwd %s is not a directory", *cwd)
	}
	store, err := session.OpenClaude(*sessionPath)
	if err != nil {
		die("%v", err)
	}
	defer store.Close()
	shell, err := tools.NewShell(*cwd)
	if err != nil {
		die("%v", err)
	}
	defer shell.Close()
	p := newProvider(*prov, *model, *effort)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if mode == "once" {
		prompt := strings.Join(fs.Args(), " ")
		if prompt == "" {
			die("once needs a prompt")
		}
		mesh := newLocalMesh()
		e, err := engine.New(engine.Config{Name: "lean-once", Space: "local", MaxSteps: 30, CompactAt: *compactAt, Root: *cwd, Log: os.Stderr}, store, p, mesh, shell)
		if err != nil {
			die("%v", err)
		}
		in := mesh.inject("you", prompt)
		if err := e.Turn(ctx, []*transport.Inbound{in}); err != nil {
			die("%v", err)
		}
		return
	}

	if *name == "" || *space == "" || *server == "" {
		die("run needs --name, --space and --server (or PAW_SPACE / PAW_SERVER)")
	}
	if *state == "" {
		*state = filepath.Join(auth.Home(), "agents", *space, *name)
	}
	var chans []string
	for _, c := range strings.Split(*channels, ",") {
		if c = strings.TrimSpace(c); c != "" {
			chans = append(chans, c)
		}
	}
	cctx, ccancel := context.WithTimeout(ctx, 20*time.Second)
	mesh, err := transport.Connect(cctx, transport.Config{
		Server: *server, Space: *space, Name: *name, Channels: chans, StateDir: *state,
		Meta: map[string]string{"connector": "lean", "provider": p.Name(), "model": p.Model()},
	})
	ccancel()
	if err != nil {
		die("%v", err)
	}
	e, err := engine.New(engine.Config{Name: *name, Space: *space, CompactAt: *compactAt, Root: *cwd, Coalesce: 300 * time.Millisecond, Log: os.Stderr}, store, p, mesh, shell)
	if err != nil {
		mesh.Close()
		die("%v", err)
	}
	fmt.Fprintf(os.Stderr, "[lean] %s on %s as %s (%s/%s), pid %d\n", *name, *space, mesh.ID(), p.Name(), p.Model(), os.Getpid())
	err = e.Run(ctx)
	if cerr := mesh.Close(); cerr != nil {
		fmt.Fprintf(os.Stderr, "[lean] close: %v\n", cerr)
	}
	if err != nil && err != context.Canceled {
		die("%v", err)
	}
}
