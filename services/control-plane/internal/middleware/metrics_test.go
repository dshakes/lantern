package middleware

import (
	"context"
	"sync"
	"testing"
)

// TestMetrics_NoPanic verifies that all Record* functions are safe to call when
// the global OTel MeterProvider is the default no-op implementation (i.e. when
// telemetry is disabled). This is the common case in unit-test and dev
// environments. Instruments created from the no-op provider must never panic.
func TestMetrics_NoPanic(t *testing.T) {
	// Reset the once so we get a fresh init with whatever global provider is
	// set (the default no-op in test environments).
	metricsOnce = sync.Once{}

	ctx := context.Background()
	// None of these should panic.
	RecordStepDuration(ctx, "my-agent", "ai-step", "shared", "ok", 123.4)
	RecordStepDuration(ctx, "my-agent", "connector", "shared", "failed", 0)
	RecordStepDuration(ctx, "my-agent", "tool", "microvm", "retried", 456.7)
	RecordStepRetries(ctx, "my-agent", "connector", "shared", 2)
	RecordReplaySkip(ctx, "my-agent")
	RecordBudgetBlock(ctx, "blocked-agent")
	RecordRunTotal(ctx, "my-agent", "shared", "succeeded")
	RecordRunTotal(ctx, "my-agent", "shared", "failed")
}

// TestMetrics_Idempotent verifies that ensureMetrics is safe to call
// concurrently and that repeated Record* calls don't panic.
func TestMetrics_Idempotent(t *testing.T) {
	metricsOnce = sync.Once{}
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			RecordStepDuration(ctx, "agent", "ai-step", "shared", "ok", 10)
			RecordRunTotal(ctx, "agent", "shared", "succeeded")
		}()
	}
	wg.Wait()
}
