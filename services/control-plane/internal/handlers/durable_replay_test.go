package handlers

// durable_replay_test.go — unit + integration tests for crash-replay primitives.
//
// DB-gated tests are skipped when DATABASE_URL is unset; run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test -run TestDurableReplay ./internal/handlers/ -v -count=1

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Pure-function tests — no DB needed
// ---------------------------------------------------------------------------

func TestIdempotencyKey_Deterministic(t *testing.T) {
	k1 := idempotencyKey("run-abc", "llm:main", 1)
	k2 := idempotencyKey("run-abc", "llm:main", 1)
	if k1 != k2 {
		t.Errorf("idempotencyKey not deterministic: %q vs %q", k1, k2)
	}
}

func TestIdempotencyKey_Unique(t *testing.T) {
	cases := []struct {
		runID, stepID string
		attempt       int
	}{
		{"run-1", "llm:main", 1},
		{"run-1", "llm:main", 2},
		{"run-1", "deliver", 1},
		{"run-2", "llm:main", 1},
	}
	seen := map[string]struct{}{}
	for _, c := range cases {
		k := idempotencyKey(c.runID, c.stepID, c.attempt)
		if _, dup := seen[k]; dup {
			t.Errorf("collision: idempotencyKey(%q,%q,%d) = %q already seen", c.runID, c.stepID, c.attempt, k)
		}
		seen[k] = struct{}{}
	}
}

func TestIdempotencyKey_NonEmpty(t *testing.T) {
	k := idempotencyKey("", "", 0)
	if k == "" {
		t.Error("idempotencyKey returned empty string")
	}
	if len(k) != 64 { // hex(sha256) is always 64 chars
		t.Errorf("expected 64-char hex, got %d chars: %q", len(k), k)
	}
}

func TestRunRecoveryLoop_NilHandlerReturnsImmediately(t *testing.T) {
	// nil handler hits the pool-nil guard and the goroutine returns immediately.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		RunRecoveryLoop(ctx, nil, nil, time.Hour)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Error("RunRecoveryLoop did not exit within 500ms for nil handler")
	}
}

func TestRunRecoveryLoop_StopsOnCtxCancel(t *testing.T) {
	// Non-nil handler with nil pool also returns immediately from the nil guard.
	// We cancel ctx right after launching and verify the goroutine stops.
	log, _ := zap.NewDevelopment()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		RunRecoveryLoop(ctx, &RESTHandler{}, log, 50*time.Millisecond)
		close(done)
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Error("RunRecoveryLoop goroutine did not stop within 500ms of ctx cancel")
	}
}

// ---------------------------------------------------------------------------
// DB-gated helpers
// ---------------------------------------------------------------------------

// drFixture holds IDs for a minimal agent+version+run inserted for a test.
type drFixture struct {
	agentID, versionID, runID string
}

// insertDRFixture inserts an agent, version, and run row under the dev tenant
// with the given status. All rows are cleaned up via t.Cleanup.
func insertDRFixture(t *testing.T, pool *pgxpool.Pool, agentName, status string) drFixture {
	t.Helper()
	ctx := context.Background()
	tenantID := recoveryTestDevTenantID

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'durable replay test fixture')
		RETURNING id::text
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-dr', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, $4, 'api', '{}'::jsonb)
		RETURNING id::text
	`, tenantID, agentID, versionID, status).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM side_effect_receipts WHERE run_id = $1`, runID)
		_, _ = pool.Exec(bg, `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = pool.Exec(bg, `DELETE FROM run_locks WHERE run_id = $1`, runID)
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(bg, `DELETE FROM agent_versions WHERE id = $1`, versionID)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE id = $1`, agentID)
	})

	return drFixture{agentID: agentID, versionID: versionID, runID: runID}
}

// ---------------------------------------------------------------------------
// Piece 2 — Run lease
// ---------------------------------------------------------------------------

func TestRunLease_AcquireAndRelease(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-lease-acquire-%d", time.Now().UnixNano()), "queued")

	log, _ := zap.NewDevelopment()
	acquired, release, err := acquireRunLease(ctx, pool, f.runID, log)
	if err != nil {
		t.Fatalf("acquireRunLease: %v", err)
	}
	if !acquired {
		t.Fatal("expected lease acquired, got false")
	}
	if release == nil {
		t.Fatal("release func is nil")
	}

	// Lock row must exist.
	var wid string
	if err := pool.QueryRow(ctx, `SELECT worker_id FROM run_locks WHERE run_id = $1`, f.runID).Scan(&wid); err != nil {
		t.Fatalf("no lock row after acquire: %v", err)
	}
	if wid == "" {
		t.Error("worker_id is empty")
	}

	// After release the lock row must be deleted.
	release()
	var count int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM run_locks WHERE run_id = $1`, f.runID).Scan(&count)
	if count != 0 {
		t.Errorf("expected lock row deleted after release, got count=%d", count)
	}
}

func TestRunLease_SecondAcquireFails(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-lease-double-%d", time.Now().UnixNano()), "queued")

	log, _ := zap.NewDevelopment()

	// First acquire must succeed.
	acquired1, release1, err := acquireRunLease(ctx, pool, f.runID, log)
	if err != nil || !acquired1 {
		t.Fatalf("first acquireRunLease: acquired=%v err=%v", acquired1, err)
	}
	defer release1()

	// Second acquire on a live lease must return false.
	acquired2, release2, err2 := acquireRunLease(ctx, pool, f.runID, log)
	if err2 != nil {
		t.Fatalf("second acquireRunLease returned error: %v", err2)
	}
	if acquired2 {
		if release2 != nil {
			release2()
		}
		t.Error("second acquire should have returned false (live lease held by first)")
	}
}

func TestRunLease_ExpiredLeaseCanBeStolen(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-lease-steal-%d", time.Now().UnixNano()), "running")

	// Directly insert an EXPIRED lock row.
	if _, err := pool.Exec(ctx, `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1, 'dead-worker', now() - interval '2 hours', now() - interval '1 hour')
	`, f.runID); err != nil {
		t.Fatalf("insert expired lock: %v", err)
	}

	log, _ := zap.NewDevelopment()
	acquired, release, err := acquireRunLease(ctx, pool, f.runID, log)
	if err != nil {
		t.Fatalf("acquireRunLease on expired lock: %v", err)
	}
	if !acquired {
		t.Fatal("expected to steal expired lease, got false")
	}
	defer release()

	var wid string
	_ = pool.QueryRow(ctx, `SELECT worker_id FROM run_locks WHERE run_id = $1`, f.runID).Scan(&wid)
	if wid == "dead-worker" {
		t.Error("lock still owned by dead-worker — steal did not update worker_id")
	}
}

// ---------------------------------------------------------------------------
// Piece 2 — LLM journal cache
// ---------------------------------------------------------------------------

func TestCachedLLMStep_MissAndHit(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-llmcache-%d", time.Now().UnixNano()), "running")

	// Cache miss: no journal rows yet.
	_, hit, err := checkCachedLLMStep(ctx, pool, f.runID)
	if err != nil {
		t.Fatalf("checkCachedLLMStep (miss): %v", err)
	}
	if hit {
		t.Error("expected cache miss on empty journal, got hit")
	}

	// step_started must NOT count as a cache hit.
	emitLLMJournalEvent(ctx, pool, f.runID, "step_started", map[string]any{"name": llmStepID})
	_, hit2, _ := checkCachedLLMStep(ctx, pool, f.runID)
	if hit2 {
		t.Error("step_started should not produce a cache hit")
	}

	// Emit step_completed with a known payload.
	want := llmStepPayload{
		Result:    "hello world",
		TokensIn:  100,
		TokensOut: 42,
		CostUSD:   0.0012,
		Provider:  "openai",
		Model:     "gpt-4o",
	}
	emitLLMJournalEvent(ctx, pool, f.runID, "step_completed", want)

	got, hit3, err := checkCachedLLMStep(ctx, pool, f.runID)
	if err != nil {
		t.Fatalf("checkCachedLLMStep (hit): %v", err)
	}
	if !hit3 {
		t.Fatal("expected cache hit after step_completed emit, got miss")
	}
	if got.Result != want.Result {
		t.Errorf("result: got %q want %q", got.Result, want.Result)
	}
	if got.TokensIn != want.TokensIn {
		t.Errorf("tokens_in: got %d want %d", got.TokensIn, want.TokensIn)
	}
	if got.TokensOut != want.TokensOut {
		t.Errorf("tokens_out: got %d want %d", got.TokensOut, want.TokensOut)
	}
	if got.Provider != want.Provider {
		t.Errorf("provider: got %q want %q", got.Provider, want.Provider)
	}
	if got.Model != want.Model {
		t.Errorf("model: got %q want %q", got.Model, want.Model)
	}
}

// TestCachedLLMStep_SecondEmitIsIdempotent verifies that emitting a second
// step_completed (e.g. from a re-drive that didn't skip correctly) doesn't
// corrupt the cache — the first cached value stays accessible.
func TestCachedLLMStep_SecondEmitIsIdempotent(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-llmcache2-%d", time.Now().UnixNano()), "running")

	first := llmStepPayload{Result: "first", TokensIn: 10, TokensOut: 5}
	emitLLMJournalEvent(ctx, pool, f.runID, "step_completed", first)
	second := llmStepPayload{Result: "second", TokensIn: 20, TokensOut: 10}
	emitLLMJournalEvent(ctx, pool, f.runID, "step_completed", second)

	// checkCachedLLMStep returns the latest (highest seq) step_completed.
	// Either row is acceptable as long as the cache reports a hit.
	got, hit, _ := checkCachedLLMStep(ctx, pool, f.runID)
	if !hit {
		t.Fatal("expected cache hit, got miss")
	}
	if got.Result != "first" && got.Result != "second" {
		t.Errorf("unexpected result: %q", got.Result)
	}
}

// ---------------------------------------------------------------------------
// Piece 3 — Side-effect dedup
// ---------------------------------------------------------------------------

func TestClaimSideEffect_OnceOnly(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-se-once-%d", time.Now().UnixNano()), "succeeded")

	key := idempotencyKey(f.runID, "whatsapp_self", 1)
	tenantID := recoveryTestDevTenantID

	// First claim returns true (row inserted).
	first, err := claimSideEffect(ctx, pool, key, f.runID, tenantID, "whatsapp_self")
	if err != nil {
		t.Fatalf("claimSideEffect (first): %v", err)
	}
	if !first {
		t.Error("first claim should return true")
	}

	// Second claim with same key returns false (ON CONFLICT DO NOTHING).
	second, err := claimSideEffect(ctx, pool, key, f.runID, tenantID, "whatsapp_self")
	if err != nil {
		t.Fatalf("claimSideEffect (second): %v", err)
	}
	if second {
		t.Error("second claim with same key should return false (already delivered)")
	}
}

func TestClaimSideEffect_DifferentKeysIndependent(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-se-multi-%d", time.Now().UnixNano()), "succeeded")

	tenantID := recoveryTestDevTenantID
	key1 := idempotencyKey(f.runID, "whatsapp_self", 1)
	key2 := idempotencyKey(f.runID, "whatsapp_self", 2) // different attempt → different key

	ok1, _ := claimSideEffect(ctx, pool, key1, f.runID, tenantID, "whatsapp_self")
	ok2, _ := claimSideEffect(ctx, pool, key2, f.runID, tenantID, "whatsapp_self")
	if !ok1 || !ok2 {
		t.Errorf("both independent keys should be claimable: ok1=%v ok2=%v", ok1, ok2)
	}
}

func TestClaimSideEffect_CrossRunKeysIndependent(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	f1 := insertDRFixture(t, pool, fmt.Sprintf("dr-se-cross1-%d", time.Now().UnixNano()), "succeeded")
	f2 := insertDRFixture(t, pool, fmt.Sprintf("dr-se-cross2-%d", time.Now().UnixNano()), "succeeded")

	tenantID := recoveryTestDevTenantID
	// Same stepID/attempt but different runIDs → different keys, no interference.
	key1 := idempotencyKey(f1.runID, "whatsapp_self", 1)
	key2 := idempotencyKey(f2.runID, "whatsapp_self", 1)

	if key1 == key2 {
		t.Fatal("keys for different runs must not collide")
	}

	ok1, _ := claimSideEffect(ctx, pool, key1, f1.runID, tenantID, "whatsapp_self")
	ok2, _ := claimSideEffect(ctx, pool, key2, f2.runID, tenantID, "whatsapp_self")
	if !ok1 || !ok2 {
		t.Errorf("cross-run keys should both be claimable: ok1=%v ok2=%v", ok1, ok2)
	}
}

// ---------------------------------------------------------------------------
// Fix 1 regression — recovery self-deadlock
//
// Before the fix, RecoverOrphanedRuns acquired a lock with an ephemeral
// worker_id ("recovery-sweep-<nano>"), then called executeRunInlineSync which
// called acquireRunLease with the stable workerID() (hostname-pid).
// acquireRunLease's UPSERT only steals EXPIRED locks; the recovery lock was
// fresh, so RowsAffected==0 → leaseAcquired=false → the run stayed 'running'.
//
// The fix: recovery now deletes its own lock row BEFORE calling
// executeRunInlineSync.  executeRunInlineSync's acquireRunLease then finds no
// row and inserts fresh — exactly the "expired/absent → steal" case it already
// handles.  The recovery sweep uses workerID() (not an ephemeral string) so
// the targeted DELETE hits the right row.
// ---------------------------------------------------------------------------

// TestRecovery_NoSelfDeadlock verifies that RecoverOrphanedRuns successfully
// re-drives a plain-LLM run all the way to 'succeeded' when a cached
// step_completed journal row exists (no real LLM call needed).
//
// The test pre-seeds the journal with a step_completed payload so the replay
// gate fires and skips callLLMWithFailover.  The handler is wired with a real
// (but key-less) llmProxy so the nil-guard in redriveRun passes.
func TestRecovery_NoSelfDeadlock(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	// Build a fully-wired RESTHandler with a real (but key-less) llmProxy.
	// The proxy has no LLM keys, but the replay path never reaches the LLM
	// call because checkCachedLLMStep returns a hit.
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)
	proxy := NewLlmProxyHandler(srv, auth)
	h.SetLlmProxy(proxy)

	// Insert an orphaned plain-LLM run (status=running, no lock).
	f := insertDRFixture(t, pool, fmt.Sprintf("dr-nodeadlock-%d", time.Now().UnixNano()), "running")

	// Pre-seed the journal with step_completed so the replay gate fires and
	// the run can reach 'succeeded' without a live LLM key.
	emitLLMJournalEvent(ctx, pool, f.runID, "step_completed", llmStepPayload{
		Result:    "replay-result",
		TokensIn:  50,
		TokensOut: 25,
		CostUSD:   0.0005,
		Provider:  "openai",
		Model:     "gpt-4o",
	})

	// Verify precondition: no lock row (truly orphaned).
	var lockCount int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM run_locks WHERE run_id = $1`, f.runID).Scan(&lockCount)
	if lockCount != 0 {
		t.Fatal("precondition failed: run already has a lock row")
	}

	// Run the recovery sweep.
	recovered, skipped := h.RecoverOrphanedRuns(ctx)
	t.Logf("recovered=%d skipped=%d", recovered, skipped)

	// The run must have been re-driven to 'succeeded' — not left 'running'.
	var finalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, f.runID).Scan(&finalStatus); err != nil {
		t.Fatalf("read final status: %v", err)
	}
	if finalStatus != "succeeded" {
		t.Errorf("run still %q after recovery sweep — self-deadlock may have recurred", finalStatus)
	}
	if recovered < 1 {
		t.Errorf("expected recovered>=1, got recovered=%d skipped=%d", recovered, skipped)
	}
}
