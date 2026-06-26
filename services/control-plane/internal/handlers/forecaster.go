package handlers

// Pre-run cost forecaster.
//
// Given an agent + proposed input, produce a cost estimate BEFORE dispatching
// the run. Estimates come from historical journal_events for this agent —
// average tokens_in, tokens_out, step count — adjusted for the input size.
// The forecast is checked against agent_budgets; if the estimate would blow
// the budget, the run is blocked (HTTP 402) and the forecast is persisted
// with blocked_by_budget=true for observability.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ForecastHandler implements /v1/runs/forecast.
type ForecastHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewForecastHandler creates a new forecaster handler.
func NewForecastHandler(srv *server.Server, auth *AuthHandler) *ForecastHandler {
	return &ForecastHandler{srv: srv, auth: auth}
}

func (h *ForecastHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("forecaster")
}

// ---------- Request / response ----------

type forecastRequest struct {
	AgentName string `json:"agentName"`
	Input     string `json:"input"`
	Model     string `json:"model,omitempty"` // capability, defaults to "auto"
}

type forecastResponse struct {
	AgentName          string          `json:"agentName"`
	Model              string          `json:"model"`
	Provider           string          `json:"provider"`
	EstimatedTokensIn  int64           `json:"estimatedTokensIn"`
	EstimatedTokensOut int64           `json:"estimatedTokensOut"`
	EstimatedCostUsd   float64         `json:"estimatedCostUsd"`
	Confidence         float64         `json:"confidence"` // 0-1
	Reasoning          map[string]any  `json:"reasoning"`
	Budget             *budgetSnapshot `json:"budget,omitempty"`
	WouldExceedBudget  bool            `json:"wouldExceedBudget"`
	BlockReason        string          `json:"blockReason,omitempty"`
}

type budgetSnapshot struct {
	MaxCostUsdPerDay  float64 `json:"maxCostUsdPerDay,omitempty"`
	MaxCostUsdPerRun  float64 `json:"maxCostUsdPerRun,omitempty"`
	SpentTodayUsd     float64 `json:"spentTodayUsd"`
	RemainingTodayUsd float64 `json:"remainingTodayUsd"`
	RunsToday         int     `json:"runsToday"`
	MaxRunsPerDay     int     `json:"maxRunsPerDay,omitempty"`
	NotifyAtPct       int     `json:"notifyAtPct"`
	HardFail          bool    `json:"hardFail"`
}

// Forecast handles POST /v1/runs/forecast.
func (h *ForecastHandler) Forecast(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req forecastRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.AgentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName is required"})
		return
	}
	if req.Model == "" {
		req.Model = "auto"
	}

	provider, model := resolveModel(req.Model)

	// 1. Historical baseline: average per-run totals for this agent.
	hist, histErr := h.historical(ctx, tenantID, req.AgentName)
	if histErr != nil {
		h.logger().Warn("historical lookup failed", zap.Error(histErr))
	}

	// 2. Input-size heuristic: ~1 token per 4 characters.
	inputTokens := int64(math.Ceil(float64(len(req.Input)) / 4.0))

	estTokensIn := hist.avgTokensIn + inputTokens
	estTokensOut := hist.avgTokensOut

	// 3. If we have no history, fall back to conservative defaults.
	confidence := hist.confidence
	if hist.runs == 0 {
		estTokensIn = maxI64(inputTokens+500, 1500)
		estTokensOut = 800
		confidence = 0.3
	}

	estCost := estimateCost(provider, model, int(estTokensIn), int(estTokensOut))

	reasoning := map[string]any{
		"historical_runs":           hist.runs,
		"historical_avg_cost_usd":   hist.avgCostUsd,
		"historical_avg_tokens_in":  hist.avgTokensIn,
		"historical_avg_tokens_out": hist.avgTokensOut,
		"input_chars":               len(req.Input),
		"input_token_estimate":      inputTokens,
		"pricing_model":             model,
		"pricing_provider":          provider,
	}

	// 4. Check against any configured budget.
	budget, spentToday, runsToday, budgetErr := h.loadBudget(ctx, tenantID, req.AgentName)
	if budgetErr != nil {
		h.logger().Warn("budget lookup failed", zap.Error(budgetErr))
	}

	resp := forecastResponse{
		AgentName:          req.AgentName,
		Model:              model,
		Provider:           provider,
		EstimatedTokensIn:  estTokensIn,
		EstimatedTokensOut: estTokensOut,
		EstimatedCostUsd:   roundMoney(estCost),
		Confidence:         confidence,
		Reasoning:          reasoning,
	}

	if budget != nil {
		snap := budgetSnapshot{
			MaxCostUsdPerDay: budget.MaxCostUsdPerDay,
			MaxCostUsdPerRun: budget.MaxCostUsdPerRun,
			SpentTodayUsd:    roundMoney(spentToday),
			RunsToday:        runsToday,
			MaxRunsPerDay:    budget.MaxRunsPerDay,
			NotifyAtPct:      budget.NotifyAtPct,
			HardFail:         budget.HardFail,
		}
		if budget.MaxCostUsdPerDay > 0 {
			snap.RemainingTodayUsd = roundMoney(budget.MaxCostUsdPerDay - spentToday)
		}
		resp.Budget = &snap

		// Evaluate blocking.
		var reasons []string
		if budget.MaxCostUsdPerRun > 0 && estCost > budget.MaxCostUsdPerRun {
			reasons = append(reasons, fmt.Sprintf("per-run cost $%.4f exceeds limit $%.4f", estCost, budget.MaxCostUsdPerRun))
		}
		if budget.MaxCostUsdPerDay > 0 && spentToday+estCost > budget.MaxCostUsdPerDay {
			reasons = append(reasons, fmt.Sprintf("daily cost would hit $%.4f exceeding $%.4f", spentToday+estCost, budget.MaxCostUsdPerDay))
		}
		if budget.MaxRunsPerDay > 0 && runsToday >= budget.MaxRunsPerDay {
			reasons = append(reasons, fmt.Sprintf("daily run limit reached (%d/%d)", runsToday, budget.MaxRunsPerDay))
		}
		if len(reasons) > 0 {
			resp.WouldExceedBudget = true
			resp.BlockReason = strings.Join(reasons, "; ")
		}
	}

	// Persist forecast for later calibration.
	go h.recordForecast(context.Background(), tenantID, req.AgentName, resp)

	status := http.StatusOK
	if resp.WouldExceedBudget && budget != nil && budget.HardFail {
		status = http.StatusPaymentRequired
	}
	writeJSON(w, status, resp)
}

// ---------- internals ----------

type historicalStats struct {
	runs         int
	avgTokensIn  int64
	avgTokensOut int64
	avgCostUsd   float64
	confidence   float64
}

func (h *ForecastHandler) historical(ctx context.Context, tenantID, agentName string) (historicalStats, error) {
	var s historicalStats
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT
				COUNT(*) AS runs,
				COALESCE(AVG(tokens_in), 0)::bigint AS avg_in,
				COALESCE(AVG(tokens_out), 0)::bigint AS avg_out,
				COALESCE(AVG(cost_usd), 0) AS avg_cost
			FROM runs r
			JOIN agents a ON a.id = r.agent_id
			WHERE r.tenant_id = $1 AND a.name = $2 AND r.status = 'completed'
			  AND r.created_at > now() - INTERVAL '30 days'
		`, tenantID, agentName).Scan(&s.runs, &s.avgTokensIn, &s.avgTokensOut, &s.avgCostUsd)
	})
	if err != nil {
		return s, err
	}
	// Confidence grows with sample size, asymptotic to 0.95.
	s.confidence = math.Min(0.95, 0.3+0.03*math.Sqrt(float64(s.runs)))
	return s, nil
}

type loadedBudget struct {
	MaxCostUsdPerDay float64
	MaxCostUsdPerRun float64
	MaxRunsPerDay    int
	MaxTokensPerDay  int64
	NotifyAtPct      int
	HardFail         bool
	ToolLimits       map[string]any
}

func (h *ForecastHandler) loadBudget(ctx context.Context, tenantID, agentName string) (*loadedBudget, float64, int, error) {
	var b loadedBudget
	var toolLimitsJSON []byte
	var maxCostPerDayRaw, maxCostPerRunRaw *float64
	var maxRunsPerDayRaw *int
	var maxTokensPerDayRaw *int64
	var spent float64
	var runs int
	today := time.Now().UTC().Format("2006-01-02")
	budgetErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `
			SELECT max_cost_usd_per_day, max_cost_usd_per_run, max_tokens_per_day, max_runs_per_day,
			       tool_limits, hard_fail, notify_at_pct
			FROM agent_budgets
			WHERE tenant_id = $1 AND agent_name = $2
		`, tenantID, agentName).Scan(
			&maxCostPerDayRaw, &maxCostPerRunRaw, &maxTokensPerDayRaw, &maxRunsPerDayRaw,
			&toolLimitsJSON, &b.HardFail, &b.NotifyAtPct,
		); e != nil {
			return e
		}
		// Load today's usage from the daily rollup (same tx).
		_ = tx.QueryRow(ctx, `
			SELECT COALESCE(cost_usd, 0)::float8, COALESCE(runs_count, 0)
			FROM agent_usage_daily
			WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3
		`, tenantID, agentName, today).Scan(&spent, &runs)
		return nil
	})
	if budgetErr != nil {
		// No budget: return nil, no usage.
		return nil, 0, 0, nil
	}
	if maxCostPerDayRaw != nil {
		b.MaxCostUsdPerDay = *maxCostPerDayRaw
	}
	if maxCostPerRunRaw != nil {
		b.MaxCostUsdPerRun = *maxCostPerRunRaw
	}
	if maxTokensPerDayRaw != nil {
		b.MaxTokensPerDay = *maxTokensPerDayRaw
	}
	if maxRunsPerDayRaw != nil {
		b.MaxRunsPerDay = *maxRunsPerDayRaw
	}
	if len(toolLimitsJSON) > 0 {
		_ = json.Unmarshal(toolLimitsJSON, &b.ToolLimits)
	}
	return &b, spent, runs, nil
}

func (h *ForecastHandler) recordForecast(ctx context.Context, tenantID, agentName string, resp forecastResponse) {
	reasoningJSON, _ := json.Marshal(resp.Reasoning)
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO cost_forecasts
			  (tenant_id, agent_name, estimated_tokens_in, estimated_tokens_out,
			   estimated_cost_usd, confidence, reasoning, blocked_by_budget)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
		`, tenantID, agentName, resp.EstimatedTokensIn, resp.EstimatedTokensOut,
			resp.EstimatedCostUsd, resp.Confidence, reasoningJSON, resp.WouldExceedBudget)
		return e
	})
	if err != nil {
		h.logger().Warn("record forecast failed", zap.Error(err))
	}
}

// authCtx is a package-local helper to extract tenant from request.
func authCtx(auth *AuthHandler, r *http.Request) (context.Context, string, error) {
	claims, err := auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
}

func maxI64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func roundMoney(v float64) float64 {
	return math.Round(v*10000) / 10000
}
