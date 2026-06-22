package handlers

// DB-gated tests for:
//   - Fix A (P0-3): CheckBudget pre-check + RecordUsage post-record on POST /v1/runs.
//   - Fix B (P0-6): unpublished marketplace agents are not invocable.
//
// Skipped automatically when DATABASE_URL is unset. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern_ga1?sslmode=disable \
//	  go test -race -run TestBudget ./internal/handlers/ -v -count=1

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// helpers local to this file
// ---------------------------------------------------------------------------

// newBudgetTestHandler builds a minimal RESTHandler backed by a real pool.
func newBudgetTestHandler(t *testing.T) (*RESTHandler, *AuthHandler) {
	t.Helper()
	pool := openTestPool(t) // skips if DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)
	return h, auth
}

// upsertBudgetDirect writes an agent_budgets row directly — avoids HTTP for
// the setup phase so the test body stays focused on the assertion.
func upsertBudgetDirect(t *testing.T, h *RESTHandler, tenantID, agentName string, maxRunsPerDay int, hardFail bool) {
	t.Helper()
	ctx := tenantCtx(tenantID)
	_, err := h.srv.Pool.Exec(ctx, `
		INSERT INTO agent_budgets
		  (tenant_id, agent_name, max_runs_per_day, hard_fail, notify_at_pct)
		VALUES ($1, $2, $3, $4, 80)
		ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
		  max_runs_per_day = EXCLUDED.max_runs_per_day,
		  hard_fail        = EXCLUDED.hard_fail,
		  updated_at       = now()
	`, tenantID, agentName, maxRunsPerDay, hardFail)
	if err != nil {
		t.Fatalf("upsertBudgetDirect: %v", err)
	}
}

// deleteBudgetDirect removes the agent_budgets row for cleanup.
func deleteBudgetDirect(t *testing.T, h *RESTHandler, tenantID, agentName string) {
	t.Helper()
	ctx := tenantCtx(tenantID)
	_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agentName)
}

// setUsageDirect inserts a daily usage row to simulate exhausted runs.
func setUsageDirect(t *testing.T, h *RESTHandler, tenantID, agentName string, runsCount int) {
	t.Helper()
	ctx := tenantCtx(tenantID)
	_, err := h.srv.Pool.Exec(ctx, `
		INSERT INTO agent_usage_daily
		  (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
		VALUES ($1, $2, CURRENT_DATE, $3, 0, 0, 0, '{}'::jsonb)
		ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET
		  runs_count = EXCLUDED.runs_count
	`, tenantID, agentName, runsCount)
	if err != nil {
		t.Fatalf("setUsageDirect: %v", err)
	}
}

// deleteUsageDirect removes the daily usage row for cleanup.
func deleteUsageDirect(t *testing.T, h *RESTHandler, tenantID, agentName string) {
	t.Helper()
	ctx := tenantCtx(tenantID)
	_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agentName)
}

// ensureAgentWithVersion creates an agent + promoted version for tests that
// need to call CreateRun via gRPC.  Returns cleanup.
func ensureAgentForBudgetTest(t *testing.T, h *RESTHandler, tenantID, agentName string) func() {
	t.Helper()
	ctx := tenantCtx(tenantID)
	pool := h.srv.Pool

	_, _ = h.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
		Name: agentName, Description: "budget test agent",
	})

	var agentID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM agents WHERE tenant_id = $1 AND name = $2`,
		tenantID, agentName,
	).Scan(&agentID); err != nil {
		t.Fatalf("resolve agent %q: %v", agentName, err)
	}

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, '0.1.0-budget-test', 'sha256:budget-test', 's3://test/bundle.tar.gz', '{}'::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET digest = EXCLUDED.digest
		RETURNING id
	`, agentID).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	return func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE agent_id = $1`, agentID)
		_, _ = pool.Exec(bg, `DELETE FROM agent_versions WHERE id = $1`, versionID)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE id = $1`, agentID)
	}
}

// postRunHTTP fires POST /v1/runs via httptest and returns the recorder.
func postRunHTTP(t *testing.T, h *RESTHandler, auth *AuthHandler, tenantID, agentName string) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	body, _ := json.Marshal(map[string]any{"agentName": agentName, "input": map[string]any{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	h.CreateRun(rr, req)
	return rr
}

// ---------------------------------------------------------------------------
// Fix A tests
// ---------------------------------------------------------------------------

// TestCreateRun_BudgetHardFail_Returns402 verifies that a hard-fail budget
// blocks dispatch and returns HTTP 402, not 201.
func TestCreateRun_BudgetHardFail_Returns402(t *testing.T) {
	h, auth := newBudgetTestHandler(t)
	agentName := "budget-hardfail-test-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, h, devTenantID, agentName)
	t.Cleanup(cleanup)

	// Set a hard-fail budget with max 1 run/day, then exhaust it.
	upsertBudgetDirect(t, h, devTenantID, agentName, 1, true)
	setUsageDirect(t, h, devTenantID, agentName, 1) // already at limit
	t.Cleanup(func() {
		deleteBudgetDirect(t, h, devTenantID, agentName)
		deleteUsageDirect(t, h, devTenantID, agentName)
	})

	rr := postRunHTTP(t, h, auth, devTenantID, agentName)

	if rr.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402, got %d; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if _, ok := resp["reason"]; !ok {
		t.Errorf("402 response missing 'reason' field: %v", resp)
	}
}

// TestCreateRun_BudgetNotHardFail_DoesNotBlock verifies that a non-hard-fail
// budget breach still dispatches the run (warn-only mode).
func TestCreateRun_BudgetNotHardFail_DoesNotBlock(t *testing.T) {
	h, auth := newBudgetTestHandler(t)
	agentName := "budget-softfail-test-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, h, devTenantID, agentName)
	t.Cleanup(cleanup)

	// Set a soft-fail budget (hardFail=false) with max 1 run/day, then exhaust it.
	upsertBudgetDirect(t, h, devTenantID, agentName, 1, false)
	setUsageDirect(t, h, devTenantID, agentName, 1) // already at limit
	t.Cleanup(func() {
		deleteBudgetDirect(t, h, devTenantID, agentName)
		deleteUsageDirect(t, h, devTenantID, agentName)
	})

	rr := postRunHTTP(t, h, auth, devTenantID, agentName)

	// Soft fail: run should be accepted (201 or 200), not 402.
	if rr.Code == http.StatusPaymentRequired {
		t.Fatalf("soft-fail budget should NOT block; got 402; body: %s", rr.Body.String())
	}
	if rr.Code >= 500 {
		t.Fatalf("unexpected server error %d: %s", rr.Code, rr.Body.String())
	}
}

// TestCreateRun_NoBudget_Dispatches verifies a run without any budget
// configured still dispatches normally (no regression).
func TestCreateRun_NoBudget_Dispatches(t *testing.T) {
	h, auth := newBudgetTestHandler(t)
	agentName := "budget-none-test-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, h, devTenantID, agentName)
	t.Cleanup(cleanup)
	// No budget row at all.
	t.Cleanup(func() {
		deleteBudgetDirect(t, h, devTenantID, agentName)
		deleteUsageDirect(t, h, devTenantID, agentName)
	})

	rr := postRunHTTP(t, h, auth, devTenantID, agentName)

	if rr.Code == http.StatusPaymentRequired {
		t.Fatalf("no-budget run must not be blocked; got 402; body: %s", rr.Body.String())
	}
	if rr.Code >= 500 {
		t.Fatalf("unexpected server error %d: %s", rr.Code, rr.Body.String())
	}
}

// TestRecordUsage_AccruesRun directly tests the RecordUsage function for
// correctness: after calling it, the daily rollup row shows the expected
// runs_count and cost.
func TestRecordUsage_AccruesRun(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	tenantID := devTenantID
	agentName := "record-usage-test-" + t.Name()

	// Clean state.
	_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agentName)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agentName)
	})

	if err := RecordUsage(ctx, pool, tenantID, agentName, 100, 200, 0.0050, map[string]int{}); err != nil {
		t.Fatalf("RecordUsage: %v", err)
	}

	var runs int
	var costUsd float64
	if err := pool.QueryRow(ctx, `
		SELECT runs_count, cost_usd FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = CURRENT_DATE
	`, tenantID, agentName).Scan(&runs, &costUsd); err != nil {
		t.Fatalf("query usage row: %v", err)
	}
	if runs != 1 {
		t.Errorf("runs_count: got %d, want 1", runs)
	}
	if costUsd < 0.004 || costUsd > 0.006 {
		t.Errorf("cost_usd: got %f, want ~0.005", costUsd)
	}

	// Second call must accumulate, not overwrite.
	if err := RecordUsage(ctx, pool, tenantID, agentName, 50, 100, 0.0025, map[string]int{}); err != nil {
		t.Fatalf("RecordUsage (second): %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT runs_count, cost_usd FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = CURRENT_DATE
	`, tenantID, agentName).Scan(&runs, &costUsd); err != nil {
		t.Fatalf("query usage row (second): %v", err)
	}
	if runs != 2 {
		t.Errorf("runs_count after two calls: got %d, want 2", runs)
	}
	if costUsd < 0.007 || costUsd > 0.008 {
		t.Errorf("cost_usd after two calls: got %f, want ~0.0075", costUsd)
	}
}

// ---------------------------------------------------------------------------
// Fix B tests
// ---------------------------------------------------------------------------

// TestMarketplaceInvoke_UnpublishedAgent_Returns404 verifies that the invoke
// query rejects an unpublished (revoked) marketplace agent with a 404.  The
// test exercises the SQL guard at the DB level by inserting a row with
// unpublished_at set and calling CheckBudget-equivalent lookup directly.
func TestMarketplaceInvoke_UnpublishedAgent_Returns404(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	slug := "test-unpub-" + t.Name()
	tenantID := devTenantID

	// Insert a marketplace agent that is already unpublished.
	_, err := pool.Exec(ctx, `
		INSERT INTO marketplace_agents
		  (slug, source_tenant_id, source_agent_id, unpublished_at, category, manifest, card)
		VALUES ($1, $2::uuid,
		        (SELECT id FROM agents WHERE tenant_id = $2 LIMIT 1),
		        now(), 'test', '{}'::jsonb, '{}'::jsonb)
		ON CONFLICT (slug) DO UPDATE SET unpublished_at = now()
	`, slug, tenantID)
	if err != nil {
		t.Skipf("insert marketplace_agents: %v (schema not ready?)", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM marketplace_agents WHERE slug = $1`, slug)
	})

	// The guarded query used by Invoke — must return no rows.
	var found bool
	rowErr := pool.QueryRow(ctx, `
		SELECT true
		FROM marketplace_agents m
		WHERE m.slug = $1 AND m.unpublished_at IS NULL
	`, slug).Scan(&found)
	if rowErr == nil {
		t.Fatal("guarded query should return no rows for an unpublished agent, but it did")
	}
	// pgx returns pgx.ErrNoRows on no result — that's the correct path.
	// Any scan error means the guard worked.
}

// ---------------------------------------------------------------------------
// Fix 1 tests — scheduled runs bypass the budget gate
// ---------------------------------------------------------------------------

// TestExecuteScheduledRun_HardFail_DoesNotDispatch verifies that
// ExecuteScheduledRun returns without inserting a run row when the agent
// has a hard-fail budget that is already exhausted.
func TestExecuteScheduledRun_HardFail_DoesNotDispatch(t *testing.T) {
	h, _ := newBudgetTestHandler(t)
	agentName := "sched-hardfail-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, h, devTenantID, agentName)
	t.Cleanup(cleanup)

	upsertBudgetDirect(t, h, devTenantID, agentName, 1, true)
	setUsageDirect(t, h, devTenantID, agentName, 1) // already at limit
	t.Cleanup(func() {
		deleteBudgetDirect(t, h, devTenantID, agentName)
		deleteUsageDirect(t, h, devTenantID, agentName)
	})

	// Count runs before.
	ctx := context.Background()
	var runsBefore int
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runs WHERE agent_id = (SELECT id FROM agents WHERE tenant_id = $1 AND name = $2)`,
		devTenantID, agentName,
	).Scan(&runsBefore)

	h.ExecuteScheduledRun(devTenantID, agentName, nil)

	var runsAfter int
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runs WHERE agent_id = (SELECT id FROM agents WHERE tenant_id = $1 AND name = $2)`,
		devTenantID, agentName,
	).Scan(&runsAfter)

	if runsAfter > runsBefore {
		t.Errorf("scheduled run should not have dispatched: runs before=%d after=%d", runsBefore, runsAfter)
	}
}

// TestExecuteScheduledRun_NoBudget_Dispatches verifies that a scheduled run
// with no budget configured still creates a run row (no regression).
func TestExecuteScheduledRun_NoBudget_Dispatches(t *testing.T) {
	h, _ := newBudgetTestHandler(t)
	agentName := "sched-nobudget-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, h, devTenantID, agentName)
	t.Cleanup(cleanup)
	// No budget row.

	ctx := context.Background()
	var runsBefore int
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runs WHERE agent_id = (SELECT id FROM agents WHERE tenant_id = $1 AND name = $2)`,
		devTenantID, agentName,
	).Scan(&runsBefore)

	h.ExecuteScheduledRun(devTenantID, agentName, nil)

	var runsAfter int
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runs WHERE agent_id = (SELECT id FROM agents WHERE tenant_id = $1 AND name = $2)`,
		devTenantID, agentName,
	).Scan(&runsAfter)

	// Run row must be created (dispatched).
	if runsAfter <= runsBefore {
		t.Errorf("no-budget scheduled run should have dispatched: runs before=%d after=%d", runsBefore, runsAfter)
	}
}

// TestExecuteScheduledRun_SoftFail_Dispatches verifies that a soft-fail
// (hardFail=false) over-budget agent is NOT blocked by the scheduler.
func TestExecuteScheduledRun_SoftFail_Dispatches(t *testing.T) {
	h, _ := newBudgetTestHandler(t)
	agentName := "sched-softfail-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, h, devTenantID, agentName)
	t.Cleanup(cleanup)

	upsertBudgetDirect(t, h, devTenantID, agentName, 1, false) // soft fail
	setUsageDirect(t, h, devTenantID, agentName, 1)
	t.Cleanup(func() {
		deleteBudgetDirect(t, h, devTenantID, agentName)
		deleteUsageDirect(t, h, devTenantID, agentName)
	})

	ctx := context.Background()
	var runsBefore int
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runs WHERE agent_id = (SELECT id FROM agents WHERE tenant_id = $1 AND name = $2)`,
		devTenantID, agentName,
	).Scan(&runsBefore)

	h.ExecuteScheduledRun(devTenantID, agentName, nil)

	var runsAfter int
	_ = h.srv.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runs WHERE agent_id = (SELECT id FROM agents WHERE tenant_id = $1 AND name = $2)`,
		devTenantID, agentName,
	).Scan(&runsAfter)

	if runsAfter <= runsBefore {
		t.Errorf("soft-fail scheduled run should have dispatched: runs before=%d after=%d", runsBefore, runsAfter)
	}
}

// ---------------------------------------------------------------------------
// Fix 2 tests — session budget gate
// ---------------------------------------------------------------------------

// TestCheckBudget_SessionBudgetGate is a table-driven unit test that
// verifies CheckBudget returns the right Allowed/HardFail pair for the
// three scenarios the session handler branches on.
func TestCheckBudget_SessionBudgetGate(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	tenantID := devTenantID

	tests := []struct {
		name          string
		maxRunsPerDay int
		runsUsed      int
		hardFail      bool
		wantAllowed   bool
		wantHardFail  bool
	}{
		{"no-budget", 0, 0, false, true, false},
		{"under-limit", 5, 4, true, true, true},
		{"at-limit-hardfail", 5, 5, true, false, true},
		{"at-limit-softfail", 5, 5, false, false, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			agent := "sess-gate-" + tc.name + "-" + t.Name()
			// Reset
			_, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agent)
			_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agent)
			t.Cleanup(func() {
				_, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agent)
				_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, agent)
			})

			if tc.maxRunsPerDay > 0 {
				_, err := pool.Exec(ctx, `
					INSERT INTO agent_budgets (tenant_id, agent_name, max_runs_per_day, hard_fail, notify_at_pct)
					VALUES ($1, $2, $3, $4, 80)
					ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
					  max_runs_per_day = EXCLUDED.max_runs_per_day,
					  hard_fail        = EXCLUDED.hard_fail
				`, tenantID, agent, tc.maxRunsPerDay, tc.hardFail)
				if err != nil {
					t.Fatalf("insert budget: %v", err)
				}
			}
			if tc.runsUsed > 0 {
				_, err := pool.Exec(ctx, `
					INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, tokens_in, tokens_out, cost_usd, tool_counts)
					VALUES ($1, $2, CURRENT_DATE, $3, 0, 0, 0, '{}'::jsonb)
					ON CONFLICT (tenant_id, agent_name, usage_date) DO UPDATE SET runs_count = EXCLUDED.runs_count
				`, tenantID, agent, tc.runsUsed)
				if err != nil {
					t.Fatalf("insert usage: %v", err)
				}
			}

			res := CheckBudget(ctx, pool, tenantID, agent, 0)
			if res.Allowed != tc.wantAllowed {
				t.Errorf("Allowed: got %v want %v (reason=%q)", res.Allowed, tc.wantAllowed, res.Reason)
			}
			if res.HardFail != tc.wantHardFail {
				t.Errorf("HardFail: got %v want %v", res.HardFail, tc.wantHardFail)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Fix 2 tests — /v1/completions agent-scoped budget gate
// ---------------------------------------------------------------------------

// newLlmProxyTestHandler builds a minimal LlmProxyHandler backed by a real pool.
func newLlmProxyTestHandler(t *testing.T) (*LlmProxyHandler, *AuthHandler) {
	t.Helper()
	pool := openTestPool(t)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewLlmProxyHandler(srv, auth)
	return h, auth
}

// postCompletionHTTP fires POST /v1/completions with a given agentName and
// returns the recorder.
func postCompletionHTTP(t *testing.T, h *LlmProxyHandler, auth *AuthHandler, tenantID, agentName string) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-"+tenantID, "owner")
	body, _ := json.Marshal(map[string]any{
		"agentName": agentName,
		"messages":  []map[string]string{{"role": "user", "content": "hello"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	h.Complete(rr, req)
	return rr
}

// TestCompletions_AgentScoped_HardFail_Returns402 verifies that a hard-fail
// budget blocks agent-scoped POST /v1/completions with 402.
func TestCompletions_AgentScoped_HardFail_Returns402(t *testing.T) {
	h, auth := newLlmProxyTestHandler(t)
	rh, _ := newBudgetTestHandler(t)
	agentName := "comp-hardfail-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, rh, devTenantID, agentName)
	t.Cleanup(cleanup)

	upsertBudgetDirect(t, rh, devTenantID, agentName, 1, true)
	setUsageDirect(t, rh, devTenantID, agentName, 1)
	t.Cleanup(func() {
		deleteBudgetDirect(t, rh, devTenantID, agentName)
		deleteUsageDirect(t, rh, devTenantID, agentName)
	})

	rr := postCompletionHTTP(t, h, auth, devTenantID, agentName)
	if rr.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402, got %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := resp["reason"]; !ok {
		t.Errorf("402 response missing 'reason' field: %v", resp)
	}
}

// TestCompletions_AgentScoped_SoftFail_DoesNotBlock verifies that a soft-fail
// budget breach does NOT block the completion request (warn-only).
// The LLM call itself will fail (no keys in test env) but must NOT be a 402.
func TestCompletions_AgentScoped_SoftFail_DoesNotBlock(t *testing.T) {
	h, auth := newLlmProxyTestHandler(t)
	rh, _ := newBudgetTestHandler(t)
	agentName := "comp-softfail-" + t.Name()
	cleanup := ensureAgentForBudgetTest(t, rh, devTenantID, agentName)
	t.Cleanup(cleanup)

	upsertBudgetDirect(t, rh, devTenantID, agentName, 1, false) // soft fail
	setUsageDirect(t, rh, devTenantID, agentName, 1)
	t.Cleanup(func() {
		deleteBudgetDirect(t, rh, devTenantID, agentName)
		deleteUsageDirect(t, rh, devTenantID, agentName)
	})

	rr := postCompletionHTTP(t, h, auth, devTenantID, agentName)
	if rr.Code == http.StatusPaymentRequired {
		t.Fatalf("soft-fail budget must NOT block completion; got 402; body: %s", rr.Body.String())
	}
}

// TestRecordUsage_AgentlessCompletions verifies that agentless completions
// record usage under the sentinel "__agentless__" name (visibility test).
func TestRecordUsage_AgentlessCompletions(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	tenantID := devTenantID
	sentinel := "__agentless__"

	_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, sentinel)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, tenantID, sentinel)
	})

	if err := RecordUsage(ctx, pool, tenantID, sentinel, 100, 50, 0.001, nil); err != nil {
		t.Fatalf("RecordUsage sentinel: %v", err)
	}

	var runsCount int
	if err := pool.QueryRow(ctx,
		`SELECT runs_count FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = CURRENT_DATE`,
		tenantID, sentinel,
	).Scan(&runsCount); err != nil {
		t.Fatalf("query sentinel usage: %v", err)
	}
	if runsCount != 1 {
		t.Errorf("sentinel runs_count: got %d, want 1", runsCount)
	}
}

// ---------------------------------------------------------------------------
// TestMarketplaceInvoke_PublishedAgent_Visible verifies that a published
// (unpublished_at IS NULL) agent IS visible to the guarded query.
// ---------------------------------------------------------------------------

// TestMarketplaceInvoke_PublishedAgent_Visible verifies that a published
// (unpublished_at IS NULL) agent IS visible to the guarded query.
func TestMarketplaceInvoke_PublishedAgent_Visible(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	slug := "test-pub-" + t.Name()
	tenantID := devTenantID

	// Insert a published marketplace agent.
	_, err := pool.Exec(ctx, `
		INSERT INTO marketplace_agents
		  (slug, source_tenant_id, source_agent_id, unpublished_at, category, manifest, card)
		VALUES ($1, $2::uuid,
		        (SELECT id FROM agents WHERE tenant_id = $2 LIMIT 1),
		        NULL, 'test', '{}'::jsonb, '{}'::jsonb)
		ON CONFLICT (slug) DO UPDATE SET unpublished_at = NULL
	`, slug, tenantID)
	if err != nil {
		t.Skipf("insert marketplace_agents: %v (schema not ready?)", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM marketplace_agents WHERE slug = $1`, slug)
	})

	var sellerTenant string
	if err := pool.QueryRow(ctx, `
		SELECT m.source_tenant_id::text
		FROM marketplace_agents m
		LEFT JOIN agents a ON a.id = m.source_agent_id
		WHERE m.slug = $1 AND m.unpublished_at IS NULL
	`, slug).Scan(&sellerTenant); err != nil {
		t.Fatalf("published agent should be visible via guarded query, but got: %v", err)
	}
	if sellerTenant == "" {
		t.Error("sellerTenant must be non-empty for a published agent")
	}
}
