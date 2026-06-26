package main

// tracing_test.go — unit tests for HTTP span naming + gRPC span enrichment
// (task P3-otel, invariant #9).

import (
	"context"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"google.golang.org/grpc/metadata"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

func TestHTTPSpanName_TemplatesIDs(t *testing.T) {
	tests := []struct {
		method, path, want string
	}{
		{"GET", "/v1/runs", "GET /v1/runs"},
		{"POST", "/v1/runs", "POST /v1/runs"},
		{"GET", "/v1/runs/9f3c2b6e-1a4d-4e2f-bc11-0a1b2c3d4e5f", "GET /v1/runs/{id}"},
		{"GET", "/v1/runs/9f3c2b6e-1a4d-4e2f-bc11-0a1b2c3d4e5f/events", "GET /v1/runs/{id}/events"},
		{"POST", "/v1/runs/9f3c2b6e-1a4d-4e2f-bc11-0a1b2c3d4e5f/cancel", "POST /v1/runs/{id}/cancel"},
		{"GET", "/v1/agents/my-cool-agent", "GET /v1/agents/my-cool-agent"}, // names stay
		{"GET", "/healthz", "GET /healthz"},
		{"GET", "/", "GET /"},
		// hex digest segment collapses
		{"GET", "/v1/x/a1b2c3d4e5f6a7b8", "GET /v1/x/{id}"},
		// long numeric (snowflake) collapses
		{"GET", "/v1/x/123456789012345", "GET /v1/x/{id}"},
		// short word does not collapse
		{"GET", "/v1/x/abc123", "GET /v1/x/abc123"},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			got := httpSpanName("op", r)
			if got != tc.want {
				t.Errorf("httpSpanName(%q) = %q, want %q", tc.path, got, tc.want)
			}
		})
	}
}

func TestLooksLikeID(t *testing.T) {
	idLike := []string{
		"9f3c2b6e-1a4d-4e2f-bc11-0a1b2c3d4e5f", // UUID
		"a1b2c3d4e5f6a7b8",                     // 16-char hex
		"123456789012",                         // 12 digits
		"00000000-0000-0000-0000-000000000001", // dev tenant UUID
	}
	notID := []string{
		"runs", "events", "cancel", "v1", "agents",
		"my-agent", "abc123", "schedule", "",
	}
	for _, s := range idLike {
		if !looksLikeID(s) {
			t.Errorf("looksLikeID(%q) = false, want true", s)
		}
	}
	for _, s := range notID {
		if looksLikeID(s) {
			t.Errorf("looksLikeID(%q) = true, want false", s)
		}
	}
}

// TestEnrichGRPCSpan verifies the gRPC tracing interceptor's enrichment stamps
// tenant_id (from context) and run_id/step_id (from incoming metadata) onto the
// active span, with the keys shared with the HTTP path.
func TestEnrichGRPCSpan(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))

	ctx, span := tp.Tracer("test").Start(context.Background(), "/lantern.v1.RunService/GetRun")
	ctx = middleware.InjectTenantID(ctx, "tnt-grpc")
	ctx = metadata.NewIncomingContext(ctx, metadata.Pairs(
		"run_id", "run-grpc-1",
		"step_id", "step-grpc-1",
	))

	enrichGRPCSpan(ctx)
	span.End()

	ended := rec.Ended()
	if len(ended) != 1 {
		t.Fatalf("expected 1 span, got %d", len(ended))
	}
	attrs := ended[0].Attributes()

	want := map[string]string{
		middleware.AttrTenantID: "tnt-grpc",
		middleware.AttrRunID:    "run-grpc-1",
		middleware.AttrStepID:   "step-grpc-1",
	}
	for key, wantVal := range want {
		kv, ok := findKV(attrs, key)
		if !ok {
			t.Errorf("attribute %q missing", key)
			continue
		}
		if got := kv.Value.AsString(); got != wantVal {
			t.Errorf("attribute %q = %q, want %q", key, got, wantVal)
		}
	}
	// user_id must NOT be set on the gRPC path.
	if _, ok := findKV(attrs, middleware.AttrUserID); ok {
		t.Errorf("attribute %q should be absent on gRPC span", middleware.AttrUserID)
	}
}

// TestEnrichGRPCSpan_NoMetadata covers the path with tenant in context but no
// run/step metadata — only tenant_id should land, no panic.
func TestEnrichGRPCSpan_NoMetadata(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))

	ctx, span := tp.Tracer("test").Start(context.Background(), "/svc/Method")
	ctx = middleware.InjectTenantID(ctx, "tnt-only")
	enrichGRPCSpan(ctx)
	span.End()

	attrs := rec.Ended()[0].Attributes()
	if kv, ok := findKV(attrs, middleware.AttrTenantID); !ok || kv.Value.AsString() != "tnt-only" {
		t.Errorf("expected tenant_id=tnt-only, got %v (present=%v)", kv.Value.AsString(), ok)
	}
	if _, ok := findKV(attrs, middleware.AttrRunID); ok {
		t.Errorf("run_id should be absent when no metadata present")
	}
}

func findKV(attrs []attribute.KeyValue, key string) (attribute.KeyValue, bool) {
	for _, kv := range attrs {
		if string(kv.Key) == key {
			return kv, true
		}
	}
	return attribute.KeyValue{}, false
}
