package cli

// onboard_test.go — unit tests for `lantern onboard`.
//
// All network calls use httptest.Server mocks — no live stack required.
// The existing doctor helpers (registerHealthOK, registerLoginOK, etc.) are
// reused where possible; onboard-specific variants are added here.
//
// Coverage:
//   - Happy path: all five steps green → run succeeds, output printed.
//   - Happy path with agent already existing: step 4 reuses it.
//   - Health down: stops at step 1, returns error, does NOT attempt a run.
//   - Health non-200: same.
//   - No provider, non-interactive: stops at step 3, prints curl hint, no run.
//   - No provider, flags provided (--provider / --api-key): configures,
//     tests, then proceeds to create agent and run.
//   - Provider test fails: returns error, does NOT proceed to agent/run.
//   - Run fails: real error surfaced, not swallowed.
//   - stringReader: ReadLine / ReadMasked work as expected.
//   - Agent payload: systemPrompt field is sent, not instructions.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dshakes/lantern/packages/cli/internal"
)

// ── mock endpoint helpers ────────────────────────────────────────────────────

// registerOnboardAgent wires the quickstart-assistant GET + POST /v1/agents.
// If exists=true the GET returns 200 immediately; otherwise 404 until POST.
func registerOnboardAgent(mux *http.ServeMux, exists bool) {
	created := exists
	mux.HandleFunc("/v1/agents/"+quickstartAgentName, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if created {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"id":"qs1","name":"` + quickstartAgentName + `"}`))
		} else {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
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
		_, _ = w.Write([]byte(`{"id":"qs1","name":"` + quickstartAgentName + `"}`))
	})
}

// registerOnboardRunSucceeded wires POST /v1/runs → queued, GET /v1/runs/{id} → succeeded.
func registerOnboardRunSucceeded(mux *http.ServeMux) {
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"onboard-run-ok","agentName":"` + quickstartAgentName + `","status":"queued"}`))
	})
	mux.HandleFunc("/v1/runs/onboard-run-ok", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"onboard-run-ok","agentName":"` + quickstartAgentName + `","status":"succeeded","output":{"text":"Hi! I can help you draft emails, summarize documents, and answer questions."}}`))
	})
}

// registerOnboardRunFailed wires run endpoints that immediately return a failed run.
func registerOnboardRunFailed(mux *http.ServeMux) {
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"onboard-run-fail","status":"queued"}`))
	})
	mux.HandleFunc("/v1/runs/onboard-run-fail", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"onboard-run-fail","status":"failed","error":{"code":"llm_error","message":"model call failed: 401 invalid key"}}`))
	})
}

// registerProviderConfigure wires GET+POST /v1/settings/llm-providers and
// POST /v1/settings/llm-providers/{provider}/test.
// First GET returns []; after POST returns [{provider}]. testOK controls
// whether the /test endpoint returns 200 or 400.
func registerProviderConfigure(mux *http.ServeMux, provider string, testOK bool) {
	var saved bool
	mux.HandleFunc("/v1/settings/llm-providers", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			if saved {
				_, _ = w.Write([]byte(`[{"provider":"` + provider + `","status":"active"}]`))
			} else {
				_, _ = w.Write([]byte(`[]`))
			}
		case http.MethodPost:
			saved = true
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"provider":"` + provider + `"}`))
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/v1/settings/llm-providers/"+provider+"/test", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if testOK {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
		} else {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid API key"}`))
		}
	})
}

// ── Tests ────────────────────────────────────────────────────────────────────

// TestOnboard_HappyPath verifies all five steps pass and the run succeeds.
func TestOnboard_HappyPath(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersOK(mux)
	registerOnboardAgent(mux, false) // onboard creates the agent
	registerOnboardRunSucceeded(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := &onboardConfig{restURL: srv.URL}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: unexpected error: %v", err)
	}
}

// TestOnboard_HappyPath_AgentExists verifies that a pre-existing agent is
// reused without error.
func TestOnboard_HappyPath_AgentExists(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersOK(mux)
	registerOnboardAgent(mux, true) // agent already exists
	registerOnboardRunSucceeded(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := &onboardConfig{restURL: srv.URL}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard (agent exists): unexpected error: %v", err)
	}
}

// TestOnboard_HealthDown verifies the wizard stops at step 1 when the stack
// is unreachable and does not attempt auth, provider, or run.
func TestOnboard_HealthDown(t *testing.T) {
	cfg := &onboardConfig{restURL: "http://127.0.0.1:19998"}
	err := runOnboard(cfg)
	if err == nil {
		t.Fatal("expected error when health check fails, got nil")
	}
	if !strings.Contains(err.Error(), "health") {
		t.Errorf("error should mention health, got: %v", err)
	}
}

// TestOnboard_HealthNon200 verifies a 503 from /healthz stops the wizard.
func TestOnboard_HealthNon200(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := &onboardConfig{restURL: srv.URL}
	if err := runOnboard(cfg); err == nil {
		t.Fatal("expected error when health returns non-200")
	}
}

// TestOnboard_NoProvider_NonInteractive verifies that when no provider is
// configured and stdin is not a TTY (and no --provider/--api-key flags are
// set), the wizard stops at step 3 and NEVER calls POST /v1/runs.
func TestOnboard_NoProvider_NonInteractive(t *testing.T) {
	runCalled := false
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersEmpty(mux)
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, _ *http.Request) {
		runCalled = true
		http.Error(w, "must not reach here", http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// No provider, no flags, no reader → non-interactive path.
	cfg := &onboardConfig{restURL: srv.URL}
	err := runOnboard(cfg)
	if err == nil {
		t.Fatal("expected error when no provider configured (non-interactive)")
	}
	if runCalled {
		t.Error("POST /v1/runs must NOT be called when the provider gate fails")
	}
	if !strings.Contains(err.Error(), "non-interactive") {
		t.Errorf("error should mention non-interactive, got: %v", err)
	}
}

// TestOnboard_NoProvider_WithFlags verifies that --provider + --api-key bypass
// the interactive prompt, configure the provider, test it, and proceed to run.
func TestOnboard_NoProvider_WithFlags(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProviderConfigure(mux, "openai", true)
	registerOnboardAgent(mux, false)
	registerOnboardRunSucceeded(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := &onboardConfig{
		restURL:  srv.URL,
		provider: "openai",
		apiKey:   "sk-test-flag-key",
	}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard with flags: unexpected error: %v", err)
	}
}

// TestOnboard_ProviderTestFails verifies that a failing provider test stops the
// wizard before it creates an agent or fires a run.
func TestOnboard_ProviderTestFails(t *testing.T) {
	runCalled := false
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProviderConfigure(mux, "openai", false) // /test returns 400
	// /v1/agents/{name} must not be hit
	mux.HandleFunc("/v1/agents/"+quickstartAgentName, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "must not reach here", http.StatusInternalServerError)
	})
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, _ *http.Request) {
		runCalled = true
		http.Error(w, "must not reach here", http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := &onboardConfig{
		restURL:  srv.URL,
		provider: "openai",
		apiKey:   "sk-bad-key",
	}
	err := runOnboard(cfg)
	if err == nil {
		t.Fatal("expected error when provider test fails")
	}
	if runCalled {
		t.Error("POST /v1/runs must NOT be called when provider test fails")
	}
	if !strings.Contains(err.Error(), "provider test") {
		t.Errorf("error should mention provider test, got: %v", err)
	}
}

// TestOnboard_RunFails verifies that a failed run surfaces the real error
// message (not a generic one) and returns a non-nil error.
func TestOnboard_RunFails(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersOK(mux)
	registerOnboardAgent(mux, true)
	registerOnboardRunFailed(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cfg := &onboardConfig{restURL: srv.URL}
	err := runOnboard(cfg)
	if err == nil {
		t.Fatal("expected error when run fails")
	}
	if !strings.Contains(err.Error(), "failed") {
		t.Errorf("error should mention 'failed', got: %v", err)
	}
	if !strings.Contains(err.Error(), "401 invalid key") {
		t.Errorf("real run error message must be surfaced, got: %v", err)
	}
}

// TestOnboard_StringReader verifies the injectable reader used in tests works
// correctly for both ReadLine and ReadMasked.
func TestOnboard_StringReader(t *testing.T) {
	r := newStringReader("openai", "sk-injected-key")

	line, err := r.ReadLine()
	if err != nil {
		t.Fatalf("ReadLine: unexpected error: %v", err)
	}
	if line != "openai" {
		t.Errorf("ReadLine: want %q, got %q", "openai", line)
	}

	key, err := r.ReadMasked()
	if err != nil {
		t.Fatalf("ReadMasked: unexpected error: %v", err)
	}
	if key != "sk-injected-key" {
		t.Errorf("ReadMasked: want %q, got %q", "sk-injected-key", key)
	}

	// EOF after values are exhausted.
	_, err = r.ReadLine()
	if err == nil {
		t.Error("ReadLine past end: expected EOF error, got nil")
	}
}

// TestOnboard_CreateAgentPayload asserts that the REST call to create the
// quickstart agent sends "systemPrompt" (not "instructions") and the correct
// agent name.
func TestOnboard_CreateAgentPayload(t *testing.T) {
	var captured map[string]interface{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/agents/"+quickstartAgentName, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	})
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
				http.Error(w, "bad body", http.StatusBadRequest)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"qs1","name":"` + quickstartAgentName + `"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Call CreateAgentWithSystemPrompt directly via the package-level REST client.
	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	_, _ = client.CreateAgentWithSystemPrompt(quickstartAgentName, "desc", quickstartSystemPrompt)

	if _, has := captured["instructions"]; has {
		t.Error("onboard must not send 'instructions' field — use 'systemPrompt'")
	}
	sp, ok := captured["systemPrompt"].(string)
	if !ok || sp == "" {
		t.Errorf("onboard must send 'systemPrompt', got captured=%v", captured)
	}
	if name, _ := captured["name"].(string); name != quickstartAgentName {
		t.Errorf("agent name: want %q, got %q", quickstartAgentName, name)
	}
}
