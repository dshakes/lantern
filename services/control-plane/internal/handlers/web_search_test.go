package handlers

import (
	"context"
	"encoding/json"
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
	if st["type"] != "web_search_20250305" {
		t.Fatalf("wrong server tool type %v", st["type"])
	}

	// Empty query errors.
	if _, err := executeWebSearchTool(context.Background(), nil, "t1", map[string]any{}); err == nil {
		t.Fatal("empty query must error")
	}
}
