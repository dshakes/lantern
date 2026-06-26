package handlers

// A/B experiments — deterministic traffic splitting between two agent
// versions, with score-based conclusion and optional auto-promotion.
//
// Workflow:
//   1. POST /v1/experiments starts an experiment.
//   2. The runtime calls PickVariant(...) on every run to decide which
//      version to execute. The decision is sticky on run_id hash so repeated
//      calls for the same run return the same variant.
//   3. After each run completes, POST /v1/experiments/{id}/record updates
//      running counts + per-variant score.
//   4. POST /v1/experiments/{id}/conclude picks a winner and (if
//      auto_promote) flips agents.current_version_id to the winning version.

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type ExperimentHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewExperimentHandler(srv *server.Server, auth *AuthHandler) *ExperimentHandler {
	return &ExperimentHandler{srv: srv, auth: auth}
}

func (h *ExperimentHandler) logger() *zap.Logger { return h.srv.Logger.Named("experiments") }

// ---------- DTOs ----------

type experimentDTO struct {
	ID               string     `json:"id"`
	AgentName        string     `json:"agentName"`
	Name             string     `json:"name"`
	VariantAVersion  string     `json:"variantAVersion"`
	VariantBVersion  string     `json:"variantBVersion"`
	TrafficSplitB    int        `json:"trafficSplitB"`
	EvalSuiteID      string     `json:"evalSuiteId,omitempty"`
	AutoPromote      bool       `json:"autoPromote"`
	MinRunsToPromote int        `json:"minRunsToPromote"`
	Status           string     `json:"status"`
	Winner           string     `json:"winner,omitempty"`
	ARuns            int        `json:"aRuns"`
	BRuns            int        `json:"bRuns"`
	AScore           *float64   `json:"aScore,omitempty"`
	BScore           *float64   `json:"bScore,omitempty"`
	StartedAt        time.Time  `json:"startedAt"`
	ConcludedAt      *time.Time `json:"concludedAt,omitempty"`
}

// Create handles POST /v1/experiments.
func (h *ExperimentHandler) Create(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body experimentDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AgentName == "" || body.Name == "" || body.VariantAVersion == "" || body.VariantBVersion == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName, name, variantAVersion, variantBVersion required"})
		return
	}
	if body.TrafficSplitB < 0 || body.TrafficSplitB > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "trafficSplitB must be 0-100"})
		return
	}
	if body.MinRunsToPromote <= 0 {
		body.MinRunsToPromote = 100
	}
	var evalSuiteID any
	if body.EvalSuiteID != "" {
		evalSuiteID = body.EvalSuiteID
	}
	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO agent_experiments
			  (tenant_id, agent_name, name, variant_a_version, variant_b_version,
			   traffic_split_b, eval_suite_id, auto_promote, min_runs_to_promote)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (tenant_id, agent_name, name) DO UPDATE SET
			  variant_a_version   = EXCLUDED.variant_a_version,
			  variant_b_version   = EXCLUDED.variant_b_version,
			  traffic_split_b     = EXCLUDED.traffic_split_b,
			  eval_suite_id       = EXCLUDED.eval_suite_id,
			  auto_promote        = EXCLUDED.auto_promote,
			  min_runs_to_promote = EXCLUDED.min_runs_to_promote,
			  status              = 'running',
			  started_at          = now(),
			  concluded_at        = NULL,
			  winner              = NULL,
			  a_runs              = 0,
			  b_runs              = 0,
			  a_score             = NULL,
			  b_score             = NULL
			RETURNING id
		`, tenantID, body.AgentName, body.Name, body.VariantAVersion, body.VariantBVersion,
			body.TrafficSplitB, evalSuiteID, body.AutoPromote, body.MinRunsToPromote).Scan(&id)
	})
	if err != nil {
		h.logger().Error("create experiment failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// List handles GET /v1/experiments.
func (h *ExperimentHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.URL.Query().Get("agentName")
	sql := `SELECT id, agent_name, name, variant_a_version, variant_b_version,
	        traffic_split_b, COALESCE(eval_suite_id::text,''), auto_promote, min_runs_to_promote,
	        status, COALESCE(winner,''), a_runs, b_runs, a_score, b_score, started_at, concluded_at
	        FROM agent_experiments WHERE tenant_id = $1`
	args := []any{tenantID}
	if agentName != "" {
		sql += ` AND agent_name = $2`
		args = append(args, agentName)
	}
	sql += ` ORDER BY started_at DESC`
	out := make([]experimentDTO, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, sql, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var dto experimentDTO
			if err := rows.Scan(&dto.ID, &dto.AgentName, &dto.Name, &dto.VariantAVersion,
				&dto.VariantBVersion, &dto.TrafficSplitB, &dto.EvalSuiteID, &dto.AutoPromote,
				&dto.MinRunsToPromote, &dto.Status, &dto.Winner, &dto.ARuns, &dto.BRuns,
				&dto.AScore, &dto.BScore, &dto.StartedAt, &dto.ConcludedAt); err != nil {
				continue
			}
			out = append(out, dto)
		}
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Get handles GET /v1/experiments/{id}.
func (h *ExperimentHandler) Get(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	var dto experimentDTO
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, agent_name, name, variant_a_version, variant_b_version,
			       traffic_split_b, COALESCE(eval_suite_id::text,''), auto_promote, min_runs_to_promote,
			       status, COALESCE(winner,''), a_runs, b_runs, a_score, b_score, started_at, concluded_at
			FROM agent_experiments WHERE id = $1 AND tenant_id = $2
		`, id, tenantID).Scan(&dto.ID, &dto.AgentName, &dto.Name, &dto.VariantAVersion,
			&dto.VariantBVersion, &dto.TrafficSplitB, &dto.EvalSuiteID, &dto.AutoPromote,
			&dto.MinRunsToPromote, &dto.Status, &dto.Winner, &dto.ARuns, &dto.BRuns,
			&dto.AScore, &dto.BScore, &dto.StartedAt, &dto.ConcludedAt)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

type recordVariantRequest struct {
	Variant string  `json:"variant"` // "a" or "b"
	Score   float64 `json:"score"`   // 0..1
}

// RecordOutcome handles POST /v1/experiments/{id}/record.
// Called by the runtime after each experimental run completes with a score.
// The score is a rolling mean over all runs of that variant.
func (h *ExperimentHandler) RecordOutcome(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	var body recordVariantRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Variant != "a" && body.Variant != "b" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "variant must be 'a' or 'b'"})
		return
	}
	countCol, scoreCol := "a_runs", "a_score"
	if body.Variant == "b" {
		countCol, scoreCol = "b_runs", "b_score"
	}
	sql := fmt.Sprintf(`
		UPDATE agent_experiments SET
		  %s = %s + 1,
		  %s = CASE WHEN %s IS NULL THEN $3::numeric
		            ELSE ((%s * %s) + $3::numeric) / (%s + 1)
		       END
		WHERE id = $1 AND tenant_id = $2
	`, countCol, countCol, scoreCol, scoreCol, scoreCol, countCol, countCol)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, sql, id, tenantID, body.Score)
		return e
	})
	if err != nil {
		h.logger().Error("record outcome failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}

	// Check auto-promotion conditions.
	go h.maybeAutoPromote(context.Background(), tenantID, id)

	writeJSON(w, http.StatusOK, map[string]string{"status": "recorded"})
}

// Conclude handles POST /v1/experiments/{id}/conclude.
// Body: { "winner": "a" | "b" | "tie", "promote": bool }
func (h *ExperimentHandler) Conclude(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	var body struct {
		Winner  string `json:"winner"`
		Promote bool   `json:"promote"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Winner != "a" && body.Winner != "b" && body.Winner != "tie" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "winner must be a/b/tie"})
		return
	}
	var agentName, aVer, bVer string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			UPDATE agent_experiments SET status = 'concluded', winner = $3, concluded_at = now()
			WHERE id = $1 AND tenant_id = $2
			RETURNING agent_name, variant_a_version, variant_b_version
		`, id, tenantID, body.Winner).Scan(&agentName, &aVer, &bVer)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if body.Promote && body.Winner != "tie" {
		winVer := aVer
		if body.Winner == "b" {
			winVer = bVer
		}
		// rls-exempt: promoteAgentVersion is a shared helper taking a *Pool and
		// self-scoping by tenantID; reused identically across handlers.
		if err := promoteAgentVersion(ctx, h.srv.Pool, tenantID, agentName, winVer); err != nil {
			h.logger().Error("promote failed", zap.Error(err))
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "concluded", "winner": body.Winner})
}

// ---------- runtime helpers ----------

// PickVariant decides which variant (a or b) a given run_id should execute
// against. The decision is deterministic on run_id — the same run always
// gets the same variant on retry. Returns ("a" or "b", version, experimentID).
// If no experiment is active, returns ("", "", "").
func PickVariant(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, runID string) (string, string, string) {
	var expID, aVer, bVer string
	var splitB int
	err := pool.QueryRow(ctx, `
		SELECT id, variant_a_version, variant_b_version, traffic_split_b
		FROM agent_experiments
		WHERE tenant_id = $1 AND agent_name = $2 AND status = 'running'
		ORDER BY started_at DESC LIMIT 1
	`, tenantID, agentName).Scan(&expID, &aVer, &bVer, &splitB)
	if err != nil {
		return "", "", ""
	}
	// Deterministic hash of run_id into [0,100).
	h := fnv.New32a()
	_, _ = h.Write([]byte(runID))
	bucket := int(h.Sum32() % 100)
	if bucket < splitB {
		return "b", bVer, expID
	}
	return "a", aVer, expID
}

func promoteAgentVersion(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, version string) error {
	_, err := pool.Exec(ctx, `
		UPDATE agents a SET current_version_id = (
		  SELECT av.id FROM agent_versions av
		  WHERE av.agent_id = a.id AND av.version = $3
		  LIMIT 1
		)
		WHERE a.tenant_id = $1 AND a.name = $2
	`, tenantID, agentName, version)
	return err
}

func (h *ExperimentHandler) maybeAutoPromote(ctx context.Context, tenantID, expID string) {
	// Background goroutine (called via `go ...` from RecordOutcome) with a fresh
	// context.Background() and an explicit tenantID — inject it so the WithTenant
	// reads/writes below are RLS-scoped.
	ctx = middleware.InjectTenantID(ctx, tenantID)
	var autoPromote bool
	var minRuns int
	var aRuns, bRuns int
	var aScore, bScore *float64
	var agentName, aVer, bVer string
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT auto_promote, min_runs_to_promote, a_runs, b_runs, a_score, b_score,
			       agent_name, variant_a_version, variant_b_version
			FROM agent_experiments WHERE id = $1 AND tenant_id = $2 AND status = 'running'
		`, expID, tenantID).Scan(&autoPromote, &minRuns, &aRuns, &bRuns, &aScore, &bScore,
			&agentName, &aVer, &bVer)
	})
	if err != nil || !autoPromote {
		return
	}
	if aRuns < minRuns || bRuns < minRuns {
		return
	}
	if aScore == nil || bScore == nil {
		return
	}
	// Require a >2% improvement to auto-promote.
	var winner, winVer string
	switch {
	case *bScore > *aScore+0.02:
		winner, winVer = "b", bVer
	case *aScore > *bScore+0.02:
		winner, winVer = "a", aVer
	default:
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE agent_experiments SET status = 'concluded', winner = $3, concluded_at = now()
			WHERE id = $1 AND tenant_id = $2
		`, expID, tenantID, winner)
		return e
	})
	if err != nil {
		h.logger().Warn("auto-conclude failed", zap.Error(err))
		return
	}
	// rls-exempt: shared promoteAgentVersion helper (takes *Pool, self-scopes by tenantID).
	if err := promoteAgentVersion(ctx, h.srv.Pool, tenantID, agentName, winVer); err != nil {
		h.logger().Warn("auto-promote failed", zap.Error(err))
		return
	}
	h.logger().Info("auto-promoted experiment winner",
		zap.String("experiment", expID), zap.String("winner", winner), zap.String("version", winVer))
}
