package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

func newSignalHandlerForTest(t *testing.T) *SignalHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	return NewSignalHandler(&server.Server{Logger: logger})
}

// isolateHome points HOME at a temp dir so the handler writes
// ~/.lantern/device-signals.jsonl under the test's sandbox.
func isolateHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	return tmp
}

func postSignal(t *testing.T, h *SignalHandler, token string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/signals", bytes.NewReader(raw))
	if token != "" {
		req.Header.Set("x-lantern-signal-token", token)
	}
	rec := httptest.NewRecorder()
	h.IngestSignal(rec, req)
	return rec
}

func TestSignalIngest(t *testing.T) {
	const tok = "test-signal-token"

	tests := []struct {
		name       string
		setEnv     bool
		token      string
		body       map[string]any
		wantStatus int
		wantLine   bool
	}{
		{
			name:       "valid token writes a line",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"app": "Calendar", "kind": "app_open", "detail": "1:1 with Raju"},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "missing app is 400",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "app_open"},
			wantStatus: http.StatusBadRequest,
			wantLine:   false,
		},
		{
			name:       "blank app is 400",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"app": "   ", "kind": "app_open"},
			wantStatus: http.StatusBadRequest,
			wantLine:   false,
		},
		{
			name:       "wrong token is 401",
			setEnv:     true,
			token:      "nope",
			body:       map[string]any{"app": "Calendar", "kind": "app_open"},
			wantStatus: http.StatusUnauthorized,
			wantLine:   false,
		},
		{
			name:       "missing token is 401",
			setEnv:     true,
			token:      "",
			body:       map[string]any{"app": "Calendar", "kind": "app_open"},
			wantStatus: http.StatusUnauthorized,
			wantLine:   false,
		},
		{
			name:       "unset env fails closed even with a token",
			setEnv:     false,
			token:      tok,
			body:       map[string]any{"app": "Calendar", "kind": "app_open"},
			wantStatus: http.StatusUnauthorized,
			wantLine:   false,
		},
		// --- richer kinds ---
		{
			name:       "location with only detail no app",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "location", "detail": "Home"},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "focus signal",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "focus", "detail": "Work"},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "device signal CarPlay",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "device", "detail": "CarPlay"},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "health with metric and value no app or detail",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "health", "metric": "steps", "value": 6200},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "health with detail only",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "health", "detail": "ran 3mi"},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "now_playing signal",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "now_playing", "detail": "Blinding Lights - The Weeknd"},
			wantStatus: http.StatusOK,
			wantLine:   true,
		},
		{
			name:       "wake signal bare no app detail value",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "wake"},
			wantStatus: http.StatusBadRequest, // no app/detail/value — fully empty payload
			wantLine:   false,
		},
		{
			name:       "missing kind is 400",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"app": "Calendar"},
			wantStatus: http.StatusBadRequest,
			wantLine:   false,
		},
		{
			name:       "fully empty non-app_open is 400",
			setEnv:     true,
			token:      tok,
			body:       map[string]any{"kind": "device"},
			wantStatus: http.StatusBadRequest,
			wantLine:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := isolateHome(t)
			if tt.setEnv {
				t.Setenv("LANTERN_SIGNAL_TOKEN", tok)
			} else {
				os.Unsetenv("LANTERN_SIGNAL_TOKEN")
			}

			h := newSignalHandlerForTest(t)
			rec := postSignal(t, h, tt.token, tt.body)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body=%s)", rec.Code, tt.wantStatus, rec.Body.String())
			}

			path := filepath.Join(home, ".lantern", "device-signals.jsonl")
			data, err := os.ReadFile(path)
			lines := 0
			if err == nil {
				for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
					if strings.TrimSpace(l) != "" {
						lines++
					}
				}
			}
			if tt.wantLine && lines != 1 {
				t.Fatalf("expected 1 line written, got %d (err=%v)", lines, err)
			}
			if !tt.wantLine && lines != 0 {
				t.Fatalf("expected no line written, got %d", lines)
			}
		})
	}
}

func TestSignalIngestDefaultsAndFormat(t *testing.T) {
	const tok = "test-signal-token"
	home := isolateHome(t)
	t.Setenv("LANTERN_SIGNAL_TOKEN", tok)
	h := newSignalHandlerForTest(t)

	// kind explicit, ts omitted -> ts defaults to now; detail clamped to 500.
	rec := postSignal(t, h, tok, map[string]any{
		"app":    "Mail",
		"kind":   "app_open",
		"detail": strings.Repeat("x", 600),
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}

	var ok struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ok); err != nil || !ok.OK {
		t.Fatalf("expected {ok:true}, got %s (err=%v)", rec.Body.String(), err)
	}

	path := filepath.Join(home, ".lantern", "device-signals.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	var e signalEntry
	if err := json.Unmarshal(bytes.TrimSpace(data), &e); err != nil {
		t.Fatalf("unmarshal line: %v (line=%s)", err, data)
	}
	if e.App != "Mail" {
		t.Errorf("app = %q, want Mail", e.App)
	}
	if e.Kind != "app_open" {
		t.Errorf("kind = %q, want app_open", e.Kind)
	}
	if len(e.Detail) != signalMaxDetailLen {
		t.Errorf("detail len = %d, want clamped to %d", len(e.Detail), signalMaxDetailLen)
	}
	if e.TS == 0 {
		t.Errorf("ts = 0, want now-ms default")
	}

	// File must be 0600 — it holds app-context PII.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("file perm = %o, want 600", perm)
	}
}

func TestSignalHealthMetricValueJSONL(t *testing.T) {
	const tok = "test-signal-token"
	home := isolateHome(t)
	t.Setenv("LANTERN_SIGNAL_TOKEN", tok)
	h := newSignalHandlerForTest(t)

	val := 6200.0
	rec := postSignal(t, h, tok, map[string]any{
		"kind":   "health",
		"metric": "steps",
		"value":  val,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}

	path := filepath.Join(home, ".lantern", "device-signals.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	var e signalEntry
	if err := json.Unmarshal(bytes.TrimSpace(data), &e); err != nil {
		t.Fatalf("unmarshal line: %v (line=%s)", err, data)
	}
	if e.Kind != "health" {
		t.Errorf("kind = %q, want health", e.Kind)
	}
	if e.Metric != "steps" {
		t.Errorf("metric = %q, want steps", e.Metric)
	}
	if e.Value == nil || *e.Value != val {
		t.Errorf("value = %v, want %v", e.Value, val)
	}
	// app_open omitempty: app should be absent / empty for a health signal.
	if e.App != "" {
		t.Errorf("app = %q, want empty (omitempty)", e.App)
	}

	// Confirm the raw JSON line has no "app" key.
	line := strings.TrimSpace(string(data))
	if strings.Contains(line, `"app"`) {
		t.Errorf("JSONL line contains unexpected 'app' key: %s", line)
	}
}

func TestSignalListReturnsAppended(t *testing.T) {
	const tok = "test-signal-token"
	isolateHome(t)
	t.Setenv("LANTERN_SIGNAL_TOKEN", tok)
	h := newSignalHandlerForTest(t)

	for _, app := range []string{"Calendar", "Mail", "Notes"} {
		if rec := postSignal(t, h, tok, map[string]any{"app": app, "kind": "app_open"}); rec.Code != http.StatusOK {
			t.Fatalf("post %s: status %d", app, rec.Code)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/signals?limit=2", nil)
	req.Header.Set("x-lantern-signal-token", tok)
	rec := httptest.NewRecorder()
	h.ListSignals(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}

	var got []signalEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal list: %v (body=%s)", err, rec.Body.String())
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (limit honored)", len(got))
	}
	// Last-N in order: Mail then Notes.
	if got[0].App != "Mail" || got[1].App != "Notes" {
		t.Errorf("apps = [%s %s], want [Mail Notes]", got[0].App, got[1].App)
	}
}

// TestSignalListReturnsMetricValue verifies that metric and value fields
// round-trip through POST → JSONL → GET correctly.
func TestSignalListReturnsMetricValue(t *testing.T) {
	const tok = "test-signal-token"
	isolateHome(t)
	t.Setenv("LANTERN_SIGNAL_TOKEN", tok)
	h := newSignalHandlerForTest(t)

	// POST a health signal with metric+value.
	if rec := postSignal(t, h, tok, map[string]any{
		"kind":   "health",
		"metric": "steps",
		"value":  8500.0,
	}); rec.Code != http.StatusOK {
		t.Fatalf("post health: status %d body=%s", rec.Code, rec.Body.String())
	}

	// GET and verify the fields come back.
	req := httptest.NewRequest(http.MethodGet, "/v1/signals?limit=1", nil)
	req.Header.Set("x-lantern-signal-token", tok)
	rec := httptest.NewRecorder()
	h.ListSignals(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}

	var got []signalEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	e := got[0]
	if e.Kind != "health" {
		t.Errorf("kind = %q, want health", e.Kind)
	}
	if e.Metric != "steps" {
		t.Errorf("metric = %q, want steps", e.Metric)
	}
	if e.Value == nil || *e.Value != 8500.0 {
		t.Errorf("value = %v, want 8500", e.Value)
	}
}

func TestSignalListTokenGate(t *testing.T) {
	isolateHome(t)
	t.Setenv("LANTERN_SIGNAL_TOKEN", "test-signal-token")
	h := newSignalHandlerForTest(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/signals", nil) // no token header
	rec := httptest.NewRecorder()
	h.ListSignals(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestSignalFileBounded(t *testing.T) {
	const tok = "test-signal-token"
	home := isolateHome(t)
	t.Setenv("LANTERN_SIGNAL_TOKEN", tok)

	// Pre-seed the file past the cap so the next append triggers a trim.
	dir := filepath.Join(home, ".lantern")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "device-signals.jsonl")
	var buf bytes.Buffer
	for i := 0; i < signalFileMaxLines+10; i++ {
		buf.WriteString(`{"app":"Seed","kind":"app_open","detail":"","ts":1}` + "\n")
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	h := newSignalHandlerForTest(t)
	if rec := postSignal(t, h, tok, map[string]any{"app": "Calendar", "kind": "app_open"}); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := 0
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.TrimSpace(l) != "" {
			lines++
		}
	}
	if lines != signalFileKeepLine {
		t.Fatalf("after trim lines = %d, want %d", lines, signalFileKeepLine)
	}
}
