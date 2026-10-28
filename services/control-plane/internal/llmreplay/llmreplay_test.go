package llmreplay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func post(t *testing.T, s *Server, path, body string) (int, string) {
	t.Helper()
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	return rr.Code, rr.Body.String()
}

func TestServe(t *testing.T) {
	s := New([]Rule{
		{Match: "canned", Reply: "the canned reply"},
		{Match: "act", Tool: &ToolCall{Name: "do_it", Args: map[string]any{"x": 1}}},
	})
	tests := []struct {
		name, path, body string
		want             []string
	}{
		{"openai default", "/v1/chat/completions", `{"messages":[{"role":"user","content":"hello"}]}`, []string{`"fixture: hello"`, `"prompt_tokens"`, `"finish_reason":"stop"`}},
		{"openai rule", "/v1/chat/completions", `{"messages":[{"role":"user","content":"a canned one"}]}`, []string{"the canned reply"}},
		{"openai tool", "/v1/chat/completions", `{"tools":[{}],"messages":[{"role":"user","content":"act now"}]}`, []string{`"tool_calls"`, `call_fixture_do_it`, `\"x\":1`}},
		{"openai tool without tools declared", "/v1/chat/completions", `{"messages":[{"role":"user","content":"act now"}]}`, []string{"fixture: act now"}},
		{"openai tool result ends loop", "/v1/chat/completions", `{"tools":[{}],"messages":[{"role":"user","content":"act"},{"role":"tool","content":"done!"}]}`, []string{"fixture: tool result: done!"}},
		{"openai stream", "/v1/chat/completions", `{"stream":true,"messages":[{"role":"user","content":"hi there"}]}`, []string{"data: [DONE]", `"usage"`}},
		{"anthropic default", "/v1/messages", `{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`, []string{"fixture: hello", `"input_tokens"`, "end_turn"}},
		{"anthropic tool", "/v1/messages", `{"tools":[{}],"messages":[{"role":"user","content":"act"}]}`, []string{`"tool_use"`, `toolu_fixture_do_it`}},
		{"anthropic tool result ends loop", "/v1/messages", `{"tools":[{}],"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}]}`, []string{"fixture: tool result: ok"}},
		{"anthropic stream", "/v1/messages", `{"stream":true,"messages":[{"role":"user","content":"yo"}]}`, []string{"event: message_start", "event: message_stop", `"output_tokens"`}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			code, body := post(t, s, tc.path, tc.body)
			if code != 200 {
				t.Fatalf("status %d: %s", code, body)
			}
			for _, w := range tc.want {
				if !strings.Contains(body, w) {
					t.Errorf("body missing %q:\n%s", w, body)
				}
			}
		})
	}
	if code, _ := post(t, s, "/v1/nope", `{}`); code != 404 {
		t.Errorf("unknown path = %d, want 404", code)
	}
	if code, _ := post(t, s, "/v1/messages", `not json`); code != 400 {
		t.Errorf("bad json = %d, want 400", code)
	}
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/__requests", nil))
	if !strings.Contains(rr.Body.String(), "/v1/chat/completions") {
		t.Errorf("/__requests = %s", rr.Body.String())
	}
}

func TestLoadRules(t *testing.T) {
	write := func(content string) string {
		p := filepath.Join(t.TempDir(), "rules.json")
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if r, err := LoadRules(write(`[{"match":"a","reply":"b"},{"match":"c","tool":{"name":"t"}}]`)); err != nil || len(r) != 2 {
		t.Fatalf("valid: %v %v", r, err)
	}
	for name, content := range map[string]string{
		"bad json": `{`,
		"no match": `[{"reply":"b"}]`,
		"both":     `[{"match":"a","reply":"b","tool":{"name":"t"}}]`,
		"neither":  `[{"match":"a"}]`,
	} {
		if _, err := LoadRules(write(content)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if _, err := LoadRules("/nonexistent/rules.json"); err == nil {
		t.Error("missing file: want error")
	}
}

func TestEmbeddings_DeterministicAndSimilar(t *testing.T) {
	s := New(nil)
	vec := func(text string) []float64 {
		code, body := post(t, s, "/v1/embeddings", `{"model":"text-embedding-3-small","input":`+strconv.Quote(text)+`}`)
		if code != 200 {
			t.Fatalf("status %d: %s", code, body)
		}
		var out struct {
			Data []struct {
				Embedding []float64 `json:"embedding"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &out); err != nil || len(out.Data) != 1 || len(out.Data[0].Embedding) != 1536 {
			t.Fatalf("want one 1536-d vector, got %v (%v)", len(out.Data), err)
		}
		return out.Data[0].Embedding
	}
	dot := func(a, b []float64) (d float64) {
		for i := range a {
			d += a[i] * b[i]
		}
		return d
	}
	q := vec("How do I reset my password?")
	if again := vec("How do I reset my password?"); dot(q, again) < 0.999 {
		t.Error("embedding is not deterministic")
	}
	near := dot(q, vec("To reset your password, open Settings and choose Reset password."))
	far := dot(q, vec("Invoices are issued on the first day of every month."))
	if !(near > 0.3 && far < 0.05) {
		t.Errorf("similarity near=%.2f far=%.2f, want near>0.3 and far<0.05", near, far)
	}
}
