package workflow

import (
	"context"
	"math"
	"testing"
)

// TestCalibratedEstimator_Math verifies the calibration formula and all
// edge cases (zero regret, high regret, clamping, nil lookup, monotonicity).
func TestCalibratedEstimator_Math(t *testing.T) {
	ctx := context.Background()
	node := Node{ID: "n1", Type: "tool"}

	cases := []struct {
		name      string
		base      float64
		regret    float64 // simulated return from RegretLookup
		wantLow   float64 // adjusted must be >= wantLow
		wantHigh  float64 // adjusted must be <= wantHigh
		wantExact *float64
	}{
		{
			name:   "zero regret passes through unchanged",
			base:   0.9,
			regret: 0.0,
			// adjusted = 0.9 * (1-0) = 0.9
			wantLow: 0.9, wantHigh: 0.9,
		},
		{
			name:   "low regret lowers score proportionally",
			base:   0.8,
			regret: 0.2,
			// adjusted = 0.8 * 0.8 = 0.64
			wantLow: 0.639, wantHigh: 0.641,
		},
		{
			name:   "high regret 0.5 halves the score",
			base:   0.9,
			regret: 0.5,
			// adjusted = 0.9 * 0.5 = 0.45
			wantLow: 0.449, wantHigh: 0.451,
		},
		{
			name:   "full regret 1.0 drives score to zero",
			base:   0.9,
			regret: 1.0,
			// adjusted = 0.9 * 0.0 = 0.0
			wantLow: 0.0, wantHigh: 0.001,
		},
		{
			name:   "negative regret treated as zero (fail-safe: no raise)",
			base:   0.6,
			regret: -0.5,
			// regret <= 0 → base returned unchanged
			wantLow: 0.6, wantHigh: 0.6,
		},
		{
			name:    "base=1.0 regret=0.25 → 0.75",
			base:    1.0,
			regret:  0.25,
			wantLow: 0.749, wantHigh: 0.751,
		},
		{
			name:   "base=0.0 with regret still 0",
			base:   0.0,
			regret: 0.8,
			// 0.0 * 0.2 = 0.0
			wantLow: 0.0, wantHigh: 0.0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			est := CalibratedEstimator{
				Base: fixedEstimator(tc.base),
				Regret: func(_ context.Context, _ string) float64 {
					return tc.regret
				},
			}
			got := est.Estimate(ctx, node, nil, nil)
			if got < tc.wantLow || got > tc.wantHigh {
				t.Errorf("Estimate() = %.6f, want in [%.6f, %.6f]", got, tc.wantLow, tc.wantHigh)
			}
		})
	}
}

// TestCalibratedEstimator_NilLookup verifies that a nil RegretLookup passes
// the base score through unchanged (fail-safe).
func TestCalibratedEstimator_NilLookup(t *testing.T) {
	ctx := context.Background()
	node := Node{ID: "n1", Type: "connector"}
	est := CalibratedEstimator{
		Base:   fixedEstimator(0.85),
		Regret: nil,
	}
	got := est.Estimate(ctx, node, nil, nil)
	if math.Abs(got-0.85) > 1e-9 {
		t.Errorf("got %.6f, want 0.85 (nil Regret must pass through)", got)
	}
}

// TestCalibratedEstimator_Name verifies the compound name preserves the inner
// estimator's name.
func TestCalibratedEstimator_Name(t *testing.T) {
	c := CalibratedEstimator{Base: fixedEstimator(0.9)}
	got := c.Name()
	want := "calibrated(fixed)"
	if got != want {
		t.Errorf("Name() = %q, want %q", got, want)
	}

	vh := CalibratedEstimator{Base: VerbalizationHeuristic{DefaultConfidence: 0.9}}
	if got := vh.Name(); got != "calibrated(verbalization_heuristic)" {
		t.Errorf("Name() = %q, want %q", got, "calibrated(verbalization_heuristic)")
	}
}

// TestCalibratedEstimator_Monotone verifies calibration is monotonically
// non-increasing as regret increases: higher regret → lower or equal score.
func TestCalibratedEstimator_Monotone(t *testing.T) {
	ctx := context.Background()
	node := Node{ID: "n1", Type: "tool"}
	const base = 0.9
	regrets := []float64{0.0, 0.1, 0.2, 0.5, 0.75, 0.99, 1.0}
	prev := base + 1.0
	for _, r := range regrets {
		regret := r // capture
		est := CalibratedEstimator{
			Base:   fixedEstimator(base),
			Regret: func(_ context.Context, _ string) float64 { return regret },
		}
		got := est.Estimate(ctx, node, nil, nil)
		if got > prev+1e-9 {
			t.Errorf("non-monotone: regret %.2f gave %.6f > prev %.6f", r, got, prev)
		}
		prev = got
	}
}

// TestCalibratedEstimator_Clamped verifies the adjusted score is always [0, 1].
func TestCalibratedEstimator_Clamped(t *testing.T) {
	ctx := context.Background()
	node := Node{ID: "n1", Type: "tool"}
	// Pathological: base > 1 due to a broken inner estimator should still clamp.
	est := CalibratedEstimator{
		Base:   fixedEstimator(0.0),
		Regret: func(_ context.Context, _ string) float64 { return 1.0 },
	}
	got := est.Estimate(ctx, node, nil, nil)
	if got < 0 || got > 1 {
		t.Errorf("Estimate() = %.6f is outside [0, 1]", got)
	}
}

// TestCalibratedEstimator_NeverRaises verifies calibration never increases the
// score regardless of regret value (regret is always non-negative by contract,
// but we guard against caller bugs too).
func TestCalibratedEstimator_NeverRaises(t *testing.T) {
	ctx := context.Background()
	node := Node{ID: "n1", Type: "tool"}
	const base = 0.7
	for _, regret := range []float64{-1.0, -0.1, 0.0, 0.3} {
		r := regret
		est := CalibratedEstimator{
			Base:   fixedEstimator(base),
			Regret: func(_ context.Context, _ string) float64 { return r },
		}
		got := est.Estimate(ctx, node, nil, nil)
		if got > base+1e-9 {
			t.Errorf("regret=%.2f: score rose from %.2f to %.6f (must never rise)", r, base, got)
		}
	}
}

// TestVerbalizationHeuristic_Name verifies the estimator satisfies Name().
func TestVerbalizationHeuristic_Name(t *testing.T) {
	var e ConfidenceEstimator = VerbalizationHeuristic{DefaultConfidence: 0.9}
	if got := e.Name(); got != "verbalization_heuristic" {
		t.Errorf("Name() = %q, want %q", got, "verbalization_heuristic")
	}
}
