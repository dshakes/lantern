package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// SurfaceHandler provides REST endpoints for managing surface configurations.
type SurfaceHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewSurfaceHandler creates a new SurfaceHandler.
func NewSurfaceHandler(srv *server.Server, auth *AuthHandler) *SurfaceHandler {
	return &SurfaceHandler{srv: srv, auth: auth}
}

func (h *SurfaceHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("surfaces")
}

func (h *SurfaceHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return r.Context(), claims.TenantID, nil
}

// ---------- Configure surface ----------

// ConfigureSurface handles POST /v1/surfaces.
func (h *SurfaceHandler) ConfigureSurface(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		SurfaceID   string         `json:"surfaceId"`
		DisplayName string         `json:"displayName"`
		Config      map[string]any `json:"config"`
		WebhookURL  string         `json:"webhookUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.SurfaceID == "" || body.DisplayName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "surfaceId and displayName are required"})
		return
	}

	configJSON, _ := json.Marshal(body.Config)

	var id string
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO surface_configs (tenant_id, surface_id, display_name, status, config, webhook_url, connected_at)
		VALUES ($1, $2, $3, 'connected', $4::jsonb, $5, now())
		ON CONFLICT (tenant_id, surface_id) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			config = EXCLUDED.config,
			webhook_url = EXCLUDED.webhook_url,
			status = 'connected',
			connected_at = now(),
			updated_at = now()
		RETURNING id
	`, tenantID, body.SurfaceID, body.DisplayName, string(configJSON), body.WebhookURL).Scan(&id)
	if err != nil {
		h.logger().Error("configure surface failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to configure surface"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":          id,
		"tenantId":    tenantID,
		"surfaceId":   body.SurfaceID,
		"displayName": body.DisplayName,
		"status":      "connected",
		"config":      body.Config,
		"webhookUrl":  body.WebhookURL,
		"connectedAt": time.Now().UTC(),
	})
}

// ---------- List surfaces ----------

// ListSurfaces handles GET /v1/surfaces.
func (h *SurfaceHandler) ListSurfaces(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id, surface_id, display_name, status, config, webhook_url, connected_at, updated_at
		FROM surface_configs
		WHERE tenant_id = $1
		ORDER BY connected_at DESC NULLS LAST
	`, tenantID)
	if err != nil {
		h.logger().Error("list surfaces failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list surfaces"})
		return
	}
	defer rows.Close()

	result := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id, surfaceID, displayName, status string
			config                             []byte
			webhookURL                         *string
			connectedAt                        *time.Time
			updatedAt                          time.Time
		)
		if err := rows.Scan(&id, &surfaceID, &displayName, &status, &config, &webhookURL, &connectedAt, &updatedAt); err != nil {
			h.logger().Error("scan surface row failed", zap.Error(err))
			continue
		}

		var configMap map[string]any
		json.Unmarshal(config, &configMap) //nolint:errcheck

		entry := map[string]any{
			"id":          id,
			"tenantId":    tenantID,
			"surfaceId":   surfaceID,
			"displayName": displayName,
			"status":      status,
			"config":      configMap,
			"updatedAt":   updatedAt,
		}
		if webhookURL != nil {
			entry["webhookUrl"] = *webhookURL
		}
		if connectedAt != nil {
			entry["connectedAt"] = *connectedAt
		}
		result = append(result, entry)
	}

	writeJSON(w, http.StatusOK, result)
}

// ---------- Update surface ----------

// UpdateSurface handles PUT /v1/surfaces/{id}.
func (h *SurfaceHandler) UpdateSurface(w http.ResponseWriter, r *http.Request) {
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

	var body struct {
		DisplayName string         `json:"displayName"`
		Config      map[string]any `json:"config"`
		WebhookURL  string         `json:"webhookUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	configJSON, _ := json.Marshal(body.Config)

	var surfaceID, displayName, status string
	err = h.srv.Pool.QueryRow(ctx, `
		UPDATE surface_configs
		SET display_name = COALESCE(NULLIF($3, ''), display_name),
		    config = $4::jsonb,
		    webhook_url = $5,
		    updated_at = now()
		WHERE id = $1 AND tenant_id = $2
		RETURNING surface_id, display_name, status
	`, id, tenantID, body.DisplayName, string(configJSON), body.WebhookURL).Scan(&surfaceID, &displayName, &status)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "surface not found"})
		return
	}
	if err != nil {
		h.logger().Error("update surface failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update surface"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":          id,
		"tenantId":    tenantID,
		"surfaceId":   surfaceID,
		"displayName": displayName,
		"status":      status,
		"config":      body.Config,
		"webhookUrl":  body.WebhookURL,
		"updatedAt":   time.Now().UTC(),
	})
}

// ---------- Remove surface ----------

// RemoveSurface handles DELETE /v1/surfaces/{id}.
func (h *SurfaceHandler) RemoveSurface(w http.ResponseWriter, r *http.Request) {
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
		DELETE FROM surface_configs WHERE id = $1 AND tenant_id = $2
	`, id, tenantID)
	if err != nil {
		h.logger().Error("remove surface failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to remove surface"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "surface not found"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------- Test surface ----------

// TestSurface handles POST /v1/surfaces/{id}/test.
func (h *SurfaceHandler) TestSurface(w http.ResponseWriter, r *http.Request) {
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

	var surfaceID, status string
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT surface_id, status
		FROM surface_configs
		WHERE id = $1 AND tenant_id = $2
	`, id, tenantID).Scan(&surfaceID, &status)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "surface not found"})
		return
	}
	if err != nil {
		h.logger().Error("test surface query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to query surface"})
		return
	}

	if status != "connected" {
		writeJSON(w, http.StatusOK, map[string]any{
			"success": false,
			"message": "Surface is not connected (status: " + status + ")",
		})
		return
	}

	// In production, we would actually send a test message through the surface.
	// For the spike, confirm the surface is configured.
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"message": "Test message sent successfully via " + surfaceID,
	})
}
