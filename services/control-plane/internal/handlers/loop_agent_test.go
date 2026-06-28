package handlers

// Tests for the loop-agent platform primitive (Part B).
//
//  TestNextNudgeAt_*                — pure unit tests; no DB.
//  TestLoopScan_NudgesDue           — DB: due commitments get next_nudge_at
//                                     advanced + a loop_nudge journal event.
//  TestLoopScan_SkipsNotDue         — DB: future-nudge commitments untouched.
//  TestLoopScan_SkipsDoneAndDismiss — DB: terminal-status rows ignored.
//  TestParseLoopManifest_*          — pure unit tests; no DB.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"go.uber.org/zap"
)

// ---------- Pure unit tests: nextNudgeAt ----------

func TestNextNudgeAt_FirstNudge(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	got := nextNudgeAt(nil, now.Add(-10*time.Minute), now)
	want := now.Add(45 * time.Minute)
	if diff := got.Sub(want); diff < -time.Second || diff > time.Second {
		t.Errorf("first nudge: got %v, want ~%v", got, want)
	}
}

func TestNextNudgeAt_SecondNudge(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	last := now.Add(-45 * time.Minute)
	// createdAt 45m ago → age < 2h → +2h
	got := nextNudgeAt(&last, now.Add(-45*time.Minute), now)
	want := now.Add(2 * time.Hour)
	if diff := got.Sub(want); diff < -time.Second || diff > time.Second {
		t.Errorf("second nudge: got %v, want ~%v", got, want)
	}
}

func TestNextNudgeAt_ThirdNudge(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	last := now.Add(-3 * time.Hour)
	// createdAt 3h ago → 2h <= age < 8h → +6h
	got := nextNudgeAt(&last, now.Add(-3*time.Hour), now)
	want := now.Add(6 * time.Hour)
	if diff := got.Sub(want); diff < -time.Second || diff > time.Second {
		t.Errorf("third nudge: got %v, want ~%v", got, want)
	}
}

func TestNextNudgeAt_MatureNudge(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	last := now.Add(-10 * time.Hour)
	// createdAt 10h ago → age ≥ 8h → +24h
	got := nextNudgeAt(&last, now.Add(-10*time.Hour), now)
	want := now.Add(24 * time.Hour)
	if diff := got.Sub(want); diff < -time.Second || diff > time.Second {
		t.Errorf("mature nudge: got %v, want ~%v", got, want)
	}
}

// ---------- DB-backed helpers ----------

// insertRawCommitmentPool inserts a commitment row directly (bypasses handler
// validation). Returns the row ID and a cleanup func.
func insertRawCommitmentPool(t *testing.T, tenantID, status, urgency string, nextNudge *time.Time) (string, func()) {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, status, tier, urgency, next_nudge_at)
		VALUES ($1, 'test task', 'self', $2, 'meso', $3, $4)
		RETURNING id
	`, tenantID, status, urgency, nextNudge).Scan(&id); err != nil {
		t.Fatalf("insertRawCommitment: %v", err)
	}
	cleanup := func() {
		_, _ = pool.Exec(ctx, "DELETE FROM commitments WHERE id = $1", id)
	}
	return id, cleanup
}

// ensureAgentAndVersion upserts an agent + version and returns (agentID, versionID).
func ensureAgentAndVersion(t *testing.T, tenantID, agentName string) (string, string) {
	t.Helper()
	pool := openTestPool(t)
	ctx := context.Background()
	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'loop test')
		ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("ensure agent: %v", err)
	}
	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v-loop-test', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
		RETURNING id
	`, agentID, agentName+"-v-loop-test").Scan(&versionID); err != nil {
		t.Fatalf("ensure version: %v", err)
	}
	return agentID, versionID
}

// insertTestRun inserts a minimal run row and returns its ID.
func insertTestRun(t *testing.T, tenantID, agentName string) string {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	agentID, versionID := ensureAgentAndVersion(t, tenantID, agentName)
	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'running', 'schedule', '{}'::jsonb)
		RETURNING id
	`, tenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insertTestRun: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DELETE FROM journal_events WHERE run_id = $1", runID)
		_, _ = pool.Exec(ctx, "DELETE FROM runs WHERE id = $1", runID)
	})
	return runID
}

// nopLogger returns a no-op logger (clean test output).
func nopLogger() *zap.Logger { return zap.NewNop() }

// ---------- TestLoopScan_NudgesDue ----------

// TestLoopScan_NudgesDue: a due commitment (next_nudge_at IS NULL) gets
// next_nudge_at advanced to ~+45m and a loop_nudge journal event is emitted.
func TestLoopScan_NudgesDue(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedCommitmentTenant(t, pool)
	runID := insertTestRun(t, tenant, "concierge-test-scan")

	// Due commitment: next_nudge_at IS NULL.
	id, cleanup := insertRawCommitmentPool(t, tenant, "open", "now", nil)
	defer cleanup()

	surfaced, err := scanAndNudgeCommitments(ctx, pool, nopLogger(), tenant, runID)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if surfaced != 1 {
		t.Errorf("surfaced=%d, want 1", surfaced)
	}

	// Assert next_nudge_at was advanced to ~+45m.
	var newNudge *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT next_nudge_at FROM commitments WHERE id = $1`, id,
	).Scan(&newNudge); err != nil {
		t.Fatalf("read next_nudge_at: %v", err)
	}
	if newNudge == nil {
		t.Fatal("next_nudge_at is still nil after scan")
	}
	minExpected := time.Now().Add(40 * time.Minute)
	if newNudge.Before(minExpected) {
		t.Errorf("next_nudge_at=%v not advanced to ~+45m (want after %v)", newNudge, minExpected)
	}

	// Assert journal event was emitted with the right kind + payload.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM journal_events WHERE run_id = $1 AND kind = 'loop_nudge'`, runID,
	).Scan(&count); err != nil {
		t.Fatalf("count journal events: %v", err)
	}
	if count != 1 {
		t.Errorf("loop_nudge events=%d, want 1", count)
	}

	var payload []byte
	if err := pool.QueryRow(ctx,
		`SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'loop_nudge'`, runID,
	).Scan(&payload); err != nil {
		t.Fatalf("read journal payload: %v", err)
	}
	var p map[string]any
	if err := json.Unmarshal(payload, &p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if p["commitment_id"] != id {
		t.Errorf("payload commitment_id=%v, want %q", p["commitment_id"], id)
	}
	if p["urgency"] != "now" {
		t.Errorf("payload urgency=%v, want 'now'", p["urgency"])
	}
}

// TestLoopScan_SkipsNotDue: a commitment with next_nudge_at in the future is
// not surfaced and not mutated.
func TestLoopScan_SkipsNotDue(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedCommitmentTenant(t, pool)
	runID := insertTestRun(t, tenant, "concierge-not-due")

	futureNudge := time.Now().Add(2 * time.Hour)
	id, cleanup := insertRawCommitmentPool(t, tenant, "open", "normal", &futureNudge)
	defer cleanup()

	surfaced, err := scanAndNudgeCommitments(ctx, pool, nopLogger(), tenant, runID)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if surfaced != 0 {
		t.Errorf("surfaced=%d for future-nudge commitment, want 0", surfaced)
	}

	// next_nudge_at must still be in the future (unchanged).
	var stored *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT next_nudge_at FROM commitments WHERE id = $1`, id,
	).Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	if stored == nil || stored.Before(time.Now().Add(90*time.Minute)) {
		t.Errorf("next_nudge_at was changed or cleared: %v", stored)
	}
}

// TestLoopScan_SkipsDoneAndDismissed: done and dismissed commitments are ignored.
func TestLoopScan_SkipsDoneAndDismissed(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedCommitmentTenant(t, pool)
	runID := insertTestRun(t, tenant, "concierge-terminal")

	_, c1 := insertRawCommitmentPool(t, tenant, "done", "now", nil)
	_, c2 := insertRawCommitmentPool(t, tenant, "dismissed", "now", nil)
	defer c1()
	defer c2()

	surfaced, err := scanAndNudgeCommitments(ctx, pool, nopLogger(), tenant, runID)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if surfaced != 0 {
		t.Errorf("surfaced=%d for done/dismissed rows, want 0", surfaced)
	}

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM journal_events WHERE run_id = $1 AND kind = 'loop_nudge'`, runID,
	).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("loop_nudge events=%d for terminal rows, want 0", count)
	}
}

// ---------- Pure unit tests: parseLoopManifest ----------

func TestParseLoopManifest_Valid(t *testing.T) {
	raw := `{"type":"loop","name":"daily-checker","goal":"check commitments","tier":"macro","cron":"0 8 * * *","sensors":["commitments"],"actions":["nudge"],"trust":"ask"}`
	m, err := parseLoopManifest(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if m.Name != "daily-checker" {
		t.Errorf("name=%q, want 'daily-checker'", m.Name)
	}
	if m.Tier != "macro" {
		t.Errorf("tier=%q, want 'macro'", m.Tier)
	}
	if m.Type != "loop" {
		t.Errorf("type=%q, want 'loop'", m.Type)
	}
	if len(m.Sensors) != 1 || m.Sensors[0] != "commitments" {
		t.Errorf("sensors=%v, want [commitments]", m.Sensors)
	}
}

func TestParseLoopManifest_DefaultsApplied(t *testing.T) {
	raw := `{"name":"my-agent","goal":"do things","tier":"meso","cron":"*/45 * * * *","sensors":["commitments"],"actions":["nudge"]}`
	m, err := parseLoopManifest(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if m.Type != "loop" {
		t.Errorf("type default: got %q, want 'loop'", m.Type)
	}
	if m.Trust != "ask" {
		t.Errorf("trust default: got %q, want 'ask'", m.Trust)
	}
}

func TestParseLoopManifest_MissingName(t *testing.T) {
	raw := `{"type":"loop","goal":"x","tier":"meso","cron":"*/45 * * * *","sensors":[],"actions":[],"trust":"ask"}`
	_, err := parseLoopManifest(raw)
	if err == nil {
		t.Error("expected error for missing name, got nil")
	}
}

func TestParseLoopManifest_CodeFence(t *testing.T) {
	raw := "```json\n{\"type\":\"loop\",\"name\":\"fence-test\",\"goal\":\"g\",\"tier\":\"meso\",\"cron\":\"*/45 * * * *\",\"sensors\":[],\"actions\":[],\"trust\":\"ask\"}\n```"
	m, err := parseLoopManifest(raw)
	if err != nil {
		t.Fatalf("parse with fence: %v", err)
	}
	if m.Name != "fence-test" {
		t.Errorf("name=%q, want 'fence-test'", m.Name)
	}
}

// ---------- Loop-run finalization tests ----------
//
// These tests verify the bug-fix: loop runs must be finalized to
// status='succeeded' with correct token/cost attribution, and
// re-driven runs must not re-execute the body (idempotency guard).

// insertLoopTestRun creates an agent with a loop manifest and an in-progress
// run. Returns the run ID. Cleans up agent/version/run on t.Cleanup.
func insertLoopTestRun(t *testing.T, tenantID, agentName, role string) string {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'finalize-test')
		ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insertLoopTestRun: insert agent: %v", err)
	}

	manifestJSON, _ := json.Marshal(LoopManifest{
		Type:  "loop",
		Role:  role,
		Name:  agentName,
		Tier:  "meso",
		Trust: "ask",
	})
	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'loop-fin-v1', decode(md5($2), 'hex'), 'local://test', $3::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
		RETURNING id
	`, agentID, agentName+"-fin", string(manifestJSON)).Scan(&versionID); err != nil {
		t.Fatalf("insertLoopTestRun: insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("insertLoopTestRun: promote version: %v", err)
	}

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'running', 'schedule', '{}'::jsonb)
		RETURNING id
	`, tenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insertLoopTestRun: insert run: %v", err)
	}

	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DELETE FROM journal_events WHERE run_id = $1", runID)
		_, _ = pool.Exec(ctx, "DELETE FROM runs WHERE id = $1", runID)
		_, _ = pool.Exec(ctx, "UPDATE agents SET current_version_id = NULL WHERE id = $1", agentID)
		_, _ = pool.Exec(ctx, "DELETE FROM agent_versions WHERE id = $1", versionID)
		_, _ = pool.Exec(ctx, "DELETE FROM agents WHERE id = $1", agentID)
	})
	return runID
}

// TestLoopRunFinalize_Succeeded: a chief_of_staff loop run (which calls
// completeFn) is finalized with status='succeeded', tokens > 0, cost > 0,
// and RecordUsage writes to agent_usage_daily.
func TestLoopRunFinalize_Succeeded(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	agentName := "cos-finalize-" + tenant[:8]
	runID := insertLoopTestRun(t, tenant, agentName, "chief_of_staff")

	// Stub completeFn with known usage so we can assert attribution.
	const stubIn int64 = 100
	const stubOut int64 = 50
	const stubCost = 0.001
	var lu loopUsage
	completeFn := func(ctx context.Context, _ string, _, _ string) (string, error) {
		lu.TokensIn += stubIn
		lu.TokensOut += stubOut
		lu.CostUsd += stubCost
		return "good morning brief", nil
	}

	if !runLoopAgentIfPresent(ctx, pool, nopLogger(), tenant, agentName, runID, completeFn) {
		t.Fatal("expected runLoopAgentIfPresent to return true")
	}
	finalizeLoopRun(ctx, pool, nopLogger(), runID, tenant, agentName, lu)

	var status string
	var tokensIn, tokensOut int64
	var costUsd float64
	if err := pool.QueryRow(ctx, `
		SELECT status, COALESCE(tokens_in,0), COALESCE(tokens_out,0), COALESCE(cost_usd,0)
		FROM runs WHERE id = $1
	`, runID).Scan(&status, &tokensIn, &tokensOut, &costUsd); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if status != "succeeded" {
		t.Errorf("status=%q, want 'succeeded'", status)
	}
	if tokensIn != stubIn {
		t.Errorf("tokens_in=%d, want %d", tokensIn, stubIn)
	}
	if tokensOut != stubOut {
		t.Errorf("tokens_out=%d, want %d", tokensOut, stubOut)
	}
	if costUsd != stubCost {
		t.Errorf("cost_usd=%f, want %f", costUsd, stubCost)
	}

	// RecordUsage must have updated agent_usage_daily.
	var dailyCost float64
	_ = pool.QueryRow(ctx, `
		SELECT COALESCE(cost_usd,0) FROM agent_usage_daily
		WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = CURRENT_DATE
	`, tenant, agentName).Scan(&dailyCost)
	if dailyCost == 0 {
		t.Error("agent_usage_daily.cost_usd=0 — RecordUsage was not called")
	}
}

// TestLoopRunFinalize_NoLLM: when completeFn is nil (no LLM configured),
// the run is still finalized to 'succeeded' with zero tokens/cost.
func TestLoopRunFinalize_NoLLM(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	agentName := "cos-nollm-" + tenant[:8]
	runID := insertLoopTestRun(t, tenant, agentName, "chief_of_staff")

	if !runLoopAgentIfPresent(ctx, pool, nopLogger(), tenant, agentName, runID, nil) {
		t.Fatal("expected runLoopAgentIfPresent to return true")
	}
	finalizeLoopRun(ctx, pool, nopLogger(), runID, tenant, agentName, loopUsage{})

	var status string
	var tokensIn, tokensOut int64
	var costUsd float64
	if err := pool.QueryRow(ctx, `
		SELECT status, COALESCE(tokens_in,0), COALESCE(tokens_out,0), COALESCE(cost_usd,0)
		FROM runs WHERE id = $1
	`, runID).Scan(&status, &tokensIn, &tokensOut, &costUsd); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if status != "succeeded" {
		t.Errorf("status=%q, want 'succeeded'", status)
	}
	if tokensIn != 0 || tokensOut != 0 || costUsd != 0 {
		t.Errorf("expected zero tokens/cost for no-LLM run, got in=%d out=%d cost=%f", tokensIn, tokensOut, costUsd)
	}
}

// TestLoopRunFinalize_Idempotent: a second call to runLoopAgentIfPresent on a
// run that already has a loop_complete journal event must return true immediately
// without re-executing the loop body (LLM call count stays unchanged).
func TestLoopRunFinalize_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	agentName := "cos-idem-" + tenant[:8]
	runID := insertLoopTestRun(t, tenant, agentName, "chief_of_staff")

	var callCount int
	completeFn := func(ctx context.Context, _ string, _, _ string) (string, error) {
		callCount++
		return "morning brief", nil
	}

	// First call: body runs, loop_complete event is written.
	if !runLoopAgentIfPresent(ctx, pool, nopLogger(), tenant, agentName, runID, completeFn) {
		t.Fatal("first call: expected true")
	}
	after1 := callCount
	if after1 == 0 {
		t.Fatal("completeFn was never called on the first dispatch")
	}

	// Second call (simulates crash-recovery re-drive): idempotency guard fires.
	if !runLoopAgentIfPresent(ctx, pool, nopLogger(), tenant, agentName, runID, completeFn) {
		t.Fatal("second call: expected true")
	}
	if callCount != after1 {
		t.Errorf("idempotency guard failed: completeFn called again (count=%d, want %d)", callCount, after1)
	}
}
