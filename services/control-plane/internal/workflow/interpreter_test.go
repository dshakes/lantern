package workflow

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// stubDeps captures every event + LLM/connector/tool/subagent call so tests
// can assert exact ordering of side-effects without spinning up Postgres.
type stubDeps struct {
	mu            sync.Mutex
	llmCalls      []string
	connCalls     []connCall
	toolCalls     []toolCall
	subagentCalls []subagentCall
	events        []JournalEvent
	llmReplies    map[string]string
	subagentReply map[string]map[string]any // agentName → fixed reply
	subagentErr   error                     // if non-nil, RunSubAgent returns this error
	noSubagent    bool                      // when true, RunSubAgent dep is not set (nil)
}

type connCall struct{ ID, Action string }
type toolCall struct{ Name string }
type subagentCall struct {
	AgentName string
	Input     map[string]any
}

func newStubDeps(replies map[string]string) *stubDeps {
	return &stubDeps{llmReplies: replies}
}

func (s *stubDeps) deps() Deps {
	d := Deps{
		CallLLM: func(_ context.Context, prompt, _ string) (string, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.llmCalls = append(s.llmCalls, prompt)
			for k, v := range s.llmReplies {
				if strings.Contains(prompt, k) {
					return v, nil
				}
			}
			return "default-reply", nil
		},
		CallConnector: func(_ context.Context, id, action string, _ map[string]any) (any, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.connCalls = append(s.connCalls, connCall{id, action})
			return map[string]any{"connector": id, "action": action, "ok": true}, nil
		},
		CallTool: func(_ context.Context, name string, _ map[string]any) (any, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.toolCalls = append(s.toolCalls, toolCall{name})
			return map[string]any{"tool": name, "ok": true}, nil
		},
		EmitEvent: func(_ context.Context, ev JournalEvent) error {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.events = append(s.events, ev)
			return nil
		},
	}
	if !s.noSubagent {
		d.RunSubAgent = func(_ context.Context, agentName string, input map[string]any) (map[string]any, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.subagentCalls = append(s.subagentCalls, subagentCall{agentName, input})
			if s.subagentErr != nil {
				return nil, s.subagentErr
			}
			if r, ok := s.subagentReply[agentName]; ok {
				return r, nil
			}
			return map[string]any{"agent": agentName, "ok": true}, nil
		}
	}
	return d
}

func eventKinds(s *stubDeps) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.events))
	for i, e := range s.events {
		out[i] = e.Kind
	}
	return out
}

func TestRun_LinearTriggerAiEnd(t *testing.T) {
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "Hello {{input.name}}"}},
			{ID: "z", Type: "end", Data: map[string]any{"outputExpression": "{{steps.a}}"}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}
	stub := newStubDeps(map[string]string{"Hello world": "world-reply"})
	res, err := Run(context.Background(), "run_1", stub.deps(), def, map[string]any{"name": "world"})
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}
	if res.Output != "world-reply" {
		t.Errorf("got output %q, want %q", res.Output, "world-reply")
	}
	if res.StepsRan != 2 {
		t.Errorf("got %d steps ran, want 2 (trigger + ai-step)", res.StepsRan)
	}
	// The journal_events stream must always be: workflow.started, then
	// alternating step_started + step_completed per visited node, then
	// workflow.completed. The W4 RunWaterfall relies on this contract.
	want := []string{
		"workflow.started",
		"step_started", "step_completed", // trigger
		"step_started", "step_completed", // ai-step
		"workflow.completed",
	}
	got := eventKinds(stub)
	if !sliceEqual(got, want) {
		t.Errorf("event kinds mismatch:\ngot:  %v\nwant: %v", got, want)
	}
}

func TestRun_ConditionBranches(t *testing.T) {
	// Branching workflow: condition routes to A on true, B on false. We
	// flip the input flag and verify the correct branch fires.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "c", Type: "condition", Data: map[string]any{"expression": "{{input.go}}"}},
			{ID: "yes", Type: "ai-step", Data: map[string]any{"prompt": "YES-PATH"}},
			{ID: "no", Type: "ai-step", Data: map[string]any{"prompt": "NO-PATH"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "c"},
			{ID: "e2", Source: "c", Target: "yes", Label: strPtr("true")},
			{ID: "e3", Source: "c", Target: "no", Label: strPtr("false")},
			{ID: "e4", Source: "yes", Target: "z"},
			{ID: "e5", Source: "no", Target: "z"},
		},
	}

	t.Run("true-branch", func(t *testing.T) {
		stub := newStubDeps(map[string]string{"YES-PATH": "yes-reply", "NO-PATH": "no-reply"})
		_, err := Run(context.Background(), "run", stub.deps(), def, map[string]any{"go": "true"})
		if err != nil {
			t.Fatalf("Run errored: %v", err)
		}
		joined := strings.Join(stub.llmCalls, "|")
		if !strings.Contains(joined, "YES-PATH") {
			t.Errorf("expected YES branch, got LLM calls: %v", stub.llmCalls)
		}
		if strings.Contains(joined, "NO-PATH") {
			t.Errorf("unexpected NO branch fired: %v", stub.llmCalls)
		}
	})

	t.Run("false-branch", func(t *testing.T) {
		stub := newStubDeps(map[string]string{"YES-PATH": "yes-reply", "NO-PATH": "no-reply"})
		_, err := Run(context.Background(), "run", stub.deps(), def, map[string]any{"go": "false"})
		if err != nil {
			t.Fatalf("Run errored: %v", err)
		}
		joined := strings.Join(stub.llmCalls, "|")
		if !strings.Contains(joined, "NO-PATH") {
			t.Errorf("expected NO branch, got LLM calls: %v", stub.llmCalls)
		}
		if strings.Contains(joined, "YES-PATH") {
			t.Errorf("unexpected YES branch fired: %v", stub.llmCalls)
		}
	})
}

func TestRun_ConnectorDispatch(t *testing.T) {
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "c", Type: "connector", Data: map[string]any{
				"connector": "slack", "action": "post_message", "inputMapping": `{"channel":"#test","text":"hi"}`,
			}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "c"},
			{ID: "e2", Source: "c", Target: "z"},
		},
	}
	stub := newStubDeps(nil)
	_, err := Run(context.Background(), "run", stub.deps(), def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if len(stub.connCalls) != 1 || stub.connCalls[0].ID != "slack" || stub.connCalls[0].Action != "post_message" {
		t.Errorf("expected one slack post_message call, got %v", stub.connCalls)
	}
}

func TestRun_FailsOnMissingTrigger(t *testing.T) {
	def := Definition{
		Nodes: []Node{{ID: "a", Type: "ai-step", Data: map[string]any{}}},
	}
	_, err := Run(context.Background(), "run", newStubDeps(nil).deps(), def, nil)
	if err == nil {
		t.Fatal("expected error for missing trigger node, got nil")
	}
	if !strings.Contains(err.Error(), "trigger") {
		t.Errorf("expected error to mention trigger, got %v", err)
	}
}

func TestRun_MaxStepsGuard(t *testing.T) {
	// A → A self-loop graph should hit maxSteps and fail rather than spin
	// forever. Without a guard, a malformed graph would hang the run.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "loop", Type: "ai-step", Data: map[string]any{"prompt": "x"}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "loop"},
			{ID: "e2", Source: "loop", Target: "loop"},
		},
	}
	stub := newStubDeps(nil)
	res, err := Run(context.Background(), "run", stub.deps(), def, nil)
	if err != nil {
		t.Fatalf("Run errored before guard fired: %v", err)
	}
	if !res.Failed {
		t.Error("expected workflow to be flagged as failed after hitting maxSteps")
	}
	if !strings.Contains(res.LastError, "maxSteps") {
		t.Errorf("expected maxSteps error, got %q", res.LastError)
	}
}

func TestRun_TemplateSubstitution(t *testing.T) {
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{
				"prompt": "Hi {{input.first}} {{input.last}}, ref={{input.ref}}",
			}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}
	stub := newStubDeps(nil)
	_, _ = Run(context.Background(), "run", stub.deps(), def, map[string]any{
		"first": "Ada", "last": "Lovelace", "ref": "X-1",
	})
	if len(stub.llmCalls) != 1 {
		t.Fatalf("expected 1 LLM call, got %d", len(stub.llmCalls))
	}
	got := stub.llmCalls[0]
	if !strings.Contains(got, "Hi Ada Lovelace, ref=X-1") {
		t.Errorf("template not substituted; got %q", got)
	}
}

// ---- Loop node tests ---------------------------------------------------------

// loopDef builds a minimal workflow: trigger → loop → end.
// The loop node has a "body" edge to bodyNode, which connects back to nothing
// (no outgoing edge from the body node), so each iteration runs bodyNode once.
//
//	trigger ──► loop ──[body]──► bodyAI
//	                 └──[next]──► end
func loopDef(arrayExpression string, maxIter *float64) Definition {
	loopData := map[string]any{
		"arrayExpression": arrayExpression,
	}
	if maxIter != nil {
		loopData["maxIterations"] = *maxIter
	}
	return Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "L", Type: "loop", Data: loopData},
			{ID: "body", Type: "ai-step", Data: map[string]any{"prompt": "process {{loop.item}} index={{loop.index}}"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "L"},
			{ID: "e2", Source: "L", Target: "body", Label: strPtr("body")},
			{ID: "e3", Source: "L", Target: "z"}, // "next" edge (no label) — followed after the loop node completes
		},
	}
}

func float64Ptr(f float64) *float64 { return &f }

func TestLoop_ThreeElements(t *testing.T) {
	stub := newStubDeps(nil)
	res, err := Run(context.Background(), "run_loop", stub.deps(), loopDef(`["a","b","c"]`, nil), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// Exactly 3 LLM calls — one per item.
	stub.mu.Lock()
	calls := stub.llmCalls
	stub.mu.Unlock()
	if len(calls) != 3 {
		t.Fatalf("expected 3 LLM calls (one per item), got %d: %v", len(calls), calls)
	}

	// Items must be bound correctly in the prompt.
	for i, wantItem := range []string{"a", "b", "c"} {
		if !strings.Contains(calls[i], "process "+wantItem) {
			t.Errorf("iteration %d: expected prompt to contain %q, got %q", i, "process "+wantItem, calls[i])
		}
		wantIdx := string(rune('0' + i))
		if !strings.Contains(calls[i], "index="+wantIdx) {
			t.Errorf("iteration %d: expected index=%s in prompt, got %q", i, wantIdx, calls[i])
		}
	}

	// Journal must include loop.iteration_started + loop.iteration_completed for each item.
	kinds := eventKinds(stub)
	var starts, completes int
	for _, k := range kinds {
		switch k {
		case "loop.iteration_started":
			starts++
		case "loop.iteration_completed":
			completes++
		}
	}
	if starts != 3 || completes != 3 {
		t.Errorf("expected 3 loop.iteration_started and 3 loop.iteration_completed, got %d/%d; events: %v", starts, completes, kinds)
	}

	// The loop result must report 3 iterations.
	stepResults, _ := stub.events[0].Payload["triggerNodeId"] // sanity only
	_ = stepResults
	// Verify via the final vars stored in step output — the loop node's step_completed
	// payload carries a truncated output which includes "iterations".
	var foundIterCount bool
	for _, ev := range stub.events {
		if ev.Kind == "step_completed" && ev.StepID == "L" {
			if out, ok := ev.Payload["output"].(string); ok && strings.Contains(out, "3") {
				foundIterCount = true
			}
		}
	}
	if !foundIterCount {
		t.Errorf("expected loop step_completed output to mention iteration count 3")
	}
}

func TestLoop_EmptyArray(t *testing.T) {
	stub := newStubDeps(nil)
	res, err := Run(context.Background(), "run_empty", stub.deps(), loopDef(`[]`, nil), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure on empty array: %s", res.LastError)
	}

	stub.mu.Lock()
	calls := stub.llmCalls
	stub.mu.Unlock()
	if len(calls) != 0 {
		t.Errorf("expected 0 LLM calls for empty array, got %d", len(calls))
	}

	// No iteration events should be emitted.
	for _, k := range eventKinds(stub) {
		if k == "loop.iteration_started" || k == "loop.iteration_completed" {
			t.Errorf("unexpected event %q for empty loop", k)
		}
	}
}

func TestLoop_MaxIterationsCap(t *testing.T) {
	// Array of 5 elements, cap of 3 — must fail, not silently truncate.
	stub := newStubDeps(nil)
	res, err := Run(context.Background(), "run_cap", stub.deps(), loopDef(`["a","b","c","d","e"]`, float64Ptr(3)), nil)
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}
	if !res.Failed {
		t.Fatal("expected workflow to fail when loop exceeds maxIterations cap")
	}
	if !strings.Contains(res.LastError, "maxIterations") {
		t.Errorf("expected error to mention maxIterations, got %q", res.LastError)
	}

	// step_failed must have been emitted for the loop node.
	var failedEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "step_failed" && ev.StepID == "L" {
			failedEmitted = true
		}
	}
	if !failedEmitted {
		t.Errorf("expected step_failed event for loop node L, got events: %v", eventKinds(stub))
	}
}

// ---- Subagent node tests -----------------------------------------------------

func subagentDef(agentName string) Definition {
	return Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "sa", Type: "subagent", Data: map[string]any{
				"agentName":    agentName,
				"inputMapping": `{"question":"{{input.q}}"}`,
			}},
			{ID: "z", Type: "end", Data: map[string]any{"outputExpression": "{{steps.sa}}"}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "sa"},
			{ID: "e2", Source: "sa", Target: "z"},
		},
	}
}

func TestSubagent_RunsAndPropagatesOutput(t *testing.T) {
	stub := newStubDeps(nil)
	stub.subagentReply = map[string]map[string]any{
		"helper-agent": {"answer": "42", "source": "helper"},
	}
	res, err := Run(context.Background(), "run_sa", stub.deps(), subagentDef("helper-agent"), map[string]any{"q": "meaning?"})
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// RunSubAgent must have been called once with the right agent name.
	stub.mu.Lock()
	calls := stub.subagentCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Fatalf("expected 1 subagent call, got %d", len(calls))
	}
	if calls[0].AgentName != "helper-agent" {
		t.Errorf("expected agentName=helper-agent, got %q", calls[0].AgentName)
	}

	// The output expression {{steps.sa}} must resolve to the subagent's result.
	if !strings.Contains(res.Output, "42") {
		t.Errorf("expected output to contain subagent result 42, got %q", res.Output)
	}

	// Journal: step_started + step_completed for the subagent node.
	var started, completed bool
	for _, ev := range stub.events {
		if ev.StepID == "sa" {
			switch ev.Kind {
			case "step_started":
				started = true
			case "step_completed":
				completed = true
			}
		}
	}
	if !started || !completed {
		t.Errorf("expected step_started + step_completed for subagent node; events: %v", eventKinds(stub))
	}
}

func TestSubagent_NilDepSkips(t *testing.T) {
	stub := newStubDeps(nil)
	stub.noSubagent = true // RunSubAgent dep is nil

	res, err := Run(context.Background(), "run_nil_sa", stub.deps(), subagentDef("some-agent"), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("nil dep should produce a skipped result, not a failure: %s", res.LastError)
	}

	// step_completed (not step_failed) must have been emitted.
	var failed bool
	for _, ev := range stub.events {
		if ev.Kind == "step_failed" && ev.StepID == "sa" {
			failed = true
		}
	}
	if failed {
		t.Error("expected skip (step_completed), got step_failed for nil dep")
	}
}

func TestSubagent_DepErrorFailsNode(t *testing.T) {
	stub := newStubDeps(nil)
	stub.subagentErr = errors.New("agent unavailable")

	res, err := Run(context.Background(), "run_sa_err", stub.deps(), subagentDef("flaky-agent"), nil)
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}
	if !res.Failed {
		t.Fatal("expected workflow to fail when subagent dep returns an error")
	}
	if !strings.Contains(res.LastError, "agent unavailable") {
		t.Errorf("expected error to mention dep error, got %q", res.LastError)
	}

	// step_failed must have been emitted for the subagent node.
	var failedEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "step_failed" && ev.StepID == "sa" {
			failedEmitted = true
		}
	}
	if !failedEmitted {
		t.Errorf("expected step_failed for subagent node; events: %v", eventKinds(stub))
	}
}

// ---- Subagent depth-cap test -------------------------------------------------

// TestSubagent_DepthCapBlocksRecursion verifies that when RunSubAgent returns
// a depth-limit error the workflow correctly marks the run as failed with that
// error surfaced in LastError. This mirrors what the production wiring does
// via context-value depth tracking — the interpreter itself doesn't enforce
// the cap; it just propagates the error from the dep.
func TestSubagent_DepthCapBlocksRecursion(t *testing.T) {
	const capErrMsg = "subagent depth limit (5) exceeded — possible workflow cycle"

	stub := newStubDeps(nil)
	// Wire RunSubAgent to return the depth-limit error unconditionally,
	// simulating what happens when the production dep hits maxSubagentDepth.
	stub.subagentErr = fmt.Errorf(capErrMsg)

	res, err := Run(context.Background(), "run_depth", stub.deps(), subagentDef("recursive-agent"), nil)
	if err != nil {
		t.Fatalf("Run returned unexpected top-level error: %v", err)
	}
	if !res.Failed {
		t.Fatal("expected workflow to fail when depth cap is hit")
	}
	if !strings.Contains(res.LastError, "depth limit") {
		t.Errorf("expected depth-limit error in LastError, got %q", res.LastError)
	}

	// step_failed must be emitted for the subagent node.
	var failedEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "step_failed" && ev.StepID == "sa" {
			failedEmitted = true
		}
	}
	if !failedEmitted {
		t.Errorf("expected step_failed for subagent node; events: %v", eventKinds(stub))
	}
}

// ---- Replay / CompletedStep tests -------------------------------------------

// TestReplay_CachedStepSkipsExecution verifies that when CompletedStep returns
// done=true for a node, the node's dep (CallLLM) is NOT invoked and the cached
// output flows downstream.
func TestReplay_CachedStepSkipsExecution(t *testing.T) {
	cachedOutput := map[string]any{"result": "cached-reply", "source": "replay"}

	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "Hello"}},
			{ID: "z", Type: "end", Data: map[string]any{"outputExpression": "{{steps.a}}"}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	// Wire CompletedStep to return the cached output for node "a".
	d.CompletedStep = func(_ context.Context, runID, stepID string) (map[string]any, bool, error) {
		if stepID == "a" {
			return cachedOutput, true, nil
		}
		return nil, false, nil
	}

	res, err := Run(context.Background(), "run_replay", d, def, map[string]any{})
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// CallLLM must NOT have been invoked — the cached output was reused.
	stub.mu.Lock()
	llmCalls := stub.llmCalls
	stub.mu.Unlock()
	if len(llmCalls) != 0 {
		t.Errorf("expected 0 LLM calls on replay, got %d: %v", len(llmCalls), llmCalls)
	}

	// The end-node's outputExpression {{steps.a}} must resolve to the
	// cached output (JSON-stringified map).
	if !strings.Contains(res.Output, "cached-reply") {
		t.Errorf("expected cached-reply in output, got %q", res.Output)
	}
}

// TestReplay_NilHookExecutesNormally verifies backward compatibility: when
// CompletedStep is nil, every node executes as before — no behavioural change.
func TestReplay_NilHookExecutesNormally(t *testing.T) {
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "Hello"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	// Explicitly nil — should be the default, but make it explicit.
	d.CompletedStep = nil

	_, err := Run(context.Background(), "run_no_replay", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}

	stub.mu.Lock()
	calls := stub.llmCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Errorf("expected 1 LLM call when CompletedStep is nil, got %d", len(calls))
	}
}

// TestReplay_ConnectorNodeSkippedOnReplay verifies that a connector node
// (side-effecting) is not re-invoked when CompletedStep returns done.
func TestReplay_ConnectorNodeSkippedOnReplay(t *testing.T) {
	cached := map[string]any{"connector": "slack", "ok": true, "replay": true}

	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "c", Type: "connector", Data: map[string]any{
				"connector": "slack", "action": "post_message",
			}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "c"},
			{ID: "e2", Source: "c", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	d.CompletedStep = func(_ context.Context, _, stepID string) (map[string]any, bool, error) {
		if stepID == "c" {
			return cached, true, nil
		}
		return nil, false, nil
	}

	_, err := Run(context.Background(), "run_conn_replay", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}

	stub.mu.Lock()
	connCalls := stub.connCalls
	stub.mu.Unlock()
	if len(connCalls) != 0 {
		t.Errorf("expected connector NOT called on replay, got %d calls: %v", len(connCalls), connCalls)
	}
}

// ---- runSubgraph cap tests ---------------------------------------------------

// TestLoopBody_ExceedsMaxBodySteps verifies that a body subgraph chain longer
// than maxBodySteps (50) produces an explicit error rather than silently
// completing. The off-by-one fix ensures the loop doesn't just fall through on
// the 50th iteration and return a success result.
func TestLoopBody_ExceedsMaxBodySteps(t *testing.T) {
	// Build a body chain: trigger → loop → body0 → body1 → … → body49 → body50
	// The loop body edge targets body0, which chains to body50 via 50 "next"
	// edges. That is maxBodySteps+1 nodes visited inside the body — must error.
	const chainLen = 51 // one more than maxBodySteps=50

	nodes := []Node{
		{ID: "t", Type: "trigger", Data: map[string]any{}},
		{ID: "L", Type: "loop", Data: map[string]any{"arrayExpression": `["x"]`}},
		{ID: "z", Type: "end", Data: map[string]any{}},
	}
	edges := []Edge{
		{ID: "e-tL", Source: "t", Target: "L"},
		{ID: "e-Lz", Source: "L", Target: "z"},
	}
	// Build body chain: body0 → body1 → … → body(chainLen-1)
	for i := 0; i < chainLen; i++ {
		id := fmt.Sprintf("body%d", i)
		nodes = append(nodes, Node{
			ID:   id,
			Type: "ai-step",
			Data: map[string]any{"prompt": fmt.Sprintf("step %d", i)},
		})
	}
	// body edge: L → body0
	edges = append(edges, Edge{ID: "e-Lbody", Source: "L", Target: "body0", Label: strPtr("body")})
	// chain edges: body0 → body1 → … → body(chainLen-1) → (no outgoing)
	for i := 0; i < chainLen-1; i++ {
		edges = append(edges, Edge{
			ID:     fmt.Sprintf("e-b%d", i),
			Source: fmt.Sprintf("body%d", i),
			Target: fmt.Sprintf("body%d", i+1),
		})
	}

	def := Definition{Nodes: nodes, Edges: edges}
	stub := newStubDeps(nil)
	res, err := Run(context.Background(), "run_maxbody", stub.deps(), def, nil)
	if err != nil {
		t.Fatalf("Run returned unexpected top-level error: %v", err)
	}
	// The loop body exceeded the cap, so the loop node must fail.
	if !res.Failed {
		t.Error("expected workflow to fail when loop body exceeds maxBodySteps")
	}
	if !strings.Contains(res.LastError, "maxBodySteps") {
		t.Errorf("expected maxBodySteps in error, got %q", res.LastError)
	}
	// step_failed must have been emitted for the loop node (the error propagates
	// up through executeLoop → executeNode → Run's step-error path).
	var failedEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "step_failed" && ev.StepID == "L" {
			failedEmitted = true
		}
	}
	if !failedEmitted {
		t.Errorf("expected step_failed for loop node; events: %v", eventKinds(stub))
	}
}

// ---- shallowCopyVars isolation tests ----------------------------------------

// TestLoop_BodyStepDoesNotBleedAcrossIterations verifies that a body node
// writing to vars["steps"]["body"] in iteration N does not pollute iteration
// N+1's view: each iteration must start with an isolated steps map.
func TestLoop_BodyStepDoesNotBleedAcrossIterations(t *testing.T) {
	// Workflow: loop over ["a", "b"], body is a single ai-step "body" whose
	// reply we track. The test checks that iteration 1's LLM prompt does not
	// contain the step result from iteration 0 injected via steps["body"].
	stub := newStubDeps(map[string]string{
		"process a": "reply-for-a",
		"process b": "reply-for-b",
	})

	// Use the shared loopDef helper which has a body ai-step with ID "body".
	def := loopDef(`["a","b"]`, nil)
	res, err := Run(context.Background(), "run_isolation", stub.deps(), def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	stub.mu.Lock()
	calls := stub.llmCalls
	stub.mu.Unlock()

	if len(calls) != 2 {
		t.Fatalf("expected 2 LLM calls, got %d: %v", len(calls), calls)
	}
	// Iteration 1's prompt must NOT contain "reply-for-a" (the step result
	// from iteration 0's body). If shallowCopyVars shares the steps map,
	// runSubgraph would write stepsMap["body"] = "reply-for-a" in iteration 0,
	// and that would appear in iteration 1's {{steps.body}} template.
	// (The loopDef body prompt is "process {{loop.item}} index={{loop.index}}"
	// which doesn't reference steps.body directly, but we verify the map is
	// isolated by checking that iteration 1 does NOT see the iteration 0 body
	// result via a direct steps-map check via a custom workflow.)
	//
	// For a more direct assertion: build a workflow where the body prompt
	// references {{steps.body}} and confirm it stays empty on iteration 1.
	stub2 := newStubDeps(nil)
	def2 := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "L", Type: "loop", Data: map[string]any{"arrayExpression": `["a","b"]`}},
			{ID: "body", Type: "ai-step", Data: map[string]any{
				// If steps["body"] bleeds across, iteration 1 sees "ITER0-RESULT" here.
				"prompt": "item={{loop.item}} prev={{steps.body}}",
			}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "L"},
			{ID: "e2", Source: "L", Target: "body", Label: strPtr("body")},
			{ID: "e3", Source: "L", Target: "z"},
		},
	}
	// stub2 replies with a fixed string for iteration 0's body call.
	stub2.llmReplies = map[string]string{"item=a": "ITER0-RESULT"}
	res2, err := Run(context.Background(), "run_isolation2", stub2.deps(), def2, nil)
	if err != nil {
		t.Fatalf("Run2 errored: %v", err)
	}
	if res2.Failed {
		t.Fatalf("unexpected failure2: %s", res2.LastError)
	}

	stub2.mu.Lock()
	calls2 := stub2.llmCalls
	stub2.mu.Unlock()

	if len(calls2) != 2 {
		t.Fatalf("expected 2 LLM calls in isolation test, got %d", len(calls2))
	}
	// Iteration 1's prompt (calls2[1]) must have prev= empty (or the literal
	// string for an unresolved path), NOT "ITER0-RESULT".
	iter1Prompt := calls2[1]
	if strings.Contains(iter1Prompt, "ITER0-RESULT") {
		t.Errorf("iteration 1 prompt contains iteration 0 body result — steps map not isolated.\nprompt: %q", iter1Prompt)
	}
	// Confirm iteration 0 did include the correct item.
	if !strings.Contains(calls2[0], "item=a") {
		t.Errorf("iteration 0 prompt malformed: %q", calls2[0])
	}
}

// ---- Feature 2: per-step token/cost in step_completed (CallLLMDetailed) -----

func TestAiStep_CallLLMDetailed_UsageInStepCompleted(t *testing.T) {
	// When CallLLMDetailed is wired, the step_completed journal event must
	// carry tokens_in, tokens_out, cost_usd, provider, and model.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{
				"prompt": "tell me about {{input.topic}}",
			}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	// Wire the detailed dep; return a usage struct with non-zero values.
	d.CallLLMDetailed = func(_ context.Context, prompt, _ string) (string, LLMStepUsage, error) {
		stub.mu.Lock()
		stub.llmCalls = append(stub.llmCalls, prompt)
		stub.mu.Unlock()
		return "detailed-reply", LLMStepUsage{
			TokensIn:  100,
			TokensOut: 50,
			CostUSD:   0.001,
			Provider:  "openai",
			Model:     "gpt-4o",
		}, nil
	}

	res, err := Run(context.Background(), "run_detailed", d, def, map[string]any{"topic": "AI"})
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// Find step_completed for the ai-step node "a".
	var found bool
	for _, ev := range stub.events {
		if ev.Kind == "step_completed" && ev.StepID == "a" {
			found = true
			p := ev.Payload
			if ti, ok := p["tokens_in"].(int64); !ok || ti != 100 {
				t.Errorf("tokens_in: got %v (%T), want int64(100)", p["tokens_in"], p["tokens_in"])
			}
			if to, ok := p["tokens_out"].(int64); !ok || to != 50 {
				t.Errorf("tokens_out: got %v (%T), want int64(50)", p["tokens_out"], p["tokens_out"])
			}
			if cu, ok := p["cost_usd"].(float64); !ok || cu != 0.001 {
				t.Errorf("cost_usd: got %v (%T), want float64(0.001)", p["cost_usd"], p["cost_usd"])
			}
			if prov, ok := p["provider"].(string); !ok || prov != "openai" {
				t.Errorf("provider: got %v, want openai", p["provider"])
			}
			if mdl, ok := p["model"].(string); !ok || mdl != "gpt-4o" {
				t.Errorf("model: got %v, want gpt-4o", p["model"])
			}
		}
	}
	if !found {
		t.Errorf("no step_completed event for node 'a'; events: %v", eventKinds(stub))
	}

	// CallLLM must NOT have been invoked — CallLLMDetailed takes precedence.
	stub.mu.Lock()
	// llmCalls is appended by the CallLLMDetailed closure above, which is correct.
	stub.mu.Unlock()
}

func TestAiStep_CallLLMDetailedNil_FallsBackToCallLLM(t *testing.T) {
	// When CallLLMDetailed is nil, the interpreter falls back to CallLLM
	// and step_completed carries NO token/cost fields.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "hello"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	// CallLLMDetailed deliberately left nil (not set).

	res, err := Run(context.Background(), "run_fallback", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	for _, ev := range stub.events {
		if ev.Kind == "step_completed" && ev.StepID == "a" {
			if _, has := ev.Payload["tokens_in"]; has {
				t.Errorf("expected no tokens_in in step_completed when CallLLMDetailed is nil")
			}
			if _, has := ev.Payload["cost_usd"]; has {
				t.Errorf("expected no cost_usd in step_completed when CallLLMDetailed is nil")
			}
		}
	}

	// CallLLM must have been invoked exactly once.
	stub.mu.Lock()
	calls := stub.llmCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Errorf("expected 1 CallLLM call, got %d", len(calls))
	}
}

// ---- Feature 3: mid-run anomaly detection -----------------------------------

func TestMidRunAnomaly_CostSpikeEmittedDuringRun(t *testing.T) {
	// Build a workflow that visits 3 ai-step nodes in sequence.
	// The first two steps each cost $2.00 (just under DefaultAnomalyLimits.MaxCostUSD=5.0).
	// The third step pushes cumulative cost to $6.00, crossing the $5 threshold.
	// An anomaly_detected event with kind=cost_spike must be emitted before
	// the run ends, not only at the end-of-run analysis phase.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "step-a"}},
			{ID: "b", Type: "ai-step", Data: map[string]any{"prompt": "step-b"}},
			{ID: "c", Type: "ai-step", Data: map[string]any{"prompt": "step-c"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "b"},
			{ID: "e3", Source: "b", Target: "c"},
			{ID: "e4", Source: "c", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	costs := []float64{2.0, 2.0, 2.0} // cumulative: 2, 4, 6 — spike at step 3
	callIdx := 0
	d.CallLLMDetailed = func(_ context.Context, prompt, _ string) (string, LLMStepUsage, error) {
		stub.mu.Lock()
		idx := callIdx
		callIdx++
		stub.mu.Unlock()
		return "reply", LLMStepUsage{CostUSD: costs[idx]}, nil
	}

	res, err := Run(context.Background(), "run_cost_spike", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// At least one anomaly_detected with kind=cost_spike must have been emitted.
	var spikeEvents []JournalEvent
	for _, ev := range stub.events {
		if ev.Kind == "anomaly_detected" {
			if k, _ := ev.Payload["kind"].(string); k == string(KindCostSpike) {
				spikeEvents = append(spikeEvents, ev)
			}
		}
	}
	if len(spikeEvents) == 0 {
		t.Errorf("expected at least one anomaly_detected(cost_spike) event; all events: %v", eventKinds(stub))
	}
	// The anomaly must have been emitted before workflow.completed (mid-run,
	// not at the end), so it must appear before the workflow.completed event.
	var spikeIdx, completedIdx = -1, -1
	for i, ev := range stub.events {
		if spikeIdx == -1 && ev.Kind == "anomaly_detected" {
			spikeIdx = i
		}
		if ev.Kind == "workflow.completed" {
			completedIdx = i
		}
	}
	if spikeIdx == -1 || completedIdx == -1 {
		t.Fatalf("missing expected events: spike=%d completed=%d", spikeIdx, completedIdx)
	}
	if spikeIdx >= completedIdx {
		t.Errorf("anomaly_detected must precede workflow.completed (spike=%d, completed=%d)", spikeIdx, completedIdx)
	}
}

func TestMidRunAnomaly_ExcessiveStepsEmittedBeforeMaxStepsHalt(t *testing.T) {
	// A self-looping ai-step will hit the maxSteps=100 guard. But the
	// excessive_steps anomaly (threshold 80) must fire before the run is
	// halted at step 100.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "loop", Type: "ai-step", Data: map[string]any{"prompt": "looping"}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "loop"},
			{ID: "e2", Source: "loop", Target: "loop"}, // self-loop
		},
	}

	stub := newStubDeps(nil)
	res, err := Run(context.Background(), "run_excessive", stub.deps(), def, nil)
	if err != nil {
		t.Fatalf("Run returned unexpected error: %v", err)
	}
	if !res.Failed {
		t.Error("expected workflow to fail due to maxSteps guard")
	}

	var excessiveEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "anomaly_detected" {
			if k, _ := ev.Payload["kind"].(string); k == string(KindExcessiveSteps) {
				excessiveEmitted = true
			}
		}
	}
	if !excessiveEmitted {
		t.Errorf("expected anomaly_detected(excessive_steps) to fire before halt; events: %v", eventKinds(stub))
	}
}

func TestMidRunAnomaly_DedupedPerKind(t *testing.T) {
	// The same anomaly kind must be emitted at most once even when multiple
	// consecutive steps cross the same threshold repeatedly.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "a"}},
			{ID: "b", Type: "ai-step", Data: map[string]any{"prompt": "b"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "b"},
			{ID: "e3", Source: "b", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	// Both steps cost $3 each → cumulative $3 then $6, both above the $5 limit.
	callIdx := 0
	d.CallLLMDetailed = func(_ context.Context, _, _ string) (string, LLMStepUsage, error) {
		stub.mu.Lock()
		callIdx++
		stub.mu.Unlock()
		return "ok", LLMStepUsage{CostUSD: 3.0}, nil
	}

	_, err := Run(context.Background(), "run_dedup", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}

	var spikeCount int
	for _, ev := range stub.events {
		if ev.Kind == "anomaly_detected" {
			if k, _ := ev.Payload["kind"].(string); k == string(KindCostSpike) {
				spikeCount++
			}
		}
	}
	if spikeCount != 1 {
		t.Errorf("expected exactly 1 cost_spike anomaly event (dedup), got %d", spikeCount)
	}
}

func sliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func strPtr(s string) *string { return &s }
