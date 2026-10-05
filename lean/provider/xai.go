package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"paw/lean/auth"
	"paw/lean/conv"
	"paw/lean/toolmap"
)

// XAI drives api.x.ai with a SuperGrok subscription's OAuth bearer (the device-flow login opencode
// and grok-cli use), over the OpenAI-compatible Chat Completions wire format: tool calls arrive
// as indexed fragments in the stream and are reassembled here; results go back as role:"tool"
// messages. Grok's reasoning_content is not replayable and is not kept.
type XAI struct {
	ModelID string
	Auth    *auth.Source
	URL     string
	Map     toolmap.Mapper
	Client  *http.Client
}

func NewXAI(model string, src *auth.Source) *XAI {
	return &XAI{ModelID: model, Auth: src, URL: "https://api.x.ai/v1/chat/completions", Map: toolmap.Grok{}, Client: http.DefaultClient}
}

func (p *XAI) Name() string  { return "xai" }
func (p *XAI) Model() string { return p.ModelID }

func (p *XAI) messages(system string, items []item) []any {
	out := []any{map[string]any{"role": "system", "content": system}}
	var asst map[string]any
	var user []string
	flushUser := func() {
		if len(user) > 0 {
			out = append(out, map[string]any{"role": "user", "content": strings.Join(user, "\n\n")})
			user = nil
		}
	}
	for _, it := range items {
		if it.role == conv.Assistant {
			flushUser()
			if asst == nil {
				asst = map[string]any{"role": "assistant", "content": ""}
				out = append(out, asst)
			}
			switch it.kind {
			case "text":
				if s := asst["content"].(string); s != "" {
					asst["content"] = s + "\n\n" + it.text
				} else {
					asst["content"] = it.text
				}
			case "call":
				tc, _ := asst["tool_calls"].([]any)
				asst["tool_calls"] = append(tc, map[string]any{"id": it.callID, "type": "function", "function": map[string]any{"name": it.name, "arguments": it.args}})
			}
			continue
		}
		asst = nil
		switch it.kind {
		case "text":
			user = append(user, it.text)
		case "result":
			flushUser()
			out = append(out, map[string]any{"role": "tool", "tool_call_id": it.callID, "content": it.text})
		}
	}
	flushUser()
	return out
}

func (p *XAI) Turn(ctx context.Context, req Request, onText func(string)) (conv.Message, error) {
	tok, err := p.Auth.Token(ctx)
	if err != nil {
		return conv.Message{}, err
	}
	var tools []any
	for _, s := range p.Map.Specs(req.Tools) {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": s.Name, "description": s.Description, "parameters": s.Params}})
	}
	body := map[string]any{
		"model": p.ModelID, "messages": p.messages(req.System, history(req.Messages, p.Map, p.Name())),
		"tools": tools, "tool_choice": "auto", "stream": true, "stream_options": map[string]any{"include_usage": true},
	}
	b, _ := json.Marshal(body)
	hr, _ := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(b))
	hr.Header.Set("content-type", "application/json")
	hr.Header.Set("authorization", "Bearer "+tok.Access)
	hr.Header.Set("x-grok-conv-id", req.CacheKey) // keeps one conversation on one prompt cache
	res, err := p.Client.Do(hr)
	if err != nil {
		return conv.Message{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return conv.Message{}, httpError(res)
	}
	type frag struct{ id, name, args strings.Builder }
	calls := map[int]*frag{}
	var text strings.Builder
	info := &conv.TurnInfo{Provider: p.Name(), Model: p.ModelID}
	finish := ""
	err = readSSE(res.Body, func(data []byte) error {
		var ch struct {
			ID      string `json:"id"`
			Model   string `json:"model"`
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens        int `json:"prompt_tokens"`
				CompletionTokens    int `json:"completion_tokens"`
				PromptTokensDetails struct {
					CachedTokens int `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
				CompletionTokensDetails struct {
					ReasoningTokens int `json:"reasoning_tokens"`
				} `json:"completion_tokens_details"`
			} `json:"usage"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(data, &ch); err != nil {
			return fmt.Errorf("xai: undecodable stream chunk: %w", err)
		}
		if ch.Error != nil {
			return fmt.Errorf("xai: stream error: %s", data)
		}
		if ch.ID != "" {
			info.ResponseID = ch.ID
		}
		if ch.Model != "" {
			info.Model = ch.Model
		}
		for _, c := range ch.Choices {
			if c.Delta.Content != "" {
				text.WriteString(c.Delta.Content)
				if onText != nil {
					onText(c.Delta.Content)
				}
			}
			for _, tc := range c.Delta.ToolCalls {
				f := calls[tc.Index]
				if f == nil {
					f = &frag{}
					calls[tc.Index] = f
				}
				f.id.WriteString(tc.ID)
				f.name.WriteString(tc.Function.Name)
				f.args.WriteString(tc.Function.Arguments)
			}
			if c.FinishReason != "" {
				finish = c.FinishReason
			}
		}
		if u := ch.Usage; u != nil {
			info.Usage = conv.Usage{Input: u.PromptTokens, CacheRead: u.PromptTokensDetails.CachedTokens, Output: u.CompletionTokens, Reasoning: u.CompletionTokensDetails.ReasoningTokens}
		}
		return nil
	})
	if err != nil {
		return conv.Message{}, err
	}
	if finish == "" {
		return conv.Message{}, fmt.Errorf("xai: stream ended without a finish_reason")
	}
	msg := conv.Message{Role: conv.Assistant}
	if s := strings.TrimSpace(text.String()); s != "" {
		msg.Blocks = append(msg.Blocks, conv.TextBlock(text.String()))
	}
	idx := make([]int, 0, len(calls))
	for i := range calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		f := calls[i]
		args := f.args.String()
		if args == "" {
			args = "{}"
		}
		msg.Blocks = append(msg.Blocks, decodeCall(p.Map, f.id.String(), f.name.String(), args))
	}
	info.StopReason = stopReason(msg.Blocks, finish == "length")
	msg.Turn = info
	return msg, nil
}
