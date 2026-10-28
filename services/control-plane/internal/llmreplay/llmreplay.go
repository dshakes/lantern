// Package llmreplay is a deterministic fixture LLM server speaking the OpenAI
// chat-completions and Anthropic messages wire formats (JSON and SSE, text and
// tool calls). With LANTERN_LLM_BASEURL_{OPENAI,ANTHROPIC} pointed at it, CI and
// kiosk mode get repeatable model output and realistic usage counts with no
// provider key.
//
// Reply policy, per request:
//   - last message is a tool result  -> "fixture: tool result: <first 60 chars>"
//     (so a scripted tool loop always terminates)
//   - else first rule whose Match is a substring of the system prompt or the last
//     user text wins (OpenAI system-role messages, Anthropic top-level `system`):
//     Reply -> that text; Tool -> a tool call (only when the request declares tools)
//   - else "fixture: <first 60 chars of last user text>".
//
// Token usage is len/4 (min 1) of the request body / reply, so budgets and cost
// metering still run.
package llmreplay

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

// Rule maps a user-text substring to a canned reply or a tool call.
type Rule struct {
	Match string    `json:"match"`
	Reply string    `json:"reply,omitempty"`
	Tool  *ToolCall `json:"tool,omitempty"`
}

// ToolCall is a scripted tool invocation.
type ToolCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args,omitempty"`
}

// Request is one recorded call (credentials are never stored).
type Request struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Body    string `json:"body"`
	HasAuth bool   `json:"hasAuth"`
	Status  int    `json:"status"`
}

// Server is the fixture http.Handler.
type Server struct {
	rules []Rule
	mu    sync.Mutex
	reqs  []Request
}

// New returns a server with the given rules (may be nil).
func New(rules []Rule) *Server { return &Server{rules: rules} }

// LoadRules reads a JSON rule file: [{"match": "...", "reply": "..."} | {"match": "...", "tool": {...}}].
func LoadRules(path string) ([]Rule, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read llm-replay rules %s: %w", path, err)
	}
	var rules []Rule
	if err := json.Unmarshal(b, &rules); err != nil {
		return nil, fmt.Errorf("parse llm-replay rules %s: %w", path, err)
	}
	for i, r := range rules {
		if r.Match == "" || (r.Reply == "") == (r.Tool == nil) {
			return nil, fmt.Errorf("llm-replay rules %s: rule %d needs a match and exactly one of reply/tool", path, i)
		}
	}
	return rules, nil
}

// Requests returns the recorded calls, oldest first.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.reqs...)
}

type decision struct {
	text string
	tool *ToolCall
}

func (s *Server) decide(lastUser, system string, isToolResult, hasTools bool) decision {
	if isToolResult {
		return decision{text: "fixture: tool result: " + clip(lastUser)}
	}
	for _, r := range s.rules {
		if strings.Contains(system, r.Match) || strings.Contains(lastUser, r.Match) {
			if r.Tool != nil && hasTools {
				return decision{tool: r.Tool}
			}
			if r.Reply != "" {
				return decision{text: r.Reply}
			}
			break
		}
	}
	return decision{text: "fixture: " + clip(lastUser)}
}

func clip(s string) string {
	if r := []rune(s); len(r) > 60 {
		return string(r[:60])
	}
	return s
}

func tokens(n int) int {
	if n/4 < 1 {
		return 1
	}
	return n / 4
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/__requests" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Requests())
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
		w.WriteHeader(http.StatusOK)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	status := http.StatusOK
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
		s.openai(w, body)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/messages":
		s.anthropic(w, body)
	default:
		status = http.StatusNotFound
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `{"error":"llm-replay: no fixture for %s %s"}`, r.Method, r.URL.Path)
	}
	s.mu.Lock()
	s.reqs = append(s.reqs, Request{
		Method: r.Method, Path: r.URL.Path, Body: string(body), Status: status,
		HasAuth: r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "",
	})
	s.mu.Unlock()
}

// text extracts plain text from a string-or-content-blocks field.
func text(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type    string          `json:"type"`
		Text    string          `json:"text"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "tool_result" {
			parts = append(parts, text(b.Content))
		} else {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, " ")
}

func sse(w http.ResponseWriter, event string, v any) {
	b, _ := json.Marshal(v)
	if event != "" {
		_, _ = fmt.Fprintf(w, "event: %s\n", event)
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func argsJSON(t *ToolCall) string {
	a := t.Args
	if a == nil {
		a = map[string]any{}
	}
	b, _ := json.Marshal(a)
	return string(b)
}

func (s *Server) openai(w http.ResponseWriter, body []byte) {
	var req struct {
		Model    string `json:"model"`
		Stream   bool   `json:"stream"`
		Tools    []any  `json:"tools"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":{"message":"invalid json"}}`, http.StatusBadRequest)
		return
	}
	var last, lastUser string
	var lastRole string
	var sys []string
	for _, m := range req.Messages {
		t := text(m.Content)
		lastRole, last = m.Role, t
		if m.Role == "user" {
			lastUser = t
		} else if m.Role == "system" || m.Role == "developer" {
			sys = append(sys, t)
		}
	}
	d := s.decide(lastUser, strings.Join(sys, "\n"), false, len(req.Tools) > 0)
	if lastRole == "tool" {
		d = s.decide(last, "", true, false)
	}
	in := tokens(len(body))
	out := tokens(len(d.text))
	if d.tool != nil {
		out = tokens(len(argsJSON(d.tool)) + len(d.tool.Name))
	}
	usage := map[string]any{"prompt_tokens": in, "completion_tokens": out, "total_tokens": in + out}
	finish := "stop"
	var toolCalls []map[string]any
	if d.tool != nil {
		finish = "tool_calls"
		toolCalls = []map[string]any{{"index": 0, "id": "call_fixture_" + d.tool.Name, "type": "function",
			"function": map[string]any{"name": d.tool.Name, "arguments": argsJSON(d.tool)}}}
	}
	if !req.Stream {
		msg := map[string]any{"role": "assistant", "content": d.text}
		if toolCalls != nil {
			msg["content"], msg["tool_calls"] = nil, toolCalls
		}
		writeJSON(w, map[string]any{"id": "chatcmpl-fixture", "object": "chat.completion", "model": req.Model,
			"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": finish}}, "usage": usage})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	chunk := func(delta map[string]any, fr any) map[string]any {
		return map[string]any{"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "model": req.Model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": fr}}}
	}
	sse(w, "", chunk(map[string]any{"role": "assistant"}, nil))
	if toolCalls != nil {
		sse(w, "", chunk(map[string]any{"tool_calls": toolCalls}, nil))
	} else {
		for _, p := range strings.SplitAfter(d.text, " ") {
			sse(w, "", chunk(map[string]any{"content": p}, nil))
		}
	}
	sse(w, "", chunk(map[string]any{}, finish))
	sse(w, "", map[string]any{"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "model": req.Model,
		"choices": []any{}, "usage": usage})
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
}

func (s *Server) anthropic(w http.ResponseWriter, body []byte) {
	var req struct {
		Model    string          `json:"model"`
		Stream   bool            `json:"stream"`
		Tools    []any           `json:"tools"`
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"type":"error","error":{"type":"invalid_request_error","message":"invalid json"}}`, http.StatusBadRequest)
		return
	}
	var last string
	isResult := false
	if n := len(req.Messages); n > 0 {
		last = text(req.Messages[n-1].Content)
		isResult = strings.Contains(string(req.Messages[n-1].Content), `"tool_result"`)
	}
	d := s.decide(last, text(req.System), isResult, len(req.Tools) > 0)
	in := tokens(len(body))
	out := tokens(len(d.text))
	var content []map[string]any
	stop := "end_turn"
	if d.tool != nil {
		out = tokens(len(argsJSON(d.tool)) + len(d.tool.Name))
		stop = "tool_use"
		in2 := d.tool.Args
		if in2 == nil {
			in2 = map[string]any{}
		}
		content = []map[string]any{{"type": "tool_use", "id": "toolu_fixture_" + d.tool.Name, "name": d.tool.Name, "input": in2}}
	} else {
		content = []map[string]any{{"type": "text", "text": d.text}}
	}
	if !req.Stream {
		writeJSON(w, map[string]any{"id": "msg_fixture", "type": "message", "role": "assistant", "model": req.Model,
			"content": content, "stop_reason": stop, "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": in, "output_tokens": out}})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	sse(w, "message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "msg_fixture", "type": "message", "role": "assistant", "model": req.Model, "content": []any{},
		"stop_reason": nil, "usage": map[string]any{"input_tokens": in, "output_tokens": 1}}})
	if d.tool != nil {
		sse(w, "content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{
			"type": "tool_use", "id": content[0]["id"], "name": d.tool.Name, "input": map[string]any{}}})
		sse(w, "content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": argsJSON(d.tool)}})
	} else {
		sse(w, "content_block_start", map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""}})
		for _, p := range strings.SplitAfter(d.text, " ") {
			sse(w, "content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
				"delta": map[string]any{"type": "text_delta", "text": p}})
		}
	}
	sse(w, "content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	sse(w, "message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop},
		"usage": map[string]any{"output_tokens": out}})
	sse(w, "message_stop", map[string]any{"type": "message_stop"})
}
