package handlers

// Run feedback / RLHF loop.
//
// The fastest improvement signal for a deployed agent is human thumbs. This
// handler captures per-run feedback (1-5 score + free-text comment + optional
// preferred-output) and aggregates daily so the eval suite can pull "the runs
// users actually liked" as positive examples for fine-tuning or
// retrieval-prompt seeding.
//
// The point is to close the loop: every run that ships into the marketplace,
// or behind a Surface (WhatsApp/Slack/etc), gets a reaction from a human, and
// that reaction shows up on the agent's analytics dashboard within seconds.

import (
	"encoding/json"
	"net/http"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type FeedbackHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewFeedbackHandler(srv *server.Server, auth *AuthHandler) *FeedbackHandler {
	return &FeedbackHandler{srv: srv, auth: auth}
}

func (h *FeedbackHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("feedback")
}

// ---------- DTOs ----------

type feedbackRequest struct {
	Score           int    `json:"score"` // 1..5; 1=thumbs-down, 5=thumbs-up
	Comment         string `json:"comment,omitempty"`
	PreferredOutput string `json:"preferredOutput,omitempty"`
	Source          string `json:"source,omitempty"` // dashboard | sdk | surface
}

type feedbackRow struct {
	RunID           string    `json:"runId"`
	AgentName       string    `json:"agentName,omitempty"`
	Score           int       `json:"score"`
	Comment         string    `json:"comment,omitempty"`
	PreferredOutput string    `json:"preferredOutput,omitempty"`
	Source          string    `json:"source"`
	CreatedAt       time.Time `json:"createdAt"`
}

type feedbackSummary struct {
	AgentName     string  `json:"agentName"`
	TotalFeedback int     `json:"totalFeedback"`
	AvgScore      float64 `json:"avgScore"`
	ThumbsUp      int     `json:"thumbsUp"`   // score >= 4
	ThumbsDown    int     `json:"thumbsDown"` // score <= 2
	HasPreferred  int     `json:"runsWithPreferredOutput"`
	Last7DaysAvg  float64 `json:"last7DaysAvgScore"`
}

// ---------- Endpoints ----------

// SubmitFeedback handles POST /v1/runs/{id}/feedback.
func (h *FeedbackHandler) SubmitFeedback(w http.ResponseWriter, r *http.Request) {
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
	var body feedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Score < 1 || body.Score > 5 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "score must be 1..5"})
		return
	}
	if body.Source == "" {
		body.Source = "dashboard"
	}

	// Verify the run belongs to the caller's tenant before accepting feedback.
	var agentName string
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT COALESCE(a.name, '')
		FROM runs r LEFT JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		WHERE r.id = $1 AND r.tenant_id = $2
	`, runID, tenantID).Scan(&agentName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
		return
	}

	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO run_feedback
		  (tenant_id, run_id, agent_name, score, comment, preferred_output, source, created_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, NOW())
	`, tenantID, runID, agentName, body.Score, body.Comment, body.PreferredOutput, body.Source)
	if err != nil {
		h.logger().Error("insert feedback", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save feedback"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"status": "recorded"})
}

// ListFeedback handles GET /v1/runs/{id}/feedback (per-run history).
func (h *FeedbackHandler) ListFeedback(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	runID := r.PathValue("id")

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT run_id, COALESCE(agent_name, ''), score, COALESCE(comment, ''),
		       COALESCE(preferred_output, ''), source, created_at
		FROM run_feedback
		WHERE tenant_id = $1 AND run_id = $2
		ORDER BY created_at DESC
	`, tenantID, runID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	defer rows.Close()

	out := []feedbackRow{}
	for rows.Next() {
		var fr feedbackRow
		if err := rows.Scan(&fr.RunID, &fr.AgentName, &fr.Score, &fr.Comment,
			&fr.PreferredOutput, &fr.Source, &fr.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan failed"})
			return
		}
		out = append(out, fr)
	}
	writeJSON(w, http.StatusOK, out)
}

// AgentSummary handles GET /v1/agents/{name}/feedback.
func (h *FeedbackHandler) AgentSummary(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.PathValue("name")
	if agentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name required"})
		return
	}

	var s feedbackSummary
	s.AgentName = agentName
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT
		  COUNT(*),
		  COALESCE(AVG(score), 0),
		  COUNT(*) FILTER (WHERE score >= 4),
		  COUNT(*) FILTER (WHERE score <= 2),
		  COUNT(*) FILTER (WHERE preferred_output IS NOT NULL),
		  COALESCE(AVG(score) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)
		FROM run_feedback
		WHERE tenant_id = $1 AND agent_name = $2
	`, tenantID, agentName).Scan(
		&s.TotalFeedback, &s.AvgScore, &s.ThumbsUp, &s.ThumbsDown,
		&s.HasPreferred, &s.Last7DaysAvg,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, s)
}
