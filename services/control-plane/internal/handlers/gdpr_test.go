package handlers

// gdpr_test.go — tests for the GDPR tenant-purge handler.
//
// Unit tests (no DB): auth guards (owner-only, cross-tenant 403).
// Integration tests (DB required): cascade delete removes agents/runs.
//
// Integration tests are skipped when DATABASE_URL is not set, so
// `go test ./...` without a real DB still passes.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// mintTestJWT creates a signed JWT for the given tenantID and role using the
// dev JWT secret. Used to build authenticated test requests without a real login.
func mintTestJWT(tenantID, role string) (string, error) {
	secret := []byte(GetJWTSecret())
	now := time.Now()
	claims := LanternClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "test-user-id",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			Issuer:    "lantern",
		},
		TenantID: tenantID,
		Email:    "test@example.com",
		Name:     "Test User",
		Role:     role,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(secret)
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

func gdprTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping GDPR integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if err := db.Migrate(ctx, pool, true); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// gdprHandler returns a GDPRHandler wired to pool with a no-op logger.
func newGDPRHandlerForTest(pool *pgxpool.Pool) *GDPRHandler {
	srv := &server.Server{
		Pool:   pool,
		Logger: zap.NewNop(),
	}
	jwtSecret := GetJWTSecret()
	auth := NewAuthHandler(srv, jwtSecret)
	return NewGDPRHandler(srv, auth)
}

// signedRequest builds a DELETE /v1/tenants/{id} request with a JWT for
// the given tenant and role. It signs using the dev JWT secret directly
// so we don't need a real login round-trip.
func gdprRequest(t *testing.T, tenantID, targetID, role string) *http.Request {
	t.Helper()
	token, err := mintTestJWT(tenantID, role)
	if err != nil {
		t.Fatalf("mintTestJWT: %v", err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/v1/tenants/"+targetID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.SetPathValue("id", targetID)
	return req
}

// -----------------------------------------------------------------------
// Unit tests (no DB required)
// -----------------------------------------------------------------------

func TestGDPR_Unauthenticated_Returns401(t *testing.T) {
	pool := gdprTestDB(t)
	h := newGDPRHandlerForTest(pool)

	req := httptest.NewRequest(http.MethodDelete, "/v1/tenants/some-id", nil)
	// No Authorization header.
	rr := httptest.NewRecorder()
	h.DeleteTenant(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestGDPR_NonOwner_Returns403(t *testing.T) {
	pool := gdprTestDB(t)
	h := newGDPRHandlerForTest(pool)

	tenantID := "00000000-0000-0000-0000-000000000001"
	req := gdprRequest(t, tenantID, tenantID, "member") // not owner
	rr := httptest.NewRecorder()
	h.DeleteTenant(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for member role, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestGDPR_CrossTenant_Returns403(t *testing.T) {
	pool := gdprTestDB(t)
	h := newGDPRHandlerForTest(pool)

	myTenantID := "00000000-0000-0000-0000-000000000001"
	otherTenantID := "00000000-0000-0000-0000-000000000099"

	req := gdprRequest(t, myTenantID, otherTenantID, "owner") // owner but wrong tenant
	rr := httptest.NewRecorder()
	h.DeleteTenant(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-tenant purge, got %d: %s", rr.Code, rr.Body.String())
	}
}

// -----------------------------------------------------------------------
// Integration tests (DB required)
// -----------------------------------------------------------------------

func TestGDPR_OwnerCanPurgeSelf(t *testing.T) {
	pool := gdprTestDB(t)
	ctx := context.Background()

	// Create a fresh tenant (avoid touching the seeded dev tenant).
	var tenantID string
	err := pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ('gdpr-test', 'GDPR Test', 'personal', 'lantern-t-gdpr-test')
		RETURNING id
	`).Scan(&tenantID)
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	// Create a user in that tenant with role=owner.
	var userID string
	err = pool.QueryRow(ctx, `
		INSERT INTO users (tenant_id, email, auth_provider, auth_subject, role, password_hash)
		VALUES ($1, 'gdpr@example.com', 'local', 'gdpr@example.com', 'owner', 'x')
		RETURNING id
	`, tenantID).Scan(&userID)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}

	// Create an agent in that tenant.
	var agentID string
	err = pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, 'gdpr-agent', 'for GDPR test')
		RETURNING id
	`, tenantID).Scan(&agentID)
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}

	// Issue the purge request.
	h := newGDPRHandlerForTest(pool)
	req := gdprRequest(t, tenantID, tenantID, "owner")
	rr := httptest.NewRecorder()
	h.DeleteTenant(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	// Verify tenant row is gone.
	var count int
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM tenants WHERE id = $1`, tenantID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("tenant row not deleted")
	}

	// Verify agent row is gone.
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM agents WHERE id = $1`, agentID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("agent row not deleted after purge")
	}

	// Verify user row is gone.
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE tenant_id = $1`, tenantID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("user row not deleted after purge")
	}
}

// TestGDPR_PurgeWithRun is the regression test for the HIGH bug: deleting a
// tenant whose agents have executed runs must succeed.
//
// The original deletion order deleted agent_versions BEFORE runs, violating
// the FK: runs.agent_version_id → agent_versions(id) ON DELETE RESTRICT.
// That caused the entire transaction to roll back with a 500, leaving the
// tenant's secrets (llm_provider_configs, api_keys, connector_installs) intact.
//
// This test FAILS on the old code and PASSES after the fix.
func TestGDPR_PurgeWithRun(t *testing.T) {
	pool := gdprTestDB(t)
	ctx := context.Background()

	// Create a tenant with a unique slug to avoid conflicts between test runs.
	var tenantID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ('gdpr-run-test', 'GDPR Run Test', 'personal', 'lantern-t-gdpr-run-test')
		ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
		RETURNING id
	`).Scan(&tenantID); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	// Seed an agent.
	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, 'run-agent', 'agent with a run')
		ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, tenantID).Scan(&agentID); err != nil {
		t.Fatalf("create agent: %v", err)
	}

	// Seed an agent_version (runs.agent_version_id RESTRICT references this).
	var avID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v1', '\xdeadbeef', 's3://bucket/key', '{}')
		ON CONFLICT (agent_id, version) DO UPDATE SET bundle_uri = EXCLUDED.bundle_uri
		RETURNING id
	`, agentID).Scan(&avID); err != nil {
		t.Fatalf("create agent_version: %v", err)
	}

	// Seed a run referencing the agent and agent_version (the RESTRICT FK chain).
	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'succeeded', 'manual', '{}')
		RETURNING id
	`, tenantID, agentID, avID).Scan(&runID); err != nil {
		t.Fatalf("create run: %v", err)
	}

	// Seed a journal_events row (exercises the run_id sub-select path).
	// payload is BYTEA; pass as Go []byte.
	if _, err := pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, payload)
		VALUES ($1, 1, 'step_started', $2)
	`, runID, []byte("{}")); err != nil {
		t.Fatalf("create journal_event: %v", err)
	}

	// Seed an llm_provider_config (the "secrets must be erased" assertion).
	if _, err := pool.Exec(ctx, `
		INSERT INTO llm_provider_configs (tenant_id, provider, api_key_encrypted)
		VALUES ($1, 'openai', 'encrypted-key')
		ON CONFLICT (tenant_id, provider) DO UPDATE SET api_key_encrypted = EXCLUDED.api_key_encrypted
	`, tenantID); err != nil {
		t.Fatalf("create llm_provider_config: %v", err)
	}

	// Issue the purge — must succeed (200), not 500.
	h := newGDPRHandlerForTest(pool)
	req := gdprRequest(t, tenantID, tenantID, "owner")
	rr := httptest.NewRecorder()
	h.DeleteTenant(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("REGRESSION: purge of tenant with a run returned %d (expected 200): %s\n"+
			"This fails when agent_versions is deleted before runs (FK RESTRICT violation).",
			rr.Code, rr.Body.String())
	}

	// Verify cascade: runs deleted.
	var count int
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM runs WHERE id = $1`, runID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Error("run row not deleted after purge")
	}

	// Verify cascade: agent_versions deleted.
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM agent_versions WHERE id = $1`, avID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Error("agent_version row not deleted after purge")
	}

	// Verify cascade: journal_events deleted.
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM journal_events WHERE run_id = $1`, runID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Error("journal_events not deleted after purge")
	}

	// Verify secrets erased.
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM llm_provider_configs WHERE tenant_id = $1`, tenantID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Error("llm_provider_configs (secret) not deleted after purge")
	}

	// Verify tenant row gone.
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM tenants WHERE id = $1`, tenantID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Error("tenant row not deleted after purge")
	}
}
