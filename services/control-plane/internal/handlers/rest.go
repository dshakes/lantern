package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// RESTHandler wraps the gRPC service handlers to expose them over HTTP/JSON.
type RESTHandler struct {
	srv      *server.Server
	auth     *AuthHandler
	agentSvc *AgentService
	runSvc   *RunService
}

// NewRESTHandler creates a new RESTHandler.
func NewRESTHandler(srv *server.Server, auth *AuthHandler, agentSvc *AgentService, runSvc *RunService) *RESTHandler {
	return &RESTHandler{
		srv:      srv,
		auth:     auth,
		agentSvc: agentSvc,
		runSvc:   runSvc,
	}
}

func (h *RESTHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("rest")
}

// ---------- context helper ----------

// contextWithTenant extracts the JWT from the request, validates it, and returns
// a context that carries the tenant_id in gRPC metadata so the existing gRPC
// handlers can read it via middleware.MustTenantID.
func (h *RESTHandler) contextWithTenant(r *http.Request) (context.Context, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, err
	}

	// The gRPC handlers extract tenant_id from incoming gRPC metadata.
	// We inject it so the same code path works for REST.
	md := metadata.Pairs("tenant_id", claims.TenantID)
	ctx := metadata.NewIncomingContext(r.Context(), md)

	return ctx, nil
}

// ---------- Agent REST endpoints ----------

// ListAgents handles GET /v1/agents.
func (h *RESTHandler) ListAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	resp, err := h.agentSvc.ListAgents(ctx, &lanternv1.ListAgentsRequest{
		PageSize: 100,
	})
	if err != nil {
		h.logger().Error("ListAgents failed", zap.Error(err))
		// Return empty list instead of 500 for common errors (e.g., no agents yet)
		if resp == nil {
			writeJSON(w, http.StatusOK, []map[string]any{})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Convert proto agents to JSON-friendly format.
	agents := make([]map[string]any, 0)
	if resp != nil {
		for _, a := range resp.GetAgents() {
			agents = append(agents, agentToMap(a))
		}
	}

	writeJSON(w, http.StatusOK, agents)
}

// CreateAgent handles POST /v1/agents.
func (h *RESTHandler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Name        string            `json:"name"`
		Description string            `json:"description"`
		Labels      map[string]string `json:"labels"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	agent, err := h.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
		Name:        body.Name,
		Description: body.Description,
		Labels:      body.Labels,
	})
	if err != nil {
		h.logger().Error("CreateAgent failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, agentToMap(agent))
}

// GetAgent handles GET /v1/agents/{name}.
func (h *RESTHandler) GetAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	agent, err := h.agentSvc.GetAgent(ctx, &lanternv1.GetAgentRequest{
		Name: name,
	})
	if err != nil {
		h.logger().Error("GetAgent failed", zap.Error(err))
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, agentToMap(agent))
}

// DeleteAgent handles DELETE /v1/agents/{name}.
func (h *RESTHandler) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	_, err = h.agentSvc.DeleteAgent(ctx, &lanternv1.DeleteAgentRequest{
		Name: name,
	})
	if err != nil {
		h.logger().Error("DeleteAgent failed", zap.Error(err))
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------- Run REST endpoints ----------

// ListRuns handles GET /v1/runs.
func (h *RESTHandler) ListRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	req := &lanternv1.ListRunsRequest{
		PageSize: 100,
	}
	if agentName := r.URL.Query().Get("agent"); agentName != "" {
		req.AgentName = agentName
	}

	resp, err := h.runSvc.ListRuns(ctx, req)
	if err != nil {
		h.logger().Error("ListRuns failed", zap.Error(err))
		if resp == nil {
			writeJSON(w, http.StatusOK, []map[string]any{})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	runs := make([]map[string]any, 0)
	if resp != nil {
		for _, run := range resp.GetRuns() {
			runs = append(runs, runToMap(run))
		}
	}

	writeJSON(w, http.StatusOK, runs)
}

// CreateRun handles POST /v1/runs.
func (h *RESTHandler) CreateRun(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		AgentName string         `json:"agentName"`
		Input     map[string]any `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	inputStruct, _ := structpb.NewStruct(body.Input)

	run, err := h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
		AgentName:   body.AgentName,
		Input:       inputStruct,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_API,
	})
	if err != nil {
		h.logger().Error("CreateRun failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, runToMap(run))
}

// GetRun handles GET /v1/runs/{id}.
func (h *RESTHandler) GetRun(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	run, err := h.runSvc.GetRun(ctx, &lanternv1.GetRunRequest{
		Id: id,
	})
	if err != nil {
		h.logger().Error("GetRun failed", zap.Error(err))
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, runToMap(run))
}

// CancelRun handles POST /v1/runs/{id}/cancel.
func (h *RESTHandler) CancelRun(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, err := h.contextWithTenant(r)
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
		Reason string `json:"reason"`
	}
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck

	run, err := h.runSvc.CancelRun(ctx, &lanternv1.CancelRunRequest{
		Id:     id,
		Reason: body.Reason,
	})
	if err != nil {
		h.logger().Error("CancelRun failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, runToMap(run))
}

// ---------- CORS middleware ----------

// CORSMiddleware wraps an http.Handler to add CORS headers for browser access.
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// ---------- proto to map converters ----------

func agentToMap(a *lanternv1.Agent) map[string]any {
	m := map[string]any{
		"id":        a.GetId(),
		"tenantId":  a.GetTenantId(),
		"name":      a.GetName(),
		"createdAt": a.GetCreatedAt().AsTime(),
		"labels":    a.GetLabels(),
		"status":    "active",
	}
	if a.GetDescription() != "" {
		m["description"] = a.GetDescription()
	}
	if a.GetCurrentVersionId() != "" {
		m["currentVersionId"] = a.GetCurrentVersionId()
	}
	if a.GetCreatedBy() != "" {
		m["createdBy"] = a.GetCreatedBy()
	}
	if a.GetArchivedAt() != nil {
		m["archivedAt"] = a.GetArchivedAt().AsTime()
		m["status"] = "archived"
	}
	return m
}

func runToMap(r *lanternv1.Run) map[string]any {
	m := map[string]any{
		"id":             r.GetId(),
		"tenantId":       r.GetTenantId(),
		"agentId":        r.GetAgentId(),
		"agentVersionId": r.GetAgentVersionId(),
		"status":         runStatusToString(r.GetStatus()),
		"costUsd":        r.GetCostUsd(),
		"tokensIn":       r.GetTokensIn(),
		"tokensOut":      r.GetTokensOut(),
		"createdAt":      r.GetCreatedAt().AsTime(),
		"labels":         r.GetLabels(),
	}
	if r.GetInput() != nil {
		m["input"] = r.GetInput().AsMap()
	}
	if r.GetOutput() != nil {
		m["output"] = r.GetOutput().AsMap()
	}
	if r.GetStartedAt() != nil {
		m["startedAt"] = r.GetStartedAt().AsTime()
	}
	if r.GetFinishedAt() != nil {
		m["finishedAt"] = r.GetFinishedAt().AsTime()
	}
	if r.GetParentRunId() != "" {
		m["parentRunId"] = r.GetParentRunId()
	}
	if r.GetError() != nil {
		m["error"] = map[string]string{
			"code":    r.GetError().GetCode(),
			"message": r.GetError().GetMessage(),
		}
	}
	return m
}
