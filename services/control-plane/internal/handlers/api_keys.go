package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ApiKeyHandler provides REST endpoints for managing API keys.
type ApiKeyHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewApiKeyHandler creates a new ApiKeyHandler.
func NewApiKeyHandler(srv *server.Server, auth *AuthHandler) *ApiKeyHandler {
	return &ApiKeyHandler{srv: srv, auth: auth}
}

func (h *ApiKeyHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("api_keys")
}

func (h *ApiKeyHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return r.Context(), claims.TenantID, nil
}

// ---------- Create API key ----------

// CreateApiKey handles POST /v1/api-keys.
// It generates a random API key, hashes it with SHA-256, stores the hash and
// prefix, and returns the full key exactly once.
func (h *ApiKeyHandler) CreateApiKey(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	if body.Scopes == nil {
		body.Scopes = []string{}
	}

	// Generate random key: hlx_live_ + 32 random hex chars (16 bytes).
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		h.logger().Error("failed to generate random key", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	rawKey := "hlx_live_" + hex.EncodeToString(keyBytes)
	keyPrefix := rawKey[:16] // "hlx_live_" + first 7 hex chars

	// Hash with SHA-256.
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	var id string
	var createdAt time.Time
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, created_at
	`, tenantID, body.Name, keyHash, keyPrefix, body.Scopes, tenantID).Scan(&id, &createdAt)
	if err != nil {
		h.logger().Error("create api key failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create API key"})
		return
	}

	// Return the full key exactly once.
	writeJSON(w, http.StatusCreated, map[string]any{
		"key": map[string]any{
			"id":        id,
			"name":      body.Name,
			"prefix":    keyPrefix,
			"scopes":    body.Scopes,
			"createdAt": createdAt,
		},
		"rawKey": rawKey,
	})
}

// ---------- List API keys ----------

// ListApiKeys handles GET /v1/api-keys.
// Returns only key prefix, never the full key or hash.
func (h *ApiKeyHandler) ListApiKeys(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_by, created_at
		FROM api_keys
		WHERE tenant_id = $1
		ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		h.logger().Error("list api keys failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list API keys"})
		return
	}
	defer rows.Close()

	result := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id, name, keyPrefix string
			scopes              []string
			expiresAt           *time.Time
			lastUsedAt          *time.Time
			revokedAt           *time.Time
			createdBy           *string
			createdAt           time.Time
		)
		if err := rows.Scan(&id, &name, &keyPrefix, &scopes, &expiresAt, &lastUsedAt, &revokedAt, &createdBy, &createdAt); err != nil {
			h.logger().Error("scan api key row failed", zap.Error(err))
			continue
		}

		status := "active"
		if revokedAt != nil {
			status = "revoked"
		}

		entry := map[string]any{
			"id":        id,
			"name":      name,
			"prefix":    keyPrefix,
			"scopes":    scopes,
			"status":    status,
			"createdAt": createdAt,
		}
		if expiresAt != nil {
			entry["expiresAt"] = *expiresAt
		}
		if lastUsedAt != nil {
			entry["lastUsedAt"] = *lastUsedAt
		}
		if revokedAt != nil {
			entry["revokedAt"] = *revokedAt
		}
		if createdBy != nil {
			entry["createdBy"] = *createdBy
		}
		result = append(result, entry)
	}

	writeJSON(w, http.StatusOK, result)
}

// ---------- Revoke API key ----------

// RevokeApiKey handles DELETE /v1/api-keys/{id}.
func (h *ApiKeyHandler) RevokeApiKey(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	tag, err := h.srv.Pool.Exec(ctx, `
		UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
	`, id, tenantID)
	if err != nil {
		h.logger().Error("revoke api key failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to revoke API key"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "API key not found or already revoked"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------- Validate API key (internal helper) ----------

// ValidateAPIKey looks up an API key by its raw value, returning the tenant_id
// if valid. This is used by the gateway to authenticate SDK requests.
func (h *ApiKeyHandler) ValidateAPIKey(ctx context.Context, rawKey string) (string, error) {
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	var tenantID string
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT tenant_id FROM api_keys
		WHERE key_hash = $1 AND revoked_at IS NULL
		AND (expires_at IS NULL OR expires_at > now())
	`, keyHash).Scan(&tenantID)
	if err != nil {
		return "", fmt.Errorf("invalid API key")
	}

	// Update last_used_at.
	_, _ = h.srv.Pool.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`, keyHash)

	return tenantID, nil
}
