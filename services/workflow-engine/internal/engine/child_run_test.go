package engine

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// TestChildDepthAllowed pins the cycle guard at its boundary.
//
// This cap is the only thing between a workflow that invokes itself and
// unbounded recursion, and an off-by-one here is invisible until something is
// already 6 runs deep in production.
func TestChildDepthAllowed(t *testing.T) {
	for _, tc := range []struct {
		parentDepth int
		want        bool
	}{
		{0, true},                    // top-level run spawning its first child
		{maxChildRunDepth - 1, true}, // last child that may still be created
		{maxChildRunDepth, false},    // one past the cap
		{maxChildRunDepth + 3, false},
	} {
		if got := childDepthAllowed(tc.parentDepth); got != tc.want {
			t.Errorf("childDepthAllowed(%d) = %v, want %v", tc.parentDepth, got, tc.want)
		}
	}
}

// TestIsTerminalRunStatus guards the branch that decides whether an adopted
// child is re-driven. Treating a finished run as unfinished would re-execute
// an agent that already ran.
func TestIsTerminalRunStatus(t *testing.T) {
	terminal := []string{"succeeded", "failed", "cancelled", "canceled"}
	for _, s := range terminal {
		if !isTerminalRunStatus(s) {
			t.Errorf("isTerminalRunStatus(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"queued", "running", "paused", "resumable", ""} {
		if isTerminalRunStatus(s) {
			t.Errorf("isTerminalRunStatus(%q) = true, want false", s)
		}
	}
}

// fakeRow returns a fixed depth (or error) for childRunDepth.
type fakeRow struct {
	depth int
	err   error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) > 0 {
		if p, ok := dest[0].(*int); ok {
			*p = r.depth
		}
	}
	return nil
}

type fakeQuerier struct {
	row      fakeRow
	gotSQL   string
	gotArgs  []any
	numCalls int
}

func (q *fakeQuerier) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	q.gotSQL = sql
	q.gotArgs = args
	q.numCalls++
	return q.row
}

// TestChildRunDepth checks the ancestor walk is bounded and reads back the
// depth the guard then acts on.
func TestChildRunDepth(t *testing.T) {
	q := &fakeQuerier{row: fakeRow{depth: 3}}
	got, err := childRunDepth(context.Background(), q, "run-x", "tenant-1")
	if err != nil {
		t.Fatalf("childRunDepth: %v", err)
	}
	if got != 3 {
		t.Errorf("depth = %d, want 3", got)
	}
	if len(q.gotArgs) != 3 || q.gotArgs[0] != "run-x" || q.gotArgs[1] != childChainScanLimit || q.gotArgs[2] != "tenant-1" {
		t.Errorf("args = %v, want [run-x %d tenant-1]", q.gotArgs, childChainScanLimit)
	}
	// The walk must be tenant-filtered, not left to a default-off policy.
	if !contains(q.gotSQL, "tenant_id = $3") {
		t.Error("ancestor walk has no explicit tenant predicate")
	}
	// A malformed parent chain must not become an unbounded recursion.
	if !contains(q.gotSQL, "c.depth <") {
		t.Error("recursive walk is not bounded by a depth predicate")
	}

	q.row = fakeRow{err: errors.New("boom")}
	if _, err := childRunDepth(context.Background(), q, "run-x", "tenant-1"); err == nil {
		t.Error("expected the query error to propagate, not a silent depth 0")
	}
}

// TestExecuteChildRun_DispatchesToRunner verifies the step forwards exactly the
// identifiers the child needs — in particular the PARENT run + step, which are
// what make a replayed step adopt its existing child instead of starting a
// second agent run.
func TestExecuteChildRun_DispatchesToRunner(t *testing.T) {
	var gotParentRun, gotStep, gotTenant, gotAgent string
	var gotInput json.RawMessage

	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	se.childRunner = func(_ context.Context, st *RunState, parentStepID, agentName string, input json.RawMessage) (json.RawMessage, error) {
		gotParentRun, gotStep, gotTenant, gotAgent, gotInput = st.RunID, parentStepID, st.TenantID, agentName, input
		return json.RawMessage(`{"child_run_id":"child-9","status":"succeeded"}`), nil
	}

	state := NewRunState("run-1", "tenant-1", "v1")
	out, err := se.executeChildRun(
		context.Background(), state, "step-7", "run-1:step-7:1",
		json.RawMessage(`{"agent_name":"researcher","input":{"q":"hi"}}`),
	)
	if err != nil {
		t.Fatalf("executeChildRun: %v", err)
	}
	if gotParentRun != "run-1" || gotStep != "step-7" || gotTenant != "tenant-1" || gotAgent != "researcher" {
		t.Errorf("forwarded (%q,%q,%q,%q), want (run-1,step-7,tenant-1,researcher)",
			gotParentRun, gotStep, gotTenant, gotAgent)
	}
	if string(gotInput) != `{"q":"hi"}` {
		t.Errorf("input = %s, want {\"q\":\"hi\"}", gotInput)
	}
	if !contains(string(out), "child-9") {
		t.Errorf("output = %s, want the runner's result", out)
	}
}

// TestExecuteChildRun_RunnerError surfaces a child failure rather than
// reporting a step that quietly succeeded with no child.
func TestExecuteChildRun_RunnerError(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	se.childRunner = func(_ context.Context, _ *RunState, _, _ string, _ json.RawMessage) (json.RawMessage, error) {
		return nil, ErrChildRunDepthExceeded
	}
	state := NewRunState("run-1", "tenant-1", "v1")

	_, err := se.executeChildRun(context.Background(), state, "s", "k", json.RawMessage(`{"agent_name":"loop"}`))
	if !errors.Is(err, ErrChildRunDepthExceeded) {
		t.Fatalf("err = %v, want ErrChildRunDepthExceeded", err)
	}
}

// TestExecuteChildRun_RequiresAgentName rejects a payload that names no agent,
// before any run row is created.
func TestExecuteChildRun_RequiresAgentName(t *testing.T) {
	called := false
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	se.childRunner = func(_ context.Context, _ *RunState, _, _ string, _ json.RawMessage) (json.RawMessage, error) {
		called = true
		return nil, nil
	}
	state := NewRunState("run-1", "tenant-1", "v1")

	if _, err := se.executeChildRun(context.Background(), state, "s", "k", json.RawMessage(`{"input":{}}`)); err == nil {
		t.Fatal("expected an error when agent_name is missing")
	}
	if called {
		t.Error("child runner was invoked despite a missing agent_name")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle ||
		len(needle) == 0 ||
		indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

// TestIsPausedRunStatus separates "waiting" from "finished".
//
// The first cut treated any non-succeeded status as a failure, so a child that
// paused for human approval failed its parent — which would have made approval
// inside a child run impossible, quietly.
func TestIsPausedRunStatus(t *testing.T) {
	for _, s := range []string{"paused", "resumable"} {
		if !isPausedRunStatus(s) {
			t.Errorf("isPausedRunStatus(%q) = false, want true", s)
		}
		if isTerminalRunStatus(s) {
			t.Errorf("isTerminalRunStatus(%q) = true — paused is not finished", s)
		}
	}
	for _, s := range []string{"succeeded", "failed", "running", "queued"} {
		if isPausedRunStatus(s) {
			t.Errorf("isPausedRunStatus(%q) = true, want false", s)
		}
	}
}

// TestExecuteChildRun_PausedIsTypedFailure: a paused child still fails the
// step — what the typed error buys is telling "waiting on a human" apart from
// "the child broke". Named for what it does, not what it might imply.
func TestExecuteChildRun_PausedIsTypedFailure(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	se.childRunner = func(_ context.Context, _ *RunState, _, _ string, _ json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"status":"paused"}`), ErrChildRunPaused
	}
	state := NewRunState("run-1", "tenant-1", "v1")

	_, err := se.executeChildRun(context.Background(), state, "s", "k", json.RawMessage(`{"agent_name":"approver"}`))
	if !errors.Is(err, ErrChildRunPaused) {
		t.Fatalf("err = %v, want ErrChildRunPaused", err)
	}
	if errors.Is(err, ErrChildRunDepthExceeded) {
		t.Error("a paused child must not be reported as a depth violation")
	}
}

// TestExecuteAttempt_ReplaySkipsExecution proves the executor HONOURS the
// replay cache — not merely that the cache stores things.
//
// The existing TestStepReplay exercises SetStepResult/HasStepResult in
// isolation: it shows the map works. It does not show that executeAttempt
// consults it, and that gap let me claim (wrongly, and repeatedly) that the
// durable engine re-executes completed steps on replay. A test asserting the
// map round-trips cannot catch a missing call site.
//
// This one is decisive because the executor has NO model client: if the replay
// check were skipped, the llm_call would fail with ErrModelRouterUnavailable.
// Returning the cached output instead can only happen if execution was skipped.
// It also touches no database — the replay check returns before step_started is
// journaled, which is itself part of the contract.
func TestExecuteAttempt_ReplaySkipsExecution(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil) // nil model client
	state := NewRunState("run-1", "tenant-1", "v1")

	cached := &StepResult{
		StepID:  "step-1",
		Attempt: 1,
		Output:  json.RawMessage(`{"answer":42}`),
	}
	state.SetStepResult(stepCacheKey("step-1", 1), cached)

	got, err := se.executeAttempt(context.Background(), state, "step-1", 1, &StepPayload{
		Kind: "llm_call",
		Data: json.RawMessage(`{"capability":"reasoning-large","prompt":"hi"}`),
	})
	if err != nil {
		t.Fatalf("replayed step returned an error (it re-executed): %v", err)
	}
	if errors.Is(err, ErrModelRouterUnavailable) {
		t.Fatal("step was re-executed on replay instead of served from cache")
	}
	if string(got.Output) != `{"answer":42}` {
		t.Errorf("output = %s, want the cached result", got.Output)
	}

	// A DIFFERENT attempt must NOT hit attempt 1's entry, or a retry would
	// replay the failure it is retrying. Asserted on the key rather than by
	// executing: a cache MISS proceeds to journal step_started, which needs a
	// database — and with a nil pool that panics, which is how the assertion
	// above is known to be decisive rather than vacuous.
	if _, ok := state.HasStepResult(stepCacheKey("step-1", 2)); ok {
		t.Error("attempt 2 hits attempt 1's cache entry; retries would never re-run")
	}
}
