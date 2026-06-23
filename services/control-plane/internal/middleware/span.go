package middleware

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Span attribute keys. Kept consistent with the rest of the codebase
// (internal/handlers/runtime.go, llm_proxy.go) which already stamp
// "lantern.tenant_id" / "lantern.run_id" on their spans. Using one prefix
// everywhere means a trace can be filtered by tenant/run regardless of which
// service entry point (HTTP, gRPC, internal step) created the span.
const (
	AttrTenantID = "lantern.tenant_id"
	AttrUserID   = "lantern.user_id"
	AttrRunID    = "lantern.run_id"
	AttrStepID   = "lantern.step_id"
)

// EnrichSpan stamps the well-known Lantern identifiers onto whatever span is
// active in ctx. Empty values are skipped so we never emit blank attributes.
//
// It is safe to call when telemetry is disabled: trace.SpanFromContext returns
// a no-op span whose SetAttributes is a cheap no-op, so this never panics and
// adds negligible overhead on the default (no-collector) path.
//
// This is the single chokepoint both the HTTP enrichment middleware and the
// gRPC tracing interceptor funnel through, so the attribute keys can never
// drift between the two entry points.
func EnrichSpan(ctx context.Context, tenantID, userID, runID, stepID string) {
	span := trace.SpanFromContext(ctx)
	if !span.IsRecording() {
		// Fast path: no-op span (telemetry disabled) or a non-recording
		// sampled-out span. Nothing to attach.
		return
	}

	attrs := make([]attribute.KeyValue, 0, 4)
	if tenantID != "" {
		attrs = append(attrs, attribute.String(AttrTenantID, tenantID))
	}
	if userID != "" {
		attrs = append(attrs, attribute.String(AttrUserID, userID))
	}
	if runID != "" {
		attrs = append(attrs, attribute.String(AttrRunID, runID))
	}
	if stepID != "" {
		attrs = append(attrs, attribute.String(AttrStepID, stepID))
	}
	if len(attrs) > 0 {
		span.SetAttributes(attrs...)
	}
}
