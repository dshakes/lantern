package handlers

// DB-gated tests for POST /internal/auth/introspect-key (introspect.go).
//
// Skipped automatically when DATABASE_URL is unset. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run Introspect -count=1 -v

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

// devTenantID (the seeded dev tenant) is declared in surfaces.go.

// seedAPIKey inserts an api_keys row for the dev tenant and returns the raw key.
// Cleanup removes the row.
func seedAPIKey(t *testing.T, h *AuthHandler, scopes []string) string {
	t.Helper()
	raw, err := randomHex(24)
	if err != nil {
		t.Fatalf("randomHex: %v", err)
	}
	rawKey := "lsk_" + raw
	sum := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(sum[:])

	ctx := context.Background()
	var id string
	err = h.srv.Pool.QueryRow(ctx,
		`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes)
		 VALUES ($1, 'introspect-test', $2, $3, $4) RETURNING id`,
		devTenantID, keyHash, rawKey[:8], scopes,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed api key: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(context.Background(), `DELETE FROM api_keys WHERE id = $1`, id)
	})
	return rawKey
}

func introspectRequest(token, rawKey string) *http.Request {
	body, _ := json.Marshal(map[string]string{"key": rawKey})
	req := httptest.NewRequest(http.MethodPost, "/internal/auth/introspect-key", bytes.NewReader(body))
	if token != "" {
		req.Header.Set(middleware.ServiceTokenMetadataKey, token)
	}
	return req
}

func TestIntrospectKey_ValidTokenValidKey(t *testing.T) {
	t.Setenv("LANTERN_GRPC_SERVICE_TOKEN", "s3cret")
	h := newAuthTestHandler(t)
	rawKey := seedAPIKey(t, h, []string{"runs:read", "runs:write"})

	rr := httptest.NewRecorder()
	h.IntrospectKey(rr, introspectRequest("s3cret", rawKey))

	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		TenantID string   `json:"tenantId"`
		Scopes   []string `json:"scopes"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.TenantID != devTenantID {
		t.Errorf("tenantId: got %q, want %q", resp.TenantID, devTenantID)
	}
	if len(resp.Scopes) != 2 || resp.Scopes[0] != "runs:read" {
		t.Errorf("scopes: got %v", resp.Scopes)
	}
}

func TestIntrospectKey_BadServiceToken(t *testing.T) {
	t.Setenv("LANTERN_GRPC_SERVICE_TOKEN", "s3cret")
	h := newAuthTestHandler(t)
	rawKey := seedAPIKey(t, h, []string{})

	rr := httptest.NewRecorder()
	h.IntrospectKey(rr, introspectRequest("wrong-token", rawKey))

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("bad service token: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
}

func TestIntrospectKey_UnsetTokenInProdFailsClosed(t *testing.T) {
	t.Setenv("LANTERN_GRPC_SERVICE_TOKEN", "")
	t.Setenv("LANTERN_ENV", "production")
	h := newAuthTestHandler(t)

	rr := httptest.NewRecorder()
	h.IntrospectKey(rr, introspectRequest("", "lsk_anything"))

	if rr.Code != http.StatusForbidden {
		t.Fatalf("prod unset token: got %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

func TestIntrospectKey_ValidTokenUnknownKey(t *testing.T) {
	t.Setenv("LANTERN_GRPC_SERVICE_TOKEN", "s3cret")
	h := newAuthTestHandler(t)

	rr := httptest.NewRecorder()
	h.IntrospectKey(rr, introspectRequest("s3cret", "lsk_does_not_exist"))

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("unknown key: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
}
