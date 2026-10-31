package handlers

// observability.go — post-deployment observability (ADR 0056).
//
//	GET  /v1/runs/{id}/trace                    run as a redacted step/LLM/tool/child-run tree
//	GET|PUT /v1/agents/{name}/slo               per-agent SLO targets
//	GET  /v1/agents/{name}/slo/status           attainment, error budget, ADR 0041 burn rates
//	GET|PUT /v1/agents/{name}/prod-evals        sampled production-eval config (+ drift summary on GET)
//	GET  /v1/incidents[?status=&agent=]         incident list
//	GET  /v1/incidents/{id}                     detail + timeline (the audit trail)
//	POST /v1/incidents/{id}/acknowledge|resolve
//	POST /v1/incidents/scan                     run detection now
//
// Detection is deterministic (internal/obs); a model may only WRITE an
// incident's summary, and only text grounded in the linked runs is accepted.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/obs"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// RollbackSuggestion is the interface Phase 6 (canary/rollback) consumes.
// Wiring is a named follow-up: P6 implements RollbackSink (or polls
// GET /v1/incidents and reads `rollback`). Nothing here depends on that code.
type RollbackSuggestion struct {
	Suggested   bool   `json:"suggested"`
	Agent       string `json:"agent,omitempty"`
	FromVersion string `json:"fromVersion,omitempty"`
	ToVersion   string `json:"toVersion,omitempty"`
	Reason      string `json:"reason,omitempty"`
	IncidentID  string `json:"incidentId,omitempty"`
}

// RollbackSink is notified once when a new incident suggests a rollback.
type RollbackSink interface {
	SuggestRollback(ctx context.Context, tenantID string, s RollbackSuggestion) error
}

type ObsHandler struct {
	srv      *server.Server
	auth     *AuthHandler
	complete evalCompleteFn // judge + incident-summary seam; nil → both off
	rollback RollbackSink
	th       obs.Thresholds
	now      func() time.Time
	// recent/baseline windows for anomaly detection.
	recent, baseline time.Duration
}

func NewObsHandler(srv *server.Server, auth *AuthHandler) *ObsHandler {
	return &ObsHandler{srv: srv, auth: auth, th: obs.DefaultThresholds(), now: time.Now,
		recent: envDur("PAL_OBS_RECENT_WINDOW", 2*time.Hour), baseline: envDur("PAL_OBS_BASELINE_WINDOW", 7*24*time.Hour)}
}

func envDur(k string, d time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return d
}

func (h *ObsHandler) SetLLM(llm *LlmProxyHandler) {
	if llm != nil {
		h.complete = llm.evalComplete
	}
}
func (h *ObsHandler) SetRollbackSink(s RollbackSink) { h.rollback = s }
func (h *ObsHandler) logger() *zap.Logger            { return h.srv.Logger.Named("observability") }

func (h *ObsHandler) actor(r *http.Request) (context.Context, string, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", "", err
	}
	who := claims.Email
	if who == "" {
		who = claims.Subject
	}
	if who == "" {
		who = "api-key"
	}
	return middleware.InjectTenantID(r.Context(), claims.TenantID), claims.TenantID, who, nil
}

func unauthorized(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

// ---------------------------------------------------------------- trace tree

const maxTraceDepth = 3
const maxTraceChildren = 25

// GetRunTrace handles GET /v1/runs/{id}/trace. A run in another tenant is a 404
// (no existence leak); journal_events is RLS-exempt, so the run-row ownership
// check below IS the tenant gate.
func (h *ObsHandler) GetRunTrace(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	runID := r.PathValue("id")
	middleware.EnrichSpan(ctx, tenantID, "", runID, "")
	var tr *obs.Trace
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		tr, e = buildRunTrace(ctx, tx, tenantID, runID, 0)
		return e
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
	case err != nil:
		h.logger().Error("trace", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "trace failed"})
	default:
		writeJSON(w, http.StatusOK, tr)
	}
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func buildRunTrace(ctx context.Context, tx pgx.Tx, tenantID, runID string, depth int) (*obs.Trace, error) {
	if !uuidRe.MatchString(runID) {
		return nil, pgx.ErrNoRows
	}
	ri := obs.RunInfo{ID: runID}
	var errRaw []byte
	if err := tx.QueryRow(ctx, `
		SELECT r.status, a.name, COALESCE(v.version,''), r.created_at, r.finished_at,
		       r.cost_usd::float8, r.tokens_in, r.tokens_out, r.error
		FROM runs r JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		LEFT JOIN agent_versions v ON v.id = r.agent_version_id
		WHERE r.id = $1 AND r.tenant_id = $2`, runID, tenantID,
	).Scan(&ri.Status, &ri.AgentName, &ri.AgentVersion, &ri.CreatedAt, &ri.FinishedAt,
		&ri.CostUSD, &ri.TokensIn, &ri.TokensOut, &errRaw); err != nil {
		return nil, err
	}
	if len(errRaw) > 0 {
		var v any
		if json.Unmarshal(errRaw, &v) == nil {
			ri.Error = v
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT seq, kind, COALESCE(step_id,''), attempt, payload, created_at
		FROM journal_events WHERE run_id = $1 ORDER BY seq LIMIT 5000`, runID)
	if err != nil {
		return nil, err
	}
	var evs []obs.Event
	for rows.Next() {
		var e obs.Event
		var raw []byte
		if err := rows.Scan(&e.Seq, &e.Kind, &e.StepID, &e.Attempt, &raw, &e.At); err != nil {
			rows.Close()
			return nil, err
		}
		_ = json.Unmarshal(raw, &e.Payload) // non-JSON payloads simply carry no detail
		evs = append(evs, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var kids []*obs.Trace
	if depth < maxTraceDepth {
		crows, err := tx.Query(ctx, `
			SELECT id::text FROM runs WHERE parent_run_id = $1 AND tenant_id = $2
			ORDER BY created_at LIMIT $3`, runID, tenantID, maxTraceChildren)
		if err != nil {
			return nil, err
		}
		var ids []string
		for crows.Next() {
			var id string
			if crows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		crows.Close()
		for _, id := range ids {
			if c, err := buildRunTrace(ctx, tx, tenantID, id, depth+1); err == nil {
				kids = append(kids, c)
			}
		}
	}
	return obs.BuildTrace(ri, evs, kids), nil
}

// ------------------------------------------------------------------ run stats

// loadStats reads finished runs of one agent in [from,to), newest first,
// capped (ponytail: 20k-run ceiling per window; push to SQL aggregates beyond).
func loadStats(ctx context.Context, tx pgx.Tx, tenantID, agent string, from, to time.Time) ([]obs.RunStat, error) {
	rows, err := tx.Query(ctx, `
		SELECT r.id::text, COALESCE(v.version,''), r.created_at, r.cost_usd::float8,
		       COALESCE(EXTRACT(EPOCH FROM (r.finished_at - COALESCE(r.started_at, r.created_at))) * 1000, 0)::float8,
		       (SELECT COUNT(*) FROM journal_events j WHERE j.run_id = r.id AND j.kind = 'tool_call')::float8,
		       r.status = 'failed', s.score::float8
		FROM runs r JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		LEFT JOIN agent_versions v ON v.id = r.agent_version_id
		LEFT JOIN prod_eval_scores s ON s.tenant_id = r.tenant_id AND s.run_id = r.id
		WHERE r.tenant_id = $1 AND a.name = $2 AND r.status IN ('succeeded','failed')
		  AND r.created_at >= $3 AND r.created_at < $4
		ORDER BY r.created_at DESC LIMIT 20000`, tenantID, agent, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []obs.RunStat
	for rows.Next() {
		var s obs.RunStat
		var sc *float64
		if err := rows.Scan(&s.ID, &s.Version, &s.At, &s.CostUSD, &s.LatencyMs, &s.ToolCalls, &s.Failed, &sc); err != nil {
			return nil, err
		}
		s.Score = sc
		out = append(out, s)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------------ SLOs

type sloDTO struct {
	Objective  float64  `json:"objective"`
	LatencyMs  *int64   `json:"latencyMs,omitempty"`
	CostUSD    *float64 `json:"costUsd,omitempty"`
	MinScore   *float64 `json:"minScore,omitempty"`
	WindowDays int      `json:"windowDays"`
}

func (d *sloDTO) validate() string {
	switch {
	case d.Objective <= 0 || d.Objective >= 1:
		return "objective must be between 0 and 1 (exclusive)"
	case d.WindowDays < 1 || d.WindowDays > 90:
		return "windowDays must be 1..90"
	case d.LatencyMs != nil && *d.LatencyMs <= 0, d.CostUSD != nil && *d.CostUSD <= 0:
		return "latencyMs and costUsd must be positive"
	case d.MinScore != nil && (*d.MinScore < 0 || *d.MinScore > 1):
		return "minScore must be 0..1"
	}
	return ""
}

func (h *ObsHandler) loadSLO(ctx context.Context, tx pgx.Tx, tenantID, agent string) (*sloDTO, error) {
	d := &sloDTO{}
	err := tx.QueryRow(ctx, `SELECT objective::float8, latency_ms, cost_usd::float8, min_score::float8, window_days
		FROM agent_slos WHERE tenant_id=$1 AND agent_name=$2`, tenantID, agent).
		Scan(&d.Objective, &d.LatencyMs, &d.CostUSD, &d.MinScore, &d.WindowDays)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return d, err
}

func (h *ObsHandler) agentExists(ctx context.Context, tx pgx.Tx, tenantID, agent string) bool {
	var one int
	return tx.QueryRow(ctx, `SELECT 1 FROM agents WHERE tenant_id=$1 AND name=$2`, tenantID, agent).Scan(&one) == nil
}

func (h *ObsHandler) GetSLO(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	var d *sloDTO
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error { var e error; d, e = h.loadSLO(ctx, tx, tenantID, r.PathValue("name")); return e })
	if e != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "load failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slo": d})
}

func (h *ObsHandler) PutSLO(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	d := sloDTO{Objective: 0.95, WindowDays: 28}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&d) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if msg := d.validate(); msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	agent := r.PathValue("name")
	found := false
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if found = h.agentExists(ctx, tx, tenantID, agent); !found {
			return nil
		}
		_, e := tx.Exec(ctx, `INSERT INTO agent_slos (tenant_id, agent_name, objective, latency_ms, cost_usd, min_score, window_days)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (tenant_id, agent_name) DO UPDATE SET objective=EXCLUDED.objective, latency_ms=EXCLUDED.latency_ms,
			  cost_usd=EXCLUDED.cost_usd, min_score=EXCLUDED.min_score, window_days=EXCLUDED.window_days, updated_at=now()`,
			tenantID, agent, d.Objective, d.LatencyMs, d.CostUSD, d.MinScore, d.WindowDays)
		return e
	})
	switch {
	case e != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save failed"})
	case !found:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"slo": d})
	}
}

type sliStatus struct {
	Name            string      `json:"name"`
	Target          string      `json:"target"`
	Good            int         `json:"good"`
	Total           int         `json:"total"`
	Attainment      float64     `json:"attainment"`
	BudgetRemaining float64     `json:"budgetRemaining"`
	BurnRates       []burnRate  `json:"burnRates"`
	Alerts          []obs.Alert `json:"alerts"`
	Measured        float64     `json:"measured,omitempty"`
	MeasuredLabel   string      `json:"measuredLabel,omitempty"`
	badIDs          []string
}
type burnRate struct {
	Window string  `json:"window"`
	Burn   float64 `json:"burn"`
	Events int     `json:"events"`
}

// sliSpecs maps an SLO to its good/bad event definitions. Every SLI is an
// event ratio against the SAME objective, so one burn-rate machinery serves
// success, latency, cost and quality (ADR 0041 windows).
func sliSpecs(d *sloDTO) []struct {
	name, target string
	applies      func(obs.RunStat) bool
	bad          func(obs.RunStat) bool
} {
	type spec = struct {
		name, target string
		applies      func(obs.RunStat) bool
		bad          func(obs.RunStat) bool
	}
	all := func(obs.RunStat) bool { return true }
	out := []spec{{"success", fmt.Sprintf("%.1f%% of runs succeed", d.Objective*100), all, func(s obs.RunStat) bool { return s.Failed }}}
	if d.LatencyMs != nil {
		lim := float64(*d.LatencyMs)
		out = append(out, spec{"latency", fmt.Sprintf("%.1f%% of runs under %dms", d.Objective*100, *d.LatencyMs),
			func(s obs.RunStat) bool { return !s.Failed }, func(s obs.RunStat) bool { return s.LatencyMs > lim }})
	}
	if d.CostUSD != nil {
		lim := *d.CostUSD
		out = append(out, spec{"cost", fmt.Sprintf("%.1f%% of runs cost under $%.4f", d.Objective*100, lim),
			all, func(s obs.RunStat) bool { return s.CostUSD > lim }})
	}
	if d.MinScore != nil {
		lim := *d.MinScore
		out = append(out, spec{"score", fmt.Sprintf("%.1f%% of scored runs score at least %.2f", d.Objective*100, lim),
			func(s obs.RunStat) bool { return s.Score != nil }, func(s obs.RunStat) bool { return *s.Score < lim }})
	}
	return out
}

func p95(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sort.Float64s(xs)
	return xs[int(math.Ceil(0.95*float64(len(xs))))-1]
}

// evalSLO computes status from run stats (newest first) at time now.
func evalSLO(d *sloDTO, stats []obs.RunStat, now time.Time, minEvents int) []sliStatus {
	var out []sliStatus
	for _, sp := range sliSpecs(d) {
		st := sliStatus{Name: sp.name, Target: sp.target, Alerts: []obs.Alert{}, BurnRates: []burnRate{}}
		count := func(since time.Duration) obs.Counts {
			var c obs.Counts
			for _, s := range stats {
				if now.Sub(s.At) > since || !sp.applies(s) {
					continue
				}
				c.Total++
				if sp.bad(s) {
					c.Bad++
				}
			}
			return c
		}
		full := count(time.Duration(d.WindowDays) * 24 * time.Hour)
		st.Total, st.Good = full.Total, full.Total-full.Bad
		st.Attainment, st.BudgetRemaining = 1, 1
		if full.Total > 0 {
			st.Attainment = float64(st.Good) / float64(full.Total)
			st.BudgetRemaining = obs.BudgetRemaining(full, d.Objective)
		}
		long, short := map[time.Duration]obs.Counts{}, map[time.Duration]obs.Counts{}
		for _, win := range obs.Windows {
			long[win.Long], short[win.Short] = count(win.Long), count(win.Short)
			st.BurnRates = append(st.BurnRates, burnRate{win.Long.String(), obs.BurnRate(long[win.Long], d.Objective), long[win.Long].Total})
		}
		st.Alerts = obs.Fire(long, short, d.Objective, minEvents)
		if st.Alerts == nil {
			st.Alerts = []obs.Alert{}
		}
		longest := time.Duration(d.WindowDays) * 24 * time.Hour
		for _, s := range stats {
			if now.Sub(s.At) <= longest && sp.applies(s) && sp.bad(s) && len(st.badIDs) < 100 {
				st.badIDs = append(st.badIDs, s.ID)
			}
		}
		switch sp.name {
		case "latency":
			var xs []float64
			for _, s := range stats {
				if sp.applies(s) && now.Sub(s.At) <= longest {
					xs = append(xs, s.LatencyMs)
				}
			}
			st.Measured, st.MeasuredLabel = p95(xs), "p95 latency ms"
		case "cost":
			var sum float64
			n := 0
			for _, s := range stats {
				if now.Sub(s.At) <= longest {
					sum += s.CostUSD
					n++
				}
			}
			if n > 0 {
				st.Measured, st.MeasuredLabel = sum/float64(n), "mean cost per run USD"
			}
		}
		out = append(out, st)
	}
	return out
}

func (h *ObsHandler) GetSLOStatus(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	agent := r.PathValue("name")
	var d *sloDTO
	var slis []sliStatus
	now := h.now()
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		if d, e = h.loadSLO(ctx, tx, tenantID, agent); e != nil || d == nil {
			return e
		}
		stats, e := loadStats(ctx, tx, tenantID, agent, now.AddDate(0, 0, -d.WindowDays), now.Add(time.Minute))
		slis = evalSLO(d, stats, now, 20)
		return e
	})
	switch {
	case e != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status failed"})
	case d == nil:
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"configured": true, "slo": d, "slis": slis})
	}
}

// ------------------------------------------------------------ production evals

type prodEvalDTO struct {
	Enabled        bool    `json:"enabled"`
	SampleRate     float64 `json:"sampleRate"`
	Rubric         string  `json:"rubric"`
	JudgeModel     string  `json:"judgeModel,omitempty"`
	DailyBudgetUSD float64 `json:"dailyBudgetUsd"`
}

type versionDrift struct {
	Version     string   `json:"version"`
	N           int      `json:"n"`
	MeanScore   float64  `json:"meanScore"`
	PassRate    float64  `json:"passRate"`
	DeltaVsPrev *float64 `json:"deltaVsPrev,omitempty"`
	Drifted     bool     `json:"drifted"`
}

// sampled is the deterministic sampling decision: a stable hash of the run id
// mapped to [0,1). Reproducible, no RNG state, and rate 0 never samples.
func sampled(runID string, rate float64) bool {
	if rate <= 0 {
		return false
	}
	f := fnv.New32a()
	_, _ = f.Write([]byte(runID))
	return float64(f.Sum32())/float64(math.MaxUint32) < rate
}

// driftByVersion orders versions by when their first scored run was created and flags a version whose
// mean fell vs the previous one by at least 0.05 AND 2 standard errors.
func driftByVersion(rows []struct {
	Version string
	Score   float64
	Passed  bool
	At      time.Time
}) []versionDrift {
	type agg struct {
		first time.Time
		xs    []float64
		pass  int
	}
	m := map[string]*agg{}
	for _, r := range rows {
		a := m[r.Version]
		if a == nil {
			a = &agg{first: r.At}
			m[r.Version] = a
		}
		if r.At.Before(a.first) {
			a.first = r.At
		}
		a.xs = append(a.xs, r.Score)
		if r.Passed {
			a.pass++
		}
	}
	vs := make([]string, 0, len(m))
	for v := range m {
		vs = append(vs, v)
	}
	sort.Slice(vs, func(i, j int) bool { return m[vs[i]].first.Before(m[vs[j]].first) })
	mean := func(xs []float64) (float64, float64) {
		var s float64
		for _, x := range xs {
			s += x
		}
		mu := s / float64(len(xs))
		var v float64
		for _, x := range xs {
			v += (x - mu) * (x - mu)
		}
		if len(xs) > 1 {
			v /= float64(len(xs) - 1)
		}
		return mu, v
	}
	out := []versionDrift{}
	var prevMu, prevVar float64
	var prevN int
	for i, v := range vs {
		a := m[v]
		mu, va := mean(a.xs)
		d := versionDrift{Version: v, N: len(a.xs), MeanScore: mu, PassRate: float64(a.pass) / float64(len(a.xs))}
		if i > 0 {
			delta := mu - prevMu
			d.DeltaVsPrev = &delta
			se := math.Sqrt(va/float64(len(a.xs)) + prevVar/float64(prevN))
			d.Drifted = len(a.xs) >= 5 && prevN >= 5 && -delta >= 0.05 && -delta >= 2*se
		}
		prevMu, prevVar, prevN = mu, va, len(a.xs)
		out = append(out, d)
	}
	return out
}

func (h *ObsHandler) GetProdEvals(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	agent := r.PathValue("name")
	cfg := prodEvalDTO{SampleRate: 0.05, DailyBudgetUSD: 1}
	var versions []versionDrift
	var spent float64
	var scored int
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT enabled, sample_rate::float8, rubric, judge_model, daily_budget_usd::float8
			FROM prod_eval_config WHERE tenant_id=$1 AND agent_name=$2`, tenantID, agent).
			Scan(&cfg.Enabled, &cfg.SampleRate, &cfg.Rubric, &cfg.JudgeModel, &cfg.DailyBudgetUSD)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT s.agent_version, s.score::float8, s.passed, r.created_at
			FROM prod_eval_scores s JOIN runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
			WHERE s.tenant_id=$1 AND s.agent_name=$2 AND r.created_at > now() - interval '30 days' ORDER BY r.created_at LIMIT 20000`, tenantID, agent)
		if err != nil {
			return err
		}
		defer rows.Close()
		var rs []struct {
			Version string
			Score   float64
			Passed  bool
			At      time.Time
		}
		for rows.Next() {
			var x struct {
				Version string
				Score   float64
				Passed  bool
				At      time.Time
			}
			if err := rows.Scan(&x.Version, &x.Score, &x.Passed, &x.At); err != nil {
				return err
			}
			rs = append(rs, x)
		}
		scored = len(rs)
		versions = driftByVersion(rs)
		rows.Close()
		return tx.QueryRow(ctx, `SELECT COALESCE(SUM(cost_usd),0)::float8 FROM prod_eval_scores
			WHERE tenant_id=$1 AND agent_name=$2 AND created_at >= date_trunc('day', now())`, tenantID, agent).Scan(&spent)
	})
	if e != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "load failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "versions": versions, "scored": scored, "spentTodayUsd": spent})
}

func (h *ObsHandler) PutProdEvals(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	c := prodEvalDTO{SampleRate: 0.05, DailyBudgetUSD: 1}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&c) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if c.SampleRate < 0 || c.SampleRate > 1 || c.DailyBudgetUSD < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sampleRate must be 0..1 and dailyBudgetUsd >= 0"})
		return
	}
	if err := validJudgeModel(c.JudgeModel); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if c.Enabled && strings.TrimSpace(c.Rubric) == "" {
		c.Rubric = defaultCalibrationRubric
	}
	agent := r.PathValue("name")
	found := false
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if found = h.agentExists(ctx, tx, tenantID, agent); !found {
			return nil
		}
		_, e := tx.Exec(ctx, `INSERT INTO prod_eval_config (tenant_id, agent_name, enabled, sample_rate, rubric, judge_model, daily_budget_usd)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (tenant_id, agent_name) DO UPDATE SET enabled=EXCLUDED.enabled, sample_rate=EXCLUDED.sample_rate,
			  rubric=EXCLUDED.rubric, judge_model=EXCLUDED.judge_model, daily_budget_usd=EXCLUDED.daily_budget_usd, updated_at=now()`,
			tenantID, agent, c.Enabled, c.SampleRate, c.Rubric, c.JudgeModel, c.DailyBudgetUSD)
		return e
	})
	switch {
	case e != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save failed"})
	case !found:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"config": c})
	}
}

// sampleProdEvals scores a deterministic sample of one tenant's recent
// succeeded runs for every opted-in agent, stopping at each agent's daily
// budget. Spend is also recorded against the agent's budget (budget-metered).
// Returns the number of runs scored.
func (h *ObsHandler) sampleProdEvals(ctx context.Context, tenantID string) int {
	if h.complete == nil {
		return 0
	}
	type cfgRow struct {
		agent, rubric, model string
		rate, budget         float64
	}
	var cfgs []cfgRow
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT agent_name, rubric, judge_model, sample_rate::float8, daily_budget_usd::float8
			FROM prod_eval_config WHERE tenant_id=$1 AND enabled AND sample_rate > 0`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c cfgRow
			if rows.Scan(&c.agent, &c.rubric, &c.model, &c.rate, &c.budget) == nil {
				cfgs = append(cfgs, c)
			}
		}
		return rows.Err()
	})
	total := 0
	for _, c := range cfgs {
		total += h.sampleAgent(ctx, tenantID, c.agent, c.rubric, c.model, c.rate, c.budget)
	}
	return total
}

func (h *ObsHandler) sampleAgent(ctx context.Context, tenantID, agent, rubric, model string, rate, budget float64) int {
	type cand struct{ id, version, input, output, producedBy string }
	var cands []cand
	var spent float64
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(cost_usd),0)::float8 FROM prod_eval_scores
			WHERE tenant_id=$1 AND agent_name=$2 AND created_at >= date_trunc('day', now())`, tenantID, agent).Scan(&spent); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT r.id::text, COALESCE(v.version,''),
			       COALESCE(r.input->>'prompt', r.input::text, ''),
			       COALESCE(r.output->>'result', r.output->>'text', r.output::text, ''),
			       COALESCE((SELECT convert_from(j.payload,'UTF8')::jsonb->>'model' FROM journal_events j
			                 WHERE j.run_id = r.id AND j.kind = 'step_completed'
			                   AND j.payload IS NOT NULL ORDER BY j.seq DESC LIMIT 1), '')
			FROM runs r JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
			LEFT JOIN agent_versions v ON v.id = r.agent_version_id
			WHERE r.tenant_id=$1 AND a.name=$2 AND r.status='succeeded' AND r.finished_at > now() - interval '24 hours'
			  AND NOT EXISTS (SELECT 1 FROM prod_eval_scores s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id)
			ORDER BY r.finished_at DESC LIMIT 200`, tenantID, agent)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c cand
			if rows.Scan(&c.id, &c.version, &c.input, &c.output, &c.producedBy) == nil && sampled(c.id, rate) {
				cands = append(cands, c)
			}
		}
		return rows.Err()
	})
	judge := &evalJudge{complete: h.complete, tenantID: tenantID, model: firstNonEmpty(model, defaultJudgeModel())}
	spec := judgeSpec{Rubric: firstNonEmpty(strings.TrimSpace(rubric), defaultCalibrationRubric), Samples: 1}
	n := 0
	for _, c := range cands {
		if spent >= budget || n >= 20 {
			break // daily cap: remaining candidates are left unscored, never "free"
		}
		o := judge.rubric(ctx, "judge", spec, c.input, c.output, "", c.producedBy)
		spent += o.costUsd
		_ = RecordUsageSpend(ctx, h.srv.Pool, tenantID, agent, 0, 0, o.costUsd)
		if o.result.Samples == 0 {
			continue // judge error / injection: no score is better than a wrong one
		}
		err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `INSERT INTO prod_eval_scores (tenant_id, run_id, agent_name, agent_version, score, passed, rationale, judge_model, cost_usd)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
				tenantID, c.id, agent, c.version, o.result.Score, o.result.Passed, obs.RedactString(o.result.Rationale), o.result.Model, o.costUsd)
			return e
		})
		if err == nil {
			n++
		}
	}
	return n
}

// ------------------------------------------------------------------ incidents

type incidentEvent struct {
	At     time.Time `json:"at"`
	Actor  string    `json:"actor"`
	Action string    `json:"action"`
	Detail string    `json:"detail,omitempty"`
}

type incidentDTO struct {
	ID              string             `json:"id"`
	AgentName       string             `json:"agentName"`
	Kind            string             `json:"kind"`
	Severity        string             `json:"severity"`
	Status          string             `json:"status"`
	Title           string             `json:"title"`
	Summary         string             `json:"summary"`
	SummarySource   string             `json:"summarySource"`
	FirstBadVersion string             `json:"firstBadVersion,omitempty"`
	LastGoodVersion string             `json:"lastGoodVersion,omitempty"`
	SuspectedCause  string             `json:"suspectedCause"`
	AffectedRunIDs  []string           `json:"affectedRunIds"`
	Evidence        json.RawMessage    `json:"evidence"`
	Rollback        RollbackSuggestion `json:"rollback"`
	OpenedAt        time.Time          `json:"openedAt"`
	AcknowledgedAt  *time.Time         `json:"acknowledgedAt,omitempty"`
	AcknowledgedBy  string             `json:"acknowledgedBy,omitempty"`
	ResolvedAt      *time.Time         `json:"resolvedAt,omitempty"`
	ResolvedBy      string             `json:"resolvedBy,omitempty"`
	Timeline        []incidentEvent    `json:"timeline,omitempty"`
}

const incidentCols = `id::text, agent_name, kind, severity, status, title, summary, summary_source, first_bad_version,
	last_good_version, suspected_cause, affected_run_ids, evidence, rollback_suggested, opened_at,
	acknowledged_at, COALESCE(acknowledged_by,''), resolved_at, COALESCE(resolved_by,'')`

func scanIncident(row pgx.Row) (*incidentDTO, error) {
	var d incidentDTO
	var affected []byte
	var ev []byte
	if err := row.Scan(&d.ID, &d.AgentName, &d.Kind, &d.Severity, &d.Status, &d.Title, &d.Summary, &d.SummarySource,
		&d.FirstBadVersion, &d.LastGoodVersion, &d.SuspectedCause, &affected, &ev, &d.Rollback.Suggested, &d.OpenedAt,
		&d.AcknowledgedAt, &d.AcknowledgedBy, &d.ResolvedAt, &d.ResolvedBy); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(affected, &d.AffectedRunIDs)
	if d.AffectedRunIDs == nil {
		d.AffectedRunIDs = []string{}
	}
	d.Evidence = ev
	if d.Rollback.Suggested {
		d.Rollback.Agent, d.Rollback.FromVersion, d.Rollback.ToVersion = d.AgentName, d.FirstBadVersion, d.LastGoodVersion
		d.Rollback.Reason, d.Rollback.IncidentID = d.SuspectedCause, d.ID
	}
	return &d, nil
}

func (h *ObsHandler) ListIncidents(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	status, agent := r.URL.Query().Get("status"), r.URL.Query().Get("agent")
	if status != "" && status != "open" && status != "acknowledged" && status != "resolved" && status != "active" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status must be open|acknowledged|resolved|active"})
		return
	}
	out := []incidentDTO{}
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+incidentCols+` FROM agent_incidents
			WHERE tenant_id=$1
			  AND ($2='' OR ($2='active' AND status<>'resolved') OR status=$2)
			  AND ($3='' OR agent_name=$3)
			ORDER BY (status='resolved'), opened_at DESC LIMIT 200`, tenantID, status, agent)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			d, err := scanIncident(rows)
			if err != nil {
				return err
			}
			out = append(out, *d)
		}
		return rows.Err()
	})
	if e != nil {
		h.logger().Error("list incidents", zap.Error(e))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "list failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"incidents": out})
}

func (h *ObsHandler) GetIncident(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	d, e := h.fetchIncident(ctx, tenantID, r.PathValue("id"))
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "incident not found"})
	case e != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "load failed"})
	default:
		writeJSON(w, http.StatusOK, d)
	}
}

func (h *ObsHandler) fetchIncident(ctx context.Context, tenantID, id string) (*incidentDTO, error) {
	if !uuidRe.MatchString(id) {
		return nil, pgx.ErrNoRows
	}
	var d *incidentDTO
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		if d, e = scanIncident(tx.QueryRow(ctx, `SELECT `+incidentCols+` FROM agent_incidents WHERE id=$1 AND tenant_id=$2`, id, tenantID)); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT at, actor, action, detail FROM agent_incident_events
			WHERE incident_id=$1 AND tenant_id=$2 ORDER BY id`, id, tenantID)
		if e != nil {
			return e
		}
		defer rows.Close()
		d.Timeline = []incidentEvent{}
		for rows.Next() {
			var ev incidentEvent
			if e := rows.Scan(&ev.At, &ev.Actor, &ev.Action, &ev.Detail); e != nil {
				return e
			}
			d.Timeline = append(d.Timeline, ev)
		}
		return rows.Err()
	})
	return d, err
}

func (h *ObsHandler) Acknowledge(w http.ResponseWriter, r *http.Request) {
	h.transition(w, r, "acknowledge")
}
func (h *ObsHandler) Resolve(w http.ResponseWriter, r *http.Request) { h.transition(w, r, "resolve") }

// transition moves an incident open→acknowledged or open|acknowledged→resolved
// and appends the audit row in the SAME transaction. A repeat or illegal move
// is 409 and writes nothing.
func (h *ObsHandler) transition(w http.ResponseWriter, r *http.Request, action string) {
	ctx, tenantID, who, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "incident not found"})
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body)
	note := obs.RedactString(strings.TrimSpace(body.Note))
	q := `UPDATE agent_incidents SET status='acknowledged', acknowledged_at=now(), acknowledged_by=$3
	      WHERE id=$1 AND tenant_id=$2 AND status='open'`
	evAction := "acknowledged"
	if action == "resolve" {
		q = `UPDATE agent_incidents SET status='resolved', resolved_at=now(), resolved_by=$3
		     WHERE id=$1 AND tenant_id=$2 AND status IN ('open','acknowledged')`
		evAction = "resolved"
	}
	var changed, exists bool
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, q, id, tenantID, who)
		if e != nil {
			return e
		}
		if changed = tag.RowsAffected() == 1; changed {
			_, e = tx.Exec(ctx, `INSERT INTO agent_incident_events (tenant_id, incident_id, actor, action, detail) VALUES ($1,$2,$3,$4,$5)`,
				tenantID, id, who, evAction, note)
			return e
		}
		return tx.QueryRow(ctx, `SELECT true FROM agent_incidents WHERE id=$1 AND tenant_id=$2`, id, tenantID).Scan(&exists)
	})
	switch {
	case e != nil && !errors.Is(e, pgx.ErrNoRows):
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "update failed"})
	case !changed && !exists:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "incident not found"})
	case !changed:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "incident cannot be " + evAction + " from its current status", "code": "invalid_transition"})
	default:
		d, _ := h.fetchIncident(ctx, tenantID, id)
		writeJSON(w, http.StatusOK, d)
	}
}

// ScanNow handles POST /v1/incidents/scan: runs SLO + anomaly detection (and
// production-eval sampling) for the caller's tenant immediately.
func (h *ObsHandler) ScanNow(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, _, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	opened, scored := h.ScanTenant(ctx, tenantID)
	writeJSON(w, http.StatusOK, map[string]any{"opened": opened, "scored": scored})
}

// ------------------------------------------------------------- scan + incidents

// ScanTenant evaluates every agent that has recent runs. It is idempotent: a
// live incident per (agent, kind) absorbs repeat detections.
func (h *ObsHandler) ScanTenant(ctx context.Context, tenantID string) (opened, scored int) {
	scored = h.sampleProdEvals(ctx, tenantID)
	var agents []string
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT DISTINCT a.name FROM runs r JOIN agents a ON a.id=r.agent_id AND a.tenant_id=r.tenant_id
			WHERE r.tenant_id=$1 AND r.created_at > $2 AND r.status IN ('succeeded','failed') LIMIT 500`, tenantID, h.now().Add(-h.recent))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var n string
			if rows.Scan(&n) == nil {
				agents = append(agents, n)
			}
		}
		return rows.Err()
	})
	for _, a := range agents {
		opened += h.scanAgent(ctx, tenantID, a)
	}
	return opened, scored
}

type candidateIncident struct {
	kind, severity, title, cause, firstBad, lastGood string
	runIDs                                           []string
	evidence                                         map[string]any
}

func (h *ObsHandler) scanAgent(ctx context.Context, tenantID, agent string) int {
	now := h.now()
	var cands []candidateIncident
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		recentFrom := now.Add(-h.recent)
		all, err := loadStats(ctx, tx, tenantID, agent, now.Add(-h.baseline), now.Add(time.Minute))
		if err != nil {
			return err
		}
		var recent, base []obs.RunStat
		for _, s := range all {
			if s.At.Before(recentFrom) {
				base = append(base, s)
			} else {
				recent = append(recent, s)
			}
		}
		cands = append(cands, anomalyCandidates(agent, base, recent, h.th)...)
		d, err := h.loadSLO(ctx, tx, tenantID, agent)
		if err != nil || d == nil {
			return err
		}
		slo, err := loadStats(ctx, tx, tenantID, agent, now.AddDate(0, 0, -d.WindowDays), now.Add(time.Minute))
		if err != nil {
			return err
		}
		for _, s := range evalSLO(d, slo, now, 20) {
			if len(s.Alerts) == 0 {
				continue
			}
			sev := "ticket"
			for _, al := range s.Alerts {
				if al.Severity == "page" {
					sev = "page"
				}
			}
			top := s.Alerts[0]
			cands = append(cands, candidateIncident{
				kind: "slo:" + s.Name, severity: sev,
				title: fmt.Sprintf("%s SLO burning error budget (%s)", s.Name, top.Rule),
				cause: fmt.Sprintf("%s: burn %.1fx over %s, %.0f%% of the %d-day budget left",
					s.Target, top.LongBurn, top.Rule, math.Max(s.BudgetRemaining, 0)*100, d.WindowDays),
				runIDs:   s.badIDs,
				evidence: map[string]any{"sli": s.Name, "alerts": s.Alerts, "burnRates": s.BurnRates, "budgetRemaining": s.BudgetRemaining},
			})
		}
		return nil
	})
	n := 0
	for _, c := range cands {
		if h.openIncident(ctx, tenantID, agent, c) {
			n++
		}
	}
	return n
}

// anomalyCandidates turns Detect findings into one candidate incident per
// metric, attributing the earliest-appearing anomalous version as first-bad.
func anomalyCandidates(agent string, base, recent []obs.RunStat, th obs.Thresholds) []candidateIncident {
	findings := obs.Detect(base, recent, th)
	if len(findings) == 0 {
		return nil
	}
	firstSeen := map[string]time.Time{}
	for _, s := range recent {
		if t, ok := firstSeen[s.Version]; !ok || s.At.Before(t) {
			firstSeen[s.Version] = s.At
		}
	}
	inBase := map[string]bool{}
	for _, s := range base {
		inBase[s.Version] = true
	}
	// last-good: version of the newest baseline run (base is newest-first) that
	// is not itself flagged.
	flagged := map[string]bool{}
	for _, f := range findings {
		flagged[f.Version] = true
	}
	lastGood := ""
	for _, s := range base {
		if !flagged[s.Version] {
			lastGood = s.Version
			break
		}
	}
	byMetric := map[string][]obs.Finding{}
	metrics := []string{}
	for _, f := range findings {
		if _, ok := byMetric[f.Metric]; !ok {
			metrics = append(metrics, f.Metric)
		}
		byMetric[f.Metric] = append(byMetric[f.Metric], f)
	}
	var out []candidateIncident
	for _, m := range metrics {
		fs := byMetric[m]
		sort.SliceStable(fs, func(i, j int) bool { return firstSeen[fs[i].Version].Before(firstSeen[fs[j].Version]) })
		f := fs[0]
		var ids []string
		for _, x := range fs {
			ids = append(ids, x.RunIDs...)
		}
		if len(ids) > 100 {
			ids = ids[:100]
		}
		cause := fmt.Sprintf("version %q first served in this window at %s; %s", f.Version, firstSeen[f.Version].UTC().Format(time.RFC3339), f.Detail)
		if inBase[f.Version] {
			cause = fmt.Sprintf("version %q was already serving before the shift; %s. Suspect a model/provider change, tool dependency or input drift rather than a deploy", f.Version, f.Detail)
		} else if lastGood != "" {
			cause += fmt.Sprintf(" (previous healthy version %q)", lastGood)
		}
		sev := "ticket"
		if m == "error_rate" || m == "score" {
			sev = "page"
		}
		out = append(out, candidateIncident{
			kind: "anomaly:" + m, severity: sev,
			title:    fmt.Sprintf("%s anomaly on %s (version %s)", strings.ReplaceAll(m, "_", " "), agent, f.Version),
			cause:    cause,
			firstBad: f.Version,
			lastGood: map[bool]string{true: "", false: lastGood}[inBase[f.Version]],
			runIDs:   ids,
			evidence: map[string]any{"findings": fs, "baselineRuns": len(base), "recentRuns": len(recent), "thresholds": th},
		})
	}
	return out
}

// openIncident inserts the incident unless a live one for (agent, kind)
// exists. Returns true when a NEW incident was opened.
func (h *ObsHandler) openIncident(ctx context.Context, tenantID, agent string, c candidateIncident) bool {
	if len(c.runIDs) > 100 {
		c.runIDs = c.runIDs[:100]
	}
	ids, _ := json.Marshal(c.runIDs)
	ev, _ := json.Marshal(c.evidence)
	rollback := c.firstBad != "" && c.lastGood != "" && strings.HasPrefix(c.kind, "anomaly:")
	summary := fmt.Sprintf("%s. %d run(s) affected; see the linked traces.", c.cause, len(c.runIDs))
	var id string
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx, `INSERT INTO agent_incidents (tenant_id, agent_name, kind, severity, title, summary, first_bad_version,
			last_good_version, suspected_cause, affected_run_ids, evidence, rollback_suggested)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (tenant_id, agent_name, kind) WHERE status <> 'resolved' DO NOTHING RETURNING id::text`,
			tenantID, agent, c.kind, c.severity, c.title, summary, c.firstBad, c.lastGood, c.cause, ids, ev, rollback).Scan(&id)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO agent_incident_events (tenant_id, incident_id, actor, action, detail) VALUES ($1,$2,'system','opened',$3)`,
			tenantID, id, c.cause)
		return e
	})
	if err != nil { // includes ErrNoRows: a live incident already covers this
		if !errors.Is(err, pgx.ErrNoRows) {
			h.logger().Error("open incident", zap.Error(err))
		}
		return false
	}
	h.logger().Info("incident opened", zap.String("tenant_id", tenantID), zap.String("agent", agent), zap.String("kind", c.kind), zap.String("incident_id", id))
	h.summarize(ctx, tenantID, id, agent, c)
	if rollback && h.rollback != nil {
		if e := h.rollback.SuggestRollback(ctx, tenantID, RollbackSuggestion{Suggested: true, Agent: agent,
			FromVersion: c.firstBad, ToVersion: c.lastGood, Reason: c.cause, IncidentID: id}); e != nil {
			h.logger().Warn("rollback sink", zap.Error(e))
		}
	}
	return true
}

var anyUUIDRe = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

var runRefRe = regexp.MustCompile(`\[run:([0-9a-fA-F-]{36})\]`)

// groundedSummary accepts a model's text only if it cites at least one run
// with [run:<id>], every cited id is one of the incident's affected runs, and
// it mentions no other UUID. Anything else is rejected (caller keeps the
// deterministic summary).
func groundedSummary(text string, affected []string) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 1500 {
		return "", false
	}
	ok := map[string]bool{}
	for _, id := range affected {
		ok[strings.ToLower(id)] = true
	}
	cited := runRefRe.FindAllStringSubmatch(text, -1)
	if len(cited) == 0 {
		return "", false
	}
	for _, m := range cited {
		if !ok[strings.ToLower(m[1])] {
			return "", false
		}
	}
	for _, u := range anyUUIDRe.FindAllString(text, -1) {
		if !ok[strings.ToLower(u)] {
			return "", false
		}
	}
	return obs.RedactString(text), true
}

// summarize asks the model for a short narrative, grounded in the facts and
// run ids it is given. Detection never depends on it.
func (h *ObsHandler) summarize(ctx context.Context, tenantID, incidentID, agent string, c candidateIncident) {
	if h.complete == nil || len(c.runIDs) == 0 || os.Getenv("PAL_OBS_MODEL_SUMMARY") == "0" {
		return
	}
	cite := c.runIDs
	if len(cite) > 5 {
		cite = cite[:5]
	}
	facts, _ := json.Marshal(c.evidence)
	prompt := fmt.Sprintf("Write a 2-3 sentence incident summary for an on-call engineer. Use ONLY the facts below. "+
		"Cite the runs you rely on as [run:<id>] using ONLY these ids: %s. Do not invent causes, versions or ids.\nagent: %s\nkind: %s\nsuspected cause: %s\nevidence: %s",
		strings.Join(cite, ", "), agent, c.kind, c.cause, obs.RedactString(string(facts)))
	msgs := []map[string]any{
		{"role": "system", "content": "You summarize production incidents. You never speculate beyond the supplied facts."},
		{"role": "user", "content": prompt},
	}
	comp, err := h.complete(ctx, tenantID, firstNonEmpty(os.Getenv("PAL_OBS_SUMMARY_MODEL"), "fast"), msgs, nil, nil)
	if err != nil {
		return
	}
	text, ok := groundedSummary(comp.Text, c.runIDs)
	if !ok {
		h.logger().Warn("incident summary rejected: not grounded", zap.String("incident_id", incidentID))
		return
	}
	_ = RecordUsageSpend(ctx, h.srv.Pool, tenantID, agent, 0, 0, comp.CostUsd)
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE agent_incidents SET summary=$3, summary_source='model' WHERE id=$1 AND tenant_id=$2`, incidentID, tenantID, text)
		return e
	})
}

// RunObservabilityLoop scans every tenant with recent runs on an interval
// (PAL_OBS_INTERVAL, default 5m; "0"/"off" disables). Writer-only.
func RunObservabilityLoop(ctx context.Context, h *ObsHandler, interval time.Duration) {
	if v := strings.ToLower(os.Getenv("PAL_OBS_INTERVAL")); v == "0" || v == "off" {
		return
	}
	if interval <= 0 {
		interval = envDur("PAL_OBS_INTERVAL", 5*time.Minute)
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.scanAllTenants(ctx)
			}
		}
	}()
}

func (h *ObsHandler) scanAllTenants(ctx context.Context) {
	// rls-exempt: background sweep with no request tenant; it only lists tenant ids,
	// every read/write after this is scoped via WithTenant.
	rows, err := h.srv.Pool.Query(ctx, `SELECT DISTINCT tenant_id::text FROM runs WHERE created_at > $1`, h.now().Add(-h.recent))
	if err != nil {
		h.logger().Warn("observability tenant list", zap.Error(err))
		return
	}
	var tenants []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			tenants = append(tenants, t)
		}
	}
	rows.Close()
	for _, t := range tenants {
		h.ScanTenant(middleware.InjectTenantID(ctx, t), t)
	}
}
