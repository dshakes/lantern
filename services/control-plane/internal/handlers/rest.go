package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
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

	// 1. Mark as running.
	_, err := h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
		runID,
	)
	if err != nil {
		h.logger().Error("inline executor: failed to mark running", zap.Error(err))
		return
	}

	// 2. Build a prompt from the input.
	inputJSON, _ := json.Marshal(input)
	prompt := fmt.Sprintf("You are the agent '%s'. Process this input and produce a result:\n\n%s", agentName, string(inputJSON))

	// 2b. Check if Gmail connector is installed for this tenant. If so, fetch
	// emails and append them to the prompt so the LLM can reference them.
	gmailToken := resolveGmailToken(ctx, h.srv.Pool, tenantID)
	if gmailToken != "" {
		emails, fetchErr := FetchGmailViaAPI(gmailToken, 20)
		if fetchErr == nil && len(emails) > 0 {
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

	// 3. Call the LLM.
	provider, model := resolveModel("auto")
	apiKey, err := h.llmProxy.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		h.logger().Warn("inline executor: no LLM key, marking failed", zap.Error(err))
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
			runID, fmt.Sprintf(`{"code":"no_llm","message":"%s"}`, err.Error()),
		)
		return
	}

	result, tokensIn, tokensOut, costUsd, llmErr := h.llmProxy.callLLMSync(ctx, provider, model, apiKey, prompt)

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
	outputJSON, _ := json.Marshal(map[string]string{"result": result})
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'succeeded', finished_at = now(), output = $2::jsonb, tokens_in = $3, tokens_out = $4, cost_usd = $5 WHERE id = $1`,
		runID, string(outputJSON), tokensIn, tokensOut, costUsd,
	)

	h.logger().Info("inline executor: run completed",
		zap.String("run_id", runID),
		zap.Int64("tokens_in", tokensIn),
		zap.Int64("tokens_out", tokensOut),
	)
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
