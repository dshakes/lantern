package cli

// agent_dev_test.go — unit tests for `lantern agent dev`.
//
// Covers:
//   - isWatchedFile: correct file-type classification.
//   - latestMtime: returns the most recent mtime across a temp dir.
//   - renderSSEEvent: smoke-tests every event kind without panicking.
//   - devIteration: full publish → run → stream cycle against httptest servers.
//   - runDevEval: eval path with suites present, no suites, and a 422 regression.
//   - publishAgent: agent.yaml present and absent; 409 on existing agent.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
)

// ── isWatchedFile ────────────────────────────────────────────────────────────

func TestIsWatchedFile(t *testing.T) {
	watched := []string{
		"agent.yaml", "agent.yml",
		"main.ts", "index.tsx", "app.js", "widget.jsx",
		"handler.py", "server.go",
		"config.json", "schema.yaml", "spec.yml",
	}
	notWatched := []string{
		"README.md", "image.png", "data.csv", ".gitignore",
		"node_modules", "dist", "build.sh",
	}
	for _, f := range watched {
		if !isWatchedFile(f) {
			t.Errorf("isWatchedFile(%q) = false, want true", f)
		}
	}
	for _, f := range notWatched {
		if isWatchedFile(f) {
			t.Errorf("isWatchedFile(%q) = true, want false", f)
		}
	}
}

// ── latestMtime ──────────────────────────────────────────────────────────────

func TestLatestMtime_EmptyDir(t *testing.T) {
	dir := t.TempDir()
	mtime := latestMtime(dir)
	if !mtime.IsZero() {
		t.Errorf("expected zero time for empty dir, got %v", mtime)
	}
}

func TestLatestMtime_TracksNewest(t *testing.T) {
	dir := t.TempDir()

	older := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(older, []byte("name: test"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Give a distinct mtime.
	time.Sleep(10 * time.Millisecond)
	newer := filepath.Join(dir, "main.ts")
	if err := os.WriteFile(newer, []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}

	newerInfo, _ := os.Stat(newer)
	latest := latestMtime(dir)
	if !latest.Equal(newerInfo.ModTime()) {
		t.Errorf("latestMtime should match newest file mtime: got %v, want %v",
			latest, newerInfo.ModTime())
	}
}

func TestLatestMtime_IgnoresNonWatched(t *testing.T) {
	dir := t.TempDir()
	// Only write a non-watched file.
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !latestMtime(dir).IsZero() {
		t.Error("latestMtime should be zero when no watched files exist")
	}
}

// ── renderSSEEvent ───────────────────────────────────────────────────────────

// TestRenderSSEEvent_NoLPanic confirms every event kind renders without panic.
func TestRenderSSEEvent_NoPanic(t *testing.T) {
	kinds := []string{
		"step_started", "step_completed", "step_failed",
		"confidence_evaluated", "log", "llm_delta", "llm_complete",
		"end", "heartbeat", "unknown_kind", "",
	}
	for _, k := range kinds {
		ev := &internal.SSEEvent{
			Kind: k,
			Payload: map[string]any{
				"step_id":       "s1",
				"kind":          "ai-step",
				"duration_ms":   float64(500),
				"will_retry":    true,
				"error_code":    "llm_error",
				"error_message": "timeout",
				"decision":      "execute",
				"score":         float64(0.85),
				"level":         "info",
				"message":       "running",
				"text":          "hello",
				"tokens_in":     float64(100),
				"tokens_out":    float64(50),
				"status":        "succeeded",
				"reason":        "done",
			},
		}
		// renderSSEEvent writes to os.Stderr; just confirm it doesn't panic.
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("renderSSEEvent panicked for kind=%q: %v", k, r)
				}
			}()
			renderSSEEvent(ev)
		}()
	}
	// nil event should also be safe.
	renderSSEEvent(nil)
}

// ── devIteration (publish → run → stream) ────────────────────────────────────

func registerDevAgent(mux *http.ServeMux, agentName string) {
	created := false
	mux.HandleFunc("/v1/agents/"+agentName, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if created {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				fmt.Fprintf(w, `{"id":"a1","name":%q}`, agentName)
			} else {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			}
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		created = true
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"id":"a1","name":%q}`, agentName)
	})
}

func registerDevRun(mux *http.ServeMux, status string) (runID string) {
	runID = "dev-run-" + status
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"id":%q,"status":"queued"}`, runID)
	})
	mux.HandleFunc("/v1/runs/"+runID, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"id":%q,"status":%q}`, runID, status)
	})
	// SSE endpoint — returns a minimal stream and closes immediately.
	mux.HandleFunc("/v1/runs/"+runID+"/events", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		endPayload := fmt.Sprintf(`{"kind":"end","payload":{"status":%q}}`, status)
		fmt.Fprintf(w, "data: %s\n\n", endPayload)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	})
	return runID
}

func TestDevIteration_Succeeded(t *testing.T) {
	agentName := "my-dev-agent"
	mux := http.NewServeMux()
	registerDevAgent(mux, agentName)
	registerDevRun(mux, "succeeded")
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	dir := t.TempDir()

	opts := agentDevOpts{dir: dir, input: `{"prompt":"test"}`}
	if err := devIteration(t.Context(), client, agentName, opts); err != nil {
		t.Fatalf("devIteration: unexpected error: %v", err)
	}
}

func TestDevIteration_Failed_NoError(t *testing.T) {
	// A failed run should not return an error from devIteration —
	// it prints the failure and the loop continues.
	agentName := "my-dev-agent"
	mux := http.NewServeMux()
	registerDevAgent(mux, agentName)
	registerDevRun(mux, "failed")
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	dir := t.TempDir()

	opts := agentDevOpts{dir: dir, input: `{"prompt":"test"}`}
	// A failed run result should NOT cause devIteration to return an error —
	// the loop keeps going.
	if err := devIteration(t.Context(), client, agentName, opts); err != nil {
		t.Fatalf("devIteration: failed run should not propagate as error, got: %v", err)
	}
}

// ── publishAgent ─────────────────────────────────────────────────────────────

func TestPublishAgent_NoYAML(t *testing.T) {
	// Without agent.yaml, publishAgent is a no-op (no REST call at all).
	mux := http.NewServeMux()
	var postCalled int32
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			atomic.AddInt32(&postCalled, 1)
		}
		http.Error(w, "unexpected call", http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	dir := t.TempDir() // no agent.yaml

	if err := publishAgent(client, "test-agent", dir); err != nil {
		t.Fatalf("publishAgent with no agent.yaml: %v", err)
	}
	if atomic.LoadInt32(&postCalled) != 0 {
		t.Error("POST /v1/agents must not be called when agent.yaml is absent")
	}
}

func TestPublishAgent_WithYAML(t *testing.T) {
	var captured map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&captured)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"id":"a1","name":"yaml-agent"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	yamlContent := `name: "yaml-agent"
description: "My test agent"
model: auto`
	if err := os.WriteFile(filepath.Join(dir, "agent.yaml"), []byte(yamlContent), 0o644); err != nil {
		t.Fatal(err)
	}

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	if err := publishAgent(client, "yaml-agent", dir); err != nil {
		t.Fatalf("publishAgent: %v", err)
	}
	if captured == nil {
		t.Fatal("POST /v1/agents was not called")
	}
	if name, _ := captured["name"].(string); name != "yaml-agent" {
		t.Errorf("published agent name: want %q got %q", "yaml-agent", name)
	}
}

func TestPublishAgent_409IsOK(t *testing.T) {
	// 409 Conflict (agent already exists) must not propagate as an error.
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			http.Error(w, `{"error":"agent already exists"}`, http.StatusConflict)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "agent.yaml"), []byte(`name: "dup-agent"\ndescription: "d"`), 0o644)

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	if err := publishAgent(client, "dup-agent", dir); err != nil {
		t.Fatalf("409 Conflict must not be an error, got: %v", err)
	}
}

// ── runDevEval ───────────────────────────────────────────────────────────────

func TestRunDevEval_NoSuites(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/eval-suites", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`[]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Should not panic or return an error.
	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	runDevEval(client, "no-suite-agent") // best-effort, must not panic
}

func TestRunDevEval_SuitePass(t *testing.T) {
	agentName := "eval-agent"
	runID := "eval-run-ok"
	var evalRunPosted bool

	mux := http.NewServeMux()
	// List suites.
	mux.HandleFunc("/v1/eval-suites", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.RawQuery, agentName) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`[{"id":"s1","agentName":"eval-agent","name":"smoke","cases":[{"id":"c1","input":{"prompt":"hi"},"expected":""}]}]`))
		} else {
			http.Error(w, "bad request", http.StatusBadRequest)
		}
	})
	// Create run for the eval case.
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"id":%q,"status":"queued"}`, runID)
	})
	// Poll run.
	mux.HandleFunc("/v1/runs/"+runID, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"id":%q,"status":"succeeded","output":{"text":"Hello there!"}}`, runID)
	})
	// Record eval run.
	mux.HandleFunc("/v1/eval-runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			evalRunPosted = true
			w.WriteHeader(http.StatusCreated)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	runDevEval(client, agentName)

	if !evalRunPosted {
		t.Error("POST /v1/eval-runs was not called after eval cases ran")
	}
}

func TestRunDevEval_Regression(t *testing.T) {
	// 422 from POST /v1/eval-runs means regression — must not panic.
	agentName := "regress-agent"
	runID := "regress-run"

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/eval-suites", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`[{"id":"s1","agentName":"regress-agent","name":"smoke","cases":[{"id":"c1","input":{"prompt":"hi"},"expected":"correct answer"}]}]`))
	})
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, `{"id":%q,"status":"queued"}`, runID)
	})
	mux.HandleFunc("/v1/runs/"+runID, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"id":%q,"status":"succeeded","output":{"text":"wrong answer"}}`, runID)
	})
	mux.HandleFunc("/v1/eval-runs", func(w http.ResponseWriter, _ *http.Request) {
		// 422 = regression
		http.Error(w, `{"error":"score regressed vs baseline"}`, http.StatusUnprocessableEntity)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	// Must not panic or hang.
	runDevEval(client, agentName)
}

// ── SSE streaming (REST client) ───────────────────────────────────────────────

func TestStreamRunEventsSSE_ParsesEvents(t *testing.T) {
	// A minimal SSE server that sends two events then closes.
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runs/test-run/events", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		events := []string{
			`{"kind":"step_started","stepId":"s1","payload":{"step_id":"s1","kind":"ai-step"}}`,
			`{"kind":"step_completed","stepId":"s1","payload":{"step_id":"s1","duration_ms":123}}`,
			`{"kind":"end","payload":{"status":"succeeded"}}`,
		}
		for _, e := range events {
			fmt.Fprintf(w, "data: %s\n\n", e)
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)

	var received []string
	err := client.StreamRunEventsSSE(t.Context(), "test-run", func(ev *internal.SSEEvent) {
		received = append(received, ev.Kind)
	})
	if err != nil {
		t.Fatalf("StreamRunEventsSSE: %v", err)
	}

	want := []string{"step_started", "step_completed", "end"}
	if len(received) != len(want) {
		t.Fatalf("received %d events, want %d: %v", len(received), len(want), received)
	}
	for i, k := range want {
		if received[i] != k {
			t.Errorf("event[%d]: want %q, got %q", i, k, received[i])
		}
	}
}

func TestStreamRunEventsSSE_Non200(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runs/bad-run/events", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	err := client.StreamRunEventsSSE(t.Context(), "bad-run", nil)
	if err == nil {
		t.Fatal("expected error for non-200 SSE response, got nil")
	}
}
