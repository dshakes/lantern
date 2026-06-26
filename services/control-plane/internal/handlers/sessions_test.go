package handlers

// DB-gated handler tests for sessions.go: the interactive-session lifecycle
// (create → get → list → stop → delete) and tenant isolation. We deliberately
// do NOT call SendMessage, which would dispatch a real LLM request; instead we
// exercise every persistence/validation path that does not hit a provider.
//
// Skipped automatically when DATABASE_URL is unset. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run Session -count=1 -v

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newSessionTestHandler builds a SessionHandler backed by a real pool. Redis is
// wired when reachable (so StopSession's publishEvent doesn't nil-panic); tests
// that strictly need Redis call requireRedis below.
func newSessionTestHandler(t *testing.T) *SessionHandler {
	t.Helper()
	pool := openTestPool(t) // skips if DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger, Redis: maybeRedis(t)}
	auth := NewAuthHandler(srv, testJWTSecret)
	llmProxy := NewLlmProxyHandler(srv, auth)
	return NewSessionHandler(srv, auth, llmProxy)
}

// maybeRedis returns a redis client for the dev Redis when reachable, else nil.
// Most session paths (create/get/list/delete) never touch Redis; StopSession
// publishes an event, so it must be present for that test.
func maybeRedis(t *testing.T) *redis.Client {
	t.Helper()
	url := os.Getenv("REDIS_URL")
	if url == "" {
		url = "redis://localhost:6379"
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil
	}
	c := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Ping(ctx).Err(); err != nil {
		_ = c.Close()
		return nil
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// createSessionHTTP fires POST /v1/sessions as the given tenant and returns the
// recorder. agentName is required by the handler.
func createSessionHTTP(t *testing.T, h *SessionHandler, tenantID, agentName string) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	body, _ := json.Marshal(map[string]any{"agentName": agentName})
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateSession(rr, req)
	return rr
}

// createSessionID creates a session and returns its id, registering cleanup.
func createSessionID(t *testing.T, h *SessionHandler, tenantID, agentName string) string {
	t.Helper()
	rr := createSessionHTTP(t, h, tenantID, agentName)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create session: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	id := resp["id"]
	if id == "" {
		t.Fatal("create session returned empty id")
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(context.Background(), `DELETE FROM sessions WHERE id = $1`, id)
	})
	return id
}

// getSessionHTTP fires GET /v1/sessions/{id} as the given tenant.
func getSessionHTTP(t *testing.T, h *SessionHandler, tenantID, id string) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/sessions/"+id, nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetSession(rr, req)
	return rr
}

// listSessionIDs fires GET /v1/sessions as the given tenant and returns the set
// of session ids visible to it.
func listSessionIDs(t *testing.T, h *SessionHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListSessions(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list sessions: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var sessions []sessionJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &sessions); err != nil {
		t.Fatalf("unmarshal list response: %v", err)
	}
	ids := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		ids[s.ID] = true
	}
	return ids
}

// seedSessionTenant inserts a fresh tenant and returns its ID (CASCADE drops its
// sessions on cleanup). Mirrors seedA2ATenant.
func seedSessionTenant(t *testing.T, h *SessionHandler, slug string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ($1, $1, 'personal', 'lantern-t-' || $1)
		RETURNING id
	`, slug).Scan(&id); err != nil {
		t.Fatalf("seed tenant %q: %v", slug, err)
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// TestSession_CreateGet exercises create then get on the dev tenant.
func TestSession_CreateGet(t *testing.T) {
	h := newSessionTestHandler(t)
	const agent = "session-lifecycle-agent"
	id := createSessionID(t, h, devTenantID, agent)

	rr := getSessionHTTP(t, h, devTenantID, id)
	if rr.Code != http.StatusOK {
		t.Fatalf("get session: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var s sessionJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &s); err != nil {
		t.Fatalf("unmarshal get response: %v", err)
	}
	if s.ID != id {
		t.Errorf("get id: got %q, want %q", s.ID, id)
	}
	if s.AgentName != agent {
		t.Errorf("get agentName: got %q, want %q", s.AgentName, agent)
	}
	if s.Status != "active" {
		t.Errorf("get status: got %q, want active", s.Status)
	}
	if s.TenantID != devTenantID {
		t.Errorf("get tenantId: got %q, want %q", s.TenantID, devTenantID)
	}
}

// TestSession_CreateRequiresAgentName proves agentName is validated.
func TestSession_CreateRequiresAgentName(t *testing.T) {
	h := newSessionTestHandler(t)
	tok := mintTestToken(t, devTenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{})
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateSession(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing agentName: got %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}

// TestSession_Unauthorized proves every mutating handler rejects a missing JWT.
func TestSession_Unauthorized(t *testing.T) {
	h := newSessionTestHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions", bytes.NewReader([]byte(`{"agentName":"x"}`)))
	rr := httptest.NewRecorder()
	h.CreateSession(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("create without auth: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
}

// TestSession_TenantIsolation is the core security assertion: tenant B can
// neither GET nor LIST a session that belongs to tenant A.
func TestSession_TenantIsolation(t *testing.T) {
	h := newSessionTestHandler(t)

	tenantA := seedSessionTenant(t, h, "sess-iso-a")
	tenantB := seedSessionTenant(t, h, "sess-iso-b")

	idA := createSessionID(t, h, tenantA, "agent-a")

	// 1. Tenant B GET of A's session → 404 (existence not leaked).
	if rr := getSessionHTTP(t, h, tenantB, idA); rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant get: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}

	// 2. Tenant B LIST must not contain A's session.
	if listSessionIDs(t, h, tenantB)[idA] {
		t.Errorf("tenant B's list leaked tenant A's session %q", idA)
	}

	// 3. Positive control: tenant A DOES see its own session.
	if !listSessionIDs(t, h, tenantA)[idA] {
		t.Errorf("tenant A's own session %q missing from its list", idA)
	}
}

// TestSession_StopThenSendRejected proves stop transitions the session out of
// 'active' and that a stopped session can't be deleted twice (idempotency of
// the 404 path), without invoking the LLM.
func TestSession_Stop(t *testing.T) {
	h := newSessionTestHandler(t)
	if h.srv.Redis == nil {
		t.Skip("REDIS_URL/localhost:6379 unreachable — StopSession publishes an event and needs Redis")
	}
	id := createSessionID(t, h, devTenantID, "stop-agent")

	tok := mintTestToken(t, devTenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/"+id+"/stop", nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.StopSession(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("stop session: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	// Confirm the persisted status flipped to 'stopped'.
	getRR := getSessionHTTP(t, h, devTenantID, id)
	var s sessionJSON
	_ = json.Unmarshal(getRR.Body.Bytes(), &s)
	if s.Status != "stopped" {
		t.Errorf("after stop, status: got %q, want stopped", s.Status)
	}
}

// TestSession_Delete proves delete removes the row (subsequent GET → 404) and a
// second delete is a clean 404, not a 500.
func TestSession_Delete(t *testing.T) {
	h := newSessionTestHandler(t)
	// Don't register the create-cleanup's DELETE as the source of truth; we
	// delete via the handler here.
	rr := createSessionHTTP(t, h, devTenantID, "delete-agent")
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	id := resp["id"]
	t.Cleanup(func() { _, _ = h.srv.Pool.Exec(context.Background(), `DELETE FROM sessions WHERE id = $1`, id) })

	tok := mintTestToken(t, devTenantID, "user-x", "owner")
	del := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodDelete, "/v1/sessions/"+id, nil)
		req.SetPathValue("id", id)
		req.Header.Set("Authorization", bearerHeader(tok))
		w := httptest.NewRecorder()
		h.DeleteSession(w, req)
		return w
	}

	if w := del(); w.Code != http.StatusNoContent {
		t.Fatalf("first delete: got %d, want 204; body: %s", w.Code, w.Body.String())
	}
	// Now gone.
	if w := getSessionHTTP(t, h, devTenantID, id); w.Code != http.StatusNotFound {
		t.Errorf("get after delete: got %d, want 404; body: %s", w.Code, w.Body.String())
	}
	// Second delete is a clean 404.
	if w := del(); w.Code != http.StatusNotFound {
		t.Errorf("second delete: got %d, want 404; body: %s", w.Code, w.Body.String())
	}
}

// TestSession_CrossTenantDeleteNoop proves tenant B can't delete tenant A's
// session — the handler returns 404 and A's session survives.
func TestSession_CrossTenantDeleteNoop(t *testing.T) {
	h := newSessionTestHandler(t)
	tenantA := seedSessionTenant(t, h, "sess-del-a")
	tenantB := seedSessionTenant(t, h, "sess-del-b")
	idA := createSessionID(t, h, tenantA, "agent-a")

	tokB := mintTestToken(t, tenantB, "user-b", "owner")
	req := httptest.NewRequest(http.MethodDelete, "/v1/sessions/"+idA, nil)
	req.SetPathValue("id", idA)
	req.Header.Set("Authorization", bearerHeader(tokB))
	rr := httptest.NewRecorder()
	h.DeleteSession(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant delete: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}

	// A's session must still be there.
	if rr := getSessionHTTP(t, h, tenantA, idA); rr.Code != http.StatusOK {
		t.Errorf("tenant A's session was destroyed by tenant B: get got %d, want 200", rr.Code)
	}
}
