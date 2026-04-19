package handlers

// Simulated rehearsals.
//
// Replays past failed (or low-feedback) runs as synthetic test cases against a
// new agent version BEFORE you flip traffic. The point: catch regressions on
// the exact inputs that broke the agent in production, not synthetic ones a
// human imagined.
//
// Algorithm:
//  1. Pull up to N runs from the requested time window where status = 'failed'
//     OR run_feedback.score <= 2. Optionally filter by tag.
//  2. For each, the rehearsal records:
//       - the original input
//       - the original output (if any)
//       - the original agent version
//  3. The caller (lantern test --rehearse) re-executes each input against the
//     candidate version and posts case results back to /v1/eval-runs, which
//     gates merge via the existing eval-in-CI machinery.
//
// This reuses the eval infrastructure rather than introducing a parallel
// system, so regressions are surfaced through the same baseline mechanism.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type RehearseHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewRehearseHandler(srv *server.Server, auth *AuthHandler) *RehearseHandler {
	return &RehearseHandler{srv: srv, auth: auth}
}

func (h *RehearseHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("rehearse")
}

// ---------- DTOs ----------

type rehearseRequest struct {
	AgentName       string `json:"agentName"`
	Window          string `json:"window,omitempty"`          // e.g. "7d", "30d"; default 7d
	IncludeFailures bool   `json:"includeFailures,omitempty"` // default true
	IncludeLowScore bool   `json:"includeLowScore,omitempty"` // default true (feedback score <= 2)
	Limit           int    `json:"limit,omitempty"`           // default 25, max 200
}

type rehearseCase struct {
	OriginalRunID      string          `json:"originalRunId"`
	OriginalAgentVer   string          `json:"originalAgentVersion,omitempty"`
	OriginalStatus     string          `json:"originalStatus"`
	OriginalScore      *int            `json:"originalScore,omitempty"`
	Input              json.RawMessage `json:"input"`
	ExpectedOutput     json.RawMessage `json:"expectedOutput,omitempty"`
	OriginalCostUsd    float64         `json:"originalCostUsd"`
	OriginalAt         time.Time       `json:"originalAt"`
}

type rehearseResponse struct {
	AgentName string         `json:"agentName"`
	Window    string         `json:"window"`
	Cases     []rehearseCase `json:"cases"`
	Count     int            `json:"count"`
	Reason    string         `json:"reason,omitempty"` // populated when 0 cases found
}

// ---------- Endpoint ----------

// Rehearse handles POST /v1/runs/rehearse. Returns the synthetic test set
// derived from past production traffic; the caller (CLI / SDK) executes each
// case against the candidate agent version and posts results to /v1/eval-runs.
func (h *RehearseHandler) Rehearse(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body rehearseRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AgentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName required"})
		return
	}
	if body.Window == "" {
		body.Window = "7d"
	}
	dur, err := parseWindow(body.Window)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if body.Limit <= 0 {
		body.Limit = 25
	} else if body.Limit > 200 {
		body.Limit = 200
	}

	// Defaults: include both failures and low-score runs.
	includeFailures := true
	includeLowScore := true
	if !body.IncludeFailures && !body.IncludeLowScore {
		includeFailures = true
		includeLowScore = true
	} else {
		includeFailures = body.IncludeFailures
		includeLowScore = body.IncludeLowScore
	}

	cutoff := time.Now().Add(-dur)

	// Build the union query. We pull runs that are either failed OR have a
	// feedback row with score <= 2.
	q := `
		SELECT DISTINCT
		  r.id,
		  COALESCE(av.digest, ''),
		  r.status,
		  rf.score,
		  COALESCE(r.input, '{}'::jsonb),
		  COALESCE(r.output, 'null'::jsonb),
		  COALESCE(r.cost_usd, 0),
		  r.created_at
		FROM runs r
		LEFT JOIN agents a         ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		LEFT JOIN agent_versions av ON av.id = a.current_version_id
		LEFT JOIN run_feedback rf  ON rf.run_id = r.id AND rf.tenant_id = r.tenant_id
		WHERE r.tenant_id = $1
		  AND a.name      = $2
		  AND r.created_at >= $3
		  AND (
		       ($4 AND r.status = 'failed')
		    OR ($5 AND rf.score <= 2)
		  )
		ORDER BY r.created_at DESC
		LIMIT $6
	`
	rows, err := h.srv.Pool.Query(ctx, q,
		tenantID, body.AgentName, cutoff,
		includeFailures, includeLowScore, body.Limit,
	)
	if err != nil {
		h.logger().Error("rehearse query", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	defer rows.Close()

	out := rehearseResponse{
		AgentName: body.AgentName,
		Window:    body.Window,
		Cases:     []rehearseCase{},
	}
	for rows.Next() {
		var c rehearseCase
		var score *int
		if err := rows.Scan(
			&c.OriginalRunID, &c.OriginalAgentVer, &c.OriginalStatus, &score,
			&c.Input, &c.ExpectedOutput, &c.OriginalCostUsd, &c.OriginalAt,
		); err != nil {
			h.logger().Warn("rehearse scan failed", zap.Error(err))
			continue
		}
		c.OriginalScore = score
		out.Cases = append(out.Cases, c)
	}
	out.Count = len(out.Cases)
	if out.Count == 0 {
		out.Reason = "no failed runs or low-score feedback in window"
	}

	writeJSON(w, http.StatusOK, out)
}

// parseWindow accepts "1h", "7d", "30d", etc. Returns the duration.
func parseWindow(s string) (time.Duration, error) {
	if len(s) < 2 {
		return 0, &windowError{s: s}
	}
	unit := s[len(s)-1]
	num, err := strconv.Atoi(s[:len(s)-1])
	if err != nil || num <= 0 {
		return 0, &windowError{s: s}
	}
	switch unit {
	case 'h':
		return time.Duration(num) * time.Hour, nil
	case 'd':
		return time.Duration(num) * 24 * time.Hour, nil
	case 'w':
		return time.Duration(num) * 7 * 24 * time.Hour, nil
	default:
		return 0, &windowError{s: s}
	}
}

type windowError struct{ s string }

func (e *windowError) Error() string {
	return "invalid window " + e.s + " (use e.g. 1h, 7d, 4w)"
}
