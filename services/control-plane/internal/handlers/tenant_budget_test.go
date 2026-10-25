package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

func setTenantCap(t *testing.T, tenantID string, capUsd float64, hardFail bool) {
	t.Helper()
	pool := openTestPool(t)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
		  max_cost_usd_per_day = EXCLUDED.max_cost_usd_per_day, hard_fail = EXCLUDED.hard_fail
	`, tenantID, TenantBudgetAgent, capUsd, hardFail); err != nil {
		t.Fatalf("set tenant cap: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, tenantID, TenantBudgetAgent)
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_usage_daily WHERE tenant_id = $1`, tenantID)
	})
}

func postAgentlessCompletion(t *testing.T, h *LlmProxyHandler, tenantID string, stream bool) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"stream":   stream,
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/completions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+mintTestToken(t, tenantID, "user-"+tenantID, "owner"))
	rr := httptest.NewRecorder()
	h.Complete(rr, req)
	return rr
}

func TestTenantBudget_BlocksAgentlessCompletion402(t *testing.T) {
	h, _ := newLlmProxyTestHandler(t)
	pool := openTestPool(t)
	tenant := seedCommitmentTenant(t, pool)
	setTenantCap(t, tenant, 1.00, true)
	if err := RecordUsage(context.Background(), pool, tenant, "__agentless__", 10, 10, 1.50, nil); err != nil {
		t.Fatal(err)
	}
	for _, stream := range []bool{false, true} {
		rr := postAgentlessCompletion(t, h, tenant, stream)
		if rr.Code != http.StatusPaymentRequired {
			t.Fatalf("stream=%v: want 402 before any provider call, got %d: %s", stream, rr.Code, rr.Body.String())
		}
		var resp map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &resp)
		if resp["reason"] == "" {
			t.Errorf("stream=%v: 402 missing reason: %v", stream, resp)
		}
	}
}

func TestTenantBudget_SumsAcrossAgentsAndAppliesToAgentChecks(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	setTenantCap(t, tenant, 1.00, true)
	for _, a := range []string{"agent-a", "agent-b"} {
		if err := RecordUsage(ctx, pool, tenant, a, 1, 1, 0.40, nil); err != nil {
			t.Fatal(err)
		}
	}
	// 0.80 spent: a 0.10 call fits, a 0.30 call does not.
	if r := CheckBudget(ctx, pool, tenant, "agent-c", 0.10); !r.Allowed {
		t.Fatalf("0.80+0.10 under cap should be allowed: %s", r.Reason)
	}
	r := CheckBudget(ctx, pool, tenant, "agent-c", 0.30)
	if r.Allowed || !r.HardFail || r.Reason == "" {
		t.Fatalf("0.80+0.30 over cap should hard-block with reason, got %+v", r)
	}
}

func TestTenantBudget_CrossTenantIsolation(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	capped := seedCommitmentTenant(t, pool)
	other := seedCommitmentTenant(t, pool)
	setTenantCap(t, capped, 1.00, true)
	if err := RecordUsage(ctx, pool, other, "agent-x", 1, 1, 50, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1`, other) })
	if r := CheckTenantBudget(ctx, pool, capped, 0.5); !r.Allowed {
		t.Fatalf("other tenant's spend must not count against capped tenant: %s", r.Reason)
	}
	if r := CheckTenantBudget(ctx, pool, other, 100); !r.Allowed {
		t.Fatal("tenant without a cap row must be unlimited")
	}
}

func TestTenantBudget_NoRowUnlimited_SoftFailDoesNotBlock(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	if err := RecordUsage(ctx, pool, tenant, "agent-a", 1, 1, 1000, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1`, tenant) })
	if r := CheckBudget(ctx, pool, tenant, "agent-a", 5); !r.Allowed {
		t.Fatalf("no cap row => unlimited: %s", r.Reason)
	}
	setTenantCap(t, tenant, 1.00, false)
	if r := CheckTenantBudget(ctx, pool, tenant, 0); r.Allowed || r.HardFail {
		t.Fatalf("soft cap should report breach with HardFail=false, got %+v", r)
	}
}

// The tenant-wide "*" row is not an agent: it must not appear in the per-agent
// list the dashboard Budgets page renders.
func TestTenantBudget_HiddenFromAgentBudgetList(t *testing.T) {
	pool := openTestPool(t)
	tenant := seedCommitmentTenant(t, pool)
	setTenantCap(t, tenant, 5.00, true)
	srv := &server.Server{Pool: pool, Logger: zap.NewNop()}
	h := NewBudgetHandler(srv, NewAuthHandler(srv, testJWTSecret))
	req := httptest.NewRequest(http.MethodGet, "/v1/budgets", nil)
	req.Header.Set("Authorization", "Bearer "+mintTestToken(t, tenant, "user-"+tenant, "owner"))
	rr := httptest.NewRecorder()
	h.ListBudgets(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list budgets: %d %s", rr.Code, rr.Body.String())
	}
	if bytes.Contains(rr.Body.Bytes(), []byte(`"`+TenantBudgetAgent+`"`)) {
		t.Errorf("tenant-wide row leaked into agent budget list: %s", rr.Body.String())
	}
}

// A soft-fail tenant cap that is exceeded must not mask the agent's own
// hard-fail budget.
func TestCheckBudget_SoftTenantCapDoesNotMaskAgentHardFail(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	setTenantCap(t, tenant, 1.00, false)
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
		VALUES ($1, 'agent-h', 0.50, true)
	`, tenant); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1`, tenant) })
	if err := RecordUsage(ctx, pool, tenant, "agent-h", 1, 1, 2.00, nil); err != nil {
		t.Fatal(err)
	}
	if r := CheckBudget(ctx, pool, tenant, "agent-h", 0.10); r.Allowed || !r.HardFail {
		t.Fatalf("agent hard-fail budget exceeded under a soft tenant overrun must block, got %+v", r)
	}
	// An agent with no budget still gets the soft tenant warning (not a block).
	if r := CheckBudget(ctx, pool, tenant, "agent-free", 0.10); r.Allowed || r.HardFail {
		t.Fatalf("soft tenant overrun should warn without blocking, got %+v", r)
	}
}

// "*" is the tenant cap's sentinel: the per-agent budget routes and agent
// creation must not be able to address it.
func TestTenantBudget_SentinelNameRejected(t *testing.T) {
	pool := openTestPool(t)
	tenant := seedCommitmentTenant(t, pool)
	setTenantCap(t, tenant, 5.00, true)
	srv := &server.Server{Pool: pool, Logger: zap.NewNop()}
	h := NewBudgetHandler(srv, NewAuthHandler(srv, testJWTSecret))
	tok := "Bearer " + mintTestToken(t, tenant, "user-"+tenant, "owner")
	for _, tc := range []struct {
		method string
		fn     http.HandlerFunc
	}{{http.MethodPut, h.UpsertBudget}, {http.MethodGet, h.GetBudget}, {http.MethodDelete, h.DeleteBudget}} {
		req := httptest.NewRequest(tc.method, "/v1/agents/*/budget", bytes.NewReader([]byte(`{"maxCostUsdPerDay":999,"hardFail":false}`)))
		req.SetPathValue("name", TenantBudgetAgent)
		req.Header.Set("Authorization", tok)
		rr := httptest.NewRecorder()
		tc.fn(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s /v1/agents/*/budget: %d, want 400", tc.method, rr.Code)
		}
	}
	var capUsd float64
	var hard bool
	if err := pool.QueryRow(context.Background(), `SELECT max_cost_usd_per_day::float8, hard_fail FROM agent_budgets WHERE tenant_id=$1 AND agent_name=$2`,
		tenant, TenantBudgetAgent).Scan(&capUsd, &hard); err != nil || capUsd != 5 || !hard {
		t.Errorf("tenant cap altered via per-agent route: cap=%v hard=%v err=%v", capUsd, hard, err)
	}

	svc := NewAgentService(srv)
	_, err := svc.CreateAgent(middleware.InjectTenantID(context.Background(), tenant), &lanternv1.CreateAgentRequest{Name: TenantBudgetAgent})
	if status.Code(err) != grpccodes.InvalidArgument {
		t.Errorf("CreateAgent(\"*\") = %v, want InvalidArgument", err)
	}
}
