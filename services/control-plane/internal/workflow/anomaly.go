package workflow

import "fmt"

// AnomalyKind identifies the category of a detected anomaly.
type AnomalyKind string

const (
	// KindRunawayLoop fires when a loop's iteration count exceeds the soft
	// threshold. The hard cap in executeLoop stops execution; this fires
	// earlier so the journal records the anomaly before execution halts.
	KindRunawayLoop AnomalyKind = "runaway_loop"

	// KindExcessiveSteps fires when the cumulative node-visit count
	// approaches or exceeds the configured limit.
	KindExcessiveSteps AnomalyKind = "excessive_steps"

	// KindRetryStorm fires when the cumulative retry count exceeds the limit.
	KindRetryStorm AnomalyKind = "retry_storm"

	// KindCostSpike fires when the cumulative cost_usd exceeds the limit.
	KindCostSpike AnomalyKind = "cost_spike"

	// KindTokenSpike fires when the cumulative token count exceeds the limit.
	KindTokenSpike AnomalyKind = "token_spike"
)

// Anomaly describes a single detected anomaly.
type Anomaly struct {
	Kind     AnomalyKind
	Observed float64 // the value that triggered the anomaly
	Limit    float64 // the threshold that was exceeded
	Message  string
}

// RunStats carries the counters the detector inspects.
type RunStats struct {
	Iterations int     // total loop iterations so far
	Steps      int     // total workflow nodes visited
	Retries    int     // cumulative retry count
	CostUSD    float64 // cumulative cost in USD
	Tokens     int64   // cumulative token count (in + out)
}

// AnomalyLimits carries the thresholds for each detector dimension.
// A zero value for any limit disables checking for that dimension.
type AnomalyLimits struct {
	MaxIterations int
	MaxSteps      int
	MaxRetries    int
	MaxCostUSD    float64
	MaxTokens     int64
}

// DefaultAnomalyLimits returns conservative defaults used when no
// agent-specific budget is configured.
func DefaultAnomalyLimits() AnomalyLimits {
	return AnomalyLimits{
		MaxIterations: 500,
		MaxSteps:      80,
		MaxRetries:    10,
		MaxCostUSD:    5.0,
		MaxTokens:     500_000,
	}
}

// DetectAnomalies is a pure, side-effect-free function that checks stats
// against limits and returns all anomalies found. Callers emit the results
// as journal events and/or log warnings; this function never writes to any
// store. An empty slice means everything is within limits.
func DetectAnomalies(stats RunStats, limits AnomalyLimits) []Anomaly {
	var out []Anomaly

	if limits.MaxIterations > 0 && stats.Iterations > limits.MaxIterations {
		out = append(out, Anomaly{
			Kind:     KindRunawayLoop,
			Observed: float64(stats.Iterations),
			Limit:    float64(limits.MaxIterations),
			Message:  fmt.Sprintf("loop iteration count %d exceeds limit %d", stats.Iterations, limits.MaxIterations),
		})
	}

	if limits.MaxSteps > 0 && stats.Steps > limits.MaxSteps {
		out = append(out, Anomaly{
			Kind:     KindExcessiveSteps,
			Observed: float64(stats.Steps),
			Limit:    float64(limits.MaxSteps),
			Message:  fmt.Sprintf("step count %d exceeds limit %d", stats.Steps, limits.MaxSteps),
		})
	}

	if limits.MaxRetries > 0 && stats.Retries > limits.MaxRetries {
		out = append(out, Anomaly{
			Kind:     KindRetryStorm,
			Observed: float64(stats.Retries),
			Limit:    float64(limits.MaxRetries),
			Message:  fmt.Sprintf("retry count %d exceeds limit %d", stats.Retries, limits.MaxRetries),
		})
	}

	if limits.MaxCostUSD > 0 && stats.CostUSD > limits.MaxCostUSD {
		out = append(out, Anomaly{
			Kind:     KindCostSpike,
			Observed: stats.CostUSD,
			Limit:    limits.MaxCostUSD,
			Message:  fmt.Sprintf("cumulative cost $%.4f exceeds limit $%.4f", stats.CostUSD, limits.MaxCostUSD),
		})
	}

	if limits.MaxTokens > 0 && stats.Tokens > limits.MaxTokens {
		out = append(out, Anomaly{
			Kind:     KindTokenSpike,
			Observed: float64(stats.Tokens),
			Limit:    float64(limits.MaxTokens),
			Message:  fmt.Sprintf("token count %d exceeds limit %d", stats.Tokens, limits.MaxTokens),
		})
	}

	return out
}
