package handlers

// Tests for the agent-instance Bearer token path in ResolveSecrets
// (runtime_secrets.go verifyInstanceToken + wiring in ResolveSecrets).
//
// Test strategy:
//   - Pure-function relay tests (no DB): invalid/expired/tampered Bearer tokens
//     rejected. Handler rejects before any pool access, so a nil pool is safe.
//   - DB-gated tests: valid token attributed in audit; wrong-vm token rejected;
//     wrong-tenant token rejected; no Bearer uses the existing shared-token path.
//
// All DB-gated tests are skipped when DATABASE_URL is unset.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Helpers specific to identity tests
// ---------------------------------------------------------------------------

// newTestSecretsHandlerForIdentity builds a RuntimeSecretsHandler with a nil
// pool using testJWTSecret, so agent-instance tokens issued by testIdentityIssuer
// are verifiable by the handler's embedded Issuer.
func newTestSecretsHandlerForIdentity(t *testing.T) *RuntimeSecretsHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: nil, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewRuntimeSecretsHandler(srv, auth)
}

// newTestSecretsHandlerForIdentityWithPool builds the same handler backed by a
// real pool.
func newTestSecretsHandlerForIdentityWithPool(t *testing.T, pool *pgxpool.Pool) *RuntimeSecretsHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewRuntimeSecretsHandler(srv, auth)
}

// testIdentityIssuer returns an Issuer that uses testJWTSecret as its signing
// key, matching what NewRuntimeSecretsHandler configures internally.
func testIdentityIssuer(t *testing.T) *agentidentity.Issuer {
	t.Helper()
	return agentidentity.New([]byte(testJWTSecret))
}

// doResolveWithBearer fires a POST /v1/runtime/secrets/resolve with both the
// shared runtime token header and an Authorization: Bearer header.
func doResolveWithBearer(h *RuntimeSecretsHandler, runtimeToken, bearerToken string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/secrets/resolve", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if runtimeToken != "" {
		req.Header.Set(runtimeTokenHeader, runtimeToken)
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	w := httptest.NewRecorder()
	h.ResolveSecrets(w, req)
	return w
}

// insertRuntimeVMWithInstance inserts a runtime_vms row that includes an
// agent_instance_id so verifyInstanceToken can resolve it.
func insertRuntimeVMWithInstance(t *testing.T, pool *pgxpool.Pool, tenantID, vmID, instanceID, state string) {
	t.Helper()
	if state == "" {
		state = "running"
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, agent_instance_id)
		VALUES ($1, $2::uuid, $3, '{}', $4)
		ON CONFLICT (vm_id) DO UPDATE
		  SET state = EXCLUDED.state, agent_instance_id = EXCLUDED.agent_instance_id
	`, vmID, tenantID, state, instanceID)
	if err != nil {
		t.Fatalf("insertRuntimeVMWithInstance(%q, %q, %q, %q): %v", vmID, tenantID, instanceID, state, err)
	}
}

// mustMarshal is a test-local JSON marshal helper.
func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("mustMarshal: %v", err)
	}
	return b
}

// ---------------------------------------------------------------------------
// Nil-pool tests: Bearer token rejected before any DB access
// ---------------------------------------------------------------------------

// TestResolveSecrets_BearerToken_InvalidFormat verifies that an Authorization
// header that is not "Bearer <token>" is rejected with 403.
func TestResolveSecrets_BearerToken_InvalidFormat(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentity(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/secrets/resolve",
		bytes.NewReader(mustMarshal(t, resolveSecretsRequest{
			TenantID: "tenant-1",
			VmID:     "vm-1",
			Refs:     []string{"lantern.secret/llm/anthropic"},
		})))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(runtimeTokenHeader, testRuntimeSecretToken)
	req.Header.Set("Authorization", "Token not-bearer-format")
	w := httptest.NewRecorder()
	h.ResolveSecrets(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for invalid Authorization format, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_BearerToken_EmptyToken verifies "Bearer " with no value is
// rejected.
func TestResolveSecrets_BearerToken_EmptyToken(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentity(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/secrets/resolve",
		bytes.NewReader(mustMarshal(t, resolveSecretsRequest{
			TenantID: "tenant-1",
			VmID:     "vm-1",
			Refs:     []string{"lantern.secret/llm/anthropic"},
		})))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(runtimeTokenHeader, testRuntimeSecretToken)
	req.Header.Set("Authorization", "Bearer ")
	w := httptest.NewRecorder()
	h.ResolveSecrets(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for empty Bearer token, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_BearerToken_GarbageJWT verifies that a syntactically invalid
// JWT is rejected with 403.
func TestResolveSecrets_BearerToken_GarbageJWT(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentity(t)

	w := doResolveWithBearer(h, testRuntimeSecretToken, "not.a.jwt", resolveSecretsRequest{
		TenantID: "tenant-1",
		VmID:     "vm-1",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for garbage JWT, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_BearerToken_ExpiredToken verifies that an already-expired
// agent-instance JWT is rejected even when the shared token is valid.
// Uses LANTERN_AGENT_IDENTITY_TTL=1ms so the token expires before verification.
func TestResolveSecrets_BearerToken_ExpiredToken(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	t.Setenv("LANTERN_AGENT_IDENTITY_TTL", "1ms")

	// Re-build the handler so its issuer picks up the tiny TTL.
	h := newTestSecretsHandlerForIdentity(t)

	iss := agentidentity.New([]byte(testJWTSecret))
	_, tok, err := iss.Issue(context.Background(), "tenant-1", "", "")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	time.Sleep(5 * time.Millisecond) // let the 1ms TTL lapse

	w := doResolveWithBearer(h, testRuntimeSecretToken, tok, resolveSecretsRequest{
		TenantID: "tenant-1",
		VmID:     "vm-1",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for expired token, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_NoBearer_SharedTokenStillWorks verifies that the existing
// shared-token path is completely unchanged when no Authorization header is
// present. Uses a nil pool so the handler stops at body-validation (400 for
// missing tenant_id) rather than reaching the DB, proving auth succeeded.
func TestResolveSecrets_NoBearer_SharedTokenStillWorks(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentity(t)

	w := doResolve(h, testRuntimeSecretToken, map[string]any{
		"vm_id": "vm-1",
		"refs":  []string{"lantern.secret/llm/anthropic"},
		// tenant_id intentionally absent → 400 (auth passed, body invalid)
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 (shared token works, body invalid), got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// DB-gated tests
// ---------------------------------------------------------------------------

// TestResolveSecrets_BearerToken_ValidAttributed verifies that a valid
// agent-instance Bearer token is accepted and the audit row carries agent_instance_id.
func TestResolveSecrets_BearerToken_ValidAttributed(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-inst-ok")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertLLMKey(t, pool, tenantID, "anthropic", "test-instance-attr-key")

	iss := testIdentityIssuer(t)
	instanceID, tok, err := iss.Issue(context.Background(), tenantID, "", "")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	vmID := fmt.Sprintf("vm-inst-ok-%s", instanceID[:8])
	insertRuntimeVMWithInstance(t, pool, tenantID, vmID, instanceID, "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentityWithPool(t, pool)

	w := doResolveWithBearer(h, testRuntimeSecretToken, tok, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     vmID,
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid instance token, got %d: %s", w.Code, w.Body.String())
	}

	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 || resp.Resolved[0].Value != "test-instance-attr-key" {
		t.Errorf("expected resolved value, got: %+v", resp.Resolved)
	}

	// Audit row must carry the instance id.
	var auditInstanceID *string
	if scanErr := pool.QueryRow(context.Background(), `
		SELECT agent_instance_id
		FROM runtime_audit_events
		WHERE tenant_id = $1::uuid AND vm_id = $2 AND action = 'secret_resolve'
		ORDER BY at DESC LIMIT 1
	`, tenantID, vmID).Scan(&auditInstanceID); scanErr != nil {
		t.Fatalf("audit row not found: %v", scanErr)
	}
	if auditInstanceID == nil || *auditInstanceID != instanceID {
		t.Errorf("expected agent_instance_id=%q in audit, got %v", instanceID, auditInstanceID)
	}
}

// TestResolveSecrets_BearerToken_WrongVM verifies that a valid token whose
// agent_instance_id maps to a DIFFERENT vm_id than the one in the body is
// rejected with 403.
func TestResolveSecrets_BearerToken_WrongVM(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-inst-wrongvm")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	iss := testIdentityIssuer(t)
	instanceID, tok, err := iss.Issue(context.Background(), tenantID, "", "")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// The token's instance id is registered under realVmID.
	realVmID := fmt.Sprintf("vm-real-%s", instanceID[:8])
	insertRuntimeVMWithInstance(t, pool, tenantID, realVmID, instanceID, "running")

	// The body claims otherVmID — mismatch.
	otherVmID := "vm-other-no-instance"
	insertRuntimeVM(t, pool, tenantID, otherVmID, "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentityWithPool(t, pool)

	w := doResolveWithBearer(h, testRuntimeSecretToken, tok, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     otherVmID,
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for wrong-vm instance token, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_BearerToken_WrongTenant verifies that a token issued for
// tenant B is rejected when the body claims tenant A.
func TestResolveSecrets_BearerToken_WrongTenant(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantA := uniqueTenantID("sec-inst-ta")
	tenantB := uniqueTenantID("sec-inst-tb")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	t.Cleanup(func() {
		cleanupSecretsData(t, pool, tenantA)
		cleanupSecretsData(t, pool, tenantB)
	})

	iss := testIdentityIssuer(t)
	instanceID, tok, err := iss.Issue(context.Background(), tenantB, "", "")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	vmID := fmt.Sprintf("vm-tb-%s", instanceID[:8])
	insertRuntimeVMWithInstance(t, pool, tenantB, vmID, instanceID, "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentityWithPool(t, pool)

	// Body claims tenant A; token + VM belong to tenant B.
	w := doResolveWithBearer(h, testRuntimeSecretToken, tok, resolveSecretsRequest{
		TenantID: tenantA,
		VmID:     vmID,
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for wrong-tenant instance token, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_BearerToken_NoBearer_SharedTokenPath verifies that a
// request with no Authorization header resolves refs correctly via the shared-
// token path, and the audit row has a NULL agent_instance_id.
func TestResolveSecrets_BearerToken_NoBearer_SharedTokenPath(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-inst-nobearer")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertLLMKey(t, pool, tenantID, "anthropic", "test-nobearer-key")
	insertRuntimeVM(t, pool, tenantID, "vm-nobearer", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerForIdentityWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-nobearer",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for shared-token-only path, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 || resp.Resolved[0].Value != "test-nobearer-key" {
		t.Errorf("expected resolved value on shared-token path, got: %+v", resp.Resolved)
	}

	// Audit row must NOT have an agent_instance_id (no Bearer token presented).
	var auditInstanceID *string
	if scanErr := pool.QueryRow(context.Background(), `
		SELECT agent_instance_id
		FROM runtime_audit_events
		WHERE tenant_id = $1::uuid AND vm_id = $2 AND action = 'secret_resolve'
		ORDER BY at DESC LIMIT 1
	`, tenantID, "vm-nobearer").Scan(&auditInstanceID); scanErr != nil {
		t.Fatalf("audit row not found: %v", scanErr)
	}
	if auditInstanceID != nil {
		t.Errorf("expected NULL agent_instance_id for no-Bearer request, got %q", *auditInstanceID)
	}
}
