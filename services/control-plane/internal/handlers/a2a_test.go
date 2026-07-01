package handlers

// P0.4 (SECURITY): A2A card / well-known directory / invoke must not disclose
// or invoke another tenant's PRIVATE agents. Only is_public agents are exposed
// to non-owners; a tenant always sees/cards/invokes its OWN agents.
//
// Skipped automatically when DATABASE_URL is unset. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run A2A -count=1

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newA2ATestHandler builds an A2AHandler backed by a real pool, using the
// shared testJWTSecret so mintTestToken-issued JWTs validate.
func newA2ATestHandler(t *testing.T, pool *pgxpool.Pool) *A2AHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewA2AHandler(srv, auth)
}

// seedA2ATenant inserts a fresh tenant and returns its ID. Cleanup removes it
// (ON DELETE CASCADE drops its agents too).
func seedA2ATenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ($1, $1, 'personal', 'lantern-t-' || $1)
		RETURNING id
	`, slug).Scan(&id)
	if err != nil {
		t.Fatalf("seed tenant %q: %v", slug, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// seedA2AAgent inserts an agent for tenantID with the given visibility.
func seedA2AAgent(t *testing.T, pool *pgxpool.Pool, tenantID, name string, isPublic bool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO agents (tenant_id, name, description, is_public)
		VALUES ($1, $2, 'a2a test agent', $3)
	`, tenantID, name, isPublic)
	if err != nil {
		t.Fatalf("seed agent %q (public=%v): %v", name, isPublic, err)
	}
}

func a2aGetCard(h *A2AHandler, name, tok string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/"+name+"/card", nil)
	req.SetPathValue("name", name)
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	h.GetAgentCard(w, req)
	return w
}

func a2aInvoke(h *A2AHandler, name, tok string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]any{"message": "hi"})
	req := httptest.NewRequest(http.MethodPost, "/v1/agents/"+name+"/a2a/invoke", bytes.NewReader(body))
	req.SetPathValue("name", name)
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	h.InvokeAgent(w, req)
	return w
}

func a2aDirectoryNames(t *testing.T, h *A2AHandler) map[string]bool {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/.well-known/agent.json", nil)
	w := httptest.NewRecorder()
	h.AgentDirectory(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("directory: status %d, body %s", w.Code, w.Body.String())
	}
	var resp struct {
		Agents []AgentCard `json:"agents"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("directory: decode: %v", err)
	}
	names := make(map[string]bool, len(resp.Agents))
	for _, c := range resp.Agents {
		names[c.Name] = true
	}
	return names
}

// TestA2A_PrivateAgentNotDisclosed is the core tenant-isolation assertion:
// tenant A's PRIVATE agent must not be carded anonymously / cross-tenant, must
// not appear in the anonymous directory, and must not be invocable by tenant B.
func TestA2A_PrivateAgentNotDisclosed(t *testing.T) {
	pool := openTestPool(t) // skips if DATABASE_URL unset
	h := newA2ATestHandler(t, pool)

	tenantA := seedA2ATenant(t, pool, "a2a-priv-a")
	tenantB := seedA2ATenant(t, pool, "a2a-priv-b")

	const privName = "a2a-secret-agent"
	seedA2AAgent(t, pool, tenantA, privName, false) // private

	tokB := mintTestToken(t, tenantB, "user-b", "owner")

	// 1. Anonymous card → 404 (existence not leaked).
	if w := a2aGetCard(h, privName, ""); w.Code != http.StatusNotFound {
		t.Errorf("anonymous card of private agent: got %d, want 404; body %s", w.Code, w.Body.String())
	}

	// 2. Cross-tenant card (tenant B authed) → 404.
	if w := a2aGetCard(h, privName, tokB); w.Code != http.StatusNotFound {
		t.Errorf("cross-tenant card of private agent: got %d, want 404; body %s", w.Code, w.Body.String())
	}

	// 3. Not in the anonymous well-known directory.
	if names := a2aDirectoryNames(t, h); names[privName] {
		t.Errorf("private agent %q leaked into anonymous directory", privName)
	}

	// 4. Cross-tenant invoke (tenant B authed) → 404, not executed.
	if w := a2aInvoke(h, privName, tokB); w.Code != http.StatusNotFound {
		t.Errorf("cross-tenant invoke of private agent: got %d, want 404; body %s", w.Code, w.Body.String())
	}
}

// TestA2A_PublicAgentVisible proves the positive path: an is_public agent IS
// carded anonymously, IS listed in the directory, and IS invocable cross-tenant.
func TestA2A_PublicAgentVisible(t *testing.T) {
	pool := openTestPool(t)
	h := newA2ATestHandler(t, pool)

	tenantA := seedA2ATenant(t, pool, "a2a-pub-a")
	tenantB := seedA2ATenant(t, pool, "a2a-pub-b")

	const pubName = "a2a-public-agent"
	seedA2AAgent(t, pool, tenantA, pubName, true) // public

	tokB := mintTestToken(t, tenantB, "user-b", "owner")

	// 1. Anonymous card → 200.
	if w := a2aGetCard(h, pubName, ""); w.Code != http.StatusOK {
		t.Errorf("anonymous card of public agent: got %d, want 200; body %s", w.Code, w.Body.String())
	}

	// 2. Listed in the directory.
	if names := a2aDirectoryNames(t, h); !names[pubName] {
		t.Errorf("public agent %q missing from directory", pubName)
	}

	// 3. Cross-tenant invoke (tenant B authed) → 501 (not yet wired; must NOT be
	//    a fabricated 200 "completed" response when no agent actually ran).
	if w := a2aInvoke(h, pubName, tokB); w.Code != http.StatusNotImplemented {
		t.Errorf("cross-tenant invoke of public agent: got %d, want 501; body %s", w.Code, w.Body.String())
	}
}

// TestA2A_OwnerSeesOwnPrivateAgent proves a tenant can always card + invoke
// its OWN private agent (visibility check is own-OR-public, not own-AND-public).
func TestA2A_OwnerSeesOwnPrivateAgent(t *testing.T) {
	pool := openTestPool(t)
	h := newA2ATestHandler(t, pool)

	tenantA := seedA2ATenant(t, pool, "a2a-own-a")

	const privName = "a2a-own-private"
	seedA2AAgent(t, pool, tenantA, privName, false) // private

	tokA := mintTestToken(t, tenantA, "user-a", "owner")

	if w := a2aGetCard(h, privName, tokA); w.Code != http.StatusOK {
		t.Errorf("owner card of own private agent: got %d, want 200; body %s", w.Code, w.Body.String())
	}
	// Invoke returns 501 (not yet wired to real execution), not a fabricated 200.
	if w := a2aInvoke(h, privName, tokA); w.Code != http.StatusNotImplemented {
		t.Errorf("owner invoke of own private agent: got %d, want 501; body %s", w.Code, w.Body.String())
	}
}
