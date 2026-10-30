package handlers

import (
	"context"
	"testing"

	"github.com/dshakes/lantern/services/control-plane/internal/workflow"
)

// The confidence gate's default estimator is self-consistency (GA-AUDIT A4):
// an unset PAL_CONFIDENCE_ESTIMATOR must not fall back to the verbalization
// heuristic, whose silence -> 0.9 -> auto-execute mode is the failure we close.
func TestSelectConfidenceEstimator(t *testing.T) {
	cases := []struct {
		name, est, samples string
		wantSC             bool
		wantSamples        int
	}{
		{"unset defaults to self-consistency", "", "", true, 5},
		{"whitespace defaults to self-consistency", "  ", "", true, 5},
		{"explicit self-consistency", "self-consistency", "", true, 5},
		{"underscore alias", "self_consistency", "3", true, 3},
		{"sampling alias", "Sampling", "", true, 5},
		{"unknown value stays on the safer default", "bogus", "", true, 5},
		{"samples out of range ignored", "", "42", true, 5},
		{"samples non-numeric ignored", "", "x", true, 5},
		{"opt-out verbalization", "verbalization", "", false, 0},
		{"opt-out heuristic alias", "HEURISTIC", "", false, 0},
		{"opt-out full name", "verbalization_heuristic", "", false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			est := selectConfidenceEstimator(tc.est, tc.samples)
			sc, isSC := est.(workflow.SelfConsistencyEstimator)
			if isSC != tc.wantSC {
				t.Fatalf("got %T (%s), wantSelfConsistency=%v", est, est.Name(), tc.wantSC)
			}
			if !isSC {
				if est.Name() != "verbalization_heuristic" {
					t.Fatalf("opt-out estimator name = %q", est.Name())
				}
				return
			}
			if sc.Samples != tc.wantSamples {
				t.Fatalf("samples = %d, want %d", sc.Samples, tc.wantSamples)
			}
			if _, ok := sc.Fallback.(workflow.VerbalizationHeuristic); !ok {
				t.Fatalf("fallback = %T, want VerbalizationHeuristic", sc.Fallback)
			}
		})
	}
}

// With no LLM wired (nil sampler) the default estimator must degrade to the
// heuristic's score rather than failing or fabricating agreement.
func TestSelectConfidenceEstimator_DefaultDegradesWithoutSampler(t *testing.T) {
	est := selectConfidenceEstimator("", "")
	node := workflow.Node{ID: "n1", Type: "tool", Data: map[string]any{"toolName": "send_email"}}
	got := est.Estimate(context.Background(), node, map[string]any{}, nil)
	want := workflow.VerbalizationHeuristic{DefaultConfidence: 0.9}.Estimate(context.Background(), node, map[string]any{}, nil)
	if got != want {
		t.Fatalf("nil-sampler score = %v, want heuristic %v", got, want)
	}
}

// buildConfidenceGate stays default OFF regardless of the estimator default.
func TestBuildConfidenceGate_DefaultOff(t *testing.T) {
	t.Setenv("PAL_CONFIDENCE_GATE", "")
	h := &RESTHandler{}
	if g := h.buildConfidenceGate("t", "a"); g != nil {
		t.Fatalf("gate enabled with PAL_CONFIDENCE_GATE unset: %+v", g)
	}
}

func TestBuildConfidenceGate_EnabledUsesSelfConsistency(t *testing.T) {
	t.Setenv("PAL_CONFIDENCE_GATE", "1")
	t.Setenv("PAL_CONFIDENCE_ESTIMATOR", "")
	t.Setenv("PAL_CONFIDENCE_CALIBRATE", "")
	h := &RESTHandler{}
	g := h.buildConfidenceGate("t", "a")
	if g == nil {
		t.Fatal("gate nil with PAL_CONFIDENCE_GATE=1")
	}
	if g.Estimator.Name() != (workflow.SelfConsistencyEstimator{}).Name() {
		t.Fatalf("default estimator = %q", g.Estimator.Name())
	}
}
