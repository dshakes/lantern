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
// Attribute keys follow the pal.* convention used in EnrichSpan so spans
// and metrics are filterable by the same dimensions.
var (
	metricsOnce  sync.Once
	mStepDur     metric.Float64Histogram // pal.run.step.duration (ms)
	mStepRetries metric.Int64Counter     // pal.run.step.retries
	mReplaySkips metric.Int64Counter     // pal.run.replay.skips
	mBudgetBlock metric.Int64Counter     // pal.run.budget.blocks
	mBudgetErr   metric.Int64Counter     // pal.budget.check.errors
	mRunTotal    metric.Int64Counter     // pal.run.total
	mOnboard     metric.Int64Counter     // pal.onboarding.step.total
)

func ensureMetrics() {
	metricsOnce.Do(func() {
		m := otel.GetMeterProvider().Meter("pal.runtime")
		// Per OTel spec, Meter methods return a no-op instrument on error, never nil.
		// Errors are discarded; a misconfigured meter name is never a crash path.
		mStepDur, _ = m.Float64Histogram("pal.run.step.duration",
			metric.WithUnit("ms"),
			metric.WithDescription("Workflow step wall-clock duration in milliseconds"),
		)
		mStepRetries, _ = m.Int64Counter("pal.run.step.retries",
			metric.WithDescription("Number of workflow step retry attempts beyond the first"),
		)
		mReplaySkips, _ = m.Int64Counter("pal.run.replay.skips",
			metric.WithDescription("CompletedStep cache hits during crash-resume replay"),
		)
		mBudgetBlock, _ = m.Int64Counter("pal.run.budget.blocks",
			metric.WithDescription("Runs blocked by agent budget hard-fail (HTTP 402)"),
		)
		mBudgetErr, _ = m.Int64Counter("pal.budget.check.errors",
			metric.WithDescription("Budget lookups that errored and failed closed"),
		)
		mRunTotal, _ = m.Int64Counter("pal.run.total",
			metric.WithDescription("Total agent runs dispatched through the inline executor"),
		)
		mOnboard, _ = m.Int64Counter("pal.onboarding.step.total",
			metric.WithDescription("Onboarding steps reached / completed"),
		)
	})
}

// RecordStepDuration records a single workflow step's execution time against
// pal.run.step.duration with the standard pal.* attribute set.
//
//   - agentName:  agent that owns the run.
//   - nodeType:   workflow node type (ai-step, tool, connector, …).
//   - tier:       execution tier ("shared" for inline executor, "microvm" for headless).
//   - outcome:    "ok", "failed", or "retried" (succeeded after ≥1 retry).
//   - ms:         wall-clock duration of the step (including all retry backoff).
func RecordStepDuration(ctx context.Context, agentName, nodeType, tier, outcome string, ms float64) {
	ensureMetrics()
	mStepDur.Record(ctx, ms, metric.WithAttributes(
		attribute.String("pal.agent_name", agentName),
		attribute.String("pal.node_type", nodeType),
		attribute.String("pal.tier", tier),
		attribute.String("pal.outcome", outcome),
	))
}

// RecordStepRetries adds retryCount to the pal.run.step.retries counter.
// Only call when retryCount > 0 (i.e. the step needed at least one extra attempt).
func RecordStepRetries(ctx context.Context, agentName, nodeType, tier string, retryCount int64) {
	ensureMetrics()
	mStepRetries.Add(ctx, retryCount, metric.WithAttributes(
		attribute.String("pal.agent_name", agentName),
		attribute.String("pal.node_type", nodeType),
		attribute.String("pal.tier", tier),
	))
}

// RecordReplaySkip increments pal.run.replay.skips once per CompletedStep
// cache hit (i.e. per step the crash-resume path skips re-executing).
func RecordReplaySkip(ctx context.Context, agentName string) {
	ensureMetrics()
	mReplaySkips.Add(ctx, 1, metric.WithAttributes(
		attribute.String("pal.agent_name", agentName),
	))
}

// RecordBudgetBlock increments pal.run.budget.blocks when a run is denied
// by the agent's hard-fail budget policy (HTTP 402).
func RecordBudgetBlock(ctx context.Context, agentName string) {
	ensureMetrics()
	mBudgetBlock.Add(ctx, 1, metric.WithAttributes(
		attribute.String("pal.agent_name", agentName),
	))
}

// RecordBudgetCheckError increments pal.budget.check.errors when a budget
// lookup errors (not "no budget") and the check fails closed. check is the
// budget scope: "tenant", "agent", "run" or "tool".
func RecordBudgetCheckError(ctx context.Context, check, agentName string) {
	ensureMetrics()
	mBudgetErr.Add(ctx, 1, metric.WithAttributes(
		attribute.String("pal.budget_check", check),
		attribute.String("pal.agent_name", agentName),
	))
}

// RecordRunTotal increments pal.run.total once per completed run.
//
//   - tier:   "shared" (inline executor) or "microvm" (headless runtime).
//   - status: "succeeded" or "failed".
func RecordRunTotal(ctx context.Context, agentName, tier, status string) {
	ensureMetrics()
	mRunTotal.Add(ctx, 1, metric.WithAttributes(
		attribute.String("pal.agent_name", agentName),
		attribute.String("pal.tier", tier),
		attribute.String("pal.status", status),
	))
}

// RecordOnboardingStep increments pal.onboarding.step.total. step is one of
// the fixed onboarding steps (goal|spec|provider|create|run|sandbox|done)
// and event is "reached" or "completed" — a bounded label set, no tenant ids.
func RecordOnboardingStep(ctx context.Context, step, event string) {
	ensureMetrics()
	mOnboard.Add(ctx, 1, metric.WithAttributes(
		attribute.String("pal.onboarding_step", step),
		attribute.String("pal.onboarding_event", event),
	))
}
