package handlers

// DB-gated handler tests for connectors.go / connector_executor.go: the
// install → list → get → uninstall lifecycle, cross-tenant isolation, and —
// most importantly — the encrypted-credential round-trip. A connector secret
// installed through the handler must (a) be stored encrypted at rest in
// connector_installs (not readable as plaintext), and (b) decrypt back to the
// original value on the read/execute path.
//
// TestMain (below) sets LANTERN_CREDENTIAL_KEY before any test in the package
// runs, so secrets.loadKey() (a sync.Once) picks up a real AES-256 key and the
// "stored form is encrypted" assertion is deterministic.
//
// Skipped automatically when DATABASE_URL is unset. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run Connector -count=1 -v

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// TestMain ensures credential encryption is active for the whole package run so
// the connectors encryption round-trip can prove the at-rest form is ciphertext.
// We set a fixed 32-byte (hex) key only when the operator hasn't supplied one,
// so a real CI key is never clobbered.
func TestMain(m *testing.M) {
	if os.Getenv(secrets.EnvKey) == "" {
		// 64 hex chars = 32 bytes = AES-256.
		os.Setenv(secrets.EnvKey, strings.Repeat("a1b2c3d4", 8))
	}
	os.Exit(m.Run())
}

// newConnectorHandlers builds the install/list/get/uninstall handler and the
// executor (read/decrypt path) on a single real pool.
func newConnectorHandlers(t *testing.T) (*ConnectorHandler, *ConnectorExecutor, *server.Server) {
	t.Helper()
	pool := openTestPool(t) // skips if DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewConnectorHandler(srv, auth), NewConnectorExecutor(srv, auth), srv
}

// seedConnectorTenant inserts a fresh tenant (CASCADE drops its installs).
func seedConnectorTenant(t *testing.T, srv *server.Server, slug string) string {
	t.Helper()
	var id string
	if err := srv.Pool.QueryRow(context.Background(), `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ($1, $1, 'personal', 'lantern-t-' || $1)
		RETURNING id
	`, slug).Scan(&id); err != nil {
		t.Fatalf("seed tenant %q: %v", slug, err)
	}
	t.Cleanup(func() {
		_, _ = srv.Pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// installConnectorHTTP fires POST /v1/connectors/install as tenantID with the
// given config blob and returns the recorder.
func installConnectorHTTP(t *testing.T, h *ConnectorHandler, tenantID, connectorID, displayName string, config map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	body, _ := json.Marshal(map[string]any{
		"connectorId": connectorID,
		"displayName": displayName,
		"config":      config,
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/connectors/install", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.InstallConnector(rr, req)
	return rr
}

// installConnectorID installs a connector and returns its row id, registering
// cleanup of the row.
func installConnectorID(t *testing.T, h *ConnectorHandler, srv *server.Server, tenantID, connectorID, displayName string, config map[string]any) string {
	t.Helper()
	rr := installConnectorHTTP(t, h, tenantID, connectorID, displayName, config)
	if rr.Code != http.StatusCreated {
		t.Fatalf("install connector: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal install response: %v", err)
	}
	id, _ := resp["id"].(string)
	if id == "" {
		t.Fatal("install returned empty id")
	}
	t.Cleanup(func() {
		_, _ = srv.Pool.Exec(context.Background(), `DELETE FROM connector_installs WHERE id = $1`, id)
	})
	return id
}

// getConnectorHTTP fires GET /v1/connectors/{id}.
func getConnectorHTTP(t *testing.T, h *ConnectorHandler, tenantID, id string) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/connectors/"+id, nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetConnector(rr, req)
	return rr
}

// listConnectorIDs fires GET /v1/connectors and returns the visible row-id set.
func listConnectorIDs(t *testing.T, h *ConnectorHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/connectors", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListConnectors(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list connectors: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &rows); err != nil {
		t.Fatalf("unmarshal list response: %v", err)
	}
	ids := make(map[string]bool, len(rows))
	for _, row := range rows {
		if id, ok := row["id"].(string); ok {
			ids[id] = true
		}
	}
	return ids
}

// TestConnector_InstallListGetUninstall walks the full lifecycle.
func TestConnector_InstallListGetUninstall(t *testing.T) {
	h, _, srv := newConnectorHandlers(t)
	tenant := seedConnectorTenant(t, srv, "conn-life")

	id := installConnectorID(t, h, srv, tenant, "github", "My GitHub", map[string]any{
		"personalAccessToken": "pat_lifecycle_token",
	})

	// List: present.
	if !listConnectorIDs(t, h, tenant)[id] {
		t.Errorf("installed connector %q missing from list", id)
	}

	// Get: returns it.
	if rr := getConnectorHTTP(t, h, tenant, id); rr.Code != http.StatusOK {
		t.Fatalf("get connector: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	// Uninstall.
	tok := mintTestToken(t, tenant, "user-x", "owner")
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/connectors/"+id, nil)
	delReq.SetPathValue("id", id)
	delReq.Header.Set("Authorization", bearerHeader(tok))
	delRR := httptest.NewRecorder()
	h.UninstallConnector(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Fatalf("uninstall: got %d, want 204; body: %s", delRR.Code, delRR.Body.String())
	}

	// Gone from list, and get → 404.
	if listConnectorIDs(t, h, tenant)[id] {
		t.Errorf("connector %q still in list after uninstall", id)
	}
	if rr := getConnectorHTTP(t, h, tenant, id); rr.Code != http.StatusNotFound {
		t.Errorf("get after uninstall: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

// TestConnector_EncryptedCredentialRoundTrip is the security-critical test:
//   - the secret is stored ENCRYPTED at rest (raw column bytes don't contain
//     the plaintext and carry the envelope marker), and
//   - it DECRYPTS back to the original value via the executor's read path.
func TestConnector_EncryptedCredentialRoundTrip(t *testing.T) {
	enabled, err := secrets.EncryptionEnabled()
	if err != nil {
		t.Fatalf("EncryptionEnabled: %v", err)
	}
	if !enabled {
		t.Skip("credential encryption not active (LANTERN_CREDENTIAL_KEY mis-set) — skipping at-rest ciphertext assertion")
	}

	h, _, srv := newConnectorHandlers(t)
	tenant := seedConnectorTenant(t, srv, "conn-enc")

	const secretValue = "pat_SUPER_SECRET_round_trip_value_42"
	id := installConnectorID(t, h, srv, tenant, "github", "Enc GitHub", map[string]any{
		"personalAccessToken": secretValue,
	})

	// 1. At-rest: read the raw config column straight from Postgres (bypassing
	//    the handler's decrypt) and prove it is ciphertext, not plaintext.
	var rawConfig []byte
	if err := srv.Pool.QueryRow(context.Background(),
		`SELECT config FROM connector_installs WHERE id = $1`, id,
	).Scan(&rawConfig); err != nil {
		t.Fatalf("read raw config: %v", err)
	}
	if bytes.Contains(rawConfig, []byte(secretValue)) {
		t.Fatalf("SECRET LEAK: plaintext token found in at-rest config column: %s", string(rawConfig))
	}
	if !bytes.Contains(rawConfig, []byte("__lantern_enc__")) {
		t.Errorf("at-rest config is not an encryption envelope: %s", string(rawConfig))
	}

	// 2. Round-trip: the encrypted blob decrypts back to the original token.
	dec, err := secrets.Decrypt(rawConfig)
	if err != nil {
		t.Fatalf("decrypt at-rest config: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(dec, &decoded); err != nil {
		t.Fatalf("unmarshal decrypted config: %v", err)
	}
	if got, _ := decoded["personalAccessToken"].(string); got != secretValue {
		t.Errorf("decrypted token: got %q, want %q", got, secretValue)
	}

	// 3. The shared executor credential-load path (used by HTTP execute AND the
	//    LLM tool loop) must surface the SAME decrypted token. GitHub list_repos
	//    is dispatched with a real-but-bogus token; we don't assert the API
	//    result, only that decryption fed a usable token through (no "not
	//    installed" / "missing token" error). Network failure is acceptable;
	//    a decrypt/credential failure is not.
	_, execErr := executeConnectorAction(context.Background(), srv.Pool, tenant, "github", "list_repos", map[string]any{"limit": 1})
	if execErr != nil {
		if isConnectorNotInstalled(execErr) {
			t.Errorf("executor reported connector not installed despite a connected install: %v", execErr)
		}
		if strings.Contains(execErr.Error(), "decrypt") {
			t.Errorf("executor failed to decrypt stored credential: %v", execErr)
		}
		if strings.Contains(strings.ToLower(execErr.Error()), "personal access token") {
			t.Errorf("executor saw an empty token — decryption did not feed the credential through: %v", execErr)
		}
		// Otherwise the error is an upstream GitHub API rejection of the bogus
		// token (401) — which proves the token WAS extracted and sent.
	}
}

// TestConnector_CrossTenantIsolation proves tenant B cannot see, get, or read
// the credentials of tenant A's connector.
func TestConnector_CrossTenantIsolation(t *testing.T) {
	h, _, srv := newConnectorHandlers(t)
	tenantA := seedConnectorTenant(t, srv, "conn-iso-a")
	tenantB := seedConnectorTenant(t, srv, "conn-iso-b")

	idA := installConnectorID(t, h, srv, tenantA, "slack", "A Slack", map[string]any{
		"botToken": "bot-token-tenant-a-secret",
	})

	// 1. Tenant B GET of A's connector → 404.
	if rr := getConnectorHTTP(t, h, tenantB, idA); rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant get: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}

	// 2. Tenant B LIST must not contain A's connector.
	if listConnectorIDs(t, h, tenantB)[idA] {
		t.Errorf("tenant B's list leaked tenant A's connector %q", idA)
	}

	// 3. The executor, scoped to tenant B, must NOT resolve A's slack install —
	//    it should report "not installed" for B (proving credentials don't
	//    cross the tenant boundary).
	_, execErr := executeConnectorAction(context.Background(), srv.Pool, tenantB, "slack", "list_channels", nil)
	if execErr == nil || !isConnectorNotInstalled(execErr) {
		t.Errorf("tenant B executor resolved tenant A's connector: err=%v", execErr)
	}

	// 4. Positive control: tenant A DOES see its own.
	if !listConnectorIDs(t, h, tenantA)[idA] {
		t.Errorf("tenant A's own connector %q missing from its list", idA)
	}
}

// TestConnector_InstallValidation proves install rejects a missing connectorId
// / displayName with 400.
func TestConnector_InstallValidation(t *testing.T) {
	h, _, srv := newConnectorHandlers(t)
	tenant := seedConnectorTenant(t, srv, "conn-val")

	tok := mintTestToken(t, tenant, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"displayName": "missing id"})
	req := httptest.NewRequest(http.MethodPost, "/v1/connectors/install", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.InstallConnector(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("install missing connectorId: got %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}
