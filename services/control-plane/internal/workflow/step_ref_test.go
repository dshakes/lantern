package workflow

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// TestStepRef_ToolCallsCarryDistinctIdentity pins the identity deps derive
// idempotency keys from (invariant #8): a top-level step carries its node ID
// and attempt (retries bump it), and each loop iteration gets its own path so
// two iterations never share a key.
func TestStepRef_ToolCallsCarryDistinctIdentity(t *testing.T) {
	var mu sync.Mutex
	var refs []StepRef
	failFirst := true
	deps := newStubDeps(nil).deps()
	deps.CallTool = func(ctx context.Context, _ string, _ map[string]any) (any, error) {
		ref, ok := StepFromContext(ctx)
		if !ok {
			t.Fatal("CallTool ctx carries no StepRef")
		}
		mu.Lock()
		defer mu.Unlock()
		refs = append(refs, ref)
		if ref.StepID == "tool1" && failFirst {
			failFirst = false
			return nil, errors.New("transient")
		}
		return map[string]any{"ok": true}, nil
	}

	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "tool1", Type: "tool", Data: map[string]any{"tool": "shell_exec", "retry": map[string]any{"maxAttempts": float64(2)}}},
			{ID: "L", Type: "loop", Data: map[string]any{"arrayExpression": `["a","b"]`}},
			{ID: "body", Type: "tool", Data: map[string]any{"tool": "shell_exec"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "tool1"},
			{ID: "e2", Source: "tool1", Target: "L"},
			{ID: "e3", Source: "L", Target: "body", Label: strPtr("body")},
			{ID: "e4", Source: "L", Target: "z"},
		},
	}
	res, err := Run(context.Background(), "run_ref", deps, def, nil)
	if err != nil || res.Failed {
		t.Fatalf("Run: err=%v failed=%v last=%s", err, res.Failed, res.LastError)
	}
	want := []StepRef{
		{StepID: "tool1", Attempt: 1},
		{StepID: "tool1", Attempt: 2},
		{StepID: "L[0]/body", Attempt: 1},
		{StepID: "L[1]/body", Attempt: 1},
	}
	if len(refs) != len(want) {
		t.Fatalf("refs = %+v, want %+v", refs, want)
	}
	for i := range want {
		if refs[i] != want[i] {
			t.Errorf("refs[%d] = %+v, want %+v", i, refs[i], want[i])
		}
	}
}
