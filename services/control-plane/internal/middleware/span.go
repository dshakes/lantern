package middleware

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Span attribute keys. Every service entry point (HTTP, gRPC, internal step)
// stamps the same keys, so a trace can be filtered by tenant/run regardless of
// which one created the span.
//
// The PAL keys are canonical. The pre-PAL "pal.*" keys are dual-emitted
// for one release (ADR 0032, rename plan step 15) so saved trace queries and
// dashboards outside this repo keep matching while operators migrate them.
const (
	AttrTenantID = "pal.tenant_id"
	AttrUserID   = "pal.user_id"
	AttrRunID    = "pal.run_id"
	AttrStepID   = "pal.step_id"

	LegacyAttrTenantID = "pal.tenant_id"
	LegacyAttrUserID   = "pal.user_id"
	LegacyAttrRunID    = "pal.run_id"
	LegacyAttrStepID   = "pal.step_id"
)

// IDAttrs returns the attribute under its PAL key and its legacy key. Use it
// for ad-hoc span attributes so they stay filterable by both names.
func IDAttrs(palKey, legacyKey, v string) []attribute.KeyValue {
	return []attribute.KeyValue{attribute.String(palKey, v), attribute.String(legacyKey, v)}
}

// EnrichSpan stamps the well-known PAL identifiers onto whatever span is
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

	attrs := make([]attribute.KeyValue, 0, 8)
	if tenantID != "" {
		attrs = append(attrs, IDAttrs(AttrTenantID, LegacyAttrTenantID, tenantID)...)
	}
	if userID != "" {
		attrs = append(attrs, IDAttrs(AttrUserID, LegacyAttrUserID, userID)...)
	}
	if runID != "" {
		attrs = append(attrs, IDAttrs(AttrRunID, LegacyAttrRunID, runID)...)
	}
	if stepID != "" {
		attrs = append(attrs, IDAttrs(AttrStepID, LegacyAttrStepID, stepID)...)
	}
	if len(attrs) > 0 {
		span.SetAttributes(attrs...)
	}
}
