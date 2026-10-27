package handlers

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.uber.org/zap"
)

// DB-backed: needs DATABASE_URL (openTestPool).
func TestMeteredLLMCall(t *testing.T) {
	pool := openTestPool(t)
	tenant := devTenantID
	ctx := context.Background()
	boom := errors.New("boom")

	cases := []struct {
		name       string
		exhausted  bool // seed a hard-fail budget already over its daily cost cap
		callErr    error
		wantCalled bool
		wantErr    error
		wantTokens int64 // tokens_in recorded
	}{
		{"records usage on success", false, nil, true, nil, 7},
		{"records usage even when call errors after spend", false, boom, true, boom, 7},
		{"hard-fail budget blocks before spend", true, nil, false, errWorkflowBudgetExceeded, 0},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			agent := "metering-test-" + string(rune('a'+i))
			cleanup := func() {
				_, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id=$1 AND agent_name=$2`, tenant, agent)
				_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id=$1 AND agent_name=$2`, tenant, agent)
			}
			cleanup()
			t.Cleanup(cleanup)
			if tc.exhausted {
				if _, err := pool.Exec(ctx, `INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail, notify_at_pct)
					VALUES ($1,$2,1,true,80)`, tenant, agent); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, `INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
					VALUES ($1,$2,$3,1,0,0,5,'{}'::jsonb)`, tenant, agent, usageDate(time.Now())); err != nil {
					t.Fatal(err)
				}
			}
			called := false
			_, err := meteredLLMCall(ctx, pool, zap.NewNop(), tenant, agent, "00000000-0000-0000-0000-000000000000", func() (string, int64, int64, float64, error) {
				called = true
				return "ok", 7, 3, 0.01, tc.callErr
			})
			if called != tc.wantCalled {
				t.Fatalf("called=%v want %v", called, tc.wantCalled)
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err=%v want %v", err, tc.wantErr)
			}
			var tin, runs int64
			var cost float64
			_ = pool.QueryRow(ctx, `SELECT COALESCE(SUM(runs_count),0), COALESCE(SUM(cost_usd),0) FROM agent_usage_daily WHERE tenant_id=$1 AND agent_name=$2`, tenant, agent).Scan(&runs, &cost)
			wantRuns, wantCost := int64(0), 0.01
			if tc.exhausted {
				wantRuns, wantCost = 1, 5 // seeded row only
			} else if tc.wantTokens == 0 {
				wantCost = 0
			}
			if runs != wantRuns || cost != wantCost {
				t.Fatalf("runs_count=%d cost=%v want %d/%v", runs, cost, wantRuns, wantCost)
			}
			_ = pool.QueryRow(ctx, `SELECT COALESCE(SUM(tokens_in),0) FROM agent_usage_daily WHERE tenant_id=$1 AND agent_name=$2`, tenant, agent).Scan(&tin)
			if tin != tc.wantTokens {
				t.Fatalf("tokens_in=%d want %d", tin, tc.wantTokens)
			}
		})
	}
}
