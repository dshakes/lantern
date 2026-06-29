// browser.go — browser-as-skill: autonomous web reads + owner-confirmed browser actions.
//
// SAFETY INVARIANT: reads are autonomous; side-effecting writes (browser_act)
// ALWAYS require explicit owner confirm. There is NO autonomous write path.
//
// Increment 1: control-plane contract + owner-confirm layer only.
// The actual headless browser executes inside a microVM (architectural
// invariant #5) via RuntimeManager.ExecTool. Until increment 2 ships the
// runtime returns TOOL_STATUS_UNAVAILABLE, which surfaces here as HTTP 503.
//
//	POST /v1/browser/read                     — autonomous browse + extract (503 today)
//	POST /v1/browser/propose                  — store a browser_act proposal (no side effect)
//	POST /v1/browser/commitments/{id}/execute — SOLE write path; owner confirm required
//
// Feature-gated behind LANTERN_BROWSER_SKILL=on/1/true (default OFF).
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
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// browserSkillEnabled reports whether the browser-as-skill feature is enabled.
// Default OFF — set LANTERN_BROWSER_SKILL=on/1/true to enable.
func browserSkillEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_BROWSER_SKILL")))
	return v == "on" || v == "1" || v == "true"
}

// browserExecFn is the injectable seam for RuntimeManager.ExecTool calls.
// Production: built from a real lanternv1.RuntimeManagerClient via SetRuntimeClient.
// Tests: a stub func that returns UNAVAILABLE or OK without a real gRPC server.
type browserExecFn func(ctx context.Context, toolName string, args map[string]any) (*lanternv1.ExecToolResponse, error)

// browserActPlan is stored as commitments.action_plan for kind='browser_act'.
// ExecutionResult is populated only after Execute confirms successfully.
type browserActPlan struct {
	URL             string `json:"url"`
	Action          string `json:"action"`
	Selector        string `json:"selector,omitempty"`
	Value           string `json:"value,omitempty"`
	Goal            string `json:"goal"`
	ExecutionResult any    `json:"executionResult,omitempty"`
}

// BrowserHandler handles the browser-as-skill endpoints.
type BrowserHandler struct {
	srv    *server.Server
	auth   *AuthHandler
	execFn browserExecFn // nil = no runtime manager configured → 503
}

// NewBrowserHandler creates a BrowserHandler. Call SetRuntimeClient to wire
// the real RuntimeManager before Read and Execute can dispatch.
func NewBrowserHandler(srv *server.Server, auth *AuthHandler) *BrowserHandler {
	return &BrowserHandler{srv: srv, auth: auth}
}

// SetRuntimeClient wires the real RuntimeManagerClient (called from main.go
// when LANTERN_RUNTIME_MANAGER_ADDR is set). Wraps ExecTool in a closure
// that handles map→structpb conversion.
func (h *BrowserHandler) SetRuntimeClient(cl lanternv1.RuntimeManagerClient) {
	h.execFn = func(ctx context.Context, toolName string, args map[string]any) (*lanternv1.ExecToolResponse, error) {
		var argsStruct *structpb.Struct
		if len(args) > 0 {
			s, err := structpb.NewStruct(args)
			if err != nil {
				return nil, fmt.Errorf("encode args for %q: %w", toolName, err)
			}
			argsStruct = s
		}
		return cl.ExecTool(ctx, &lanternv1.ExecToolRequest{
			ToolName: toolName,
			Args:     argsStruct,
		})
	}
}

func (h *BrowserHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("browser-skill")
}

// Read handles POST /v1/browser/read.
//
// Autonomous read: navigates to url and extracts information for task. No
// side effects — browse is classified as a read per ADR 0017.
//
// In increment 1 the runtime always returns TOOL_STATUS_UNAVAILABLE, so this
// endpoint returns 503 until increment 2 ships.
//
// Body: {url, task}
func (h *BrowserHandler) Read(w http.ResponseWriter, r *http.Request) {
	if !browserSkillEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "browser skill disabled (set LANTERN_BROWSER_SKILL=on)"})
		return
	}

	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)

	var body struct {
		URL  string `json:"url"`
		Task string `json:"task"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.URL == "" || body.Task == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url and task are required"})
		return
	}

	if h.execFn == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "browser runtime not yet available (increment 2)"})
		return
	}

	resp, err := h.execFn(ctx, "browse", map[string]any{"url": body.URL, "task": body.Task})
	if err != nil {
		h.logger().Warn("browse: ExecTool error",
			zap.String("tenant", claims.TenantID),
			zap.String("url", body.URL),
			zap.Error(err),
		)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "browser runtime not yet available (increment 2)"})
		return
	}

	switch resp.GetStatus() {
	case lanternv1.ToolStatus_TOOL_STATUS_OK:
		var resultMap map[string]any
		if r := resp.GetResult(); r != nil {
			resultMap = r.AsMap()
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": resultMap})
	case lanternv1.ToolStatus_TOOL_STATUS_ERROR:
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": resp.GetError()})
	default: // UNAVAILABLE or UNSPECIFIED
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "browser runtime not yet available (increment 2)"})
	}
}

// Propose handles POST /v1/browser/propose.
//
// Stores a browser_act proposal as a kind='browser_act' commitment with
// status='suggested'. The browser action is NEVER executed here — it requires
// an explicit owner confirm via POST /v1/browser/commitments/{id}/execute.
//
// Body: {url, action, selector?, value?, goal}
// Returns: {id}
func (h *BrowserHandler) Propose(w http.ResponseWriter, r *http.Request) {
	if !browserSkillEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "browser skill disabled (set LANTERN_BROWSER_SKILL=on)"})
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
		URL      string `json:"url"`
		Action   string `json:"action"`
		Selector string `json:"selector"`
		Value    string `json:"value"`
		Goal     string `json:"goal"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.URL == "" || body.Action == "" || body.Goal == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url, action, and goal are required"})
		return
	}

	plan := browserActPlan{
		URL:      body.URL,
		Action:   body.Action,
		Selector: body.Selector,
		Value:    body.Value,
		Goal:     body.Goal,
	}
	planJSON, _ := json.Marshal(plan)

	var id string
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO commitments
				(tenant_id, title, source, kind, tier, urgency, status, action_plan)
			VALUES ($1, $2, 'browser', 'browser_act', 'meso', 'normal', 'suggested', $3::jsonb)
			RETURNING id
		`, tenantID, clampRunes(body.Goal, 500), string(planJSON)).Scan(&id)
	}); err != nil {
		h.logger().Error("propose: store commitment failed",
			zap.String("tenant", tenantID),
			zap.Error(err),
		)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.logger().Info("propose: stored browser_act commitment",
		zap.String("id", id),
		zap.String("tenant", tenantID),
		zap.String("url", body.URL),
		zap.String("action", body.Action),
	)

	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// Execute handles POST /v1/browser/commitments/{id}/execute.
//
// This is the SOLE side-effect path for browser actions. The owner calling
// this endpoint constitutes explicit confirmation.
//
// Safety invariants enforced (mirrors cross_app.ExecuteAction):
//   - Feature-gated: same LANTERN_BROWSER_SKILL flag.
//   - Owner/admin role gate: non-owners get 403 before any DB access.
//   - Runtime check: no manager configured → 503 without touching the commitment.
//   - Atomic exclusive claim: UPDATE WHERE status='suggested' RETURNING — only
//     ONE concurrent caller proceeds; all others get 409.
//   - Secondary side-effect receipt: claimSideEffect (invariant #8).
//   - UNAVAILABLE: status reverted to 'suggested' + receipt deleted so the
//     owner can retry once increment 2 ships. Returns 503.
//   - ERROR: status set to 'failed'; owner must re-propose. Returns 502.
func (h *BrowserHandler) Execute(w http.ResponseWriter, r *http.Request) {
	if !browserSkillEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "browser skill disabled (set LANTERN_BROWSER_SKILL=on)"})
		return
	}

	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if claims.Role != "owner" && claims.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner can execute a browser action"})
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	// Fail fast before the atomic claim: if no runtime is configured, no amount
	// of confirming will fire the browser action. Return 503 without mutating the
	// commitment so a retry works once the runtime is wired (increment 2).
	if h.execFn == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "browser runtime not yet available (increment 2)"})
		return
	}

	// Atomically claim the commitment by transitioning status='suggested' → 'done'.
	// action_plan is returned to this caller exclusively. Concurrent requests that
	// also try to claim get 0 rows back and return 409.
	var planJSON []byte
	claimErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			UPDATE commitments
			SET    status = 'done', updated_at = now()
			WHERE  id = $1 AND tenant_id = $2 AND kind = 'browser_act' AND status = 'suggested'
			RETURNING action_plan
		`, id, tenantID).Scan(&planJSON)
	})
	if claimErr == pgx.ErrNoRows {
		// Diagnose for a precise error message.
		var kindPtr *string
		var statusVal string
		diagErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT kind, status FROM commitments WHERE id = $1 AND tenant_id = $2
			`, id, tenantID).Scan(&kindPtr, &statusVal)
		})
		if diagErr == pgx.ErrNoRows {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
			return
		}
		if diagErr != nil {
			h.logger().Error("execute: diagnostic query failed", zap.String("id", id), zap.Error(diagErr))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if kindPtr == nil || *kindPtr != "browser_act" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "commitment is not a browser_act proposal"})
			return
		}
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already executed"})
		return
	}
	if claimErr != nil {
		h.logger().Error("execute: atomic claim failed", zap.String("id", id), zap.Error(claimErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// Secondary side-effect receipt (invariant #8). Prevents double-dispatch on
	// crash-replay.
	// ponytail: commitment id used as run_id (UUID field, no FK — semantically
	// equivalent for this non-run side-effect, mirrors cross_app).
	idemKey := "browseract:" + id
	claimed, sideEffectErr := claimSideEffect(ctx, h.srv.Pool, idemKey, id, tenantID, "browser_act")
	if sideEffectErr != nil {
		h.logger().Error("execute: claimSideEffect failed", zap.String("id", id), zap.Error(sideEffectErr))
		h.setCommitmentStatus(ctx, id, tenantID, "suggested")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !claimed {
		// A prior attempt already holds the receipt. Revert the claim (our UPDATE
		// set status='done') so the commitment is not stuck, then report conflict.
		h.setCommitmentStatus(ctx, id, tenantID, "suggested")
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already executed (concurrent request)"})
		return
	}

	var plan browserActPlan
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "corrupt action_plan"})
		return
	}

	args := map[string]any{"url": plan.URL, "action": plan.Action, "goal": plan.Goal}
	if plan.Selector != "" {
		args["selector"] = plan.Selector
	}
	if plan.Value != "" {
		args["value"] = plan.Value
	}

	resp, execErr := h.execFn(ctx, "browser_act", args)
	if execErr != nil {
		h.logger().Warn("execute: ExecTool error",
			zap.String("id", id),
			zap.String("url", plan.URL),
			zap.Error(execErr),
		)
		// Network/RPC error — treat as UNAVAILABLE: revert status to 'suggested'.
		// The side_effect_receipts row is kept (prevents double-fire in concurrent
		// or crash-replay scenarios). A new Propose creates a fresh commitment.
		h.setCommitmentStatus(ctx, id, tenantID, "suggested")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "browser runtime not yet available (increment 2)"})
		return
	}

	switch resp.GetStatus() {
	case lanternv1.ToolStatus_TOOL_STATUS_OK:
		var resultMap map[string]any
		if r := resp.GetResult(); r != nil {
			resultMap = r.AsMap()
		}
		plan.ExecutionResult = resultMap
		updatedPlanJSON, _ := json.Marshal(plan)
		if updateErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				UPDATE commitments
				SET    action_plan = $1::jsonb, updated_at = now()
				WHERE  id = $2 AND tenant_id = $3
			`, string(updatedPlanJSON), id, tenantID)
			return e
		}); updateErr != nil {
			// Side-effect already fired; log and return success with a warning field
			// rather than misleading the caller with 500.
			h.logger().Error("execute: store-result failed — side-effect already fired",
				zap.String("id", id), zap.Error(updateErr))
			writeJSON(w, http.StatusOK, map[string]any{
				"id":      id,
				"status":  "done",
				"result":  resultMap,
				"warning": "executed but failed to store result",
			})
			return
		}
		h.logger().Info("execute: browser action executed",
			zap.String("id", id),
			zap.String("tenant", tenantID),
			zap.String("url", plan.URL),
		)
		writeJSON(w, http.StatusOK, map[string]any{
			"id":     id,
			"status": "done",
			"result": resultMap,
		})

	case lanternv1.ToolStatus_TOOL_STATUS_ERROR:
		// Tool ran but failed — mark 'failed'. Receipt remains, blocking retry.
		// Owner must re-propose.
		h.setCommitmentStatus(ctx, id, tenantID, "failed")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": resp.GetError()})

	default: // UNAVAILABLE or UNSPECIFIED
		// No side-effect occurred. Revert status to 'suggested'. The receipt is
		// kept — it's the exactly-once guard in concurrent / crash-replay scenarios.
		// A new Propose is needed to retry once increment 2 ships.
		h.setCommitmentStatus(ctx, id, tenantID, "suggested")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "browser runtime not yet available (increment 2)"})
	}
}

// setCommitmentStatus updates a commitment's status. Used by Execute to revert
// on runtime unavailability ('suggested') or mark terminal failure ('failed').
func (h *BrowserHandler) setCommitmentStatus(ctx context.Context, id, tenantID, status string) {
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE commitments SET status = $1, updated_at = now()
			WHERE  id = $2 AND tenant_id = $3
		`, status, id, tenantID)
		return e
	}); err != nil {
		h.logger().Error("setCommitmentStatus failed",
			zap.String("id", id), zap.String("status", status), zap.Error(err))
	}
}
