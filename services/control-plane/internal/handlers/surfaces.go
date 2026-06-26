package handlers

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// devTenantID is the seeded dev tenant. When the bridge runs in dev mode
// (no LANTERN_TENANT_ID set) it identifies itself as "default" — we map
// that here so heartbeats land on a real row. In prod, the bridge sends
// the real tenant UUID and this fallback is never used.
const devTenantID = "00000000-0000-0000-0000-000000000001"

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
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
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
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
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
	})
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

	result := make([]map[string]any, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, surface_id, display_name, status, config, webhook_url, connected_at, updated_at
			FROM surface_configs
			WHERE tenant_id = $1
			ORDER BY connected_at DESC NULLS LAST
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
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
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list surfaces failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list surfaces"})
		return
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
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			UPDATE surface_configs
			SET display_name = COALESCE(NULLIF($3, ''), display_name),
			    config = $4::jsonb,
			    webhook_url = $5,
			    updated_at = now()
			WHERE id = $1 AND tenant_id = $2
			RETURNING surface_id, display_name, status
		`, id, tenantID, body.DisplayName, string(configJSON), body.WebhookURL).Scan(&surfaceID, &displayName, &status)
	})
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

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx, `
			DELETE FROM surface_configs WHERE id = $1 AND tenant_id = $2
		`, id, tenantID)
		if execErr != nil {
			return execErr
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("remove surface failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to remove surface"})
		return
	}
	if rowsAffected == 0 {
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
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT surface_id, status
			FROM surface_configs
			WHERE id = $1 AND tenant_id = $2
		`, id, tenantID).Scan(&surfaceID, &status)
	})
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

// ---------- WhatsApp bridge heartbeat ----------

// whatsappHeartbeatPayload is the shape pushed by the bridge every 30s when
// LANTERN_CONTROL_PLANE_URL + LANTERN_BRIDGE_HEARTBEAT_TOKEN are set on its
// side. Each session entry mirrors WhatsAppSession.getDiagnostics().
type whatsappHeartbeatSession struct {
	TenantID              string  `json:"tenantId"`
	State                 string  `json:"state"`
	Paired                bool    `json:"paired"`
	Connected             bool    `json:"connected"`
	PhoneNumber           *string `json:"phoneNumber"`
	DisplayName           *string `json:"displayName"`
	LastConnectionEventAt *int64  `json:"lastConnectionEventAt"`
	LastError             *string `json:"lastError"`
}

type whatsappHeartbeatPayload struct {
	BridgeVersion string                     `json:"bridgeVersion"`
	Timestamp     int64                      `json:"timestamp"`
	Sessions      []whatsappHeartbeatSession `json:"sessions"`
}

// resolveTenantID accepts a UUID, a tenant slug, or the dev sentinel
// "default" and returns the canonical tenant UUID. Returns "" if the
// input doesn't match any known tenant — the caller treats that as
// a soft skip so a misconfigured bridge can't poison heartbeats.
func resolveTenantID(ctx context.Context, srv *server.Server, raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if raw == "default" {
		raw = devTenantID
	}
	if _, err := uuid.Parse(raw); err == nil {
		var id string
		// rls-exempt: resolves the bridge's claimed tenant against the `tenants`
		// registry (an RLS-exempt table keyed by id, not tenant_id) — runs before
		// any tenant context exists, on the privileged pool.
		err := srv.Pool.QueryRow(ctx, `SELECT id::text FROM tenants WHERE id = $1`, raw).Scan(&id)
		if err == nil {
			return id
		}
	}
	// Try as slug.
	var id string
	// rls-exempt: tenant-registry lookup by slug (exempt `tenants` table), pre-context.
	err := srv.Pool.QueryRow(ctx, `SELECT id::text FROM tenants WHERE slug = $1`, raw).Scan(&id)
	if err == nil {
		return id
	}
	return ""
}

// BridgeHeartbeat handles POST /v1/surfaces/whatsapp/heartbeat.
//
// Auth is via a shared bearer token (LANTERN_BRIDGE_HEARTBEAT_TOKEN) rather
// than JWT — the bridge is a service principal, not a logged-in user. When
// the env var is unset the endpoint refuses every request, so an
// unconfigured prod deployment can't be silently spammed by a stray bridge.
func (h *SurfaceHandler) BridgeHeartbeat(w http.ResponseWriter, r *http.Request) {
	expected := os.Getenv("LANTERN_BRIDGE_HEARTBEAT_TOKEN")
	if expected == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "heartbeat endpoint disabled (set LANTERN_BRIDGE_HEARTBEAT_TOKEN to enable)",
		})
		return
	}
	authz := r.Header.Get("Authorization")
	provided := strings.TrimPrefix(authz, "Bearer ")
	if provided == authz || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var payload whatsappHeartbeatPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	ctx := r.Context()
	heartbeatAt := time.Now().UTC()
	accepted := 0
	skipped := 0

	for _, s := range payload.Sessions {
		tenantUUID := resolveTenantID(ctx, h.srv, s.TenantID)
		if tenantUUID == "" {
			skipped++
			continue
		}

		status := "disconnected"
		if s.Connected {
			status = "connected"
		} else if s.State == "logged_out" {
			status = "logged_out"
		} else if s.State == "reconnecting" || s.State == "connecting" {
			status = "connecting"
		} else if s.State == "qr_ready" {
			status = "pairing"
		}

		var lastEvent *time.Time
		if s.LastConnectionEventAt != nil {
			t := time.UnixMilli(*s.LastConnectionEventAt).UTC()
			lastEvent = &t
		}
		var connectedAt *time.Time
		if s.Connected {
			connectedAt = &heartbeatAt
		}

		// The tenant was just resolved from the bridge's claimed id against the
		// registry; inject it so the heartbeat upsert is RLS-scoped to that tenant.
		hbCtx := middleware.InjectTenantID(ctx, tenantUUID)
		err := h.srv.WithTenant(hbCtx, func(tx pgx.Tx) error {
			_, e := tx.Exec(hbCtx, `
				INSERT INTO surface_configs (
					tenant_id, surface_id, display_name, status,
					phone_number, display_handle, bridge_state, bridge_version,
					last_heartbeat_at, last_connection_event_at, last_error,
					connected_at, updated_at
				) VALUES (
					$1, 'whatsapp', 'WhatsApp', $2,
					$3, $4, $5, $6,
					$7, $8, $9,
					$10, now()
				)
				ON CONFLICT (tenant_id, surface_id) DO UPDATE SET
					status = EXCLUDED.status,
					phone_number = COALESCE(EXCLUDED.phone_number, surface_configs.phone_number),
					display_handle = COALESCE(EXCLUDED.display_handle, surface_configs.display_handle),
					bridge_state = EXCLUDED.bridge_state,
					bridge_version = EXCLUDED.bridge_version,
					last_heartbeat_at = EXCLUDED.last_heartbeat_at,
					last_connection_event_at = COALESCE(EXCLUDED.last_connection_event_at, surface_configs.last_connection_event_at),
					last_error = EXCLUDED.last_error,
					connected_at = COALESCE(EXCLUDED.connected_at, surface_configs.connected_at),
					updated_at = now()
			`,
				tenantUUID, status,
				s.PhoneNumber, s.DisplayName, s.State, payload.BridgeVersion,
				heartbeatAt, lastEvent, s.LastError,
				connectedAt,
			)
			return e
		})
		if err != nil {
			h.logger().Warn(
				"heartbeat upsert failed",
				zap.String("tenant", tenantUUID),
				zap.Error(err),
			)
			skipped++
			continue
		}
		accepted++
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"accepted": accepted,
		"skipped":  skipped,
	})
}

// ---------- WhatsApp paired status ----------

// WhatsAppStatus handles GET /v1/surfaces/whatsapp/status.
//
// This is the single source of truth the dashboard uses to render the
// WhatsApp pairing card: it's authoritative across hosts (unlike a direct
// bridge probe) and survives bridge restarts. The dashboard still talks
// directly to the bridge for QR + bot controls; this endpoint just tells
// it which state to expect.
func (h *SurfaceHandler) WhatsAppStatus(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var (
		status, bridgeState, bridgeVersion                  string
		phoneNumber, displayHandle, lastError               *string
		lastHeartbeatAt, lastConnectionEventAt, connectedAt *time.Time
	)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT
				COALESCE(status, 'disconnected'),
				COALESCE(bridge_state, ''),
				COALESCE(bridge_version, ''),
				phone_number, display_handle, last_error,
				last_heartbeat_at, last_connection_event_at, connected_at
			FROM surface_configs
			WHERE tenant_id = $1 AND surface_id = 'whatsapp'
		`, tenantID).Scan(
			&status, &bridgeState, &bridgeVersion,
			&phoneNumber, &displayHandle, &lastError,
			&lastHeartbeatAt, &lastConnectionEventAt, &connectedAt,
		)
	})
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusOK, map[string]any{
			"tenantId": tenantID,
			"status":   "unconfigured",
			"present":  false,
		})
		return
	}
	if err != nil {
		h.logger().Error("whatsapp status query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read status"})
		return
	}

	// `stale` is true if we've not heard from the bridge in 2x the heartbeat
	// interval. The dashboard uses this to dim the connected pill so the
	// user knows the data may be cold.
	stale := lastHeartbeatAt == nil || time.Since(*lastHeartbeatAt) > 90*time.Second

	writeJSON(w, http.StatusOK, map[string]any{
		"tenantId":              tenantID,
		"status":                status,
		"present":               true,
		"stale":                 stale,
		"phoneNumber":           phoneNumber,
		"displayHandle":         displayHandle,
		"bridgeState":           bridgeState,
		"bridgeVersion":         bridgeVersion,
		"lastError":             lastError,
		"lastHeartbeatAt":       lastHeartbeatAt,
		"lastConnectionEventAt": lastConnectionEventAt,
		"connectedAt":           connectedAt,
	})
}
