package handlers

// Park-without-compute integration tests (DB-backed).
//
// Proves the park/resume state machine introduced in the approval-node and
// confidence-gate divert paths:
//
//  1. Park: when a workflow hits an approval node, runs.status = 'waiting',
//     a step_waiting journal event is emitted, and workflow.Run returns with
//     Parked=true (no goroutine held, no step_failed emitted).
//
//  2. Resume: after the operator grants the takeover row, the run is flipped
//     to 'queued' and re-driven. CompletedStep skip proven — nodes completed
//     before the approval node are not re-executed.
//
//  3. Pre-granted idempotency: on a re-drive where a granted/released row
//     already exists, WaitForApproval returns immediately (no new park).
//
//  4. Recovery sweep safety: 'waiting' runs are NOT returned by findOrphanedRuns.
//
//  5. Confidence-gate divert also parks via the same WaitForApproval path.
//
// Gated on DATABASE_URL. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern_ga_gate?sslmode=disable \
//	    go test -p 1 ./internal/handlers/ -run 'Park' -count=1 -v

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"github.com/dshakes/lantern/services/control-plane/internal/workflow"
)

// zeroConfidenceEstimator always returns 0.0, forcing a confidence-gate divert
// on any node regardless of threshold.
type zeroConfidenceEstimator struct{}

func (zeroConfidenceEstimator) Estimate(_ context.Context, _ workflow.Node, _ map[string]any, _ workflow.Sampler) float64 {
	return 0.0
}
func (zeroConfidenceEstimator) Name() string { return "zero_estimator_test" }

// ---- helpers ----------------------------------------------------------------

// makeParkRun seeds a 'running' run and returns its id plus agent name.
// The agent workflow is set separately per test via setAgentWorkflow.
func makeParkRun(t *testing.T, h *RESTHandler) (runID, agentName string) {
	t.Helper()
	ctx := context.Background()
	agentName = fmt.Sprintf("park-test-agent-%d", time.Now().UnixNano())

	var agentID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'park-without-compute test agent')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID)
	})

	var versionID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-park', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := h.srv.Pool.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`,
		versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb, now())
		RETURNING id::text
	`, recoveryTestDevTenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM takeover_requests WHERE run_id = $1`, runID)
	})
	return runID, agentName
}

// setAgentWorkflow writes a workflow graph into the agents row.
func setAgentWorkflow(t *testing.T, h *RESTHandler, agentName string, def workflow.Definition) {
	t.Helper()
	b, _ := json.Marshal(def)
	if _, err := h.srv.Pool.Exec(context.Background(), `
		UPDATE agents SET workflow = $1::jsonb WHERE name = $2 AND tenant_id = $3
	`, string(b), agentName, recoveryTestDevTenantID); err != nil {
		t.Fatalf("setAgentWorkflow: %v", err)
	}
}

// approvalNodeDef returns a graph: trigger → ai-step → approval → end.
func approvalNodeDef() workflow.Definition {
	return workflow.Definition{
		Nodes: []workflow.Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "s1", Type: "ai-step", Data: map[string]any{"prompt": "hello", "capability": "auto"}},
			{ID: "ap", Type: "approval", Data: map[string]any{"reason": "please approve"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []workflow.Edge{
			{ID: "e1", Source: "t", Target: "s1"},
			{ID: "e2", Source: "s1", Target: "ap"},
			{ID: "e3", Source: "ap", Target: "z"},
		},
	}
}

// parkRunStatus queries the current status of a run.
// Named parkRunStatus to avoid collision with runStatus in crash_replay_chaos_test.go.
func parkRunStatus(t *testing.T, h *RESTHandler, runID string) string {
	t.Helper()
	var s string
	if err := h.srv.Pool.QueryRow(context.Background(),
		`SELECT status FROM runs WHERE id = $1`, runID,
	).Scan(&s); err != nil {
		t.Fatalf("parkRunStatus(%s): %v", runID, err)
	}
	return s
}

// hasJournalEvent checks whether a specific kind+stepID event exists in journal_events.
func hasJournalEvent(t *testing.T, h *RESTHandler, runID, kind, stepID string) bool {
	t.Helper()
	var n int
	_ = h.srv.Pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM journal_events
		WHERE run_id = $1 AND kind = $2 AND step_id = $3
	`, runID, kind, stepID).Scan(&n)
	return n > 0
}

// newParkHandler builds a minimal RESTHandler for park tests (no llmProxy needed).
func newParkHandler(t *testing.T) *RESTHandler {
	t.Helper()
	pool := openTestPool(t)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, "test-secret")
	return NewRESTHandler(srv, auth, NewAgentService(srv), NewRunService(srv))
}

// parkWaitForApproval is the production-faithful WaitForApproval stub used in
// tests: grant-check-first, then park.
func parkWaitForApproval(h *RESTHandler) func(ctx context.Context, runID, stepID, reason string) (workflow.ApprovalDisposition, error) {
	return func(ctx context.Context, runID, stepID, reason string) (workflow.ApprovalDisposition, error) {
		var notes string
		err := h.srv.Pool.QueryRow(ctx, `
			SELECT COALESCE(notes, '')
			FROM takeover_requests
			WHERE run_id = $1
			  AND (step_id = $2 OR step_id IS NULL OR step_id = '')
			  AND status IN ('granted', 'released')
			ORDER BY created_at DESC LIMIT 1
		`, runID, stepID).Scan(&notes)
		if err == nil {
			return workflow.ApprovalDisposition{Granted: true, Reason: notes}, nil
		}
		// Park.
		_, _ = h.srv.Pool.Exec(ctx, `
			INSERT INTO takeover_requests (run_id, tenant_id, step_id, reason, status, expires_at)
			VALUES ($1, $2, $3, $4, 'pending', now() + interval '30 minutes')
		`, runID, recoveryTestDevTenantID, stepID, reason)
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE runs SET status = 'waiting' WHERE id = $1 AND status IN ('running', 'queued')
		`, runID)
		return workflow.ApprovalDisposition{}, workflow.ErrRunParked
	}
}

// parkEmitJournal writes one journal row using the self-computing seq pattern.
func parkEmitJournal(ctx context.Context, h *RESTHandler, runID, kind, stepID string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	_, _ = h.srv.Pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		SELECT $1,
		       COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1), 0) + 1,
		       $2, $3, 1, $4
		ON CONFLICT DO NOTHING
	`, runID, kind, stepID, raw)
}

// ---- tests ------------------------------------------------------------------

// TestPark_ApprovalNode proves the core park path: workflow.Run returns
// Parked=true, step_waiting is journaled, and no step_failed is emitted.
func TestPark_ApprovalNode(t *testing.T) {
	h := newParkHandler(t)
	ctx := context.Background()

	runID, agentName := makeParkRun(t, h)
	setAgentWorkflow(t, h, agentName, approvalNodeDef())

	var aiStepCalled int
	deps := workflow.Deps{
		CallLLM: func(_ context.Context, prompt, _ string) (string, error) {
			aiStepCalled++
			return "ai replied: " + prompt, nil
		},
		EmitEvent: func(emitCtx context.Context, ev workflow.JournalEvent) error {
			parkEmitJournal(emitCtx, h, runID, ev.Kind, ev.StepID, ev.Payload)
			return nil
		},
		WaitForApproval: parkWaitForApproval(h),
		CompletedStep:   h.journalCompletedStep,
	}

	res, err := workflow.Run(ctx, runID, deps, approvalNodeDef(), map[string]any{})
	if err != nil {
		t.Fatalf("workflow.Run returned error: %v", err)
	}
	if res.Failed {
		t.Fatalf("want Parked, got Failed: %s", res.LastError)
	}
	if !res.Parked {
		t.Fatal("want res.Parked=true, got false")
	}
	// ai-step ran before parking.
	if aiStepCalled != 1 {
		t.Errorf("ai-step called %d times, want 1", aiStepCalled)
	}
	// step_waiting must be journaled for the approval node.
	if !hasJournalEvent(t, h, runID, "step_waiting", "ap") {
		t.Error("expected step_waiting event for approval node 'ap'")
	}
	// No step_failed for the approval node.
	if hasJournalEvent(t, h, runID, "step_failed", "ap") {
		t.Error("step_failed emitted for approval node — should not happen on park")
	}
	// runs.status must be 'waiting'.
	if s := parkRunStatus(t, h, runID); s != "waiting" {
		t.Errorf("runs.status = %q, want 'waiting'", s)
	}
}

// TestPark_GrantResumesAndCompletes proves the full park → grant → resume cycle.
// After parking: operator grants → run flips 'queued' → re-drive via workflow.Run.
// On re-drive: ai-step NOT re-called (CompletedStep skip), approval passes through
// (grant-check-first), workflow completes.
func TestPark_GrantResumesAndCompletes(t *testing.T) {
	h := newParkHandler(t)
	ctx := context.Background()

	runID, agentName := makeParkRun(t, h)
	setAgentWorkflow(t, h, agentName, approvalNodeDef())

	var (
		mu          sync.Mutex
		aiCallCount int
	)

	emitFn := func(emitCtx context.Context, ev workflow.JournalEvent) error {
		parkEmitJournal(emitCtx, h, runID, ev.Kind, ev.StepID, ev.Payload)
		return nil
	}
	callLLM := func(_ context.Context, _, _ string) (string, error) {
		mu.Lock()
		aiCallCount++
		mu.Unlock()
		return "ai output", nil
	}

	deps := workflow.Deps{
		CallLLM:         callLLM,
		EmitEvent:       emitFn,
		WaitForApproval: parkWaitForApproval(h),
		CompletedStep:   h.journalCompletedStep,
	}

	// Phase 1: park.
	res1, _ := workflow.Run(ctx, runID, deps, approvalNodeDef(), map[string]any{})
	if !res1.Parked {
		t.Fatalf("first run: want Parked=true, got Failed=%v Parked=%v err=%s",
			res1.Failed, res1.Parked, res1.LastError)
	}
	if s := parkRunStatus(t, h, runID); s != "waiting" {
		t.Fatalf("after park: status=%q, want 'waiting'", s)
	}

	aiCallCountAfterPark := aiCallCount

	// Phase 2: operator grants and flips run to 'queued'.
	_, _ = h.srv.Pool.Exec(ctx, `
		UPDATE takeover_requests
		SET status = 'granted', granted_at = now(), notes = 'test grant'
		WHERE run_id = $1 AND status = 'pending'
	`, runID)
	_, _ = h.srv.Pool.Exec(ctx, `
		UPDATE runs SET status = 'queued' WHERE id = $1 AND status = 'waiting'
	`, runID)
	if s := parkRunStatus(t, h, runID); s != "queued" {
		t.Fatalf("after grant: status=%q, want 'queued'", s)
	}

	// Phase 3: re-drive. ai-step must NOT be re-called (CompletedStep skip).
	res2, err := workflow.Run(ctx, runID, deps, approvalNodeDef(), map[string]any{})
	if err != nil {
		t.Fatalf("redrive workflow.Run: %v", err)
	}
	if res2.Failed {
		t.Fatalf("redrive: want success, got Failed: %s", res2.LastError)
	}
	if res2.Parked {
		t.Fatal("redrive: re-parked unexpectedly (grant-check-first failed)")
	}
	// ai-step must NOT have been called again.
	if aiCallCount > aiCallCountAfterPark {
		t.Errorf("ai-step re-called %d extra time(s) on redrive; want 0 (CompletedStep should skip it)",
			aiCallCount-aiCallCountAfterPark)
	}
}

// TestPark_PreGrantedPassesThrough: when a granted takeover row already exists
// at the start of WaitForApproval (re-drive scenario), it returns immediately
// without parking again.
func TestPark_PreGrantedPassesThrough(t *testing.T) {
	h := newParkHandler(t)
	ctx := context.Background()

	runID, _ := makeParkRun(t, h)

	// Pre-seed a granted row (simulating prior park + operator grant).
	_, _ = h.srv.Pool.Exec(ctx, `
		INSERT INTO takeover_requests
		    (run_id, tenant_id, step_id, reason, status, expires_at, granted_at, notes)
		VALUES ($1, $2, 'ap', 'please approve', 'granted',
		        now() + interval '30 minutes', now(), 'pre-seeded grant')
	`, runID, recoveryTestDevTenantID)

	parkCalled := false
	deps := workflow.Deps{
		CallLLM: func(_ context.Context, _, _ string) (string, error) {
			return "ok", nil
		},
		EmitEvent: func(emitCtx context.Context, ev workflow.JournalEvent) error {
			parkEmitJournal(emitCtx, h, runID, ev.Kind, ev.StepID, ev.Payload)
			return nil
		},
		WaitForApproval: func(waitCtx context.Context, rID, stepID, _ string) (workflow.ApprovalDisposition, error) {
			// Inline grant-check-first.
			var n string
			if err := h.srv.Pool.QueryRow(waitCtx, `
				SELECT COALESCE(notes, '')
				FROM takeover_requests
				WHERE run_id = $1
				  AND (step_id = $2 OR step_id IS NULL OR step_id = '')
				  AND status IN ('granted', 'released')
				ORDER BY created_at DESC LIMIT 1
			`, rID, stepID).Scan(&n); err == nil {
				return workflow.ApprovalDisposition{Granted: true, Reason: n}, nil
			}
			// Should not reach here — pre-seeded grant must be found above.
			parkCalled = true
			return workflow.ApprovalDisposition{}, workflow.ErrRunParked
		},
		CompletedStep: h.journalCompletedStep,
	}

	_, _ = h.srv.Pool.Exec(ctx, `UPDATE runs SET status = 'running' WHERE id = $1`, runID)

	res, err := workflow.Run(ctx, runID, deps, approvalNodeDef(), map[string]any{})
	if err != nil {
		t.Fatalf("workflow.Run: %v", err)
	}
	if res.Parked {
		t.Error("workflow was parked again despite existing grant — grant-check-first failed")
	}
	if res.Failed {
		t.Errorf("workflow failed: %s", res.LastError)
	}
	if parkCalled {
		t.Error("WaitForApproval park path reached — should have short-circuited via grant-check-first")
	}
}

// TestPark_RecoverySweepIgnoresWaiting confirms that 'waiting' runs are NOT
// returned by findOrphanedRuns even when the run lock is absent.
func TestPark_RecoverySweepIgnoresWaiting(t *testing.T) {
	h := newParkHandler(t)
	ctx := context.Background()

	runID, _ := makeParkRun(t, h)

	// Put the run into 'waiting' state with no lock row.
	_, _ = h.srv.Pool.Exec(ctx, `UPDATE runs SET status = 'waiting' WHERE id = $1`, runID)
	_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM run_locks WHERE run_id = $1`, runID)

	orphans, err := findOrphanedRuns(ctx, h.srv.Pool)
	if err != nil {
		t.Fatalf("findOrphanedRuns: %v", err)
	}
	for _, o := range orphans {
		if o.runID == runID {
			t.Errorf("findOrphanedRuns returned 'waiting' run %s — should be excluded", runID)
		}
	}
}

// TestPark_ConfidenceDivertParks checks that a confidence-gate divert (score=0
// below any threshold > 0) reaches WaitForApproval and parks the run.
// This is a pure in-memory test (no DB) — it proves the interpreter wiring.
func TestPark_ConfidenceDivertParks(t *testing.T) {
	parkHit := false
	deps := workflow.Deps{
		CallLLM: func(_ context.Context, _, _ string) (string, error) { return "ok", nil },
		CallTool: func(_ context.Context, _ string, _ map[string]any) (any, error) {
			return map[string]any{"result": "tool ran"}, nil
		},
		EmitEvent: func(_ context.Context, _ workflow.JournalEvent) error { return nil },
		WaitForApproval: func(_ context.Context, _, _, _ string) (workflow.ApprovalDisposition, error) {
			parkHit = true
			return workflow.ApprovalDisposition{}, workflow.ErrRunParked
		},
		ConfidenceGate: &workflow.ConfidenceGate{
			Estimator: zeroConfidenceEstimator{},
			Threshold: 0.5,
		},
	}

	// Graph: trigger → tool → end.
	def := workflow.Definition{
		Nodes: []workflow.Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "tool1", Type: "tool", Data: map[string]any{"tool": "web.search", "parameters": ""}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []workflow.Edge{
			{ID: "e1", Source: "t", Target: "tool1"},
			{ID: "e2", Source: "tool1", Target: "z"},
		},
	}

	res, err := workflow.Run(context.Background(), "fake-run-id", deps, def, map[string]any{})
	if err != nil {
		t.Fatalf("workflow.Run: %v", err)
	}
	if !parkHit {
		t.Error("WaitForApproval was not called for confidence-gate divert")
	}
	if !res.Parked {
		t.Errorf("want Parked=true for confidence divert, got Failed=%v LastError=%s",
			res.Failed, res.LastError)
	}
	if res.Failed {
		t.Errorf("confidence-gate divert should not mark run failed, got LastError=%s", res.LastError)
	}
}
