package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
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
		if dec, decErr := secrets.Decrypt(oauthTokenJSON); decErr == nil {
			var tokenData map[string]any
			if jsonErr := json.Unmarshal(dec, &tokenData); jsonErr == nil {
				if at, ok := tokenData["access_token"].(string); ok && at != "" {
					return at
				}
			}
		}
	}

	// Fall back to config.accessToken. The config is an encrypted JSONB
	// envelope, so load + decrypt it in Go rather than via `config->>`.
	var configRaw []byte
	if err := pool.QueryRow(ctx, `
		SELECT config
		FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
	`, tenantID).Scan(&configRaw); err == nil {
		if dec, decErr := secrets.Decrypt(configRaw); decErr == nil {
			var cfg map[string]any
			if json.Unmarshal(dec, &cfg) == nil {
				if at, ok := cfg["accessToken"].(string); ok {
					return at
				}
			}
		}
	}

	return ""
}

// RESTHandler wraps the gRPC service handlers to expose them over HTTP/JSON.
type RESTHandler struct {
	srv          *server.Server
	auth         *AuthHandler
	agentSvc     *AgentService
	runSvc       *RunService
	llmProxy     *LlmProxyHandler
	dpRouter     *DataPlaneService // routes runs to a connected data plane (nil = inline-only)
	spawnLimiter *SpawnRateLimiter // per-tenant spawn-storm guard (nil = disabled)

	// inFlightRuns tracks goroutines started by executeRunInline so the
	// shutdown path can wait for them to finish (DrainInFlightRuns).
	inFlightRuns sync.WaitGroup
}

// SetSpawnLimiter wires the per-tenant spawn rate limiter (phase 3). nil-safe:
// when unset, CreateRun does not rate-limit.
func (h *RESTHandler) SetSpawnLimiter(l *SpawnRateLimiter) { h.spawnLimiter = l }

// SetDataPlaneRouter wires the data-plane run router. nil-safe: when unset (or
// when no plane is connected for the tenant), runs execute inline in the control
// plane. When set and a plane is connected, the run is dispatched to it instead.
func (h *RESTHandler) SetDataPlaneRouter(dp *DataPlaneService) { h.dpRouter = dp }

// DrainInFlightRuns waits for all in-flight inline-run goroutines to finish,
// up to timeout. Any goroutines still running after timeout are abandoned —
// the durable-replay recovery loop will re-drive them on next startup.
// Call this after the HTTP server stops accepting new connections.
func (h *RESTHandler) DrainInFlightRuns(timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		h.inFlightRuns.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
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
	// db.WithTenantConn sets app.tenant_id (transaction-local) before running
	// the UPDATE so that, under LANTERN_RLS_ENFORCE=1, the RLS policy evaluates
	// the GUC and allows the write.  WHERE tenant_id = $4 remains the primary
	// correctness guard; RLS is defence-in-depth.
	if body.AvatarURL != nil || body.StylePrompt != nil || body.SystemPrompt != nil {
		tenantID, _ := middleware.TenantIDFromContext(ctx)
		uerr := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				UPDATE agents SET
					avatar_url   = COALESCE($1, avatar_url),
					style_prompt = COALESCE($2, style_prompt),
					system_prompt = COALESCE($3, system_prompt)
				WHERE tenant_id = $4 AND name = $5
			`, body.AvatarURL, body.StylePrompt, body.SystemPrompt, tenantID, body.Name)
			return err
		})
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
	// db.WithTenantConn sets app.tenant_id before the SELECT so that, under
	// LANTERN_RLS_ENFORCE=1, the RLS policy allows the read (GUC matches the
	// tenant_id of the row). Without the GUC the policy matches nothing →
	// returns empty even for the row's own owner.
	tenantID, _ := middleware.TenantIDFromContext(ctx)
	var (
		avatarURL    *string
		stylePrompt  *string
		systemPrompt *string
	)
	_ = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT avatar_url, style_prompt, system_prompt
			FROM agents WHERE tenant_id = $1 AND name = $2
		`, tenantID, name).Scan(&avatarURL, &stylePrompt, &systemPrompt)
	})
	if avatarURL != nil {
		out["avatarUrl"] = *avatarURL
	}
	if stylePrompt != nil {
		out["stylePrompt"] = *stylePrompt
	}
	if systemPrompt != nil {
		out["systemPrompt"] = *systemPrompt
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

	// db.WithTenantConn sets app.tenant_id before the UPDATE so that, under
	// LANTERN_RLS_ENFORCE=1, the RLS policy allows the write. Without the GUC
	// set, the policy matches nothing → RowsAffected()==0 → false HTTP 404 for
	// the agent's own owner. WHERE tenant_id = $5 is the primary correctness
	// guard; RLS is defence-in-depth.
	var rowsAffected int64
	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx, `
			UPDATE agents SET
				system_prompt = COALESCE($1, system_prompt),
				avatar_url    = COALESCE($2, avatar_url),
				style_prompt  = COALESCE($3, style_prompt)
			WHERE name = $4 AND tenant_id = $5
		`, body.SystemPrompt, body.AvatarURL, body.StylePrompt, name, tenantID)
		rowsAffected = tag.RowsAffected()
		return execErr
	})
	if err != nil {
		h.logger().Error("UpdateAgent failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "update failed"})
		return
	}
	if rowsAffected == 0 {
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
	if sid := r.URL.Query().Get("sessionId"); sid != "" {
		req.SessionId = sid
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

	tenantID, _ := middleware.TenantIDFromContext(ctx)
	runs := make([]map[string]any, 0)
	if resp != nil {
		for _, run := range resp.GetRuns() {
			m := runToMap(run)
			// Enrich: execution steps + agent name.
			// db.WithTenantConn sets app.tenant_id so that, under
			// LANTERN_RLS_ENFORCE=1, the RLS policy allows the read.
			// Without the GUC the policy matches nothing → empty enrichment
			// even for the tenant's own runs.
			var rawSteps []byte
			var agentName string
			_ = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx,
					`SELECT r.trigger_meta, COALESCE(a.name, '') FROM runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = $1`,
					run.GetId(),
				).Scan(&rawSteps, &agentName)
			})
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

	// Per-tenant spawn-storm guard (phase 3): a burst of run creations from one
	// tenant is throttled to protect shared capacity. 429 carries no work side-effect.
	if h.spawnLimiter != nil {
		if tenant, ok := middleware.TenantIDFromContext(ctx); ok && !h.spawnLimiter.Allow(tenant) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited: too many runs, slow down"})
			return
		}
	}

	var body struct {
		AgentName string         `json:"agentName"`
		Input     map[string]any `json:"input"`
		// SessionId is optional; when provided the run is grouped under that session.
		SessionId string `json:"sessionId,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Budget pre-check: enforce hard-fail limits before dispatching the run
	// so a blocked agent never consumes compute or LLM tokens.  Estimated
	// per-run cost is 0 at dispatch time (actual cost is unknown until the
	// run completes); CheckBudget still catches exceeded daily-run-count and
	// daily-cost limits from prior runs.  Mirrors the pattern in voice.go
	// and marketplace_invoke.go.
	if tenantID, ok := middleware.TenantIDFromContext(ctx); ok {
		if bc := CheckBudget(ctx, h.srv.Pool, tenantID, body.AgentName, 0); !bc.Allowed && bc.HardFail {
			h.logger().Warn("run blocked by budget",
				zap.String("agent", body.AgentName),
				zap.String("reason", bc.Reason),
			)
			writeJSON(w, http.StatusPaymentRequired, map[string]any{
				"error":  "agent budget limit reached: " + bc.Reason,
				"reason": bc.Reason,
			})
			return
		}
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
		SessionId:   body.SessionId,
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

	// Placement: if a data plane is connected for this tenant, dispatch the run
	// there (customer-VPC execution); the plane reports status/completion back
	// over the RunStream. Otherwise fall back to inline execution in the control
	// plane (managed-cloud model). RouteRun is fast (a guarded UPDATE + channel
	// send) and safe to run on the request goroutine.
	routed := false
	if h.dpRouter != nil {
		inputJSON, _ := json.Marshal(body.Input) // map[string]any from decoded JSON — marshal cannot fail
		if planeID, ok := h.dpRouter.RouteRun(ctx, run.GetId(), run.GetTenantId(), run.GetAgentVersionId(), string(inputJSON)); ok {
			routed = true
			h.logger().Info("run dispatched to data plane",
				zap.String("run_id", run.GetId()),
				zap.String("tenant_id", run.GetTenantId()),
				zap.String("plane_id", planeID),
			)
		}
	}

	// Kick off inline execution in a background goroutine so the run
	// transitions from queued → running → succeeded without needing the
	// separate workflow-engine service.
	if !routed && h.llmProxy != nil {
		h.inFlightRuns.Add(1)
		go func() {
			defer h.inFlightRuns.Done()
			h.executeRunInline(run.GetId(), run.GetTenantId(), body.AgentName, body.Input)
		}()
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
	// Enrich: execution steps + agent name.
	// db.WithTenantConn sets app.tenant_id before the SELECT so that, under
	// LANTERN_RLS_ENFORCE=1, the RLS policy allows the read. Without the GUC,
	// the policy matches nothing → enrichment silently empty even for the
	// tenant's own run.
	tenantID, _ := middleware.TenantIDFromContext(ctx)
	var rawSteps []byte
	var agentName string
	_ = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT r.trigger_meta, COALESCE(a.name, '') FROM runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = $1`, id,
		).Scan(&rawSteps, &agentName)
	})
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

	tenantID, _ := middleware.TenantIDFromContext(ctx)
	// db.WithTenantConn sets app.tenant_id so that RLS allows the DELETE under
	// enforcement. WHERE tenant_id = $2 is the primary correctness guard
	// (multi-tenant invariant #7); RLS is defence-in-depth.
	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		_, execErr := tx.Exec(ctx, `DELETE FROM runs WHERE id = $1 AND tenant_id = $2`, id, tenantID)
		return execErr
	})
	if err != nil {
		h.logger().Error("DeleteRun failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------- CORS middleware ----------

// isPublicCORSPath reports whether the request path is an explicitly public
// endpoint that should carry Access-Control-Allow-Origin: * so that
// unauthenticated browser clients (e.g. the public /proof verifier page,
// external receipt auditors, and the well-known discovery documents) can
// reach it without credentials.
func isPublicCORSPath(path string) bool {
	return strings.HasPrefix(path, "/.well-known/") ||
		path == "/proof" ||
		path == "/v1/runs/receipts/verify"
}

// CORSMiddleware wraps an http.Handler to add CORS headers for browser access.
//
// Public endpoints (/.well-known/*, /proof, receipt verify) emit
// Access-Control-Allow-Origin: * so unauthenticated external clients can
// reach them.
//
// All other routes reflect the request Origin only when it appears in the
// allowlist built from LANTERN_CORS_ORIGINS (comma-separated; default
// http://localhost:3001). This prevents credential-bearing cross-origin
// requests from arbitrary origins in production.
func CORSMiddleware(next http.Handler) http.Handler {
	allowed := corsAllowedOrigins()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		if isPublicCORSPath(r.URL.Path) {
			// Public endpoints: allow any origin.
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else if origin != "" {
			if _, ok := allowed[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
			// Unknown origins get no ACAO header — browser will block the request.
		}

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
// isRunNowInput returns true when the run's input has no real user
// instruction — Run Now from the dashboard, cron-triggered runs, etc.
// "Real instruction" means at least one non-empty string field OR a
// 'prompt'/'message'/'text'/'query'/'input' key. The dashboard sends
// shaped metadata like {"connectors":[]} for Run Now invocations, which
// is NOT a user instruction; treat it as empty so the executor's
// synthesized default + prefetch logic kicks in.
func isRunNowInput(input map[string]any, raw string) bool {
	if len(input) == 0 || raw == "" || raw == "{}" || raw == "null" {
		return true
	}
	// Known user-instruction field names. If any is present with non-empty
	// content, this is a real user message.
	for _, key := range []string{"prompt", "message", "text", "query", "input", "instruction", "ask"} {
		if v, ok := input[key]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return false
			}
		}
	}
	// No known instruction field. Treat as Run Now unless there's some
	// other meaningful string content we haven't named.
	for k, v := range input {
		// Skip pure-metadata keys the dashboard adds.
		switch k {
		case "connectors", "surfaces", "tags", "labels", "model", "stream":
			continue
		}
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			return false
		}
	}
	return true
}

// subagentDepthKey is a context key that tracks the subagent call depth to
// prevent infinite recursion when a workflow invokes itself or forms a cycle.
type subagentDepthKey struct{}

const maxSubagentDepth = 5

// subagentDepth returns the current subagent nesting depth from ctx.
func subagentDepth(ctx context.Context) int {
	if v, ok := ctx.Value(subagentDepthKey{}).(int); ok {
		return v
	}
	return 0
}

// withSubagentDepth returns a context with the depth incremented by one.
func withSubagentDepth(ctx context.Context) context.Context {
	return context.WithValue(ctx, subagentDepthKey{}, subagentDepth(ctx)+1)
}

// executeRunInline processes a run asynchronously (called from a goroutine).
// It sets up its own background context, delegates to executeRunInlineSync,
// then handles email/WhatsApp delivery on success.
func (h *RESTHandler) executeRunInline(runID, tenantID, agentName string, input map[string]any) {
	ctx := context.Background()
	ctx = middleware.InjectTenantID(ctx, tenantID)
	md := metadata.Pairs("tenant_id", tenantID)
	ctx = metadata.NewIncomingContext(ctx, md)

	result, resolvedTemplateID, err := h.executeRunInlineSync(ctx, runID, tenantID, agentName, input)
	if err != nil {
		// Error already written to runs.error by executeRunInlineSync.
		return
	}

	// Delivery side-effects: only for top-level runs, not child subagent runs.
	// Check if email delivery is configured for this agent's schedule.
	var deliveryEmail string
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT config->>'deliveryEmail' FROM schedules WHERE tenant_id = $1 AND agent_name = $2 AND enabled = true`,
		tenantID, agentName,
	).Scan(&deliveryEmail)

	if deliveryEmail != "" {
		// Side-effect dedup: skip the email if a prior attempt already sent it.
		emailIdemKey := idempotencyKey(runID, "email_delivery", 1)
		go func() {
			claimed, claimErr := claimSideEffect(ctx, h.srv.Pool, emailIdemKey, runID, tenantID, "email_delivery")
			if claimErr != nil {
				h.logger().Warn("email delivery: side-effect claim error",
					zap.String("run_id", runID), zap.Error(claimErr))
				// Proceed on claim error rather than silently dropping the email.
			} else if !claimed {
				h.logger().Info("email delivery: already delivered (idempotent skip)",
					zap.String("run_id", runID))
				return
			}
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

	if shouldDeliverToWhatsApp(resolvedTemplateID) && result != "" {
		// Side-effect dedup: compute an idempotency key for this delivery so
		// a crash-replay doesn't double-send the WhatsApp message.
		idemKey := idempotencyKey(runID, "whatsapp_self", 1)
		go func() {
			claimed, claimErr := claimSideEffect(ctx, h.srv.Pool, idemKey, runID, tenantID, "whatsapp_self")
			if claimErr != nil {
				h.logger().Warn("whatsapp delivery: side-effect claim error",
					zap.String("run_id", runID), zap.Error(claimErr))
				// Proceed on claim error rather than silently dropping the message.
			} else if !claimed {
				h.logger().Info("whatsapp delivery: already delivered (idempotent skip)",
					zap.String("run_id", runID))
				return
			}
			if err := h.deliverWhatsAppSelf(tenantID, result); err != nil {
				h.logger().Warn("whatsapp delivery failed",
					zap.String("run_id", runID),
					zap.String("template", resolvedTemplateID),
					zap.Error(err),
				)
				return
			}
			h.logger().Info("whatsapp delivered",
				zap.String("run_id", runID),
				zap.String("template", resolvedTemplateID),
			)
		}()
	}
}

// executeRunInlineSync is the synchronous core of run execution. It updates the
// runs row directly (marking running/succeeded/failed) and returns (resultText,
// resolvedTemplateID, error). On failure, the runs row is already marked failed
// and a non-nil error is returned so the caller can short-circuit delivery.
// Child subagent runs call this directly with the parent's context so
// cancellation propagates and depth is tracked.
func (h *RESTHandler) executeRunInlineSync(ctx context.Context, runID, tenantID, agentName string, input map[string]any) (outResult string, outTemplate string, outErr error) {
	var resolvedTemplateID string
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

	// 1. Acquire a run lease to prevent concurrent double-execution.
	// Two replicas that both try to execute the same run will race on the
	// run_locks UPSERT; only one wins (rows_affected > 0) and proceeds.
	// The loser aborts silently — the winner will complete or fail the run,
	// and the recovery sweep will re-drive if the winner crashes.
	leaseAcquired, releaseLease, leaseErr := acquireRunLease(ctx, h.srv.Pool, runID, h.logger())
	if leaseErr != nil {
		h.logger().Error("inline executor: lease acquisition error — aborting to avoid double-execute",
			zap.String("run_id", runID), zap.Error(leaseErr))
		return "", "", fmt.Errorf("acquire run lease: %w", leaseErr)
	}
	if !leaseAcquired {
		h.logger().Info("inline executor: lease held by another worker — aborting",
			zap.String("run_id", runID))
		// Return success-shaped zero values; the run is already being executed.
		return "", "", nil
	}
	defer releaseLease()

	// 1c. Deferred safety net: if this function returns with an error and the
	// run is still in a non-terminal state (e.g. we panicked or hit an early
	// return before the per-path status update), force it to 'failed' so the
	// row is never abandoned in 'running'/'queued'. The lease-not-acquired path
	// (leaseAcquired==false) returns nil error, so it is correctly excluded.
	var safetyNetFired bool
	defer func() {
		if safetyNetFired {
			return
		}
		// Only fire on an ERROR return. A success return that legitimately left
		// the row non-terminal (e.g. the workflow path manages its own status, or
		// an async terminal write) must never be clobbered to 'failed'. The
		// lease-not-acquired path returned before this defer was registered, so it
		// is excluded structurally. This guards the one case that matters: an error
		// return that forgot (or failed) to mark the run terminal — never abandon a
		// run in 'running'/'queued'.
		if outErr == nil {
			return
		}
		// We query the current status and only write if still non-terminal.
		var currentStatus string
		_ = h.srv.Pool.QueryRow(
			context.Background(), // detached — ctx may already be cancelled
			`SELECT status FROM runs WHERE id = $1`,
			runID,
		).Scan(&currentStatus)
		if currentStatus == "running" || currentStatus == "queued" {
			safetyErrJSON, _ := json.Marshal(map[string]string{
				"code":    "executor_abort",
				"message": "run executor exited without completing the run",
			})
			if _, dbErr := h.srv.Pool.Exec(
				context.Background(),
				`UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
				runID, string(safetyErrJSON),
			); dbErr != nil {
				h.logger().Error("inline executor safety net: failed to mark run failed",
					zap.String("run_id", runID), zap.Error(dbErr))
			}
		}
	}()

	// 1b. Mark as running.
	logStep("initialize", "running", "Starting agent execution")
	_, err := h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
		runID,
	)
	if err != nil {
		h.logger().Error("inline executor: failed to mark running", zap.Error(err))
		return "", "", fmt.Errorf("mark running: %w", err)
	}

	// 1a. If the agent has a saved workflow graph, hand off to the workflow
	// interpreter (W11b). Otherwise fall through to the simple single-LLM-
	// call path below. Workflow execution emits journal_events per node so
	// the RunWaterfall renders the full graph.
	if h.runWorkflowIfPresent(ctx, runID, tenantID, agentName, input) {
		// Workflow path: read the output back from the DB so the caller
		// can return it. On workflow failure the DB already has an error row;
		// read whatever was written for delivery side-effects.
		var outputJSON []byte
		_ = h.srv.Pool.QueryRow(ctx,
			`SELECT COALESCE(output, '{}'::jsonb)::text::bytea FROM runs WHERE id = $1`, runID,
		).Scan(&outputJSON)
		var outMap map[string]any
		if len(outputJSON) > 0 {
			_ = json.Unmarshal(outputJSON, &outMap)
		}
		wfResult := ""
		if r, ok := outMap["result"].(string); ok {
			wfResult = r
		}
		return wfResult, resolvedTemplateID, nil
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
	resolvedTemplateID = ""
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
	// User-side content. When called via Run Now with no real user
	// instruction, synthesize a sensible default ask matching the
	// template's intent rather than handing the model an empty/metadata
	// blob which it interprets as "input is empty".
	//
	// "No real instruction" includes more than just `{}`/`null` — the
	// dashboard sometimes sends `{"connectors":[]}` (the agent's config
	// shape, not a user message). Treat any input with no user-facing
	// text fields as Run Now too.
	userContent := string(inputJSON)
	if isRunNowInput(input, userContent) {
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

	// (Dead pre-prefetch-era Gmail-injection branch removed. All
	//  template-driven data fetching now goes through prefetchForTemplate
	//  in template_prefetch.go — see Source B in prefetchMorningBrief /
	//  prefetchInboxConcierge. Custom agents that need Gmail data go
	//  through the tool-use loop, where the model calls gmail__search /
	//  gmail__list_messages explicitly. No more ad-hoc input-flag
	//  inspection inside executeRunInline.)

	// 3. Call the LLM — with idempotent replay gate.
	//
	// BEFORE making the LLM call, check whether journal_events already has a
	// step_completed for llmStepID (i.e. a prior attempt finished the call
	// and then crashed before writing runs.status).  If so, reconstruct the
	// result from the cached payload and skip the call entirely.  This is
	// the "no re-spent tokens" guarantee on crash-replay.
	if cached, hit, _ := checkCachedLLMStep(ctx, h.srv.Pool, runID); hit {
		h.logger().Info("inline executor: replaying from cached LLM step — skipping LLM call",
			zap.String("run_id", runID))
		logStep("call_llm", "completed", fmt.Sprintf("replay from cache (%s/%s, %d tokens)",
			cached.Provider, cached.Model, cached.TokensOut))
		logStep("save_output", "running", "Saving results (replay)")
		outputJSON, _ := json.Marshal(map[string]string{"result": cached.Result})
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET status = 'succeeded', finished_at = now(), output = $2::jsonb, tokens_in = $3, tokens_out = $4, cost_usd = $5 WHERE id = $1`,
			runID, string(outputJSON), cached.TokensIn, cached.TokensOut, cached.CostUSD,
		)
		logStep("complete", "completed", fmt.Sprintf("Run finished (replay): %d tokens, $%.4f",
			cached.TokensIn+cached.TokensOut, cached.CostUSD))
		return cached.Result, resolvedTemplateID, nil
	}

	// Emit step_started so the run waterfall shows the LLM step in flight.
	emitLLMJournalEvent(ctx, h.srv.Pool, runID, "step_started", map[string]any{
		"name": llmStepID,
		"type": "llm",
	})

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
				model = sonnetModel()
			}
		} else {
			h.logger().Warn("inline executor: no LLM key, marking failed", zap.Error(err))
			emitLLMJournalEvent(ctx, h.srv.Pool, runID, "step_failed", map[string]any{
				"name":  llmStepID,
				"error": err.Error(),
			})
			noLLMJSON, _ := json.Marshal(map[string]string{"code": "no_llm", "message": err.Error()})
			if _, updateErr := h.srv.Pool.Exec(ctx,
				`UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
				runID, string(noLLMJSON),
			); updateErr != nil {
				h.logger().Error("inline executor: failed to mark run failed (no LLM key)",
					zap.String("run_id", runID), zap.Error(updateErr))
			}
			safetyNetFired = true // explicit UPDATE done; deferred net should not double-write
			return "", resolvedTemplateID, fmt.Errorf("no LLM key: %w", err)
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
		case "claude-haiku-4-20250414", "claude-haiku-4-5-20251001":
			model = sonnetModel()
			logStep("upgrade_model", "completed", "Upgraded haiku → sonnet for tool-use reliability")
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
	// userFacing=false: run outputs go to runs.output JSON, not directly
	// to a bridge contact. The existing tools-filter in callLLMWithFailover
	// already excludes claude-code when tools are present.
	result, _, usedProvider, usedModel, tokensIn, tokensOut, llmErr := h.llmProxy.callLLMWithFailover(
		ctx, tenantID,
		llmMessages, llmTools, llmDispatch, onToolCallStep, onAttempt, 5, false,
	)
	if llmErr == nil {
		provider = usedProvider
		model = usedModel
	}
	costUsd := estimateCost(provider, model, int(tokensIn), int(tokensOut))

	if llmErr != nil {
		h.logger().Error("inline executor: LLM call failed", zap.Error(llmErr))
		// Persist step_failed so replay knows this attempt did not produce output.
		emitLLMJournalEvent(ctx, h.srv.Pool, runID, "step_failed", map[string]any{
			"name":  llmStepID,
			"error": llmErr.Error(),
		})
		errJSON, _ := json.Marshal(map[string]string{"code": "llm_error", "message": llmErr.Error()})
		_, _ = h.srv.Pool.Exec(ctx,
			`UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
			runID, string(errJSON),
		)
		return "", resolvedTemplateID, fmt.Errorf("LLM call failed: %w", llmErr)
	}

	// Persist step_completed with the full output payload.  This is the
	// journal record that a crash-replay will find and reuse to skip the LLM
	// call on the next attempt (idempotency invariant #3 / #8).
	emitLLMJournalEvent(ctx, h.srv.Pool, runID, "step_completed", llmStepPayload{
		Result:    result,
		TokensIn:  tokensIn,
		TokensOut: tokensOut,
		CostUSD:   costUsd,
		Provider:  provider,
		Model:     model,
	})

	// Anomaly detection: check cost/token spend against the agent's budget
	// limits (or sane defaults when no budget is configured). Emit an
	// anomaly_detected journal event for each breach so the run waterfall
	// surfaces it. This is informational — the run continues; budget hard-fail
	// blocking happens earlier at the CheckBudget call site.
	h.emitRunAnomalies(ctx, runID, tenantID, agentName, tokensIn+tokensOut, costUsd)

	// 4. Mark as succeeded with output.
	logStep("call_llm", "completed", fmt.Sprintf("Response from %s/%s: %d tokens", provider, model, tokensOut))
	logStep("save_output", "running", "Saving results")
	outputJSON, _ := json.Marshal(map[string]string{"result": result})
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE runs SET status = 'succeeded', finished_at = now(), output = $2::jsonb, tokens_in = $3, tokens_out = $4, cost_usd = $5 WHERE id = $1`,
		runID, string(outputJSON), tokensIn, tokensOut, costUsd,
	)

	logStep("complete", "completed", fmt.Sprintf("Run finished: %d tokens, $%.4f", tokensIn+tokensOut, costUsd))

	// Record actual usage in the daily rollup so CheckBudget gates future
	// runs correctly.  Called once here — only the single-LLM-call path
	// reaches this point; the workflow path returns earlier via
	// runWorkflowIfPresent and the crash-replay path returns from the
	// checkCachedLLMStep branch, both without recording (workflow nodes
	// may record individually; the replay cost was already recorded on
	// the original run).  So there is exactly one RecordUsage per
	// successful inline run.
	if recErr := RecordUsage(ctx, h.srv.Pool, tenantID, agentName, tokensIn, tokensOut, costUsd, map[string]int{}); recErr != nil {
		h.logger().Warn("inline executor: RecordUsage failed",
			zap.String("run_id", runID), zap.Error(recErr))
	}

	h.logger().Info("inline executor: run completed",
		zap.String("run_id", runID),
		zap.Int64("tokens_in", tokensIn),
		zap.Int64("tokens_out", tokensOut),
	)

	return result, resolvedTemplateID, nil
}

// shouldDeliverToWhatsApp returns true if the named template declares
// "whatsapp" as a delivery surface in its templateDef. Unknown templates
// (including user-built agents with no template_id) are NOT auto-
// delivered — that would surprise users who didn't opt in.
func shouldDeliverToWhatsApp(templateID string) bool {
	if templateID == "" {
		return false
	}
	tpl, ok := templates[templateID]
	if !ok {
		return false
	}
	for _, s := range tpl.Surfaces {
		if strings.EqualFold(s, "whatsapp") {
			return true
		}
	}
	return false
}

// deliverViaBridge POSTs to whichever bridge (WhatsApp or iMessage)
// queued the draft so the approved/edited text goes out on the right
// channel. Channel string is "whatsapp" | "imessage"; falls back to
// WhatsApp for back-compat with drafts that pre-date the channel column.
func deliverViaBridge(channel, tenantID, jid, message string) error {
	var base string
	switch channel {
	case "imessage":
		base = os.Getenv("LANTERN_IMESSAGE_BRIDGE_URL")
		if base == "" {
			base = "http://localhost:3200"
		}
	default:
		base = os.Getenv("LANTERN_BRIDGE_URL")
		if base == "" {
			base = "http://localhost:3100"
		}
	}
	base = strings.TrimRight(base, "/")

	// iMessage uses 'to' as a handle (phone/email); WhatsApp uses JID.
	// Both bridges accept the same {to, message} shape on /send.
	payload, _ := json.Marshal(map[string]string{"to": jid, "message": message})
	req, err := http.NewRequest("POST",
		fmt.Sprintf("%s/session/%s/send", base, tenantID),
		bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	tokenEnv := "LANTERN_BRIDGE_TOKEN"
	if channel == "imessage" {
		tokenEnv = "LANTERN_IMESSAGE_BRIDGE_TOKEN"
	}
	if tok := os.Getenv(tokenEnv); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bridge unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("bridge returned %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

// deliverWhatsAppViaBridge — back-compat wrapper. Existing call sites
// (if any remain) hit this; new code uses deliverViaBridge(channel, ...).
func deliverWhatsAppViaBridge(tenantID, jid, message string) error {
	base := os.Getenv("LANTERN_BRIDGE_URL")
	if base == "" {
		base = "http://localhost:3100"
	}
	base = strings.TrimRight(base, "/")
	payload, _ := json.Marshal(map[string]string{"to": jid, "message": message})
	req, err := http.NewRequest(
		"POST",
		fmt.Sprintf("%s/session/%s/send", base, tenantID),
		bytes.NewReader(payload),
	)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := os.Getenv("LANTERN_BRIDGE_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bridge unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("bridge returned %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

// deliverWhatsAppSelf POSTs the message to the bridge's send-self
// endpoint, which routes to the bridge owner's own WhatsApp self-chat.
// Bridge URL + optional shared token come from env (LANTERN_BRIDGE_URL,
// LANTERN_BRIDGE_TOKEN). Defaults to localhost:3100 for dev.
func (h *RESTHandler) deliverWhatsAppSelf(tenantID, message string) error {
	base := os.Getenv("LANTERN_BRIDGE_URL")
	if base == "" {
		base = "http://localhost:3100"
	}
	base = strings.TrimRight(base, "/")

	payload, _ := json.Marshal(map[string]string{"message": message})
	req, err := http.NewRequest(
		"POST",
		fmt.Sprintf("%s/session/%s/send-self", base, tenantID),
		bytes.NewReader(payload),
	)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := os.Getenv("LANTERN_BRIDGE_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bridge unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("bridge returned %d: %s", resp.StatusCode, string(body))
	}
	return nil
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
		RunSubAgent: func(subCtx context.Context, agentName string, input map[string]any) (map[string]any, error) {
			// Depth guard: prevent infinite recursion when a workflow invokes
			// itself or forms a cycle. The limit is enforced via context value
			// so it survives across the synchronous call stack.
			depth := subagentDepth(subCtx)
			if depth >= maxSubagentDepth {
				return nil, fmt.Errorf("subagent depth limit (%d) exceeded — possible workflow cycle", maxSubagentDepth)
			}
			childCtx := withSubagentDepth(subCtx)

			// Insert a child run row for the named agent under the same tenant.
			// We use a direct INSERT rather than the HTTP CreateRun path to avoid
			// HTTP plumbing and preserve the parent's context/cancellation.
			childRunID, err := h.createSubAgentRunRow(childCtx, tenantID, agentName, runID, input)
			if err != nil {
				return nil, fmt.Errorf("create subagent run row for %q: %w", agentName, err)
			}

			// Execute synchronously — caller blocks until the child is done.
			if _, _, execErr := h.executeRunInlineSync(childCtx, childRunID, tenantID, agentName, input); execErr != nil {
				return nil, fmt.Errorf("subagent %q (run %s) failed: %w", agentName, childRunID, execErr)
			}

			// Read back the child run's output from the DB.
			var outputJSON []byte
			_ = h.srv.Pool.QueryRow(childCtx,
				`SELECT COALESCE(output, '{}'::jsonb)::text::bytea FROM runs WHERE id = $1`, childRunID,
			).Scan(&outputJSON)
			var out map[string]any
			if len(outputJSON) > 0 {
				_ = json.Unmarshal(outputJSON, &out)
			}
			if out == nil {
				out = map[string]any{}
			}
			return out, nil
		},
		CompletedStep: func(stepCtx context.Context, stepRunID, stepID string) (map[string]any, bool, error) {
			// Query journal_events for the most recent step_completed event for
			// this (run_id, step_id) pair. If found, unmarshal the payload and
			// return done=true so the interpreter reuses the cached output
			// instead of re-invoking the side-effecting dep.
			var payloadJSON []byte
			err := h.srv.Pool.QueryRow(stepCtx, `
				SELECT payload
				FROM journal_events
				WHERE run_id = $1 AND step_id = $2 AND kind = 'step_completed'
				ORDER BY seq DESC
				LIMIT 1
			`, stepRunID, stepID).Scan(&payloadJSON)
			if err != nil {
				// No completed record or DB error — fall through to re-execute.
				return nil, false, nil
			}
			var payload map[string]any
			if err := json.Unmarshal(payloadJSON, &payload); err != nil {
				return nil, false, nil
			}
			// The step_completed payload carries {"output": ..., "name": ..., "type": ...}.
			// Extract the output field; if absent return the whole payload.
			if out, ok := payload["output"]; ok {
				switch v := out.(type) {
				case map[string]any:
					return v, true, nil
				case string:
					return map[string]any{"result": v}, true, nil
				}
			}
			return payload, true, nil
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
	// Credentials are encrypted at rest; decrypt before parsing.
	if configRaw, err = secrets.Decrypt(configRaw); err != nil {
		return nil, fmt.Errorf("decrypt connector config: %w", err)
	}
	if oauthRaw, err = secrets.Decrypt(oauthRaw); err != nil {
		return nil, fmt.Errorf("decrypt connector oauth: %w", err)
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

// createSubAgentRunRow inserts a child run row for a subagent invocation.
// It looks up the agent's id + current_version_id and inserts a runs row with
// trigger_kind='subagent' and parent_run_id set to the calling run.
// Returns the new child run ID on success.
func (h *RESTHandler) createSubAgentRunRow(ctx context.Context, tenantID, agentName, parentRunID string, input map[string]any) (string, error) {
	var agentID, versionID string
	if err := h.srv.Pool.QueryRow(ctx, `
		SELECT id::text, COALESCE(current_version_id::text, '')
		FROM agents
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, agentName).Scan(&agentID, &versionID); err != nil {
		return "", fmt.Errorf("resolve agent %q: %w", agentName, err)
	}
	if versionID == "" {
		return "", fmt.Errorf("agent %q has no promoted version", agentName)
	}
	inputJSON, err := json.Marshal(input)
	if err != nil {
		return "", fmt.Errorf("marshal input: %w", err)
	}
	var childRunID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, parent_run_id, session_id)
		VALUES (
			$1, $2, $3, 'queued', 'subagent', $4::jsonb, $5,
			COALESCE(
				(SELECT session_id FROM runs WHERE id = $5::uuid),
				$5::uuid
			)
		)
		RETURNING id
	`, tenantID, agentID, versionID, string(inputJSON), parentRunID).Scan(&childRunID); err != nil {
		return "", fmt.Errorf("insert child run: %w", err)
	}
	return childRunID, nil
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

	// Budget pre-check: honour hard-fail limits for scheduled runs so an
	// over-budget agent does not fire every cron tick unattended.
	budgetResult := CheckBudget(ctx, h.srv.Pool, tenantID, agentName, 0)
	if !budgetResult.Allowed && budgetResult.HardFail {
		h.logger().Warn("scheduler: run blocked by budget",
			zap.String("tenant_id", tenantID),
			zap.String("agent", agentName),
			zap.String("reason", budgetResult.Reason),
		)
		return
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
		h.inFlightRuns.Add(1)
		go func() {
			defer h.inFlightRuns.Done()
			h.executeRunInline(run.GetId(), run.GetTenantId(), agentName, input)
		}()
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

	decToken, err := secrets.Decrypt(oauthTokenJSON)
	if err != nil {
		return "", fmt.Errorf("decrypt token: %w", err)
	}
	var tokenData map[string]any
	if err := json.Unmarshal(decToken, &tokenData); err != nil {
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

	// Re-encrypt and update the stored token.
	tokenData["access_token"] = newAccessToken
	updatedJSON, _ := json.Marshal(tokenData)
	encUpdated, err := secrets.EncryptString(string(updatedJSON))
	if err != nil {
		return "", fmt.Errorf("encrypt token: %w", err)
	}
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE connector_installs SET oauth_token_encrypted = $1::jsonb WHERE tenant_id = $2 AND connector_id = 'gmail'`,
		encUpdated, tenantID,
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

	// db.WithTenantConn sets app.tenant_id so that, under LANTERN_RLS_ENFORCE=1,
	// the RLS policy allows the UPDATE. Without the GUC the policy matches
	// nothing → RowsAffected()==0 → false HTTP 404 for the agent's own owner.
	var rowsAffected int64
	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx, `
			UPDATE agents SET workflow = $1::jsonb
			WHERE tenant_id = $2 AND name = $3 AND archived_at IS NULL
		`, string(body), tenantID, name)
		rowsAffected = tag.RowsAffected()
		return execErr
	})
	if err != nil {
		h.logger().Error("save workflow failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save workflow"})
		return
	}
	if rowsAffected == 0 {
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

	// db.WithTenantConn sets app.tenant_id so that, under LANTERN_RLS_ENFORCE=1,
	// the RLS policy allows the SELECT. Without the GUC the policy matches
	// nothing → pgx.ErrNoRows → false HTTP 404 for the agent's own owner.
	var wfBytes []byte
	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT workflow FROM agents
			WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
		`, tenantID, name).Scan(&wfBytes)
	})
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if err != nil {
		h.logger().Error("get workflow failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get workflow"})
		return
	}
	if wfBytes == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no workflow saved"})
		return
	}

	// Return the raw JSON directly.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(wfBytes) //nolint:errcheck
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

	_, _ = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID)

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

// emitRunAnomalies checks the final token/cost totals for this run against
// the agent's configured budget limits (or safe defaults when no budget
// exists) and writes an anomaly_detected journal event for each breach.
// Side-effect-light: one SELECT for the budget, one INSERT per anomaly.
// Never fatal — detection failures are logged and swallowed.
func (h *RESTHandler) emitRunAnomalies(ctx context.Context, runID, tenantID, agentName string, totalTokens int64, totalCostUSD float64) {
	// Build limits from agent_budgets if present; otherwise use defaults.
	limits := workflow.DefaultAnomalyLimits()
	var maxCostRaw *float64
	var maxTokensRaw *int64
	if err := h.srv.Pool.QueryRow(ctx, `
		SELECT max_cost_usd_per_run, max_tokens_per_day
		FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2
	`, tenantID, agentName).Scan(&maxCostRaw, &maxTokensRaw); err == nil {
		if maxCostRaw != nil && *maxCostRaw > 0 {
			limits.MaxCostUSD = *maxCostRaw
		}
		if maxTokensRaw != nil && *maxTokensRaw > 0 {
			limits.MaxTokens = *maxTokensRaw
		}
	}

	stats := workflow.RunStats{
		Tokens:  totalTokens,
		CostUSD: totalCostUSD,
	}

	anomalies := workflow.DetectAnomalies(stats, limits)
	if len(anomalies) == 0 {
		return
	}

	// Fetch the current max seq for this run so we can append.
	var maxSeq int64
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(seq), 0) FROM journal_events WHERE run_id = $1`, runID,
	).Scan(&maxSeq)

	for i, a := range anomalies {
		payload, _ := json.Marshal(map[string]any{
			"kind":     string(a.Kind),
			"observed": a.Observed,
			"limit":    a.Limit,
			"message":  a.Message,
		})
		seq := maxSeq + int64(i) + 1
		_, err := h.srv.Pool.Exec(ctx, `
			INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
			VALUES ($1, $2, 'anomaly_detected', '', 1, $3)
			ON CONFLICT (run_id, seq) DO NOTHING`,
			runID, seq, payload,
		)
		if err != nil {
			h.logger().Warn("emitRunAnomalies: journal insert failed",
				zap.String("run_id", runID),
				zap.String("kind", string(a.Kind)),
				zap.Error(err),
			)
			continue
		}
		h.logger().Warn("run anomaly detected",
			zap.String("run_id", runID),
			zap.String("agent", agentName),
			zap.String("kind", string(a.Kind)),
			zap.Float64("observed", a.Observed),
			zap.Float64("limit", a.Limit),
			zap.String("message", a.Message),
		)
	}
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
	if r.GetSessionId() != "" {
		m["sessionId"] = r.GetSessionId()
	}
	if r.GetError() != nil {
		m["error"] = map[string]string{
			"code":    r.GetError().GetCode(),
			"message": r.GetError().GetMessage(),
		}
	}
	return m
}
