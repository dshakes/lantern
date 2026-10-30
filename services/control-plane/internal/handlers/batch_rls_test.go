package handlers

// RLS enforcement tests for the batch handler (batch.go / ADR 0033).
//
// These tests use the newEnforcedServer harness (rls_integration_test.go) so
// every DB access the handlers route through s.srv.WithTenant is executed by
// the non-superuser `lantern_app` role with RLS genuinely enforced — NOT
// simulated.
//
// Skipped automatically when DATABASE_URL is unset.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newEnforcedBatchHandlers builds a BatchHandler whose server uses the
// RLS-enforced TenantPool. The RESTHandler is constructed with a nil workflow
// engine and nil LLM so any spawnBatchRun attempt will fail gracefully (the
// tests here never reach run dispatch; they test only the batch CRUD layer).
func newEnforcedBatchHandlers(t *testing.T, e *enforcedServer) *BatchHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)

	// restHandler needs a logger; use a real one.
	logger, _ := zap.NewDevelopment()
	restSrv := &server.Server{
		Pool:    e.srv.Pool,
		AppPool: e.srv.AppPool,
		Logger:  logger,
	}
	// Build a minimal RESTHandler. Most fields are nil (no engine, no LLM)
	// — sufficient for batch CRUD tests that don't dispatch child runs.
	rest := &RESTHandler{
		srv:  restSrv,
		auth: auth,
	}
	return NewBatchHandler(e.srv, auth, rest)
}

// seedBatchDirect inserts a batch row directly via the privileged pool
// (bypassing RLS) and registers cleanup. Returns the batch id.
func seedBatchDirect(t *testing.T, e *enforcedServer, tenantID, agentName string, count int) string {
	t.Helper()
	var id string
	err := e.superPool.QueryRow(context.Background(), `
		INSERT INTO batches (tenant_id, agent_name, total_count, pending_count, status)
		VALUES ($1, $2, $3, $3, 'running')
		RETURNING id
	`, tenantID, agentName, count).Scan(&id)
	if err != nil {
		t.Fatalf("seedBatchDirect: %v", err)
	}
	t.Cleanup(func() {
		_, _ = e.superPool.Exec(context.Background(), `DELETE FROM batches WHERE id = $1`, id)
	})
	return id
}

// postCreateBatch fires POST /v1/batches and returns the recorder.
func postCreateBatch(t *testing.T, h *BatchHandler, tenantID string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/batches", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	tok := mintTestToken(t, tenantID, "user-batch-test", "owner")
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateBatch(rr, req)
	return rr
}

// postCreateBatchIdem fires POST /v1/batches with an Idempotency-Key header.
func postCreateBatchIdem(t *testing.T, h *BatchHandler, tenantID, idemKey string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/batches", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", idemKey)
	tok := mintTestToken(t, tenantID, "user-batch-test", "owner")
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateBatch(rr, req)
	return rr
}

// getOneBatch fires GET /v1/batches/{id} and returns the recorder.
func getOneBatch(t *testing.T, h *BatchHandler, tenantID, batchID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/batches/"+batchID, nil)
	req.SetPathValue("id", batchID)
	tok := mintTestToken(t, tenantID, "user-batch-test", "owner")
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetBatch(rr, req)
	return rr
}

// cancelBatch fires POST /v1/batches/{id}/cancel and returns the recorder.
func cancelBatch(t *testing.T, h *BatchHandler, tenantID, batchID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/batches/"+batchID+"/cancel", nil)
	req.SetPathValue("id", batchID)
	tok := mintTestToken(t, tenantID, "user-batch-test", "owner")
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CancelBatch(rr, req)
	return rr
}

// ---------- tests ----------

// TestRLSBatches_SameTenant_CreateAndGet proves that a tenant can create a
// batch (INSERT via WithTenant succeeds under RLS WITH CHECK) and immediately
// retrieve it (SELECT via WithTenant returns the row, not zero).
func TestRLSBatches_SameTenant_CreateAndGet(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-batch-own-"+uuid.NewString()[:8])

	// CreateBatch: must return 201 with an id.
	rr := postCreateBatch(t, h, tenant, map[string]any{
		"agentName": "test-agent",
		"items":     []map[string]any{{"input": map[string]any{"msg": "hello"}}},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("same-tenant CreateBatch: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil || resp["id"] == "" {
		t.Fatalf("CreateBatch response missing id: %s", rr.Body.String())
	}
	batchID := fmt.Sprint(resp["id"])

	// GetBatch: must return 200 with the row.
	rr2 := getOneBatch(t, h, tenant, batchID)
	if rr2.Code != http.StatusOK {
		t.Fatalf("same-tenant GetBatch after create: got %d, want 200; body: %s", rr2.Code, rr2.Body.String())
	}
	var summary batchSummary
	if err := json.Unmarshal(rr2.Body.Bytes(), &summary); err != nil {
		t.Fatalf("GetBatch decode: %v; body: %s", err, rr2.Body.String())
	}
	if summary.ID != batchID {
		t.Errorf("GetBatch returned wrong id: %q, want %q", summary.ID, batchID)
	}
	if summary.AgentName != "test-agent" {
		t.Errorf("GetBatch agentName: %q, want %q", summary.AgentName, "test-agent")
	}
	if summary.TotalCount != 1 {
		t.Errorf("GetBatch totalCount: %d, want 1", summary.TotalCount)
	}
}

// TestRLSBatches_CrossTenant_GetBlocked proves that tenant B cannot see
// tenant A's batch via GetBatch — RLS returns 404 (row hidden, not 403).
func TestRLSBatches_CrossTenant_GetBlocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-batch-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-batch-iso-b-"+uuid.NewString()[:8])

	// Seed a batch for tenant A via the privileged pool (bypasses RLS).
	batchID := seedBatchDirect(t, e, tenantA, "agent-a", 5)

	// Tenant A reads its own batch → 200.
	rrA := getOneBatch(t, h, tenantA, batchID)
	if rrA.Code != http.StatusOK {
		t.Fatalf("REGRESSION: tenant A cannot GET its own batch under RLS: got %d; body: %s",
			rrA.Code, rrA.Body.String())
	}

	// Tenant B reads tenant A's batch → must be 404 (row hidden by RLS).
	rrB := getOneBatch(t, h, tenantB, batchID)
	if rrB.Code != http.StatusNotFound {
		t.Errorf("SECURITY VIOLATION: tenant B got %d reading tenant A's batch (want 404); body: %s",
			rrB.Code, rrB.Body.String())
	}
}

// TestRLSBatches_CrossTenant_CancelBlocked proves that tenant B cannot cancel
// tenant A's batch via CancelBatch (returns 404, not 200).
func TestRLSBatches_CrossTenant_CancelBlocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-batch-cancel-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-batch-cancel-b-"+uuid.NewString()[:8])

	batchID := seedBatchDirect(t, e, tenantA, "agent-cancel", 2)

	// Tenant B tries to cancel tenant A's batch → 404.
	rr := cancelBatch(t, h, tenantB, batchID)
	if rr.Code != http.StatusNotFound {
		t.Errorf("SECURITY VIOLATION: tenant B cancelling tenant A's batch got %d (want 404); body: %s",
			rr.Code, rr.Body.String())
	}

	// Tenant A can cancel its own batch → 200.
	rrA := cancelBatch(t, h, tenantA, batchID)
	if rrA.Code != http.StatusOK {
		t.Fatalf("REGRESSION: tenant A cannot cancel its own batch under RLS: got %d; body: %s",
			rrA.Code, rrA.Body.String())
	}
}

// TestRLSBatches_IdempotentCreate proves that POST /v1/batches with the same
// Idempotency-Key header returns the EXISTING batch (200) rather than creating
// a duplicate.
func TestRLSBatches_IdempotentCreate(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-batch-idem-"+uuid.NewString()[:8])
	idemKey := "idem-batch-" + uuid.NewString()

	body := map[string]any{
		"agentName": "idem-agent",
		"items":     []map[string]any{{"input": map[string]any{"n": 1}}},
	}

	// First call → 201.
	rr1 := postCreateBatchIdem(t, h, tenant, idemKey, body)
	if rr1.Code != http.StatusCreated {
		t.Fatalf("first idempotent CreateBatch: got %d, want 201; body: %s", rr1.Code, rr1.Body.String())
	}
	var resp1 map[string]any
	if err := json.Unmarshal(rr1.Body.Bytes(), &resp1); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	id1 := fmt.Sprint(resp1["id"])

	// Second call (same key) → 200 with the same id.
	rr2 := postCreateBatchIdem(t, h, tenant, idemKey, body)
	if rr2.Code != http.StatusOK {
		t.Fatalf("second idempotent CreateBatch: got %d, want 200; body: %s", rr2.Code, rr2.Body.String())
	}
	var resp2 map[string]any
	if err := json.Unmarshal(rr2.Body.Bytes(), &resp2); err != nil {
		t.Fatalf("decode second response: %v", err)
	}
	id2 := fmt.Sprint(resp2["id"])
	if id1 != id2 {
		t.Errorf("idempotent CreateBatch returned different ids: first %q, second %q — a duplicate was created", id1, id2)
	}
}

// TestRLSBatches_SSRFCallbackUrl proves that CreateBatch rejects a private-IP
// callbackUrl with 400 (SSRF protection) before touching the DB.
func TestRLSBatches_SSRFCallbackUrl(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-batch-ssrf-"+uuid.NewString()[:8])

	rr := postCreateBatch(t, h, tenant, map[string]any{
		"agentName":   "ssrf-agent",
		"items":       []map[string]any{{"input": map[string]any{}}},
		"callbackUrl": "http://169.254.169.254/latest/meta-data/",
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("SSRF callbackUrl: got %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}

// TestBatchRecovery_HeartbeatGatesFinalization pins the live-batch race fix:
// recovery must never finalize a batch whose dispatcher is still heartbeating,
// however old the batch is, and must finalize it once the heartbeat goes stale.
func TestBatchRecovery_HeartbeatGatesFinalization(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)
	ctx := context.Background()
	tenant := seedEnforcedTenant(t, e, "batch-hb-"+uuid.NewString()[:8])
	id := seedBatchDirect(t, e, tenant, "agent-hb", 1)
	log := zap.NewNop()

	status := func() string {
		var s string
		if err := e.superPool.QueryRow(ctx, `SELECT status FROM batches WHERE id = $1`, id).Scan(&s); err != nil {
			t.Fatalf("read status: %v", err)
		}
		return s
	}

	// Old batch, live dispatcher (fresh heartbeat), no child runs yet.
	if _, err := e.superPool.Exec(ctx,
		`UPDATE batches SET created_at = now() - interval '2 hours', heartbeat_at = now() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	h.recoverStuckBatches(ctx, log)
	if got := status(); got != "running" {
		t.Fatalf("live batch (fresh heartbeat) was finalized by recovery: status=%s", got)
	}

	// Dispatcher died: heartbeat stale → recovery finalizes.
	if _, err := e.superPool.Exec(ctx,
		`UPDATE batches SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	h.recoverStuckBatches(ctx, log)
	if got := status(); got == "running" {
		t.Fatalf("dead batch (stale heartbeat) was not recovered")
	}
}

// TestCancelBatch_DeadDispatcherSettlesCounters: cancelling a batch whose
// dispatcher died (stale heartbeat) must settle the counters — nobody else
// will — while a live batch's counters are left to its dispatcher.
func TestCancelBatch_DeadDispatcherSettlesCounters(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBatchHandlers(t, e)
	ctx := context.Background()
	tenant := seedEnforcedTenant(t, e, "batch-cancel-dead-"+uuid.NewString()[:8])

	counts := func(id string) (pending, cancelled int) {
		if err := e.superPool.QueryRow(ctx,
			`SELECT pending_count, cancelled_count FROM batches WHERE id = $1`, id).Scan(&pending, &cancelled); err != nil {
			t.Fatalf("read counters: %v", err)
		}
		return
	}

	dead := seedBatchDirect(t, e, tenant, "agent-dead", 3)
	if _, err := e.superPool.Exec(ctx,
		`UPDATE batches SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, dead); err != nil {
		t.Fatal(err)
	}
	if rr := cancelBatch(t, h, tenant, dead); rr.Code != http.StatusOK {
		t.Fatalf("cancel dead batch: %d %s", rr.Code, rr.Body.String())
	}
	if p, c := counts(dead); p != 0 || c != 3 {
		t.Fatalf("dead batch counters not settled: pending=%d cancelled=%d (want 0, 3)", p, c)
	}

	live := seedBatchDirect(t, e, tenant, "agent-live", 3) // heartbeat_at defaults to now()
	if rr := cancelBatch(t, h, tenant, live); rr.Code != http.StatusOK {
		t.Fatalf("cancel live batch: %d %s", rr.Code, rr.Body.String())
	}
	if p, c := counts(live); p != 3 || c != 0 {
		t.Fatalf("live batch counters were overwritten: pending=%d cancelled=%d (dispatcher owns them)", p, c)
	}
}
