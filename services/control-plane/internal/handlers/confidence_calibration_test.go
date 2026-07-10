package handlers

import "testing"

// TestComputeRegretRate exercises the pure math that turns raw DB counts into
// a calibration rate. No DB required.
func TestComputeRegretRate(t *testing.T) {
	cases := []struct {
		name       string
		total      int64
		regrets    int64
		minSamples int
		want       float64
	}{
		{
			name:  "zero total → 0 (no data)",
			total: 0, regrets: 0, minSamples: 3, want: 0,
		},
		{
			name:  "below min samples → 0",
			total: 2, regrets: 2, minSamples: 3, want: 0,
		},
		{
			name:  "exactly min samples, zero regrets → 0",
			total: 3, regrets: 0, minSamples: 3, want: 0,
		},
		{
			name:  "exactly min samples, all regrets → 1",
			total: 3, regrets: 3, minSamples: 3, want: 1,
		},
		{
			name:  "half regrets",
			total: 10, regrets: 5, minSamples: 3, want: 0.5,
		},
		{
			name:  "1 out of 20",
			total: 20, regrets: 1, minSamples: 3, want: 0.05,
		},
		{
			name:  "regrets > total (defensive: clamped to 1)",
			total: 5, regrets: 10, minSamples: 3, want: 1,
		},
		{
			name:  "minSamples=1 accepts single sample",
			total: 1, regrets: 1, minSamples: 1, want: 1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := computeRegretRate(tc.total, tc.regrets, tc.minSamples)
			if got != tc.want {
				t.Errorf("computeRegretRate(%d, %d, %d) = %v, want %v",
					tc.total, tc.regrets, tc.minSamples, got, tc.want)
			}
		})
	}
}
