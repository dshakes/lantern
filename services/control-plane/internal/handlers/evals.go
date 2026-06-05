package handlers

// Eval suites, runs, and baselines — the foundation for "lantern test --against=last-green".
//
// An eval suite is a set of test cases (input -> expected) defined per agent.
// An eval run executes the suite against a specific agent version/commit and
// records a pass/fail + score + per-case results.
// A baseline is the last-known-good eval run pinned to a branch. Future runs
// can be compared against it to detect regressions — this is what CI consumes.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type EvalHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewEvalHandler(srv *server.Server, auth *AuthHandler) *EvalHandler {
	return &EvalHandler{srv: srv, auth: auth}
}

func (h *EvalHandler) logger() *zap.Logger { return h.srv.Logger.Named("evals") }

// ---------- DTOs ----------

type evalCase struct {
	Name     string         `json:"name"`
	Input    string         `json:"input"`
	Expected string         `json:"expected,omitempty"`
	Assert   map[string]any `json:"assert,omitempty"` // e.g. {"contains":"foo", "minLen":10}
	Weight   float64        `json:"weight,omitempty"`
}

type evalSuiteDTO struct {
	ID          string     `json:"id"`
	AgentName   string     `json:"agentName"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Cases       []evalCase `json:"cases"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type evalCaseResult struct {
	Name      string  `json:"name"`
	Passed    bool    `json:"passed"`
	Score     float64 `json:"score"`
	Actual    string  `json:"actual,omitempty"`
	Expected  string  `json:"expected,omitempty"`
	Error     string  `json:"error,omitempty"`
	LatencyMs int64   `json:"latencyMs,omitempty"`
	CostUsd   float64 `json:"costUsd,omitempty"`
}

type evalRunDTO struct {
	ID            string           `json:"id"`
	SuiteID       string           `json:"suiteId"`
	AgentName     string           `json:"agentName"`
	AgentVersion  string           `json:"agentVersion,omitempty"`
	CommitSha     string           `json:"commitSha,omitempty"`
	Branch        string           `json:"branch,omitempty"`
	Passed        bool             `json:"passed"`
	Score         float64          `json:"score"`
	CasesTotal    int              `json:"casesTotal"`
	CasesPassed   int              `json:"casesPassed"`
	CaseResults   []evalCaseResult `json:"caseResults,omitempty"`
	DurationMs    int64            `json:"durationMs"`
	TotalCostUsd  float64          `json:"totalCostUsd"`
	CreatedAt     time.Time        `json:"createdAt"`
	BaselineScore *float64         `json:"baselineScore,omitempty"`
	Regressed     bool             `json:"regressed"`
}

// ---------- suites ----------

// UpsertSuite handles POST /v1/eval-suites.
func (h *EvalHandler) UpsertSuite(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body evalSuiteDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AgentName == "" || body.Name == "" || len(body.Cases) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName, name, and cases required"})
		return
	}
	casesJSON, _ := json.Marshal(body.Cases)
	var id string
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO eval_suites (tenant_id, agent_name, name, description, cases)
		VALUES ($1, $2, $3, $4, $5::jsonb)
		ON CONFLICT (tenant_id, agent_name, name) DO UPDATE SET
		  description = EXCLUDED.description,
		  cases       = EXCLUDED.cases,
		  updated_at  = now()
		RETURNING id
	`, tenantID, body.AgentName, body.Name, body.Description, casesJSON).Scan(&id)
	if err != nil {
		h.logger().Error("upsert suite failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// ListSuites handles GET /v1/eval-suites.
func (h *EvalHandler) ListSuites(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.URL.Query().Get("agentName")
	sql := `SELECT id, agent_name, name, COALESCE(description,''), cases, created_at, updated_at FROM eval_suites WHERE tenant_id = $1`
	args := []any{tenantID}
	if agentName != "" {
		sql += ` AND agent_name = $2`
		args = append(args, agentName)
	}
	sql += ` ORDER BY updated_at DESC`
	rows, err := h.srv.Pool.Query(ctx, sql, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	defer rows.Close()
	out := make([]evalSuiteDTO, 0)
	for rows.Next() {
		var s evalSuiteDTO
		var casesJSON []byte
		if err := rows.Scan(&s.ID, &s.AgentName, &s.Name, &s.Description, &casesJSON, &s.CreatedAt, &s.UpdatedAt); err != nil {
			continue
		}
		_ = json.Unmarshal(casesJSON, &s.Cases)
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, out)
}

// GetSuite handles GET /v1/eval-suites/{id}.
func (h *EvalHandler) GetSuite(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	var s evalSuiteDTO
	var casesJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, agent_name, name, COALESCE(description,''), cases, created_at, updated_at
		FROM eval_suites WHERE id = $1 AND tenant_id = $2
	`, id, tenantID).Scan(&s.ID, &s.AgentName, &s.Name, &s.Description, &casesJSON, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	_ = json.Unmarshal(casesJSON, &s.Cases)
	writeJSON(w, http.StatusOK, s)
}

// DeleteSuite handles DELETE /v1/eval-suites/{id}.
func (h *EvalHandler) DeleteSuite(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	_, err = h.srv.Pool.Exec(ctx, `DELETE FROM eval_suites WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ---------- runs ----------

type recordRunRequest struct {
	SuiteID      string           `json:"suiteId"`
	AgentVersion string           `json:"agentVersion,omitempty"`
	CommitSha    string           `json:"commitSha,omitempty"`
	Branch       string           `json:"branch,omitempty"`
	DurationMs   int64            `json:"durationMs"`
	TotalCostUsd float64          `json:"totalCostUsd"`
	CaseResults  []evalCaseResult `json:"caseResults"`
}

// RecordRun handles POST /v1/eval-runs.
// The CLI/CI runs the suite locally (or against a deployed agent) and POSTs
// the results here. The server stores + scores them and compares to the
// branch baseline, returning regression info.
func (h *EvalHandler) RecordRun(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body recordRunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.SuiteID == "" || len(body.CaseResults) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "suiteId and caseResults required"})
		return
	}
	// Pull the agent_name for the suite.
	var agentName string
	err = h.srv.Pool.QueryRow(ctx,
		`SELECT agent_name FROM eval_suites WHERE id = $1 AND tenant_id = $2`,
		body.SuiteID, tenantID).Scan(&agentName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "suite not found"})
		return
	}

	passed := 0
	totalScore := 0.0
	for _, c := range body.CaseResults {
		if c.Passed {
			passed++
		}
		totalScore += c.Score
	}
	total := len(body.CaseResults)
	score := 0.0
	if total > 0 {
		score = totalScore / float64(total)
	}
	allPassed := passed == total

	caseResultsJSON, _ := json.Marshal(body.CaseResults)
	var id string
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO eval_runs
		  (tenant_id, suite_id, agent_name, agent_version, commit_sha, branch, passed, score,
		   cases_total, cases_passed, cases_result, duration_ms, total_cost_usd)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
		RETURNING id
	`, tenantID, body.SuiteID, agentName, body.AgentVersion, body.CommitSha, body.Branch,
		allPassed, score, total, passed, caseResultsJSON, body.DurationMs, body.TotalCostUsd).Scan(&id)
	if err != nil {
		h.logger().Error("record eval run failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed: " + err.Error()})
		return
	}

	// Compare against the branch baseline if one is set.
	baselineScore, regressed := compareToBaseline(ctx, h.srv.Pool, tenantID, agentName, body.Branch, score)

	resp := map[string]any{
		"id":            id,
		"passed":        allPassed,
		"score":         score,
		"casesTotal":    total,
		"casesPassed":   passed,
		"regressed":     regressed,
		"baselineScore": baselineScore,
	}
	status := http.StatusOK
	if regressed {
		status = http.StatusUnprocessableEntity // 422 — signals CI failure
	}
	writeJSON(w, status, resp)
}

// ListRuns handles GET /v1/eval-runs.
func (h *EvalHandler) ListRuns(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	suiteID := r.URL.Query().Get("suiteId")
	agentName := r.URL.Query().Get("agentName")
	branch := r.URL.Query().Get("branch")

	sql := `SELECT id, suite_id, agent_name, COALESCE(agent_version,''), COALESCE(commit_sha,''),
	         COALESCE(branch,''), passed, score, cases_total, cases_passed, duration_ms, total_cost_usd, created_at
	        FROM eval_runs WHERE tenant_id = $1`
	args := []any{tenantID}
	idx := 2
	if suiteID != "" {
		sql += fmt.Sprintf(" AND suite_id = $%d", idx)
		args = append(args, suiteID)
		idx++
	}
	if agentName != "" {
		sql += fmt.Sprintf(" AND agent_name = $%d", idx)
		args = append(args, agentName)
		idx++
	}
	if branch != "" {
		sql += fmt.Sprintf(" AND branch = $%d", idx)
		args = append(args, branch)
		idx++
	}
	sql += " ORDER BY created_at DESC LIMIT 100"

	rows, err := h.srv.Pool.Query(ctx, sql, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	defer rows.Close()
	out := make([]evalRunDTO, 0)
	for rows.Next() {
		var dto evalRunDTO
		if err := rows.Scan(&dto.ID, &dto.SuiteID, &dto.AgentName, &dto.AgentVersion,
			&dto.CommitSha, &dto.Branch, &dto.Passed, &dto.Score, &dto.CasesTotal,
			&dto.CasesPassed, &dto.DurationMs, &dto.TotalCostUsd, &dto.CreatedAt); err != nil {
			continue
		}
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, out)
}

// GetRun handles GET /v1/eval-runs/{id}.
func (h *EvalHandler) GetRun(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	var dto evalRunDTO
	var caseResultsJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, suite_id, agent_name, COALESCE(agent_version,''), COALESCE(commit_sha,''),
		       COALESCE(branch,''), passed, score, cases_total, cases_passed, cases_result,
		       duration_ms, total_cost_usd, created_at
		FROM eval_runs WHERE id = $1 AND tenant_id = $2
	`, id, tenantID).Scan(&dto.ID, &dto.SuiteID, &dto.AgentName, &dto.AgentVersion,
		&dto.CommitSha, &dto.Branch, &dto.Passed, &dto.Score, &dto.CasesTotal,
		&dto.CasesPassed, &caseResultsJSON, &dto.DurationMs, &dto.TotalCostUsd, &dto.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	_ = json.Unmarshal(caseResultsJSON, &dto.CaseResults)
	writeJSON(w, http.StatusOK, dto)
}

// ---------- baselines ----------

type setBaselineRequest struct {
	AgentName string `json:"agentName"`
	Branch    string `json:"branch"`
	EvalRunID string `json:"evalRunId"`
}

// SetBaseline handles POST /v1/eval-baselines.
func (h *EvalHandler) SetBaseline(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body setBaselineRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AgentName == "" || body.Branch == "" || body.EvalRunID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName, branch, evalRunId required"})
		return
	}
	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO eval_baselines (tenant_id, agent_name, branch, eval_run_id)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (tenant_id, agent_name, branch) DO UPDATE SET
		  eval_run_id = EXCLUDED.eval_run_id,
		  set_at      = now()
	`, tenantID, body.AgentName, body.Branch, body.EvalRunID)
	if err != nil {
		h.logger().Error("set baseline failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "baseline set"})
}

// GetBaseline handles GET /v1/eval-baselines?agentName=&branch=.
func (h *EvalHandler) GetBaseline(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.URL.Query().Get("agentName")
	branch := r.URL.Query().Get("branch")
	if agentName == "" || branch == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName and branch required"})
		return
	}
	var runID string
	var score float64
	var setAt time.Time
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT b.eval_run_id, r.score, b.set_at
		FROM eval_baselines b
		JOIN eval_runs r ON r.id = b.eval_run_id
		WHERE b.tenant_id = $1 AND b.agent_name = $2 AND b.branch = $3
	`, tenantID, agentName, branch).Scan(&runID, &score, &setAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no baseline"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"agentName": agentName,
		"branch":    branch,
		"evalRunId": runID,
		"score":     score,
		"setAt":     setAt,
	})
}

// compareToBaseline returns the baseline score (if any) and whether the given
// score represents a regression. Regression = score is > 1% worse than baseline.
func compareToBaseline(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, branch string, score float64) (*float64, bool) {
	if branch == "" {
		return nil, false
	}
	var baseline float64
	err := pool.QueryRow(ctx, `
		SELECT r.score FROM eval_baselines b
		JOIN eval_runs r ON r.id = b.eval_run_id
		WHERE b.tenant_id = $1 AND b.agent_name = $2 AND b.branch = $3
	`, tenantID, agentName, branch).Scan(&baseline)
	if err != nil {
		return nil, false
	}
	regressed := score+0.01 < baseline && math.Abs(baseline-score) > 0.01
	return &baseline, regressed
}
