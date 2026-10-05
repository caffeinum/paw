package main

import (
	"fmt"
	"os"

	"paw/lean/transport"
)

// localMesh stands in for the cotal transport in `lean once`: DMs and posts are printed.
type localMesh struct{ in chan *transport.Inbound }

func newLocalMesh() *localMesh { return &localMesh{in: make(chan *transport.Inbound, 1)} }

func (m *localMesh) inject(from, text string) *transport.Inbound {
	return transport.NewInbound("once-1", transport.Ref{ID: "local." + from, Name: from}, "", text)
}

func (m *localMesh) Inbox() <-chan *transport.Inbound { return m.in }
func (m *localMesh) SetStatus(string) error           { return nil }
func (m *localMesh) ID() string                       { return "local.lean-once" }
func (m *localMesh) Roster() []transport.Peer {
	return []transport.Peer{{ID: "local.you", Name: "you", Kind: "endpoint", Status: "idle"}}
}
func (m *localMesh) DM(to, text string) (transport.Ref, error) {
	fmt.Fprintf(os.Stdout, "── DM → %s ──\n%s\n", to, text)
	return transport.Ref{ID: "local." + to, Name: to}, nil
}
func (m *localMesh) Send(ch, text string) error {
	fmt.Fprintf(os.Stdout, "── #%s ──\n%s\n", ch, text)
	return nil
}
