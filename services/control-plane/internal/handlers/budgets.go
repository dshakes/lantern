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
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

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
	agentName := r.PathValue("name")
	if agentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name required"})
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

	_, err = h.srv.Pool.Exec(ctx, `
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
	agentName := r.PathValue("name")

	var dto budgetDTO
	dto.AgentName = agentName
	var toolLimitsJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT max_cost_usd_per_day, max_cost_usd_per_run, max_tokens_per_day,
		       max_runs_per_day, tool_limits, hard_fail, notify_at_pct, updated_at
		FROM agent_budgets
		WHERE tenant_id = $1 AND agent_name = $2
	`, tenantID, agentName).Scan(
		&dto.MaxCostUsdPerDay, &dto.MaxCostUsdPerRun, &dto.MaxTokensPerDay,
		&dto.MaxRunsPerDay, &toolLimitsJSON, &dto.HardFail, &dto.NotifyAtPct, &dto.UpdatedAt,
	)
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
	agentName := r.PathValue("name")
	_, err = h.srv.Pool.Exec(ctx,
		`DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`,
		tenantID, agentName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// ListBudgets handles GET /v1/budgets.
func (h *BudgetHandler) ListBudgets(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT agent_name, max_cost_usd_per_day, max_cost_usd_per_run,
		       max_tokens_per_day, max_runs_per_day, tool_limits, hard_fail, notify_at_pct, updated_at
		FROM agent_budgets WHERE tenant_id = $1 ORDER BY agent_name
	`, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	defer rows.Close()
	result := make([]budgetDTO, 0)
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
	writeJSON(w, http.StatusOK, result)
}

// ---------- Enforcement ----------

// BudgetCheckResult is the return value of CheckBudget.
type BudgetCheckResult struct {
	Allowed    bool
	HardFail   bool
	Reason     string
	SpentToday float64
	RunsToday  int
	Budget     *loadedBudget
}

// CheckBudget evaluates whether an agent may dispatch a new run right now.
// Call this from POST /v1/runs, the scheduler, and the step-executor.
//
// If no budget is configured, Allowed=true, HardFail=false.
// If configured and violating, Allowed=false and Reason explains.
func CheckBudget(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, estCostUsd float64) BudgetCheckResult {
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
	if err != nil {
		return BudgetCheckResult{Allowed: true}
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
	today := time.Now().UTC().Format("2006-01-02")
	_ = pool.QueryRow(ctx, `
		SELECT COALESCE(cost_usd,0)::float8, COALESCE(runs_count,0)
		FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3
	`, tenantID, agentName, today).Scan(&spent, &runs)

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
	if b.MaxRunsPerDay > 0 && runs >= b.MaxRunsPerDay {
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
	if err != nil {
		return BudgetCheckResult{Allowed: true}
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
	today := time.Now().UTC().Format("2006-01-02")
	_ = pool.QueryRow(ctx, `
		SELECT COALESCE((tool_counts->>$4)::int, 0)
		FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3
	`, tenantID, agentName, today, toolName).Scan(&used)

	if used >= limit {
		return BudgetCheckResult{
			Allowed:  false,
			HardFail: hardFail,
			Reason:   fmt.Sprintf("tool %q budget exhausted (%d/%d today)", toolName, used, limit),
		}
	}
	return BudgetCheckResult{Allowed: true, HardFail: hardFail}
}

// RecordUsage upserts one run's worth of spend into the daily rollup.
// Call this AFTER a run completes.
func RecordUsage(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName string, tokensIn, tokensOut int64, costUsd float64, toolCalls map[string]int) error {
	today := time.Now().UTC().Format("2006-01-02")
	toolCallsJSON, _ := json.Marshal(toolCalls)
	if len(toolCallsJSON) == 0 {
		toolCallsJSON = []byte("{}")
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO agent_usage_daily
		  (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, $2, $3, 1, $4, $5, $6, $7::jsonb)
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET
		  runs_count   = agent_usage_daily.runs_count + 1,
		  tokens_in    = agent_usage_daily.tokens_in + EXCLUDED.tokens_in,
		  tokens_out   = agent_usage_daily.tokens_out + EXCLUDED.tokens_out,
		  cost_usd     = agent_usage_daily.cost_usd + EXCLUDED.cost_usd,
		  tool_counts  = (
		    SELECT jsonb_object_agg(k, COALESCE((agent_usage_daily.tool_counts->>k)::int, 0) + COALESCE((EXCLUDED.tool_counts->>k)::int, 0))
		    FROM jsonb_object_keys(agent_usage_daily.tool_counts || EXCLUDED.tool_counts) k
		  )
	`, tenantID, agentName, today, tokensIn, tokensOut, costUsd, toolCallsJSON)
	return err
}

// AdjustUsageCost adds deltaUsd (which may be negative) to the cost rollup for
// an agent on usageDate (a "YYYY-MM-DD" UTC date) WITHOUT touching runs_count
// or tokens. Used to reconcile an estimated charge to its actual value — e.g.
// when a voice call ends and the flat connect-time reservation is replaced by
// the duration-based cost. The delta must land on the SAME day the estimate was
// charged (the reservation day), so a call crossing UTC midnight doesn't leave
// the start day over-charged. The resulting cost is clamped at >= 0 so a refund
// can't drive the rollup negative.
func AdjustUsageCost(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, usageDate string, deltaUsd float64) error {
	if usageDate == "" {
		usageDate = time.Now().UTC().Format("2006-01-02")
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO agent_usage_daily
		  (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, $2, $3, 0, 0, 0, GREATEST($4, 0), '{}'::jsonb)
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET
		  cost_usd = GREATEST(agent_usage_daily.cost_usd + $4, 0)
	`, tenantID, agentName, usageDate, deltaUsd)
	return err
}
