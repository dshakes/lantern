// cross_app.go — cross-app workflow: read from one app, propose action on another.
//
// SAFETY INVARIANT: reads are autonomous; side-effecting writes ALWAYS require
// an explicit owner confirm. There is NO autonomous side-effect path.
//
//	POST /v1/cross-app/propose               — gather context (read-only) + LLM
//	                                           compose → stored proposal (no write)
//	POST /v1/commitments/{id}/execute-action — SOLE side-effect path; fires ONLY
//	                                           when the owner calls this endpoint
//
// Feature-gated behind LANTERN_CROSS_APP=on (default OFF).
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// crossAppEnabled reports whether cross-app workflows are enabled.
// Default OFF — set LANTERN_CROSS_APP=on to enable.
func crossAppEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_CROSS_APP")))
	return v == "on" || v == "1" || v == "true"
}

// crossAppConnectorFn is the injectable connector seam used by CrossAppHandler.
// Production default: executeConnectorAction via srv.WithTenant.
// Tests: inject a stub to avoid needing real connector credentials.
type crossAppConnectorFn func(ctx context.Context, tenantID, connectorID, action string, params map[string]any) (any, error)

// crossAppProposed is the proposed side-effecting action stored in the
// commitment's action_plan.proposedAction.
type crossAppProposed struct {
	Connector string         `json:"connector"`
	Action    string         `json:"action"`
	Params    map[string]any `json:"params"`
}

// crossAppPlan is stored as commitments.action_plan for kind='cross_app'
// commitments. ExecutionResult is populated only after execute-action confirms.
type crossAppPlan struct {
	Goal            string           `json:"goal"`
	ReadConnector   string           `json:"readConnector"`
	ReadAction      string           `json:"readAction"`
	ReadContext     any              `json:"readContext"`
	ProposedAction  crossAppProposed `json:"proposedAction"`
	ExecutionResult any              `json:"executionResult,omitempty"`
}

// CrossAppHandler handles the cross-app workflow endpoints.
type CrossAppHandler struct {
	srv         *server.Server
	auth        *AuthHandler
	completeFn  researchCompleteFn  // injectable LLM seam (reuses type from commitment_research.go)
	connectorFn crossAppConnectorFn // injectable connector seam; nil = real path
}

// NewCrossAppHandler creates a CrossAppHandler. Call SetLlmProxy before use.
func NewCrossAppHandler(srv *server.Server, auth *AuthHandler) *CrossAppHandler {
	return &CrossAppHandler{srv: srv, auth: auth}
}

// SetLlmProxy wires the LLM proxy (called from main after construction).
func (h *CrossAppHandler) SetLlmProxy(p *LlmProxyHandler) {
	h.completeFn = func(ctx context.Context, tenantID, system, user string) (string, error) {
		return p.CompleteInternal(ctx, tenantID, system, user, 0)
	}
}

func (h *CrossAppHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("cross-app")
}

// connectorCall dispatches a connector action. Uses h.connectorFn when set
// (test stub path); otherwise executes via executeConnectorAction under
// srv.WithTenant (real path). Follows the same transaction-wrapping pattern
// as ConnectorExecutor.Execute.
func (h *CrossAppHandler) connectorCall(
	ctx context.Context,
	tenantID, connectorID, action string,
	params map[string]any,
) (any, error) {
	if h.connectorFn != nil {
		return h.connectorFn(ctx, tenantID, connectorID, action, params)
	}
	var result any
	var execErr error
	txErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		result, execErr = executeConnectorAction(ctx, tx, tenantID, connectorID, action, params)
		return execErr
	})
	if txErr != nil && execErr == nil {
		return nil, fmt.Errorf("connector call: %w", txErr)
	}
	return result, execErr
}

// Propose handles POST /v1/cross-app/propose.
//
// Reads from one connector autonomously (must be a non-side-effecting action),
// calls the LLM to compose a proposed action on another connector, and stores
// it as a kind='cross_app' commitment with status='suggested'. The proposed
// action is NEVER executed here — it requires an explicit owner confirm via
// POST /v1/commitments/{id}/execute-action.
//
// Body: {goal, readConnector, readAction, readParams?}
// Returns: {commitmentId, proposedAction}
func (h *CrossAppHandler) Propose(w http.ResponseWriter, r *http.Request) {
	if !crossAppEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "cross-app workflows disabled (set LANTERN_CROSS_APP=on)"})
		return
	}

	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	var body struct {
		Goal          string         `json:"goal"`
		ReadConnector string         `json:"readConnector"`
		ReadAction    string         `json:"readAction"`
		ReadParams    map[string]any `json:"readParams"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Goal == "" || body.ReadConnector == "" || body.ReadAction == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "goal, readConnector, readAction are required"})
		return
	}

	// Fail-safe: reject if the caller attempts to use a side-effecting action
	// as the read step. Unknown actions default to true (fail-safe).
	if isSideEffectingAction(body.ReadConnector, body.ReadAction) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf(
				"action %q on connector %q is side-effecting and cannot be used as the read step",
				body.ReadAction, body.ReadConnector,
			),
		})
		return
	}

	if h.completeFn == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LLM not configured"})
		return
	}

	commitmentID, proposedAction, err := h.proposeCrossAppAction(
		ctx, tenantID,
		body.Goal, body.ReadConnector, body.ReadAction, body.ReadParams,
	)
	if err != nil {
		h.logger().Warn("propose failed",
			zap.String("tenant", tenantID),
			zap.String("goal", body.Goal),
			zap.Error(err),
		)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"commitmentId":   commitmentID,
		"proposedAction": proposedAction,
	})
}

// proposeCrossAppAction is the core propose logic, extracted for testability.
//
// Preconditions (caller must verify):
//   - readAction is non-side-effecting (isSideEffectingAction returned false)
//   - h.completeFn is non-nil
//
// It runs the read, calls the LLM, and stores a commitment. It NEVER executes
// the proposed action.
func (h *CrossAppHandler) proposeCrossAppAction(
	ctx context.Context,
	tenantID, goal, readConnector, readAction string,
	readParams map[string]any,
) (commitmentID string, proposed crossAppProposed, err error) {
	if readParams == nil {
		readParams = map[string]any{}
	}

	// 1. Run the read. Only reached because isSideEffectingAction = false.
	readResult, err := h.connectorCall(ctx, tenantID, readConnector, readAction, readParams)
	if err != nil {
		return "", crossAppProposed{}, fmt.Errorf("read %s/%s: %w", readConnector, readAction, err)
	}

	// Serialise read context for the LLM prompt; bound to protect context window.
	readJSON, _ := json.Marshal(readResult)
	if len(readJSON) > 8000 {
		// ponytail: simple truncation; upgrade to summary pass if context overflow matters
		readJSON = readJSON[:8000]
	}

	// 2. Call LLM to compose a proposed action.
	systemPrompt := `You are a cross-app workflow assistant.
Given context read from one application and a high-level goal, propose ONE
concrete action on another application.

Output ONLY valid JSON (no markdown fences, no explanation outside the JSON):
{
  "summary": "one-sentence description of what will be done",
  "action": {
    "connector": "<connector-id>",
    "action": "<action-name>",
    "params": {}
  }
}`

	userPrompt := fmt.Sprintf(
		"Goal: %s\n\nContext read from %s (action: %s):\n%s\n\nPropose one action to accomplish the goal.",
		goal, readConnector, readAction, string(readJSON),
	)

	// Stamp idempotency key on the context (invariant #8).
	idemBase := "cross-app:" + tenantID + ":" + goal
	callCtx := WithLLMIdempotencyBase(ctx, idemBase)

	rawText, err := h.completeFn(callCtx, tenantID, systemPrompt, userPrompt)
	if err != nil {
		return "", crossAppProposed{}, fmt.Errorf("LLM call: %w", err)
	}

	// 3. Parse LLM response — treat model output as untrusted data (invariant).
	proposedAction, summary, parseErr := parseCrossAppLLMResponse(rawText)
	if parseErr != nil {
		return "", crossAppProposed{}, fmt.Errorf("parse LLM response: %w", parseErr)
	}

	// 4. Build action_plan JSONB.
	plan := crossAppPlan{
		Goal:           goal,
		ReadConnector:  readConnector,
		ReadAction:     readAction,
		ReadContext:    readResult,
		ProposedAction: proposedAction,
	}
	planJSON, _ := json.Marshal(plan)

	// 5. Store as a kind='cross_app' commitment, status='suggested'.
	// The proposed action is stored as DATA for the owner to review.
	// It is NEVER executed here.
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO commitments
				(tenant_id, title, source, kind, tier, urgency, status, action_plan)
			VALUES ($1, $2, 'self', 'cross_app', 'meso', 'normal', 'suggested', $3::jsonb)
			RETURNING id
		`, tenantID, clampRunes(summary, 500), string(planJSON)).Scan(&commitmentID)
	})
	if err != nil {
		return "", crossAppProposed{}, fmt.Errorf("store commitment: %w", err)
	}

	h.logger().Info("propose: stored cross-app commitment",
		zap.String("id", commitmentID),
		zap.String("tenant", tenantID),
		zap.String("connector", proposedAction.Connector),
		zap.String("action", proposedAction.Action),
	)

	return commitmentID, proposedAction, nil
}

// ExecuteAction handles POST /v1/commitments/{id}/execute-action.
//
// This is the SOLE side-effect path for cross-app workflows. The owner calling
// this endpoint constitutes explicit confirmation.
//
// It executes the connector action stored in action_plan.proposedAction only when:
//   - commitment exists and belongs to this tenant (cross-tenant → 404)
//   - kind = 'cross_app'
//   - status != 'done' (idempotent: refuse to re-execute an already-done one)
//
// On success, marks the commitment status='done' and stores the execution result.
// The conditional UPDATE (WHERE status != 'done') prevents double-execution on
// concurrent requests.
func (h *CrossAppHandler) ExecuteAction(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	// 1. Load commitment — tenant-scoped; cross-tenant rows invisible (404).
	// kind and action_plan are nullable columns; use pointer types to avoid
	// scan errors when a plain commitment has kind=NULL or action_plan=NULL.
	var kindPtr *string
	var status string
	var planJSON []byte
	var found bool
	if loadErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		scanErr := tx.QueryRow(ctx, `
			SELECT kind, status, action_plan
			FROM commitments
			WHERE id = $1 AND tenant_id = $2
		`, id, tenantID).Scan(&kindPtr, &status, &planJSON)
		if scanErr == pgx.ErrNoRows {
			found = false
			return nil
		}
		found = true
		return scanErr
	}); loadErr != nil {
		h.logger().Error("execute-action: load failed", zap.String("id", id), zap.Error(loadErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
		return
	}
	kind := ""
	if kindPtr != nil {
		kind = *kindPtr
	}
	if kind != "cross_app" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "commitment is not a cross-app proposal"})
		return
	}
	if status == "done" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already executed"})
		return
	}

	// 2. Parse action_plan to extract the proposed action.
	var plan crossAppPlan
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "corrupt action_plan"})
		return
	}
	pa := plan.ProposedAction
	if pa.Connector == "" || pa.Action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no proposedAction in commitment"})
		return
	}

	// 3. Execute the proposed action.
	// This is the ONLY place a cross-app side-effect runs.
	execResult, execErr := h.connectorCall(ctx, tenantID, pa.Connector, pa.Action, pa.Params)
	if execErr != nil {
		h.logger().Warn("execute-action: connector call failed",
			zap.String("id", id),
			zap.String("connector", pa.Connector),
			zap.String("action", pa.Action),
			zap.Error(execErr),
		)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": execErr.Error()})
		return
	}

	// 4. Mark done — conditional WHERE status != 'done' prevents double-execution
	// if two requests race past the status check above. Store execution result.
	plan.ExecutionResult = execResult
	updatedPlanJSON, _ := json.Marshal(plan)

	var rowsAffected int64
	if updateErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `
			UPDATE commitments
			SET status = 'done', action_plan = $1::jsonb, updated_at = now()
			WHERE id = $2 AND tenant_id = $3 AND status != 'done'
		`, string(updatedPlanJSON), id, tenantID)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	}); updateErr != nil {
		// The side-effect already happened; returning 500 would mislead the owner.
		// Log the failure and return success with a warning field.
		h.logger().Error("execute-action: mark-done failed — side-effect already fired",
			zap.String("id", id), zap.Error(updateErr))
		writeJSON(w, http.StatusOK, map[string]any{
			"id":      id,
			"status":  "done",
			"result":  execResult,
			"warning": "executed but failed to mark commitment done",
		})
		return
	}
	if rowsAffected == 0 {
		// Concurrent request raced us and already marked done.
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already executed (concurrent request)"})
		return
	}

	h.logger().Info("execute-action: executed",
		zap.String("id", id),
		zap.String("connector", pa.Connector),
		zap.String("action", pa.Action),
		zap.String("tenant", tenantID),
	)

	writeJSON(w, http.StatusOK, map[string]any{
		"id":     id,
		"status": "done",
		"result": execResult,
	})
}

// parseCrossAppLLMResponse strips code fences and parses the LLM JSON into
// a (crossAppProposed, summary). Returns an error when required fields are missing.
// LLM output is treated as untrusted data — never executed directly.
func parseCrossAppLLMResponse(raw string) (crossAppProposed, string, error) {
	s := strings.TrimSpace(raw)
	// Strip code fences: ```json ... ``` or ``` ... ```.
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		if strings.HasPrefix(s, "json") {
			s = s[4:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
		s = strings.TrimSpace(s)
	}
	// Find first { ... last } to tolerate leading/trailing prose.
	if start := strings.Index(s, "{"); start != -1 {
		s = s[start:]
	}
	if end := strings.LastIndex(s, "}"); end != -1 {
		s = s[:end+1]
	}

	var resp struct {
		Summary string           `json:"summary"`
		Action  crossAppProposed `json:"action"`
	}
	if err := json.Unmarshal([]byte(s), &resp); err != nil {
		return crossAppProposed{}, "", fmt.Errorf("json.Unmarshal: %w", err)
	}
	if strings.TrimSpace(resp.Summary) == "" {
		return crossAppProposed{}, "", fmt.Errorf("LLM returned empty summary")
	}
	if resp.Action.Connector == "" || resp.Action.Action == "" {
		return crossAppProposed{}, "", fmt.Errorf("LLM returned incomplete action (missing connector or action name)")
	}
	return resp.Action, resp.Summary, nil
}
