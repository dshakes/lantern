package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"github.com/dshakes/lantern/services/control-plane/internal/workflow"
)

// resolveGmailToken looks up the Gmail OAuth access token for a tenant from
// connector_installs. It checks oauth_token_encrypted first (OAuth flow), then
// falls back to config->>'accessToken' (manual install).
func resolveGmailToken(ctx context.Context, pool interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, tenantID string) string {
	// Try oauth_token_encrypted first.
	var oauthTokenJSON []byte
	err := pool.QueryRow(ctx, `
		SELECT oauth_token_encrypted
		FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
	`, tenantID).Scan(&oauthTokenJSON)
	if err == nil && len(oauthTokenJSON) > 0 {
		var tokenData map[string]any
		if jsonErr := json.Unmarshal(oauthTokenJSON, &tokenData); jsonErr == nil {
			if at, ok := tokenData["access_token"].(string); ok && at != "" {
				return at
			}
		}
	}

	// Fall back to config->>'accessToken'.
	var accessToken string
	_ = pool.QueryRow(ctx, `
		SELECT config->>'accessToken'
		FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
	`, tenantID).Scan(&accessToken)

	return accessToken
}

// RESTHandler wraps the gRPC service handlers to expose them over HTTP/JSON.
type RESTHandler struct {
	srv      *server.Server
	auth     *AuthHandler
	agentSvc *AgentService
	runSvc   *RunService
	llmProxy *LlmProxyHandler
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

	// The gRPC handlers extract tenant_id from incoming gRPC metadata via
	// the tenant interceptor. But when called directly from REST (not via
	// the gRPC interceptor chain), we need to also inject it as a context
	// value so middleware.MustTenantID works.
	md := metadata.Pairs("tenant_id", claims.TenantID)
	ctx := metadata.NewIncomingContext(r.Context(), md)

	// Also inject as context value (what MustTenantID actually reads).
	ctx = middleware.InjectTenantID(ctx, claims.TenantID)

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
		Name         string            `json:"name"`
		Description  string            `json:"description"`
		Labels       map[string]string `json:"labels"`
		AvatarURL    *string           `json:"avatarUrl"`
		StylePrompt  *string           `json:"stylePrompt"`
		SystemPrompt *string           `json:"systemPrompt"`
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

	// Optional extension columns (not on the proto Agent message) are
	// persisted with a follow-up UPDATE so the proto path stays untouched.
	if body.AvatarURL != nil || body.StylePrompt != nil || body.SystemPrompt != nil {
		tenantID, _ := middleware.TenantIDFromContext(ctx)
		_, uerr := h.srv.Pool.Exec(ctx, `
			UPDATE agents SET
				avatar_url   = COALESCE($1, avatar_url),
				style_prompt = COALESCE($2, style_prompt),
				system_prompt = COALESCE($3, system_prompt)
			WHERE tenant_id = $4 AND name = $5
		`, body.AvatarURL, body.StylePrompt, body.SystemPrompt, tenantID, body.Name)
		if uerr != nil {
			h.logger().Warn("CreateAgent extension fields failed", zap.Error(uerr))
		}
	}

	out := agentToMap(agent)
	if body.AvatarURL != nil {
		out["avatarUrl"] = *body.AvatarURL
	}
	if body.StylePrompt != nil {
		out["stylePrompt"] = *body.StylePrompt
	}
	if body.SystemPrompt != nil {
		out["systemPrompt"] = *body.SystemPrompt
	}
	writeJSON(w, http.StatusCreated, out)
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

	out := agentToMap(agent)
	// Extension columns not present on the proto Agent (system_prompt,
	// avatar_url, style_prompt) — pulled directly so the dashboard can
	// round-trip them through the create/edit forms.
	tenantID, _ := middleware.TenantIDFromContext(ctx)
	var (
		avatarURL    *string
		stylePrompt  *string
		systemPrompt *string
	)
	if err := h.srv.Pool.QueryRow(ctx, `
		SELECT avatar_url, style_prompt, system_prompt
		FROM agents WHERE tenant_id = $1 AND name = $2
	`, tenantID, name).Scan(&avatarURL, &stylePrompt, &systemPrompt); err == nil {
		if avatarURL != nil {
			out["avatarUrl"] = *avatarURL
		}
		if stylePrompt != nil {
			out["stylePrompt"] = *stylePrompt
		}
		if systemPrompt != nil {
			out["systemPrompt"] = *systemPrompt
		}
	}
	writeJSON(w, http.StatusOK, out)
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

// UpdateAgent handles PATCH /v1/agents/{name}. Currently supports updating
// the system prompt used by interactive sessions and the chat surfaces.
func (h *RESTHandler) UpdateAgent(w http.ResponseWriter, r *http.Request) {
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

	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	var body struct {
		SystemPrompt *string `json:"systemPrompt"`
		AvatarURL    *string `json:"avatarUrl"`
		StylePrompt  *string `json:"stylePrompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.SystemPrompt == nil && body.AvatarURL == nil && body.StylePrompt == nil {
		writeJSON(w, http.StatusOK, map[string]any{"name": name, "updated": false})
		return
	}

	tag, err := h.srv.Pool.Exec(ctx, `
		UPDATE agents SET
			system_prompt = COALESCE($1, system_prompt),
			avatar_url    = COALESCE($2, avatar_url),
			style_prompt  = COALESCE($3, style_prompt)
		WHERE name = $4 AND tenant_id = $5
	`, body.SystemPrompt, body.AvatarURL, body.StylePrompt, name, tenantID)
	if err != nil {
		h.logger().Error("UpdateAgent failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "update failed"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"name": name, "updated": true})
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
			m := runToMap(run)
			// Enrich: execution steps + agent name
			var rawSteps []byte
			var agentName string
			_ = h.srv.Pool.QueryRow(ctx,
				`SELECT r.trigger_meta, COALESCE(a.name, '') FROM runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = $1`,
				run.GetId(),
			).Scan(&rawSteps, &agentName)
			if len(rawSteps) > 0 && rawSteps[0] == '[' {
				var steps []any
				if json.Unmarshal(rawSteps, &steps) == nil {
					m["triggerMeta"] = steps
				}
			}
			if agentName != "" {
				m["agentName"] = agentName
			}
			runs = append(runs, m)
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

	// Ensure the agent exists — auto-create if not found.
	_, getErr := h.agentSvc.GetAgent(ctx, &lanternv1.GetAgentRequest{Name: body.AgentName})
	if getErr != nil {
		// Agent doesn't exist — create it with a default version.
		h.logger().Info("auto-creating agent for run", zap.String("agent", body.AgentName))
		_, createErr := h.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
			Name:        body.AgentName,
			Description: "Auto-created by run request",
		})
		if createErr != nil {
			h.logger().Warn("auto-create agent failed", zap.Error(createErr))
			// Continue anyway — maybe it was a race condition.
		}
	}

	run, err := h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
		AgentName:   body.AgentName,
		Input:       inputStruct,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_API,
	})
	if err != nil {
		// The most common error is "agent has no promoted version".
		// For the spike, auto-create a version and retry once.
		errStr := err.Error()
		if strings.Contains(errStr, "no promoted version") || strings.Contains(errStr, "not found") {
			h.autoCreateVersion(ctx, body.AgentName)
			run, err = h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
				AgentName:   body.AgentName,
				Input:       inputStruct,
				TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_API,
			})
		}
		if err != nil {
			h.logger().Error("CreateRun failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}

	// Kick off inline execution in a background goroutine so the run
	// transitions from queued → running → succeeded without needing the
	// separate workflow-engine service.
	if h.llmProxy != nil {
		go h.executeRunInline(run.GetId(), run.GetTenantId(), body.AgentName, body.Input)
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

	result := runToMap(run)
	// Enrich: execution steps + agent name
	var rawSteps []byte
	var agentName string
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT r.trigger_meta, COALESCE(a.name, '') FROM runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = $1`, id,
	).Scan(&rawSteps, &agentName)
	if len(rawSteps) > 0 && rawSteps[0] == '[' {
		var steps []any
		if json.Unmarshal(rawSteps, &steps) == nil {
			result["triggerMeta"] = steps
		}
	}
	if agentName != "" {
		result["agentName"] = agentName
	}
	writeJSON(w, http.StatusOK, result)
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

// DeleteRun handles DELETE /v1/runs/{id}.
func (h *RESTHandler) DeleteRun(w http.ResponseWriter, r *http.Request) {
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

	_, err = h.srv.Pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, id)
	if err != nil {
		h.logger().Error("DeleteRun failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusNoContent)
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

// SetLlmProxy injects the LLM proxy handler for inline run execution.
func (h *RESTHandler) SetLlmProxy(proxy *LlmProxyHandler) {
	h.llmProxy = proxy
}

// executeRunInline processes a run in the background by calling the LLM
// directly. This is the spike-mode "workflow engine" — in production, the
// separate workflow-engine service handles this with durable execution.
func (h *RESTHandler) executeRunInline(runID, tenantID, agentName string, input map[string]any) {
	ctx := context.Background()
	ctx = middleware.InjectTenantID(ctx, tenantID)
	md := metadata.Pairs("tenant_id", tenantID)
	ctx = metadata.NewIncomingContext(ctx, md)

	h.logger().Info("inline executor: starting run", zap.String("run_id", runID), zap.String("agent", agentName))

	// Helper to log execution steps to the run's trigger_meta field (used as steps log)
	logStep := func(stepName, status, detail string) {
		step := map[string]string{"step": stepName, "status": status, "detail": detail, "ts": time.Now().Format(time.RFC3339)}
		stepJSON, _ := json.Marshal(step)
		// Append to trigger_meta as a JSON array of steps
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET trigger_meta = CASE
				WHEN trigger_meta IS NULL OR trigger_meta::text = '{}' THEN jsonb_build_array($2::jsonb)
				ELSE trigger_meta || $2::jsonb
			END WHERE id = $1`,
			runID, string(stepJSON),
		)
	}

	// 1. Mark as running.
	logStep("initialize", "running", "Starting agent execution")
	_, err := h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
		runID,
	)
	if err != nil {
		h.logger().Error("inline executor: failed to mark running", zap.Error(err))
		return
	}

	// 1a. If the agent has a saved workflow graph, hand off to the workflow
	// interpreter (W11b). Otherwise fall through to the simple single-LLM-
	// call path below. Workflow execution emits journal_events per node so
	// the RunWaterfall renders the full graph.
	if h.runWorkflowIfPresent(ctx, runID, tenantID, agentName, input) {
		return
	}

	// 2. Build messages from the agent's stored system_prompt + the input.
	//    Up until now this used a generic "You are the agent X, process this
	//    input" fallback that ignored the agent's real instructions — which
	//    is why Morning Brief (whose template prompt says "use the GitHub
	//    connector / Linear connector") was responding "no connectors
	//    provided": the model literally never saw that prompt.
	logStep("build_prompt", "running", "Building prompt from agent configuration")
	inputJSON, _ := json.Marshal(input)
	var storedSystemPrompt *string
	var labelsJSON []byte
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT system_prompt, COALESCE(labels, '{}'::jsonb)::text::bytea FROM agents WHERE name = $1 AND tenant_id = $2`,
		agentName, tenantID,
	).Scan(&storedSystemPrompt, &labelsJSON)
	systemPromptStr := fmt.Sprintf("You are the agent '%s'. Process the user's input and produce a useful result.", agentName)
	// resolvedTemplateID drives prefetch dispatch — MUST be set on every
	// run, not just freshly-backfilled ones. Earlier bug: backfill ran
	// once, populated system_prompt, but NOT labels. Subsequent runs
	// skipped the backfill block (system_prompt now non-empty) and
	// resolvedTemplateID stayed empty, so prefetch silently returned
	// false and tools attached when they shouldn't.
	//
	// Resolve in two steps, every run:
	//   1. labels.lantern.template (set by templates.Apply OR back-fill)
	//   2. agent-name == template-name (covers any agent named after a
	//      registered template, even with no labels)
	resolvedTemplateID := ""
	{
		var lbl struct {
			TemplateID string `json:"lantern.template"`
		}
		_ = json.Unmarshal(labelsJSON, &lbl)
		resolvedTemplateID = lbl.TemplateID
	}
	if resolvedTemplateID == "" {
		if _, ok := templates[agentName]; ok {
			resolvedTemplateID = agentName
		}
	}
	if storedSystemPrompt != nil && *storedSystemPrompt != "" {
		systemPromptStr = *storedSystemPrompt
	} else {
		// Lazy back-fill for agents that pre-date templates.go storing
		// system_prompt. resolvedTemplateID was already set above.
		var tpl templateDef
		var found bool
		if resolvedTemplateID != "" {
			tpl, found = templates[resolvedTemplateID]
		}
		if found && tpl.SystemPrompt != "" {
			systemPromptStr = tpl.SystemPrompt
			// Persist system_prompt AND labels so the next run sees
			// lbl.TemplateID and can hit step 1 above (no name-match
			// fallback needed) — and the setup gate can re-derive
			// required_connectors/surfaces too.
			labelsPatch, _ := json.Marshal(map[string]any{
				"lantern.template":            tpl.ID,
				"lantern.required_connectors": tpl.Connectors,
				"lantern.required_surfaces":   tpl.Surfaces,
			})
			_, _ = h.srv.Pool.Exec(ctx,
				`UPDATE agents
				 SET system_prompt = $1,
				     model = COALESCE(NULLIF(model,''), $2),
				     labels = COALESCE(labels, '{}'::jsonb) || $5::jsonb
				 WHERE name = $3 AND tenant_id = $4`,
				tpl.SystemPrompt, tpl.Model, agentName, tenantID, string(labelsPatch),
			)
			logStep("backfill_prompt", "completed", fmt.Sprintf("Restored system prompt from template '%s'", tpl.ID))
		}
	}
	// User-side content. When called via Run Now with no input, give the
	// model a sensible default ask matching the template's intent rather
	// than feeding it `{}` which it interprets as "input is empty".
	userContent := string(inputJSON)
	if len(input) == 0 || userContent == "{}" || userContent == "null" {
		userContent = "This is a Run Now invocation — execute the workflow described in your system prompt right now. Call the tools you have available; do not ask me for clarification or claim you can't access anything."
	}
	prompt := fmt.Sprintf("%s\n\n%s", systemPromptStr, userContent)

	// 2c. Deterministic pre-fetch for templates whose data sources we know
	//     up-front (Morning Brief, etc.). Fetches everything server-side and
	//     hands the formatted text to the LLM, so the model only has to
	//     summarize — no tool-use loop, works on cheap models, can't fail
	//     with 'no connectors set up' gaslighting. Falls through to the
	//     tool-use loop for custom agents that don't have a prefetch.
	prefetched, hasPrefetch := prefetchForTemplate(ctx, h.srv.Pool, tenantID, resolvedTemplateID, userContent)
	if hasPrefetch {
		detail := fmt.Sprintf("%d sources fetched", len(prefetched.Sources))
		if len(prefetched.Errors) > 0 {
			detail += fmt.Sprintf(", %d errored", len(prefetched.Errors))
		}
		logStep("prefetch", "completed", detail)
		// Replace the user message with the prefetched markdown + an
		// explicit summarize directive. The system prompt's workflow
		// instructions are unchanged; the model just doesn't need to
		// call any tools to follow them anymore.
		userContent = "# Pre-fetched data\n\n" + prefetched.Body +
			"\n\n# Your task\n\nUsing ONLY the data above, synthesize the brief per your system prompt's instructions. Do NOT call any tools. If a section is missing or shows an error, briefly acknowledge it and continue with what's available."
		prompt = fmt.Sprintf("%s\n\n%s", systemPromptStr, userContent)
	}

	// 2b. Check if this agent has Gmail in its connector config.
	// The agent's connector list is stored in the input JSON under "connectors"
	// or we check if the agent has a Gmail connector explicitly linked.
	// For now, check the input for a "useGmail" flag, or check if the agent
	// description/labels mention email. The proper fix: read agent's connector
	// config from a dedicated table.
	agentUsesGmail := false
	if connectors, ok := input["connectors"]; ok {
		if connList, ok := connectors.([]any); ok {
			for _, c := range connList {
				if cs, ok := c.(string); ok && (cs == "Gmail" || cs == "gmail") {
					agentUsesGmail = true
				}
			}
		}
	}
	// Also check if explicitly requested in the input
	if _, ok := input["fetchEmails"]; ok {
		agentUsesGmail = true
	}

	var gmailToken string
	if agentUsesGmail {
		logStep("fetch_data", "running", "Fetching data from connected sources")
		gmailToken = resolveGmailToken(ctx, h.srv.Pool, tenantID)
	// Try to refresh the token before use
	if gmailToken != "" {
		var refreshToken string
		var oauthJSON []byte
		_ = h.srv.Pool.QueryRow(ctx,
			`SELECT oauth_token_encrypted FROM connector_installs WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'`,
			tenantID,
		).Scan(&oauthJSON)
		if len(oauthJSON) > 0 {
			var tok map[string]any
			if json.Unmarshal(oauthJSON, &tok) == nil {
				if rt, ok := tok["refresh_token"].(string); ok { refreshToken = rt }
			}
		}
		if refreshToken != "" {
			if newToken, err := refreshGoogleToken(refreshToken); err == nil && newToken != "" {
				gmailToken = newToken
				updatedOAuth, _ := json.Marshal(map[string]any{"access_token": newToken, "refresh_token": refreshToken, "token_type": "Bearer"})
				_, _ = h.srv.Pool.Exec(ctx, `UPDATE connector_installs SET oauth_token_encrypted = $1 WHERE tenant_id = $2 AND connector_id = 'gmail'`, string(updatedOAuth), tenantID)
			}
		}
	}
	if gmailToken != "" {
		logStep("fetch_gmail", "running", "Fetching emails from Gmail API")
		emails, fetchErr := FetchGmailViaAPI(gmailToken, 20)
		if fetchErr == nil && len(emails) > 0 {
			logStep("fetch_gmail", "completed", fmt.Sprintf("Fetched %d emails", len(emails)))
			var emailText strings.Builder
			emailText.WriteString("\n\nHere are the user's recent emails:\n\n")
			for i, e := range emails {
				emailText.WriteString(fmt.Sprintf("%d. From: %s\n   Subject: %s\n   Preview: %s\n   Date: %s\n\n",
					i+1, e.From, e.Subject, e.Snippet, e.Date))
			}
			prompt += emailText.String()
		} else if fetchErr != nil {
			h.logger().Warn("inline executor: Gmail fetch failed, continuing without emails",
				zap.String("run_id", runID), zap.Error(fetchErr))
		}
	} else {
		// Try IMAP with email + app password
		var email, appPassword string
		_ = h.srv.Pool.QueryRow(ctx,
			`SELECT config->>'email', config->>'appPassword' FROM connector_installs WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'`,
			tenantID,
		).Scan(&email, &appPassword)

		if email != "" && appPassword != "" {
			emails, fetchErr := FetchGmailViaIMAP(email, appPassword, 20)
			if fetchErr == nil && len(emails) > 0 {
				var emailText strings.Builder
				emailText.WriteString("\n\nHere are the user's recent emails (fetched via IMAP):\n\n")
				for i, e := range emails {
					emailText.WriteString(fmt.Sprintf("%d. From: %s\n   Subject: %s\n   Preview: %s\n   Date: %s\n\n",
						i+1, e.From, e.Subject, e.Snippet, e.Date))
				}
				prompt += emailText.String()
			} else if fetchErr != nil {
				h.logger().Warn("inline executor: IMAP Gmail fetch failed", zap.String("run_id", runID), zap.Error(fetchErr))
			}
		} else {
			prompt += "\n\nNote: Gmail is not connected. The user may paste email content manually, or you should explain how to connect Gmail."
		}
	}
	} // end isEmailAgent

	// 3. Call the LLM. Use the tenant-aware resolver so auto-routing picks
	// from providers configured in Settings, not just the process env.
	logStep("call_llm", "running", "Sending to AI model for processing")
	provider, model := h.llmProxy.resolveModelForTenant(ctx, tenantID, "auto")
	apiKey, err := h.llmProxy.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		altProvider := "anthropic"
		if provider == "anthropic" {
			altProvider = "openai"
		}
		if altKey, altErr := h.llmProxy.resolveProviderKey(ctx, tenantID, altProvider); altErr == nil {
			provider = altProvider
			apiKey = altKey
			if provider == "openai" {
				model = "gpt-4o"
			} else {
				model = "claude-sonnet-4-20250514"
			}
		} else {
			h.logger().Warn("inline executor: no LLM key, marking failed", zap.Error(err))
			_, _ = h.srv.Pool.Exec(ctx,
				`UPDATE runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
				runID, fmt.Sprintf(`{"code":"no_llm","message":"%s"}`, err.Error()),
			)
			return
		}
	}

	// Build messages + tools for the tool-use loop. The inline executor
	// previously called callLLMSync with a single concatenated prompt and
	// no tools — Run Now would happily reply "no connectors provided"
	// even when GitHub/Linear/Gmail were all connected. With tools wired
	// here, Run Now matches the Chat tab's behavior exactly.
	llmMessages := []map[string]any{
		{"role": "system", "content": systemPromptStr},
		{"role": "user", "content": userContent},
	}
	// If we pre-fetched Gmail above and appended to `prompt`, keep that
	// inline-context flow intact by sending the augmented user content.
	if prompt != systemPromptStr+"\n\n"+userContent {
		// The Gmail branch above mutated `prompt`. Use whatever was after
		// the system prompt as the user message body.
		llmMessages[1] = map[string]any{"role": "user", "content": strings.TrimPrefix(prompt, systemPromptStr+"\n\n")}
	}
	var llmTools []map[string]any
	if hasPrefetch {
		// Pre-fetch did the work — no tools attached so the model just
		// summarizes. Saves 700+ tokens of tool definitions per call and
		// removes the model's option to refuse / hallucinate.
		logStep("attach_tools", "completed", "0 tools (prefetch mode — model summarizes the fetched data)")
	} else {
		var llmToolsErr error
		llmTools, llmToolsErr = toolsForTenant(ctx, h.srv.Pool, tenantID)
		if llmToolsErr != nil {
			h.logger().Warn("inline executor: tools lookup failed",
				zap.String("run_id", runID), zap.Error(llmToolsErr))
		}
	}
	// When tools ARE attached, models still routinely refuse to call them
	// because the system prompt's mention of e.g. 'the GitHub connector'
	// reads to them as a requirement, not as the tools they actually have.
	// Append a hard, explicit binding from prompt-vocabulary to tool-names
	// to the system message so the model can't mistake the two.
	if len(llmTools) > 0 {
		availableNames := make([]string, 0, len(llmTools))
		for _, t := range llmTools {
			if fn, ok := t["function"].(map[string]any); ok {
				if n, ok := fn["name"].(string); ok {
					availableNames = append(availableNames, n)
				}
			}
		}
		systemPromptStr += fmt.Sprintf(`

# Available tools (call these — they ARE the connectors)
You currently have these tools attached and ready to call: %s.
When the instructions above mention a 'GitHub connector', 'Linear connector',
'Gmail connector', etc., they refer to the matching tools in this list.
DO NOT respond with "I don't have access" — the tools are right here. Call them.`, strings.Join(availableNames, ", "))
	}
	// Tool-shy models (gpt-4o-mini, haiku) routinely refuse to call tools
	// that ARE in the request, then lie 'I can't access the tools'. If we
	// have tools attached and the resolver picked a small model, upgrade
	// to the same provider's strong model. Cheaper for the user too —
	// nothing more expensive than paying tokens for an LLM that pretends
	// it can't see its tools.
	if len(llmTools) > 0 {
		switch model {
		case "gpt-4o-mini":
			model = "gpt-4o"
			logStep("upgrade_model", "completed", "Upgraded gpt-4o-mini → gpt-4o for tool-use reliability")
		case "claude-haiku-4-20250414":
			model = "claude-sonnet-4-20250514"
			logStep("upgrade_model", "completed", "Upgraded haiku-4 → sonnet-4 for tool-use reliability")
		}
	}
	if !hasPrefetch {
		// Surface the count + which connectors made it through the
		// install filter. Without this it's invisible whether the model
		// got 0, 3, or 10 tools — and tool-shy responses look identical
		// to no-tools-attached responses.
		// Skipped in prefetch mode since attach_tools was logged earlier
		// with the prefetch detail.
		names := make([]string, 0, len(llmTools))
		for _, t := range llmTools {
			if fn, ok := t["function"].(map[string]any); ok {
				if n, ok := fn["name"].(string); ok {
					names = append(names, n)
				}
			}
		}
		detail := fmt.Sprintf("%d tools attached", len(llmTools))
		if len(names) > 0 {
			detail = fmt.Sprintf("%d tools: %s", len(llmTools), strings.Join(names, ", "))
		}
		logStep("attach_tools", "completed", detail)
		h.logger().Info("inline executor: tools attached",
			zap.String("run_id", runID),
			zap.String("tenant", tenantID),
			zap.Int("count", len(llmTools)),
			zap.Strings("tools", names),
		)
	}
	llmDispatch := func(dctx context.Context, name string, args map[string]any) (any, error) {
		return dispatchTool(dctx, h.srv.Pool, tenantID, name, args)
	}
	onToolCallStep := func(inv ToolInvocation) {
		argsJSON, _ := json.Marshal(inv.Args)
		switch {
		case inv.Error != "":
			logStep(fmt.Sprintf("tool:%s", inv.Name), "failed", inv.Error)
		case inv.Result != nil:
			resultJSON, _ := json.Marshal(inv.Result)
			s := string(resultJSON)
			if len(s) > 400 {
				s = s[:400] + "..."
			}
			logStep(fmt.Sprintf("tool:%s", inv.Name), "completed", s)
		default:
			logStep(fmt.Sprintf("tool:%s", inv.Name), "running", string(argsJSON))
		}
	}

	_ = provider // resolved by failover loop below
	_ = model
	_ = apiKey
	// Per-attempt step: shows the run waterfall which provider answered
	// and which (if any) failed over. Surfaces multi-provider failover
	// when Anthropic is out of credits and OpenAI takes over (or v.v.).
	onAttempt := func(att candidateAttempt) {
		label := fmt.Sprintf("llm:%s/%s", att.Provider, att.Model)
		if att.Err != nil {
			logStep(label, "failed", truncate(att.Err.Error(), 200))
		} else {
			logStep(label, "completed", "answered")
		}
	}
	result, _, usedProvider, usedModel, tokensIn, tokensOut, llmErr := h.llmProxy.callLLMWithFailover(
		ctx, tenantID,
		llmMessages, llmTools, llmDispatch, onToolCallStep, onAttempt, 5,
	)
	if llmErr == nil {
		provider = usedProvider
		model = usedModel
	}
	costUsd := estimateCost(provider, model, int(tokensIn), int(tokensOut))

	if llmErr != nil {
		h.logger().Error("inline executor: LLM call failed", zap.Error(llmErr))
		errJSON, _ := json.Marshal(map[string]string{"code": "llm_error", "message": llmErr.Error()})
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
			runID, string(errJSON),
		)
		return
	}

	// 4. Mark as succeeded with output.
	logStep("call_llm", "completed", fmt.Sprintf("Response from %s/%s: %d tokens", provider, model, tokensOut))
	logStep("save_output", "running", "Saving results")
	outputJSON, _ := json.Marshal(map[string]string{"result": result})
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'succeeded', finished_at = now(), output = $2::jsonb, tokens_in = $3, tokens_out = $4, cost_usd = $5 WHERE id = $1`,
		runID, string(outputJSON), tokensIn, tokensOut, costUsd,
	)

	logStep("complete", "completed", fmt.Sprintf("Run finished: %d tokens, $%.4f", tokensIn+tokensOut, costUsd))

	h.logger().Info("inline executor: run completed",
		zap.String("run_id", runID),
		zap.Int64("tokens_in", tokensIn),
		zap.Int64("tokens_out", tokensOut),
	)

	// 5. Check if email delivery is configured for this agent's schedule.
	var deliveryEmail string
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT config->>'deliveryEmail' FROM schedules WHERE tenant_id = $1 AND agent_name = $2 AND enabled = true`,
		tenantID, agentName,
	).Scan(&deliveryEmail)

	if deliveryEmail != "" {
		go func() {
			if err := h.sendEmailViaGmail(tenantID, deliveryEmail, fmt.Sprintf("Lantern: %s run completed", agentName), result); err != nil {
				h.logger().Warn("email delivery failed",
					zap.String("run_id", runID),
					zap.String("to", deliveryEmail),
					zap.Error(err),
				)
			} else {
				h.logger().Info("email delivered",
					zap.String("run_id", runID),
					zap.String("to", deliveryEmail),
				)
			}
		}()
	}
}

// runWorkflowIfPresent loads agents.workflow for the given agent and, if a
// valid graph is stored, runs it via the workflow interpreter. Returns
// true if the workflow was executed (caller short-circuits the single-
// LLM-call path); false if the agent has no workflow and should fall
// through to the legacy executor.
//
// All side-effects (LLM, connector, tool, journal_events) are wired
// through the shared resolveProviderKey + connector dispatch + writer
// that the rest of the run pipeline uses — the interpreter doesn't
// bypass auth, tenant-scoped keys, or audit logging.
func (h *RESTHandler) runWorkflowIfPresent(ctx context.Context, runID, tenantID, agentName string, input map[string]any) bool {
	if h.llmProxy == nil {
		return false
	}
	var wfRaw []byte
	err := h.srv.Pool.QueryRow(ctx,
		`SELECT COALESCE(workflow, '{}'::jsonb)::text::bytea FROM agents WHERE name = $1 AND tenant_id = $2`,
		agentName, tenantID,
	).Scan(&wfRaw)
	if err != nil || len(wfRaw) == 0 {
		return false
	}
	var def workflow.Definition
	if err := json.Unmarshal(wfRaw, &def); err != nil || len(def.Nodes) == 0 {
		return false
	}

	deps := workflow.Deps{
		CallLLM: func(ctx context.Context, prompt, capability string) (string, error) {
			provider, model := h.llmProxy.resolveModelForTenant(ctx, tenantID, capability)
			apiKey, err := h.llmProxy.resolveProviderKey(ctx, tenantID, provider)
			if err != nil {
				return "", err
			}
			text, _, _, _, llmErr := h.llmProxy.callLLMSync(ctx, provider, model, apiKey, prompt)
			return text, llmErr
		},
		CallConnector: func(ctx context.Context, connectorID, action string, params map[string]any) (any, error) {
			// In-process dispatch matching the HTTP path in
			// /v1/connectors/{id}/execute. We load credentials for the
			// tenant + connector and call the same execute<Connector>
			// helpers used elsewhere.
			return dispatchConnectorInProc(ctx, h.srv.Pool, tenantID, connectorID, action, params)
		},
		CallTool: func(_ context.Context, tool string, params map[string]any) (any, error) {
			// Built-in tools are still under-built (web.search etc. live
			// in the runtime-manager). Return a structured "skipped"
			// payload so the workflow proceeds — failing here would
			// strand workflows that reference tools we haven't shipped.
			return map[string]any{
				"skipped": true,
				"tool":    tool,
				"params":  params,
				"reason":  "tool runtime not wired into control-plane yet",
			}, nil
		},
		EmitEvent: func(ctx context.Context, ev workflow.JournalEvent) error {
			payload, _ := json.Marshal(ev.Payload)
			_, err := h.srv.Pool.Exec(ctx,
				`INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (run_id, seq) DO NOTHING`,
				runID, ev.Seq, ev.Kind, ev.StepID, ev.Attempt, payload,
			)
			return err
		},
		WaitForApproval: func(ctx context.Context, runID, stepID, reason string) (workflow.ApprovalDisposition, error) {
			// W11a: open a takeover request and poll until a human flips
			// its status. The dashboard surfaces pending requests and
			// operators grant/release them. We poll once a second; for
			// real production load this should switch to LISTEN/NOTIFY
			// on a Postgres channel — punting that to a follow-up.
			var takeoverID string
			err := h.srv.Pool.QueryRow(ctx, `
				INSERT INTO takeover_requests (run_id, tenant_id, step_id, reason, status, expires_at)
				VALUES ($1, $2, $3, $4, 'pending', now() + interval '30 minutes')
				RETURNING id::text
			`, runID, tenantID, stepID, reason).Scan(&takeoverID)
			if err != nil {
				return workflow.ApprovalDisposition{}, fmt.Errorf("create takeover row: %w", err)
			}

			ticker := time.NewTicker(1 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return workflow.ApprovalDisposition{}, ctx.Err()
				case <-ticker.C:
					var status, notes string
					var expiresAt *time.Time
					err := h.srv.Pool.QueryRow(ctx, `
						SELECT status, COALESCE(notes, ''), expires_at
						FROM takeover_requests WHERE id = $1
					`, takeoverID).Scan(&status, &notes, &expiresAt)
					if err != nil {
						continue
					}
					switch status {
					case "released":
						return workflow.ApprovalDisposition{Granted: true, Reason: notes}, nil
					case "denied":
						return workflow.ApprovalDisposition{Granted: false, Reason: notes}, nil
					case "expired":
						return workflow.ApprovalDisposition{Granted: false, Reason: "approval expired"}, nil
					}
					// Mark expired ourselves if the wall-clock passed.
					if expiresAt != nil && time.Now().After(*expiresAt) {
						_, _ = h.srv.Pool.Exec(ctx, `
							UPDATE takeover_requests SET status = 'expired' WHERE id = $1
						`, takeoverID)
						return workflow.ApprovalDisposition{Granted: false, Reason: "approval timed out"}, nil
					}
				}
			}
		},
	}

	res, runErr := workflow.Run(ctx, runID, deps, def, input)
	if runErr != nil {
		errJSON, _ := json.Marshal(map[string]string{"code": "workflow_error", "message": runErr.Error()})
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
			runID, string(errJSON),
		)
		return true
	}
	if res.Failed {
		errJSON, _ := json.Marshal(map[string]any{
			"code":    "workflow_step_failed",
			"message": res.LastError,
			"stepId":  res.FailedAt,
		})
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
			runID, string(errJSON),
		)
		return true
	}

	outputJSON, _ := json.Marshal(map[string]any{"result": res.Output, "stepsRan": res.StepsRan})
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'succeeded', finished_at = now(), output = $2::jsonb WHERE id = $1`,
		runID, string(outputJSON),
	)
	h.logger().Info("workflow run completed",
		zap.String("run_id", runID),
		zap.Int("steps_ran", res.StepsRan),
	)
	return true
}

// dispatchConnectorInProc is a slim wrapper that mirrors what the HTTP
// connector-executor handler does, minus the request/response plumbing.
// It loads the tenant's encrypted oauth token / connector config and
// hands them to the same execute* helpers.
func dispatchConnectorInProc(ctx context.Context, pool *pgxpool.Pool, tenantID, connectorID, action string, params map[string]any) (any, error) {
	var configRaw, oauthRaw []byte
	err := pool.QueryRow(ctx,
		`SELECT COALESCE(config, '{}'::jsonb)::text::bytea,
		        COALESCE(oauth_token_encrypted, '{}'::jsonb)::text::bytea
		 FROM connector_installs
		 WHERE tenant_id = $1 AND connector_id = $2 AND status = 'connected'`,
		tenantID, connectorID,
	).Scan(&configRaw, &oauthRaw)
	if err != nil {
		return nil, fmt.Errorf("connector %s not installed for this tenant", connectorID)
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(configRaw, &cfg)
	if len(oauthRaw) > 0 {
		var tok map[string]any
		if json.Unmarshal(oauthRaw, &tok) == nil {
			if at, ok := tok["access_token"].(string); ok && at != "" {
				cfg["oauth_access_token"] = at
				cfg["accessToken"] = at
			}
		}
	}
	switch connectorID {
	case "gmail":
		return executeGmail(cfg, action, params)
	case "slack":
		return executeSlack(cfg, action, params)
	case "github":
		return executeGitHub(cfg, action, params)
	case "notion":
		return executeNotion(cfg, action, params)
	case "linear":
		return executeLinear(cfg, action, params)
	default:
		return nil, fmt.Errorf("workflow-connector dispatch not yet wired for %s", connectorID)
	}
}

// ExecuteScheduledRun creates and runs an agent on behalf of the scheduler.
// It mirrors the logic in CreateRun but without an HTTP request context.
func (h *RESTHandler) ExecuteScheduledRun(tenantID, agentName string, input map[string]any) {
	ctx := context.Background()
	ctx = middleware.InjectTenantID(ctx, tenantID)
	md := metadata.Pairs("tenant_id", tenantID)
	ctx = metadata.NewIncomingContext(ctx, md)

	if input == nil {
		input = map[string]any{}
	}

	inputStruct, _ := structpb.NewStruct(input)

	// Ensure agent exists.
	_, getErr := h.agentSvc.GetAgent(ctx, &lanternv1.GetAgentRequest{Name: agentName})
	if getErr != nil {
		h.logger().Info("scheduler: auto-creating agent", zap.String("agent", agentName))
		_, _ = h.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
			Name:        agentName,
			Description: "Auto-created by scheduler",
		})
	}

	run, err := h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
		AgentName:   agentName,
		Input:       inputStruct,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_SCHEDULE,
	})
	if err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "no promoted version") || strings.Contains(errStr, "not found") {
			h.autoCreateVersion(ctx, agentName)
			run, err = h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
				AgentName:   agentName,
				Input:       inputStruct,
				TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_SCHEDULE,
			})
		}
		if err != nil {
			h.logger().Error("scheduler: CreateRun failed", zap.String("agent", agentName), zap.Error(err))
			return
		}
	}

	// Execute inline (this already handles email delivery at the end).
	if h.llmProxy != nil {
		go h.executeRunInline(run.GetId(), run.GetTenantId(), agentName, input)
	}
}

// sendEmailViaGmail sends an email using the tenant's Gmail OAuth token via
// the Gmail API. This is the spike-mode email delivery — in production, use a
// dedicated notification service with proper retry and templating.
func (h *RESTHandler) sendEmailViaGmail(tenantID, to, subject, body string) error {
	ctx := context.Background()
	token := resolveGmailToken(ctx, h.srv.Pool, tenantID)
	if token == "" {
		return fmt.Errorf("no Gmail token for tenant %s", tenantID)
	}

	// If the token is a refresh token, try refreshing it.
	// The resolveGmailToken helper already returns the access token, but it
	// may be expired. We attempt the send and, on 401, try refreshing.
	if err := h.doGmailSend(token, to, subject, body); err != nil {
		if strings.Contains(err.Error(), "401") {
			// Try refreshing the token.
			newToken, refreshErr := h.tryRefreshGmailToken(ctx, tenantID)
			if refreshErr != nil {
				return fmt.Errorf("send failed and refresh failed: send=%v, refresh=%v", err, refreshErr)
			}
			return h.doGmailSend(newToken, to, subject, body)
		}
		return err
	}
	return nil
}

// doGmailSend performs the actual Gmail API send.
func (h *RESTHandler) doGmailSend(accessToken, to, subject, body string) error {
	// Build RFC 2822 message.
	msg := fmt.Sprintf("To: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s", to, subject, body)
	encoded := base64.URLEncoding.EncodeToString([]byte(msg))

	reqBody, _ := json.Marshal(map[string]string{"raw": encoded})
	req, err := http.NewRequest("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("gmail API call: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("gmail API %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// tryRefreshGmailToken attempts to refresh the Gmail OAuth token for the given
// tenant and updates it in the database.
func (h *RESTHandler) tryRefreshGmailToken(ctx context.Context, tenantID string) (string, error) {
	var oauthTokenJSON []byte
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT oauth_token_encrypted
		FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
	`, tenantID).Scan(&oauthTokenJSON)
	if err != nil {
		return "", fmt.Errorf("no Gmail connector: %w", err)
	}

	var tokenData map[string]any
	if err := json.Unmarshal(oauthTokenJSON, &tokenData); err != nil {
		return "", fmt.Errorf("parse token: %w", err)
	}

	refreshToken, _ := tokenData["refresh_token"].(string)
	if refreshToken == "" {
		return "", fmt.Errorf("no refresh token available")
	}

	newAccessToken, err := refreshGoogleToken(refreshToken)
	if err != nil {
		return "", err
	}

	// Update the stored token.
	tokenData["access_token"] = newAccessToken
	updatedJSON, _ := json.Marshal(tokenData)
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE connector_installs SET oauth_token_encrypted = $1::jsonb WHERE tenant_id = $2 AND connector_id = 'gmail'`,
		string(updatedJSON), tenantID,
	)

	return newAccessToken, nil
}

// ---------- Workflow persistence (visual editor) ----------

// SaveWorkflow handles PUT /v1/agents/{name}/workflow.
// Stores the visual workflow JSON in the agents table's workflow JSONB column.
func (h *RESTHandler) SaveWorkflow(w http.ResponseWriter, r *http.Request) {
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name is required"})
		return
	}

	tenantID, _ := middleware.TenantIDFromContext(ctx)

	// Read the raw workflow JSON from the request body.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB max
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read body"})
		return
	}

	// Validate it's valid JSON.
	if !json.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	tag, err := h.srv.Pool.Exec(ctx, `
		UPDATE agents SET workflow = $1::jsonb
		WHERE tenant_id = $2 AND name = $3 AND archived_at IS NULL
	`, string(body), tenantID, name)
	if err != nil {
		h.logger().Error("save workflow failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save workflow"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// GetWorkflow handles GET /v1/agents/{name}/workflow.
// Returns the stored visual workflow JSON for the agent.
func (h *RESTHandler) GetWorkflow(w http.ResponseWriter, r *http.Request) {
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name is required"})
		return
	}

	tenantID, _ := middleware.TenantIDFromContext(ctx)

	var workflow []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT workflow FROM agents
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, name).Scan(&workflow)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if err != nil {
		h.logger().Error("get workflow failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get workflow"})
		return
	}

	if workflow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no workflow saved"})
		return
	}

	// Return the raw JSON directly.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(workflow) //nolint:errcheck
}

// autoCreateVersion creates a default agent version and promotes it.
// This is a convenience for the spike — in production, versions come from
// `lantern deploy`.
func (h *RESTHandler) autoCreateVersion(ctx context.Context, agentName string) {
	tenantID, _ := middleware.TenantIDFromContext(ctx)
	if tenantID == "" {
		return
	}

	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, _ = tx.Exec(ctx, fmt.Sprintf("SET LOCAL app.tenant_id = '%s'", tenantID))

	// Get the agent ID.
	var agentID string
	err = tx.QueryRow(ctx,
		`SELECT id FROM agents WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL`,
		tenantID, agentName,
	).Scan(&agentID)
	if err != nil {
		h.logger().Error("autoCreateVersion: agent not found", zap.Error(err), zap.String("agent", agentName), zap.String("tenant", tenantID))
		return
	}

	// Check if a version already exists.
	var existingVersionID string
	err = tx.QueryRow(ctx,
		`SELECT id FROM agent_versions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
		agentID,
	).Scan(&existingVersionID)
	if err == nil {
		// Version exists — just promote it.
		_, _ = tx.Exec(ctx,
			`UPDATE agents SET current_version_id = $1 WHERE id = $2`,
			existingVersionID, agentID,
		)
		_ = tx.Commit(ctx)
		return
	}
	if err != pgx.ErrNoRows {
		return
	}

	// Create a default version.
	var versionID string
	err = tx.QueryRow(ctx,
		`INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		 VALUES ($1, 'v0.1.0', decode(md5($2), 'hex'), 'local://auto-created', '{"runtime":"node","entry":"src/index.ts"}'::jsonb)
		 RETURNING id`,
		agentID, agentName+"-v0.1.0",
	).Scan(&versionID)
	if err != nil {
		h.logger().Error("auto-create version insert failed", zap.Error(err), zap.String("agent", agentName))
		return
	}

	// Promote it.
	_, _ = tx.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`,
		versionID, agentID,
	)
	_ = tx.Commit(ctx)
	h.logger().Info("auto-created and promoted agent version",
		zap.String("agent", agentName),
		zap.String("version_id", versionID),
	)
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
	if r.GetTriggerMeta() != nil {
		m["triggerMeta"] = r.GetTriggerMeta().AsMap()
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
