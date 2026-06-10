package handlers

// Tests for the runtime handler (runtime.go).
//
// Test strategy mirrors the rest of this package:
//   - Pure-function tests (agentSpecFromMap, parseIsolation, parseNetwork,
//     vmStateString) run with no infrastructure at all.
//   - HTTP handler tests that exercise pre-DB validation paths (missing auth,
//     missing imageDigest, spec validation) use httptest + a real JWT but a
//     nil pool; they never reach the pool.
//   - Tests that require a real Postgres (quota enforcement, runtime_vms row
//     insertion, audit events, tenant isolation) are gated on the DATABASE_URL
//     env var and skipped when it is absent. The test binary does NOT run them
//     in short mode (`go test -short`). In CI the dev Postgres from
//     `make dev-infra` must be running.
//
// The mock scheduler (recScheduler) is injected via RuntimeHandler.WithScheduler
// so no real RuntimeScheduler process is needed.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const testJWTSecret = "test-jwt-secret-do-not-use-in-production"

// mintTestToken returns a signed JWT for the given tenant, user, and role.
func mintTestToken(t *testing.T, tenantID, userID, role string) string {
	t.Helper()
	now := time.Now()
	claims := LanternClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
			Issuer:    "lantern-test",
		},
		TenantID: tenantID,
		Email:    userID + "@test.example",
		Name:     "Test User",
		Role:     role,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("mintTestToken: %v", err)
	}
	return s
}

// newTestRuntimeHandler builds a RuntimeHandler with a nil pool (safe for
// pre-DB-hit validation tests) and the given scheduler mock.
func newTestRuntimeHandler(t *testing.T, sched SchedulerClient) *RuntimeHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{
		Pool:   nil, // nil: panics if DB is actually reached
		Logger: logger,
	}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := &RuntimeHandler{
		srv:       srv,
		auth:      auth,
		scheduler: sched,
	}
	return h
}

// newTestRuntimeHandlerWithPool builds a RuntimeHandler backed by a real pool.
// The caller is responsible for ensuring the schema is migrated.
func newTestRuntimeHandlerWithPool(t *testing.T, pool *pgxpool.Pool, sched SchedulerClient) *RuntimeHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{
		Pool:   pool,
		Logger: logger,
	}
	auth := NewAuthHandler(srv, testJWTSecret)
	return &RuntimeHandler{
		srv:       srv,
		auth:      auth,
		scheduler: sched,
	}
}

// openTestPool connects to the DATABASE_URL environment variable.
// Skips the test if DATABASE_URL is unset or the database is unreachable.
func openTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping DB test in -short mode")
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set — skipping integration test (run `make dev-infra` first)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Skipf("pgxpool.New: %v — skipping (DB unreachable?)", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("pool.Ping: %v — skipping (DB unreachable?)", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// bearerHeader returns an "Authorization: Bearer <tok>" header value.
func bearerHeader(tok string) string { return "Bearer " + tok }

// doSchedule fires a POST /v1/runtime/schedule request with the given body
// and returns the recorder.
func doSchedule(h *RuntimeHandler, tok string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/schedule", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	h.Schedule(w, req)
	return w
}

// ---------------------------------------------------------------------------
// Mock scheduler
// ---------------------------------------------------------------------------

// recScheduler is a fake SchedulerClient that records calls and returns
// configurable responses. Zero value is a success scheduler.
type recScheduler struct {
	scheduleErr  error
	terminateErr error
	vmID         string
	node         string
	az           string
	calls        []string // "schedule", "terminate", etc.
}

func (r *recScheduler) Schedule(_ context.Context, _ map[string]any) (string, string, string, error) {
	r.calls = append(r.calls, "schedule")
	if r.scheduleErr != nil {
		return "", "", "", r.scheduleErr
	}
	id := r.vmID
	if id == "" {
		id = "vm-test-" + fmt.Sprintf("%d", len(r.calls))
	}
	n := r.node
	if n == "" {
		n = "node-stub"
	}
	az := r.az
	if az == "" {
		az = "az-stub"
	}
	return id, n, az, nil
}

func (r *recScheduler) Terminate(_ context.Context, vmID, _ string) error {
	r.calls = append(r.calls, "terminate:"+vmID)
	return r.terminateErr
}

func (r *recScheduler) Exec(_ context.Context, _, _ string, _ []string) (string, string, int32, error) {
	r.calls = append(r.calls, "exec")
	return "", "", 0, nil
}

func (r *recScheduler) Cluster(_ context.Context) (map[string]any, error) {
	r.calls = append(r.calls, "cluster")
	return map[string]any{}, nil
}

func (r *recScheduler) ListStates(_ context.Context, _ string) (map[string]string, error) {
	return map[string]string{}, nil
}

// ---------------------------------------------------------------------------
// Pure-function tests — no DB, no network
// ---------------------------------------------------------------------------

func TestParseIsolation(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"trusted", "ISOLATION_TRUSTED"},
		{"standard", "ISOLATION_STANDARD"},
		{"untrusted", "ISOLATION_UNTRUSTED"},
		{"hostile", "ISOLATION_HOSTILE"},
		{"wasm", "ISOLATION_WASM"},
		{"devcontainer", "ISOLATION_DEVCONTAINER"},
		{"", "ISOLATION_UNSPECIFIED"},
		{"unknown", "ISOLATION_UNSPECIFIED"},
		{"TRUSTED", "ISOLATION_TRUSTED"}, // case-insensitive
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := parseIsolation(tc.in).String()
			if got != tc.want {
				t.Errorf("parseIsolation(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseNetwork(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"none", "NETWORK_NONE"},
		{"allowlist", "NETWORK_ALLOWLIST_DOMAIN"},
		{"allowlist_domain", "NETWORK_ALLOWLIST_DOMAIN"},
		{"tenant_vpc", "NETWORK_TENANT_VPC"},
		{"open", "NETWORK_OPEN"},
		{"", "NETWORK_UNSPECIFIED"},
		{"bogus", "NETWORK_UNSPECIFIED"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := parseNetwork(tc.in).String()
			if got != tc.want {
				t.Errorf("parseNetwork(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestVmStateString(t *testing.T) {
	cases := []struct {
		s    int32
		want string
	}{
		{0, "pending"},    // VM_STATE_UNSPECIFIED → default pending
		{1, "pending"},    // VM_STATE_PENDING
		{2, "spawning"},   // VM_STATE_SPAWNING
		{3, "running"},    // VM_STATE_RUNNING
		{4, "draining"},   // VM_STATE_DRAINING
		{5, "terminated"}, // VM_STATE_TERMINATED
		{6, "failed"},     // VM_STATE_FAILED
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			// Import the proto enum values via a numeric cast since the test
			// package has access to the internal type aliases.
			// We cast int32 → lanternv1.VmState through the function under test.
			// This validates the switch branches without importing lanternv1 here.
			// (lanternv1 is imported in the package being tested, so the function
			// is callable from the same package.)
			_ = tc.s // silence unused; actual values tested via literal below
		})
	}

	// Test the non-default branches with the actual proto constants. These are
	// imported in runtime.go and visible here since we're in package handlers.
	import_table := []struct {
		want string
		fn   func() string
	}{
		{"pending", func() string { return vmStateString(1) }},    // VM_STATE_PENDING
		{"spawning", func() string { return vmStateString(2) }},   // VM_STATE_SPAWNING
		{"running", func() string { return vmStateString(3) }},    // VM_STATE_RUNNING
		{"draining", func() string { return vmStateString(4) }},   // VM_STATE_DRAINING
		{"terminated", func() string { return vmStateString(5) }}, // VM_STATE_TERMINATED
		{"failed", func() string { return vmStateString(6) }},     // VM_STATE_FAILED
		{"pending", func() string { return vmStateString(99) }},   // unknown → default
	}
	for _, tc := range import_table {
		if got := tc.fn(); got != tc.want {
			t.Errorf("vmStateString: got %q, want %q", got, tc.want)
		}
	}
}

func TestAgentSpecFromMap_Basic(t *testing.T) {
	m := map[string]any{
		"image_digest":     "sha256:abc123",
		"tenant_id":        "tenant-x",
		"isolation":        "standard",
		"network":          "none",
		"idempotent":       true,
		"agent_version_id": "ver-1",
		"run_id":           "run-1",
	}
	spec := agentSpecFromMap(m)
	if spec.ImageDigest != "sha256:abc123" {
		t.Errorf("ImageDigest: got %q", spec.ImageDigest)
	}
	if spec.TenantId != "tenant-x" {
		t.Errorf("TenantId: got %q", spec.TenantId)
	}
	if !spec.Idempotent {
		t.Error("Idempotent should be true")
	}
}

func TestAgentSpecFromMap_CommandArgsEnv(t *testing.T) {
	m := map[string]any{
		"command": []any{"python", "-m"},
		"args":    []any{"mymodule"},
		"env":     map[string]any{"FOO": "bar", "BAR": "baz"},
	}
	spec := agentSpecFromMap(m)
	if len(spec.Command) != 2 || spec.Command[0] != "python" {
		t.Errorf("Command: %v", spec.Command)
	}
	if len(spec.Args) != 1 || spec.Args[0] != "mymodule" {
		t.Errorf("Args: %v", spec.Args)
	}
	if spec.Env["FOO"] != "bar" {
		t.Errorf("Env[FOO]: %q", spec.Env["FOO"])
	}
}

func TestAgentSpecFromMap_Nil(t *testing.T) {
	spec := agentSpecFromMap(nil)
	if spec == nil {
		t.Fatal("expected non-nil spec from nil map")
	}
}

// ---------------------------------------------------------------------------
// HTTP handler tests — pre-DB validation (nil pool safe)
// ---------------------------------------------------------------------------

func TestSchedule_MissingAuth(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	w := doSchedule(h, "", map[string]any{"imageDigest": "sha256:abc"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestSchedule_InvalidToken(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	w := doSchedule(h, "not-a-jwt", map[string]any{"imageDigest": "sha256:abc"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestSchedule_MissingImageDigest(t *testing.T) {
	// imageDigest is required; validated BEFORE quota check (no DB hit).
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "owner")
	w := doSchedule(h, tok, map[string]any{}) // no imageDigest
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "imageDigest") {
		t.Errorf("expected error mentioning imageDigest, got: %s", w.Body.String())
	}
}

func TestSchedule_BadJSON(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "owner")
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/schedule",
		strings.NewReader("not json {"))
	req.Header.Set("Authorization", bearerHeader(tok))
	w := httptest.NewRecorder()
	h.Schedule(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for bad JSON, got %d", w.Code)
	}
}

func TestListVMs_MissingAuth(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms", nil)
	w := httptest.NewRecorder()
	h.ListVMs(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestGetVM_MissingAuth(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms/vm-1", nil)
	req.SetPathValue("id", "vm-1")
	w := httptest.NewRecorder()
	h.GetVM(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestTerminateVM_MissingAuth(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	req := httptest.NewRequest(http.MethodDelete, "/v1/runtime/vms/vm-1", nil)
	req.SetPathValue("id", "vm-1")
	w := httptest.NewRecorder()
	h.TerminateVM(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestExecVM_MissingAuth(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/vms/vm-1/exec",
		strings.NewReader(`{"command":"ls"}`))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "vm-1")
	w := httptest.NewRecorder()
	h.ExecVM(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestCluster_RequiresOwnerRole(t *testing.T) {
	// Cluster endpoint is owner-only; a member token gets 403.
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member") // not owner
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/cluster", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	w := httptest.NewRecorder()
	h.Cluster(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner, got %d: %s", w.Code, w.Body.String())
	}
}

func TestUpsertQuota_RequiresOwnerRole(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	req := httptest.NewRequest(http.MethodPut, "/v1/runtime/quota",
		strings.NewReader(`{"maxConcurrentVms":5}`))
	req.Header.Set("Authorization", bearerHeader(tok))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.UpsertQuota(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// DB-backed integration tests — skipped when DATABASE_URL is unset
// ---------------------------------------------------------------------------

// uniqueTenantID generates a fresh UUID for a test tenant. The prefix is used
// only to derive a deterministic slug; the returned value is a valid UUID
// string as required by the runtime tables' tenant_id UUID columns.
func uniqueTenantID(prefix string) string {
	return uuid.New().String()
}

// seedTestTenant inserts a minimal row into the tenants table so that FK
// constraints on runtime_quotas / runtime_vms / runtime_audit_events are
// satisfied. The row is removed in t.Cleanup alongside the runtime rows.
func seedTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	slug := fmt.Sprintf("test-%s", tenantID[:8])
	_, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Test Tenant', 'personal', $3)
		ON CONFLICT (id) DO NOTHING
	`, tenantID, slug, "ns-"+tenantID[:8])
	if err != nil {
		t.Fatalf("seedTestTenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants WHERE id = $1", tenantID)
	})
}

// migrateRuntimeTables ensures the three runtime tables exist in the test DB.
// It runs the CREATE TABLE IF NOT EXISTS statements directly so these tests
// don't need the full migrate.Run() path.
func migrateRuntimeTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS runtime_quotas (
			tenant_id            TEXT PRIMARY KEY,
			max_concurrent_vms   INT NOT NULL DEFAULT 20,
			max_compute_hours_per_day FLOAT8 NOT NULL DEFAULT 10,
			max_egress_gb_per_day     INT NOT NULL DEFAULT 5,
			max_cost_usd_per_day FLOAT8 NOT NULL DEFAULT 5.0,
			hard_fail            BOOL NOT NULL DEFAULT TRUE,
			updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE IF NOT EXISTS runtime_audit_events (
			id           BIGSERIAL PRIMARY KEY,
			tenant_id    TEXT NOT NULL,
			vm_id        TEXT,
			action       TEXT NOT NULL,
			attrs        JSONB NOT NULL DEFAULT '{}',
			principal_id UUID,
			at           TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
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
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatalf("migrateRuntimeTables: %v", err)
		}
	}
}

// cleanupTenant deletes all runtime rows for a given tenantID so tests don't
// bleed into each other.
func cleanupTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	for _, tbl := range []string{"runtime_vms", "runtime_audit_events", "runtime_quotas"} {
		_, _ = pool.Exec(ctx, "DELETE FROM "+tbl+" WHERE tenant_id = $1", tenantID)
	}
}

// TestSchedule_QuotaExceeded_Returns402 verifies that a tenant whose
// max_concurrent_vms quota is exhausted and has hard_fail=true gets HTTP 402.
func TestSchedule_QuotaExceeded_Returns402(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-quota")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	ctx := context.Background()

	// Insert a quota of 1 concurrent VM with hard_fail.
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_quotas (tenant_id, max_concurrent_vms, hard_fail)
		VALUES ($1, 1, true)
		ON CONFLICT (tenant_id) DO UPDATE
		  SET max_concurrent_vms = 1, hard_fail = true
	`, tenantID)
	if err != nil {
		t.Fatalf("insert quota: %v", err)
	}

	// Insert a VM that counts against the limit (state=running).
	_, err = pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at)
		VALUES ('vm-existing-1', $1, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, tenantID)
	if err != nil {
		t.Fatalf("insert vm: %v", err)
	}

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-quota-1", "owner")

	w := doSchedule(h, tok, map[string]any{"imageDigest": "sha256:test"})
	if w.Code != http.StatusPaymentRequired {
		t.Errorf("expected 402 when quota exceeded, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "quota exceeded" {
		t.Errorf("expected error=quota exceeded, got %v", resp)
	}

	// Scheduler should NOT have been called.
	for _, call := range sched.calls {
		if call == "schedule" {
			t.Error("scheduler.Schedule must not be called when quota is exceeded")
		}
	}
}

// TestSchedule_StubScheduler_CreatesVMRow verifies that a successful schedule
// via the stub scheduler inserts a runtime_vms row with state=pending.
func TestSchedule_StubScheduler_CreatesVMRow(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-sched")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	sched := &recScheduler{vmID: "vm-stub-test-42", node: "node-test", az: "az-test"}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-sched-1", "owner")

	w := doSchedule(h, tok, map[string]any{
		"imageDigest": "sha256:deadbeef",
		"isolation":   "standard",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the stub scheduler was called.
	found := false
	for _, c := range sched.calls {
		if c == "schedule" {
			found = true
		}
	}
	if !found {
		t.Error("scheduler.Schedule was not called")
	}

	// Verify the runtime_vms row was created.
	var state string
	err := pool.QueryRow(context.Background(), `
		SELECT state FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2
	`, "vm-stub-test-42", tenantID).Scan(&state)
	if err != nil {
		t.Fatalf("runtime_vms row not found: %v", err)
	}
	if state != "pending" {
		t.Errorf("expected state=pending, got %q", state)
	}

	// Verify response body.
	var resp scheduleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if resp.VmID != "vm-stub-test-42" {
		t.Errorf("response vmId: got %q, want %q", resp.VmID, "vm-stub-test-42")
	}
	if resp.Node != "node-test" {
		t.Errorf("response node: got %q", resp.Node)
	}
}

// TestSchedule_AuditEventWritten verifies that a successful schedule writes an
// audit event of action="schedule" to runtime_audit_events.
func TestSchedule_AuditEventWritten(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-audit")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	sched := &recScheduler{vmID: "vm-audit-test-1"}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-audit-1", "owner")

	w := doSchedule(h, tok, map[string]any{"imageDigest": "sha256:audit"})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var action string
	err := pool.QueryRow(context.Background(), `
		SELECT action FROM runtime_audit_events
		WHERE tenant_id = $1 AND vm_id = $2
		ORDER BY at DESC LIMIT 1
	`, tenantID, "vm-audit-test-1").Scan(&action)
	if err != nil {
		t.Fatalf("audit event not found: %v", err)
	}
	if action != "schedule" {
		t.Errorf("expected audit action=schedule, got %q", action)
	}
}

// TestSchedule_TerminateVM_AuditEventWritten verifies that a terminate call
// also writes an audit event of action="terminate".
func TestTerminateVM_AuditEventWritten(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-term")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	ctx := context.Background()
	vmID := "vm-terminate-test-1"

	// Pre-insert a VM row so TerminateVM can look it up.
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at)
		VALUES ($1, $2, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID)
	if err != nil {
		t.Fatalf("insert vm: %v", err)
	}

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-term-1", "owner")

	req := httptest.NewRequest(http.MethodDelete,
		"/v1/runtime/vms/"+vmID+"?reason=test_terminate", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	req.SetPathValue("id", vmID)
	w := httptest.NewRecorder()
	h.TerminateVM(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// State should be updated to terminated.
	var state string
	_ = pool.QueryRow(ctx,
		`SELECT state FROM runtime_vms WHERE vm_id = $1`, vmID).Scan(&state)
	if state != "terminated" {
		t.Errorf("expected state=terminated after terminate, got %q", state)
	}

	// Audit event should be written.
	var action string
	err = pool.QueryRow(ctx, `
		SELECT action FROM runtime_audit_events
		WHERE tenant_id = $1 AND vm_id = $2 AND action = 'terminate'
		LIMIT 1
	`, tenantID, vmID).Scan(&action)
	if err != nil {
		t.Fatalf("terminate audit event not found: %v", err)
	}
}

// TestListVMs_TenantIsolation verifies that VMs belonging to tenant A are not
// visible to tenant B.
func TestListVMs_TenantIsolation(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantA := uniqueTenantID("tenant-A")
	tenantB := uniqueTenantID("tenant-B")
	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)
	t.Cleanup(func() {
		cleanupTenant(t, pool, tenantA)
		cleanupTenant(t, pool, tenantB)
	})

	ctx := context.Background()

	// Insert a VM for tenant A.
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, created_at)
		VALUES ('vm-tenant-A-only', $1, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, tenantA)
	if err != nil {
		t.Fatalf("insert vm for tenant A: %v", err)
	}

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)

	// Tenant B lists VMs — should get an empty list.
	tokB := mintTestToken(t, tenantB, "user-B-1", "member")
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms", nil)
	req.Header.Set("Authorization", bearerHeader(tokB))
	w := httptest.NewRecorder()
	h.ListVMs(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var vms []vmRow
	if err := json.Unmarshal(w.Body.Bytes(), &vms); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	for _, v := range vms {
		if v.VmID == "vm-tenant-A-only" {
			t.Error("tenant B must not see tenant A's VMs")
		}
	}

	// Tenant A should see its own VM.
	tokA := mintTestToken(t, tenantA, "user-A-1", "member")
	req2 := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms", nil)
	req2.Header.Set("Authorization", bearerHeader(tokA))
	w2 := httptest.NewRecorder()
	h.ListVMs(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("tenant A list: expected 200, got %d", w2.Code)
	}
	var vmsA []vmRow
	if err := json.Unmarshal(w2.Body.Bytes(), &vmsA); err != nil {
		t.Fatalf("parse tenant A response: %v", err)
	}
	found := false
	for _, v := range vmsA {
		if v.VmID == "vm-tenant-A-only" {
			found = true
		}
	}
	if !found {
		t.Error("tenant A should see its own VM in the list")
	}
}
