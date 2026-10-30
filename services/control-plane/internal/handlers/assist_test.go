package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---- GET /auth/providers ---------------------------------------------------

func TestAuthProviders_ReflectsConfiguration(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	h := NewAuthHandler(&server.Server{Logger: logger}, testJWTSecret)

	get := func() authProvidersResponse {
		t.Helper()
		rr := httptest.NewRecorder()
		h.AuthProviders(rr, httptest.NewRequest(http.MethodGet, "/auth/providers", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("got %d", rr.Code)
		}
		var out authProvidersResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		// Only booleans and an enum may leave this endpoint.
		if strings.Contains(rr.Body.String(), "secret") || strings.Contains(rr.Body.String(), "client") {
			t.Fatalf("response leaks configuration detail: %s", rr.Body.String())
		}
		return out
	}

	t.Setenv("GOOGLE_CLIENT_ID", "")
	t.Setenv("GOOGLE_CLIENT_SECRET", "")
	t.Setenv("GITHUB_CLIENT_ID", "gh-id")
	t.Setenv("GITHUB_CLIENT_SECRET", "")
	t.Setenv("PAL_SIGNUP_MODE", "invite")
	out := get()
	if out.OAuth["google"] || out.OAuth["github"] {
		t.Errorf("half-configured providers must read as off: %v", out.OAuth)
	}
	if out.Signup != "invite" || !out.PasswordReset {
		t.Errorf("signup=%q passwordReset=%v", out.Signup, out.PasswordReset)
	}

	t.Setenv("GITHUB_CLIENT_SECRET", "gh-secret")
	t.Setenv("PAL_SIGNUP_MODE", "closed")
	out = get()
	if !out.OAuth["github"] || out.OAuth["google"] || out.Signup != "closed" {
		t.Errorf("got %+v, want github only, signup closed", out)
	}
}

// ---- POST /v1/assist/explain ----------------------------------------------

func TestAssistExplain_Validation(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewAssistHandler(srv, auth, NewLlmProxyHandler(srv, auth))

	for name, body := range map[string]map[string]string{
		"unknown kind":      {"kind": "vm"},
		"run without id":    {"kind": "run"},
		"run junk id":       {"kind": "run", "runId": "'; drop table runs;--"},
		"eval without case": {"kind": "eval_case", "error": "boom"},
		"eval without data": {"kind": "eval_case", "case": "greets"},
	} {
		rr := onbReq(t, h.Explain, http.MethodPost, "/v1/assist/explain", onboardingTestTenant, body)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d %s, want 400", name, rr.Code, rr.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/assist/explain", strings.NewReader(`{"kind":"eval_case"}`))
	rr := httptest.NewRecorder()
	h.Explain(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("no token: got %d, want 401", rr.Code)
	}
}

func TestAssistExplain_EvalCase(t *testing.T) {
	var prompt string
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
		func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			prompt = string(b)
			return anthropicOKResponse("The agent answered in French; the case expects English. Pin the reply language in the system prompt.")(r)
		},
	}}
	llm := newTestProxyWithStub(t, stub)
	h := NewAssistHandler(llm.srv, llm.auth, llm)

	rr := onbReq(t, h.Explain, http.MethodPost, "/v1/assist/explain", onboardingTestTenant, map[string]string{
		"kind": "eval_case", "agentName": "greeter", "case": "greets-in-english",
		"expected": "Hello", "actual": "Bonjour", "error": "mismatch",
	})
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "French") {
		t.Fatalf("got %d %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(prompt, "greets-in-english") || !strings.Contains(prompt, "Bonjour") {
		t.Errorf("prompt is not grounded in the case: %s", prompt)
	}

	t.Setenv("ANTHROPIC_API_KEY", "")
	rr = onbReq(t, h.Explain, http.MethodPost, "/v1/assist/explain", onboardingTestTenant, map[string]string{
		"kind": "eval_case", "case": "c", "error": "boom",
	})
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "no_provider") {
		t.Errorf("no provider: got %d %s, want 400 no_provider", rr.Code, rr.Body.String())
	}
}

// The run path is grounded in the DB and tenant-isolated: the owner's run is
// explained from its real status/error/journal; another tenant gets 404.
func TestAssistExplain_RunGroundedAndTenantScoped(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	var prompt string
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
		func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			prompt = string(b)
			return anthropicOKResponse("The run failed at step fetch with a 429 from the connector. Retry later or raise the connector rate limit.")(r)
		},
	}}
	llm := newTestProxyWithStub(t, stub)
	llm.srv.Pool = pool
	h := NewAssistHandler(llm.srv, llm.auth, llm)

	owner := seedA2ATenant(t, pool, "assist-owner-tenant")
	other := seedA2ATenant(t, pool, "assist-other-tenant")
	seedA2AAgentWithVersion(t, pool, owner, "assist-agent", false)
	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, error)
		SELECT tenant_id, id, current_version_id, 'failed', 'api', '{"q":"hi"}'::jsonb, '{"message":"connector returned 429"}'::jsonb
		FROM agents WHERE tenant_id = $1 AND name = 'assist-agent' RETURNING id::text`, owner).Scan(&runID); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, payload)
		VALUES ($1, 1, 'step_failed', 'fetch', convert_to('{"error":"HTTP 429"}', 'UTF8'))`, runID); err != nil {
		t.Fatalf("seed journal: %v", err)
	}

	rr := onbReq(t, h.Explain, http.MethodPost, "/v1/assist/explain", owner, map[string]string{"kind": "run", "runId": runID})
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "429") {
		t.Fatalf("owner: got %d %s", rr.Code, rr.Body.String())
	}
	for _, want := range []string{"assist-agent", "failed", "connector returned 429", "step_failed fetch"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q (not grounded in the run): %s", want, prompt)
		}
	}

	calls := stub.callCount()
	rr = onbReq(t, h.Explain, http.MethodPost, "/v1/assist/explain", other, map[string]string{"kind": "run", "runId": runID})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant: got %d %s, want 404", rr.Code, rr.Body.String())
	}
	if stub.callCount() != calls {
		t.Error("cross-tenant request reached the model")
	}
}
