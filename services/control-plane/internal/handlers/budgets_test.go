package handlers

// DB-backed tests for the W1-A budget holes: tokens/day, the per-run cap
// enforced mid-run, and fail-closed lookups. Need DATABASE_URL (openTestPool).

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"go.uber.org/zap"
)

// seedBudget writes one agent_budgets row plus today's usage for agent under
// the dev tenant, and removes both (and any usage written later) on cleanup.
func seedBudget(t *testing.T, agent, cols string, vals []any, tokensIn, tokensOut int64, costUsd float64) {
	t.Helper()
	pool := openTestPool(t)
	ctx := context.Background()
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id=$1 AND agent_name=$2`, devTenantID, agent)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id=$1 AND agent_name=$2`, devTenantID, agent)
	}
	cleanup()
	t.Cleanup(cleanup)
	if cols != "" {
		args := append([]any{devTenantID, agent}, vals...)
		ph := ""
		for i := range vals {
			ph += fmt.Sprintf(", $%d", i+3)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO agent_budgets (tenant_id, agent_name, `+cols+`) VALUES ($1, $2`+ph+`)`, args...); err != nil {
			t.Fatalf("seed budget: %v", err)
		}
	}
	if tokensIn > 0 || tokensOut > 0 || costUsd > 0 {
		if _, err := pool.Exec(ctx, `INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
			VALUES ($1,$2,$3,0,$4,$5,$6,'{}'::jsonb)`, devTenantID, agent, usageDate(time.Now()), tokensIn, tokensOut, costUsd); err != nil {
			t.Fatalf("seed usage: %v", err)
		}
	}
}

func TestCheckBudget_TokensPerDay(t *testing.T) {
	pool := openTestPool(t)
	cases := []struct {
		name          string
		hardFail      bool
		in, out       int64
		wantAllowed   bool
		wantHardBlock bool
	}{
		{"under cap allowed", true, 40, 50, true, false},
		{"at cap hard-fail blocks", true, 60, 40, false, true},
		{"over cap hard-fail blocks", true, 90, 50, false, true},
		{"over cap soft warns", false, 90, 50, false, false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			agent := "w1a-tokens-" + string(rune('a'+i))
			seedBudget(t, agent, "max_tokens_per_day, hard_fail", []any{100, tc.hardFail}, tc.in, tc.out, 0)
			r := CheckBudget(context.Background(), pool, devTenantID, agent, 0)
			if r.Allowed != tc.wantAllowed || (!r.Allowed && r.HardFail) != tc.wantHardBlock {
				t.Fatalf("got %+v, want allowed=%v hardBlock=%v", r, tc.wantAllowed, tc.wantHardBlock)
			}
		})
	}
}

// Agents with NO budget row (e.g. the owner's bridge agents) must behave
// exactly as before: allowed, not hard-fail, no reason, never "unavailable".
func TestBudgetChecks_NoBudgetRowUnchanged(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	agent := "w1a-nobudget"
	seedBudget(t, agent, "", nil, 1_000_000, 1_000_000, 999)
	fx := insertDRFixture(t, pool, agent, "running")
	if err := AccrueRunSpend(ctx, pool, devTenantID, fx.runID, 10, 10, 50); err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]BudgetCheckResult{
		"CheckBudget":     CheckBudget(ctx, pool, devTenantID, agent, 5),
		"CheckRunBudget":  CheckRunBudget(ctx, pool, devTenantID, agent, fx.runID),
		"CheckToolBudget": CheckToolBudget(ctx, pool, devTenantID, agent, "slack.post"),
	} {
		if !r.Allowed || r.HardFail || r.Unavailable || r.Reason != "" {
			t.Errorf("%s: no-budget agent changed behavior: %+v", name, r)
		}
	}
}

func TestCheckRunBudget_PerRunCapMidRun(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	agent := "w1a-perrun"
	seedBudget(t, agent, "max_cost_usd_per_run, max_runs_per_day, hard_fail", []any{0.10, 1, true}, 0, 0, 0)
	fx := insertDRFixture(t, pool, agent, "running")

	if r := CheckRunBudget(ctx, pool, devTenantID, agent, fx.runID); !r.Allowed {
		t.Fatalf("fresh run must be allowed: %+v", r)
	}
	// Another run finishing must not stop this in-flight run via runs/day.
	if err := RecordUsage(ctx, pool, devTenantID, agent, 0, 0, 0, nil); err != nil {
		t.Fatal(err)
	}
	if err := AccrueRunSpend(ctx, pool, devTenantID, fx.runID, 100, 50, 0.06); err != nil {
		t.Fatal(err)
	}
	if r := CheckRunBudget(ctx, pool, devTenantID, agent, fx.runID); !r.Allowed {
		t.Fatalf("$0.06 accrued under $0.10 cap (runs/day ignored mid-run) must be allowed: %+v", r)
	}
	if err := AccrueRunSpend(ctx, pool, devTenantID, fx.runID, 100, 50, 0.05); err != nil {
		t.Fatal(err)
	}
	r := CheckRunBudget(ctx, pool, devTenantID, agent, fx.runID)
	if r.Allowed || !r.HardFail {
		t.Fatalf("$0.11 accrued over $0.10 per-run cap must hard-block: %+v", r)
	}
	var tin, tout int64
	var cost float64
	if err := pool.QueryRow(ctx, `SELECT tokens_in, tokens_out, cost_usd::float8 FROM runs WHERE id=$1`, fx.runID).Scan(&tin, &tout, &cost); err != nil {
		t.Fatal(err)
	}
	if tin != 200 || tout != 100 || cost < 0.109 || cost > 0.111 {
		t.Fatalf("run accrual = %d/%d/$%v, want 200/100/$0.11", tin, tout, cost)
	}
}

// The workflow LLM wrapper stops the run before the model call that would
// follow a per-run cap overrun.
func TestMeteredLLMCall_StopsWhenRunOverCap(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	agent := "w1a-metered-perrun"
	seedBudget(t, agent, "max_cost_usd_per_run, hard_fail", []any{0.10, true}, 0, 0, 0)
	fx := insertDRFixture(t, pool, agent, "running")

	calls := 0
	call := func() (string, int64, int64, float64, error) { calls++; return "ok", 10, 10, 0.08, nil }
	for i := 0; i < 2; i++ {
		if _, err := meteredLLMCall(ctx, pool, zap.NewNop(), devTenantID, agent, fx.runID, call); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	_, err := meteredLLMCall(ctx, pool, zap.NewNop(), devTenantID, agent, fx.runID, call)
	if !errors.Is(err, errWorkflowBudgetExceeded) || calls != 2 {
		t.Fatalf("third call: err=%v calls=%d, want errWorkflowBudgetExceeded and no provider call", err, calls)
	}
}

// A budget lookup that fails (DB down / closed pool) must not silently allow.
func TestBudgetChecks_LookupErrorFailsClosed(t *testing.T) {
	pool := openTestPool(t)
	pool.Close()
	ctx := context.Background()
	for name, r := range map[string]BudgetCheckResult{
		"CheckBudget":       CheckBudget(ctx, pool, devTenantID, "w1a-any", 0),
		"CheckTenantBudget": CheckTenantBudget(ctx, pool, devTenantID, 0),
		"CheckRunBudget":    CheckRunBudget(ctx, pool, devTenantID, "w1a-any", "00000000-0000-0000-0000-000000000000"),
		"CheckToolBudget":   CheckToolBudget(ctx, pool, devTenantID, "w1a-any", "slack.post"),
	} {
		if r.Allowed || !r.HardFail || !r.Unavailable {
			t.Errorf("%s: lookup error must fail closed, got %+v", name, r)
		}
	}
}

// POST /v1/runs answers 503 (not 402, not 201) when the budget can't be read.
func TestCreateRun_BudgetLookupError_Returns503(t *testing.T) {
	h, auth := newBudgetTestHandler(t)
	h.srv.Pool.Close()
	rr := postRunHTTP(t, h, auth, devTenantID, "w1a-any")
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d; body: %s", rr.Code, rr.Body.String())
	}
}
