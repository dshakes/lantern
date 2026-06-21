package handlers

// observability_p4_test.go — Phase 4 observability integration tests.
//
// Feature 4: eval_result journal event written when POST /v1/eval-runs
//            includes a run_id.
// Feature 5: GET /v1/runtime/metrics returns tenant-scoped VM rows and
//            403s cross-tenant attempts.
//
// DB-backed tests skip cleanly when DATABASE_URL is unset.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Shared helper: seed agent + version + run for ownership-gated tests
// ---------------------------------------------------------------------------

// evalRunFixture holds the IDs for a minimal agent+version+run row set.
type evalRunFixture struct {
	agentID, versionID, runID string
}

// seedRunForEvalOwnershipTest inserts an agent, an agent_version, and a run
// row under the given tenant. All rows are cleaned up in t.Cleanup.
// The returned runID is a valid UUID that will pass the ownership gate in
// EvalHandler.RecordRun.
func seedRunForEvalOwnershipTest(t *testing.T, pool *pgxpool.Pool, tenantID string) evalRunFixture {
	t.Helper()
	ctx := context.Background()

	agentName := fmt.Sprintf("eval-own-agent-%s", uuid.New().String()[:8])

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'eval ownership test fixture')
		RETURNING id::text
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("seedRunForEvalOwnershipTest: insert agent: %v", err)
	}

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-eval', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("seedRunForEvalOwnershipTest: insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("seedRunForEvalOwnershipTest: promote version: %v", err)
	}

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb)
		RETURNING id::text
	`, tenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("seedRunForEvalOwnershipTest: insert run: %v", err)
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(bg, `DELETE FROM agent_versions WHERE id = $1`, versionID)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE id = $1`, agentID)
	})

	return evalRunFixture{agentID: agentID, versionID: versionID, runID: runID}
}

// ---------------------------------------------------------------------------
// Feature 4: eval_result journal event
// ---------------------------------------------------------------------------

func TestEvalRecordRun_WritesEvalResultJournalEvent(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	tenantID := uuid.New().String()
	userID := uuid.New().String()
	agentName := "obs-test-agent-" + uuid.New().String()[:8]

	seedTestTenant(t, pool, tenantID)

	// Seed a real run so the ownership gate passes.
	fix := seedRunForEvalOwnershipTest(t, pool, tenantID)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewEvalHandler(srv, auth)

	tok := mintTestToken(t, tenantID, userID, "owner")

	// 1. Insert a suite so RecordRun can look up agent_name.
	var suiteID string
	casesJSON, _ := json.Marshal([]map[string]any{
		{"name": "case-1", "input": "hi", "expected": "hello"},
	})
	err := pool.QueryRow(ctx, `
		INSERT INTO eval_suites (tenant_id, agent_name, name, cases)
		VALUES ($1, $2, 'obs-suite', $3::jsonb)
		RETURNING id
	`, tenantID, agentName, casesJSON).Scan(&suiteID)
	if err != nil {
		t.Fatalf("insert eval_suite: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM eval_runs WHERE suite_id = $1`, suiteID)
		_, _ = pool.Exec(bg, `DELETE FROM eval_suites WHERE id = $1`, suiteID)
	})

	// 2. POST /v1/eval-runs with the real run_id.
	body := map[string]any{
		"suiteId": suiteID,
		"runId":   fix.runID,
		"caseResults": []map[string]any{
			{"name": "case-1", "passed": true, "score": 1.0},
		},
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/eval-runs", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.RecordRun(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("RecordRun: got %d, body: %s", w.Code, w.Body.String())
	}

	// 3. Verify an eval_result journal event was written for the run.
	var kind string
	var payloadRaw []byte
	err = pool.QueryRow(ctx, `
		SELECT kind, payload
		FROM journal_events
		WHERE run_id = $1 AND kind = 'eval_result'
		ORDER BY seq DESC
		LIMIT 1
	`, fix.runID).Scan(&kind, &payloadRaw)
	if err != nil {
		t.Fatalf("expected eval_result journal event for run %s, got error: %v", fix.runID, err)
	}
	if kind != "eval_result" {
		t.Errorf("journal kind: got %q, want eval_result", kind)
	}

	var payload map[string]any
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if score, _ := payload["score"].(float64); score != 1.0 {
		t.Errorf("payload score: got %v, want 1.0", payload["score"])
	}
	if sid, _ := payload["suiteId"].(string); sid != suiteID {
		t.Errorf("payload suiteId: got %q, want %q", sid, suiteID)
	}
}

func TestEvalRecordRun_NoRunID_NoJournalEvent(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	tenantID := uuid.New().String()
	userID := uuid.New().String()
	agentName := "obs-test-agent2-" + uuid.New().String()[:8]

	seedTestTenant(t, pool, tenantID)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewEvalHandler(srv, auth)

	tok := mintTestToken(t, tenantID, userID, "owner")

	var suiteID string
	casesJSON, _ := json.Marshal([]map[string]any{
		{"name": "c1", "input": "x", "expected": "y"},
	})
	err := pool.QueryRow(ctx, `
		INSERT INTO eval_suites (tenant_id, agent_name, name, cases)
		VALUES ($1, $2, 'obs-suite2', $3::jsonb)
		RETURNING id
	`, tenantID, agentName, casesJSON).Scan(&suiteID)
	if err != nil {
		t.Fatalf("insert eval_suite: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM eval_runs WHERE suite_id = $1`, suiteID)
		_, _ = pool.Exec(bg, `DELETE FROM eval_suites WHERE id = $1`, suiteID)
	})

	// POST without run_id.
	body := map[string]any{
		"suiteId":     suiteID,
		"caseResults": []map[string]any{{"name": "c1", "passed": true, "score": 0.5}},
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/eval-runs", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.RecordRun(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("RecordRun: got %d, body: %s", w.Code, w.Body.String())
	}

	// No eval_result rows should exist for a nil run_id (empty string).
	var count int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM journal_events WHERE run_id = '' AND kind = 'eval_result'
	`).Scan(&count)
	if count != 0 {
		t.Errorf("expected 0 eval_result journal events when run_id omitted, got %d", count)
	}
}

// TestEvalRecordRun_CrossTenantRunIDBlocked is the cross-tenant regression
// test for the HIGH security fix in evals.go: a tenant-A eval run that
// supplies tenant-B's run_id must NOT write any journal event for that run.
//
// Attack model: tenant-A knows (or guesses) a run UUID owned by tenant-B and
// passes it as runId in POST /v1/eval-runs. Without the ownership gate, the
// handler would write an eval_result journal event into tenant-B's run journal
// stream, potentially tampering with its verifiable receipt (which HMAC-signs
// the SHA-256 of journal_events).
func TestEvalRecordRun_CrossTenantRunIDBlocked(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	userA := uuid.New().String()
	agentName := "cross-tenant-agent-" + uuid.New().String()[:8]

	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)

	// Seed a real run under tenant-B (the "victim" run).
	fixB := seedRunForEvalOwnershipTest(t, pool, tenantB)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewEvalHandler(srv, auth)

	// Caller authenticates as tenant-A.
	tok := mintTestToken(t, tenantA, userA, "owner")

	// Create a suite under tenant-A.
	var suiteID string
	casesJSON, _ := json.Marshal([]map[string]any{
		{"name": "c1", "input": "x", "expected": "y"},
	})
	err := pool.QueryRow(ctx, `
		INSERT INTO eval_suites (tenant_id, agent_name, name, cases)
		VALUES ($1, $2, 'cross-tenant-suite', $3::jsonb)
		RETURNING id
	`, tenantA, agentName, casesJSON).Scan(&suiteID)
	if err != nil {
		t.Fatalf("insert eval_suite (tenant-A): %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM eval_runs WHERE suite_id = $1`, suiteID)
		_, _ = pool.Exec(bg, `DELETE FROM eval_suites WHERE id = $1`, suiteID)
	})

	// POST /v1/eval-runs as tenant-A, but with tenant-B's run_id.
	body := map[string]any{
		"suiteId": suiteID,
		"runId":   fixB.runID, // <-- tenant-B's run; tenant-A is not the owner
		"caseResults": []map[string]any{
			{"name": "c1", "passed": true, "score": 1.0},
		},
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/eval-runs", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.RecordRun(w, req)

	// The eval run itself should still be recorded (200 OK) — the optional
	// journal annotation is skipped, not the whole request.
	if w.Code != http.StatusOK {
		t.Fatalf("RecordRun: got %d, body: %s", w.Code, w.Body.String())
	}

	// CRITICAL: NO eval_result journal event must have been written for
	// tenant-B's run. If one exists the ownership gate is broken.
	var count int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM journal_events
		WHERE run_id = $1 AND kind = 'eval_result'
	`, fixB.runID).Scan(&count); err != nil {
		t.Fatalf("count journal events: %v", err)
	}
	if count != 0 {
		t.Errorf("CROSS-TENANT LEAK: %d eval_result journal event(s) written for tenant-B's run "+
			"by tenant-A's RecordRun call — ownership gate is broken", count)
	}
}

// ---------------------------------------------------------------------------
// Feature 5: GET /v1/runtime/metrics
// ---------------------------------------------------------------------------

func TestLiveMetrics_ReturnsTenantScopedVMs(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	userA := uuid.New().String()

	seedTestTenant(t, pool, tenantA)
	seedTestTenant(t, pool, tenantB)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)

	tokA := mintTestToken(t, tenantA, userA, "owner")

	// Insert a VM for tenantA and one for tenantB.
	vmA := "vm-obs-a-" + uuid.New().String()[:8]
	vmB := "vm-obs-b-" + uuid.New().String()[:8]
	specJSON := []byte(`{}`)
	instanceA := uuid.New().String()
	instanceB := uuid.New().String()
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, agent_instance_id, created_at)
		VALUES ($1, $2, 'running', $3::jsonb, $4, $5)
	`, vmA, tenantA, specJSON, instanceA, time.Now())
	if err != nil {
		t.Fatalf("insert vmA: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, agent_instance_id, created_at)
		VALUES ($1, $2, 'running', $3::jsonb, $4, $5)
	`, vmB, tenantB, specJSON, instanceB, time.Now())
	if err != nil {
		t.Fatalf("insert vmB: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id IN ($1, $2)`, vmA, vmB)
	})

	// GET /v1/runtime/metrics as tenantA.
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+tokA)
	w := httptest.NewRecorder()
	h.LiveMetrics(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("LiveMetrics: got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		TenantID string         `json:"tenantId"`
		VMs      []vmMetricsDTO `json:"vms"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.TenantID != tenantA {
		t.Errorf("tenantId: got %q, want %q", resp.TenantID, tenantA)
	}

	// vmA must appear, vmB must not.
	var foundA, foundB bool
	for _, vm := range resp.VMs {
		switch vm.VmID {
		case vmA:
			foundA = true
		case vmB:
			foundB = true
		}
	}
	if !foundA {
		t.Errorf("vmA (%s) not found in LiveMetrics response for tenantA", vmA)
	}
	if foundB {
		t.Errorf("vmB (%s) from tenantB leaked into tenantA LiveMetrics response", vmB)
	}

	_ = auth
	_ = sched
}

func TestLiveMetrics_Forbidden_UnknownRole(t *testing.T) {
	// authorizeRuntimeScope denies any unrecognised role — even for runtime:read.
	// This test exercises the RBAC gate without touching the DB: the handler
	// returns 403 before it ever calls pool.Query.
	tenantID := uuid.New().String()
	// Mint a token with an unrecognised role that authorizeRuntimeScope must deny.
	unknownTok := mintTestToken(t, tenantID, uuid.New().String(), "robot")

	h := newTestRuntimeHandler(t, &recScheduler{})
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+unknownTok)
	w := httptest.NewRecorder()
	h.LiveMetrics(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for unknown role, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestLiveMetrics_WithPromMetricsOverlay(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	tenantID := uuid.New().String()
	userID := uuid.New().String()

	seedTestTenant(t, pool, tenantID)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)

	// Create a RuntimeReportHandler (owns the in-memory store) and wire it.
	rptH := NewRuntimeReportHandler(srv)

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	h.SetMetricsStore(rptH)

	tok := mintTestToken(t, tenantID, userID, "owner")

	// Insert a VM for the tenant.
	vmID := "vm-obs-prom-" + uuid.New().String()[:8]
	specJSON := []byte(`{}`)
	instance := uuid.New().String()
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, agent_instance_id, created_at)
		VALUES ($1, $2, 'running', $3::jsonb, $4, $5)
	`, vmID, tenantID, specJSON, instance, time.Now())
	if err != nil {
		t.Fatalf("insert vm: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, vmID)
	})

	// Inject a prom entry directly into the store (bypassing HTTP auth).
	key := tenantID + "/" + vmID
	rptH.metricsMu.Lock()
	rptH.metricsLatest[key] = &vmMetricsEntry{
		TenantID:   tenantID,
		VmID:       vmID,
		PromText:   "# HELP test_metric A test counter\ntest_metric 42\n",
		ReceivedAt: time.Now(),
	}
	rptH.metricsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.LiveMetrics(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("LiveMetrics: got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		VMs []vmMetricsDTO `json:"vms"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var found bool
	for _, vm := range resp.VMs {
		if vm.VmID == vmID {
			found = true
			if vm.PromMetrics == "" {
				t.Errorf("expected PromMetrics to be populated, got empty string")
			}
			if vm.PromReceivedAt == nil {
				t.Errorf("expected PromReceivedAt to be set")
			}
		}
	}
	if !found {
		t.Errorf("vm %s not found in LiveMetrics response", vmID)
	}

	_ = auth
}

// ---------------------------------------------------------------------------
// sweepTerminatedVMMetrics eviction test
// ---------------------------------------------------------------------------

// TestSweepTerminatedVMMetrics_EvictsTerminalEntry verifies that
// sweepTerminatedVMMetrics removes the in-memory entry for a VM that has
// been marked as "terminated" in runtime_vms, and preserves entries for
// VMs that are still running.
func TestSweepTerminatedVMMetrics_EvictsTerminalEntry(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	tenantID := uuid.New().String()
	seedTestTenant(t, pool, tenantID)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	rptH := NewRuntimeReportHandler(srv)

	// Insert two VMs: one that will be terminated, one that stays running.
	vmTerminated := "vm-sweep-term-" + uuid.New().String()[:8]
	vmRunning := "vm-sweep-run-" + uuid.New().String()[:8]
	specJSON := []byte(`{}`)

	for _, vm := range []string{vmTerminated, vmRunning} {
		instance := uuid.New().String()
		_, err := pool.Exec(ctx, `
			INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, agent_instance_id, created_at)
			VALUES ($1, $2, 'running', $3::jsonb, $4, $5)
		`, vm, tenantID, specJSON, instance, time.Now())
		if err != nil {
			t.Fatalf("insert vm %s: %v", vm, err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM runtime_vms WHERE vm_id IN ($1, $2)`, vmTerminated, vmRunning)
	})

	// Inject both entries into the in-memory store.
	rptH.metricsMu.Lock()
	rptH.metricsLatest[tenantID+"/"+vmTerminated] = &vmMetricsEntry{
		TenantID: tenantID, VmID: vmTerminated, PromText: "terminated_metric 1\n", ReceivedAt: time.Now(),
	}
	rptH.metricsLatest[tenantID+"/"+vmRunning] = &vmMetricsEntry{
		TenantID: tenantID, VmID: vmRunning, PromText: "running_metric 1\n", ReceivedAt: time.Now(),
	}
	rptH.metricsMu.Unlock()

	// Flip the terminated VM to terminal state in the DB.
	if _, err := pool.Exec(ctx, `UPDATE runtime_vms SET state = 'terminated' WHERE vm_id = $1`, vmTerminated); err != nil {
		t.Fatalf("update vm state: %v", err)
	}

	// Run the sweep.
	evicted := rptH.sweepTerminatedVMMetrics(ctx)
	if evicted != 1 {
		t.Errorf("sweepTerminatedVMMetrics: evicted %d, want 1", evicted)
	}

	// The terminated VM's entry must be gone.
	rptH.metricsMu.RLock()
	_, termPresent := rptH.metricsLatest[tenantID+"/"+vmTerminated]
	_, runPresent := rptH.metricsLatest[tenantID+"/"+vmRunning]
	rptH.metricsMu.RUnlock()

	if termPresent {
		t.Errorf("metricsLatest still contains entry for terminated VM %s after sweep", vmTerminated)
	}
	if !runPresent {
		t.Errorf("metricsLatest lost entry for running VM %s — should have been retained", vmRunning)
	}
}
