package handlers

// W11a — Human takeover handshake for a running agent.
//
// What it does today:
//   - POST /v1/runs/{id}/takeover/request — workflow (or a human via the
//     dashboard) creates a takeover_requests row, returns its id. The run's
//     workflow interpreter (W11b approval node) polls this table and pauses
//     until the row flips to "granted".
//   - POST /v1/runs/{id}/takeover/{takeoverId}/grant — operator approves,
//     optionally posting an SDP offer (when a real Firecracker VM display
//     is available). The workflow resumes.
//   - POST /v1/runs/{id}/takeover/{takeoverId}/answer — operator returns
//     the SDP answer from the browser side. The runtime-manager uses
//     these to set up the WebRTC peer connection.
//   - POST /v1/runs/{id}/takeover/{takeoverId}/release — operator hands
//     control back, workflow continues to the next step.
//   - GET /v1/runs/{id}/takeover — lists takeover requests for the run.
//
// What's deferred:
//   - Actual Firecracker microVM display streaming. The contract here is
//     real: requests get persisted, the workflow pauses, the dashboard
//     can grant/release. When the runtime-manager gains an x11vnc →
//     WebRTC encoder, the SDP fields plug straight in.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type TakeoverHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewTakeoverHandler(srv *server.Server, auth *AuthHandler) *TakeoverHandler {
	return &TakeoverHandler{srv: srv, auth: auth}
}

func (h *TakeoverHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("takeover")
}

// ---------- Request a takeover ----------

type requestBody struct {
	StepID string `json:"stepId,omitempty"`
	Reason string `json:"reason,omitempty"`
	// TimeoutMinutes bounds how long the takeover can stay in 'pending'
	// before being auto-expired. Default 30 min, max 24h.
	TimeoutMinutes int `json:"timeoutMinutes,omitempty"`
}

func (h *TakeoverHandler) Request(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	runID := r.PathValue("id")
	if runID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "run id required"})
		return
	}
	var body requestBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.TimeoutMinutes <= 0 {
		body.TimeoutMinutes = 30
	}
	if body.TimeoutMinutes > 24*60 {
		body.TimeoutMinutes = 24 * 60
	}

	expiresAt := time.Now().Add(time.Duration(body.TimeoutMinutes) * time.Minute)
	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO takeover_requests (run_id, tenant_id, step_id, reason, status, expires_at)
			VALUES ($1, $2, $3, $4, 'pending', $5)
			RETURNING id::text
		`, runID, tenantID, body.StepID, body.Reason, expiresAt).Scan(&id)
	})
	if err != nil {
		h.logger().Error("create takeover failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create takeover"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        id,
		"runId":     runID,
		"status":    "pending",
		"expiresAt": expiresAt,
	})
}

// ---------- Grant ----------

type grantBody struct {
	SDPOffer string `json:"sdpOffer,omitempty"`
	Notes    string `json:"notes,omitempty"`
}

func (h *TakeoverHandler) Grant(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("takeoverId")
	var body grantBody
	_ = json.NewDecoder(r.Body).Decode(&body)

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `
			UPDATE takeover_requests
			SET status = 'granted',
			    granted_at = now(),
			    sdp_offer = COALESCE(NULLIF($3, ''), sdp_offer),
			    notes = COALESCE(NULLIF($4, ''), notes)
			WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
		`, id, tenantID, body.SDPOffer, body.Notes)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("grant takeover failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to grant takeover"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "takeover not found or not pending"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":     id,
		"status": "granted",
	})
}

// ---------- SDP answer (WebRTC handshake completion) ----------

type answerBody struct {
	SDPAnswer string `json:"sdpAnswer"`
}

func (h *TakeoverHandler) Answer(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("takeoverId")
	var body answerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SDPAnswer == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sdpAnswer required"})
		return
	}

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `
			UPDATE takeover_requests
			SET sdp_answer = $3
			WHERE id = $1 AND tenant_id = $2 AND status = 'granted'
		`, id, tenantID, body.SDPAnswer)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to store answer"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "takeover not granted yet"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "negotiated"})
}

// ---------- Release ----------

func (h *TakeoverHandler) Release(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("takeoverId")

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `
			UPDATE takeover_requests
			SET status = 'released', released_at = now()
			WHERE id = $1 AND tenant_id = $2 AND status IN ('granted', 'pending')
		`, id, tenantID)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to release"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "takeover not found or already closed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "released"})
}

// ---------- List for a run ----------

func (h *TakeoverHandler) ListForRun(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	runID := r.PathValue("id")

	out := make([]map[string]any, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id::text, step_id, status, COALESCE(reason, ''),
			       COALESCE(notes, ''),
			       sdp_offer IS NOT NULL,
			       sdp_answer IS NOT NULL,
			       created_at, granted_at, released_at, expires_at
			FROM takeover_requests
			WHERE run_id = $1 AND tenant_id = $2
			ORDER BY created_at DESC
		`, runID, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var id, stepID, status, reason, notes string
			var hasOffer, hasAnswer bool
			var createdAt time.Time
			var grantedAt, releasedAt, expiresAt *time.Time
			if e := rows.Scan(&id, &stepID, &status, &reason, &notes, &hasOffer, &hasAnswer, &createdAt, &grantedAt, &releasedAt, &expiresAt); e != nil {
				continue
			}
			entry := map[string]any{
				"id":         id,
				"stepId":     stepID,
				"status":     status,
				"reason":     reason,
				"notes":      notes,
				"hasOffer":   hasOffer,
				"hasAnswer":  hasAnswer,
				"createdAt":  createdAt,
				"grantedAt":  grantedAt,
				"releasedAt": releasedAt,
				"expiresAt":  expiresAt,
			}
			out = append(out, entry)
		}
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}
