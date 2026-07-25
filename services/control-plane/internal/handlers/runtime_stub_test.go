package handlers

// runtime_stub_test.go — the silent-no-op bug, server half.
//
// Without LANTERN_SCHEDULER_GRPC_ADDR the handler falls back to
// stubSchedulerClient, which SYNTHESIZES a vm_id and spawns nothing. The
// response was byte-identical to a real schedule, so `lantern run` printed
// "scheduled vm_id=..." and exited 0 against a stack that ran no workload.
// Verified live before the fix: a vm_id the scheduler had never heard of and
// zero containers. The response must now self-identify.

import (
	"encoding/json"
	"net/http"
	"testing"

	"go.uber.org/zap"
)

func TestSchedule_StubSchedulerMarksResponse(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-stub")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	logger, _ := zap.NewDevelopment()
	h := newTestRuntimeHandlerWithPool(t, pool, &stubSchedulerClient{logger: logger})
	tok := mintTestToken(t, tenantID, "user-stub-1", "owner")

	w := doSchedule(h, tok, map[string]any{"imageDigest": "demo:latest"})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v (body=%s)", err, w.Body.String())
	}

	if stub, _ := resp["stub"].(bool); !stub {
		t.Fatalf("stub scheduler response must carry stub=true, got: %s", w.Body.String())
	}
	warning, _ := resp["warning"].(string)
	if warning == "" {
		t.Fatalf("stub response must carry a warning, got: %s", w.Body.String())
	}
	if vmID, _ := resp["vmId"].(string); vmID == "" {
		t.Fatal("vmId should still be present so callers can correlate the audit row")
	}
}

// The real path must stay clean — `stub` and `warning` are omitempty, so a
// correctly-wired stack sends neither and the CLI prints plain success.
func TestSchedule_RealSchedulerOmitsStubMarker(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-real")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	h := newTestRuntimeHandlerWithPool(t, pool, &recScheduler{})
	tok := mintTestToken(t, tenantID, "user-real-1", "owner")

	w := doSchedule(h, tok, map[string]any{"imageDigest": "demo:latest"})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if _, present := resp["stub"]; present {
		t.Fatalf("real scheduler must not emit a stub marker, got: %s", w.Body.String())
	}
	if _, present := resp["warning"]; present {
		t.Fatalf("real scheduler must not emit a warning, got: %s", w.Body.String())
	}
}

// Invariant #10, end to end: the persisted spec that GET /v1/runtime/vms
// serves must not contain the agent-instance bearer token. Verified live
// before the fix by pulling a valid JWT out of the list endpoint.
func TestSchedule_PersistedSpecHasNoInstanceToken(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-redact")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	h := newTestRuntimeHandlerWithPool(t, pool, &recScheduler{})
	tok := mintTestToken(t, tenantID, "user-redact-1", "owner")

	w := doSchedule(h, tok, map[string]any{"imageDigest": "demo:latest"})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var stored string
	err := pool.QueryRow(t.Context(),
		`SELECT spec::text FROM runtime_vms WHERE tenant_id = $1 LIMIT 1`, tenantID).Scan(&stored)
	if err != nil {
		t.Fatalf("read back spec: %v", err)
	}

	var spec map[string]any
	if err := json.Unmarshal([]byte(stored), &spec); err != nil {
		t.Fatalf("stored spec is not JSON: %v", err)
	}
	env, _ := spec["env"].(map[string]any)
	if env == nil {
		t.Fatal("stored spec should still carry env (only the token is redacted)")
	}
	if got := env["LANTERN_AGENT_INSTANCE_TOKEN"]; got != redactedValue {
		t.Fatalf("instance token must be redacted at rest, got %v", got)
	}
	// The identifier is not a credential and must survive for correlation.
	if id, _ := env["LANTERN_AGENT_INSTANCE_ID"].(string); id == "" {
		t.Fatal("instance id must be preserved")
	}
}
