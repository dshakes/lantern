package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// asyncRunServer mimics the control plane: POST /v1/runs -> 201 (no output),
// GET /v1/runs/{id} -> each entry of statuses in turn, the last repeating.
func asyncRunServer(t *testing.T, createCode int, statuses []map[string]any) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var polls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(createCode)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "run-1", "status": "queued"})
	})
	mux.HandleFunc("GET /v1/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		i := int(polls.Add(1)) - 1
		if i >= len(statuses) {
			i = len(statuses) - 1
		}
		_ = json.NewEncoder(w).Encode(statuses[i])
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &polls
}

func TestRunCaseAsync(t *testing.T) {
	ok := map[string]any{"id": "run-1", "status": "succeeded", "output": map[string]any{"text": "hello world"}, "costUsd": 0.5}
	running := map[string]any{"id": "run-1", "status": "running"}
	failed := map[string]any{"id": "run-1", "status": "failed", "error": map[string]any{"code": "llm_failed", "message": "boom"}}

	tests := []struct {
		name       string
		createCode int
		statuses   []map[string]any
		timeout    time.Duration
		wantPassed bool
		wantErr    string
		wantPolls  int32
	}{
		{"201 then running to succeeded", 201, []map[string]any{running, running, ok}, 5 * time.Second, true, "", 3},
		{"200 compat still polls", 200, []map[string]any{ok}, 5 * time.Second, true, "", 1},
		{"failed run", 201, []map[string]any{running, failed}, 5 * time.Second, false, "llm_failed: boom", 2},
		{"cancelled run", 201, []map[string]any{{"id": "run-1", "status": "cancelled"}}, 5 * time.Second, false, "run cancelled", 1},
		{"timeout", 201, []map[string]any{running}, 600 * time.Millisecond, false, "timed out", -1},
		{"create rejected", 402, []map[string]any{ok}, 5 * time.Second, false, "402", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv, polls := asyncRunServer(t, tc.createCode, tc.statuses)
			cr := runCase(context.Background(), srv.URL, "tok", "agent", evalCase{Name: "c", Assert: map[string]any{"contains": "hello"}}, tc.timeout)
			if cr.Passed != tc.wantPassed {
				t.Fatalf("passed=%v want %v (err=%q)", cr.Passed, tc.wantPassed, cr.Error)
			}
			if tc.wantErr == "" && cr.Error != "" || !strings.Contains(cr.Error, tc.wantErr) {
				t.Fatalf("error=%q want contains %q", cr.Error, tc.wantErr)
			}
			if tc.wantPolls >= 0 && polls.Load() != tc.wantPolls {
				t.Fatalf("polls=%d want %d", polls.Load(), tc.wantPolls)
			}
			if tc.wantPassed && cr.CostUsd != 0.5 {
				t.Fatalf("cost=%v", cr.CostUsd)
			}
		})
	}
}
