// Eval observability — failure clustering + score/pass-rate trends over the
// existing eval_runs history. Read-only, additive: no new tables, no writes.
// Answers the two questions LangSmith-style dashboards make easy and Lantern
// didn't: "which cases keep failing?" and "is quality trending down?".
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// runCases is one eval_run's raw case results plus when it ran — the input to
// the pure clustering/trend functions.
type runCases struct {
	RunID     string
	CreatedAt time.Time
	Cases     []evalCaseResult
}

// FailureCluster groups a recurring failing case across runs so the owner sees
// the worst offenders first instead of scrolling raw run logs.
type FailureCluster struct {
	Case        string    `json:"case"`
	Failures    int       `json:"failures"`    // times this case failed in the window
	Seen        int       `json:"seen"`        // times this case ran (fail + pass)
	FailRate    float64   `json:"failRate"`    // failures / seen, 0..1
	SampleError string    `json:"sampleError"` // most recent non-empty error
	Expected    string    `json:"expected"`    // most recent expected (for triage)
	Actual      string    `json:"actual"`      // most recent actual
	FirstSeen   time.Time `json:"firstSeen"`   // oldest failure in window
	LastSeen    time.Time `json:"lastSeen"`    // newest failure in window
}

// clusterFailures groups failing cases by name across the given runs, ranked by
// failure count then fail-rate. Pure + deterministic (stable sort). Runs may be
// in any order; timestamps come from each run.
func clusterFailures(runs []runCases) []FailureCluster {
	type agg struct {
		fails, seen         int
		sampleErr           string
		expected, actual    string
		firstSeen, lastSeen time.Time
	}
	byCase := map[string]*agg{}
	// Process oldest-first so "SampleError/Actual" ends on the most recent.
	ordered := append([]runCases(nil), runs...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].CreatedAt.Before(ordered[j].CreatedAt) })
	for _, run := range ordered {
		for _, c := range run.Cases {
			a := byCase[c.Name]
			if a == nil {
				a = &agg{}
				byCase[c.Name] = a
			}
			a.seen++
			if c.Passed {
				continue
			}
			a.fails++
			if run.CreatedAt.After(a.lastSeen) {
				a.lastSeen = run.CreatedAt
			}
			if a.firstSeen.IsZero() || run.CreatedAt.Before(a.firstSeen) {
				a.firstSeen = run.CreatedAt
			}
			// Latest non-empty triage detail wins (ordered oldest→newest).
			if c.Error != "" {
				a.sampleErr = c.Error
			}
			if c.Expected != "" {
				a.expected = c.Expected
			}
			if c.Actual != "" {
				a.actual = c.Actual
			}
		}
	}
	out := make([]FailureCluster, 0, len(byCase))
	for name, a := range byCase {
		if a.fails == 0 {
			continue // only clusters that actually failed at least once
		}
		rate := 0.0
		if a.seen > 0 {
			rate = float64(a.fails) / float64(a.seen)
		}
		out = append(out, FailureCluster{
			Case: name, Failures: a.fails, Seen: a.seen, FailRate: rate,
			SampleError: a.sampleErr, Expected: a.expected, Actual: a.actual,
			FirstSeen: a.firstSeen, LastSeen: a.lastSeen,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Failures != out[j].Failures {
			return out[i].Failures > out[j].Failures
		}
		if out[i].FailRate != out[j].FailRate {
			return out[i].FailRate > out[j].FailRate
		}
		return out[i].Case < out[j].Case
	})
	return out
}

// TrendPoint is one run in the score/pass-rate/cost time series.
type TrendPoint struct {
	RunID     string    `json:"runId"`
	CreatedAt time.Time `json:"createdAt"`
	Score     float64   `json:"score"`
	PassRate  float64   `json:"passRate"`
	Passed    bool      `json:"passed"`
	Cost      float64   `json:"costUsd"`
	Version   string    `json:"agentVersion"`
	Commit    string    `json:"commitSha"`
}

// FailuresResponse is the /failures payload.
type FailuresResponse struct {
	Clusters []FailureCluster `json:"clusters"`
	Runs     int              `json:"runsScanned"`
}

// TrendsResponse is the /trends payload with a simple regression signal:
// the latest run's score minus the mean of the prior points.
type TrendsResponse struct {
	Points     []TrendPoint `json:"points"`
	LatestVs   float64      `json:"latestVsMean"` // latest.score - mean(prior); <0 = down
	Regressing bool         `json:"regressing"`
}

func clampLimit(raw string, def, max int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// GetFailureClusters handles GET /v1/eval-observability/failures.
// Query: ?agentName=&branch=&limit= (runs scanned, default 50, max 200).
func (h *EvalHandler) GetFailureClusters(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	limit := clampLimit(r.URL.Query().Get("limit"), 50, 200)
	runs, err := h.recentRunCases(ctx, tenantID, r.URL.Query().Get("agentName"), r.URL.Query().Get("branch"), limit)
	if err != nil {
		h.logger().Error("failure clusters query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, FailuresResponse{Clusters: clusterFailures(runs), Runs: len(runs)})
}

// GetTrends handles GET /v1/eval-observability/trends.
// Query: ?agentName=&branch=&limit= (points, default 30, max 200).
func (h *EvalHandler) GetTrends(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	limit := clampLimit(r.URL.Query().Get("limit"), 30, 200)
	agentName := r.URL.Query().Get("agentName")
	branch := r.URL.Query().Get("branch")

	points := []TrendPoint{}
	sql := `SELECT id, score, cases_total, cases_passed, passed, total_cost_usd,
	               COALESCE(agent_version,''), COALESCE(commit_sha,''), created_at
	        FROM eval_runs WHERE tenant_id = $1`
	args := []any{tenantID}
	if agentName != "" {
		args = append(args, agentName)
		sql += " AND agent_name = $" + strconv.Itoa(len(args))
	}
	if branch != "" {
		args = append(args, branch)
		sql += " AND branch = $" + strconv.Itoa(len(args))
	}
	args = append(args, limit)
	sql += " ORDER BY created_at DESC LIMIT $" + strconv.Itoa(len(args))

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, sql, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var p TrendPoint
			var total, passed int
			if err := rows.Scan(&p.RunID, &p.Score, &total, &passed, &p.Passed, &p.Cost, &p.Version, &p.Commit, &p.CreatedAt); err != nil {
				return err
			}
			if total > 0 {
				p.PassRate = float64(passed) / float64(total)
			}
			points = append(points, p)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("trends query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	// Query is newest-first; return oldest-first for charting.
	for i, j := 0, len(points)-1; i < j; i, j = i+1, j-1 {
		points[i], points[j] = points[j], points[i]
	}
	writeJSON(w, http.StatusOK, computeTrend(points))
}

// computeTrend attaches the regression signal (latest score vs mean of priors).
// Pure + testable.
func computeTrend(points []TrendPoint) TrendsResponse {
	resp := TrendsResponse{Points: points}
	if len(points) >= 2 {
		latest := points[len(points)-1].Score
		var sum float64
		for _, p := range points[:len(points)-1] {
			sum += p.Score
		}
		mean := sum / float64(len(points)-1)
		resp.LatestVs = latest - mean
		resp.Regressing = resp.LatestVs < 0
	}
	return resp
}

// recentRunCases loads cases_result for the most recent runs (tenant-scoped).
func (h *EvalHandler) recentRunCases(ctx context.Context, tenantID, agentName, branch string, limit int) ([]runCases, error) {
	sql := `SELECT id, cases_result, created_at FROM eval_runs WHERE tenant_id = $1`
	args := []any{tenantID}
	if agentName != "" {
		args = append(args, agentName)
		sql += " AND agent_name = $" + strconv.Itoa(len(args))
	}
	if branch != "" {
		args = append(args, branch)
		sql += " AND branch = $" + strconv.Itoa(len(args))
	}
	args = append(args, limit)
	sql += " ORDER BY created_at DESC LIMIT $" + strconv.Itoa(len(args))

	var out []runCases
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, sql, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var rc runCases
			var casesJSON []byte
			if err := rows.Scan(&rc.RunID, &casesJSON, &rc.CreatedAt); err != nil {
				return err
			}
			_ = json.Unmarshal(casesJSON, &rc.Cases) // tolerate legacy/empty rows
			out = append(out, rc)
		}
		return rows.Err()
	})
	return out, err
}
