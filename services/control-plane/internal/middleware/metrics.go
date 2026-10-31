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
// Instrument and attribute names use the pal.* prefix, matching EnrichSpan.
var (
	metricsOnce  sync.Once
	mStepDur     metric.Float64Histogram // pal.run.step.duration (ms)
	mStepRetries i64Counter              // pal.run.step.retries
	mReplaySkips i64Counter              // pal.run.replay.skips
	mBudgetBlock i64Counter              // pal.run.budget.blocks
	mBudgetErr   i64Counter              // pal.budget.check.errors
	mRunTotal    i64Counter              // pal.run.total
	mOnboard     i64Counter              // pal.onboarding.step.total
)

// i64Counter wraps a counter so call sites pass plain key/value pairs.
type i64Counter struct{ c metric.Int64Counter }

func (p i64Counter) Add(ctx context.Context, n int64, kv ...string) {
	p.c.Add(ctx, n, metric.WithAttributes(attrs("pal.", kv)...))
}

// attrs turns key/value pairs into attributes whose keys carry prefix.
func attrs(prefix string, kv []string) []attribute.KeyValue {
	out := make([]attribute.KeyValue, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		out = append(out, attribute.String(prefix+kv[i], kv[i+1]))
	}
	return out
}

func newI64Counter(m metric.Meter, name string, opts ...metric.Int64CounterOption) i64Counter {
	// Per OTel spec, Meter methods return a no-op instrument on error, never nil.
	// Errors are discarded; a misconfigured meter name is never a crash path.
	c, _ := m.Int64Counter("pal."+name, opts...)
	return i64Counter{c: c}
}

func ensureMetrics() {
	metricsOnce.Do(func() {
		m := otel.GetMeterProvider().Meter("pal.runtime")
		mStepDur, _ = m.Float64Histogram("pal.run.step.duration",
			metric.WithUnit("ms"),
			metric.WithDescription("Workflow step wall-clock duration in milliseconds"))
		mStepRetries = newI64Counter(m, "run.step.retries",
			metric.WithDescription("Number of workflow step retry attempts beyond the first"))
		mReplaySkips = newI64Counter(m, "run.replay.skips",
			metric.WithDescription("CompletedStep cache hits during crash-resume replay"))
		mBudgetBlock = newI64Counter(m, "run.budget.blocks",
			metric.WithDescription("Runs blocked by agent budget hard-fail (HTTP 402)"))
		mBudgetErr = newI64Counter(m, "budget.check.errors",
			metric.WithDescription("Budget lookups that errored and failed closed"))
		mRunTotal = newI64Counter(m, "run.total",
			metric.WithDescription("Total agent runs dispatched through the inline executor"))
		mOnboard = newI64Counter(m, "onboarding.step.total",
			metric.WithDescription("Onboarding steps reached / completed"))
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
	mStepDur.Record(ctx, ms, metric.WithAttributes(attrs("pal.",
		[]string{"agent_name", agentName, "node_type", nodeType, "tier", tier, "outcome", outcome})...))
}

// RecordStepRetries adds retryCount to the pal.run.step.retries counter.
// Only call when retryCount > 0 (i.e. the step needed at least one extra attempt).
func RecordStepRetries(ctx context.Context, agentName, nodeType, tier string, retryCount int64) {
	ensureMetrics()
	mStepRetries.Add(ctx, retryCount,
		"agent_name", agentName,
		"node_type", nodeType,
		"tier", tier,
	)
}

// RecordReplaySkip increments pal.run.replay.skips once per CompletedStep
// cache hit (i.e. per step the crash-resume path skips re-executing).
func RecordReplaySkip(ctx context.Context, agentName string) {
	ensureMetrics()
	mReplaySkips.Add(ctx, 1,
		"agent_name", agentName,
	)
}

// RecordBudgetBlock increments pal.run.budget.blocks when a run is denied
// by the agent's hard-fail budget policy (HTTP 402).
func RecordBudgetBlock(ctx context.Context, agentName string) {
	ensureMetrics()
	mBudgetBlock.Add(ctx, 1,
		"agent_name", agentName,
	)
}

// RecordBudgetCheckError increments pal.budget.check.errors when a budget
// lookup errors (not "no budget") and the check fails closed. check is the
// budget scope: "tenant", "agent", "run" or "tool".
func RecordBudgetCheckError(ctx context.Context, check, agentName string) {
	ensureMetrics()
	mBudgetErr.Add(ctx, 1,
		"budget_check", check,
		"agent_name", agentName,
	)
}

// RecordRunTotal increments pal.run.total once per completed run.
//
//   - tier:   "shared" (inline executor) or "microvm" (headless runtime).
//   - status: "succeeded" or "failed".
func RecordRunTotal(ctx context.Context, agentName, tier, status string) {
	ensureMetrics()
	mRunTotal.Add(ctx, 1,
		"agent_name", agentName,
		"tier", tier,
		"status", status,
	)
}

// RecordOnboardingStep increments pal.onboarding.step.total. step is one of
// the fixed onboarding steps (goal|spec|provider|create|run|sandbox|done)
// and event is "reached" or "completed" — a bounded label set, no tenant ids.
func RecordOnboardingStep(ctx context.Context, step, event string) {
	ensureMetrics()
	mOnboard.Add(ctx, 1,
		"onboarding_step", step,
		"onboarding_event", event,
	)
}
