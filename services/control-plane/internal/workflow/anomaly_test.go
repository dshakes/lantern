package workflow

import (
	"testing"
)

// limitsForTest returns limits with every dimension set to a small value
// so tests can cross them easily without large numbers.
func limitsForTest() AnomalyLimits {
	return AnomalyLimits{
		MaxIterations: 10,
		MaxSteps:      20,
		MaxRetries:    3,
		MaxCostUSD:    1.0,
		MaxTokens:     1000,
	}
}

func TestDetectAnomalies_EmptyWhenWithinLimits(t *testing.T) {
	stats := RunStats{
		Iterations: 5,
		Steps:      10,
		Retries:    1,
		CostUSD:    0.50,
		Tokens:     500,
	}
	got := DetectAnomalies(stats, limitsForTest())
	if len(got) != 0 {
		t.Errorf("expected no anomalies within limits, got %d: %v", len(got), got)
	}
}

func TestDetectAnomalies_AtLimitNotTriggered(t *testing.T) {
	// Exactly at the limit — must NOT trigger (strictly greater-than).
	limits := limitsForTest()
	stats := RunStats{
		Iterations: limits.MaxIterations,
		Steps:      limits.MaxSteps,
		Retries:    limits.MaxRetries,
		CostUSD:    limits.MaxCostUSD,
		Tokens:     limits.MaxTokens,
	}
	got := DetectAnomalies(stats, limits)
	if len(got) != 0 {
		t.Errorf("expected no anomalies at exactly the limit, got %d: %v", len(got), got)
	}
}

func TestDetectAnomalies_RunawayLoop(t *testing.T) {
	limits := limitsForTest()
	stats := RunStats{Iterations: limits.MaxIterations + 1}
	got := DetectAnomalies(stats, limits)
	if len(got) != 1 {
		t.Fatalf("expected 1 anomaly, got %d: %v", len(got), got)
	}
	if got[0].Kind != KindRunawayLoop {
		t.Errorf("expected %s, got %s", KindRunawayLoop, got[0].Kind)
	}
	if got[0].Observed != float64(stats.Iterations) {
		t.Errorf("observed=%v, want %v", got[0].Observed, stats.Iterations)
	}
	if got[0].Limit != float64(limits.MaxIterations) {
		t.Errorf("limit=%v, want %v", got[0].Limit, limits.MaxIterations)
	}
}

func TestDetectAnomalies_ExcessiveSteps(t *testing.T) {
	limits := limitsForTest()
	stats := RunStats{Steps: limits.MaxSteps + 1}
	got := DetectAnomalies(stats, limits)
	if len(got) != 1 {
		t.Fatalf("expected 1 anomaly, got %d: %v", len(got), got)
	}
	if got[0].Kind != KindExcessiveSteps {
		t.Errorf("expected %s, got %s", KindExcessiveSteps, got[0].Kind)
	}
}

func TestDetectAnomalies_RetryStorm(t *testing.T) {
	limits := limitsForTest()
	stats := RunStats{Retries: limits.MaxRetries + 1}
	got := DetectAnomalies(stats, limits)
	if len(got) != 1 {
		t.Fatalf("expected 1 anomaly, got %d: %v", len(got), got)
	}
	if got[0].Kind != KindRetryStorm {
		t.Errorf("expected %s, got %s", KindRetryStorm, got[0].Kind)
	}
}

func TestDetectAnomalies_CostSpike(t *testing.T) {
	limits := limitsForTest()
	stats := RunStats{CostUSD: limits.MaxCostUSD + 0.01}
	got := DetectAnomalies(stats, limits)
	if len(got) != 1 {
		t.Fatalf("expected 1 anomaly, got %d: %v", len(got), got)
	}
	if got[0].Kind != KindCostSpike {
		t.Errorf("expected %s, got %s", KindCostSpike, got[0].Kind)
	}
}

func TestDetectAnomalies_TokenSpike(t *testing.T) {
	limits := limitsForTest()
	stats := RunStats{Tokens: limits.MaxTokens + 1}
	got := DetectAnomalies(stats, limits)
	if len(got) != 1 {
		t.Fatalf("expected 1 anomaly, got %d: %v", len(got), got)
	}
	if got[0].Kind != KindTokenSpike {
		t.Errorf("expected %s, got %s", KindTokenSpike, got[0].Kind)
	}
}

func TestDetectAnomalies_MultipleAnomaliesTogether(t *testing.T) {
	limits := limitsForTest()
	// Exceed all five simultaneously.
	stats := RunStats{
		Iterations: limits.MaxIterations + 1,
		Steps:      limits.MaxSteps + 1,
		Retries:    limits.MaxRetries + 1,
		CostUSD:    limits.MaxCostUSD + 0.01,
		Tokens:     limits.MaxTokens + 1,
	}
	got := DetectAnomalies(stats, limits)
	if len(got) != 5 {
		t.Fatalf("expected 5 anomalies, got %d: %v", len(got), got)
	}
	// Verify each kind appears exactly once.
	seen := map[AnomalyKind]int{}
	for _, a := range got {
		seen[a.Kind]++
	}
	for _, k := range []AnomalyKind{KindRunawayLoop, KindExcessiveSteps, KindRetryStorm, KindCostSpike, KindTokenSpike} {
		if seen[k] != 1 {
			t.Errorf("kind %s appeared %d times, want 1", k, seen[k])
		}
	}
}

func TestDetectAnomalies_ZeroLimitsDisableChecks(t *testing.T) {
	// Zero limits must disable the corresponding check entirely.
	limits := AnomalyLimits{} // all zero
	stats := RunStats{
		Iterations: 1_000_000,
		Steps:      1_000_000,
		Retries:    1_000_000,
		CostUSD:    1_000_000,
		Tokens:     1_000_000_000,
	}
	got := DetectAnomalies(stats, limits)
	if len(got) != 0 {
		t.Errorf("expected no anomalies when all limits are zero (disabled), got %d: %v", len(got), got)
	}
}

func TestDetectAnomalies_MessageNonEmpty(t *testing.T) {
	limits := limitsForTest()
	stats := RunStats{CostUSD: limits.MaxCostUSD + 1}
	got := DetectAnomalies(stats, limits)
	if len(got) != 1 {
		t.Fatalf("expected 1 anomaly, got %d", len(got))
	}
	if got[0].Message == "" {
		t.Error("anomaly message must be non-empty")
	}
}
