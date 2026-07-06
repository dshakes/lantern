package handlers

// Scope-enforcement tests covering:
//
//  1. HasScope pure implication logic — table-driven, no DB.
//  2. WithScope with JWT auth — always passes (crypto only, no DB).
//  3. WithScope with API-key auth + enforcement flag gate (DB-gated).
//
// Run pure tests:
//
//	go test ./internal/handlers/ -run TestHasScope -v
//
// Run all (needs dev-infra):
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run TestWithScope -count=1 -v

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"go.uber.org/zap"
)

// ---------- Pure scope-implication tests (no DB) ----------

func TestHasScope(t *testing.T) {
	jwtOwner := &LanternClaims{Role: "owner"} // JWT: bypasses scope checks

	cases := []struct {
		name     string
		claims   *LanternClaims
		required Scope
		want     bool
	}{
		// JWT interactive users always pass.
		{"jwt/any-scope", jwtOwner, ScopeAgentsWrite, true},
		{"jwt/admin", jwtOwner, ScopeAdmin, true},

		// Unrestricted API key (empty scopes list) — always passes.
		{"empty-scopes/write", serviceKey(nil), ScopeAgentsWrite, true},
		{"empty-scopes/read", serviceKey(nil), ScopeRunsRead, true},

		// Exact match.
		{"exact/agents:write", serviceKey([]string{ScopeAgentsWrite}), ScopeAgentsWrite, true},
		{"exact/runs:execute", serviceKey([]string{ScopeRunsExecute}), ScopeRunsExecute, true},

		// admin implies everything.
		{"admin→agents:write", serviceKey([]string{ScopeAdmin}), ScopeAgentsWrite, true},
		{"admin→runs:execute", serviceKey([]string{ScopeAdmin}), ScopeRunsExecute, true},
		{"admin→settings:write", serviceKey([]string{ScopeAdmin}), ScopeSettingsWrite, true},
		{"admin→budgets:write", serviceKey([]string{ScopeAdmin}), ScopeBudgetsWrite, true},
		{"admin→connectors:write", serviceKey([]string{ScopeAdmin}), ScopeConnectorsWrite, true},

		// Coarse write implies all fine-grained write and read scopes.
		{"write→agents:write", serviceKey([]string{ScopeWrite}), ScopeAgentsWrite, true},
		{"write→runs:execute", serviceKey([]string{ScopeWrite}), ScopeRunsExecute, true},
		{"write→connectors:write", serviceKey([]string{ScopeWrite}), ScopeConnectorsWrite, true},
		{"write→settings:write", serviceKey([]string{ScopeWrite}), ScopeSettingsWrite, true},
		{"write→agents:read", serviceKey([]string{ScopeWrite}), ScopeAgentsRead, true},
		{"write→runs:read", serviceKey([]string{ScopeWrite}), ScopeRunsRead, true},

		// Coarse read implies fine-grained read scopes.
		{"read→agents:read", serviceKey([]string{ScopeRead}), ScopeAgentsRead, true},
		{"read→runs:read", serviceKey([]string{ScopeRead}), ScopeRunsRead, true},
		// Coarse read does NOT imply write.
		{"read↛agents:write", serviceKey([]string{ScopeRead}), ScopeAgentsWrite, false},

		// agents:write ⊇ agents:read; no cross-resource implication.
		{"agents:write→agents:read", serviceKey([]string{ScopeAgentsWrite}), ScopeAgentsRead, true},
		{"agents:write↛runs:execute", serviceKey([]string{ScopeAgentsWrite}), ScopeRunsExecute, false},
		{"agents:write↛settings:write", serviceKey([]string{ScopeAgentsWrite}), ScopeSettingsWrite, false},

		// runs:execute ⊇ runs:read + runs:write.
		{"runs:execute→runs:read", serviceKey([]string{ScopeRunsExecute}), ScopeRunsRead, true},
		{"runs:execute→runs:write", serviceKey([]string{ScopeRunsExecute}), ScopeRunsWrite, true},
		{"runs:execute↛agents:read", serviceKey([]string{ScopeRunsExecute}), ScopeAgentsRead, false},

		// No cross-resource implication between fine-grained write scopes.
		{"connectors:write↛budgets:write", serviceKey([]string{ScopeConnectorsWrite}), ScopeBudgetsWrite, false},
		{"budgets:write↛agents:write", serviceKey([]string{ScopeBudgetsWrite}), ScopeAgentsWrite, false},

		// Multiple scopes: any one can satisfy.
		{"multi/needs-write-lacks-it",
			serviceKey([]string{ScopeAgentsRead, ScopeRunsExecute}), ScopeAgentsWrite, false},
		{"multi/has-enough",
			serviceKey([]string{ScopeAgentsWrite, ScopeRunsExecute}), ScopeAgentsRead, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := HasScope(tc.claims, tc.required)
			if got != tc.want {
				t.Errorf("HasScope(scopes=%v, required=%q) = %v, want %v",
					tc.claims.Scopes, tc.required, got, tc.want)
			}
		})
	}
}

// ---------- WithScope + JWT auth — no DB ----------

// TestWithScope_JWT_AlwaysPasses confirms that JWT-authenticated requests
// (Role != "service") reach the handler for any scope requirement, regardless
// of LANTERN_AUTHZ_ENFORCE.
func TestWithScope_JWT_AlwaysPasses(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	// nil Pool is fine: JWT validation is crypto-only, no DB access.
	srv := &server.Server{Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)

	tok, err := auth.generateToken("u1", devTenantID, "owner@test.local", "Owner", "owner")
	if err != nil {
		t.Fatalf("generateToken: %v", err)
	}

	for _, enforce := range []string{"", "0", "1"} {
		t.Run("enforce="+enforce, func(t *testing.T) {
			t.Setenv("LANTERN_AUTHZ_ENFORCE", enforce)

			reached := false
			handler := auth.WithScope(ScopeAgentsWrite, func(w http.ResponseWriter, _ *http.Request) {
				reached = true
				w.WriteHeader(http.StatusOK)
			})

			req := httptest.NewRequest(http.MethodPost, "/v1/agents", nil)
			req.Header.Set("Authorization", "Bearer "+tok)
			rr := httptest.NewRecorder()
			handler(rr, req)

			if rr.Code != http.StatusOK || !reached {
				t.Errorf("JWT auth: want 200+reached; got %d reached=%v", rr.Code, reached)
			}
		})
	}
}

// ---------- WithScope + API-key enforcement — DB-gated ----------

// TestWithScope_APIKey_Enforcement covers the flag-gate behavior with real
// API keys against a live database.
//
// Skipped when DATABASE_URL is unset or when run with -short.
func TestWithScope_APIKey_Enforcement(t *testing.T) {
	pool := openTestPool(t) // skips if DATABASE_URL unset or -short
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)

	keySeq := 0
	insertKey := func(scopes []string) string {
		keySeq++
		rawKey := fmt.Sprintf("hlx_live_authztest_%04d", keySeq)
		hash := sha256.Sum256([]byte(rawKey))
		keyHash := hex.EncodeToString(hash[:])
		_, err := pool.Exec(context.Background(),
			`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes)
			 VALUES ($1, $2, $3, $4, $5)`,
			devTenantID,
			fmt.Sprintf("authz-test-%d", keySeq),
			keyHash,
			rawKey[:8],
			scopes,
		)
		if err != nil {
			t.Fatalf("insertKey seq=%d: %v", keySeq, err)
		}
		return rawKey
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), //nolint:errcheck
			`DELETE FROM api_keys WHERE name LIKE 'authz-test-%' AND tenant_id = $1`,
			devTenantID,
		)
	})

	// Required scope for all subtests.
	const need = ScopeAgentsWrite

	makeRequest := func(rawKey string) (reached bool, code int) {
		hit := false
		handler := auth.WithScope(need, func(w http.ResponseWriter, _ *http.Request) {
			hit = true
			w.WriteHeader(http.StatusOK)
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/agents", nil)
		req.Header.Set("Authorization", "Bearer "+rawKey)
		rr := httptest.NewRecorder()
		handler(rr, req)
		return hit, rr.Code
	}

	// enforcement OFF (default): missing scope is logged and request is allowed.
	t.Run("enforce=off/missing-scope-allowed", func(t *testing.T) {
		key := insertKey([]string{ScopeRunsRead}) // lacks agents:write
		t.Setenv("LANTERN_AUTHZ_ENFORCE", "0")
		reached, code := makeRequest(key)
		if code != http.StatusOK || !reached {
			t.Errorf("enforce=off missing scope: want 200+reached; got %d reached=%v", code, reached)
		}
	})

	// enforcement ON: missing scope → 403.
	t.Run("enforce=on/missing-scope-forbidden", func(t *testing.T) {
		key := insertKey([]string{ScopeRunsRead}) // lacks agents:write
		t.Setenv("LANTERN_AUTHZ_ENFORCE", "1")
		reached, code := makeRequest(key)
		if code != http.StatusForbidden {
			t.Errorf("enforce=on missing scope: want 403; got %d", code)
		}
		if reached {
			t.Error("handler must not be reached on 403")
		}
	})

	// enforcement ON: correct scope → 200.
	t.Run("enforce=on/correct-scope-allowed", func(t *testing.T) {
		key := insertKey([]string{ScopeAgentsWrite})
		t.Setenv("LANTERN_AUTHZ_ENFORCE", "1")
		reached, code := makeRequest(key)
		if code != http.StatusOK || !reached {
			t.Errorf("enforce=on correct scope: want 200+reached; got %d reached=%v", code, reached)
		}
	})

	// enforcement ON: admin scope implies everything → 200.
	t.Run("enforce=on/admin-scope-allowed", func(t *testing.T) {
		key := insertKey([]string{ScopeAdmin})
		t.Setenv("LANTERN_AUTHZ_ENFORCE", "1")
		reached, code := makeRequest(key)
		if code != http.StatusOK || !reached {
			t.Errorf("enforce=on admin scope: want 200+reached; got %d reached=%v", code, reached)
		}
	})

	// enforcement ON: coarse "write" scope implies agents:write → 200 (backward-compat).
	t.Run("enforce=on/coarse-write-allowed", func(t *testing.T) {
		key := insertKey([]string{ScopeWrite})
		t.Setenv("LANTERN_AUTHZ_ENFORCE", "1")
		reached, code := makeRequest(key)
		if code != http.StatusOK || !reached {
			t.Errorf("enforce=on coarse write: want 200+reached; got %d reached=%v", code, reached)
		}
	})

	// enforcement ON: empty scopes list = unrestricted legacy key → always 200.
	t.Run("enforce=on/empty-scopes-unrestricted", func(t *testing.T) {
		key := insertKey([]string{}) // empty → unrestricted
		t.Setenv("LANTERN_AUTHZ_ENFORCE", "1")
		reached, code := makeRequest(key)
		if code != http.StatusOK || !reached {
			t.Errorf("enforce=on empty scopes: want 200+reached; got %d reached=%v", code, reached)
		}
	})
}

// ---------- helpers ----------

// serviceKey returns LanternClaims with Role="service" (API key) and the given scopes.
func serviceKey(scopes []string) *LanternClaims {
	return &LanternClaims{Role: "service", TenantID: devTenantID, Scopes: scopes}
}
