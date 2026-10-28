package handlers

import (
	"context"
	"math"
	"testing"
)

// AdjustUsageCost must apply SUB-DOLLAR deltas: voice reconciliation adjusts by
// a few cents, and an untyped $4 was inferred as INTEGER (every delta -> 0).
func TestAdjustUsageCost_SubDollarDeltas(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	const tenant, agent, day = "00000000-0000-0000-0000-000000000001", "zz-adjust-usage-test", "2099-01-01"
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id=$1 AND agent_name=$2`, tenant, agent)
	})
	cost := func() float64 {
		var c float64
		if err := pool.QueryRow(ctx, `SELECT cost_usd::float8 FROM agent_usage_daily WHERE tenant_id=$1 AND agent_name=$2 AND usage_date=$3`,
			tenant, agent, day).Scan(&c); err != nil {
			t.Fatalf("read rollup: %v", err)
		}
		return c
	}
	for _, step := range []struct{ delta, want float64 }{{0.05, 0.05}, {0.01, 0.06}, {-0.05, 0.01}, {-0.5, 0}} {
		if err := AdjustUsageCost(ctx, pool, tenant, agent, day, step.delta); err != nil {
			t.Fatalf("AdjustUsageCost(%v): %v", step.delta, err)
		}
		if got := cost(); math.Abs(got-step.want) > 1e-6 {
			t.Fatalf("after delta %v cost = %v, want %v", step.delta, got, step.want)
		}
	}
}
