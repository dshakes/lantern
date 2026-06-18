package dialer

// TestTracePropagation_GRPCMetadataCarrier verifies the W3C trace-context
// propagation contract for the scheduler → manager leg:
//
//  1. With a real TracerProvider + W3C propagator set globally, injecting a
//     span context into a gRPC metadata.MD carrier produces a "traceparent"
//     key whose value extracts back to the same trace ID.
//  2. GRPCDialer.connFor is wired with otelgrpc.NewClientHandler() so the
//     header is injected automatically on every outgoing RPC. The build + vet
//     gate confirms the option is valid on grpc.NewClient; the round-trip test
//     here confirms the propagation contract is correct.
//
// Infra-free: no live gRPC connection is made.

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc/metadata"
)

// metadataMDCarrier adapts gRPC metadata.MD to the OTel TextMapCarrier
// interface, matching what otelgrpc uses internally.
type metadataMDCarrier metadata.MD

func (m metadataMDCarrier) Get(key string) string {
	vals := metadata.MD(m).Get(key)
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

func (m metadataMDCarrier) Set(key, value string) {
	metadata.MD(m).Set(key, value)
}

func (m metadataMDCarrier) Keys() []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func TestTracePropagation_GRPCMetadataCarrier(t *testing.T) {
	// Install a real (in-memory) TracerProvider and W3C propagator globally.
	// This mirrors what main() does via otel.SetTextMapPropagator at startup.
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()))
	prevTP := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	prevProp := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
		otel.SetTracerProvider(prevTP)
		otel.SetTextMapPropagator(prevProp)
	})

	tracer := otel.Tracer("test.scheduler")
	ctx, span := tracer.Start(context.Background(), "test-schedule")
	defer span.End()

	wantTraceID := span.SpanContext().TraceID()
	if !wantTraceID.IsValid() {
		t.Fatal("tracer returned an invalid (zero) trace ID — provider not wired")
	}

	// Inject into gRPC metadata (what otelgrpc client handler does).
	md := metadata.MD{}
	otel.GetTextMapPropagator().Inject(ctx, metadataMDCarrier(md))

	if vals := md.Get("traceparent"); len(vals) == 0 {
		t.Fatal("inject: traceparent header missing from metadata.MD")
	}

	// Extract (what otelgrpc server handler does on the receiving side).
	extracted := otel.GetTextMapPropagator().Extract(context.Background(), metadataMDCarrier(md))
	gotSC := trace.SpanContextFromContext(extracted)

	if !gotSC.IsValid() {
		t.Fatal("extract: span context is invalid after round-trip")
	}
	if gotSC.TraceID() != wantTraceID {
		t.Errorf("trace ID mismatch: got %s, want %s", gotSC.TraceID(), wantTraceID)
	}
}
