package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"paw/lean/auth"
	"paw/lean/conv"
	"paw/lean/toolmap"
)

// OpenAI drives the ChatGPT-plan codex backend (https://chatgpt.com/backend-api/codex/responses):
// the Responses API wire format, authenticated with the subscription's OAuth bearer plus the
// ChatGPT account id — the path codex CLI itself uses. Requests are stateless (store:false), so
// reasoning is carried forward as encrypted_content items replayed on the next call.
type OpenAI struct {
	ModelID string
	Effort  string // reasoning effort: low | medium | high
	Auth    *auth.Source
	URL     string
	Map     toolmap.Mapper
	Client  *http.Client
}

func NewOpenAI(model, effort string, src *auth.Source) *OpenAI {
	return &OpenAI{ModelID: model, Effort: effort, Auth: src, URL: "https://chatgpt.com/backend-api/codex/responses", Map: toolmap.Codex{}, Client: http.DefaultClient}
}

func (p *OpenAI) Name() string  { return "openai" }
func (p *OpenAI) Model() string { return p.ModelID }

func (p *OpenAI) input(items []item) []any {
	var out []any
	var cur map[string]any
	for _, it := range items {
		if it.kind == "text" {
			ct := "input_text"
			if it.role == conv.Assistant {
				ct = "output_text"
			}
			if cur != nil && cur["role"] == string(it.role) {
				cur["content"] = append(cur["content"].([]any), map[string]any{"type": ct, "text": it.text})
				continue
			}
			cur = map[string]any{"type": "message", "role": string(it.role), "content": []any{map[string]any{"type": ct, "text": it.text}}}
			out = append(out, cur)
			continue
		}
		cur = nil
		switch it.kind {
		case "call":
			if it.freeform {
				out = append(out, map[string]any{"type": "custom_tool_call", "call_id": it.callID, "name": it.name, "input": it.args})
			} else {
				out = append(out, map[string]any{"type": "function_call", "call_id": it.callID, "name": it.name, "arguments": it.args})
			}
		case "result":
			typ := "function_call_output"
			if it.freeform {
				typ = "custom_tool_call_output"
			}
			out = append(out, map[string]any{"type": typ, "call_id": it.callID, "output": it.text})
		case "reasoning":
			var r map[string]any
			if json.Unmarshal(it.opaque, &r) == nil {
				delete(r, "id") // stateless (store:false): item ids don't resolve server-side
				out = append(out, r)
			}
		}
	}
	return out
}

func (p *OpenAI) tools(enabled []string) []any {
	var out []any
	for _, s := range p.Map.Specs(enabled) {
		if s.Grammar != "" {
			out = append(out, map[string]any{"type": "custom", "name": s.Name, "description": s.Description, "format": map[string]any{"type": "grammar", "syntax": "lark", "definition": s.Grammar}})
		} else {
			out = append(out, map[string]any{"type": "function", "name": s.Name, "description": s.Description, "parameters": s.Params, "strict": false})
		}
	}
	return out
}

func (p *OpenAI) Turn(ctx context.Context, req Request, onText func(string)) (conv.Message, error) {
	tok, err := p.Auth.Token(ctx)
	if err != nil {
		return conv.Message{}, err
	}
	if tok.AccountID == "" {
		return conv.Message{}, errors.New("openai: the login carries no ChatGPT account id")
	}
	body := map[string]any{
		"model": p.ModelID, "instructions": req.System, "input": p.input(history(req.Messages, p.Map, p.Name())),
		"tools": p.tools(req.Tools), "tool_choice": "auto", "parallel_tool_calls": true,
		"store": false, "stream": true, "include": []string{"reasoning.encrypted_content"},
		"prompt_cache_key": req.CacheKey,
	}
	if p.Effort != "" {
		body["reasoning"] = map[string]any{"effort": p.Effort}
	}
	b, _ := json.Marshal(body)
	hr, _ := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(b))
	hr.Header.Set("content-type", "application/json")
	hr.Header.Set("accept", "text/event-stream")
	hr.Header.Set("authorization", "Bearer "+tok.Access)
	hr.Header.Set("chatgpt-account-id", tok.AccountID)
	hr.Header.Set("OpenAI-Beta", "responses=experimental")
	hr.Header.Set("originator", "paw_lean")
	hr.Header.Set("session_id", req.CacheKey)
	res, err := p.Client.Do(hr)
	if err != nil {
		return conv.Message{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return conv.Message{}, httpError(res)
	}
	msg := conv.Message{Role: conv.Assistant}
	info := &conv.TurnInfo{Provider: p.Name(), Model: p.ModelID}
	done := false
	truncated := false
	err = readSSE(res.Body, func(data []byte) error {
		var ev struct {
			Type     string          `json:"type"`
			Delta    string          `json:"delta"`
			Item     json.RawMessage `json:"item"`
			Response *struct {
				ID                string `json:"id"`
				Model             string `json:"model"`
				Status            string `json:"status"`
				IncompleteDetails *struct {
					Reason string `json:"reason"`
				} `json:"incomplete_details"`
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
				Usage *struct {
					InputTokens        int `json:"input_tokens"`
					OutputTokens       int `json:"output_tokens"`
					InputTokensDetails struct {
						CachedTokens int `json:"cached_tokens"`
					} `json:"input_tokens_details"`
					OutputTokensDetails struct {
						ReasoningTokens int `json:"reasoning_tokens"`
					} `json:"output_tokens_details"`
				} `json:"usage"`
			} `json:"response"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(data, &ev); err != nil {
			return fmt.Errorf("openai: undecodable stream event: %w", err)
		}
		switch ev.Type {
		case "response.output_text.delta":
			if onText != nil {
				onText(ev.Delta)
			}
		case "response.output_item.done":
			var it struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
				Input     string `json:"input"`
				Content   []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			if err := json.Unmarshal(ev.Item, &it); err != nil {
				return err
			}
			switch it.Type {
			case "message":
				for _, c := range it.Content {
					if c.Type == "output_text" && c.Text != "" {
						msg.Blocks = append(msg.Blocks, conv.TextBlock(c.Text))
					}
				}
			case "function_call":
				msg.Blocks = append(msg.Blocks, decodeCall(p.Map, it.CallID, it.Name, it.Arguments))
			case "custom_tool_call":
				msg.Blocks = append(msg.Blocks, decodeCall(p.Map, it.CallID, it.Name, it.Input))
			case "reasoning":
				msg.Blocks = append(msg.Blocks, conv.Block{Kind: conv.Reasoning, Provider: p.Name(), Opaque: append(json.RawMessage(nil), ev.Item...)})
			}
		case "response.completed", "response.incomplete":
			done = true
			if r := ev.Response; r != nil {
				info.ResponseID = r.ID
				if r.Model != "" {
					info.Model = r.Model
				}
				if r.IncompleteDetails != nil {
					truncated = true
				}
				if u := r.Usage; u != nil {
					info.Usage = conv.Usage{Input: u.InputTokens, CacheRead: u.InputTokensDetails.CachedTokens, Output: u.OutputTokens, Reasoning: u.OutputTokensDetails.ReasoningTokens}
				}
			}
		case "response.failed":
			if ev.Response != nil && ev.Response.Error != nil {
				return fmt.Errorf("openai: response failed: %s", ev.Response.Error.Message)
			}
			return fmt.Errorf("openai: response failed: %s", data)
		case "error":
			return fmt.Errorf("openai: stream error: %s", data)
		}
		return nil
	})
	if err != nil {
		return conv.Message{}, err
	}
	if !done {
		return conv.Message{}, errors.New("openai: stream ended without response.completed")
	}
	info.StopReason = stopReason(msg.Blocks, truncated)
	msg.Turn = info
	return msg, nil
}
