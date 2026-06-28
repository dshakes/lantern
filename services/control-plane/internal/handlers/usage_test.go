package handlers

// DB-gated tests for GET /v1/usage and the ListRuns status filter.
// Skipped when DATABASE_URL is unset (same convention as the rest of the package).
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run 'Usage|ListRuns' -count=1 -v

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newTestUsageHandler builds a UsageHandler backed by a real pool.
func newTestUsageHandler(t *testing.T) *UsageHandler {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewUsageHandler(srv, auth)
}

// seedUsageTenant inserts a minimal tenant and agent, then returns (tenantID,
// agentID, agentVersionID). Cleans up on t.Cleanup.
func seedUsageTenant(t *testing.T, h *UsageHandler, agentName string) (tenantID, agentID, agentVersionID string) {
	t.Helper()
	ctx := context.Background()
	pool := h.srv.Pool

	tenantID = uuid.NewString()
	slug := "usage-test-" + tenantID[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Usage Test', 'personal', 'ns-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, tenantID, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'usage test agent')
		ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-usage-test', decode(md5($2), 'hex'), 'local://test', '{}'::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
		RETURNING id
	`, agentID, agentName+"-usage").Scan(&agentVersionID); err != nil {
		t.Fatalf("seed agent_version: %v", err)
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM agent_usage_daily WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(bg, `DELETE FROM agent_versions WHERE agent_id = $1`, agentID)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return
}

// doGetUsage fires GET /v1/usage and returns the decoded response.
func doGetUsage(t *testing.T, h *UsageHandler, tenantID string) usageResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/usage", nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "user-"+tenantID[:8], "owner")))
	rr := httptest.NewRecorder()
	h.GetUsage(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GetUsage returned %d; body: %s", rr.Code, rr.Body.String())
	}
	var out usageResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode usage response: %v; body: %s", err, rr.Body.String())
	}
	return out
}

// TestUsage_PeriodAggregation seeds agent_usage_daily rows and run rows, then
// asserts the period buckets contain the correct aggregated values.
func TestUsage_PeriodAggregation(t *testing.T) {
	h := newTestUsageHandler(t)
	pool := h.srv.Pool
	ctx := context.Background()

	tenantID, agentID, versionID := seedUsageTenant(t, h, "usage-period-agent")

	today := time.Now().UTC().Format("2006-01-02")
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	// A date in the last-7-days window but not today.
	threeDaysAgo := time.Now().UTC().AddDate(0, 0, -3).Format("2006-01-02")
	// A date in the current calendar month (if month has more than 6 days, this
	// is also within the 7-day window; we choose yesterday which is always safe).
	_ = yesterday // referenced below

	// Seed daily-cost rows.
	insertDaily := func(date string, cost float64, ti, to int64) {
		_, err := pool.Exec(ctx, `
			INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
			VALUES ($1, 'usage-period-agent', $2, 1, $3, $4, $5, '{}')
			ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET
			  cost_usd = EXCLUDED.cost_usd,
			  tokens_in = EXCLUDED.tokens_in,
			  tokens_out = EXCLUDED.tokens_out
		`, tenantID, date, ti, to, cost)
		if err != nil {
			t.Fatalf("insertDaily %s: %v", date, err)
		}
	}
	insertDaily(today, 0.10, 1000, 500)       // in today, week, month, total
	insertDaily(threeDaysAgo, 0.05, 500, 200) // in week, month, total (not today)

	// Seed run rows with different statuses.
	insertRun := func(status string) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
			VALUES ($1, $2, $3, $4, 'api', '{}'::jsonb)
		`, tenantID, agentID, versionID, status); err != nil {
			t.Fatalf("insertRun %s: %v", status, err)
		}
	}
	insertRun("succeeded")
	insertRun("succeeded")
	insertRun("failed")
	insertRun("running")

	resp := doGetUsage(t, h, tenantID)

	// All 4 runs were created now (within today/week/month).
	for _, period := range []string{"today", "week", "month", "total"} {
		p, ok := resp.Periods[period]
		if !ok {
			t.Fatalf("missing period %q", period)
		}
		if p.Runs != 4 {
			t.Errorf("period=%s runs=%d want 4", period, p.Runs)
		}
		if p.Succeeded != 2 {
			t.Errorf("period=%s succeeded=%d want 2", period, p.Succeeded)
		}
		if p.Failed != 1 {
			t.Errorf("period=%s failed=%d want 1", period, p.Failed)
		}
		if p.Running != 1 {
			t.Errorf("period=%s running=%d want 1", period, p.Running)
		}
	}

	// Cost assertions:
	// today: only today row → 0.10
	todayP := resp.Periods["today"]
	if todayP.CostUsd < 0.099 || todayP.CostUsd > 0.101 {
		t.Errorf("today costUsd=%.4f want ~0.10", todayP.CostUsd)
	}
	if todayP.TokensIn != 1000 {
		t.Errorf("today tokensIn=%d want 1000", todayP.TokensIn)
	}

	// week/month/total: both rows → 0.15
	weekP := resp.Periods["week"]
	if weekP.CostUsd < 0.149 || weekP.CostUsd > 0.151 {
		t.Errorf("week costUsd=%.4f want ~0.15", weekP.CostUsd)
	}
	totalP := resp.Periods["total"]
	if totalP.CostUsd < 0.149 || totalP.CostUsd > 0.151 {
		t.Errorf("total costUsd=%.4f want ~0.15", totalP.CostUsd)
	}
}

// TestUsage_TenantIsolation ensures a different tenant's cost rows don't leak.
func TestUsage_TenantIsolation(t *testing.T) {
	h := newTestUsageHandler(t)
	pool := h.srv.Pool
	ctx := context.Background()

	tid1, _, _ := seedUsageTenant(t, h, "usage-isolation-a")
	tid2, _, _ := seedUsageTenant(t, h, "usage-isolation-b")

	today := time.Now().UTC().Format("2006-01-02")

	// Only tenant 2 has cost data.
	_, err := pool.Exec(ctx, `
		INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, 'usage-isolation-b', $2, 5, 5000, 2000, 1.23, '{}')
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET cost_usd = EXCLUDED.cost_usd
	`, tid2, today)
	if err != nil {
		t.Fatalf("seed tid2 daily: %v", err)
	}

	// Tenant 1 must see $0.
	resp1 := doGetUsage(t, h, tid1)
	if resp1.Periods["total"].CostUsd != 0 {
		t.Errorf("tenant1 sees cost %.4f from tenant2, want 0", resp1.Periods["total"].CostUsd)
	}

	// Tenant 2 sees its own data.
	resp2 := doGetUsage(t, h, tid2)
	if resp2.Periods["today"].CostUsd < 1.22 || resp2.Periods["today"].CostUsd > 1.24 {
		t.Errorf("tenant2 today costUsd=%.4f want ~1.23", resp2.Periods["today"].CostUsd)
	}
}

// TestUsage_ByAgent asserts the byAgent list reflects cost from agent_usage_daily
// and run counts from the runs table.
func TestUsage_ByAgent(t *testing.T) {
	h := newTestUsageHandler(t)
	pool := h.srv.Pool
	ctx := context.Background()

	tenantID, agentID, versionID := seedUsageTenant(t, h, "usage-byagent-agent")
	today := time.Now().UTC().Format("2006-01-02")

	_, err := pool.Exec(ctx, `
		INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, 'usage-byagent-agent', $2, 3, 3000, 1000, 0.42, '{}')
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET cost_usd = EXCLUDED.cost_usd
	`, tenantID, today)
	if err != nil {
		t.Fatalf("seed daily: %v", err)
	}

	// 2 succeeded, 1 failed.
	for _, s := range []string{"succeeded", "succeeded", "failed"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
			VALUES ($1, $2, $3, $4, 'api', '{}'::jsonb)
		`, tenantID, agentID, versionID, s); err != nil {
			t.Fatalf("insert run: %v", err)
		}
	}

	resp := doGetUsage(t, h, tenantID)

	if len(resp.ByAgent) == 0 {
		t.Fatal("byAgent is empty, want at least 1 entry")
	}

	var found bool
	for _, a := range resp.ByAgent {
		if a.AgentName != "usage-byagent-agent" {
			continue
		}
		found = true
		if a.CostUsd < 0.41 || a.CostUsd > 0.43 {
			t.Errorf("byAgent costUsd=%.4f want ~0.42", a.CostUsd)
		}
		if a.Runs != 3 {
			t.Errorf("byAgent runs=%d want 3", a.Runs)
		}
		if a.Succeeded != 2 {
			t.Errorf("byAgent succeeded=%d want 2", a.Succeeded)
		}
		if a.Failed != 1 {
			t.Errorf("byAgent failed=%d want 1", a.Failed)
		}
	}
	if !found {
		t.Error("usage-byagent-agent not found in byAgent")
	}
}

// TestListRuns_StatusFilter asserts that GET /v1/runs?status=succeeded returns
// only succeeded rows (server-side, not client-side filtering).
func TestListRuns_StatusFilter(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	h := &RESTHandler{srv: srv, auth: auth, agentSvc: agentSvc, runSvc: runSvc}
	ctx := context.Background()

	// Fresh tenant so we don't trip over dev-seed data.
	tenantID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Filter Test', 'personal', 'ns-ft-' || $2)
	`, tenantID, "ft-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})

	var agentID, versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, 'filter-test-agent', 'status filter test')
		RETURNING id
	`, tenantID).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-ft', decode(md5($2), 'hex'), 'local://test', '{}'::jsonb)
		RETURNING id
	`, agentID, "filter-test-version").Scan(&versionID); err != nil {
		t.Fatalf("seed version: %v", err)
	}

	for _, s := range []string{"succeeded", "succeeded", "failed", "running"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
			VALUES ($1, $2, $3, $4, 'api', '{}'::jsonb)
		`, tenantID, agentID, versionID, s); err != nil {
			t.Fatalf("insert run %s: %v", s, err)
		}
	}

	// Fire GET /v1/runs?status=succeeded.
	req := httptest.NewRequest(http.MethodGet, "/v1/runs?status=succeeded", nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "user-ft", "owner")))
	rr := httptest.NewRecorder()
	h.ListRuns(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("ListRuns returned %d; body: %s", rr.Code, rr.Body.String())
	}

	var runs []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &runs); err != nil {
		t.Fatalf("decode: %v; body: %s", err, rr.Body.String())
	}
	if len(runs) != 2 {
		t.Errorf("got %d runs, want 2 (only succeeded)", len(runs))
	}
	for _, run := range runs {
		if run["status"] != "succeeded" {
			t.Errorf("got run with status=%v, want succeeded", run["status"])
		}
	}
}
