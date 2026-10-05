package session

// Claude Code session JSONL: a port of scripts/lean/session.ts (verified against claude 2.1.289,
// docs/notes/lean-harness.md#session-format) plus a tail reader and the neutral mapping.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"paw/lean/conv"
)

type rawRec = map[string]any

func str(r rawRec, k string) string   { s, _ := r[k].(string); return s }
func boolean(r rawRec, k string) bool { b, _ := r[k].(bool); return b }
func obj(v any) rawRec                { m, _ := v.(map[string]any); return m }

var chainTypes = map[string]bool{"user": true, "assistant": true, "attachment": true, "system": true}

// TailThreshold: transcripts bigger than this are read from the last compaction boundary only.
var TailThreshold int64 = 8 << 20

type Claude struct {
	path     string
	lock     string
	meta     Meta
	version  string
	branch   string
	parent   string // leaf uuid the next record chains to
	lastAsst string
	promptID string
}

// OpenClaude opens a Claude Code transcript for reading and appending. It takes a single-writer
// lock (<path>.lean.lock) and refuses a transcript a live claude process holds.
func OpenClaude(path string) (*Claude, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := refuseLiveClaude(abs); err != nil {
		return nil, err
	}
	lock := abs + ".lean.lock"
	if err := takeLock(lock); err != nil {
		return nil, err
	}
	return &Claude{path: abs, lock: lock, meta: Meta{Format: "claude-code", Path: abs}}, nil
}

func (c *Claude) Meta() Meta   { return c.meta }
func (c *Claude) Close() error { return os.Remove(c.lock) }

// ---- reading ---------------------------------------------------------------------------------

func parseLines(data []byte, path string, lineBase int) ([]rawRec, error) {
	var out []rawRec
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 512<<20)
	n := lineBase
	for sc.Scan() {
		n++
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var r rawRec
		if err := json.Unmarshal(line, &r); err != nil {
			return nil, fmt.Errorf("%s:%d: not JSON — refusing to continue a corrupt transcript", path, n)
		}
		out = append(out, r)
	}
	return out, sc.Err()
}

// lastBoundaryOffset scans the file backwards for the last main-thread compact_boundary line and
// returns its byte offset, or -1.
func lastBoundaryOffset(f *os.File, size int64) (int64, error) {
	needle := []byte(`"subtype":"compact_boundary"`)
	const chunk = 4 << 20
	end := size
	var carry []byte
	for end > 0 {
		start := end - chunk
		if start < 0 {
			start = 0
		}
		buf := make([]byte, end-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return -1, err
		}
		buf = append(buf, carry...)
		for i := bytes.LastIndex(buf, needle); i >= 0; i = bytes.LastIndex(buf[:i], needle) {
			ls := bytes.LastIndexByte(buf[:i], '\n')
			if ls < 0 && start > 0 {
				break // line starts in an earlier chunk; carry handles it
			}
			le := bytes.IndexByte(buf[i:], '\n')
			line := buf[ls+1:]
			if le >= 0 {
				line = buf[ls+1 : i+le]
			}
			var r rawRec
			if json.Unmarshal(line, &r) == nil && str(r, "type") == "system" && str(r, "subtype") == "compact_boundary" && !boolean(r, "isSidechain") {
				return start + int64(ls+1), nil
			}
		}
		// keep the partial first line so a boundary straddling the chunk edge is still found
		if nl := bytes.IndexByte(buf, '\n'); nl >= 0 {
			carry = append([]byte(nil), buf[:nl]...)
		} else {
			carry = buf
		}
		end = start
	}
	return -1, nil
}

func (c *Claude) readRecords(full bool) ([]rawRec, error) {
	f, err := os.Open(c.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if full || st.Size() < TailThreshold {
		data, err := io.ReadAll(f)
		if err != nil {
			return nil, err
		}
		return parseLines(data, c.path, 0)
	}
	off, err := lastBoundaryOffset(f, st.Size())
	if err != nil {
		return nil, err
	}
	if off < 0 {
		return c.readRecords(true)
	}
	tail := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(tail, off); err != nil && err != io.EOF {
		return nil, err
	}
	recs, err := parseLines(tail, c.path, -1)
	if err != nil {
		return nil, err
	}
	// a partial compaction keeps pre-boundary records verbatim: fetch exactly those
	pres := preserved(recs[0])
	if pres == nil {
		return recs, nil
	}
	want := map[string]bool{}
	for _, u := range pres.uuids {
		want[u] = true
	}
	var kept []rawRec
	sc := bufio.NewScanner(io.NewSectionReader(f, 0, off))
	sc.Buffer(make([]byte, 1<<20), 512<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte(`"uuid"`)) {
			continue
		}
		var r rawRec
		if json.Unmarshal(line, &r) == nil && want[str(r, "uuid")] {
			kept = append(kept, r)
		}
	}
	return append(kept, recs...), sc.Err()
}

type preservedSet struct {
	anchor string
	uuids  []string
}

func preserved(r rawRec) *preservedSet {
	if str(r, "subtype") != "compact_boundary" {
		return nil
	}
	pm := obj(obj(r["compactMetadata"])["preservedMessages"])
	if pm == nil {
		return nil
	}
	list, _ := pm["uuids"].([]any)
	if len(list) == 0 {
		return nil
	}
	p := &preservedSet{anchor: str(pm, "anchorUuid")}
	for _, u := range list {
		p.uuids = append(p.uuids, fmt.Sprint(u))
	}
	return p
}

func leafOf(recs []rawRec) (rawRec, error) {
	for i := len(recs) - 1; i >= 0; i-- {
		r := recs[i]
		if chainTypes[str(r, "type")] && str(r, "uuid") != "" && !boolean(r, "isSidechain") {
			return r, nil
		}
	}
	return nil, errors.New("transcript has no main-thread chain record to continue from")
}

func msgID(r rawRec) string { return str(obj(r["message"]), "id") }

func isToolResultRecord(r rawRec) bool {
	if str(r, "type") != "user" {
		return false
	}
	blocks, ok := obj(r["message"])["content"].([]any)
	if !ok {
		return false
	}
	for _, b := range blocks {
		if str(obj(b), "type") == "tool_result" {
			return true
		}
	}
	return false
}

var errDangling = errors.New("dangling parentUuid")

// activeChain walks parentUuid from the leaf to the root of the active segment (a
// compact_boundary has parentUuid null), reassembles parallel tool calls, and splices a partial
// compaction's preserved tail right after its anchor.
func activeChain(recs []rawRec, leaf rawRec) ([]rawRec, error) {
	byID := map[string]rawRec{}
	for _, r := range recs {
		if u := str(r, "uuid"); u != "" {
			byID[u] = r
		}
	}
	var chain []rawRec
	seen := map[string]bool{}
	for r := leaf; r != nil; {
		u := str(r, "uuid")
		if seen[u] {
			return nil, fmt.Errorf("parentUuid cycle at %s", u)
		}
		seen[u] = true
		chain = append(chain, r)
		p := str(r, "parentUuid")
		if p == "" {
			break
		}
		next, ok := byID[p]
		if !ok {
			return nil, fmt.Errorf("%w %s under %s", errDangling, p, u)
		}
		r = next
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	chain = expandParallel(recs, chain)
	if len(chain) > 0 {
		if p := preserved(chain[0]); p != nil {
			at := -1
			for i, r := range chain {
				if str(r, "uuid") == p.anchor {
					at = i
				}
			}
			if at == -1 {
				return nil, fmt.Errorf("compact anchor %s is not on the active chain", p.anchor)
			}
			var kept []rawRec
			for _, u := range p.uuids {
				r, ok := byID[u]
				if !ok {
					return nil, fmt.Errorf("preserved message %s is missing from the transcript", u)
				}
				kept = append(kept, r)
			}
			chain = append(chain[:at+1], append(kept, chain[at+1:]...)...)
		}
	}
	return chain, nil
}

// expandParallel: claude writes one assistant record per tool_use (same message.id) and each result
// as a child of its own tool_use record, so the walk sees one branch. Emit the whole message.
func expandParallel(recs []rawRec, chain []rawRec) []rawRec {
	order := map[string]int{}
	byMsg := map[string][]rawRec{}
	resultsOf := map[string][]rawRec{}
	for i, r := range recs {
		u := str(r, "uuid")
		if u == "" || boolean(r, "isSidechain") {
			continue
		}
		order[u] = i
		if str(r, "type") == "assistant" && msgID(r) != "" {
			byMsg[msgID(r)] = append(byMsg[msgID(r)], r)
		}
		if isToolResultRecord(r) && str(r, "parentUuid") != "" {
			resultsOf[str(r, "parentUuid")] = append(resultsOf[str(r, "parentUuid")], r)
		}
	}
	var out []rawRec
	emitted := map[string]bool{}
	emittedMsg := map[string]bool{}
	for _, r := range chain {
		u := str(r, "uuid")
		if emitted[u] {
			continue
		}
		mid := ""
		if str(r, "type") == "assistant" {
			mid = msgID(r)
		}
		if mid == "" || len(byMsg[mid]) <= 1 {
			out = append(out, r)
			emitted[u] = true
			continue
		}
		if emittedMsg[mid] {
			continue
		}
		emittedMsg[mid] = true
		group := byMsg[mid]
		var results []rawRec
		for _, a := range group {
			results = append(results, resultsOf[str(a, "uuid")]...)
		}
		sortByOrder(results, order)
		for _, x := range append(append([]rawRec{}, group...), results...) {
			out = append(out, x)
			emitted[str(x, "uuid")] = true
		}
	}
	return out
}

func sortByOrder(rs []rawRec, order map[string]int) {
	for i := 1; i < len(rs); i++ {
		for j := i; j > 0 && order[str(rs[j], "uuid")] < order[str(rs[j-1], "uuid")]; j-- {
			rs[j], rs[j-1] = rs[j-1], rs[j]
		}
	}
}

// ---- chain → Messages-API messages (attachment placement as claude 2.1.289 does it) ----------

type apiMessage struct {
	role   string
	blocks []rawRec
}

type userItem struct {
	kind   string // user | attachment | barrier
	blocks []rawRec
	texts  []string
}

func asBlocks(content any) []rawRec {
	switch c := content.(type) {
	case string:
		return []rawRec{{"type": "text", "text": c}}
	case []any:
		out := make([]rawRec, 0, len(c))
		for _, b := range c {
			if m := obj(b); m != nil {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func attachmentTexts(r rawRec) []string {
	var out []string
	rendered, _ := r["rendered"].([]any)
	for _, p := range rendered {
		switch c := obj(p)["content"].(type) {
		case string:
			out = append(out, c)
		case nil:
		default:
			b, _ := json.Marshal(c)
			out = append(out, string(b))
		}
	}
	return out
}

func userMessage(items []userItem) apiMessage {
	var placed []userItem
	anchor := -1
	for _, it := range items {
		switch it.kind {
		case "barrier":
			anchor = len(placed) - 1
		case "attachment":
			if len(it.texts) > 0 {
				anchor++
				placed = append(placed[:anchor], append([]userItem{it}, placed[anchor:]...)...)
			}
		default:
			placed = append(placed, it)
			for _, b := range it.blocks {
				if str(b, "type") == "tool_result" {
					anchor = len(placed) - 1
					break
				}
			}
		}
	}
	var content []rawRec
	for _, it := range placed {
		if it.kind == "user" {
			for _, b := range it.blocks {
				cp := rawRec{}
				for k, v := range b {
					cp[k] = v
				}
				content = append(content, cp)
			}
			continue
		}
		if n := len(content); n > 0 && str(content[n-1], "type") == "tool_result" {
			text := strings.Join(it.texts, "\n\n")
			last := content[n-1]
			switch c := last["content"].(type) {
			case string:
				if c == "" {
					last["content"] = text
				} else {
					last["content"] = c + "\n\n" + text
				}
			case nil:
				last["content"] = text
			case []any:
				last["content"] = append(c, map[string]any{"type": "text", "text": text})
			}
		} else {
			for _, t := range it.texts {
				content = append(content, rawRec{"type": "text", "text": t})
			}
		}
	}
	return apiMessage{role: "user", blocks: content}
}

func toAPIMessages(chain []rawRec) ([]apiMessage, error) {
	var out []apiMessage
	var pending []userItem
	lastAsst := ""
	flush := func() {
		if m := userMessage(pending); len(m.blocks) > 0 {
			out = append(out, m)
		}
		pending = nil
	}
	for _, r := range chain {
		switch str(r, "type") {
		case "assistant":
			m := obj(r["message"])
			if m == nil {
				continue
			}
			if boolean(r, "isApiErrorMessage") {
				pending = append(pending, userItem{kind: "barrier"})
				continue
			}
			blocks := asBlocks(m["content"])
			for _, b := range blocks {
				delete(b, "caller")
			}
			onlyResults := true
			for _, it := range pending {
				if it.kind == "attachment" {
					onlyResults = false
				}
				if it.kind == "user" {
					for _, b := range it.blocks {
						if str(b, "type") != "tool_result" {
							onlyResults = false
						}
					}
				}
			}
			id := str(m, "id")
			if n := len(out); id != "" && id == lastAsst && n > 0 && out[n-1].role == "assistant" && onlyResults {
				out[n-1].blocks = append(out[n-1].blocks, blocks...)
				continue
			}
			flush()
			out = append(out, apiMessage{role: "assistant", blocks: blocks})
			lastAsst = id
		case "user":
			pending = append(pending, userItem{kind: "user", blocks: asBlocks(obj(r["message"])["content"])})
		case "system":
			if str(r, "subtype") == "local_command" {
				if s, ok := r["content"].(string); ok {
					pending = append(pending, userItem{kind: "user", blocks: []rawRec{{"type": "text", "text": s}}})
				}
			}
		case "attachment":
			pending = append(pending, userItem{kind: "attachment", texts: attachmentTexts(r)})
		}
	}
	flush()
	if len(out) == 0 || out[0].role != "user" {
		return nil, errors.New("reconstructed conversation does not start with a user message")
	}
	return out, nil
}

// ---- Claude tool names ↔ canonical ------------------------------------------------------------

// claudeName is how each canonical tool is recorded in a Claude transcript. apply_patch has no
// Claude Code equivalent and is recorded under its own name (claude --resume replays it as an
// unknown historical tool call, which the API accepts).
var claudeName = map[string]string{
	conv.ToolBash: "Bash", conv.ToolRead: "Read", conv.ToolWrite: "Write", conv.ToolEdit: "Edit",
	conv.ToolApplyPatch: "apply_patch", conv.ToolCotalDM: "mcp__cotal__cotal_dm",
	conv.ToolCotalSend: "mcp__cotal__cotal_send", conv.ToolCotalRoster: "mcp__cotal__cotal_roster",
}

func canonicalFromClaude(name string, in rawRec) (tool string, input json.RawMessage) {
	s := func(k string) string { return str(in, k) }
	n := func(k string) int { f, _ := in[k].(float64); return int(f) }
	switch {
	case name == "Bash":
		return conv.ToolBash, conv.MustJSON(conv.BashInput{Command: s("command"), TimeoutMs: n("timeout")})
	case name == "Read":
		return conv.ToolRead, conv.MustJSON(conv.ReadInput{Path: s("file_path"), Offset: n("offset"), Limit: n("limit")})
	case name == "Write":
		return conv.ToolWrite, conv.MustJSON(conv.WriteInput{Path: s("file_path"), Content: s("content")})
	case name == "Edit":
		ra, _ := in["replace_all"].(bool)
		return conv.ToolEdit, conv.MustJSON(conv.EditInput{Path: s("file_path"), OldString: s("old_string"), NewString: s("new_string"), ReplaceAll: ra})
	case name == "apply_patch":
		return conv.ToolApplyPatch, conv.MustJSON(conv.ApplyPatchInput{Patch: s("patch")})
	case strings.HasSuffix(name, "__cotal_dm"):
		return conv.ToolCotalDM, conv.MustJSON(conv.CotalDMInput{To: s("to"), Text: s("text")})
	case strings.HasSuffix(name, "__cotal_send"):
		return conv.ToolCotalSend, conv.MustJSON(conv.CotalSendInput{Channel: s("channel"), Text: s("text")})
	case strings.HasSuffix(name, "__cotal_roster"):
		return conv.ToolCotalRoster, json.RawMessage(`{}`)
	}
	raw, _ := json.Marshal(in)
	return "", raw
}

func claudeInput(b conv.Block) (string, any, error) {
	if b.Tool == "" {
		var v any
		if err := json.Unmarshal(b.Input, &v); err != nil {
			return "", nil, err
		}
		return b.Foreign, v, nil
	}
	name, ok := claudeName[b.Tool]
	if !ok {
		return "", nil, fmt.Errorf("no Claude Code name for canonical tool %q", b.Tool)
	}
	switch b.Tool {
	case conv.ToolBash:
		var in conv.BashInput
		if err := json.Unmarshal(b.Input, &in); err != nil {
			return "", nil, err
		}
		out := map[string]any{"command": in.Command}
		if in.TimeoutMs > 0 {
			out["timeout"] = in.TimeoutMs
		}
		return name, out, nil
	case conv.ToolRead:
		var in conv.ReadInput
		if err := json.Unmarshal(b.Input, &in); err != nil {
			return "", nil, err
		}
		out := map[string]any{"file_path": in.Path}
		if in.Offset > 0 {
			out["offset"] = in.Offset
		}
		if in.Limit > 0 {
			out["limit"] = in.Limit
		}
		return name, out, nil
	case conv.ToolWrite:
		var in conv.WriteInput
		if err := json.Unmarshal(b.Input, &in); err != nil {
			return "", nil, err
		}
		return name, map[string]any{"file_path": in.Path, "content": in.Content}, nil
	case conv.ToolEdit:
		var in conv.EditInput
		if err := json.Unmarshal(b.Input, &in); err != nil {
			return "", nil, err
		}
		out := map[string]any{"file_path": in.Path, "old_string": in.OldString, "new_string": in.NewString}
		if in.ReplaceAll {
			out["replace_all"] = true
		}
		return name, out, nil
	}
	var v any
	if err := json.Unmarshal(b.Input, &v); err != nil {
		return "", nil, err
	}
	return name, v, nil
}

// ---- API messages → neutral ------------------------------------------------------------------

func flattenResult(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, p := range v {
			pb := obj(p)
			switch str(pb, "type") {
			case "text":
				parts = append(parts, str(pb, "text"))
			case "image":
				parts = append(parts, "[image omitted]")
			default:
				b, _ := json.Marshal(pb)
				parts = append(parts, string(b))
			}
		}
		return strings.Join(parts, "\n")
	case nil:
		return ""
	}
	b, _ := json.Marshal(c)
	return string(b)
}

func toNeutral(msgs []apiMessage) []conv.Message {
	out := make([]conv.Message, 0, len(msgs))
	for _, m := range msgs {
		nm := conv.Message{Role: conv.Role(m.role)}
		for _, b := range m.blocks {
			switch t := str(b, "type"); t {
			case "text":
				if s := str(b, "text"); s != "" {
					nm.Blocks = append(nm.Blocks, conv.TextBlock(s))
				}
			case "tool_use":
				tool, input := canonicalFromClaude(str(b, "name"), obj(b["input"]))
				blk := conv.Block{Kind: conv.ToolCall, CallID: str(b, "id"), Tool: tool, Input: input}
				if tool == "" {
					blk.Foreign = str(b, "name")
				}
				nm.Blocks = append(nm.Blocks, blk)
			case "tool_result":
				nm.Blocks = append(nm.Blocks, conv.Block{Kind: conv.ToolResult, CallID: str(b, "tool_use_id"), Text: flattenResult(b["content"]), IsError: boolean(b, "is_error")})
			case "thinking", "redacted_thinking":
				raw, _ := json.Marshal(b)
				nm.Blocks = append(nm.Blocks, conv.Block{Kind: conv.Reasoning, Provider: "anthropic", Opaque: raw})
			case "image":
				nm.Blocks = append(nm.Blocks, conv.TextBlock("[image omitted]"))
			case "document":
				nm.Blocks = append(nm.Blocks, conv.TextBlock("[document omitted]"))
			default: // server tools (web_search …): keep what happened as text
				raw, _ := json.Marshal(b)
				s := string(raw)
				if len(s) > 4000 {
					s = s[:4000] + "…"
				}
				nm.Blocks = append(nm.Blocks, conv.TextBlock(fmt.Sprintf("[%s] %s", t, s)))
			}
		}
		if len(nm.Blocks) > 0 {
			out = append(out, nm)
		}
	}
	return out
}

// Load reads the transcript's active context and positions the writer on its leaf.
func (c *Claude) Load() ([]conv.Message, error) {
	recs, err := c.readRecords(false)
	if err != nil {
		return nil, err
	}
	leaf, err := leafOf(recs)
	if err != nil {
		return nil, err
	}
	chain, err := activeChain(recs, leaf)
	if errors.Is(err, errDangling) {
		// the tail read cut a link (a record after the boundary pointing before it): read it all
		if recs, err = c.readRecords(true); err != nil {
			return nil, err
		}
		if leaf, err = leafOf(recs); err != nil {
			return nil, err
		}
		chain, err = activeChain(recs, leaf)
	}
	if err != nil {
		return nil, err
	}
	for _, r := range chain {
		if str(r, "sessionId") != "" && str(r, "cwd") != "" {
			c.meta.SessionID, c.meta.Cwd, c.branch = str(r, "sessionId"), str(r, "cwd"), str(r, "gitBranch")
			break
		}
	}
	if c.meta.SessionID == "" {
		return nil, fmt.Errorf("%s: no record carries sessionId + cwd", c.path)
	}
	for i := len(recs) - 1; i >= 0; i-- {
		if v := str(recs[i], "version"); v != "" {
			c.version = v
			break
		}
	}
	if c.version == "" {
		return nil, fmt.Errorf("%s: no record carries a claude version", c.path)
	}
	c.parent = str(leaf, "uuid")
	api, err := toAPIMessages(chain)
	if err != nil {
		return nil, err
	}
	return toNeutral(api), nil
}

// ---- writing ---------------------------------------------------------------------------------

func uuid4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

var unsafeID = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// toolID makes a provider's call id acceptable as an Anthropic tool_use id.
func toolID(id string) string { return unsafeID.ReplaceAllString(id, "_") }

func (c *Claude) envelope(typ string) rawRec {
	return rawRec{
		"parentUuid": c.parent, "isSidechain": false, "type": typ, "uuid": uuid4(),
		"timestamp": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "userType": "external",
		"entrypoint": "sdk-cli", "cwd": c.meta.Cwd, "sessionId": c.meta.SessionID,
		"version": c.version, "gitBranch": c.branch,
	}
}

func (c *Claude) write(recs ...rawRec) error {
	var buf bytes.Buffer
	for _, r := range recs {
		b, err := json.Marshal(r)
		if err != nil {
			return err
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	f, err := os.OpenFile(c.path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func (c *Claude) Append(msgs ...conv.Message) error {
	if c.parent == "" {
		return errors.New("Append before Load: the writer has no leaf to chain to")
	}
	for _, m := range msgs {
		var r rawRec
		switch {
		case m.Role == conv.Assistant:
			r = c.envelope("assistant")
			var content []any
			for _, b := range m.Blocks {
				switch b.Kind {
				case conv.Text:
					content = append(content, map[string]any{"type": "text", "text": b.Text})
				case conv.ToolCall:
					name, in, err := claudeInput(b)
					if err != nil {
						return err
					}
					content = append(content, map[string]any{"type": "tool_use", "id": toolID(b.CallID), "name": name, "input": in})
				case conv.Reasoning: // provider-private; Claude can't replay another model's reasoning
				}
			}
			t := m.Turn
			if t == nil {
				return errors.New("assistant message without TurnInfo: the store needs model + usage")
			}
			stop := t.StopReason
			r["requestId"] = t.ResponseID
			r["message"] = map[string]any{
				"id": "msg_lean_" + strings.ReplaceAll(uuid4(), "-", ""), "type": "message", "role": "assistant",
				"model": t.Model, "content": content, "stop_reason": stop, "stop_sequence": nil,
				"usage": map[string]any{"input_tokens": t.Usage.Input - t.Usage.CacheRead, "cache_read_input_tokens": t.Usage.CacheRead, "cache_creation_input_tokens": 0, "output_tokens": t.Usage.Output},
			}
			c.lastAsst = r["uuid"].(string)
		case hasResults(m):
			r = c.envelope("user")
			var content []any
			var raw []string
			for _, b := range m.Blocks {
				if b.Kind != conv.ToolResult {
					continue
				}
				content = append(content, map[string]any{"type": "tool_result", "tool_use_id": toolID(b.CallID), "content": b.Text, "is_error": b.IsError})
				raw = append(raw, b.Text)
			}
			r["promptId"] = c.promptID
			r["message"] = map[string]any{"role": "user", "content": content}
			if len(raw) == 1 {
				r["toolUseResult"] = raw[0]
			} else {
				r["toolUseResult"] = raw
			}
			r["sourceToolAssistantUUID"] = c.lastAsst
		default:
			c.promptID = uuid4()
			r = c.envelope("user")
			r["promptId"] = c.promptID
			r["message"] = map[string]any{"role": "user", "content": m.PlainText()}
		}
		if err := c.write(r); err != nil {
			return err
		}
		c.parent = r["uuid"].(string)
		if m.Role == conv.User && !hasResults(m) {
			if err := c.write(rawRec{"type": "last-prompt", "lastPrompt": trunc(m.PlainText(), 200), "leafUuid": c.parent, "sessionId": c.meta.SessionID}); err != nil {
				return err
			}
		}
	}
	return nil
}

func hasResults(m conv.Message) bool {
	for _, b := range m.Blocks {
		if b.Kind == conv.ToolResult {
			return true
		}
	}
	return false
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// Compact writes a compact_boundary (parentUuid null, the old leaf kept as logicalParentUuid) and
// the summary as an isCompactSummary user record — the shape claude itself writes, so both
// claude --resume and this harness start from the summary afterwards.
func (c *Claude) Compact(summary string, preTokens int) error {
	b := c.envelope("system")
	b["parentUuid"] = nil
	b["logicalParentUuid"] = c.parent
	b["subtype"] = "compact_boundary"
	b["content"] = "Conversation compacted"
	b["level"] = "info"
	b["compactMetadata"] = map[string]any{"trigger": "auto", "preTokens": preTokens}
	if err := c.write(b); err != nil {
		return err
	}
	c.parent = b["uuid"].(string)
	s := c.envelope("user")
	s["promptId"] = uuid4()
	s["message"] = map[string]any{"role": "user", "content": conv.CompactPreamble + summary}
	s["isVisibleInTranscriptOnly"] = true
	s["isCompactSummary"] = true
	if err := c.write(s); err != nil {
		return err
	}
	c.parent = s["uuid"].(string)
	return nil
}

// ---- single writer ---------------------------------------------------------------------------

func takeLock(path string) error {
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, werr := fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return werr
		}
		if !os.IsExist(err) {
			return err
		}
		b, _ := os.ReadFile(path)
		pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		if pid > 0 && syscall.Kill(pid, 0) == nil {
			return fmt.Errorf("transcript is held by lean pid %d (%s) — one writer per transcript", pid, path)
		}
		os.Remove(path) // dead holder
	}
	return fmt.Errorf("could not take %s", path)
}

// refuseLiveClaude: a transcript under the real ~/.claude/projects whose session a live claude
// process holds must not get a second writer (paw's two-writer guard, docs/notes/agents.md).
func refuseLiveClaude(abs string) error {
	home, _ := os.UserHomeDir()
	cfg := os.Getenv("CLAUDE_CONFIG_DIR")
	if cfg == "" {
		cfg = filepath.Join(home, ".claude")
	}
	if !strings.HasPrefix(abs, filepath.Join(cfg, "projects")+string(os.PathSeparator)) {
		return nil
	}
	sid := strings.TrimSuffix(filepath.Base(abs), ".jsonl")
	entries, _ := filepath.Glob(filepath.Join(cfg, "sessions", "*.json"))
	for _, e := range entries {
		b, err := os.ReadFile(e)
		if err != nil {
			continue
		}
		var s struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(b, &s) == nil && s.SessionID == sid && s.PID > 0 && syscall.Kill(s.PID, 0) == nil {
			return fmt.Errorf("session %s is held by a live claude (pid %d) — refusing a second writer", sid, s.PID)
		}
	}
	return nil
}
