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

// DeploymentHandler provides REST endpoints for managing deployments and
// data planes.
type DeploymentHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewDeploymentHandler creates a new DeploymentHandler.
func NewDeploymentHandler(srv *server.Server, auth *AuthHandler) *DeploymentHandler {
	return &DeploymentHandler{srv: srv, auth: auth}
}

func (h *DeploymentHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("deployments")
}

func (h *DeploymentHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return r.Context(), claims.TenantID, nil
}

// ---------- Create deployment ----------

// CreateDeployment handles POST /v1/deployments.
func (h *DeploymentHandler) CreateDeployment(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		AgentName   string `json:"agentName"`
		Version     string `json:"version"`
		Environment string `json:"environment"`
		Message     string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.AgentName == "" || body.Version == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName and version are required"})
		return
	}

	if body.Environment == "" {
		body.Environment = "development"
	}

	initialLogs, _ := json.Marshal([]string{
		"Pulling bundle " + body.AgentName + "@" + body.Version + "...",
		"Deployment initiated",
	})

	var id string
	var createdAt time.Time
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO deployments (tenant_id, agent_name, version, environment, status, deployed_by, message, logs)
		VALUES ($1, $2, $3, $4, 'deploying', $5, $6, $7::jsonb)
		RETURNING id, created_at
	`, tenantID, body.AgentName, body.Version, body.Environment, tenantID, body.Message, string(initialLogs)).Scan(&id, &createdAt)
	if err != nil {
		h.logger().Error("create deployment failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create deployment"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":          id,
		"tenantId":    tenantID,
		"agentName":   body.AgentName,
		"version":     body.Version,
		"environment": body.Environment,
		"status":      "deploying",
		"message":     body.Message,
		"createdAt":   createdAt,
	})
}

// ---------- List deployments ----------

// ListDeployments handles GET /v1/deployments.
func (h *DeploymentHandler) ListDeployments(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id, agent_name, version, environment, status, deployed_by, message, logs, created_at, finished_at
		FROM deployments
		WHERE tenant_id = $1
		ORDER BY created_at DESC
		LIMIT 100
	`, tenantID)
	if err != nil {
		h.logger().Error("list deployments failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list deployments"})
		return
	}
	defer rows.Close()

	result := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id, agentName, version, environment, status string
			deployedBy                                  *string
			message                                     *string
			logs                                        []byte
			createdAt                                   time.Time
			finishedAt                                  *time.Time
		)
		if err := rows.Scan(&id, &agentName, &version, &environment, &status, &deployedBy, &message, &logs, &createdAt, &finishedAt); err != nil {
			h.logger().Error("scan deployment row failed", zap.Error(err))
			continue
		}

		var logEntries []string
		json.Unmarshal(logs, &logEntries) //nolint:errcheck

		entry := map[string]any{
			"id":          id,
			"tenantId":    tenantID,
			"agentName":   agentName,
			"version":     version,
			"environment": environment,
			"status":      status,
			"logs":        logEntries,
			"createdAt":   createdAt,
		}
		if deployedBy != nil {
			entry["deployedBy"] = *deployedBy
		}
		if message != nil {
			entry["message"] = *message
		}
		if finishedAt != nil {
			entry["finishedAt"] = *finishedAt
		}
		result = append(result, entry)
	}

	writeJSON(w, http.StatusOK, result)
}

// ---------- Get deployment ----------

// GetDeployment handles GET /v1/deployments/{id}.
func (h *DeploymentHandler) GetDeployment(w http.ResponseWriter, r *http.Request) {
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

	var (
		agentName, version, environment, status string
		deployedBy                              *string
		message                                 *string
		logs                                    []byte
		createdAt                               time.Time
		finishedAt                              *time.Time
	)
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT agent_name, version, environment, status, deployed_by, message, logs, created_at, finished_at
		FROM deployments
		WHERE id = $1 AND tenant_id = $2
	`, id, tenantID).Scan(&agentName, &version, &environment, &status, &deployedBy, &message, &logs, &createdAt, &finishedAt)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "deployment not found"})
		return
	}
	if err != nil {
		h.logger().Error("get deployment failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get deployment"})
		return
	}

	var logEntries []string
	json.Unmarshal(logs, &logEntries) //nolint:errcheck

	entry := map[string]any{
		"id":          id,
		"tenantId":    tenantID,
		"agentName":   agentName,
		"version":     version,
		"environment": environment,
		"status":      status,
		"logs":        logEntries,
		"createdAt":   createdAt,
	}
	if deployedBy != nil {
		entry["deployedBy"] = *deployedBy
	}
	if message != nil {
		entry["message"] = *message
	}
	if finishedAt != nil {
		entry["finishedAt"] = *finishedAt
	}

	writeJSON(w, http.StatusOK, entry)
}

// ---------- Register data plane ----------

// RegisterDataPlane handles POST /v1/data-planes.
func (h *DeploymentHandler) RegisterDataPlane(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Name        string         `json:"name"`
		Cloud       string         `json:"cloud"`
		Region      string         `json:"region"`
		ClusterName string         `json:"clusterName"`
		Config      map[string]any `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.Name == "" || body.Cloud == "" || body.Region == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, cloud, and region are required"})
		return
	}

	configJSON, _ := json.Marshal(body.Config)

	var id string
	var createdAt time.Time
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO data_planes (tenant_id, name, cloud, region, cluster_name, status, config, last_heartbeat)
		VALUES ($1, $2, $3, $4, $5, 'provisioning', $6::jsonb, now())
		RETURNING id, created_at
	`, tenantID, body.Name, body.Cloud, body.Region, body.ClusterName, string(configJSON)).Scan(&id, &createdAt)
	if err != nil {
		h.logger().Error("register data plane failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to register data plane"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":            id,
		"tenantId":      tenantID,
		"name":          body.Name,
		"cloud":         body.Cloud,
		"region":        body.Region,
		"clusterName":   body.ClusterName,
		"status":        "provisioning",
		"agentCount":    0,
		"lastHeartbeat": time.Now().UTC(),
		"config":        body.Config,
		"createdAt":     createdAt,
	})
}

// ---------- List data planes ----------

// ListDataPlanes handles GET /v1/data-planes.
func (h *DeploymentHandler) ListDataPlanes(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id, name, cloud, region, cluster_name, status, agent_count, last_heartbeat, config, created_at
		FROM data_planes
		WHERE tenant_id = $1
		ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		h.logger().Error("list data planes failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list data planes"})
		return
	}
	defer rows.Close()

	result := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id, name, cloud, region, status string
			clusterName                     *string
			agentCount                      int
			lastHeartbeat                   *time.Time
			config                          []byte
			createdAt                       time.Time
		)
		if err := rows.Scan(&id, &name, &cloud, &region, &clusterName, &status, &agentCount, &lastHeartbeat, &config, &createdAt); err != nil {
			h.logger().Error("scan data plane row failed", zap.Error(err))
			continue
		}

		var configMap map[string]any
		json.Unmarshal(config, &configMap) //nolint:errcheck

		entry := map[string]any{
			"id":         id,
			"tenantId":   tenantID,
			"name":       name,
			"cloud":      cloud,
			"region":     region,
			"status":     status,
			"agentCount": agentCount,
			"config":     configMap,
			"createdAt":  createdAt,
		}
		if clusterName != nil {
			entry["clusterName"] = *clusterName
		}
		if lastHeartbeat != nil {
			entry["lastHeartbeat"] = *lastHeartbeat
		}
		result = append(result, entry)
	}

	writeJSON(w, http.StatusOK, result)
}

// ---------- Remove data plane ----------

// RemoveDataPlane handles DELETE /v1/data-planes/{id}.
func (h *DeploymentHandler) RemoveDataPlane(w http.ResponseWriter, r *http.Request) {
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
		DELETE FROM data_planes WHERE id = $1 AND tenant_id = $2
	`, id, tenantID)
	if err != nil {
		h.logger().Error("remove data plane failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to remove data plane"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "data plane not found"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
