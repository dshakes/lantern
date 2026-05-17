package workflow

import (
	"context"
	"strings"
	"sync"
	"testing"
)

// stubDeps captures every event + LLM/connector/tool call so tests can
// assert exact ordering of side-effects without spinning up Postgres.
type stubDeps struct {
	mu         sync.Mutex
	llmCalls   []string
	connCalls  []connCall
	toolCalls  []toolCall
	events     []JournalEvent
	llmReplies map[string]string
}

type connCall struct{ ID, Action string }
type toolCall struct{ Name string }

func newStubDeps(replies map[string]string) *stubDeps {
	return &stubDeps{llmReplies: replies}
}

func (s *stubDeps) deps() Deps {
	return Deps{
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
