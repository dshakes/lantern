package workflow

import (
	"context"
	"errors"
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
