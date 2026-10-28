package handlers

// Workflow tool-node dispatch tests (DB-backed, gated on DATABASE_URL like the
// rest of the DB suite). Each drives runWorkflowIfPresent end-to-end so the
// rest.go Deps wiring is what's under test, not just callWorkflowTool.
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	    go test ./internal/handlers/ -run TestWorkflowTool -count=1 -v

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// fakeToolRuntime is a MicroVMDispatcher that also serves ExecTool, standing in
// for RuntimeHandler backed by a real manager.
type fakeToolRuntime struct {
	mu   sync.Mutex
	reqs []*lanternv1.ExecToolRequest
	resp *lanternv1.ExecToolResponse
	err  error
}

func (f *fakeToolRuntime) ScheduleRunInMicroVM(context.Context, string, string, string, string, map[string]any) (string, error) {
	return "", errors.New("not used")
}

func (f *fakeToolRuntime) ExecTool(_ context.Context, _ string, req *lanternv1.ExecToolRequest) (*lanternv1.ExecToolResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	return f.resp, f.err
}

func (f *fakeToolRuntime) calls() []*lanternv1.ExecToolRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*lanternv1.ExecToolRequest(nil), f.reqs...)
}

func okToolResp(t *testing.T, result map[string]any) *lanternv1.ExecToolResponse {
	t.Helper()
	s, err := structpb.NewStruct(result)
	if err != nil {
		t.Fatal(err)
	}
	return &lanternv1.ExecToolResponse{Status: lanternv1.ToolStatus_TOOL_STATUS_OK, Result: s}
}

type toolFixture struct {
	pool      *pgxpool.Pool
	h         *RESTHandler
	agentName string
	runID     string
}

// newToolFixture seeds an agent whose workflow is trigger → <node> → end, plus
// a running run, and a RESTHandler (dispatcher nil = no runtime wired).
func newToolFixture(t *testing.T, node map[string]any, dispatcher MicroVMDispatcher) *toolFixture {
	t.Helper()
	return newToolChainFixture(t, []map[string]any{node}, dispatcher)
}

// newToolChainFixture chains nodes as trigger → n1 → n2 → … → end.
func newToolChainFixture(t *testing.T, chain []map[string]any, dispatcher MicroVMDispatcher) *toolFixture {
	t.Helper()
	pool := openTestPool(t)
	ctx := context.Background()
	agentName := fmt.Sprintf("wf-tool-%d", time.Now().UnixNano())
	nodes := []any{map[string]any{"id": "t", "type": "trigger", "data": map[string]any{}}}
	var edges []any
	prev := "t"
	for i, n := range chain {
		n["id"] = fmt.Sprintf("n%d", i+1)
		nodes = append(nodes, n)
		edges = append(edges, map[string]any{"id": "e" + prev, "source": prev, "target": n["id"]})
		prev = n["id"].(string)
	}
	nodes = append(nodes, map[string]any{"id": "z", "type": "end", "data": map[string]any{}})
	edges = append(edges, map[string]any{"id": "e" + prev, "source": prev, "target": "z"})
	wf, _ := json.Marshal(map[string]any{"nodes": nodes, "edges": edges})
	var agentID string
	if err := pool.QueryRow(ctx, `INSERT INTO agents (tenant_id, name, description, workflow)
		VALUES ($1, $2, 'tool node test', $3::jsonb) RETURNING id::text`,
		recoveryTestDevTenantID, agentName, string(wf)).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	var versionID string
	if err := pool.QueryRow(ctx, `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1', decode(md5($2), 'hex'), 'local://test', '{}'::jsonb) RETURNING id::text`,
		agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	var runID string
	if err := pool.QueryRow(ctx, `INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb, now()) RETURNING id::text`,
		recoveryTestDevTenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, agentName)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, agentName)
		_, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID)
	})

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewRESTHandler(srv, NewAuthHandler(srv, "test-secret"), NewAgentService(srv), NewRunService(srv))
	h.llmProxy = &LlmProxyHandler{} // tool-only graphs never call the LLM
	if dispatcher != nil {
		h.SetMicroVMDispatcher(dispatcher)
	}
	return &toolFixture{pool: pool, h: h, agentName: agentName, runID: runID}
}

func (f *toolFixture) run(t *testing.T) {
	t.Helper()
	if !f.h.runWorkflowIfPresent(context.Background(), f.runID, recoveryTestDevTenantID, f.agentName, map[string]any{}) {
		t.Fatal("runWorkflowIfPresent did not run the workflow")
	}
}

func (f *toolFixture) status(t *testing.T) (status, errMsg string) {
	t.Helper()
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, COALESCE(error->>'message', '') FROM runs WHERE id = $1`, f.runID).Scan(&status, &errMsg); err != nil {
		t.Fatalf("read run: %v", err)
	}
	return status, errMsg
}

func (f *toolFixture) toolCount(t *testing.T, key string) int {
	t.Helper()
	var n int
	_ = f.pool.QueryRow(context.Background(), `SELECT COALESCE(SUM((tool_counts->>$3)::int), 0)
		FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`,
		recoveryTestDevTenantID, f.agentName, key).Scan(&n)
	return n
}

func (f *toolFixture) setToolLimit(t *testing.T, key string, limit int, hardFail bool, usedToday int) {
	t.Helper()
	ctx := context.Background()
	limits, _ := json.Marshal(map[string]int{key: limit})
	if _, err := f.pool.Exec(ctx, `INSERT INTO agent_budgets (tenant_id, agent_name, tool_limits, hard_fail)
		VALUES ($1, $2, $3::jsonb, $4)`, recoveryTestDevTenantID, f.agentName, string(limits), hardFail); err != nil {
		t.Fatalf("insert budget: %v", err)
	}
	for i := 0; i < usedToday; i++ {
		if err := RecordToolUse(ctx, f.pool, recoveryTestDevTenantID, f.agentName, key); err != nil {
			t.Fatalf("seed usage: %v", err)
		}
	}
}

func shellNode() map[string]any {
	return map[string]any{"type": "tool", "data": map[string]any{"tool": "shell_exec", "parameters": map[string]any{"cmd": "echo hi"}}}
}

func TestWorkflowTool_RuntimeSuccess(t *testing.T) {
	rt := &fakeToolRuntime{resp: okToolResp(t, map[string]any{"stdout": "hi\n"})}
	f := newToolFixture(t, shellNode(), rt)
	f.run(t)

	if st, msg := f.status(t); st != "succeeded" {
		t.Fatalf("status = %q (%s), want succeeded", st, msg)
	}
	reqs := rt.calls()
	if len(reqs) != 1 {
		t.Fatalf("ExecTool calls = %d, want 1", len(reqs))
	}
	r := reqs[0]
	if r.GetToolName() != "shell_exec" || r.GetRunId() != f.runID || r.GetStepId() != "n1" ||
		r.GetTenantId() != recoveryTestDevTenantID || r.GetArgs().AsMap()["cmd"] != "echo hi" {
		t.Errorf("unexpected request: %+v", r)
	}
	if want := idempotencyKey(f.runID, "n1", 1); r.GetIdempotencyKey() != want {
		t.Errorf("idempotency key = %q, want %q", r.GetIdempotencyKey(), want)
	}
	if r.GetTimeout() == nil {
		t.Error("expected the step deadline to be forwarded as the tool timeout")
	}
	if n := f.toolCount(t, "shell_exec"); n != 1 {
		t.Errorf("tool_counts[shell_exec] = %d, want 1", n)
	}
	var payload string
	if err := f.pool.QueryRow(context.Background(), `SELECT convert_from(payload, 'UTF8') FROM journal_events
		WHERE run_id = $1 AND step_id = 'n1' AND kind = 'step_completed'`, f.runID).Scan(&payload); err != nil {
		t.Fatalf("step_completed for n1: %v", err)
	}
	if !strings.Contains(payload, "hi") || strings.Contains(payload, "skipped") {
		t.Errorf("step_completed payload = %s", payload)
	}
}

func TestWorkflowTool_FailurePaths(t *testing.T) {
	cases := []struct {
		name      string
		rt        *fakeToolRuntime // nil = no runtime wired at all
		wantErr   string
		wantCount int
	}{
		{"unwired", nil, "tool runtime unavailable", 0},
		{"stub scheduler", &fakeToolRuntime{err: errToolRuntimeUnavailable}, "tool runtime unavailable", 0},
		{"tool error", &fakeToolRuntime{resp: &lanternv1.ExecToolResponse{
			Status: lanternv1.ToolStatus_TOOL_STATUS_ERROR, Error: "exit status 2"}}, "exit status 2", 1},
		{"tool unavailable on vm", &fakeToolRuntime{resp: &lanternv1.ExecToolResponse{
			Status: lanternv1.ToolStatus_TOOL_STATUS_UNAVAILABLE, Error: "no harness"}}, "tool runtime unavailable", 1},
		{"rpc error", &fakeToolRuntime{err: errors.New("rpc error: code = NotFound desc = no active vm")}, "no active vm", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var d MicroVMDispatcher
			if tc.rt != nil {
				d = tc.rt
			}
			f := newToolFixture(t, shellNode(), d)
			f.run(t)
			st, msg := f.status(t)
			if st != "failed" || !strings.Contains(msg, tc.wantErr) {
				t.Fatalf("status=%q msg=%q, want failed containing %q", st, msg, tc.wantErr)
			}
			var failed int
			_ = f.pool.QueryRow(context.Background(), `SELECT count(*) FROM journal_events
				WHERE run_id = $1 AND step_id = 'n1' AND kind = 'step_failed'`, f.runID).Scan(&failed)
			if failed == 0 {
				t.Error("expected a step_failed journal event for n1")
			}
			if n := f.toolCount(t, "shell_exec"); n != tc.wantCount {
				t.Errorf("tool_counts[shell_exec] = %d, want %d", n, tc.wantCount)
			}
		})
	}
}

// TestRuntimeHandler_ExecTool_StubScheduler: the real RuntimeHandler without a
// manager-capable scheduler reports the typed unavailable error.
func TestRuntimeHandler_ExecTool_StubScheduler(t *testing.T) {
	h := &RuntimeHandler{scheduler: &stubSchedulerClient{}}
	if _, err := h.ExecTool(context.Background(), "", &lanternv1.ExecToolRequest{}); !errors.Is(err, errToolRuntimeUnavailable) {
		t.Fatalf("err = %v, want errToolRuntimeUnavailable", err)
	}
}

func TestWorkflowTool_PerToolLimit(t *testing.T) {
	t.Run("hard fail blocks before dispatch", func(t *testing.T) {
		rt := &fakeToolRuntime{resp: okToolResp(t, map[string]any{})}
		f := newToolFixture(t, shellNode(), rt)
		f.setToolLimit(t, "shell_exec", 1, true, 1)
		f.run(t)
		if st, msg := f.status(t); st != "failed" || !strings.Contains(msg, "budget limit exceeded") {
			t.Fatalf("status=%q msg=%q, want failed with budget limit exceeded", st, msg)
		}
		if len(rt.calls()) != 0 {
			t.Error("ExecTool dispatched despite exhausted hard limit")
		}
		if n := f.toolCount(t, "shell_exec"); n != 1 {
			t.Errorf("blocked call was counted: tool_counts = %d, want 1", n)
		}
	})
	t.Run("soft limit proceeds", func(t *testing.T) {
		rt := &fakeToolRuntime{resp: okToolResp(t, map[string]any{})}
		f := newToolFixture(t, shellNode(), rt)
		f.setToolLimit(t, "shell_exec", 1, false, 1)
		f.run(t)
		if st, msg := f.status(t); st != "succeeded" {
			t.Fatalf("status=%q (%s), want succeeded", st, msg)
		}
		if n := f.toolCount(t, "shell_exec"); n != 2 {
			t.Errorf("tool_counts = %d, want 2", n)
		}
	})
	t.Run("under limit proceeds", func(t *testing.T) {
		rt := &fakeToolRuntime{resp: okToolResp(t, map[string]any{})}
		f := newToolFixture(t, shellNode(), rt)
		f.setToolLimit(t, "shell_exec", 2, true, 1)
		f.run(t)
		if st, msg := f.status(t); st != "succeeded" {
			t.Fatalf("status=%q (%s), want succeeded", st, msg)
		}
	})
	t.Run("connector limit keyed connector.action", func(t *testing.T) {
		node := map[string]any{"type": "connector", "data": map[string]any{"connector": "slack", "action": "post"}}
		f := newToolFixture(t, node, nil)
		f.setToolLimit(t, "slack.post", 1, true, 1)
		f.run(t)
		if st, msg := f.status(t); st != "failed" || !strings.Contains(msg, "budget limit exceeded") {
			t.Fatalf("status=%q msg=%q, want failed with budget limit exceeded", st, msg)
		}
	})
}

func TestWorkflowTool_BuiltinWebSearch(t *testing.T) {
	orig := workflowBuiltinTools["web_search"]
	t.Cleanup(func() { workflowBuiltinTools["web_search"] = orig })
	var gotQuery any
	workflowBuiltinTools["web_search"] = func(ctx context.Context, _ *pgxpool.Pool, _ string, params map[string]any) (any, error) {
		gotQuery = params["query"]
		addToolUsage(ctx, "anthropic", "claude-sonnet-4-6", 100, 50)
		return "flight UA1 landed", nil
	}
	rt := &fakeToolRuntime{}
	node := map[string]any{"type": "tool", "data": map[string]any{"tool": "web_search", "parameters": map[string]any{"query": "UA1 status"}}}
	f := newToolFixture(t, node, rt)
	f.run(t)

	if st, msg := f.status(t); st != "succeeded" {
		t.Fatalf("status=%q (%s), want succeeded", st, msg)
	}
	if gotQuery != "UA1 status" {
		t.Errorf("query = %v", gotQuery)
	}
	if len(rt.calls()) != 0 {
		t.Error("built-in tool must not go to the microVM runtime")
	}
	if n := f.toolCount(t, "web_search"); n != 1 {
		t.Errorf("tool_counts[web_search] = %d, want 1", n)
	}
	var tokensIn int64
	_ = f.pool.QueryRow(context.Background(), `SELECT COALESCE(SUM(tokens_in), 0) FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, f.agentName).Scan(&tokensIn)
	if tokensIn != 100 {
		t.Errorf("web_search spend not metered: tokens_in = %d, want 100", tokensIn)
	}
}

// TestWorkflowTool_ResumeSkipsCompletedTool: a re-drive after a crash that
// already journaled step_completed for the tool node must not dispatch again.
func TestWorkflowTool_ResumeSkipsCompletedTool(t *testing.T) {
	rt := &fakeToolRuntime{resp: okToolResp(t, map[string]any{})}
	f := newToolFixture(t, shellNode(), rt)
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, 1000, 'step_completed', 'n1', 1, convert_to('{"output":{"tool_name":"shell_exec","result":{"stdout":"first"}}}', 'UTF8'))`,
		f.runID); err != nil {
		t.Fatalf("seed journal: %v", err)
	}
	f.run(t)
	if st, msg := f.status(t); st != "succeeded" {
		t.Fatalf("status=%q (%s), want succeeded", st, msg)
	}
	if n := len(rt.calls()); n != 0 {
		t.Fatalf("completed tool node re-dispatched %d time(s) on resume", n)
	}
}

// TestWorkflowTool_WebSearchPerRunCap: web_search spend accrues onto the run,
// so once the run is over its per-run cap the next web_search is blocked before
// any spend.
func TestWorkflowTool_WebSearchPerRunCap(t *testing.T) {
	orig := workflowBuiltinTools["web_search"]
	t.Cleanup(func() { workflowBuiltinTools["web_search"] = orig })
	var calls int
	workflowBuiltinTools["web_search"] = func(ctx context.Context, _ *pgxpool.Pool, _ string, _ map[string]any) (any, error) {
		calls++
		addToolUsage(ctx, "anthropic", "claude-sonnet-4-6", 1_000_000, 0)
		return "result", nil
	}
	ws := func() map[string]any {
		return map[string]any{"type": "tool", "data": map[string]any{"tool": "web_search", "parameters": map[string]any{"query": "q"}}}
	}
	f := newToolChainFixture(t, []map[string]any{ws(), ws()}, nil)
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_run, hard_fail)
		VALUES ($1, $2, 0.01, true)`, recoveryTestDevTenantID, f.agentName); err != nil {
		t.Fatalf("insert budget: %v", err)
	}
	f.run(t)

	st, msg := f.status(t)
	if st != "failed" || !strings.Contains(msg, "budget limit exceeded") {
		t.Fatalf("status=%q msg=%q, want failed with budget limit exceeded", st, msg)
	}
	if calls != 1 {
		t.Fatalf("web_search calls = %d, want 1 (second blocked by per-run cap)", calls)
	}
	var stepID string
	_ = f.pool.QueryRow(context.Background(), `SELECT COALESCE(error->>'stepId', '') FROM runs WHERE id = $1`, f.runID).Scan(&stepID)
	if stepID != "n2" {
		t.Errorf("failed at %q, want n2", stepID)
	}
	var cost float64
	if err := f.pool.QueryRow(context.Background(), `SELECT COALESCE(cost_usd, 0)::float8 FROM runs WHERE id = $1`, f.runID).Scan(&cost); err != nil {
		t.Fatalf("read run cost: %v", err)
	}
	if cost <= 0.01 {
		t.Errorf("run cost_usd = %v, want the first web_search accrued over the $0.01 cap", cost)
	}
}
