// Package session is the SessionLoader layer: an agent's conversation lives on disk in some
// harness's native transcript format, and a Store turns it into the neutral conv model and
// writes the harness's own turns back in that same format, so the original harness can resume
// the session afterwards.
//
// Implemented: Claude Code JSONL (claude.go). The interface is shaped so a Codex rollout store
// (~/.codex/sessions/…/rollout-*.jsonl: response_item lines carrying Responses-API items) or a
// Grok/opencode store slots in without touching the engine: each only has to map its records to
// and from conv.Message and record compactions in its own way.
package session

import "paw/lean/conv"

type Meta struct {
	Format    string // "claude-code"
	Path      string
	SessionID string
	Cwd       string
}

// Store is one agent's conversation on disk.
type Store interface {
	// Load returns the MODEL-VISIBLE context: what the native harness itself would send on resume
	// (for Claude Code: from the last compaction boundary on, with its preserved tail).
	Load() ([]conv.Message, error)
	// Append writes messages produced by this harness, in order, chained after the current leaf.
	// A user message of plain text is a prompt; a user message of tool results answers the
	// preceding assistant message's calls.
	Append(msgs ...conv.Message) error
	// Compact records that everything before now is replaced by summary for the model.
	Compact(summary string, preTokens int) error
	Meta() Meta
	// Close releases the single-writer lock.
	Close() error
}
