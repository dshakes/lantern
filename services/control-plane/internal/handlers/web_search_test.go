package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebSearchToolInCatalogAndReadOnly(t *testing.T) {
	// The tool must survive the contact-path read-only filter.
	tools := []map[string]any{webSearchTool()}
	kept := filterReadOnlyTools(tools)
	if len(kept) != 1 {
		t.Fatalf("web_search must pass filterReadOnlyTools, got %d tools", len(kept))
	}
	fn, _ := kept[0]["function"].(map[string]any)
	if fn["name"] != "web_search" {
		t.Fatalf("unexpected tool name %v", fn["name"])
	}
}

func TestExecuteWebSearchTool(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "test-key")

	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "test-key" {
			t.Errorf("missing api key header")
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"content":[
			{"type":"server_tool_use","id":"tu1","name":"web_search","input":{}},
			{"type":"web_search_tool_result","tool_use_id":"tu1","content":[]},
			{"type":"text","text":"FFT3990 diverted to CVG, new ETA 4:12pm."}
		]}`))
	}))
	defer srv.Close()
	origURL := anthropicWebSearchURL
	anthropicWebSearchURL = srv.URL
	defer func() { anthropicWebSearchURL = origURL }()

	res, err := executeWebSearchTool(context.Background(), nil, "t1", map[string]any{"query": "FFT3990 status"})
	if err != nil {
		t.Fatalf("executeWebSearchTool: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok || m["ok"] != true {
		t.Fatalf("unexpected result %v", res)
	}
	if !strings.Contains(m["summary"].(string), "CVG") {
		t.Fatalf("summary missing search text: %v", m["summary"])
	}

	// Request must carry the server-side web_search tool + the query.
	toolsAny, _ := gotBody["tools"].([]any)
	if len(toolsAny) != 1 {
		t.Fatalf("expected 1 server tool, got %v", gotBody["tools"])
	}
	st, _ := toolsAny[0].(map[string]any)
	if st["type"] != "web_search_20260209" {
		t.Fatalf("wrong server tool type %v", st["type"])
	}

	// Empty query errors.
	if _, err := executeWebSearchTool(context.Background(), nil, "t1", map[string]any{}); err == nil {
		t.Fatal("empty query must error")
	}
}

func TestExecuteWebSearchToolOpenAIFallback(t *testing.T) {
	// No Anthropic key → falls back to OpenAI's search-preview path.
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "oai-key")

	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer oai-key" {
			t.Errorf("missing bearer token")
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"FFT3990 landed CVG 4:12pm per FlightAware."}}]}`))
	}))
	defer srv.Close()
	origURL := openaiWebSearchURL
	openaiWebSearchURL = srv.URL
	defer func() { openaiWebSearchURL = origURL }()

	res, err := executeWebSearchTool(context.Background(), nil, "t1", map[string]any{"query": "FFT3990 status"})
	if err != nil {
		t.Fatalf("executeWebSearchTool (openai fallback): %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok || m["ok"] != true || !strings.Contains(m["summary"].(string), "CVG") {
		t.Fatalf("unexpected result %v", res)
	}
	if _, hasOpts := gotBody["web_search_options"]; !hasOpts {
		t.Fatalf("request must carry web_search_options: %v", gotBody)
	}

	// Neither provider configured → clean unavailable error.
	t.Setenv("OPENAI_API_KEY", "")
	if _, err := executeWebSearchTool(context.Background(), nil, "t1", map[string]any{"query": "x"}); err == nil {
		t.Fatal("no keys must error")
	}
}

func TestExecuteWebSearchTool_ReportsUsage(t *testing.T) {
	cases := []struct {
		name            string
		anthropic       bool
		body            string
		wantIn, wantOut int64
	}{
		{"anthropic", true, `{"content":[{"type":"text","text":"x"}],"usage":{"input_tokens":120,"output_tokens":45}}`, 120, 45},
		{"openai", false, `{"choices":[{"message":{"content":"x"}}],"usage":{"prompt_tokens":80,"completion_tokens":20}}`, 80, 20},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.anthropic {
				t.Setenv("ANTHROPIC_API_KEY", "k")
			} else {
				t.Setenv("ANTHROPIC_API_KEY", "")
				t.Setenv("OPENAI_API_KEY", "k")
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			oa, oo := anthropicWebSearchURL, openaiWebSearchURL
			anthropicWebSearchURL, openaiWebSearchURL = srv.URL, srv.URL
			defer func() { anthropicWebSearchURL, openaiWebSearchURL = oa, oo }()

			ctx, tu := withToolUsage(context.Background())
			if _, err := executeWebSearchTool(ctx, nil, "t1", map[string]any{"query": "q"}); err != nil {
				t.Fatal(err)
			}
			in, out, _ := tu.totals()
			if in != tc.wantIn || out != tc.wantOut {
				t.Fatalf("usage=%d/%d want %d/%d", in, out, tc.wantIn, tc.wantOut)
			}
		})
	}
}

// Tool spend must be priced at the tool's own provider/model: a web_search on
// Anthropic Sonnet inside a cheap gpt-4o-mini loop must not be billed at
// gpt-4o-mini rates.
func TestToolUsage_PricedAtToolModel(t *testing.T) {
	ctx, tu := withToolUsage(context.Background())
	if ctx2, tu2 := withToolUsage(ctx); tu2 != tu || ctx2 != ctx {
		t.Fatal("nested withToolUsage must share the caller's accumulator")
	}
	addToolUsage(ctx, "anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000)
	in, out, cost := tu.addTo("openai", "gpt-4o-mini", 1_000_000, 0)
	if in != 2_000_000 || out != 1_000_000 {
		t.Fatalf("tokens = %d/%d, want 2000000/1000000", in, out)
	}
	want := 0.15 + 3.00 + 15.00 // outer mini input + sonnet in/out
	if cost < want-1e-9 || cost > want+1e-9 {
		t.Fatalf("cost = %v, want %v (tool priced at its own model)", cost, want)
	}
}

// The tool loop returns only its own provider tokens; tool spend reaches the
// caller through the accumulator (so it is not double counted or mispriced).
func TestCallLLMWithTools_ToolSpendStaysOnAccumulator(t *testing.T) {
	reply := func(msg map[string]any) func(*http.Request) (*http.Response, error) {
		return func(*http.Request) (*http.Response, error) {
			b, _ := json.Marshal(map[string]any{
				"choices": []any{map[string]any{"message": msg}},
				"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 1},
			})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b)), Header: http.Header{}}, nil
		}
	}
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
		reply(map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
			"id": "c1", "type": "function", "function": map[string]any{"name": "web_search", "arguments": "{}"}}}}),
		reply(map[string]any{"role": "assistant", "content": "done"}),
	}}
	h := newTestProxyWithStub(t, stub)
	ctx, tu := withToolUsage(context.Background())
	_, _, tin, tout, err := h.callLLMWithTools(ctx, "openai", "gpt-4o-mini", "k",
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		func(ctx context.Context, _ string, _ map[string]any) (any, error) {
			addToolUsage(ctx, "anthropic", "claude-sonnet-4-6", 500, 50)
			return "r", nil
		}, nil, 4)
	if err != nil {
		t.Fatal(err)
	}
	if tin != 20 || tout != 2 {
		t.Errorf("loop tokens = %d/%d, want 20/2 (outer calls only)", tin, tout)
	}
	if in, out, cost := tu.totals(); in != 500 || out != 50 || cost != estimateCost("anthropic", "claude-sonnet-4-6", 500, 50) {
		t.Errorf("accumulator = %d/%d $%v", in, out, cost)
	}
}
