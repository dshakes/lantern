package handlers

// introspect.go — POST /internal/auth/introspect-key
//
// Internal-only endpoint the Rust gateway calls to validate a raw API key it
// received on X-API-Key. It reuses AuthHandler.validateAPIKey (the same SQL the
// JWT/API-key request path uses) so key validation lives in exactly one place.
//
// Auth mirrors middleware.UnaryServiceAuthInterceptor (the :50051 gRPC trust
// boundary): the caller must present the shared service token in the
// x-lantern-service-token header, constant-time compared against
// LANTERN_GRPC_SERVICE_TOKEN. When that env is unset: dev → allow with a
// one-time WARN; prod (LANTERN_ENV prod/production/staging) → 403 fail-closed.
//
// The raw key and the service token never appear in logs (invariant #10).

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"sync"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

const introspectServiceTokenEnv = "LANTERN_GRPC_SERVICE_TOKEN"

var introspectDevWarnOnce sync.Once

// IntrospectKey validates a raw API key on behalf of an in-cluster caller.
// 200 {"tenantId","scopes"} on a valid key; 401 on an unknown/invalid key.
func (h *AuthHandler) IntrospectKey(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeIntrospect(w, r) {
		return
	}

	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
		return
	}

	claims, err := h.validateAPIKey(r.Context(), body.Key)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid API key"})
		return
	}

	scopes := claims.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenantId": claims.TenantID,
		"scopes":   scopes,
	})
}

// authorizeIntrospect enforces the shared-token trust boundary and writes the
// error response itself on failure. Returns true when the caller may proceed.
func (h *AuthHandler) authorizeIntrospect(w http.ResponseWriter, r *http.Request) bool {
	expected := os.Getenv(introspectServiceTokenEnv)
	if expected == "" {
		if IsProd() {
			h.logger().Warn("introspect-key: LANTERN_GRPC_SERVICE_TOKEN unset — refusing (fail-closed in prod)")
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "introspection disabled"})
			return false
		}
		introspectDevWarnOnce.Do(func() {
			h.logger().Warn("introspect-key: LANTERN_GRPC_SERVICE_TOKEN unset — allowing unauthenticated calls (dev only)")
		})
		return true
	}
	presented := r.Header.Get(middleware.ServiceTokenMetadataKey)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) != 1 {
		h.logger().Warn("introspect-key: invalid service token")
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid service token"})
		return false
	}
	return true
}
