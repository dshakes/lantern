package handlers

// tenant_defaults.go — free-tier caps applied to every NEW tenant at sign-up
// (password Signup and OAuth first login). Reuses existing storage: the
// tenant-wide daily cap is the agent_budgets row at agent_name='*' (the same
// row PUT /v1/budgets/tenant writes) and the sandbox cap is runtime_quotas.
//
// Env (all optional; unset → the default below; "0" or "off" skips that cap):
//
//	LANTERN_FREE_TIER_COST_USD_PER_DAY          tenant-wide LLM spend/day   (default 2.00)
//	LANTERN_FREE_TIER_MAX_VMS                   concurrent sandbox VMs      (default 2)
//	LANTERN_FREE_TIER_RUNTIME_COST_USD_PER_DAY  sandbox spend/day           (default 1.00)
//
// The seeded dev tenant is created by db/migrate.go, not sign-up, so it never
// receives caps. Only sign-up calls this; existing tenants are untouched.

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	defaultFreeCostUSDPerDay        = 2.0
	defaultFreeMaxVMs               = 2
	defaultFreeRuntimeCostUSDPerDay = 1.0
	freeComputeHoursPerDay          = 4.0
	freeEgressGBPerDay              = 1.0
)

type freeTier struct {
	CostUSDPerDay        float64 // 0 = no cap row
	MaxVMs               int     // 0 = no quota row
	RuntimeCostUSDPerDay float64
}

// freeTierFromEnv parses the env; a malformed or negative value falls back to
// the default rather than silently removing a cap.
func freeTierFromEnv() freeTier {
	return freeTier{
		CostUSDPerDay:        envFloat("LANTERN_FREE_TIER_COST_USD_PER_DAY", defaultFreeCostUSDPerDay),
		MaxVMs:               int(envFloat("LANTERN_FREE_TIER_MAX_VMS", defaultFreeMaxVMs)),
		RuntimeCostUSDPerDay: envFloat("LANTERN_FREE_TIER_RUNTIME_COST_USD_PER_DAY", defaultFreeRuntimeCostUSDPerDay),
	}
}

func envFloat(key string, def float64) float64 {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "":
		return def
	case "off":
		return 0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		return def
	}
	return f
}

// applyFreeTierDefaults writes the caps for a brand-new tenant inside the
// sign-up transaction, so a tenant never exists uncapped. Idempotent upserts.
func applyFreeTierDefaults(ctx context.Context, tx pgx.Tx, tenantID string) error {
	ft := freeTierFromEnv()
	if ft.CostUSDPerDay > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
			VALUES ($1, '*', $2, true)
			ON CONFLICT (tenant_id, agent_name) DO NOTHING
		`, tenantID, ft.CostUSDPerDay); err != nil {
			return fmt.Errorf("free tier budget for tenant %s: %w", tenantID, err)
		}
	}
	if ft.MaxVMs > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO runtime_quotas
			  (tenant_id, max_concurrent_vms, max_compute_hours_per_day,
			   max_egress_gb_per_day, max_cost_usd_per_day, hard_fail, updated_at)
			VALUES ($1, $2, $3, $4, $5, true, now())
			ON CONFLICT (tenant_id) DO NOTHING
		`, tenantID, ft.MaxVMs, freeComputeHoursPerDay, freeEgressGBPerDay, ft.RuntimeCostUSDPerDay); err != nil {
			return fmt.Errorf("free tier runtime quota for tenant %s: %w", tenantID, err)
		}
	}
	return nil
}
