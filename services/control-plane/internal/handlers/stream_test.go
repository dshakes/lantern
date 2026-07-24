package handlers

// Tests for token-delta streaming through the control-plane.
//
// Coverage:
//   - callLLMStreamingMessages: OpenAI SSE delta parsing
//   - callLLMStreamingMessages: Anthropic SSE delta parsing
//   - completeSSE: ordered message_delta + message_completed named SSE events
//   - streamWithFailover: failover before first delta (provider 1 → 500 → provider 2 succeeds)
//   - streamWithFailover: error after first delta → message_error event
//   - writeSSEEvent: named-SSE wire format (event: X\ndata: Y\n\n)

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// rtFunc is an http.RoundTripper backed by a plain function.
type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// routeToServer returns a RoundTripper that sends every request to srv,
// regardless of the original URL. Used to intercept provider API calls.
func routeToServer(srv *httptest.Server) http.RoundTripper {
	return rtFunc(func(r *http.Request) (*http.Response, error) {
		cloned := r.Clone(r.Context())
		cloned.URL.Scheme = "http"
		cloned.URL.Host = strings.TrimPrefix(srv.URL, "http://")
		// Keep path/query so the stub server can differentiate providers.
		return http.DefaultTransport.RoundTrip(cloned)
	})
}

// openAISSEBody returns a fake OpenAI streaming response body with the given
// text chunks and usage counts. Format matches the openai /v1/chat/completions
// SSE spec parsed by callLLMStreamingMessages.
func openAISSEBody(chunks []string, tokensIn, tokensOut int) string {
	var sb strings.Builder
	for _, c := range chunks {
		payload, _ := json.Marshal(map[string]any{
			"choices": []any{map[string]any{
				"delta": map[string]any{"content": c},
			}},
		})
		fmt.Fprintf(&sb, "data: %s\n\n", payload)
	}
	// Usage sent on the last data event before [DONE].
	usage, _ := json.Marshal(map[string]any{
		"choices": []any{},
		"usage":   map[string]any{"prompt_tokens": tokensIn, "completion_tokens": tokensOut},
	})
	fmt.Fprintf(&sb, "data: %s\n\n", usage)
	fmt.Fprintf(&sb, "data: [DONE]\n\n")
	return sb.String()
}

// anthropicSSEBody returns a fake Anthropic streaming response body.
// Format matches the anthropic /v1/messages SSE spec parsed by callLLMStreamingMessages.
func anthropicSSEBody(chunks []string, tokensIn, tokensOut int) string {
	var sb strings.Builder
	// message_start with input token count
	start, _ := json.Marshal(map[string]any{
		"type":    "message_start",
		"message": map[string]any{"usage": map[string]any{"input_tokens": tokensIn, "output_tokens": 0}},
	})
	fmt.Fprintf(&sb, "data: %s\n\n", start)
	for _, c := range chunks {
		delta, _ := json.Marshal(map[string]any{
			"type": "content_block_delta",
			"delta": map[string]any{
				"type": "text_delta",
				"text": c,
			},
		})
		fmt.Fprintf(&sb, "data: %s\n\n", delta)
	}
	// message_delta with output token count
	msgDelta, _ := json.Marshal(map[string]any{
		"type":  "message_delta",
		"usage": map[string]any{"input_tokens": tokensIn, "output_tokens": tokensOut},
	})
	fmt.Fprintf(&sb, "data: %s\n\n", msgDelta)
	fmt.Fprintf(&sb, "data: %s\n\n", `{"type":"message_stop"}`)
	return sb.String()
}

// sseProxyHandler serves the given body with text/event-stream headers.
func sseProxyHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, body)
	})
}

// newStreamHandler builds a minimal LlmProxyHandler with an injected HTTP
// client. Pool is nil so resolveProviderKey falls back to env vars.
func newStreamHandler(client *http.Client) *LlmProxyHandler {
	logger, _ := zap.NewDevelopment()
	return &LlmProxyHandler{srv: &server.Server{Logger: logger}, httpClient: client}
}

// parseSSEEvents splits a text/event-stream body into (eventName, data) pairs.
// Unnamed events (no "event:" line) use "" as the event name.
func parseSSEEvents(body string) []struct{ name, data string } {
	var out []struct{ name, data string }
	var cur struct{ name, data string }
	scanner := bufio.NewScanner(strings.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			// blank line → dispatch this event
			if cur.data != "" || cur.name != "" {
				out = append(out, cur)
				cur = struct{ name, data string }{}
			}
			continue
		}
		if strings.HasPrefix(line, "event: ") {
			cur.name = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			cur.data = strings.TrimPrefix(line, "data: ")
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// callLLMStreamingMessages — OpenAI delta parsing
// ---------------------------------------------------------------------------

func TestCallLLMStreamingMessages_OpenAI(t *testing.T) {
	chunks := []string{"Hello", " ", "world"}
	ts := httptest.NewServer(sseProxyHandler(openAISSEBody(chunks, 10, 5)))
	defer ts.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	h := newStreamHandler(&http.Client{Transport: routeToServer(ts)})

	messages := []map[string]any{{"role": "user", "content": "hi"}}
	var got []string
	full, tin, tout, err := h.callLLMStreamingMessages(
		context.Background(), "openai", "gpt-4o", "test-key", messages,
		func(chunk string) { got = append(got, chunk) },
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if full != "Hello world" {
		t.Errorf("full text: got %q, want %q", full, "Hello world")
	}
	if strings.Join(got, "") != full {
		t.Errorf("onDelta chunks %v don't assemble to %q", got, full)
	}
	if tin != 10 || tout != 5 {
		t.Errorf("usage: got in=%d out=%d, want in=10 out=5", tin, tout)
	}
}

// ---------------------------------------------------------------------------
// callLLMStreamingMessages — Anthropic delta parsing
// ---------------------------------------------------------------------------

func TestCallLLMStreamingMessages_Anthropic(t *testing.T) {
	chunks := []string{"Hi", " there"}
	ts := httptest.NewServer(sseProxyHandler(anthropicSSEBody(chunks, 8, 3)))
	defer ts.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	h := newStreamHandler(&http.Client{Transport: routeToServer(ts)})

	messages := []map[string]any{
		{"role": "system", "content": "You help."},
		{"role": "user", "content": "yo"},
	}
	var got []string
	full, tin, tout, err := h.callLLMStreamingMessages(
		context.Background(), "anthropic", "claude-sonnet-4-20250514", "test-key", messages,
		func(chunk string) { got = append(got, chunk) },
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if full != "Hi there" {
		t.Errorf("full: got %q, want %q", full, "Hi there")
	}
	if strings.Join(got, "") != full {
		t.Errorf("delta chunks don't match full text")
	}
	if tin != 8 || tout != 3 {
		t.Errorf("usage: got in=%d out=%d, want in=8 out=3", tin, tout)
	}
}

// ---------------------------------------------------------------------------
// completeSSE — named SSE event ordering
// ---------------------------------------------------------------------------

func TestCompleteSSE_DeltasThenCompleted(t *testing.T) {
	// Fake OpenAI provider streaming "Hey" + " you"
	chunks := []string{"Hey", " you"}
	ts := httptest.NewServer(sseProxyHandler(openAISSEBody(chunks, 12, 4)))
	defer ts.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_API_KEY", "") // only OpenAI available

	h := newStreamHandler(&http.Client{Transport: routeToServer(ts)})

	req := &completionRequest{
		Messages: []completionMessage{{Role: "user", Content: "hey"}},
		Stream:   true,
	}
	w := httptest.NewRecorder()
	h.completeSSE(w, context.Background(), "tenant-test", req)

	events := parseSSEEvents(w.Body.String())

	// Expect: 2 × message_delta, then 1 × message_completed.
	// There may also be a single unnamed delta from fallback if usage-only events
	// are re-emitted; tolerate extra unnamed blank events.
	var deltas []struct{ name, data string }
	var completed struct{ name, data string }
	for _, ev := range events {
		switch ev.name {
		case "message_delta":
			deltas = append(deltas, ev)
		case "message_completed":
			completed = ev
		}
	}

	if len(deltas) != len(chunks) {
		t.Fatalf("expected %d message_delta events, got %d (all events: %v)",
			len(chunks), len(deltas), events)
	}

	// seq must be monotonically increasing 1, 2, ...
	for i, ev := range deltas {
		var payload struct {
			TurnID string `json:"turnId"`
			Seq    int    `json:"seq"`
			Delta  string `json:"delta"`
		}
		if err := json.Unmarshal([]byte(ev.data), &payload); err != nil {
			t.Fatalf("delta[%d] unmarshal: %v", i, err)
		}
		if payload.Seq != i+1 {
			t.Errorf("delta[%d] seq: got %d, want %d", i, payload.Seq, i+1)
		}
		if payload.Delta != chunks[i] {
			t.Errorf("delta[%d] text: got %q, want %q", i, payload.Delta, chunks[i])
		}
		if payload.TurnID == "" {
			t.Errorf("delta[%d] missing turnId", i)
		}
	}

	if completed.name == "" {
		t.Fatal("missing message_completed event")
	}
	var comp struct {
		TurnID string `json:"turnId"`
		Text   string `json:"text"`
		Usage  struct {
			TokensIn  int64   `json:"tokensIn"`
			TokensOut int64   `json:"tokensOut"`
			CostUsd   float64 `json:"costUsd"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(completed.data), &comp); err != nil {
		t.Fatalf("message_completed unmarshal: %v", err)
	}
	if comp.Text != "Hey you" {
		t.Errorf("completed text: got %q, want %q", comp.Text, "Hey you")
	}
	if comp.Usage.TokensIn != 12 || comp.Usage.TokensOut != 4 {
		t.Errorf("completed usage: in=%d out=%d, want in=12 out=4",
			comp.Usage.TokensIn, comp.Usage.TokensOut)
	}
	if comp.Usage.CostUsd <= 0 {
		t.Errorf("completed costUsd should be positive, got %v", comp.Usage.CostUsd)
	}
	// All deltas must share the same turnId as the completed event.
	turnIDs := make(map[string]bool)
	for _, ev := range deltas {
		var d struct {
			TurnID string `json:"turnId"`
		}
		_ = json.Unmarshal([]byte(ev.data), &d)
		turnIDs[d.TurnID] = true
	}
	if len(turnIDs) != 1 || !turnIDs[comp.TurnID] {
		t.Errorf("turnId mismatch: deltas have %v, completed has %q",
			turnIDs, comp.TurnID)
	}
}

// ---------------------------------------------------------------------------
// streamWithFailover — failover before first delta
// ---------------------------------------------------------------------------

func TestStreamWithFailover_BeforeFirstDelta(t *testing.T) {
	// First call → 500 (openai/gpt-4o). Second call → SSE (openai/gpt-4o-mini).
	// resolveCandidateChain with only openai returns [gpt-4o, gpt-4o-mini].
	var callN int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&callN, 1)
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, openAISSEBody([]string{"fallback"}, 5, 2))
	}))
	defer ts.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_API_KEY", "") // only OpenAI

	h := newStreamHandler(&http.Client{Transport: routeToServer(ts)})

	var deltas []string
	full, _, _, _, _, err := h.streamWithFailover(
		context.Background(), "tenant1",
		[]map[string]any{{"role": "user", "content": "hi"}},
		func(chunk string) { deltas = append(deltas, chunk) },
		nil,
		false,
	)
	if err != nil {
		t.Fatalf("expected success after failover, got error: %v", err)
	}
	if full != "fallback" {
		t.Errorf("full text: got %q, want %q", full, "fallback")
	}
	if len(deltas) == 0 {
		t.Error("expected at least one delta from the fallback provider")
	}
	if atomic.LoadInt32(&callN) < 2 {
		t.Errorf("expected at least 2 provider calls (fail + succeed), got %d", callN)
	}
}

// ---------------------------------------------------------------------------
// streamWithFailover — error after first delta → caller emits message_error
// ---------------------------------------------------------------------------

// halfThenErrorReader sends data then returns a non-EOF error on the next read.
// This triggers scanner.Err() != nil in callLLMStreamingMessages, returning an
// error even though some deltas were already emitted.
type halfThenErrorReader struct {
	data []byte
	sent bool
}

func (r *halfThenErrorReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		n := copy(p, r.data)
		return n, nil
	}
	return 0, errors.New("simulated mid-stream provider failure")
}
func (r *halfThenErrorReader) Close() error { return nil }

func TestCompleteSSE_ErrorAfterFirstDelta(t *testing.T) {
	// Provider returns one delta then the connection dies mid-stream.
	firstDelta, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{
			"delta": map[string]any{"content": "partial"},
		}},
	})
	// Single SSE line + blank line; next Read will return an error.
	lineData := fmt.Sprintf("data: %s\n\n", firstDelta)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		// Flush headers so the recorder sees them even before the body.
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
	}))
	defer ts.Close()

	// Use a custom transport that injects the error-body directly.
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_API_KEY", "")

	errBody := &halfThenErrorReader{data: []byte(lineData)}
	transport := rtFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       errBody,
		}, nil
	})

	h := newStreamHandler(&http.Client{Transport: transport})

	req := &completionRequest{
		Messages: []completionMessage{{Role: "user", Content: "go"}},
		Stream:   true,
	}
	w := httptest.NewRecorder()
	h.completeSSE(w, context.Background(), "tenant-err", req)

	body := w.Body.String()
	events := parseSSEEvents(body)

	var sawDelta, sawError bool
	for _, ev := range events {
		switch ev.name {
		case "message_delta":
			sawDelta = true
		case "message_error":
			sawError = true
			var payload struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal([]byte(ev.data), &payload); err != nil {
				t.Fatalf("message_error unmarshal: %v", err)
			}
			if payload.Error == "" {
				t.Error("message_error event must have a non-empty error field")
			}
		case "message_completed":
			t.Errorf("must NOT have message_completed after a mid-stream error")
		}
	}
	if !sawDelta {
		t.Error("expected at least one message_delta before the error")
	}
	if !sawError {
		t.Errorf("expected message_error event; got events: %v", events)
	}
}

// ---------------------------------------------------------------------------
// writeSSEEvent — named-SSE wire format
// ---------------------------------------------------------------------------

func TestWriteSSEEvent_Format(t *testing.T) {
	w := httptest.NewRecorder()
	writeSSEEvent(w, nil, "message_delta", map[string]any{
		"turnId": "abc",
		"seq":    1,
		"delta":  "hello",
	})

	body := w.Body.String()
	// Must start with "event: message_delta\n"
	if !strings.HasPrefix(body, "event: message_delta\n") {
		t.Errorf("expected 'event: message_delta\\n' prefix, got: %q", body)
	}
	// Must have a "data: {...}\n" line
	if !containsStr(body, "data: ") {
		t.Errorf("missing data: line in %q", body)
	}
	// Must end with double newline
	if !strings.HasSuffix(body, "\n\n") {
		t.Errorf("event must end with \\n\\n, got: %q", body)
	}
	// Payload must be valid JSON containing the fields.
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	var dataLine string
	for _, l := range lines {
		if strings.HasPrefix(l, "data: ") {
			dataLine = strings.TrimPrefix(l, "data: ")
		}
	}
	if dataLine == "" {
		t.Fatal("no data line found")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(dataLine), &payload); err != nil {
		t.Fatalf("data payload is not valid JSON: %v (got %q)", err, dataLine)
	}
	if payload["turnId"] != "abc" {
		t.Errorf("turnId: got %v, want abc", payload["turnId"])
	}
}

// ---------------------------------------------------------------------------
// stream:false byte-compat — sync JSON response shape unchanged
// ---------------------------------------------------------------------------

func TestCompleteNonStream_JSONResponseShape(t *testing.T) {
	// Verify that the existing sync JSON response (stream:false / absent) keeps
	// its documented shape. Tests the handleOpenAISyncResponse path which
	// must be byte-identical before and after the streaming additions.
	h := newTestLlmProxyHandler() // from llm_proxy_test.go
	payload := map[string]any{
		"choices": []any{map[string]any{
			"message":       map[string]any{"content": "sync reply"},
			"finish_reason": "stop",
		}},
		"usage": map[string]any{
			"prompt_tokens":     100,
			"completion_tokens": 50,
		},
	}
	w := httptest.NewRecorder()
	h.handleOpenAISyncResponse(w, stubHTTPResponse(payload), "gpt-4o")

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	// Must be JSON (not SSE) — no "event:" in the response.
	body := w.Body.String()
	if containsStr(body, "event:") || containsStr(body, "message_delta") {
		t.Errorf("sync response must be plain JSON, got SSE markers in: %q", body)
	}
	var cr completionResponse
	if err := json.Unmarshal([]byte(body), &cr); err != nil {
		t.Fatalf("sync response is not valid JSON: %v", err)
	}
	if cr.Content != "sync reply" {
		t.Errorf("Content: got %q, want %q", cr.Content, "sync reply")
	}
	if cr.TokensIn != 100 || cr.TokensOut != 50 {
		t.Errorf("tokens: in=%d out=%d, want in=100 out=50", cr.TokensIn, cr.TokensOut)
	}
}
