// Package telemetry initialises the OpenTelemetry TracerProvider for the
// control-plane. It is env-gated: when neither OTEL_EXPORTER_OTLP_ENDPOINT
// nor LANTERN_OTEL_ENABLED=1 is set, a no-op provider is installed and the
// returned shutdown function is safe to call but does nothing. This means the
// default behaviour (no collector configured) is completely unchanged.
package telemetry

import (
	"context"
	"fmt"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

// noopShutdown is returned when tracing is disabled.
func noopShutdown(_ context.Context) error { return nil }

// otelEnabled reports whether a real TracerProvider should be configured.
// True when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTel env) or
// LANTERN_OTEL_ENABLED=1 (Lantern-specific override).
func otelEnabled() bool {
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" {
		return true
	}
	return os.Getenv("LANTERN_OTEL_ENABLED") == "1"
}

// InitTracer configures the global OTel TracerProvider and TextMapPropagator.
//
// When tracing is disabled (no endpoint configured) the call installs a no-op
// provider and returns immediately — no network dial, no goroutines, no
// required collector. The returned shutdown func is safe to call in all cases.
//
// When tracing is enabled, an OTLP/HTTP exporter is created pointing at
// OTEL_EXPORTER_OTLP_ENDPOINT (or localhost:4318 if that var is absent but
// LANTERN_OTEL_ENABLED=1). The resource carries service.name=serviceName plus
// the standard OTel SDK resource attributes. W3C TraceContext+Baggage
// propagation is set globally.
//
// The caller must wire the returned shutdown into the process exit path:
//
//	shutdown, err := telemetry.InitTracer(ctx, "lantern.control-plane")
//	if err != nil { /* handle */ }
//	defer shutdown(ctx)
func InitTracer(ctx context.Context, serviceName string) (shutdown func(context.Context) error, err error) {
	if !otelEnabled() {
		// Install a no-op provider so otel.Tracer("...") calls in the codebase
		// continue to compile and run without a provider configured.
		otel.SetTracerProvider(otel.GetTracerProvider()) // already a no-op by default
		return noopShutdown, nil
	}

	res, err := sdkresource.New(ctx,
		sdkresource.WithAttributes(
			semconv.ServiceName(serviceName),
		),
		sdkresource.WithProcessRuntimeDescription(),
		sdkresource.WithTelemetrySDK(),
	)
	if err != nil {
		return noopShutdown, fmt.Errorf("telemetry: build resource: %w", err)
	}

	// OTLP/HTTP exporter. otlptracehttp.New respects the standard
	// OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS env vars.
	// No explicit endpoint option needed when the env var is set.
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		return noopShutdown, fmt.Errorf("telemetry: create OTLP exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)

	// Set global provider + W3C propagators (TraceContext + Baggage).
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return func(shutdownCtx context.Context) error {
		return tp.Shutdown(shutdownCtx)
	}, nil
}
