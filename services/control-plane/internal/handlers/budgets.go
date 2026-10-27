package handlers

// Policy-as-code per-agent budgets.
//
// A budget is a tenant-scoped, agent-scoped set of declarative limits:
//   - max_cost_usd_per_day
//   - max_cost_usd_per_run
//   - max_tokens_per_day
//   - max_runs_per_day
//   - tool_limits (e.g. {"slack.post": 100, "github.create_issue": 25} per day)
//   - hard_fail (block vs. warn)
//   - notify_at_pct (alert threshold)
//
// CheckBudget is the single hot-path entry point for the step-executor and
// run-creator to ask: may this agent do this thing right now?

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// BudgetHandler exposes CRUD + enforcement for agent budgets.
type BudgetHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewBudgetHandler creates a new budget handler.
func NewBudgetHandler(srv *server.Server, auth *AuthHandler) *BudgetHandler {
	return &BudgetHandler{srv: srv, auth: auth}
}

func (h *BudgetHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("budgets")
}

// ---------- DTOs ----------

type budgetDTO struct {
	AgentName        string         `json:"agentName"`
	MaxCostUsdPerDay *float64       `json:"maxCostUsdPerDay,omitempty"`
	MaxCostUsdPerRun *float64       `json:"maxCostUsdPerRun,omitempty"`
	MaxTokensPerDay  *int64         `json:"maxTokensPerDay,omitempty"`
	MaxRunsPerDay    *int           `json:"maxRunsPerDay,omitempty"`
	ToolLimits       map[string]int `json:"toolLimits,omitempty"`
	HardFail         bool           `json:"hardFail"`
	NotifyAtPct      int            `json:"notifyAtPct"`
	UpdatedAt        time.Time      `json:"updatedAt,omitempty"`
}

// ---------- REST endpoints ----------

// UpsertBudget handles PUT /v1/agents/{name}/budget.
func (h *BudgetHandler) UpsertBudget(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName, ok := budgetAgentName(w, r)
	if !ok {
		return
	}

	var body budgetDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.NotifyAtPct <= 0 || body.NotifyAtPct > 100 {
		body.NotifyAtPct = 80
	}
	toolLimitsJSON, _ := json.Marshal(body.ToolLimits)
	if len(toolLimitsJSON) == 0 {
		toolLimitsJSON = []byte("{}")
	}

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO agent_budgets
			  (tenant_id, agent_name, max_cost_usd_per_day, max_cost_usd_per_run,
			   max_tokens_per_day, max_runs_per_day, tool_limits, hard_fail, notify_at_pct)
			VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
			ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
			  max_cost_usd_per_day = EXCLUDED.max_cost_usd_per_day,
			  max_cost_usd_per_run = EXCLUDED.max_cost_usd_per_run,
			  max_tokens_per_day   = EXCLUDED.max_tokens_per_day,
			  max_runs_per_day     = EXCLUDED.max_runs_per_day,
			  tool_limits          = EXCLUDED.tool_limits,
			  hard_fail            = EXCLUDED.hard_fail,
			  notify_at_pct        = EXCLUDED.notify_at_pct,
			  updated_at           = now()
		`, tenantID, agentName, body.MaxCostUsdPerDay, body.MaxCostUsdPerRun,
			body.MaxTokensPerDay, body.MaxRunsPerDay, toolLimitsJSON, body.HardFail, body.NotifyAtPct)
		return e
	})
	if err != nil {
		h.logger().Error("upsert budget failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save budget"})
		return
	}
	h.logger().Info("budget saved", zap.String("agent", agentName), zap.Bool("hardFail", body.HardFail))
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// GetBudget handles GET /v1/agents/{name}/budget.
func (h *BudgetHandler) GetBudget(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName, ok := budgetAgentName(w, r)
	if !ok {
		return
	}

	var dto budgetDTO
	dto.AgentName = agentName
	var toolLimitsJSON []byte
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT max_cost_usd_per_day, max_cost_usd_per_run, max_tokens_per_day,
			       max_runs_per_day, tool_limits, hard_fail, notify_at_pct, updated_at
			FROM agent_budgets
			WHERE tenant_id = $1 AND agent_name = $2
		`, tenantID, agentName).Scan(
			&dto.MaxCostUsdPerDay, &dto.MaxCostUsdPerRun, &dto.MaxTokensPerDay,
			&dto.MaxRunsPerDay, &toolLimitsJSON, &dto.HardFail, &dto.NotifyAtPct, &dto.UpdatedAt,
		)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no budget configured"})
		return
	}
	if len(toolLimitsJSON) > 0 {
		_ = json.Unmarshal(toolLimitsJSON, &dto.ToolLimits)
	}
	writeJSON(w, http.StatusOK, dto)
}

// DeleteBudget handles DELETE /v1/agents/{name}/budget.
func (h *BudgetHandler) DeleteBudget(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName, ok := budgetAgentName(w, r)
	if !ok {
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`,
			tenantID, agentName)
		return e
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// budgetAgentName reads {name} for the per-agent budget routes. The tenant-wide
// cap's sentinel row is reachable only via /v1/budgets/tenant: letting
// /v1/agents/*/budget address it would let a per-agent call rewrite or delete
// the tenant cap.
func budgetAgentName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name := r.PathValue("name")
	switch name {
	case "":
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name required"})
		return "", false
	case TenantBudgetAgent:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `agent name "*" is reserved; use /v1/budgets/tenant`})
		return "", false
	}
	return name, true
}

// ListBudgets handles GET /v1/budgets.
func (h *BudgetHandler) ListBudgets(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	result := make([]budgetDTO, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT agent_name, max_cost_usd_per_day, max_cost_usd_per_run,
			       max_tokens_per_day, max_runs_per_day, tool_limits, hard_fail, notify_at_pct, updated_at
			FROM agent_budgets WHERE tenant_id = $1 AND agent_name <> '*' ORDER BY agent_name -- the tenant-wide cap lives at /v1/budgets/tenant
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var dto budgetDTO
			var toolLimitsJSON []byte
			if err := rows.Scan(&dto.AgentName, &dto.MaxCostUsdPerDay, &dto.MaxCostUsdPerRun,
				&dto.MaxTokensPerDay, &dto.MaxRunsPerDay, &toolLimitsJSON, &dto.HardFail,
				&dto.NotifyAtPct, &dto.UpdatedAt); err != nil {
				continue
			}
			if len(toolLimitsJSON) > 0 {
				_ = json.Unmarshal(toolLimitsJSON, &dto.ToolLimits)
			}
			result = append(result, dto)
		}
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// UpsertTenantBudget handles PUT /v1/budgets/tenant. Body: {maxCostUsdPerDay, hardFail}.
func (h *BudgetHandler) UpsertTenantBudget(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body budgetDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.MaxCostUsdPerDay == nil || *body.MaxCostUsdPerDay <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "maxCostUsdPerDay must be > 0"})
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
			  max_cost_usd_per_day = EXCLUDED.max_cost_usd_per_day,
			  hard_fail            = EXCLUDED.hard_fail,
			  updated_at           = now()
		`, tenantID, TenantBudgetAgent, body.MaxCostUsdPerDay, body.HardFail)
		return e
	})
	if err != nil {
		h.logger().Error("upsert tenant budget failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save tenant budget"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// GetTenantBudget handles GET /v1/budgets/tenant.
func (h *BudgetHandler) GetTenantBudget(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	dto := budgetDTO{AgentName: TenantBudgetAgent}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT max_cost_usd_per_day, hard_fail, updated_at
			FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2
		`, tenantID, TenantBudgetAgent).Scan(&dto.MaxCostUsdPerDay, &dto.HardFail, &dto.UpdatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no tenant budget configured"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

// DeleteTenantBudget handles DELETE /v1/budgets/tenant.
func (h *BudgetHandler) DeleteTenantBudget(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, tenantID, TenantBudgetAgent)
		return e
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// ---------- Enforcement ----------

// BudgetCheckResult is the return value of CheckBudget.
type BudgetCheckResult struct {
	Allowed  bool
	HardFail bool
	// Unavailable means the budget could not be read (a DB error, not "no
	// budget configured") and the check failed closed. Callers answer 503
	// rather than 402: the agent may well be under budget.
	Unavailable bool
	Reason      string
	SpentToday  float64
	RunsToday   int
	Budget      *loadedBudget
}

// budgetLookupFailed is the fail-closed result for a budget read that errored
// with anything other than pgx.ErrNoRows. hardFail is the budget's own policy
// when the row was read; when the row itself could not be read it is unknown,
// so the caller passes true: a hard-fail budget must never be silently skipped
// because the DB hiccuped. The error text stays in the log, never the Reason
// (which reaches HTTP clients).
func budgetLookupFailed(ctx context.Context, check, tenantID, agentName string, hardFail bool, err error) BudgetCheckResult {
	zap.L().Error("budget check failed closed: lookup error",
		zap.String("check", check),
		zap.String("tenant_id", tenantID),
		zap.String("agent", agentName),
		zap.Bool("hard_fail", hardFail),
		zap.Error(err),
	)
	middleware.RecordBudgetCheckError(ctx, check, agentName)
	return BudgetCheckResult{HardFail: hardFail, Unavailable: true, Reason: "budget check unavailable"}
}

// CheckBudget evaluates whether an agent may dispatch a new run right now.
// Call this from POST /v1/runs, the scheduler, and the step-executor.
//
// If no budget is configured, Allowed=true, HardFail=false.
// If configured and violating, Allowed=false and Reason explains.
// If a budget can't be read (DB error), Allowed=false, Unavailable=true.
//
// The tenant-wide cap (agent_budgets row with agent_name = TenantBudgetAgent)
// is checked first, against spend summed across every agent.
// A hard-fail violation from either budget wins: a soft tenant cap that is
// exceeded must not mask the agent's own hard-fail limit (callers block only
// on !Allowed && HardFail).
func CheckBudget(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, estCostUsd float64) BudgetCheckResult {
	return combineBudgets(CheckTenantBudget(ctx, pool, tenantID, estCostUsd), func() BudgetCheckResult {
		return checkAgentBudget(ctx, pool, tenantID, agentName, estCostUsd, true)
	})
}

// CheckRunBudget is the mid-run check: call it before each model call of an
// already-admitted run. It enforces max_cost_usd_per_run against the spend the
// run has accrued so far (runs.cost_usd, fed by AccrueRunSpend) plus the
// tenant and agent daily cost/token caps. It skips max_runs_per_day: the run
// was admitted, and other runs finishing must not stop it halfway.
func CheckRunBudget(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, runID string) BudgetCheckResult {
	return combineBudgets(CheckTenantBudget(ctx, pool, tenantID, 0), func() BudgetCheckResult {
		res := checkAgentBudget(ctx, pool, tenantID, agentName, 0, false)
		if !res.Allowed || res.Budget == nil || res.Budget.MaxCostUsdPerRun <= 0 {
			return res
		}
		var accrued float64
		err := pool.QueryRow(ctx, `
			SELECT COALESCE(cost_usd, 0)::float8 FROM runs WHERE id = $1 AND tenant_id = $2
		`, runID, tenantID).Scan(&accrued)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return budgetLookupFailed(ctx, "run", tenantID, agentName, res.HardFail, err)
		}
		if accrued >= res.Budget.MaxCostUsdPerRun {
			res.Allowed = false
			res.Reason = fmt.Sprintf("run spend $%.4f reached per-run limit $%.4f", accrued, res.Budget.MaxCostUsdPerRun)
		}
		return res
	})
}

// combineBudgets merges the tenant-wide result with the agent's (evaluated
// only when the tenant cap doesn't already hard-block).
func combineBudgets(tc BudgetCheckResult, agent func() BudgetCheckResult) BudgetCheckResult {
	if !tc.Allowed && tc.HardFail {
		return tc
	}
	ac := agent()
	if !ac.Allowed && ac.HardFail {
		return ac
	}
	if !tc.Allowed {
		return tc // soft tenant overrun: warn, don't block
	}
	return ac
}

// TenantBudgetAgent is the reserved agent_budgets.agent_name holding the
// tenant-wide daily spend cap. Reusing agent_budgets (UNIQUE tenant_id,
// agent_name) avoids a new table, migration and RLS catalog entry. "*" is
// rejected as an agent name and on the per-agent budget routes so nothing else
// can address this row.
const TenantBudgetAgent = "*"

// CheckTenantBudget enforces the tenant-wide max_cost_usd_per_day against
// SUM(agent_usage_daily.cost_usd) over all agents (incl. "__agentless__").
// No row / no cap -> allowed (unlimited, unchanged behavior); a lookup error
// fails closed (see budgetLookupFailed).
func CheckTenantBudget(ctx context.Context, pool *pgxpool.Pool, tenantID string, estCostUsd float64) BudgetCheckResult {
	var maxCost *float64
	var hardFail bool
	err := pool.QueryRow(ctx, `
		SELECT max_cost_usd_per_day::float8, hard_fail
		FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2
	`, tenantID, TenantBudgetAgent).Scan(&maxCost, &hardFail)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetCheckResult{Allowed: true}
	}
	if err != nil {
		return budgetLookupFailed(ctx, "tenant", tenantID, "", true, err)
	}
	if maxCost == nil || *maxCost <= 0 {
		return BudgetCheckResult{Allowed: true}
	}
	var spent float64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(cost_usd),0)::float8 FROM agent_usage_daily
		WHERE tenant_id = $1 AND usage_date = $2
	`, tenantID, usageDate(time.Now())).Scan(&spent); err != nil {
		return budgetLookupFailed(ctx, "tenant", tenantID, "", hardFail, err)
	}
	res := BudgetCheckResult{Allowed: true, HardFail: hardFail, SpentToday: spent}
	if spent+estCostUsd > *maxCost {
		res.Allowed = false
		res.Reason = fmt.Sprintf("tenant-wide daily spend would reach $%.4f exceeding tenant limit $%.4f", spent+estCostUsd, *maxCost)
	}
	return res
}

// checkAgentBudget evaluates the agent's own limits. checkRuns gates
// max_runs_per_day, which only applies when admitting a new run.
func checkAgentBudget(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, estCostUsd float64, checkRuns bool) BudgetCheckResult {
	var b loadedBudget
	var toolLimitsJSON []byte
	var maxCostPerDayRaw, maxCostPerRunRaw *float64
	var maxRunsPerDayRaw *int
	var maxTokensPerDayRaw *int64
	err := pool.QueryRow(ctx, `
		SELECT max_cost_usd_per_day, max_cost_usd_per_run, max_tokens_per_day, max_runs_per_day,
		       tool_limits, hard_fail, notify_at_pct
		FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2
	`, tenantID, agentName).Scan(
		&maxCostPerDayRaw, &maxCostPerRunRaw, &maxTokensPerDayRaw, &maxRunsPerDayRaw,
		&toolLimitsJSON, &b.HardFail, &b.NotifyAtPct,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetCheckResult{Allowed: true}
	}
	if err != nil {
		return budgetLookupFailed(ctx, "agent", tenantID, agentName, true, err)
	}
	if maxCostPerDayRaw != nil {
		b.MaxCostUsdPerDay = *maxCostPerDayRaw
	}
	if maxCostPerRunRaw != nil {
		b.MaxCostUsdPerRun = *maxCostPerRunRaw
	}
	if maxRunsPerDayRaw != nil {
		b.MaxRunsPerDay = *maxRunsPerDayRaw
	}
	if maxTokensPerDayRaw != nil {
		b.MaxTokensPerDay = *maxTokensPerDayRaw
	}

	var spent float64
	var runs int
	var tokens int64
	today := usageDate(time.Now())
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(cost_usd,0)::float8, COALESCE(runs_count,0), COALESCE(tokens_in + tokens_out,0)::bigint
		FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3
	`, tenantID, agentName, today).Scan(&spent, &runs, &tokens)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return budgetLookupFailed(ctx, "agent", tenantID, agentName, b.HardFail, err)
	}

	res := BudgetCheckResult{
		Allowed:    true,
		HardFail:   b.HardFail,
		SpentToday: spent,
		RunsToday:  runs,
		Budget:     &b,
	}
	if b.MaxCostUsdPerRun > 0 && estCostUsd > b.MaxCostUsdPerRun {
		res.Allowed = false
		res.Reason = fmt.Sprintf("estimated cost $%.4f exceeds per-run limit $%.4f", estCostUsd, b.MaxCostUsdPerRun)
		return res
	}
	if b.MaxCostUsdPerDay > 0 && spent+estCostUsd > b.MaxCostUsdPerDay {
		res.Allowed = false
		res.Reason = fmt.Sprintf("daily spend would reach $%.4f exceeding limit $%.4f", spent+estCostUsd, b.MaxCostUsdPerDay)
		return res
	}
	if b.MaxTokensPerDay > 0 && tokens >= b.MaxTokensPerDay {
		res.Allowed = false
		res.Reason = fmt.Sprintf("daily token limit reached (%d/%d)", tokens, b.MaxTokensPerDay)
		return res
	}
	if checkRuns && b.MaxRunsPerDay > 0 && runs >= b.MaxRunsPerDay {
		res.Allowed = false
		res.Reason = fmt.Sprintf("daily run limit reached (%d/%d)", runs, b.MaxRunsPerDay)
		return res
	}
	return res
}

// CheckToolBudget evaluates per-tool call limits.
func CheckToolBudget(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, toolName string) BudgetCheckResult {
	var toolLimitsJSON []byte
	var hardFail bool
	err := pool.QueryRow(ctx, `
		SELECT tool_limits, hard_fail
		FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2
	`, tenantID, agentName).Scan(&toolLimitsJSON, &hardFail)
	if errors.Is(err, pgx.ErrNoRows) {
		return BudgetCheckResult{Allowed: true}
	}
	if err != nil {
		return budgetLookupFailed(ctx, "tool", tenantID, agentName, true, err)
	}
	var limits map[string]int
	if len(toolLimitsJSON) > 0 {
		_ = json.Unmarshal(toolLimitsJSON, &limits)
	}
	limit, ok := limits[toolName]
	if !ok || limit <= 0 {
		return BudgetCheckResult{Allowed: true, HardFail: hardFail}
	}

	var used int
	today := usageDate(time.Now())
	err = pool.QueryRow(ctx, `
		SELECT COALESCE((tool_counts->>$4)::int, 0)
		FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3
	`, tenantID, agentName, today, toolName).Scan(&used)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return budgetLookupFailed(ctx, "tool", tenantID, agentName, hardFail, err)
	}

	if used >= limit {
		return BudgetCheckResult{
			Allowed:  false,
			HardFail: hardFail,
			Reason:   fmt.Sprintf("tool %q budget exhausted (%d/%d today)", toolName, used, limit),
		}
	}
	return BudgetCheckResult{Allowed: true, HardFail: hardFail}
}

// AccrueRunSpend adds one intra-run model call's tokens and cost onto the run
// row so CheckRunBudget sees what the run has spent so far. The workflow path
// finishes without overwriting cost_usd, so the accrual is also the run's
// recorded cost. Daily rollups are separate (RecordUsageSpend).
func AccrueRunSpend(ctx context.Context, pool *pgxpool.Pool, tenantID, runID string, tokensIn, tokensOut int64, costUsd float64) error {
	_, err := pool.Exec(ctx, `
		UPDATE runs SET
		  tokens_in  = COALESCE(tokens_in, 0) + $3,
		  tokens_out = COALESCE(tokens_out, 0) + $4,
		  cost_usd   = COALESCE(cost_usd, 0) + $5
		WHERE id = $1 AND tenant_id = $2
	`, runID, tenantID, tokensIn, tokensOut, costUsd)
	if err != nil {
		return fmt.Errorf("accrue run spend %s: %w", runID, err)
	}
	return nil
}

// RecordUsage upserts one run's worth of spend into the daily rollup.
// Call this AFTER a run completes.
func RecordUsage(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, tokensIn, tokensOut int64, costUsd float64, toolCalls map[string]int) error {
	return recordUsage(ctx, pool, tenantID, agentName, 1, tokensIn, tokensOut, costUsd, toolCalls)
}

// RecordUsageSpend adds tokens and cost to the daily rollup WITHOUT bumping
// runs_count. For intra-run LLM calls (workflow ai-steps, consistency votes)
// whose run is already counted, so runs/day budgets are not inflated.
func RecordUsageSpend(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, tokensIn, tokensOut int64, costUsd float64) error {
	return recordUsage(ctx, pool, tenantID, agentName, 0, tokensIn, tokensOut, costUsd, nil)
}

func recordUsage(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, runsDelta int, tokensIn, tokensOut int64, costUsd float64, toolCalls map[string]int) error {
	today := usageDate(time.Now())
	// json.Marshal of a NIL map yields the 4-byte literal `null`, not `{}` —
	// so the len()==0 guard never fired, and every caller that passes nil
	// toolCalls (the session path does) sent `null::jsonb` into the upsert.
	// There `null || '{}'` produces an ARRAY, and jsonb_object_keys rejects a
	// non-object: "cannot call jsonb_object_keys on an array (SQLSTATE 22023)".
	// The whole upsert failed, so runs/tokens/cost were NEVER recorded —
	// 11,074 failures in this deployment's log, i.e. budget enforcement and
	// cost attribution have been silently reading near-empty rollups.
	toolCallsJSON := []byte("{}")
	if len(toolCalls) > 0 {
		if b, err := json.Marshal(toolCalls); err == nil && len(b) > 0 && string(b) != "null" {
			toolCallsJSON = b
		}
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO agent_usage_daily
		  (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, $2, $3, $8, $4, $5, $6, $7::jsonb)
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET
		  runs_count   = agent_usage_daily.runs_count + EXCLUDED.runs_count,
		  tokens_in    = agent_usage_daily.tokens_in + EXCLUDED.tokens_in,
		  tokens_out   = agent_usage_daily.tokens_out + EXCLUDED.tokens_out,
		  cost_usd     = agent_usage_daily.cost_usd + EXCLUDED.cost_usd,
		  tool_counts  = COALESCE((
		    SELECT jsonb_object_agg(k, COALESCE((agent_usage_daily.tool_counts->>k)::int, 0) + COALESCE((EXCLUDED.tool_counts->>k)::int, 0))
		    FROM jsonb_object_keys(agent_usage_daily.tool_counts || EXCLUDED.tool_counts) k
		  ), '{}'::jsonb)
	`, tenantID, agentName, today, tokensIn, tokensOut, costUsd, toolCallsJSON, runsDelta)
	return err
}

// AdjustUsageCost adds deltaUsd (which may be negative) to the cost rollup for
// an agent on date (a "YYYY-MM-DD" date in the deployment timezone) WITHOUT
// touching runs_count or tokens. Used to reconcile an estimated charge to its
// actual value — e.g. when a voice call ends and the flat connect-time
// reservation is replaced by the duration-based cost. The delta must land on
// the SAME day the estimate was charged (the reservation day), so a call
// crossing midnight doesn't leave the start day over-charged. The resulting
// cost is clamped at >= 0 so a refund can't drive the rollup negative.
func AdjustUsageCost(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, date string, deltaUsd float64) error {
	if date == "" {
		date = usageDate(time.Now())
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO agent_usage_daily
		  (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, $2, $3, 0, 0, 0, GREATEST($4, 0), '{}'::jsonb)
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET
		  cost_usd = GREATEST(agent_usage_daily.cost_usd + $4, 0)
	`, tenantID, agentName, date, deltaUsd)
	return err
}
