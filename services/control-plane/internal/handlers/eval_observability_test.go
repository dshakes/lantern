package handlers

import (
	"testing"
	"time"
)

func ts(min int) time.Time { return time.Date(2026, 7, 6, 12, min, 0, 0, time.UTC) }

func TestClusterFailures(t *testing.T) {
	runs := []runCases{
		{RunID: "r1", CreatedAt: ts(1), Cases: []evalCaseResult{
			{Name: "grounding", Passed: false, Error: "old err", Expected: "X", Actual: "Y"},
			{Name: "latency", Passed: true},
		}},
		{RunID: "r2", CreatedAt: ts(3), Cases: []evalCaseResult{
			{Name: "grounding", Passed: false, Error: "new err", Expected: "X2", Actual: "Y2"},
			{Name: "latency", Passed: false, Error: "slow"},
		}},
		{RunID: "r3", CreatedAt: ts(2), Cases: []evalCaseResult{
			{Name: "grounding", Passed: true},
		}},
	}
	got := clusterFailures(runs)
	if len(got) != 2 {
		t.Fatalf("clusters = %d, want 2", len(got))
	}
	// grounding: 2 failures / 3 seen; ranked first (more failures than latency's 1).
	g := got[0]
	if g.Case != "grounding" || g.Failures != 2 || g.Seen != 3 {
		t.Fatalf("grounding cluster = %+v", g)
	}
	if g.FailRate < 0.66 || g.FailRate > 0.67 {
		t.Errorf("failRate = %v, want ~0.667", g.FailRate)
	}
	// Latest (by time, r2 @ min3) triage detail wins.
	if g.SampleError != "new err" || g.Expected != "X2" || g.Actual != "Y2" {
		t.Errorf("expected latest triage detail, got err=%q exp=%q act=%q", g.SampleError, g.Expected, g.Actual)
	}
	if !g.FirstSeen.Equal(ts(1)) || !g.LastSeen.Equal(ts(3)) {
		t.Errorf("first/last seen = %v / %v", g.FirstSeen, g.LastSeen)
	}
	if got[1].Case != "latency" || got[1].Failures != 1 {
		t.Errorf("second cluster = %+v", got[1])
	}
}

func TestClusterFailures_AllPass(t *testing.T) {
	runs := []runCases{{RunID: "r1", CreatedAt: ts(1), Cases: []evalCaseResult{
		{Name: "a", Passed: true}, {Name: "b", Passed: true},
	}}}
	if got := clusterFailures(runs); len(got) != 0 {
		t.Fatalf("clusters = %d, want 0 (nothing failed)", len(got))
	}
}

func TestComputeTrend(t *testing.T) {
	// Prior mean 0.9; latest 0.6 → regressing.
	pts := []TrendPoint{
		{Score: 0.9}, {Score: 0.9}, {Score: 0.6},
	}
	r := computeTrend(pts)
	if !r.Regressing {
		t.Errorf("expected regressing")
	}
	if r.LatestVs > -0.29 || r.LatestVs < -0.31 {
		t.Errorf("latestVsMean = %v, want ~-0.3", r.LatestVs)
	}

	// Improving.
	up := computeTrend([]TrendPoint{{Score: 0.5}, {Score: 0.9}})
	if up.Regressing {
		t.Errorf("expected not regressing")
	}

	// Single point → no signal.
	one := computeTrend([]TrendPoint{{Score: 0.7}})
	if one.Regressing || one.LatestVs != 0 {
		t.Errorf("single point should have no regression signal, got %+v", one)
	}
}

func TestClampLimit(t *testing.T) {
	cases := []struct {
		raw            string
		def, max, want int
	}{
		{"", 50, 200, 50},
		{"0", 50, 200, 50},
		{"-5", 50, 200, 50},
		{"abc", 50, 200, 50},
		{"10", 50, 200, 10},
		{"500", 50, 200, 200},
	}
	for _, c := range cases {
		if got := clampLimit(c.raw, c.def, c.max); got != c.want {
			t.Errorf("clampLimit(%q,%d,%d) = %d, want %d", c.raw, c.def, c.max, got, c.want)
		}
	}
}
