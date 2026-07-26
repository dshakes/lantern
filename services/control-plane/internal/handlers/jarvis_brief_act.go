package handlers

// Two-way morning brief: the numbers in the brief are the interface.
//
// The brief lists "1. Review the flagged Amex charge". Replying "done 1"
// resolves 1 against the mapping persisted when that brief was SENT — never
// by recomputing the ranked query, which drifts as commitments change and
// would close a different item than the one on screen.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

type briefActRequest struct {
	N      int    `json:"n"`
	Action string `json:"action"` // done | snooze | dismiss
}

type briefActResponse struct {
	OK           bool   `json:"ok"`
	CommitmentID string `json:"commitmentId,omitempty"`
	Title        string `json:"title,omitempty"`
	Action       string `json:"action,omitempty"`
	Error        string `json:"error,omitempty"`
}

// BriefAct handles POST /v1/jarvis/brief/act.
//
// Deliberately narrow: it only acts on items the last brief actually listed.
// An out-of-range number is a clear error rather than a best guess, because
// the failure mode of guessing is marking the wrong thing done — which the
// owner will never notice, since they believe it is handled.
func (h *JarvisHandler) BriefAct(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, briefActResponse{Error: "unauthorized"})
		return
	}
	tenantID := claims.TenantID

	var req briefActRequest
	if decErr := json.NewDecoder(r.Body).Decode(&req); decErr != nil {
		writeJSON(w, http.StatusBadRequest, briefActResponse{Error: "invalid body"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = "done"
	}
	switch action {
	case "done", "snooze", "dismiss":
	default:
		writeJSON(w, http.StatusBadRequest, briefActResponse{
			Error: "action must be one of: done, snooze, dismiss",
		})
		return
	}
	if req.N < 1 {
		writeJSON(w, http.StatusBadRequest, briefActResponse{Error: "n must be 1 or greater"})
		return
	}

	id, ok := h.ResolveBriefItem(r.Context(), tenantID, req.N)
	if !ok {
		writeJSON(w, http.StatusNotFound, briefActResponse{
			Error: "no item with that number in your latest brief",
		})
		return
	}

	title, actErr := h.applyBriefAction(r.Context(), tenantID, id, action)
	if actErr != nil {
		h.logger().Warn("brief action failed",
			zap.String("commitment_id", id), zap.String("action", action), zap.Error(actErr))
		writeJSON(w, http.StatusInternalServerError, briefActResponse{Error: "could not update the item"})
		return
	}

	h.logger().Info("brief action applied",
		zap.String("commitment_id", id), zap.String("action", action), zap.Int("n", req.N))
	writeJSON(w, http.StatusOK, briefActResponse{
		OK: true, CommitmentID: id, Title: title, Action: action,
	})
}

// applyBriefAction performs the transition and returns the item's title for
// the acknowledgement, so the owner sees WHAT they just closed rather than a
// bare "ok" — the cheapest guard against acting on the wrong number.
func (h *JarvisHandler) applyBriefAction(ctx context.Context, tenantID, id, action string) (string, error) {
	status := map[string]string{
		"done":    "done",
		"dismiss": "dismissed",
	}[action]

	var title string
	err := h.srv.WithTenant(middleware.InjectTenantID(ctx, tenantID), func(tx pgx.Tx) error {
		if action == "snooze" {
			// Snooze defers the nudge without closing the item, matching
			// POST /v1/commitments/{id}/snooze semantics.
			return tx.QueryRow(ctx, `
				UPDATE commitments
				SET next_nudge_at = now() + interval '1 day', updated_at = now()
				WHERE tenant_id = $1 AND id = $2
				RETURNING title
			`, tenantID, id).Scan(&title)
		}
		return tx.QueryRow(ctx, `
			UPDATE commitments
			SET status = $3, updated_at = now()
			WHERE tenant_id = $1 AND id = $2
			RETURNING title
		`, tenantID, id, status).Scan(&title)
	})
	return title, err
}
