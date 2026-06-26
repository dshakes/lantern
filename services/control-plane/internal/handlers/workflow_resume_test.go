package handlers

// Durable workflow-resume integration tests (DB-backed).
//
// These prove the P3-durable invariant (#3): on a re-drive after a crash, the
// workflow interpreter SKIPS nodes already recorded as step_completed in
// journal_events and RESUMES from the first incomplete node — it does not
// restart from scratch and re-execute completed (side-effecting) steps.
//
// The hook under test is the real production closure RESTHandler.journalCompletedStep,
// wired into workflow.Deps.CompletedStep exactly as runWorkflowIfPresent wires it.
// The side-effecting deps (CallConnector / CallLLM) are instrumented to count
// invocations so we can assert that a completed node's dep is never re-called.
//
// Gated on DATABASE_URL (same convention as the rest of the DB suite). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	    go test ./internal/handlers/ -run 'Resume' -count=1 -v

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

// emitJournal writes a single journal_events row using the same self-computing
// seq form the production EmitEvent closure uses.
func emitJournal(t *testing.T, ctx context.Context, h *RESTHandler, runID, kind, stepID string, payload map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	_, err := h.srv.Pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		SELECT $1,
		       COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1), 0) + 1,
		       $2, $3, 1, $4
	`, runID, kind, stepID, raw)
	if err != nil {
		t.Fatalf("emitJournal(%s/%s): %v", kind, stepID, err)
	}
}

// makeResumeRun seeds an agent + version + running run and returns its id.
func makeResumeRun(t *testing.T, h *RESTHandler) string {
	t.Helper()
	ctx := context.Background()
	agentName := fmt.Sprintf("resume-test-agent-%d", time.Now().UnixNano())

	var agentID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'workflow resume test agent')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	t.Cleanup(func() { _, _ = h.srv.Pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID) })

	var versionID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-resume', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := h.srv.Pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	var runID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb, now() - interval '5 minutes')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
	})
	return runID
}

// twoConnectorDef is a linear graph: trigger → c1 (connector) → c2 (connector) → end.
func twoConnectorDef() workflow.Definition {
	return workflow.Definition{
		Nodes: []workflow.Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "c1", Type: "connector", Data: map[string]any{"connector": "slack", "action": "post_message"}},
			{ID: "c2", Type: "connector", Data: map[string]any{"connector": "slack", "action": "post_message"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []workflow.Edge{
			{ID: "e1", Source: "t", Target: "c1"},
			{ID: "e2", Source: "c1", Target: "c2"},
			{ID: "e3", Source: "c2", Target: "z"},
		},
	}
}

// TestResume_SkipsCompletedStepReexecutesIncomplete is the core durable-resume
// proof. It seeds a run whose first connector node (c1) already has a
// step_completed row in journal_events (simulating a crash AFTER c1 sent but
// BEFORE c2). On re-drive via workflow.Run with the real journalCompletedStep
// hook, c1's connector dep must NOT fire again (no double side-effect) and c2's
// must fire exactly once (resume from the first incomplete node).
func TestResume_SkipsCompletedStepReexecutesIncomplete(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, NewAgentService(srv), NewRunService(srv))

	runID := makeResumeRun(t, h)

	// Pre-seed the journal as if a prior attempt got through the trigger and c1
	// before crashing: workflow.started, step_started(c1), step_completed(c1).
	emitJournal(t, ctx, h, runID, "workflow.started", "", map[string]any{})
	emitJournal(t, ctx, h, runID, "step_started", "c1", map[string]any{"type": "connector"})
	emitJournal(t, ctx, h, runID, "step_completed", "c1", map[string]any{
		"type":   "connector",
		"name":   "slack post",
		"output": map[string]any{"connector": "slack", "ok": true, "from": "first-attempt"},
	})

	// Instrument the side-effecting deps to record which connectors fire on
	// re-drive.
	var mu sync.Mutex
	connectorCalls := map[string]int{}
	deps := workflow.Deps{
		CallConnector: func(_ context.Context, connectorID, action string, _ map[string]any) (any, error) {
			mu.Lock()
			connectorCalls[action]++
			callNo := connectorCalls[action]
			mu.Unlock()
			return map[string]any{"connector": connectorID, "ok": true, "from": "re-drive", "call": callNo}, nil
		},
		EmitEvent: func(emitCtx context.Context, ev workflow.JournalEvent) error {
			payload, _ := json.Marshal(ev.Payload)
			_, err := h.srv.Pool.Exec(emitCtx,
				`INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (run_id, seq) DO NOTHING`,
				ev.RunID, ev.Seq, ev.Kind, ev.StepID, ev.Attempt, payload,
			)
			return err
		},
		// The real production resume hook — answers from journal_events.
		CompletedStep: h.journalCompletedStep,
	}

	res, err := workflow.Run(ctx, runID, deps, twoConnectorDef(), map[string]any{})
	if err != nil {
		t.Fatalf("workflow.Run (re-drive): %v", err)
	}
	if res.Failed {
		t.Fatalf("workflow re-drive failed: %s", res.LastError)
	}

	mu.Lock()
	defer mu.Unlock()
	// post_message is the action for BOTH connector nodes. c1 was already
	// completed (skipped), c2 runs once → total exactly 1 invocation.
	if got := connectorCalls["post_message"]; got != 1 {
		t.Fatalf("expected connector dep to fire exactly ONCE on re-drive (c2 only); "+
			"got %d (c1 must be skipped from journal, no double side-effect)", got)
	}

	// The run must have completed (walked through to the end node).
	if res.StepsRan < 1 {
		t.Errorf("expected at least 1 step run on resume, got %d", res.StepsRan)
	}

	// The original first-attempt output for c1 must still be preserved in the
	// journal — the resume reused it, it was never recomputed by re-invoking
	// the connector. (The interpreter appends a second, formatted step_completed
	// for the skipped node; the original row carrying the structured output
	// remains, so the first-attempt result is not lost.)
	rows, err := pool.Query(ctx, `
		SELECT payload FROM journal_events
		WHERE run_id = $1 AND step_id = 'c1' AND kind = 'step_completed'
	`, runID)
	if err != nil {
		t.Fatalf("read c1 step_completed: %v", err)
	}
	defer rows.Close()
	foundOriginal := false
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatalf("scan c1 payload: %v", err)
		}
		var p map[string]any
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if out, ok := p["output"].(map[string]any); ok {
			if from, _ := out["from"].(string); from == "first-attempt" {
				foundOriginal = true
			}
		}
	}
	if !foundOriginal {
		t.Errorf("expected the original first-attempt c1 step_completed to remain in the journal — resume must reuse it, not recompute c1")
	}
}

// TestResume_NoCompletedStepsRunsAllNodes is the control: with an empty journal
// (a fresh run, not a crash), journalCompletedStep returns done=false for every
// node, so the full graph executes — both connector nodes fire.
func TestResume_NoCompletedStepsRunsAllNodes(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, NewAgentService(srv), NewRunService(srv))

	runID := makeResumeRun(t, h)
	// No pre-seeded step_completed rows — this is a first execution.

	var mu sync.Mutex
	calls := 0
	deps := workflow.Deps{
		CallConnector: func(_ context.Context, connectorID, _ string, _ map[string]any) (any, error) {
			mu.Lock()
			calls++
			mu.Unlock()
			return map[string]any{"connector": connectorID, "ok": true}, nil
		},
		EmitEvent: func(emitCtx context.Context, ev workflow.JournalEvent) error {
			payload, _ := json.Marshal(ev.Payload)
			_, err := h.srv.Pool.Exec(emitCtx,
				`INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
				 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, seq) DO NOTHING`,
				ev.RunID, ev.Seq, ev.Kind, ev.StepID, ev.Attempt, payload,
			)
			return err
		},
		CompletedStep: h.journalCompletedStep,
	}

	res, err := workflow.Run(ctx, runID, deps, twoConnectorDef(), map[string]any{})
	if err != nil {
		t.Fatalf("workflow.Run (fresh): %v", err)
	}
	if res.Failed {
		t.Fatalf("fresh workflow failed: %s", res.LastError)
	}

	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Errorf("expected BOTH connector nodes to fire on a fresh run, got %d", calls)
	}
}

// TestResume_CompletedStepReturnsCachedOutput verifies journalCompletedStep
// reads back the exact cached output map a prior step_completed wrote, so the
// resumed run propagates the original result downstream (not a re-computed one).
func TestResume_CompletedStepReturnsCachedOutput(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, NewAgentService(srv), NewRunService(srv))

	runID := makeResumeRun(t, h)

	emitJournal(t, ctx, h, runID, "step_completed", "n1", map[string]any{
		"type":   "ai-step",
		"output": "the cached answer",
	})

	out, done, err := h.journalCompletedStep(ctx, runID, "n1")
	if err != nil {
		t.Fatalf("journalCompletedStep: %v", err)
	}
	if !done {
		t.Fatalf("expected done=true for a node with a step_completed row")
	}
	if got, _ := out["result"].(string); got != "the cached answer" {
		t.Errorf("expected cached string output mapped to result=%q, got %v", "the cached answer", out)
	}

	// A node with no journal row must report done=false (re-execute).
	_, done2, err := h.journalCompletedStep(ctx, runID, "does-not-exist")
	if err != nil {
		t.Fatalf("journalCompletedStep (miss): %v", err)
	}
	if done2 {
		t.Errorf("expected done=false for a node with no step_completed row")
	}
}
