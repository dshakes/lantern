package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dshakes/lantern/services/control-plane/internal/llmreplay"
)

func TestCheckLLMBaseURLOverrides(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	tests := []struct {
		name      string
		prod      bool
		env       map[string]string
		wantFatal bool
		wantMsg   string
	}{
		{"prod unset", true, nil, false, ""},
		{"prod set", true, map[string]string{"LANTERN_LLM_BASEURL_OPENAI": "http://127.0.0.1:1"}, true, "LANTERN_LLM_BASEURL_OPENAI"},
		{"dev valid", false, map[string]string{"LANTERN_LLM_BASEURL_ANTHROPIC": "http://127.0.0.1:1"}, false, ""},
		{"dev malformed", false, map[string]string{"LANTERN_LLM_BASEURL_ANTHROPIC": "127.0.0.1:1"}, true, "malformed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fatal, msg := CheckLLMBaseURLOverrides(tc.prod, env(tc.env))
			if fatal != tc.wantFatal || !strings.Contains(msg, tc.wantMsg) {
				t.Fatalf("fatal=%v msg=%q, want fatal=%v containing %q", fatal, msg, tc.wantFatal, tc.wantMsg)
			}
		})
	}
}

func TestLLMBaseURLTransport(t *testing.T) {
	tests := []struct {
		name, env, url, wantHost string
	}{
		{"openai override", "", "https://api.openai.com/v1/chat/completions", "127.0.0.1:7"},
		{"anthropic override", "", "https://api.anthropic.com/v1/messages", "127.0.0.1:8"},
		{"other host untouched", "", "https://example.com/x", "example.com"},
		{"prod ignores override", "production", "https://api.openai.com/v1/chat/completions", "api.openai.com"},
	}
	t.Setenv("LANTERN_LLM_BASEURL_OPENAI", "http://127.0.0.1:7")
	t.Setenv("LANTERN_LLM_BASEURL_ANTHROPIC", "http://127.0.0.1:8")
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LANTERN_ENV", tc.env)
			c := &captureRT{}
			req, _ := http.NewRequest("POST", tc.url, nil)
			if _, err := (llmBaseURLTransport{next: c}).RoundTrip(req); err != nil {
				t.Fatal(err)
			}
			if c.host != tc.wantHost {
				t.Fatalf("host=%q want %q", c.host, tc.wantHost)
			}
			if req.URL.Host != strings.SplitN(tc.url, "/", 4)[2] {
				t.Fatal("original request was mutated")
			}
		})
	}
}

// fixtureLLM starts llm-replay and points both provider overrides at it.
func fixtureLLM(t *testing.T, rules []llmreplay.Rule) *llmreplay.Server {
	t.Helper()
	t.Setenv("LANTERN_ENV", "")
	fx := llmreplay.New(rules)
	ts := httptest.NewServer(fx)
	t.Cleanup(ts.Close)
	t.Setenv("LANTERN_LLM_BASEURL_OPENAI", ts.URL)
	t.Setenv("LANTERN_LLM_BASEURL_ANTHROPIC", ts.URL)
	t.Setenv("OPENAI_API_KEY", "sk-fixture")
	t.Setenv("ANTHROPIC_API_KEY", "")
	return fx
}

// POST /v1/completions end to end: handler -> failover -> OpenAI builder -> llm-replay.
func TestCompletions_ThroughFixtureLLM(t *testing.T) {
	fx := fixtureLLM(t, nil)
	h, _ := newLlmProxyTestHandler(t)
	rr := postCompletionHTTP(t, h, nil, devTenantID, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var resp completionResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Content != "fixture: hello" || resp.TokensIn <= 0 || resp.TokensOut <= 0 {
		t.Fatalf("resp = %+v, want fixture text and nonzero tokens", resp)
	}
	reqs := fx.Requests()
	if len(reqs) != 1 || reqs[0].Path != "/v1/chat/completions" || !reqs[0].HasAuth {
		t.Fatalf("recorded = %+v", reqs)
	}
}

// Streaming builders for both providers receive the fixture text and usage.
func TestStreaming_ThroughFixtureLLM(t *testing.T) {
	fixtureLLM(t, nil)
	h := &LlmProxyHandler{}
	for _, provider := range []string{"openai", "anthropic"} {
		t.Run(provider, func(t *testing.T) {
			full, in, out, err := h.callLLMStreamingNoTools(context.Background(), provider, "m", "k", "sys", "stream me please", nil)
			if err != nil {
				t.Fatal(err)
			}
			if full != "fixture: stream me please" || in <= 0 || out <= 0 {
				t.Fatalf("full=%q in=%d out=%d", full, in, out)
			}
		})
	}
}

// The session tool loop: scripted tool call -> dispatch -> tool result -> fixture text.
func TestToolLoop_ThroughFixtureLLM(t *testing.T) {
	rules := []llmreplay.Rule{{Match: "weather", Tool: &llmreplay.ToolCall{Name: "get_weather", Args: map[string]any{"city": "Austin"}}}}
	tools := []map[string]any{{"type": "function", "function": map[string]any{"name": "get_weather", "parameters": map[string]any{"type": "object"}}}}
	for _, provider := range []string{"openai", "anthropic"} {
		t.Run(provider, func(t *testing.T) {
			fx := fixtureLLM(t, rules)
			h := &LlmProxyHandler{}
			var gotName string
			var gotArgs map[string]any
			text, invs, in, out, err := h.callLLMWithTools(context.Background(), provider, "m", "k",
				[]map[string]any{{"role": "user", "content": "what is the weather"}}, tools,
				func(_ context.Context, name string, args map[string]any) (any, error) {
					gotName, gotArgs = name, args
					return map[string]any{"temp": "99F"}, nil
				}, nil, 4)
			if err != nil {
				t.Fatal(err)
			}
			if gotName != "get_weather" || gotArgs["city"] != "Austin" || len(invs) != 1 {
				t.Fatalf("dispatch name=%q args=%v invs=%d", gotName, gotArgs, len(invs))
			}
			if !strings.HasPrefix(text, "fixture: tool result:") || !strings.Contains(text, "99F") || in <= 0 || out <= 0 {
				t.Fatalf("text=%q in=%d out=%d", text, in, out)
			}
			if n := len(fx.Requests()); n != 2 {
				t.Fatalf("llm-replay saw %d requests, want 2 (call + follow-up)", n)
			}
		})
	}
}
