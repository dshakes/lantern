package middleware

import (
	"context"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Runtime metric instruments. Initialised lazily on first use (ensureMetrics)
// so the package is safe to import when telemetry is disabled — the global
// MeterProvider defaults to a no-op implementation and all instruments it
// creates are cheap no-ops that never allocate or panic.
//
// Attribute keys follow the lantern.* convention used in EnrichSpan so spans
// and metrics are filterable by the same dimensions.
var (
	metricsOnce  sync.Once
	mStepDur     metric.Float64Histogram // lantern.run.step.duration (ms)
	mStepRetries metric.Int64Counter     // lantern.run.step.retries
	mReplaySkips metric.Int64Counter     // lantern.run.replay.skips
	mBudgetBlock metric.Int64Counter     // lantern.run.budget.blocks
	mRunTotal    metric.Int64Counter     // lantern.run.total
)

func ensureMetrics() {
	metricsOnce.Do(func() {
		m := otel.GetMeterProvider().Meter("lantern.runtime")
		// Per OTel spec, Meter methods return a no-op instrument on error, never nil.
		// Errors are discarded; a misconfigured meter name is never a crash path.
		mStepDur, _ = m.Float64Histogram("lantern.run.step.duration",
			metric.WithUnit("ms"),
			metric.WithDescription("Workflow step wall-clock duration in milliseconds"),
		)
		mStepRetries, _ = m.Int64Counter("lantern.run.step.retries",
			metric.WithDescription("Number of workflow step retry attempts beyond the first"),
		)
		mReplaySkips, _ = m.Int64Counter("lantern.run.replay.skips",
			metric.WithDescription("CompletedStep cache hits during crash-resume replay"),
		)
		mBudgetBlock, _ = m.Int64Counter("lantern.run.budget.blocks",
			metric.WithDescription("Runs blocked by agent budget hard-fail (HTTP 402)"),
		)
		mRunTotal, _ = m.Int64Counter("lantern.run.total",
			metric.WithDescription("Total agent runs dispatched through the inline executor"),
		)
	})
}

// RecordStepDuration records a single workflow step's execution time against
// lantern.run.step.duration with the standard lantern.* attribute set.
//
//   - agentName:  agent that owns the run.
//   - nodeType:   workflow node type (ai-step, tool, connector, …).
//   - tier:       execution tier ("shared" for inline executor, "microvm" for headless).
//   - outcome:    "ok", "failed", or "retried" (succeeded after ≥1 retry).
//   - ms:         wall-clock duration of the step (including all retry backoff).
func RecordStepDuration(ctx context.Context, agentName, nodeType, tier, outcome string, ms float64) {
	ensureMetrics()
	mStepDur.Record(ctx, ms, metric.WithAttributes(
		attribute.String("lantern.agent_name", agentName),
		attribute.String("lantern.node_type", nodeType),
		attribute.String("lantern.tier", tier),
		attribute.String("lantern.outcome", outcome),
	))
}

// RecordStepRetries adds retryCount to the lantern.run.step.retries counter.
// Only call when retryCount > 0 (i.e. the step needed at least one extra attempt).
func RecordStepRetries(ctx context.Context, agentName, nodeType, tier string, retryCount int64) {
	ensureMetrics()
	mStepRetries.Add(ctx, retryCount, metric.WithAttributes(
		attribute.String("lantern.agent_name", agentName),
		attribute.String("lantern.node_type", nodeType),
		attribute.String("lantern.tier", tier),
	))
}

// RecordReplaySkip increments lantern.run.replay.skips once per CompletedStep
// cache hit (i.e. per step the crash-resume path skips re-executing).
func RecordReplaySkip(ctx context.Context, agentName string) {
	ensureMetrics()
	mReplaySkips.Add(ctx, 1, metric.WithAttributes(
		attribute.String("lantern.agent_name", agentName),
	))
}

// RecordBudgetBlock increments lantern.run.budget.blocks when a run is denied
// by the agent's hard-fail budget policy (HTTP 402).
func RecordBudgetBlock(ctx context.Context, agentName string) {
	ensureMetrics()
	mBudgetBlock.Add(ctx, 1, metric.WithAttributes(
		attribute.String("lantern.agent_name", agentName),
	))
}

// RecordRunTotal increments lantern.run.total once per completed run.
//
//   - tier:   "shared" (inline executor) or "microvm" (headless runtime).
//   - status: "succeeded" or "failed".
func RecordRunTotal(ctx context.Context, agentName, tier, status string) {
	ensureMetrics()
	mRunTotal.Add(ctx, 1, metric.WithAttributes(
		attribute.String("lantern.agent_name", agentName),
		attribute.String("lantern.tier", tier),
		attribute.String("lantern.status", status),
	))
}
