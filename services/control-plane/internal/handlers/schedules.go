package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/scheduler"
)

// ---------- Schedule REST endpoints ----------

// CreateSchedule handles POST /v1/schedules.
func (h *RESTHandler) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	tenantID, _ := middleware.TenantIDFromContext(ctx)

	var body struct {
		AgentName     string         `json:"agentName"`
		CronExpr      string         `json:"cronExpr"`
		InputTemplate map[string]any `json:"inputTemplate"`
		DeliveryEmail string         `json:"deliveryEmail"`
		Enabled       *bool          `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.AgentName == "" || body.CronExpr == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName and cronExpr are required"})
		return
	}

	// Validate the cron expression.
	nextFire, err := scheduler.NextCronTime(body.CronExpr, time.Now())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cron expression: " + err.Error()})
		return
	}

	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	inputJSON, _ := json.Marshal(body.InputTemplate)
	if body.InputTemplate == nil {
		inputJSON = []byte("{}")
	}

	// Build config (stores deliveryEmail etc.).
	config := map[string]any{}
	if body.DeliveryEmail != "" {
		config["deliveryEmail"] = body.DeliveryEmail
	}
	configJSON, _ := json.Marshal(config)

	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO schedules (tenant_id, agent_name, cron_expr, input_template, config, enabled, next_fire_at)
			VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
			ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
				cron_expr = EXCLUDED.cron_expr,
				input_template = EXCLUDED.input_template,
				config = EXCLUDED.config,
				enabled = EXCLUDED.enabled,
				next_fire_at = EXCLUDED.next_fire_at,
				updated_at = now()
			RETURNING id
		`, tenantID, body.AgentName, body.CronExpr, string(inputJSON), string(configJSON), enabled, nextFire,
		).Scan(&id)
	})
	if err != nil {
		h.logger().Error("CreateSchedule failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":            id,
		"tenantId":      tenantID,
		"agentName":     body.AgentName,
		"cronExpr":      body.CronExpr,
		"inputTemplate": body.InputTemplate,
		"deliveryEmail": body.DeliveryEmail,
		"enabled":       enabled,
		"nextFireAt":    nextFire,
	})
}

// ListSchedules handles GET /v1/schedules.
func (h *RESTHandler) ListSchedules(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	tenantID, _ := middleware.TenantIDFromContext(ctx)

	schedules := make([]map[string]any, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, tenant_id, agent_name, cron_expr, input_template, config, enabled, next_fire_at, last_fired_at, created_at, updated_at
			FROM schedules
			WHERE tenant_id = $1
			ORDER BY created_at DESC
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var (
				id, tid, agentName, cronExpr string
				inputJSON, configJSON        []byte
				enabled                      bool
				nextFireAt, lastFiredAt      *time.Time
				createdAt, updatedAt         time.Time
			)
			if err := rows.Scan(&id, &tid, &agentName, &cronExpr, &inputJSON, &configJSON, &enabled, &nextFireAt, &lastFiredAt, &createdAt, &updatedAt); err != nil {
				h.logger().Error("ListSchedules scan error", zap.Error(err))
				continue
			}

			s := map[string]any{
				"id":        id,
				"tenantId":  tid,
				"agentName": agentName,
				"cronExpr":  cronExpr,
				"enabled":   enabled,
				"createdAt": createdAt,
				"updatedAt": updatedAt,
			}

			var inputTemplate map[string]any
			if len(inputJSON) > 0 {
				_ = json.Unmarshal(inputJSON, &inputTemplate)
			}
			s["inputTemplate"] = inputTemplate

			var config map[string]any
			if len(configJSON) > 0 {
				_ = json.Unmarshal(configJSON, &config)
			}
			if email, ok := config["deliveryEmail"].(string); ok {
				s["deliveryEmail"] = email
			}

			if nextFireAt != nil {
				s["nextFireAt"] = *nextFireAt
			}
			if lastFiredAt != nil {
				s["lastFiredAt"] = *lastFiredAt
			}

			schedules = append(schedules, s)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("ListSchedules failed", zap.Error(err))
		writeJSON(w, http.StatusOK, []map[string]any{})
		return
	}

	writeJSON(w, http.StatusOK, schedules)
}

// UpdateSchedule handles PUT /v1/schedules/{id}.
func (h *RESTHandler) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	tenantID, _ := middleware.TenantIDFromContext(ctx)
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	var body struct {
		CronExpr      *string `json:"cronExpr"`
		DeliveryEmail *string `json:"deliveryEmail"`
		Enabled       *bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Fetch current schedule.
	var currentCronExpr string
	var currentConfigJSON []byte
	var currentEnabled bool
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT cron_expr, config, enabled FROM schedules WHERE id = $1 AND tenant_id = $2`,
			id, tenantID,
		).Scan(&currentCronExpr, &currentConfigJSON, &currentEnabled)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "schedule not found"})
		return
	}

	cronExpr := currentCronExpr
	if body.CronExpr != nil {
		cronExpr = *body.CronExpr
	}
	enabled := currentEnabled
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	var currentConfig map[string]any
	if len(currentConfigJSON) > 0 {
		_ = json.Unmarshal(currentConfigJSON, &currentConfig)
	}
	if currentConfig == nil {
		currentConfig = map[string]any{}
	}
	if body.DeliveryEmail != nil {
		currentConfig["deliveryEmail"] = *body.DeliveryEmail
	}
	configJSON, _ := json.Marshal(currentConfig)

	// Recalculate next fire time.
	nextFire, err := scheduler.NextCronTime(cronExpr, time.Now())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cron expression: " + err.Error()})
		return
	}

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE schedules SET cron_expr = $1, config = $2::jsonb, enabled = $3, next_fire_at = $4, updated_at = now()
			WHERE id = $5 AND tenant_id = $6
		`, cronExpr, string(configJSON), enabled, nextFire, id, tenantID)
		return e
	})
	if err != nil {
		h.logger().Error("UpdateSchedule failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":         id,
		"cronExpr":   cronExpr,
		"enabled":    enabled,
		"nextFireAt": nextFire,
	})
}

// DeleteSchedule handles DELETE /v1/schedules/{id}.
func (h *RESTHandler) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	tenantID, _ := middleware.TenantIDFromContext(ctx)
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx,
			`DELETE FROM schedules WHERE id = $1 AND tenant_id = $2`,
			id, tenantID,
		)
		if execErr != nil {
			return execErr
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("DeleteSchedule failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "schedule not found"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
