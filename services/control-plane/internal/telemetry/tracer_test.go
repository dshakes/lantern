package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// ---------------------------------------------------------------------------
// Test B: InitTracer env-gating behaviour
// ---------------------------------------------------------------------------

// TestInitTracer_NoOp verifies that when no OTEL env vars are set, InitTracer
// returns a working no-op shutdown and doesn't panic.
func TestInitTracer_NoOp(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("LANTERN_OTEL_ENABLED", "")

	ctx := context.Background()
	shutdown, err := InitTracer(ctx, "test-service")
	if err != nil {
		t.Fatalf("InitTracer no-op: unexpected error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("InitTracer no-op: shutdown func must not be nil")
	}
	// Shutdown must not error.
	if err := shutdown(ctx); err != nil {
		t.Errorf("no-op shutdown returned error: %v", err)
	}
	// Global provider must still be usable (returns no-op spans).
	tracer := otel.Tracer("test")
	_, span := tracer.Start(ctx, "probe")
	span.End()
}

// TestInitTracer_EnabledDummyEndpoint checks that when LANTERN_OTEL_ENABLED=1
// is set with a dummy (unreachable) endpoint, InitTracer returns a real
// provider and shutdown without panicking. We don't require the exporter to
// actually connect — OTLP/HTTP exporters are lazy-connecting and
// NewTracerProvider succeeds even with a bad endpoint.
func TestInitTracer_EnabledDummyEndpoint(t *testing.T) {
	// Use a localhost port that is almost certainly closed so we never
	// make a real network call, while still exercising the init code path.
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:19999")
	t.Setenv("LANTERN_OTEL_ENABLED", "1")

	ctx := context.Background()
	shutdown, err := InitTracer(ctx, "test-service")
	if err != nil {
		t.Fatalf("InitTracer with dummy endpoint: unexpected error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must not be nil")
	}
	// Shutdown flushes; with a closed endpoint the exporter will fail
	// internally but Shutdown must not panic and typically returns nil
	// (the SDK swallows export errors during shutdown).
	if shutErr := shutdown(ctx); shutErr != nil {
		t.Logf("shutdown returned error (expected when no collector): %v", shutErr)
		// Not a test failure — the SDK may surface an export error here.
	}
}

// ---------------------------------------------------------------------------
// Helper: install an in-memory recorder as the global TracerProvider.
// Returns the exporter + a cleanup func that restores the prior provider.
// ---------------------------------------------------------------------------

// installRecorder sets up a TracerProvider backed by an InMemoryExporter and
// sets it as the global provider. The returned restore func must be called in
// a defer to avoid polluting other tests.
func installRecorder(t *testing.T) (*tracetest.InMemoryExporter, func()) {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSyncer(exp),
	)
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	return exp, func() {
		_ = tp.Shutdown(context.Background())
		otel.SetTracerProvider(prev)
	}
}
