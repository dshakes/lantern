package handlers

// Tests for OpenTelemetry span emission in the handlers layer.
//
// Test A — callLLMSync GenAI span:
//   Exercises the "unsupported provider" error path (no network call) to verify
//   gen_ai.* attributes are always recorded, including on error.
//
// Also exercises the claude-code branch (binary absent in test env) which
// returns an error without a subprocess, confirming early-exit paths still
// record spans.
//
// Test C — runtime.Schedule span attributes:
//   Two sub-tests:
//    1. No-DB: uses the nil-pool handler + empty imageDigest to trigger a 400
//       early return and verify span + lantern.tenant_id attribute are recorded.
//    2. DB-backed: uses openTestPool + stub scheduler (skipped when DATABASE_URL
//       unset) to verify the success path records lantern.vm_id.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// installTestRecorder installs an in-memory OTel TracerProvider as the global
// provider and returns the exporter plus a cleanup func that restores the
// previous provider. Tests that call this must defer the cleanup.
func installTestRecorder(t *testing.T) (*tracetest.InMemoryExporter, func()) {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	return exp, func() {
		_ = tp.Shutdown(context.Background())
		otel.SetTracerProvider(prev)
	}
}

// findAttr searches attrs for a key and returns the KeyValue + found flag.
func findAttr(attrs []attribute.KeyValue, key string) (attribute.KeyValue, bool) {
	for _, kv := range attrs {
		if string(kv.Key) == key {
			return kv, true
		}
	}
	return attribute.KeyValue{}, false
}

// findSpan returns a pointer to the first SpanStub whose Name matches, or nil.
func findSpan(spans []tracetest.SpanStub, name string) *tracetest.SpanStub {
	for i := range spans {
		if spans[i].Name == name {
			return &spans[i]
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Test A: callLLMSync emits a GenAI-attributed span
// ---------------------------------------------------------------------------

// TestCallLLMSync_GenAISpan_UnsupportedProvider verifies that callLLMSync
// records an OTel span with the expected gen_ai.* attributes even when the
// call returns an error (unsupported provider → no network call needed).
func TestCallLLMSync_GenAISpan_UnsupportedProvider(t *testing.T) {
	exp, cleanup := installTestRecorder(t)
	defer cleanup()

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewLlmProxyHandler(srv, auth)

	const wantProvider = "noop-provider"
	const wantModel = "noop-model"

	ctx := context.Background()
	// "noop-provider" hits the default switch branch → "unsupported provider" error.
	_, _, _, _, _ = h.callLLMSync(ctx, wantProvider, wantModel, "fake-key", "hello")

	spans := exp.GetSpans()
	if len(spans) == 0 {
		t.Fatal("expected at least one recorded span, got none")
	}

	s := findSpan(spans, "chat "+wantModel)
	if s == nil {
		names := make([]string, len(spans))
		for i, sp := range spans {
			names[i] = sp.Name
		}
		t.Fatalf("span 'chat %s' not found; recorded: %v", wantModel, names)
	}

	checks := map[string]string{
		"gen_ai.system":         wantProvider,
		"gen_ai.request.model":  wantModel,
		"gen_ai.operation.name": "chat",
	}
	for key, wantVal := range checks {
		kv, ok := findAttr(s.Attributes, key)
		if !ok {
			t.Errorf("attribute %q missing from span", key)
			continue
		}
		if got := kv.Value.AsString(); got != wantVal {
			t.Errorf("attribute %q = %q, want %q", key, got, wantVal)
		}
	}

	// Token counts must be int64 zero for the error/unsupported-provider path.
	for _, key := range []string{"gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"} {
		kv, ok := findAttr(s.Attributes, key)
		if !ok {
			t.Errorf("attribute %q missing from span", key)
			continue
		}
		if got := kv.Value.AsInt64(); got != 0 {
			t.Errorf("attribute %q = %d, want 0", key, got)
		}
	}
}

// TestCallLLMSync_GenAISpan_ClaudeCode exercises the claude-code provider
// branch. With LANTERN_USE_CLAUDE_CODE=0 the binary look-up is skipped and the
// function returns an error immediately, confirming the span is still recorded.
func TestCallLLMSync_GenAISpan_ClaudeCode(t *testing.T) {
	t.Setenv("LANTERN_USE_CLAUDE_CODE", "0")

	exp, cleanup := installTestRecorder(t)
	defer cleanup()

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewLlmProxyHandler(srv, auth)

	ctx := context.Background()
	_, _, _, _, _ = h.callLLMSync(ctx, "claude-code", "local", "", "test prompt")

	spans := exp.GetSpans()
	if len(spans) == 0 {
		t.Fatal("expected at least one span, got none")
	}
	s := findSpan(spans, "chat local")
	if s == nil {
		t.Fatalf("span 'chat local' not found in %d recorded span(s)", len(spans))
	}
	kv, ok := findAttr(s.Attributes, "gen_ai.system")
	if !ok {
		t.Error("gen_ai.system attribute missing")
	} else if kv.Value.AsString() != "claude-code" {
		t.Errorf("gen_ai.system = %q, want %q", kv.Value.AsString(), "claude-code")
	}
}

// ---------------------------------------------------------------------------
// Test C: runtime.Schedule emits a span with lantern.* attributes
// ---------------------------------------------------------------------------

// TestSchedule_SpanAttributes_EarlyReturn verifies the span is started and
// carries lantern.tenant_id even when Schedule returns 400 (missing imageDigest)
// before touching the database. This exercises the nil-pool handler so no
// DATABASE_URL is required.
func TestSchedule_SpanAttributes_EarlyReturn(t *testing.T) {
	exp, cleanup := installTestRecorder(t)
	defer cleanup()

	h := newTestRuntimeHandler(t, &recScheduler{})

	tok := mintTestToken(t, "tenant-span-test", "user-1", "owner")
	// Empty imageDigest → 400 before any DB call.
	body, _ := json.Marshal(map[string]string{
		"imageDigest": "",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/schedule", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Schedule(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}

	spans := exp.GetSpans()
	s := findSpan(spans, "runtime.schedule")
	if s == nil {
		names := make([]string, len(spans))
		for i, sp := range spans {
			names[i] = sp.Name
		}
		t.Fatalf("'runtime.schedule' span not found; recorded: %v", names)
	}

	kv, ok := findAttr(s.Attributes, "lantern.tenant_id")
	if !ok {
		t.Error("lantern.tenant_id attribute missing from span")
	} else if kv.Value.AsString() != "tenant-span-test" {
		t.Errorf("lantern.tenant_id = %q, want %q", kv.Value.AsString(), "tenant-span-test")
	}
}

// TestSchedule_SpanAttributes_Success verifies the success-path span includes
// lantern.vm_id. Requires DATABASE_URL (same gate as the existing DB suite).
func TestSchedule_SpanAttributes_Success(t *testing.T) {
	pool := openTestPool(t) // skips when DATABASE_URL unset
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("span-sched")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	exp, cleanup := installTestRecorder(t)
	defer cleanup()

	h := newTestRuntimeHandlerWithPool(t, pool, &recScheduler{vmID: "vm-span-success-1"})
	tok := mintTestToken(t, tenantID, "user-span-1", "owner")

	body, _ := json.Marshal(map[string]any{
		"imageDigest": "sha256:spantest",
		"isolation":   "standard",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/schedule", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Schedule(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	spans := exp.GetSpans()
	s := findSpan(spans, "runtime.schedule")
	if s == nil {
		t.Fatal("'runtime.schedule' span not found on success path")
	}

	for _, check := range []struct{ key, want string }{
		{"lantern.tenant_id", tenantID},
		{"lantern.isolation_class", "standard"},
		{"lantern.vm_id", "vm-span-success-1"},
	} {
		kv, ok := findAttr(s.Attributes, check.key)
		if !ok {
			t.Errorf("attribute %q missing from success span", check.key)
			continue
		}
		if kv.Value.AsString() != check.want {
			t.Errorf("attribute %q = %q, want %q", check.key, kv.Value.AsString(), check.want)
		}
	}
}
