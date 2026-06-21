package handlers

// Tests for RuntimeReportHandler (runtime_report.go).
//
// Test strategy mirrors runtime_secrets_test.go:
//   - Handler-level tests that never reach the DB (nil pool safe): auth
//     failures, body validation, unknown kind.
//   - DB-gated integration tests (skipped without DATABASE_URL): valid audit
//     report persists a runtime_audit_events row, valid log report persists
//     a runtime_vm_logs row, vm/tenant mismatch returns 403.
//
// Security invariants verified:
//   (a) LANTERN_RUNTIME_SECRET_TOKEN unset → 403 (relay disabled)
//   (b) Wrong token → 403
//   (c) vm_id belonging to a different tenant → 403
//   (d) A valid audit report persists a runtime_audit_events row

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// newTestReportHandler builds a RuntimeReportHandler with a nil pool.
// Safe for tests that never reach the DB.
func newTestReportHandler(t *testing.T) *RuntimeReportHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: nil, Logger: logger}
	return NewRuntimeReportHandler(srv)
}

// newTestReportHandlerWithPool builds a RuntimeReportHandler backed by a real pool.
func newTestReportHandlerWithPool(t *testing.T, pool *pgxpool.Pool) *RuntimeReportHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	return NewRuntimeReportHandler(srv)
}

// doReport fires a POST /v1/runtime/report request with the given token header
// value and body, returning the recorder.
func doReport(h *RuntimeReportHandler, token string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/report", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set(runtimeTokenHeader, token)
	}
	w := httptest.NewRecorder()
	h.Report(w, req)
	return w
}

// setReportToken sets LANTERN_RUNTIME_SECRET_TOKEN for the duration of a test
// and restores the original value in t.Cleanup.
func setReportToken(t *testing.T, token string) {
	t.Helper()
	old := os.Getenv(envRuntimeSecretToken)
	_ = os.Setenv(envRuntimeSecretToken, token)
	t.Cleanup(func() { _ = os.Setenv(envRuntimeSecretToken, old) })
}

// migrateReportTables ensures runtime_vms, runtime_audit_events, and the new
// runtime_vm_logs tables exist in the test DB. Uses TEXT for tenant_id
// (matches the looser test DDL in migrateRuntimeTables) to avoid FK coupling.
func migrateReportTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS runtime_vms (
			vm_id             TEXT PRIMARY KEY,
			tenant_id         TEXT NOT NULL,
			agent_version_id  UUID,
			run_id            UUID,
			node              TEXT,
			az                TEXT,
			region            TEXT,
			isolation_class   TEXT,
			state             TEXT NOT NULL DEFAULT 'pending',
			spec              JSONB NOT NULL DEFAULT '{}',
			last_heartbeat_at TIMESTAMPTZ,
			created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
			terminated_at     TIMESTAMPTZ
		)`,
		// agent_instance_id may not exist on an older test DB — add idempotently.
		`ALTER TABLE runtime_vms ADD COLUMN IF NOT EXISTS agent_instance_id TEXT`,
		`CREATE TABLE IF NOT EXISTS runtime_audit_events (
			id           BIGSERIAL PRIMARY KEY,
			tenant_id    TEXT NOT NULL,
			vm_id        TEXT,
			action       TEXT NOT NULL,
			attrs        JSONB NOT NULL DEFAULT '{}',
			principal_id UUID,
			at           TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`ALTER TABLE runtime_audit_events ADD COLUMN IF NOT EXISTS agent_instance_id TEXT`,
		`CREATE TABLE IF NOT EXISTS runtime_vm_logs (
			seq       BIGSERIAL PRIMARY KEY,
			vm_id     TEXT NOT NULL,
			tenant_id TEXT NOT NULL,
			stream    TEXT NOT NULL DEFAULT 'stdout',
			text      TEXT NOT NULL,
			at        TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS runtime_vm_logs_vm_at_idx ON runtime_vm_logs (vm_id, at)`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatalf("migrateReportTables: %v", err)
		}
	}
}

// cleanupReportTenant removes all runtime rows for a tenant so tests don't bleed.
func cleanupReportTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	for _, tbl := range []string{"runtime_vm_logs", "runtime_audit_events", "runtime_vms"} {
		_, _ = pool.Exec(ctx, fmt.Sprintf("DELETE FROM %s WHERE tenant_id = $1", tbl), tenantID)
	}
}

// seedVMForReport inserts a running runtime_vms row and returns its vm_id.
func seedVMForReport(t *testing.T, pool *pgxpool.Pool, vmID, tenantID string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at)
		VALUES ($1, $2, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("seedVMForReport: %v", err)
	}
}

// ---------------------------------------------------------------------------
// (a) Unset server token → 403 "relay disabled"
// ---------------------------------------------------------------------------

func TestReport_UnsetToken_Returns403(t *testing.T) {
	// Ensure the env var is empty for this test.
	old := os.Getenv(envRuntimeSecretToken)
	_ = os.Unsetenv(envRuntimeSecretToken)
	t.Cleanup(func() { _ = os.Setenv(envRuntimeSecretToken, old) })

	h := newTestReportHandler(t)
	w := doReport(h, "any-token", map[string]any{
		"vm_id": "vm-1", "tenant_id": "t-1", "kind": "audit",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when token unset, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "relay disabled" {
		t.Errorf("expected error=relay disabled, got %q", resp["error"])
	}
}

// ---------------------------------------------------------------------------
// (b) Wrong token → 403 "forbidden"
// ---------------------------------------------------------------------------

func TestReport_WrongToken_Returns403(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)

	h := newTestReportHandler(t)
	w := doReport(h, "definitely-wrong-token", map[string]any{
		"vm_id": "vm-1", "tenant_id": "t-1", "kind": "audit",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for wrong token, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "forbidden" {
		t.Errorf("expected error=forbidden, got %q", resp["error"])
	}
}

// ---------------------------------------------------------------------------
// Missing token header → 403
// ---------------------------------------------------------------------------

func TestReport_MissingTokenHeader_Returns403(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)

	h := newTestReportHandler(t)
	// doReport with empty string omits the header.
	w := doReport(h, "", map[string]any{
		"vm_id": "vm-1", "tenant_id": "t-1", "kind": "audit",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for missing token header, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Body validation — no DB needed
// ---------------------------------------------------------------------------

func TestReport_MissingVmID_Returns400(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandler(t)
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"tenant_id": "t-1", "kind": "audit",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing vm_id, got %d", w.Code)
	}
}

func TestReport_MissingTenantID_Returns400(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandler(t)
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id": "vm-1", "kind": "audit",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing tenant_id, got %d", w.Code)
	}
}

func TestReport_UnknownKind_Returns400(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandler(t)
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id": "vm-1", "tenant_id": "t-1", "kind": "bad_kind",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for unknown kind, got %d", w.Code)
	}
}

func TestReport_BadJSON_Returns400(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/report",
		bytes.NewReader([]byte("not json {")))
	req.Header.Set(runtimeTokenHeader, testRuntimeSecretToken)
	w := httptest.NewRecorder()
	h.Report(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for bad JSON, got %d", w.Code)
	}
}

func TestReport_AuditKind_MissingPayload_Returns400(t *testing.T) {
	setReportToken(t, testRuntimeSecretToken)
	// No DB needed — the nil pool is only reached after a successful VM
	// binding check; we can't reach the DB without a real pool, but this
	// test terminates before that (nil pool panics on QueryRow). Because
	// the binding check IS reached before the payload check, we need a real
	// pool here. Skip if none is available.
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-audit-missing")
	vmID := "vm-audit-missing-" + tenantID[:8]
	seedTestTenant(t, pool, tenantID)
	seedVMForReport(t, pool, vmID, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	h := newTestReportHandlerWithPool(t, pool)
	// kind=audit but no audit payload.
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "audit",
		// no "audit" key
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing audit payload, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// (c) VM/tenant mismatch → 403
// ---------------------------------------------------------------------------

func TestReport_VMTenantMismatch_Returns403(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantA := uniqueTenantID("rpt-mismatch-A")
	tenantB := uniqueTenantID("rpt-mismatch-B")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	vmID := "vm-mismatch-" + tenantA[:8]
	seedVMForReport(t, pool, vmID, tenantA) // VM belongs to tenant A

	t.Cleanup(func() {
		cleanupReportTenant(t, pool, tenantA)
		cleanupReportTenant(t, pool, tenantB)
	})

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	// Tenant B claims vm_id that belongs to tenant A → must be 403.
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantB, // wrong tenant
		"kind":      "audit",
		"audit":     map[string]any{"vm_id": vmID, "action": "test_action"},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for vm/tenant mismatch, got %d: %s", w.Code, w.Body.String())
	}
}

// Unknown vm_id → 403 (no oracle).
func TestReport_UnknownVMID_Returns403(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-novm")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     "vm-does-not-exist",
		"tenant_id": tenantID,
		"kind":      "audit",
		"audit":     map[string]any{"vm_id": "vm-does-not-exist", "action": "probe"},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unknown vm_id, got %d: %s", w.Code, w.Body.String())
	}
}

// Terminal VM beyond grace window → 403.
//
// The VM's terminated_at is set to 1 hour ago — well beyond the default 10-min
// grace window — so even kind=audit/log must be rejected.
func TestReport_TerminalVM_Returns403(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-terminal")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-terminal-" + tenantID[:8]
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	// Insert as already terminated 1 hour ago — beyond the 10-min default grace.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at, terminated_at)
		VALUES ($1, $2, 'terminated', '{}', now() - interval '2 hours', now() - interval '1 hour')
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("seed terminated vm: %v", err)
	}

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "audit",
		"audit":     map[string]any{"vm_id": vmID, "action": "probe"},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for terminal VM beyond grace, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Terminal-VM grace window tests (LANTERN_RUNTIME_TERMINAL_GRACE)
// ---------------------------------------------------------------------------

// (a) kind=log for a VM terminated 1 minute ago → accepted + row persisted.
func TestReport_TerminalVM_WithinGrace_LogAccepted(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-grace-log")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-grace-log-" + tenantID[:8]
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	// VM terminated 1 minute ago — inside the 10-min default grace window.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at, terminated_at)
		VALUES ($1, $2, 'terminated', '{}', now() - interval '5 minutes', now() - interval '1 minute')
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("seed terminated vm: %v", err)
	}

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	const wantText = "final shutdown log"
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "log",
		"log": map[string]any{
			"vm_id":  vmID,
			"stream": "stdout",
			"text":   wantText,
		},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for log within grace, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the log row landed in runtime_vm_logs.
	var text string
	err = pool.QueryRow(context.Background(), `
		SELECT text FROM runtime_vm_logs
		WHERE vm_id = $1 AND tenant_id = $2
		ORDER BY at DESC LIMIT 1
	`, vmID, tenantID).Scan(&text)
	if err != nil {
		t.Fatalf("log row not found after grace-window accept: %v", err)
	}
	if text != wantText {
		t.Errorf("expected text=%q, got %q", wantText, text)
	}
}

// (b) Same VM (terminated 1 min ago) but with an explicit 0-duration grace
// window configured → 403 (grace disabled).
func TestReport_TerminalVM_GraceDisabled_Returns403(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-grace-off")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-grace-off-" + tenantID[:8]
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	// VM terminated 1 minute ago — would normally be inside default grace.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at, terminated_at)
		VALUES ($1, $2, 'terminated', '{}', now() - interval '5 minutes', now() - interval '1 minute')
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("seed terminated vm: %v", err)
	}

	// Disable the grace window via env.
	t.Setenv(envTerminalGrace, "0")

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "log",
		"log": map[string]any{
			"vm_id":  vmID,
			"stream": "stdout",
			"text":   "should be rejected",
		},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when grace disabled, got %d: %s", w.Code, w.Body.String())
	}
}

// (c) Wrong tenant for a recently-terminated VM → 403 regardless of grace.
func TestReport_TerminalVM_WrongTenantStillDenied(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantA := uniqueTenantID("rpt-grace-ta")
	tenantB := uniqueTenantID("rpt-grace-tb")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	vmID := "vm-grace-wt-" + tenantA[:8]
	t.Cleanup(func() {
		cleanupReportTenant(t, pool, tenantA)
		cleanupReportTenant(t, pool, tenantB)
	})

	// VM belongs to tenantA, terminated 1 min ago (inside default grace).
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at, terminated_at)
		VALUES ($1, $2, 'terminated', '{}', now() - interval '5 minutes', now() - interval '1 minute')
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantA)
	if err != nil {
		t.Fatalf("seed terminated vm: %v", err)
	}

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	// TenantB tries to report for this VM — must be rejected.
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantB,
		"kind":      "log",
		"log": map[string]any{
			"vm_id":  vmID,
			"stream": "stdout",
			"text":   "cross-tenant probe",
		},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for wrong tenant even within grace, got %d: %s", w.Code, w.Body.String())
	}
}

// (d) Non-terminal VM is unaffected — still accepted as before.
func TestReport_NonTerminalVM_UnchangedBehaviour(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-grace-run")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-grace-run-" + tenantID[:8]
	seedVMForReport(t, pool, vmID, tenantID) // state=running, terminated_at=NULL
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "audit",
		"audit":     map[string]any{"vm_id": vmID, "action": "heartbeat"},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for non-terminal VM, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// (d) Valid audit report persists a runtime_audit_events row
// ---------------------------------------------------------------------------

func TestReport_ValidAudit_PersistsRow(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-audit-ok")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-audit-ok-" + tenantID[:8]
	seedVMForReport(t, pool, vmID, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "audit",
		"audit": map[string]any{
			"vm_id":  vmID,
			"action": "egress_blocked",
			"attrs":  map[string]any{"dst": "evil.example.com", "port": 443},
		},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for valid audit report, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the audit row landed.
	var action string
	var attrsJSON []byte
	err := pool.QueryRow(context.Background(), `
		SELECT action, attrs
		FROM runtime_audit_events
		WHERE tenant_id = $1 AND vm_id = $2
		ORDER BY at DESC
		LIMIT 1
	`, tenantID, vmID).Scan(&action, &attrsJSON)
	if err != nil {
		t.Fatalf("audit event not found in runtime_audit_events: %v", err)
	}
	if action != "egress_blocked" {
		t.Errorf("expected action=egress_blocked, got %q", action)
	}

	var attrs map[string]any
	if err := json.Unmarshal(attrsJSON, &attrs); err != nil {
		t.Fatalf("unmarshal attrs: %v", err)
	}
	if attrs["dst"] != "evil.example.com" {
		t.Errorf("attrs.dst: got %v", attrs["dst"])
	}
}

// Verify 202 response body is well-formed JSON.
func TestReport_ValidAudit_ResponseBody(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-body")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-body-" + tenantID[:8]
	seedVMForReport(t, pool, vmID, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "audit",
		"audit":     map[string]any{"vm_id": vmID, "action": "spawn"},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not valid JSON: %v — body: %s", err, w.Body.String())
	}
	if resp["status"] != "accepted" {
		t.Errorf("expected status=accepted, got %q", resp["status"])
	}
}

// ---------------------------------------------------------------------------
// kind=log persists a runtime_vm_logs row
// ---------------------------------------------------------------------------

func TestReport_ValidLog_PersistsRow(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-log-ok")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-log-ok-" + tenantID[:8]
	seedVMForReport(t, pool, vmID, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	const wantText = "harness started ok"
	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "log",
		"log": map[string]any{
			"vm_id":  vmID,
			"stream": "stdout",
			"text":   wantText,
		},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for log report, got %d: %s", w.Code, w.Body.String())
	}

	var stream, text string
	err := pool.QueryRow(context.Background(), `
		SELECT stream, text
		FROM runtime_vm_logs
		WHERE vm_id = $1 AND tenant_id = $2
		ORDER BY at DESC
		LIMIT 1
	`, vmID, tenantID).Scan(&stream, &text)
	if err != nil {
		t.Fatalf("log row not found in runtime_vm_logs: %v", err)
	}
	if stream != "stdout" {
		t.Errorf("expected stream=stdout, got %q", stream)
	}
	if text != wantText {
		t.Errorf("expected text=%q, got %q", wantText, text)
	}
}

// ---------------------------------------------------------------------------
// kind=otlp_traces and kind=prometheus_metrics → 202 (debug-logged, not stored)
// ---------------------------------------------------------------------------

func TestReport_OTLP_Returns202(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-otlp")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-otlp-" + tenantID[:8]
	seedVMForReport(t, pool, vmID, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":           vmID,
		"tenant_id":       tenantID,
		"kind":            "otlp_traces",
		"otlp_traces_b64": "dGVzdA==", // base64("test")
	})
	if w.Code != http.StatusAccepted {
		t.Errorf("expected 202 for otlp_traces, got %d: %s", w.Code, w.Body.String())
	}
}

func TestReport_Prometheus_Returns202(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-prom")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-prom-" + tenantID[:8]
	seedVMForReport(t, pool, vmID, tenantID)
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":          vmID,
		"tenant_id":      tenantID,
		"kind":           "prometheus_metrics",
		"prometheus_b64": "dGVzdA==",
	})
	if w.Code != http.StatusAccepted {
		t.Errorf("expected 202 for prometheus_metrics, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// M2 — log retention sweep
// ---------------------------------------------------------------------------

// TestSweepOldLogs_DeletesOldRetainsNew verifies that sweepOldLogs removes
// rows older than the configured window and keeps newer rows intact.
func TestSweepOldLogs_DeletesOldRetainsNew(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-sweep")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-sweep-" + tenantID[:8]
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	ctx := context.Background()

	// Insert an old row (25 days ago) and a new row (1 day ago).
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vm_logs (vm_id, tenant_id, stream, text, at)
		VALUES ($1, $2, 'stdout', 'old line', now() - interval '25 days'),
		       ($1, $2, 'stdout', 'new line', now() - interval '1 day')
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("seed log rows: %v", err)
	}

	// Confirm both rows exist before the sweep.
	var before int
	_ = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runtime_vm_logs WHERE vm_id = $1`, vmID).Scan(&before)
	if before != 2 {
		t.Fatalf("expected 2 log rows before sweep, got %d", before)
	}

	// Set a 14-day retention window via env.
	t.Setenv(envLogRetentionDays, "14")
	logger, _ := zap.NewDevelopment()
	h := NewRuntimeReportHandler(&server.Server{Pool: pool, Logger: logger})

	deleted, err := h.sweepOldLogs(ctx)
	if err != nil {
		t.Fatalf("sweepOldLogs: %v", err)
	}
	if deleted != 1 {
		t.Errorf("expected 1 row deleted, got %d", deleted)
	}

	// Only the new row (1 day ago) should remain.
	var after int
	_ = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM runtime_vm_logs WHERE vm_id = $1`, vmID).Scan(&after)
	if after != 1 {
		t.Errorf("expected 1 log row remaining after sweep, got %d", after)
	}

	var remaining string
	_ = pool.QueryRow(ctx,
		`SELECT text FROM runtime_vm_logs WHERE vm_id = $1`, vmID).Scan(&remaining)
	if remaining != "new line" {
		t.Errorf("expected remaining row text='new line', got %q", remaining)
	}
}

// TestSweepOldLogs_CustomRetentionWindow verifies the configurable window.
func TestSweepOldLogs_CustomRetentionWindow(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-sweep2")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-sweep2-" + tenantID[:8]
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	ctx := context.Background()

	// Insert a row that is 3 days old.
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vm_logs (vm_id, tenant_id, stream, text, at)
		VALUES ($1, $2, 'stderr', '3-day-old line', now() - interval '3 days')
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("seed log row: %v", err)
	}

	logger, _ := zap.NewDevelopment()
	h := NewRuntimeReportHandler(&server.Server{Pool: pool, Logger: logger})

	// With a 7-day window the 3-day-old row should NOT be deleted.
	t.Setenv(envLogRetentionDays, "7")
	deleted, err := h.sweepOldLogs(ctx)
	if err != nil {
		t.Fatalf("sweepOldLogs (7d): %v", err)
	}
	if deleted != 0 {
		t.Errorf("expected 0 rows deleted with 7d window for a 3-day-old row, got %d", deleted)
	}

	// With a 2-day window it SHOULD be deleted.
	t.Setenv(envLogRetentionDays, "2")
	deleted, err = h.sweepOldLogs(ctx)
	if err != nil {
		t.Fatalf("sweepOldLogs (2d): %v", err)
	}
	if deleted != 1 {
		t.Errorf("expected 1 row deleted with 2d window for a 3-day-old row, got %d", deleted)
	}
}

// ---------------------------------------------------------------------------
// agent_instance_id is stamped on audit rows when present on the VM row
// ---------------------------------------------------------------------------

func TestReport_AuditStampsAgentInstanceID(t *testing.T) {
	pool := openTestPool(t)
	migrateReportTables(t, pool)

	tenantID := uniqueTenantID("rpt-iid")
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-iid-" + tenantID[:8]
	const wantInstanceID = "agent-instance-test-xyz"

	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, agent_instance_id, created_at)
		VALUES ($1, $2, 'running', '{}', $3, now())
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID, wantInstanceID)
	if err != nil {
		t.Fatalf("seed vm with instance id: %v", err)
	}
	t.Cleanup(func() { cleanupReportTenant(t, pool, tenantID) })

	setReportToken(t, testRuntimeSecretToken)
	h := newTestReportHandlerWithPool(t, pool)

	w := doReport(h, testRuntimeSecretToken, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"kind":      "audit",
		"audit":     map[string]any{"vm_id": vmID, "action": "spawn_complete"},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}

	var gotInstanceID *string
	err = pool.QueryRow(context.Background(), `
		SELECT agent_instance_id
		FROM runtime_audit_events
		WHERE tenant_id = $1 AND vm_id = $2 AND action = 'spawn_complete'
		ORDER BY at DESC
		LIMIT 1
	`, tenantID, vmID).Scan(&gotInstanceID)
	if err != nil {
		t.Fatalf("audit event not found: %v", err)
	}
	if gotInstanceID == nil || *gotInstanceID != wantInstanceID {
		t.Errorf("expected agent_instance_id=%q, got %v", wantInstanceID, gotInstanceID)
	}
}
