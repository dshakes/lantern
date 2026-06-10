package handlers

// Tests for RuntimeSecretsHandler (runtime_secrets.go).
//
// Test strategy mirrors runtime_test.go:
//   - Pure-function tests (parseRef grammar table, tokenHash) — no infrastructure.
//   - HTTP handler tests that never reach the DB (nil pool safe): relay-disabled,
//     wrong token, no header, bad JSON, missing fields, body too large, too many
//     refs, rate-limit on auth failures.
//   - DB-gated integration tests (skipped without DATABASE_URL): LLM ref, connector
//     config ref, connector oauth ref, unknown refs, tenant isolation (LLM + connector
//     + oauth), audit event written with no secret value in attrs.
//
// SECURITY invariants verified:
//   - plaintext secret values never appear in audit attrs
//   - tenant A cannot resolve tenant B's secrets (LLM, config, oauth)
//   - relay-disabled (env unset) returns 403 before any body parsing

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const testRuntimeSecretToken = "test-runtime-secret-token-do-not-use"

// newTestSecretsHandler builds a RuntimeSecretsHandler with a nil pool.
// Safe for tests that never reach the DB.
func newTestSecretsHandler(t *testing.T) *RuntimeSecretsHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: nil, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewRuntimeSecretsHandler(srv, auth)
}

// newTestSecretsHandlerWithPool builds a handler backed by a real pool.
func newTestSecretsHandlerWithPool(t *testing.T, pool *pgxpool.Pool) *RuntimeSecretsHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewRuntimeSecretsHandler(srv, auth)
}

// doResolve fires a POST /v1/runtime/secrets/resolve with the given token
// header value and JSON body, returning the recorder.
func doResolve(h *RuntimeSecretsHandler, token string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/secrets/resolve", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set(runtimeTokenHeader, token)
	}
	w := httptest.NewRecorder()
	h.ResolveSecrets(w, req)
	return w
}

// ---------------------------------------------------------------------------
// Pure-function tests — no DB, no network
// ---------------------------------------------------------------------------

func TestParseRef_Grammar(t *testing.T) {
	cases := []struct {
		input    string
		scope    string
		provider string
		install  string
		key      string
	}{
		// Valid LLM refs
		{"lantern.secret/llm/anthropic", "llm", "anthropic", "", ""},
		{"lantern.secret/llm/openai", "llm", "openai", "", ""},
		{"lantern.secret/llm/gemini", "llm", "gemini", "", ""},
		// Valid connector config refs
		{
			"lantern.secret/connector/11111111-1111-1111-1111-111111111111/apiKey",
			"connector", "", "11111111-1111-1111-1111-111111111111", "apiKey",
		},
		{
			"lantern.secret/connector/abc/myKey",
			"connector", "", "abc", "myKey",
		},
		// Valid connector oauth ref (reserved key name)
		{
			"lantern.secret/connector/11111111-1111-1111-1111-111111111111/oauth",
			"connector", "", "11111111-1111-1111-1111-111111111111", "oauth",
		},
		// Missing prefix
		{"", "", "", "", ""},
		{"not-a-ref", "", "", "", ""},
		{"lantern.secret/", "", "", "", ""},
		// LLM with no provider
		{"lantern.secret/llm/", "", "", "", ""},
		{"lantern.secret/llm", "", "", "", ""},
		// Connector with missing parts
		{"lantern.secret/connector/only-id", "", "", "", ""},
		{"lantern.secret/connector//key", "", "", "", ""},
		{"lantern.secret/connector/id/", "", "", "", ""},
		// Unknown scope
		{"lantern.secret/vault/something", "", "", "", ""},
	}

	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			p := parseRef(tc.input)
			if p.scope != tc.scope {
				t.Errorf("scope: got %q, want %q", p.scope, tc.scope)
			}
			if p.provider != tc.provider {
				t.Errorf("provider: got %q, want %q", p.provider, tc.provider)
			}
			if p.installID != tc.install {
				t.Errorf("installID: got %q, want %q", p.installID, tc.install)
			}
			if p.configKey != tc.key {
				t.Errorf("configKey: got %q, want %q", p.configKey, tc.key)
			}
		})
	}
}

// TestTokenHash_FixedSize verifies that tokenHash always returns 32 bytes.
func TestTokenHash_FixedSize(t *testing.T) {
	cases := []string{"", "a", "short", strings.Repeat("x", 256)}
	for _, s := range cases {
		h := tokenHash(s)
		if len(h) != 32 {
			t.Errorf("tokenHash(%q) len = %d, want 32", s, len(h))
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP handler tests — nil pool safe (no DB reached)
// ---------------------------------------------------------------------------

// TestResolveSecrets_RelayDisabled verifies fail-closed: unset env → 403.
func TestResolveSecrets_RelayDisabled(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, "")
	h := newTestSecretsHandler(t)

	w := doResolve(h, "any-token", resolveSecretsRequest{
		TenantID: "tenant-1",
		VmID:     "vm-1",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 when relay disabled, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "relay disabled" {
		t.Errorf("expected error=relay disabled, got %v", resp)
	}
}

// TestResolveSecrets_WrongToken verifies that a mismatched token gets 403.
func TestResolveSecrets_WrongToken(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	w := doResolve(h, "wrong-token", resolveSecretsRequest{
		TenantID: "tenant-1",
		VmID:     "vm-1",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for wrong token, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_NoTokenHeader verifies absent header → 403.
func TestResolveSecrets_NoTokenHeader(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	// Pass "" so doResolve skips setting the header.
	w := doResolve(h, "", resolveSecretsRequest{
		TenantID: "tenant-1",
		VmID:     "vm-1",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 with no token header, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_RateLimit verifies that > secretAuthFailMax failures from
// the same IP within the window returns 429.
func TestResolveSecrets_RateLimit(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	body := resolveSecretsRequest{
		TenantID: "tenant-1",
		VmID:     "vm-1",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	}

	// Fire secretAuthFailMax+1 requests with a wrong token.
	var lastCode int
	for i := 0; i <= secretAuthFailMax; i++ {
		w := doResolve(h, "wrong-token", body)
		lastCode = w.Code
	}
	if lastCode != http.StatusTooManyRequests {
		t.Errorf("expected 429 after %d failures, got %d", secretAuthFailMax+1, lastCode)
	}
}

// TestResolveSecrets_RateLimit_CorrectTokenStillWorks verifies that the right
// token is never rate-limited (only failures accumulate).
func TestResolveSecrets_RateLimit_CorrectTokenStillWorks(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	// Use a handler with a nil pool: the correct token passes auth, then the
	// missing tenant_id returns 400 before the pool is touched.
	h := newTestSecretsHandler(t)

	// Burn through the limit with wrong tokens.
	for i := 0; i < secretAuthFailMax+5; i++ {
		doResolve(h, "wrong-token", map[string]any{"tenant_id": "t", "vm_id": "v", "refs": []string{"r"}})
	}

	// A correct-token request should still reach validation (400 for missing
	// tenant_id, not 429).
	w := doResolve(h, testRuntimeSecretToken, map[string]any{
		"vm_id": "vm-1",
		"refs":  []string{"lantern.secret/llm/anthropic"},
		// tenant_id intentionally omitted → 400
	})
	if w.Code == http.StatusTooManyRequests {
		t.Error("correct token must not be rate-limited")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing tenant_id, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_BadJSON verifies malformed JSON → 400.
func TestResolveSecrets_BadJSON(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/secrets/resolve",
		strings.NewReader("not json {"))
	req.Header.Set(runtimeTokenHeader, testRuntimeSecretToken)
	w := httptest.NewRecorder()
	h.ResolveSecrets(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for bad JSON, got %d", w.Code)
	}
}

// TestResolveSecrets_BodyTooLarge verifies that a body > 64 KiB returns 400.
func TestResolveSecrets_BodyTooLarge(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	// Build a body that is just over the limit.
	large := strings.Repeat("x", secretBodyLimit+1)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/secrets/resolve",
		strings.NewReader(large))
	req.Header.Set(runtimeTokenHeader, testRuntimeSecretToken)
	w := httptest.NewRecorder()
	h.ResolveSecrets(w, req)

	// MaxBytesReader causes json.Decoder to return an error, which → 400.
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for oversized body, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_TooManyRefs verifies refs > 64 → 400.
func TestResolveSecrets_TooManyRefs(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	refs := make([]string, secretMaxRefs+1)
	for i := range refs {
		refs[i] = "lantern.secret/llm/anthropic"
	}
	w := doResolve(h, testRuntimeSecretToken, map[string]any{
		"tenant_id": "tenant-1",
		"vm_id":     "vm-1",
		"refs":      refs,
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for too many refs, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "too many refs") {
		t.Errorf("expected error mentioning 'too many refs', got: %s", w.Body.String())
	}
}

// TestResolveSecrets_MissingTenantID verifies 400 when tenant_id is absent.
func TestResolveSecrets_MissingTenantID(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	w := doResolve(h, testRuntimeSecretToken, map[string]any{
		"vm_id": "vm-1",
		"refs":  []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing tenant_id, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "tenant_id") {
		t.Errorf("error should mention tenant_id, got: %s", w.Body.String())
	}
}

// TestResolveSecrets_MissingVmID verifies 400 when vm_id is absent.
func TestResolveSecrets_MissingVmID(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	w := doResolve(h, testRuntimeSecretToken, map[string]any{
		"tenant_id": "tenant-1",
		"refs":      []string{"lantern.secret/llm/anthropic"},
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing vm_id, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "vm_id") {
		t.Errorf("error should mention vm_id, got: %s", w.Body.String())
	}
}

// TestResolveSecrets_EmptyRefs verifies 400 when refs is empty.
func TestResolveSecrets_EmptyRefs(t *testing.T) {
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandler(t)

	w := doResolve(h, testRuntimeSecretToken, map[string]any{
		"tenant_id": "tenant-1",
		"vm_id":     "vm-1",
		"refs":      []string{},
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty refs, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// DB-backed integration tests — skipped when DATABASE_URL is unset
// ---------------------------------------------------------------------------

// migrateSecretsTables verifies the tables the secret relay tests depend on
// exist in the DB. The real schema is created by internal/db/migrate.go at
// control-plane startup; the dev-infra stack has already applied it.
// This function fast-fails with a clear message if a table is absent.
func migrateSecretsTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, tbl := range []string{
		"runtime_audit_events",
		"llm_provider_configs",
		"connector_installs",
		"runtime_vms",
	} {
		var exists bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1)`,
			tbl).Scan(&exists)
		if err != nil {
			t.Fatalf("migrateSecretsTables: check %s: %v", tbl, err)
		}
		if !exists {
			t.Fatalf("migrateSecretsTables: table %q not found — run 'make dev-infra && make run-api' to apply migrations", tbl)
		}
	}
}

// cleanupSecretsData removes test rows from the secrets-related tables.
func cleanupSecretsData(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	for _, tbl := range []string{
		"runtime_audit_events",
		"llm_provider_configs",
		"connector_installs",
		"runtime_vms",
	} {
		_, _ = pool.Exec(ctx, "DELETE FROM "+tbl+" WHERE tenant_id = $1::uuid", tenantID)
	}
}

// insertRuntimeVM inserts a minimal runtime_vms row for the given tenant and
// returns the vm_id. state defaults to 'running' (a live, non-terminal state).
// Use state="" to get the default.
func insertRuntimeVM(t *testing.T, pool *pgxpool.Pool, tenantID, vmID, state string) string {
	t.Helper()
	if state == "" {
		state = "running"
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec)
		VALUES ($1, $2::uuid, $3, '{}')
		ON CONFLICT (vm_id) DO UPDATE SET state = EXCLUDED.state
	`, vmID, tenantID, state)
	if err != nil {
		t.Fatalf("insertRuntimeVM(%q, %q, %q): %v", vmID, tenantID, state, err)
	}
	return vmID
}

// insertLLMKey inserts an AES-256-GCM encrypted LLM API key for a tenant.
func insertLLMKey(t *testing.T, pool *pgxpool.Pool, tenantID, provider, plainKey string) {
	t.Helper()
	enc, err := secrets.EncryptString(plainKey)
	if err != nil {
		t.Fatalf("insertLLMKey: encrypt: %v", err)
	}
	_, err = pool.Exec(context.Background(), `
		INSERT INTO llm_provider_configs (tenant_id, provider, api_key_encrypted, status)
		VALUES ($1::uuid, $2, $3, 'active')
		ON CONFLICT (tenant_id, provider) DO UPDATE
		  SET api_key_encrypted = EXCLUDED.api_key_encrypted, status = 'active'
	`, tenantID, provider, enc)
	if err != nil {
		t.Fatalf("insertLLMKey: %v", err)
	}
}

// insertConnectorConfig inserts a connector install with an encrypted config
// JSONB for a tenant. Returns the generated install ID (TEXT).
func insertConnectorConfig(t *testing.T, pool *pgxpool.Pool, tenantID, connectorID string, configMap map[string]any) string {
	t.Helper()
	configJSON, _ := json.Marshal(configMap)
	enc, err := secrets.EncryptString(string(configJSON))
	if err != nil {
		t.Fatalf("insertConnectorConfig: encrypt: %v", err)
	}
	var id string
	err = pool.QueryRow(context.Background(), `
		INSERT INTO connector_installs (tenant_id, connector_id, display_name, config)
		VALUES ($1::uuid, $2, $2, $3::jsonb)
		ON CONFLICT (tenant_id, connector_id) DO UPDATE
		  SET config = EXCLUDED.config
		RETURNING id
	`, tenantID, connectorID, enc).Scan(&id)
	if err != nil {
		t.Fatalf("insertConnectorConfig: %v", err)
	}
	return id
}

// insertConnectorOAuth inserts a connector install with an encrypted
// oauth_token_encrypted JSONB value. Returns the install ID.
func insertConnectorOAuth(t *testing.T, pool *pgxpool.Pool, tenantID, connectorID string, tokenMap map[string]any) string {
	t.Helper()
	tokenJSON, _ := json.Marshal(tokenMap)
	enc, err := secrets.EncryptString(string(tokenJSON))
	if err != nil {
		t.Fatalf("insertConnectorOAuth: encrypt: %v", err)
	}
	var id string
	err = pool.QueryRow(context.Background(), `
		INSERT INTO connector_installs (tenant_id, connector_id, display_name, config, oauth_token_encrypted)
		VALUES ($1::uuid, $2, $2, '{}', $3::jsonb)
		ON CONFLICT (tenant_id, connector_id) DO UPDATE
		  SET oauth_token_encrypted = EXCLUDED.oauth_token_encrypted
		RETURNING id
	`, tenantID, connectorID, enc).Scan(&id)
	if err != nil {
		t.Fatalf("insertConnectorOAuth: %v", err)
	}
	return id
}

// ---------------------------------------------------------------------------
// DB-gated: LLM resolution
// ---------------------------------------------------------------------------

func TestResolveSecrets_LLMRef_Resolves(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-llm")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertLLMKey(t, pool, tenantID, "anthropic", "test-llm-plaintext-key")
	insertRuntimeVM(t, pool, tenantID, "vm-llm-test", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-llm-test",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 resolved ref, got %d", len(resp.Resolved))
	}
	r := resp.Resolved[0]
	if r.Error != "" {
		t.Errorf("expected no error, got: %s", r.Error)
	}
	if r.Value != "test-llm-plaintext-key" {
		t.Errorf("expected plaintext key, got: %q", r.Value)
	}
}

// ---------------------------------------------------------------------------
// DB-gated: connector config resolution
// ---------------------------------------------------------------------------

func TestResolveSecrets_ConnectorConfigRef_Resolves(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-conn-cfg")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	installID := insertConnectorConfig(t, pool, tenantID, "slack-cfg", map[string]any{
		"botToken": "test-connector-bot-token",
		"teamID":   "T12345",
	})
	insertRuntimeVM(t, pool, tenantID, "vm-conn-cfg-test", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	ref := "lantern.secret/connector/" + installID + "/botToken"
	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-conn-cfg-test",
		Refs:     []string{ref},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 resolved ref, got %d", len(resp.Resolved))
	}
	r := resp.Resolved[0]
	if r.Error != "" {
		t.Errorf("expected no error, got: %s", r.Error)
	}
	if r.Value != "test-connector-bot-token" {
		t.Errorf("expected botToken value, got: %q", r.Value)
	}
}

// ---------------------------------------------------------------------------
// DB-gated: connector oauth resolution
// ---------------------------------------------------------------------------

func TestResolveSecrets_ConnectorOAuthRef_Resolves(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-conn-oauth")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	tokenData := map[string]any{
		"access_token":  "test-access-token-value",
		"refresh_token": "test-refresh-token-value",
		"token_type":    "Bearer",
	}
	installID := insertConnectorOAuth(t, pool, tenantID, "google-oauth", tokenData)
	insertRuntimeVM(t, pool, tenantID, "vm-conn-oauth-test", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	ref := "lantern.secret/connector/" + installID + "/oauth"
	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-conn-oauth-test",
		Refs:     []string{ref},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 resolved ref, got %d", len(resp.Resolved))
	}
	r := resp.Resolved[0]
	if r.Error != "" {
		t.Errorf("expected no error, got: %s", r.Error)
	}
	// The resolved value is the raw decrypted JSON; it must contain the token.
	if !strings.Contains(r.Value, "test-access-token-value") {
		t.Errorf("resolved oauth value must contain access_token, got: %q", r.Value)
	}
}

// TestResolveSecrets_ConnectorOAuth_NullColumn verifies that a connector
// without an oauth token returns "not found", not an error.
func TestResolveSecrets_ConnectorOAuth_NullColumn(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-conn-oauth-null")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	// Insert connector with config only, no oauth token.
	installID := insertConnectorConfig(t, pool, tenantID, "no-oauth-connector", map[string]any{
		"someKey": "someValue",
	})
	insertRuntimeVM(t, pool, tenantID, "vm-null-oauth", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	ref := "lantern.secret/connector/" + installID + "/oauth"
	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-null-oauth",
		Refs:     []string{ref},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(resp.Resolved))
	}
	if resp.Resolved[0].Error != "not found" {
		t.Errorf("expected not found for null oauth column, got error=%q value=%q",
			resp.Resolved[0].Error, resp.Resolved[0].Value)
	}
}

// ---------------------------------------------------------------------------
// DB-gated: unknown refs
// ---------------------------------------------------------------------------

func TestResolveSecrets_UnknownRef_ReturnsNotFound(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-unknown")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertRuntimeVM(t, pool, tenantID, "vm-unknown", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-unknown",
		Refs: []string{
			"lantern.secret/llm/no-such-provider",
			"lantern.secret/vault/something",
			"not-a-ref-at-all",
		},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(resp.Resolved))
	}
	for _, r := range resp.Resolved {
		if r.Error != "not found" {
			t.Errorf("ref %q: expected error=not found, got error=%q value=%q", r.Ref, r.Error, r.Value)
		}
	}
}

// ---------------------------------------------------------------------------
// DB-gated: tenant isolation
// ---------------------------------------------------------------------------

// TestResolveSecrets_TenantIsolation_LLM verifies that tenant A cannot resolve
// tenant B's LLM key via a body-supplied tenant_id.
func TestResolveSecrets_TenantIsolation_LLM(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantA := uniqueTenantID("sec-iso-llm-A")
	tenantB := uniqueTenantID("sec-iso-llm-B")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	t.Cleanup(func() {
		cleanupSecretsData(t, pool, tenantA)
		cleanupSecretsData(t, pool, tenantB)
	})

	insertLLMKey(t, pool, tenantB, "openai", "openai-secret-for-tenant-B")
	insertRuntimeVM(t, pool, tenantA, "vm-iso-llm", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantA, // A's ID in body
		VmID:     "vm-iso-llm",
		Refs:     []string{"lantern.secret/llm/openai"},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(resp.Resolved))
	}
	r := resp.Resolved[0]
	if r.Value == "openai-secret-for-tenant-B" {
		t.Error("SECURITY: tenant A resolved tenant B's LLM secret — isolation failure")
	}
	if r.Error != "not found" {
		t.Errorf("expected not found, got error=%q value=%q", r.Error, r.Value)
	}
}

// TestResolveSecrets_TenantIsolation_ConnectorConfig verifies connector config
// isolation: A cannot resolve B's install using B's install ID.
func TestResolveSecrets_TenantIsolation_ConnectorConfig(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantA := uniqueTenantID("sec-iso-cfg-A")
	tenantB := uniqueTenantID("sec-iso-cfg-B")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	t.Cleanup(func() {
		cleanupSecretsData(t, pool, tenantA)
		cleanupSecretsData(t, pool, tenantB)
	})

	installID := insertConnectorConfig(t, pool, tenantB, "notion-iso", map[string]any{
		"apiKey": "notion-secret-key-for-tenant-B",
	})
	insertRuntimeVM(t, pool, tenantA, "vm-iso-cfg", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	ref := "lantern.secret/connector/" + installID + "/apiKey"
	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantA,
		VmID:     "vm-iso-cfg",
		Refs:     []string{ref},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(resp.Resolved))
	}
	r := resp.Resolved[0]
	if r.Value == "notion-secret-key-for-tenant-B" {
		t.Error("SECURITY: tenant A resolved tenant B's connector config — isolation failure")
	}
	if r.Error != "not found" {
		t.Errorf("expected not found, got error=%q value=%q", r.Error, r.Value)
	}
}

// TestResolveSecrets_TenantIsolation_ConnectorOAuth verifies OAuth token
// isolation: A cannot resolve B's oauth token using B's install ID.
func TestResolveSecrets_TenantIsolation_ConnectorOAuth(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantA := uniqueTenantID("sec-iso-oauth-A")
	tenantB := uniqueTenantID("sec-iso-oauth-B")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	t.Cleanup(func() {
		cleanupSecretsData(t, pool, tenantA)
		cleanupSecretsData(t, pool, tenantB)
	})

	installID := insertConnectorOAuth(t, pool, tenantB, "gmail-iso", map[string]any{
		"access_token": "tenant-B-gmail-token",
	})
	insertRuntimeVM(t, pool, tenantA, "vm-iso-oauth", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	ref := "lantern.secret/connector/" + installID + "/oauth"
	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantA,
		VmID:     "vm-iso-oauth",
		Refs:     []string{ref},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Resolved) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(resp.Resolved))
	}
	r := resp.Resolved[0]
	if strings.Contains(r.Value, "tenant-B-gmail-token") {
		t.Error("SECURITY: tenant A resolved tenant B's OAuth token — isolation failure")
	}
	if r.Error != "not found" {
		t.Errorf("expected not found, got error=%q value=%q", r.Error, r.Value)
	}
}

// ---------------------------------------------------------------------------
// DB-gated: audit event
// ---------------------------------------------------------------------------

func TestResolveSecrets_AuditEventWritten(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-audit")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	const testPlainKey = "test-audit-llm-key"
	insertLLMKey(t, pool, tenantID, "anthropic", testPlainKey)

	vmID := "vm-audit-secrets-1"
	insertRuntimeVM(t, pool, tenantID, vmID, "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	ref := "lantern.secret/llm/anthropic"

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     vmID,
		Refs:     []string{ref},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var action string
	var attrsJSON []byte
	err := pool.QueryRow(context.Background(), `
		SELECT action, attrs FROM runtime_audit_events
		WHERE tenant_id = $1::uuid AND vm_id = $2 AND action = 'secret_resolve'
		ORDER BY at DESC LIMIT 1
	`, tenantID, vmID).Scan(&action, &attrsJSON)
	if err != nil {
		t.Fatalf("audit event not found: %v", err)
	}
	if action != "secret_resolve" {
		t.Errorf("expected action=secret_resolve, got %q", action)
	}

	var attrs map[string]any
	if err := json.Unmarshal(attrsJSON, &attrs); err != nil {
		t.Fatalf("parse audit attrs: %v", err)
	}

	// ref_names must contain the ref string.
	refNamesRaw, ok := attrs["ref_names"]
	if !ok {
		t.Fatal("audit attrs must contain ref_names")
	}
	refNamesStr := func() string {
		var parts []string
		if arr, ok := refNamesRaw.([]any); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok {
					parts = append(parts, s)
				}
			}
		}
		return strings.Join(parts, ",")
	}()
	if !strings.Contains(refNamesStr, "lantern.secret/llm/anthropic") {
		t.Errorf("ref_names must contain the ref, got: %v", refNamesRaw)
	}

	// SECURITY: plaintext value must NOT appear in audit attrs.
	if strings.Contains(string(attrsJSON), testPlainKey) {
		t.Error("SECURITY: plaintext secret value found in audit attrs — must never be logged")
	}

	count, _ := attrs["resolved_count"].(float64)
	if int(count) != 1 {
		t.Errorf("expected resolved_count=1, got %v", attrs["resolved_count"])
	}
}

// ---------------------------------------------------------------------------
// DB-gated: mixed refs partial resolution
// ---------------------------------------------------------------------------

func TestResolveSecrets_MixedRefs_PartialResolution(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-mixed")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertLLMKey(t, pool, tenantID, "anthropic", "test-mixed-llm-key")
	insertRuntimeVM(t, pool, tenantID, "vm-mixed", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	refs := []string{
		"lantern.secret/llm/anthropic",        // exists
		"lantern.secret/llm/no-such-provider", // does not exist
		"not-a-valid-ref",                     // bad format
	}
	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-mixed",
		Refs:     refs,
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(resp.Resolved))
	}

	byRef := map[string]resolvedRef{}
	for _, r := range resp.Resolved {
		byRef[r.Ref] = r
	}

	if byRef["lantern.secret/llm/anthropic"].Value != "test-mixed-llm-key" {
		t.Errorf("anthropic ref: expected value, got error=%q", byRef["lantern.secret/llm/anthropic"].Error)
	}
	if byRef["lantern.secret/llm/no-such-provider"].Error != "not found" {
		t.Errorf("no-such-provider: expected error=not found")
	}
	if byRef["not-a-valid-ref"].Error != "not found" {
		t.Errorf("bad-format ref: expected error=not found")
	}
}

// ---------------------------------------------------------------------------
// DB-gated: vm-binding checks
// ---------------------------------------------------------------------------

// TestResolveSecrets_VMBinding_Success verifies that a valid (vm_id, tenant_id)
// pair in a live state passes the binding check and resolves refs normally.
func TestResolveSecrets_VMBinding_Success(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-bind-ok")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertLLMKey(t, pool, tenantID, "anthropic", "test-binding-plaintext-key")
	insertRuntimeVM(t, pool, tenantID, "vm-binding-ok", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-binding-ok",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid binding, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 || resp.Resolved[0].Value != "test-binding-plaintext-key" {
		t.Errorf("expected resolved value, got: %+v", resp.Resolved)
	}
}

// TestResolveSecrets_VMBinding_WrongTenant verifies that supplying a vm_id that
// belongs to a DIFFERENT tenant returns 404 — the shared token does not let the
// caller escalate to another tenant's VM.
func TestResolveSecrets_VMBinding_WrongTenant(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantA := uniqueTenantID("sec-bind-wrong-A")
	tenantB := uniqueTenantID("sec-bind-wrong-B")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	t.Cleanup(func() {
		cleanupSecretsData(t, pool, tenantA)
		cleanupSecretsData(t, pool, tenantB)
	})

	// VM belongs to tenantB; caller claims tenantA.
	insertRuntimeVM(t, pool, tenantB, "vm-binding-wrong-tenant", "running")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantA, // mismatch
		VmID:     "vm-binding-wrong-tenant",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for wrong-tenant binding, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_VMBinding_UnknownVM verifies that a vm_id that does not
// exist in runtime_vms returns 404, and the body is byte-identical to the
// wrong-tenant 404 body (no oracle distinguishing the two cases).
func TestResolveSecrets_VMBinding_UnknownVM(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-bind-novm")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	// Confirm that an unknown vm produces the same body as a wrong-tenant case.
	wUnknown := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-does-not-exist-at-all",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if wUnknown.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown vm, got %d: %s", wUnknown.Code, wUnknown.Body.String())
	}

	// Seed a VM owned by a different tenant to get the "wrong-tenant" response
	// for byte comparison. We need a second tenant for this.
	tenantOther := uniqueTenantID("sec-bind-novm-other")
	seedTestTenant(t, pool, tenantOther)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantOther) })
	insertRuntimeVM(t, pool, tenantOther, "vm-binding-other-tenant-novm", "running")

	wWrong := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID, // doesn't own the VM
		VmID:     "vm-binding-other-tenant-novm",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})
	if wWrong.Code != http.StatusNotFound {
		t.Errorf("expected 404 for wrong-tenant vm, got %d: %s", wWrong.Code, wWrong.Body.String())
	}

	// Byte-identical bodies confirm no oracle.
	if wUnknown.Body.String() != wWrong.Body.String() {
		t.Errorf("unknown-vm and wrong-tenant bodies differ (oracle!): %q vs %q",
			wUnknown.Body.String(), wWrong.Body.String())
	}
}

// TestResolveSecrets_VMBinding_TerminatedVM verifies that a vm_id in a terminal
// state ('terminated') returns 404 — the VM is no longer live so no new secret
// resolutions are allowed against it.
func TestResolveSecrets_VMBinding_TerminatedVM(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-bind-term")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertRuntimeVM(t, pool, tenantID, "vm-binding-terminated", "terminated")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-binding-terminated",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for terminated vm, got %d: %s", w.Code, w.Body.String())
	}
}

// TestResolveSecrets_VMBinding_PendingVM verifies that a vm_id in 'pending'
// state (freshly scheduled, harness starting up) is accepted. This is the
// correct ordering: the control-plane inserts the runtime_vms row with
// state='pending' before returning the schedule response; the manager calls
// ResolveSecrets only after it processes that response, so the row is always
// committed by the time a legitimate call arrives.
func TestResolveSecrets_VMBinding_PendingVM(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-bind-pending")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	insertLLMKey(t, pool, tenantID, "anthropic", "test-pending-vm-key")
	insertRuntimeVM(t, pool, tenantID, "vm-binding-pending", "pending")

	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	w := doResolve(h, testRuntimeSecretToken, resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-binding-pending",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for pending vm, got %d: %s", w.Code, w.Body.String())
	}
	var resp resolveSecretsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if len(resp.Resolved) != 1 || resp.Resolved[0].Value != "test-pending-vm-key" {
		t.Errorf("expected resolved value for pending vm, got: %+v", resp.Resolved)
	}
}

// TestResolveSecrets_VMBinding_DenialIncrementsRateLimiter verifies that a
// vm-binding failure increments the per-IP rate limiter so an attacker probing
// vm_ids or tenant_ids gets throttled at the same rate as auth brute-force.
func TestResolveSecrets_VMBinding_DenialIncrementsRateLimiter(t *testing.T) {
	pool := openTestPool(t)
	migrateSecretsTables(t, pool)

	tenantID := uniqueTenantID("sec-bind-ratelimit")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupSecretsData(t, pool, tenantID) })

	// Do NOT seed a VM — every resolve attempt will be a binding failure.
	t.Setenv(envRuntimeSecretToken, testRuntimeSecretToken)
	h := newTestSecretsHandlerWithPool(t, pool)

	body := resolveSecretsRequest{
		TenantID: tenantID,
		VmID:     "vm-does-not-exist-ratelimit",
		Refs:     []string{"lantern.secret/llm/anthropic"},
	}

	// Fire secretAuthFailMax+1 requests; all will hit the binding check.
	// The last one should be rate-limited (429) because each binding failure
	// increments the same per-IP counter as auth failures.
	var lastCode int
	for i := 0; i <= secretAuthFailMax; i++ {
		w := doResolve(h, testRuntimeSecretToken, body)
		lastCode = w.Code
	}
	if lastCode != http.StatusTooManyRequests {
		t.Errorf("expected 429 after %d binding failures, got %d", secretAuthFailMax+1, lastCode)
	}
}
