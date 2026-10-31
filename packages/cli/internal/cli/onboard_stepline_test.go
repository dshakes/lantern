package cli

import (
	"testing"

	"github.com/dshakes/pal/packages/cli/internal"
)

// The server's step events carry the kind as "type" and no duration: the line
// must not print an empty "(kind: )" or a fabricated "(0ms)".
func TestStepLine(t *testing.T) {
	cases := []struct {
		name string
		ev   internal.SSEEvent
		want string
	}{
		{"inline llm start", internal.SSEEvent{Kind: "step_started", StepID: "llm:main", Payload: map[string]any{"name": "llm:main", "type": "llm"}},
			"→ step started: llm:main (llm)"},
		{"llm completed: tokens, no duration", internal.SSEEvent{Kind: "step_completed", StepID: "llm:main", Payload: map[string]any{"result": "hi", "tokens_in": float64(120), "tokens_out": float64(40)}},
			"✓ step completed: llm:main (120→40 tokens)"},
		{"nothing known", internal.SSEEvent{Kind: "step_completed", StepID: "s1", Payload: map[string]any{}},
			"✓ step completed: s1"},
		{"duration when present", internal.SSEEvent{Kind: "step_completed", Payload: map[string]any{"step_id": "n2", "type": "tool", "duration_ms": float64(85)}},
			"✓ step completed: n2 (tool, 85ms)"},
		{"no step id: falls back to name", internal.SSEEvent{Kind: "step_started", Payload: map[string]any{"name": "Summarize", "kind": "ai-step"}},
			"→ step started: Summarize (ai-step)"},
	}
	for _, c := range cases {
		if got := stepLine(&c.ev); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
