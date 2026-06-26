package cli

// doctor_test.go — unit tests for `lantern doctor`.
//
// All checks use httptest.Server mocks — no live stack required.
// Tests cover:
//   - all-green path
//   - health check failure (server unreachable / non-200)
//   - no LLM provider configured
//   - run reaches "failed" terminal status
//   - poll timeout

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
)

// devBearerToken is the dummy token the mock /auth/login returns.
const devBearerToken = "test-bearer-token"

// registerHealthOK wires a /healthz handler that returns 200 JSON {"status":"ok"}.
func registerHealthOK(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok","llmMode":"api"}`))
	})
}

// registerLoginOK wires /auth/login to return a valid token.
func registerLoginOK(mux *http.ServeMux) {
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"token":"` + devBearerToken + `","user":{"id":"u1","email":"admin@lantern.dev","name":"Admin","tenantId":"t1","role":"owner"}}`))
	})
}

// registerGetMe wires /auth/me to return 200 for the devBearerToken.
func registerGetMe(mux *http.ServeMux) {
	mux.HandleFunc("/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+devBearerToken {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"u1","email":"admin@lantern.dev","name":"Admin","tenantId":"t1","role":"owner"}`))
	})
}

// registerProvidersOK wires /v1/settings/llm-providers with one active provider.
func registerProvidersOK(mux *http.ServeMux) {
	mux.HandleFunc("/v1/settings/llm-providers", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[{"provider":"openai","status":"active","keyMasked":"****env****"}]`))
	})
}

// registerProvidersEmpty wires /v1/settings/llm-providers with an empty list.
func registerProvidersEmpty(mux *http.ServeMux) {
	mux.HandleFunc("/v1/settings/llm-providers", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	})
}

// registerRunOK wires the agent+run endpoints for a successful end-to-end run.
func registerRunOK(mux *http.ServeMux) {
	var agentCreated bool
	mux.HandleFunc("/v1/agents/"+doctorAgentName, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if !agentCreated {
				w.Header().Set("Content-Type", "application/json")
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			} else {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"id":"a1","name":"` + doctorAgentName + `"}`))
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
		agentCreated = true
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"a1","name":"` + doctorAgentName + `"}`))
	})
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"run-ok","agentName":"` + doctorAgentName + `","status":"queued"}`))
	})
	mux.HandleFunc("/v1/runs/run-ok", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"run-ok","agentName":"` + doctorAgentName + `","status":"succeeded","output":{"text":"ready"}}`))
	})
}

// registerRunFailed wires run endpoints where the run terminates as "failed".
func registerRunFailed(mux *http.ServeMux) {
	// Agent already exists so we skip create.
	mux.HandleFunc("/v1/agents/"+doctorAgentName, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"id":"a1","name":"` + doctorAgentName + `"}`))
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"run-fail","status":"queued"}`))
	})
	mux.HandleFunc("/v1/runs/run-fail", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"run-fail","status":"failed","error":{"code":"llm_error","message":"no provider configured"}}`))
	})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestDoctor_AllGreen verifies that every check passes when the stack is healthy.
func TestDoctor_AllGreen(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersOK(mux)
	registerRunOK(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if r := checkHealth(srv.URL); !r.passed {
		t.Errorf("checkHealth: want passed, got failed: %s", r.detail)
	}

	authResult, tok := checkAuth(srv.URL)
	if !authResult.passed {
		t.Errorf("checkAuth: want passed, got failed: %s", authResult.detail)
	}
	if tok == "" {
		t.Error("checkAuth: expected non-empty token")
	}

	if r := checkProviders(srv.URL, tok); !r.passed {
		t.Errorf("checkProviders: want passed, got failed: %s", r.detail)
	}

	if r := checkRun(srv.URL, tok); !r.passed {
		t.Errorf("checkRun: want passed, got failed: %s", r.detail)
	}
}

// TestDoctor_HealthDown verifies an unreachable server fails the health check.
func TestDoctor_HealthDown(t *testing.T) {
	r := checkHealth("http://127.0.0.1:19999")
	if r.passed {
		t.Error("checkHealth: expected failed for unreachable server, got passed")
	}
	if !r.hard {
		t.Error("checkHealth: expected hard=true")
	}
}

// TestDoctor_HealthNon200 verifies a non-200 response fails the health check.
func TestDoctor_HealthNon200(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r := checkHealth(srv.URL)
	if r.passed {
		t.Errorf("checkHealth: expected failed for non-200, got passed")
	}
	if !r.hard {
		t.Error("checkHealth: expected hard=true")
	}
}

// TestDoctor_NoProvider verifies the no-provider path returns a useful hint.
func TestDoctor_NoProvider(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersEmpty(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, tok := checkAuth(srv.URL)
	r := checkProviders(srv.URL, tok)
	if r.passed {
		t.Error("checkProviders: expected failed for empty provider list, got passed")
	}
	if !r.hard {
		t.Error("checkProviders: expected hard=true")
	}
	if !strings.Contains(r.detail, "POST /v1/settings/llm-providers") {
		t.Errorf("checkProviders detail missing POST hint: %q", r.detail)
	}
}

// TestDoctor_RunFailed verifies a failed run is surfaced with its error message.
func TestDoctor_RunFailed(t *testing.T) {
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersOK(mux)
	registerRunFailed(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, tok := checkAuth(srv.URL)
	r := checkRun(srv.URL, tok)
	if r.passed {
		t.Errorf("checkRun: expected failed for a failed run, got passed")
	}
	if !r.hard {
		t.Error("checkRun: expected hard=true")
	}
	if !strings.Contains(r.detail, "failed") {
		t.Errorf("checkRun detail should mention failure: %q", r.detail)
	}
}

// TestDoctor_PollTerminal_Timeout verifies pollRunUntilTerminal returns an
// error when the run never reaches a terminal state within the deadline.
func TestDoctor_PollTerminal_Timeout(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runs/run-loop", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"run-loop","status":"running"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	_, err := pollRunUntilTerminal(client, "run-loop", 300*time.Millisecond)
	if err == nil {
		t.Error("pollRunUntilTerminal: expected timeout error, got nil")
	}
}

// TestDoctor_CreateAgentBodyUsesSystemPrompt asserts that
// CreateAgentWithSystemPrompt sends "systemPrompt" and never "instructions".
func TestDoctor_CreateAgentBodyUsesSystemPrompt(t *testing.T) {
	var captured map[string]interface{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
				http.Error(w, "bad body", http.StatusBadRequest)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"a1","name":"probe"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := internal.NewRESTClient(srv.URL, "", devBearerToken)
	_, _ = client.CreateAgentWithSystemPrompt("probe", "desc", "be ready")

	if _, has := captured["instructions"]; has {
		t.Error("CreateAgentWithSystemPrompt must not send 'instructions' field")
	}
	sp, ok := captured["systemPrompt"].(string)
	if !ok || sp == "" {
		t.Errorf("CreateAgentWithSystemPrompt must send 'systemPrompt', got captured=%v", captured)
	}
}
