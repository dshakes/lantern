package middleware

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// findAttr returns the value of key on the span's recorded attributes.
func findAttr(attrs []attribute.KeyValue, key string) (attribute.KeyValue, bool) {
	for _, kv := range attrs {
		if string(kv.Key) == key {
			return kv, true
		}
	}
	return attribute.KeyValue{}, false
}

// startRecordedSpan installs an in-memory recorder, starts a span, and returns
// its context plus a function that ends the span and yields its attributes.
func startRecordedSpan(t *testing.T) (context.Context, func() []attribute.KeyValue) {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	ctx, span := tp.Tracer("test").Start(context.Background(), "unit")
	return ctx, func() []attribute.KeyValue {
		span.End()
		ended := rec.Ended()
		if len(ended) != 1 {
			t.Fatalf("expected exactly 1 ended span, got %d", len(ended))
		}
		return ended[0].Attributes()
	}
}

func TestEnrichSpan_StampsIdentifiers(t *testing.T) {
	tests := []struct {
		name                          string
		tenantID, userID, runID, step string
		want                          map[string]string // key -> value; absent key means "must NOT be present"
		absent                        []string
	}{
		{
			name:     "all four ids",
			tenantID: "tnt-1", userID: "usr-1", runID: "run-1", step: "step-1",
			want: map[string]string{
				AttrTenantID: "tnt-1",
				AttrUserID:   "usr-1",
				AttrRunID:    "run-1",
				AttrStepID:   "step-1",
			},
		},
		{
			name:     "tenant only — empties skipped",
			tenantID: "tnt-2",
			want:     map[string]string{AttrTenantID: "tnt-2"},
			absent:   []string{AttrUserID, AttrRunID, AttrStepID},
		},
		{
			name:     "http shape: tenant+user+run, no step",
			tenantID: "tnt-3", userID: "usr-3", runID: "run-3",
			want:   map[string]string{AttrTenantID: "tnt-3", AttrUserID: "usr-3", AttrRunID: "run-3"},
			absent: []string{AttrStepID},
		},
		{
			name:   "all empty — no attributes",
			absent: []string{AttrTenantID, AttrUserID, AttrRunID, AttrStepID},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, finish := startRecordedSpan(t)
			EnrichSpan(ctx, tc.tenantID, tc.userID, tc.runID, tc.step)
			attrs := finish()

			for key, wantVal := range tc.want {
				kv, ok := findAttr(attrs, key)
				if !ok {
					t.Errorf("attribute %q missing from span", key)
					continue
				}
				if got := kv.Value.AsString(); got != wantVal {
					t.Errorf("attribute %q = %q, want %q", key, got, wantVal)
				}
			}
			for _, key := range tc.absent {
				if _, ok := findAttr(attrs, key); ok {
					t.Errorf("attribute %q should be absent but was present", key)
				}
			}
		})
	}
}

// TestEnrichSpan_NoopSpan verifies the call is safe (no panic) when there is no
// span in context — the telemetry-disabled path. trace.SpanFromContext returns
// a non-recording no-op span; EnrichSpan must return cleanly.
func TestEnrichSpan_NoopSpan(t *testing.T) {
	// Context with an explicit no-op span (telemetry disabled).
	ctx := trace.ContextWithSpan(context.Background(), trace.SpanFromContext(context.Background()))
	EnrichSpan(ctx, "tnt", "usr", "run", "step") // must not panic

	// Also the bare background context (no span attached at all).
	EnrichSpan(context.Background(), "tnt", "usr", "run", "step") // must not panic
}
