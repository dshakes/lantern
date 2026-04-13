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

	result := runToMap(run)
	// Enrich with execution steps from trigger_meta (stored as JSON array by logStep)
	var rawSteps []byte
	_ = h.srv.Pool.QueryRow(ctx, `SELECT trigger_meta FROM runs WHERE id = $1`, id).Scan(&rawSteps)
	if len(rawSteps) > 0 && rawSteps[0] == '[' {
		var steps []any
		if json.Unmarshal(rawSteps, &steps) == nil {
			result["triggerMeta"] = steps
		}
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

	// 2. Build a prompt from the input.
	logStep("build_prompt", "running", "Building prompt from agent configuration")
	inputJSON, _ := json.Marshal(input)
	prompt := fmt.Sprintf("You are the agent '%s'. Process this input and produce a result:\n\n%s", agentName, string(inputJSON))

	// 2b. Check if Gmail connector is installed for this tenant. If so, fetch
	// emails and append them to the prompt so the LLM can reference them.
	logStep("fetch_data", "running", "Checking for connected data sources")
	gmailToken := resolveGmailToken(ctx, h.srv.Pool, tenantID)
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

	// 3. Call the LLM.
	logStep("call_llm", "running", "Sending to AI model for processing")
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
	logStep("call_llm", "completed", fmt.Sprintf("AI response received: %d tokens", tokensOut))
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
