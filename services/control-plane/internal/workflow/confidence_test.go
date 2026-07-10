package workflow

import (
	"context"
	"strings"
	"testing"
)

// ---- parseVerbalized unit tests ----

func TestParseVerbalized_PercentColon(t *testing.T) {
	cases := []struct {
		text string
		want float64
	}{
		{"Confidence: 85%", 0.85},
		{"confidence: 100%", 1.0},
		{"confidence: 0%", 0.0},
		{"confidence level: 72.5%", 0.725},
	}
	for _, tc := range cases {
		score, ok := parseVerbalized(tc.text)
		if !ok {
			t.Errorf("parseVerbalized(%q): got ok=false, want ok=true", tc.text)
			continue
		}
		if score != tc.want {
			t.Errorf("parseVerbalized(%q): got %.4f, want %.4f", tc.text, score, tc.want)
		}
	}
}

func TestParseVerbalized_PercentSuffix(t *testing.T) {
	score, ok := parseVerbalized("I am 70% confident this is correct.")
	if !ok || score != 0.70 {
		t.Errorf("got ok=%v score=%.2f, want ok=true score=0.70", ok, score)
	}
}

func TestParseVerbalized_Decimal(t *testing.T) {
	cases := []struct {
		text string
		want float64
	}{
		{"confidence: 0.85", 0.85},
		{"confidence score: 0.8", 0.80},
		{"Confidence Score: 0.95", 0.95},
	}
	for _, tc := range cases {
		score, ok := parseVerbalized(tc.text)
		if !ok {
			t.Errorf("parseVerbalized(%q): got ok=false, want ok=true", tc.text)
			continue
		}
		if score != tc.want {
			t.Errorf("parseVerbalized(%q): got %.4f, want %.4f", tc.text, score, tc.want)
		}
	}
}

func TestParseVerbalized_LevelLabels(t *testing.T) {
	cases := []struct {
		text string
		want float64
	}{
		{"Confidence: High", 0.90},
		{"high confidence in this result", 0.90},
		{"Confidence: Medium", 0.60},
		{"medium confidence assessment", 0.60},
		{"Confidence: Low", 0.30},
		{"this is a low confidence prediction", 0.30},
	}
	for _, tc := range cases {
		score, ok := parseVerbalized(tc.text)
		if !ok {
			t.Errorf("parseVerbalized(%q): got ok=false, want ok=true", tc.text)
			continue
		}
		if score != tc.want {
			t.Errorf("parseVerbalized(%q): got %.2f, want %.2f", tc.text, score, tc.want)
		}
	}
}

func TestParseVerbalized_NoMatch(t *testing.T) {
	cases := []string{
		"",
		"The answer is 42.",
		"I think this is probably right.",
		"High quality output delivered.",
	}
	for _, text := range cases {
		_, ok := parseVerbalized(text)
		if ok {
			t.Errorf("parseVerbalized(%q): got ok=true, want false", text)
		}
	}
}

// ---- VerbalizationHeuristic.Estimate unit tests ----

func TestVerbalizationHeuristic_DefaultWhenNoSteps(t *testing.T) {
	h := VerbalizationHeuristic{DefaultConfidence: 0.8}
	score := h.Estimate(context.Background(), Node{}, map[string]any{}, nil)
	if score != 0.8 {
		t.Errorf("got %.2f, want 0.80", score)
	}
}

func TestVerbalizationHeuristic_DefaultFallbackIs09(t *testing.T) {
	h := VerbalizationHeuristic{} // zero value → default 0.9
	score := h.Estimate(context.Background(), Node{}, map[string]any{
		"steps": map[string]any{},
	}, nil)
	if score != 0.9 {
		t.Errorf("got %.2f, want 0.90", score)
	}
}

func TestVerbalizationHeuristic_ParsesFromPriorStep(t *testing.T) {
	h := VerbalizationHeuristic{}
	vars := map[string]any{
		"steps": map[string]any{
			"plan": "I have planned the action. Confidence: 65%",
		},
	}
	score := h.Estimate(context.Background(), Node{}, vars, nil)
	if score != 0.65 {
		t.Errorf("got %.2f, want 0.65", score)
	}
}

func TestVerbalizationHeuristic_NonStringStepSkipped(t *testing.T) {
	h := VerbalizationHeuristic{DefaultConfidence: 0.7}
	vars := map[string]any{
		"steps": map[string]any{
			// connector returns a map, not a string
			"conn": map[string]any{"ok": true},
		},
	}
	score := h.Estimate(context.Background(), Node{}, vars, nil)
	if score != 0.7 {
		t.Errorf("got %.2f, want 0.70 (default)", score)
	}
}

// ---- isConfidenceGated unit tests ----

func TestIsConfidenceGated(t *testing.T) {
	cases := []struct {
		node Node
		want bool
	}{
		{Node{Type: "tool"}, true},
		{Node{Type: "connector"}, true},
		{Node{Type: "ai-step", Data: map[string]any{"requiresConfidence": true}}, true},
		{Node{Type: "ai-step", Data: map[string]any{}}, false},
		{Node{Type: "ai-step"}, false},
		{Node{Type: "trigger"}, false},
		{Node{Type: "condition"}, false},
		{Node{Type: "end"}, false},
		{Node{Type: "approval"}, false},
		{Node{Type: "subagent"}, false},
	}
	for _, tc := range cases {
		got := isConfidenceGated(tc.node)
		if got != tc.want {
			t.Errorf("isConfidenceGated(%s/%v): got %v, want %v",
				tc.node.Type, tc.node.Data, got, tc.want)
		}
	}
}

// ---- Confidence gate integration tests (via workflow.Run) ----

// confidenceGateDef builds: trigger → tool → end
// The tool node is always gated when ConfidenceGate is non-nil.
func confidenceGateDef(toolName string, requiresConf bool) Definition {
	nodeData := map[string]any{"tool": toolName}
	if requiresConf {
		nodeData["requiresConfidence"] = true
	}
	return Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "tool1", Type: "tool", Data: nodeData},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "tool1"},
			{ID: "e2", Source: "tool1", Target: "z"},
		},
	}
}

// TestConfidenceGate_NilGate_Unchanged verifies that when ConfidenceGate is
// nil (the default, flag off), the tool executes normally with no
// confidence_evaluated event emitted. This is the regression test for the
// flag-off path.
func TestConfidenceGate_NilGate_Unchanged(t *testing.T) {
	stub := newStubDeps(nil)
	d := stub.deps()
	// Explicitly nil gate — must be the default, but stated explicitly.
	d.ConfidenceGate = nil

	_, err := Run(context.Background(), "run_nogate", d, confidenceGateDef("web.search", false), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}

	// Tool must have been called (no gate diversion).
	stub.mu.Lock()
	calls := stub.toolCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Errorf("expected 1 tool call, got %d", len(calls))
	}

	// No confidence_evaluated event must be present.
	for _, ev := range stub.events {
		if ev.Kind == "confidence_evaluated" {
			t.Errorf("unexpected confidence_evaluated event with nil gate")
		}
	}
}

// TestConfidenceGate_AboveThreshold_Executes verifies that a step with a
// confidence score above the threshold auto-executes and the journal carries
// a confidence_evaluated event with decision=execute.
func TestConfidenceGate_AboveThreshold_Executes(t *testing.T) {
	stub := newStubDeps(nil)
	d := stub.deps()
	// Gate with a fixed-high estimator: score=0.9 >= threshold=0.75 → execute.
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.9),
		Threshold: 0.75,
	}

	_, err := Run(context.Background(), "run_above", d, confidenceGateDef("fs.read", false), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}

	// Tool must have been called.
	stub.mu.Lock()
	calls := stub.toolCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Errorf("expected 1 tool call (gate passed), got %d", len(calls))
	}

	// confidence_evaluated must be present with decision=execute.
	var found bool
	for _, ev := range stub.events {
		if ev.Kind == "confidence_evaluated" && ev.StepID == "tool1" {
			found = true
			if d, _ := ev.Payload["decision"].(string); d != "execute" {
				t.Errorf("expected decision=execute, got %q", d)
			}
			if s, _ := ev.Payload["score"].(float64); s != 0.9 {
				t.Errorf("expected score=0.9, got %v", s)
			}
		}
	}
	if !found {
		t.Errorf("expected confidence_evaluated event; events: %v", eventKinds(stub))
	}
}

// TestConfidenceGate_BelowThreshold_DiversionAndApproval verifies that when
// score < threshold, the tool is NOT executed immediately. Instead,
// WaitForApproval is called. When the human grants approval, the tool
// executes. The journal must have confidence_evaluated with decision=divert.
func TestConfidenceGate_BelowThreshold_DiversionAndApproval(t *testing.T) {
	stub := newStubDeps(nil)
	d := stub.deps()
	// Gate with a fixed-low estimator: score=0.3 < threshold=0.75 → divert.
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.3),
		Threshold: 0.75,
	}
	approvalCalled := false
	d.WaitForApproval = func(_ context.Context, _, _, _ string) (ApprovalDisposition, error) {
		approvalCalled = true
		return ApprovalDisposition{Granted: true, Reason: "looks fine"}, nil
	}

	res, err := Run(context.Background(), "run_divert", d, confidenceGateDef("fs.write", false), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// WaitForApproval must have been called for the low-confidence step.
	if !approvalCalled {
		t.Error("expected WaitForApproval to be called for low-confidence step")
	}

	// Tool must still have executed (after approval).
	stub.mu.Lock()
	calls := stub.toolCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Errorf("expected 1 tool call after approval granted, got %d", len(calls))
	}

	// Journal: confidence_evaluated with decision=divert.
	var foundEval bool
	for _, ev := range stub.events {
		if ev.Kind == "confidence_evaluated" && ev.StepID == "tool1" {
			foundEval = true
			if dec, _ := ev.Payload["decision"].(string); dec != "divert" {
				t.Errorf("expected decision=divert, got %q", dec)
			}
		}
	}
	if !foundEval {
		t.Errorf("expected confidence_evaluated(divert) event; events: %v", eventKinds(stub))
	}
}

// TestConfidenceGate_BelowThreshold_ApprovalDenied verifies that when
// score < threshold and the human denies approval, the step fails and the
// side effect (tool call) is never executed.
func TestConfidenceGate_BelowThreshold_ApprovalDenied(t *testing.T) {
	stub := newStubDeps(nil)
	d := stub.deps()
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.2),
		Threshold: 0.75,
	}
	d.WaitForApproval = func(_ context.Context, _, _, _ string) (ApprovalDisposition, error) {
		return ApprovalDisposition{Granted: false, Reason: "too risky"}, nil
	}

	res, err := Run(context.Background(), "run_denied", d, confidenceGateDef("fs.delete", false), nil)
	if err != nil {
		t.Fatalf("Run returned unexpected top-level error: %v", err)
	}
	if !res.Failed {
		t.Fatal("expected workflow to fail when approval is denied")
	}
	if !strings.Contains(res.LastError, "too risky") {
		t.Errorf("expected denial reason in error, got %q", res.LastError)
	}

	// Tool must NOT have been called.
	stub.mu.Lock()
	calls := stub.toolCalls
	stub.mu.Unlock()
	if len(calls) != 0 {
		t.Errorf("tool must not execute when approval denied, got %d calls", len(calls))
	}

	// step_failed must be emitted for the tool node.
	var failedEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "step_failed" && ev.StepID == "tool1" {
			failedEmitted = true
		}
	}
	if !failedEmitted {
		t.Errorf("expected step_failed for tool1; events: %v", eventKinds(stub))
	}
}

// TestConfidenceGate_ConnectorGated verifies that connector nodes are also
// subject to the confidence gate.
func TestConfidenceGate_ConnectorGated(t *testing.T) {
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "c1", Type: "connector", Data: map[string]any{
				"connector": "slack", "action": "post_message",
			}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "c1"},
			{ID: "e2", Source: "c1", Target: "z"},
		},
	}

	stub := newStubDeps(nil)
	d := stub.deps()
	approvalCalled := false
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.1), // very low → always divert
		Threshold: 0.75,
	}
	d.WaitForApproval = func(_ context.Context, _, _, reason string) (ApprovalDisposition, error) {
		approvalCalled = true
		if !strings.Contains(reason, "connector") {
			// Reason should mention the node type
		}
		return ApprovalDisposition{Granted: true}, nil
	}

	res, err := Run(context.Background(), "run_conn_gate", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}
	if !approvalCalled {
		t.Error("expected WaitForApproval to be called for low-confidence connector node")
	}

	// Connector must have been called after approval.
	stub.mu.Lock()
	conns := stub.connCalls
	stub.mu.Unlock()
	if len(conns) != 1 {
		t.Errorf("expected 1 connector call after approval, got %d", len(conns))
	}
}

// TestConfidenceGate_AiStep_OnlyGatedWhenFlagged verifies that an ai-step
// is NOT gated unless requiresConfidence=true is set in node data.
func TestConfidenceGate_AiStep_OnlyGatedWhenFlagged(t *testing.T) {
	// ai-step WITHOUT requiresConfidence → should not be gated (no approval call)
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{"prompt": "plan something"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "a"},
			{ID: "e2", Source: "a", Target: "z"},
		},
	}
	stub := newStubDeps(nil)
	d := stub.deps()
	approvalCalled := false
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.1), // would trigger divert if gated
		Threshold: 0.75,
	}
	d.WaitForApproval = func(_ context.Context, _, _, _ string) (ApprovalDisposition, error) {
		approvalCalled = true
		return ApprovalDisposition{Granted: true}, nil
	}

	res, err := Run(context.Background(), "run_aistep_ungated", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}
	if approvalCalled {
		t.Error("WaitForApproval must NOT be called for an ai-step without requiresConfidence=true")
	}

	// No confidence_evaluated event for the ai-step.
	for _, ev := range stub.events {
		if ev.Kind == "confidence_evaluated" {
			t.Errorf("unexpected confidence_evaluated for ungated ai-step")
		}
	}
}

// TestConfidenceGate_AiStep_GatedWhenFlagged verifies that an ai-step with
// requiresConfidence=true IS subject to the confidence gate.
func TestConfidenceGate_AiStep_GatedWhenFlagged(t *testing.T) {
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "a", Type: "ai-step", Data: map[string]any{
				"prompt":             "take an action",
				"requiresConfidence": true,
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
	approvalCalled := false
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.1), // below threshold → divert
		Threshold: 0.75,
	}
	d.WaitForApproval = func(_ context.Context, _, _, _ string) (ApprovalDisposition, error) {
		approvalCalled = true
		return ApprovalDisposition{Granted: true}, nil
	}

	res, err := Run(context.Background(), "run_aistep_gated", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}
	if !approvalCalled {
		t.Error("expected WaitForApproval for ai-step with requiresConfidence=true")
	}
}

// TestConfidenceGate_BelowThreshold_NilApproval_AutoApproves verifies that
// when WaitForApproval is nil and score < threshold, the node auto-approves
// (same contract as the approval node when no handler is wired).
func TestConfidenceGate_BelowThreshold_NilApproval_AutoApproves(t *testing.T) {
	stub := newStubDeps(nil)
	d := stub.deps()
	d.ConfidenceGate = &ConfidenceGate{
		Estimator: fixedEstimator(0.1),
		Threshold: 0.75,
	}
	d.WaitForApproval = nil // explicitly nil

	res, err := Run(context.Background(), "run_nil_approval", d, confidenceGateDef("fs.read", false), nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("nil WaitForApproval should auto-approve, not fail: %s", res.LastError)
	}

	// Tool must still execute (auto-approved).
	stub.mu.Lock()
	calls := stub.toolCalls
	stub.mu.Unlock()
	if len(calls) != 1 {
		t.Errorf("expected 1 tool call after auto-approval, got %d", len(calls))
	}

	// confidence_gate_bypassed must be in the journal.
	var bypassEmitted bool
	for _, ev := range stub.events {
		if ev.Kind == "confidence_gate_bypassed" {
			bypassEmitted = true
		}
	}
	if !bypassEmitted {
		t.Errorf("expected confidence_gate_bypassed event; events: %v", eventKinds(stub))
	}
}

// TestConfidenceGate_VerbalizationFromPriorStep exercises the end-to-end
// path where an ai-step outputs a verbalized confidence signal and the
// following tool node picks it up.
func TestConfidenceGate_VerbalizationFromPriorStep(t *testing.T) {
	// Workflow: trigger → ai-step (returns "confidence: 40%") → tool → end
	// With threshold=0.75 the low prior-step confidence should divert the tool.
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "plan", Type: "ai-step", Data: map[string]any{"prompt": "plan the action"}},
			{ID: "act", Type: "tool", Data: map[string]any{"tool": "fs.write"}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{
			{ID: "e1", Source: "t", Target: "plan"},
			{ID: "e2", Source: "plan", Target: "act"},
			{ID: "e3", Source: "act", Target: "z"},
		},
	}

	stub := newStubDeps(map[string]string{
		"plan the action": "I will write the file. Confidence: 40%",
	})
	d := stub.deps()
	approvalCalled := false
	d.ConfidenceGate = &ConfidenceGate{
		// VerbalizationHeuristic reads the "Confidence: 40%" from the plan step.
		Estimator: VerbalizationHeuristic{},
		Threshold: 0.75,
	}
	d.WaitForApproval = func(_ context.Context, _, _, _ string) (ApprovalDisposition, error) {
		approvalCalled = true
		return ApprovalDisposition{Granted: true}, nil
	}

	res, err := Run(context.Background(), "run_verbalize", d, def, nil)
	if err != nil {
		t.Fatalf("Run errored: %v", err)
	}
	if res.Failed {
		t.Fatalf("unexpected failure: %s", res.LastError)
	}

	// Low confidence (40% < 75%) should have triggered approval.
	if !approvalCalled {
		t.Error("expected WaitForApproval for 40% confidence step (threshold 75%)")
	}

	// confidence_evaluated must carry score≈0.40 and decision=divert.
	var found bool
	for _, ev := range stub.events {
		if ev.Kind == "confidence_evaluated" && ev.StepID == "act" {
			found = true
			if s, _ := ev.Payload["score"].(float64); s != 0.40 {
				t.Errorf("expected score=0.40, got %.4f", s)
			}
			if dec, _ := ev.Payload["decision"].(string); dec != "divert" {
				t.Errorf("expected decision=divert, got %q", dec)
			}
		}
	}
	if !found {
		t.Errorf("expected confidence_evaluated for tool node 'act'; events: %v", eventKinds(stub))
	}
}

// fixedEstimator is a test-only ConfidenceEstimator that always returns the
// same score, regardless of node or vars.
type fixedEstimator float64

func (f fixedEstimator) Name() string { return "fixed" }
func (f fixedEstimator) Estimate(_ context.Context, _ Node, _ map[string]any, _ Sampler) float64 {
	return float64(f)
}

// ---- SelfConsistencyEstimator unit tests ----

// mockSampler returns a fixed reply for every call and counts invocations.
type mockSampler struct {
	reply   string
	err     error
	calls   int
	replies []string // if set, returns replies[i%len] per call (round-robin votes)
}

func (m *mockSampler) fn() Sampler {
	return func(_ context.Context, _ string, _ string) (string, error) {
		i := m.calls
		m.calls++
		if m.err != nil {
			return "", m.err
		}
		if len(m.replies) > 0 {
			return m.replies[i%len(m.replies)], nil
		}
		return m.reply, nil
	}
}

func toolNode() Node {
	return Node{ID: "n", Type: "tool", Data: map[string]any{"tool": "email.send", "args": map[string]any{"to": "x@y.com"}}}
}

func TestSelfConsistency_ConsensusYes_HighScore(t *testing.T) {
	m := &mockSampler{reply: "YES — well specified and safe."}
	est := SelfConsistencyEstimator{Samples: 5}
	score := est.Estimate(context.Background(), toolNode(), map[string]any{}, m.fn())
	if score != 1.0 {
		t.Errorf("unanimous YES: got %.2f, want 1.0", score)
	}
	if m.calls != 5 {
		t.Errorf("expected 5 samples, got %d", m.calls)
	}
}

func TestSelfConsistency_SplitVote_LowScore(t *testing.T) {
	// 2 YES, 2 NO over 4 usable samples → 0.5 (would divert at 0.75).
	m := &mockSampler{replies: []string{"YES do it", "NO too risky", "yes", "no"}}
	est := SelfConsistencyEstimator{Samples: 4}
	score := est.Estimate(context.Background(), toolNode(), map[string]any{}, m.fn())
	if score != 0.5 {
		t.Errorf("split vote: got %.2f, want 0.50", score)
	}
}

func TestSelfConsistency_NilSampler_FallsBack(t *testing.T) {
	// No sampler → must fall back to the verbalization heuristic (default 0.9).
	est := SelfConsistencyEstimator{Samples: 5, Fallback: VerbalizationHeuristic{DefaultConfidence: 0.9}}
	score := est.Estimate(context.Background(), toolNode(), map[string]any{}, nil)
	if score != 0.9 {
		t.Errorf("nil sampler fallback: got %.2f, want 0.90", score)
	}
}

func TestSelfConsistency_UndescribableAction_FallsBack(t *testing.T) {
	// A node with no describable action → fall back rather than judge nothing.
	m := &mockSampler{reply: "YES"}
	est := SelfConsistencyEstimator{Samples: 5, Fallback: VerbalizationHeuristic{DefaultConfidence: 0.8}}
	score := est.Estimate(context.Background(), Node{ID: "n", Type: "tool", Data: map[string]any{}}, map[string]any{}, m.fn())
	if score != 0.8 {
		t.Errorf("undescribable action: got %.2f, want 0.80 (fallback)", score)
	}
	if m.calls != 0 {
		t.Errorf("must not sample an undescribable action, got %d calls", m.calls)
	}
}

func TestSelfConsistency_AllSamplesFail_FallsBack(t *testing.T) {
	m := &mockSampler{err: context.DeadlineExceeded}
	est := SelfConsistencyEstimator{Samples: 3, Fallback: VerbalizationHeuristic{DefaultConfidence: 0.7}}
	score := est.Estimate(context.Background(), toolNode(), map[string]any{}, m.fn())
	if score != 0.7 {
		t.Errorf("all samples failed: got %.2f, want 0.70 (fallback)", score)
	}
}

func TestSelfConsistency_VerbalizedDoubtLowersConsensus(t *testing.T) {
	// Unanimous YES (1.0) but a prior step verbalized 30% → the model's own
	// doubt wins (min), so the step still diverts.
	m := &mockSampler{reply: "YES"}
	est := SelfConsistencyEstimator{Samples: 3}
	vars := map[string]any{"steps": map[string]any{"plan": "risky. Confidence: 30%"}}
	score := est.Estimate(context.Background(), toolNode(), vars, m.fn())
	if score != 0.30 {
		t.Errorf("verbalized doubt should lower consensus: got %.2f, want 0.30", score)
	}
}

func TestParseYesNo(t *testing.T) {
	cases := []struct {
		in   string
		vote bool
		ok   bool
	}{
		{"YES, safe.", true, true},
		{"no — premature", false, true},
		{"  **Yes**", true, true},
		{"\"NO\"", false, true},
		{"maybe, unclear", false, false},
		{"", false, false},
	}
	for _, c := range cases {
		vote, ok := parseYesNo(c.in)
		if ok != c.ok || (ok && vote != c.vote) {
			t.Errorf("parseYesNo(%q): got (%v,%v), want (%v,%v)", c.in, vote, ok, c.vote, c.ok)
		}
	}
}

func TestDescribeAction(t *testing.T) {
	if got := describeAction(Node{Type: "tool", Data: map[string]any{"tool": "fs.write"}}); !strings.Contains(got, "fs.write") {
		t.Errorf("tool: got %q", got)
	}
	if got := describeAction(Node{Type: "connector", Data: map[string]any{"connector": "slack", "action": "post"}}); !strings.Contains(got, "slack") || !strings.Contains(got, "post") {
		t.Errorf("connector: got %q", got)
	}
	if got := describeAction(Node{Type: "tool", Data: map[string]any{}}); got != "" {
		t.Errorf("empty tool: want \"\", got %q", got)
	}
}
