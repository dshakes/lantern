package handlers

// agents_create_contract_test.go — contract tests for POST /v1/agents.
//
// These tests lock the HTTP API contract so regressions can't slip in silently:
//
//   1. A body containing "systemPrompt" persists the prompt and the field is
//      readable back via GET /v1/agents/{name}.
//
//   2. A body containing the wrong field name "instructions" does NOT set the
//      agent's system prompt — the server ignores unknown fields.
//
// DB-gated: skipped when DATABASE_URL is unset (same convention as the rest of
// this package). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run Contract -v -count=1

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newRESTHandlerForContractTest builds a minimal RESTHandler backed by a real
// Postgres pool and an AuthHandler using the shared testJWTSecret, following
// the pattern established by newAuthTestHandler and newRESTHandlerForRunEventsTest.
func newRESTHandlerForContractTest(t *testing.T) *RESTHandler {
	t.Helper()
	pool := openTestPool(t) // skips when DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, AppPool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, testJWTSecret)
	return &RESTHandler{srv: srv, agentSvc: agentSvc, runSvc: runSvc, auth: auth}
}

// mintContractToken mints a JWT for devTenantID using the shared testJWTSecret
// so the REST handler's auth validation passes.
func mintContractToken(t *testing.T, h *RESTHandler) string {
	t.Helper()
	tok, err := h.auth.generateToken("contract-user-id", devTenantID, "contract@test.local", "Contract Tester", "owner")
	if err != nil {
		t.Fatalf("mintContractToken: %v", err)
	}
	return tok
}

// doCreateAgent fires POST /v1/agents with the supplied body map and returns
// the recorder. The auth token is injected as a Bearer header.
func doCreateAgent(h *RESTHandler, tok string, body map[string]any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/agents", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	h.CreateAgent(rr, req)
	return rr
}

// doGetAgent fires GET /v1/agents/{name} and returns the recorder.
func doGetAgent(h *RESTHandler, tok, name string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/"+name, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.SetPathValue("name", name)
	rr := httptest.NewRecorder()
	h.GetAgent(rr, req)
	return rr
}

// doDeleteAgent fires DELETE /v1/agents/{name}.
func doDeleteAgent(h *RESTHandler, tok, name string) {
	req := httptest.NewRequest(http.MethodDelete, "/v1/agents/"+name, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.SetPathValue("name", name)
	rr := httptest.NewRecorder()
	h.DeleteAgent(rr, req)
	_ = rr
}

// contractAgentName returns a per-test agent name that won't collide with other
// tests or seeded data.
func contractAgentName(t *testing.T, prefix string) string {
	t.Helper()
	// Use a hex suffix like the auth test uniqueEmail helper.
	suffix, err := randomHex(6)
	if err != nil {
		t.Fatalf("randomHex: %v", err)
	}
	return fmt.Sprintf("%s-%s", prefix, suffix)
}

// ---------------------------------------------------------------------------
// TestContract_CreateAgent_SystemPrompt_Persisted
// ---------------------------------------------------------------------------

// TestContract_CreateAgent_SystemPrompt_Persisted asserts that sending
// "systemPrompt" in the POST /v1/agents body causes the value to be stored
// and returned by GET /v1/agents/{name}.
func TestContract_CreateAgent_SystemPrompt_Persisted(t *testing.T) {
	h := newRESTHandlerForContractTest(t)
	tok := mintContractToken(t, h)

	name := contractAgentName(t, "contract-sp")
	t.Cleanup(func() { doDeleteAgent(h, tok, name) })

	wantPrompt := "Answer questions clearly and concisely."
	rr := doCreateAgent(h, tok, map[string]any{
		"name":         name,
		"description":  "contract test agent",
		"systemPrompt": wantPrompt,
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /v1/agents: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	// The create response should include systemPrompt.
	var createResp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	if sp, ok := createResp["systemPrompt"].(string); !ok || sp != wantPrompt {
		t.Errorf("create response systemPrompt: got %v, want %q", createResp["systemPrompt"], wantPrompt)
	}

	// Read it back via GET to confirm DB persistence.
	rr2 := doGetAgent(h, tok, name)
	if rr2.Code != http.StatusOK {
		t.Fatalf("GET /v1/agents/%s: got %d, want 200; body: %s", name, rr2.Code, rr2.Body.String())
	}
	var getResp map[string]any
	if err := json.Unmarshal(rr2.Body.Bytes(), &getResp); err != nil {
		t.Fatalf("unmarshal get response: %v", err)
	}
	if sp, ok := getResp["systemPrompt"].(string); !ok || sp != wantPrompt {
		t.Errorf("GET response systemPrompt: got %v, want %q", getResp["systemPrompt"], wantPrompt)
	}
}

// ---------------------------------------------------------------------------
// TestContract_CreateAgent_Instructions_Ignored
// ---------------------------------------------------------------------------

// TestContract_CreateAgent_Instructions_Ignored asserts that sending the wrong
// field name "instructions" (old/incorrect API usage) does NOT populate the
// agent's system prompt. Unknown JSON fields are silently dropped.
func TestContract_CreateAgent_Instructions_Ignored(t *testing.T) {
	h := newRESTHandlerForContractTest(t)
	tok := mintContractToken(t, h)

	name := contractAgentName(t, "contract-instr")
	t.Cleanup(func() { doDeleteAgent(h, tok, name) })

	rr := doCreateAgent(h, tok, map[string]any{
		"name":         name,
		"description":  "contract test agent — wrong field",
		"instructions": "This should be silently ignored.",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /v1/agents: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	// The create response must NOT expose "systemPrompt" populated from "instructions".
	var createResp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	if sp, ok := createResp["systemPrompt"].(string); ok && sp != "" {
		t.Errorf("create response systemPrompt should be empty when 'instructions' was sent, got %q", sp)
	}

	// Read back via GET — systemPrompt must be absent or empty.
	rr2 := doGetAgent(h, tok, name)
	if rr2.Code != http.StatusOK {
		t.Fatalf("GET /v1/agents/%s: got %d, want 200; body: %s", name, rr2.Code, rr2.Body.String())
	}
	var getResp map[string]any
	if err := json.Unmarshal(rr2.Body.Bytes(), &getResp); err != nil {
		t.Fatalf("unmarshal get response: %v", err)
	}
	if sp, ok := getResp["systemPrompt"].(string); ok && sp != "" {
		t.Errorf("GET systemPrompt should be empty when only 'instructions' was sent, got %q", sp)
	}
}
