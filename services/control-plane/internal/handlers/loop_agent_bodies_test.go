package handlers

// Tests for the three new loop-agent bodies introduced in Stage 3 Part C.
//
// Pure unit tests (no DB):
//   TestIsPromoEmail_*
//
// DB-backed tests (skip when DATABASE_URL unset):
//   TestChiefOfStaffBrief_EmitsEvent   — stub LLM, assert daily_brief journal event
//   TestChiefOfStaffBrief_LLMFallback  — LLM error → template brief still emitted
//   TestProcessInboxMessages_*         — fake messages; commitment creation + cursor + dedup
//   TestGmailCursor_CrossTenant        — cursor for tenant A is invisible to tenant B
//   TestRelationshipKeeper_*           — stale/fresh people; idempotent weekly dedup

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------- Pure unit tests: isPromoEmail ----------

func TestIsPromoEmail_NoReply(t *testing.T) {
	msg := GmailMessage{From: "noreply@example.com", Subject: "Your order shipped"}
	if !isPromoEmail(msg) {
		t.Error("expected noreply sender to be promo")
	}
}

func TestIsPromoEmail_Newsletter(t *testing.T) {
	msg := GmailMessage{From: "news@company.com", Subject: "Weekly digest: top stories"}
	if !isPromoEmail(msg) {
		t.Error("expected 'weekly digest' subject to be promo")
	}
}

func TestIsPromoEmail_SaleSubject(t *testing.T) {
	msg := GmailMessage{From: "store@shop.com", Subject: "30% off — sale ends tonight"}
	if !isPromoEmail(msg) {
		t.Error("expected '% off' subject to be promo")
	}
}

func TestIsPromoEmail_RealEmail(t *testing.T) {
	msg := GmailMessage{From: "alice@example.com", Subject: "Lunch tomorrow?"}
	if isPromoEmail(msg) {
		t.Error("real personal email should not be promo")
	}
}

func TestIsPromoEmail_BillEmail(t *testing.T) {
	msg := GmailMessage{From: "billing@bank.com", Subject: "Your invoice is ready"}
	if isPromoEmail(msg) {
		t.Error("billing email (no promo signals) should not be promo")
	}
}

// ---------- Helpers ----------

// seedBodyTenant creates a fresh test tenant + cleanup.
// Same pattern as seedCommitmentTenant in commitments_test.go.
func seedBodyTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "body-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Body Test', 'personal', 'ns-body-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM commitments        WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM life_events        WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM people             WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM gmail_poll_cursors WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants            WHERE id        = $1::uuid", id)
	})
	return id
}

// insertBodyRun creates a minimal run row for the given tenant/agent.
// Returns runID; cleans up journal_events + the run on t.Cleanup.
func insertBodyRun(t *testing.T, pool *pgxpool.Pool, tenantID, agentName string) string {
	t.Helper()
	ctx := context.Background()
	agentID, versionID := ensureAgentAndVersion(t, tenantID, agentName)
	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'running', 'schedule', '{}'::jsonb)
		RETURNING id
	`, tenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insertBodyRun: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM journal_events WHERE run_id = $1", runID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM runs WHERE id = $1", runID)
	})
	return runID
}

// ---------- TestChiefOfStaffBrief ----------

// TestChiefOfStaffBrief_EmitsEvent seeds 1 commitment + 1 life event, calls
// runChiefOfStaffBrief with a stub LLM that returns canned text, and asserts
// a daily_brief journal event is emitted with correct counts.
func TestChiefOfStaffBrief_EmitsEvent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "cos-test-llm")

	// Seed an open commitment.
	if _, err := pool.Exec(ctx, `
		INSERT INTO commitments (tenant_id, title, source, status, tier, urgency)
		VALUES ($1, 'File quarterly taxes', 'self', 'open', 'macro', 'soon')
	`, tenant); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	// Seed a recent life event.
	if _, err := pool.Exec(ctx, `
		INSERT INTO life_events (tenant_id, kind, channel, summary, created_at)
		VALUES ($1, 'bill', 'whatsapp', 'Electricity bill due', now() - interval '2 hours')
	`, tenant); err != nil {
		t.Fatalf("seed life event: %v", err)
	}

	// Stub LLM returns a canned brief.
	stubBrief := "Good morning! You have 1 open item: file quarterly taxes. 1 life event noted."
	completeFn := func(_ context.Context, _, _, _ string) (string, error) {
		return stubBrief, nil
	}

	briefChars, err := runChiefOfStaffBrief(ctx, pool, nopLogger(), tenant, runID, completeFn)
	if err != nil {
		t.Fatalf("runChiefOfStaffBrief: %v", err)
	}
	if briefChars != len(stubBrief) {
		t.Errorf("briefChars=%d, want %d", briefChars, len(stubBrief))
	}

	// Assert daily_brief journal event was emitted.
	var payload []byte
	if err := pool.QueryRow(ctx,
		`SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'daily_brief'`, runID,
	).Scan(&payload); err != nil {
		t.Fatalf("read daily_brief event: %v", err)
	}

	var p map[string]any
	if err := json.Unmarshal(payload, &p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if p["commitmentCount"].(float64) != 1 {
		t.Errorf("commitmentCount=%v, want 1", p["commitmentCount"])
	}
	if p["lifeEventCount"].(float64) != 1 {
		t.Errorf("lifeEventCount=%v, want 1", p["lifeEventCount"])
	}
	if p["text"] != stubBrief {
		t.Errorf("text=%q, want %q", p["text"], stubBrief)
	}
}

// TestChiefOfStaffBrief_LLMFallback verifies that when the LLM call returns
// an error, the function still emits a daily_brief event using the template.
func TestChiefOfStaffBrief_LLMFallback(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "cos-test-fallback")

	// Seed one commitment so the template has content.
	if _, err := pool.Exec(ctx, `
		INSERT INTO commitments (tenant_id, title, source, status, tier, urgency)
		VALUES ($1, 'Renew passport', 'self', 'open', 'mega', 'now')
	`, tenant); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	// LLM always fails.
	failFn := func(_ context.Context, _, _, _ string) (string, error) {
		return "", fmt.Errorf("LLM unavailable")
	}

	briefChars, err := runChiefOfStaffBrief(ctx, pool, nopLogger(), tenant, runID, failFn)
	if err != nil {
		t.Fatalf("runChiefOfStaffBrief should not error on LLM failure: %v", err)
	}
	if briefChars == 0 {
		t.Error("briefChars=0; template brief should have produced text")
	}

	// Event must still be present.
	var payload []byte
	if err := pool.QueryRow(ctx,
		`SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'daily_brief'`, runID,
	).Scan(&payload); err != nil {
		t.Fatalf("daily_brief event not emitted on LLM failure: %v", err)
	}

	var p map[string]any
	_ = json.Unmarshal(payload, &p)
	text, _ := p["text"].(string)
	if text == "" {
		t.Error("daily_brief payload.text is empty on LLM fallback")
	}
}

// ---------- TestProcessInboxMessages ----------

// TestProcessInboxMessages_CreatesCommitment sends 2 messages (1 promo, 1
// real bill), asserts only the real one becomes a commitment.
func TestProcessInboxMessages_CreatesCommitment(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "inbox-test-create")

	msgs := []GmailMessage{
		// Promo — should be skipped.
		{ID: "msg-promo-1", InternalDate: "1750000000001",
			From: "newsletter@deals.com", Subject: "50% off this weekend!", Snippet: "Big sale"},
		// Actionable bill — should create a commitment.
		{ID: "msg-bill-1", InternalDate: "1750000000002",
			From: "billing@bank.com", Subject: "Your invoice #1234 is ready", Snippet: "Payment due"},
	}

	newN, createdM, err := processInboxMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", nil)
	if err != nil {
		t.Fatalf("processInboxMessages: %v", err)
	}
	if newN != 2 {
		t.Errorf("newN=%d, want 2 (both are new)", newN)
	}
	if createdM != 1 {
		t.Errorf("createdM=%d, want 1 (promo skipped)", createdM)
	}

	// Assert the commitment exists with idempotency key = Gmail message ID.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM commitments WHERE tenant_id = $1 AND idempotency_key = 'msg-bill-1'`,
		tenant,
	).Scan(&count); err != nil {
		t.Fatalf("count commitment: %v", err)
	}
	if count != 1 {
		t.Errorf("commitment count=%d, want 1", count)
	}
}

// TestProcessInboxMessages_Idempotent runs the same messages twice and asserts
// the second run creates 0 new commitments (ON CONFLICT DO NOTHING guard).
func TestProcessInboxMessages_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "inbox-test-idem")

	msgs := []GmailMessage{
		{ID: "msg-idem-1", InternalDate: "1750000001000",
			From: "boss@company.com", Subject: "Action required: Q3 review", Snippet: "Please review"},
	}

	_, created1, _ := processInboxMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", nil)
	if created1 != 1 {
		t.Fatalf("first run: createdM=%d, want 1", created1)
	}

	// Second run with same messages and empty cursor (simulates re-run scenario).
	// Cursor was advanced by first run; but here we pass empty cursor to force
	// re-processing — the DB-level idempotency key must block duplicates.
	_, created2, _ := processInboxMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", nil)
	if created2 != 0 {
		t.Errorf("second run: createdM=%d, want 0 (idempotency guard)", created2)
	}
}

// TestProcessInboxMessages_AdvancesCursor asserts the cursor is advanced to
// the max internalDate of the batch.
func TestProcessInboxMessages_AdvancesCursor(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "inbox-test-cursor")

	msgs := []GmailMessage{
		{ID: "msg-c1", InternalDate: "1750000002000", From: "a@b.com", Subject: "First"},
		{ID: "msg-c2", InternalDate: "1750000003000", From: "a@b.com", Subject: "Second"},
	}

	_, _, err := processInboxMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", nil)
	if err != nil {
		t.Fatalf("processInboxMessages: %v", err)
	}

	var cursor string
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1`,
		tenant,
	).Scan(&cursor); err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if cursor != "1750000003000" {
		t.Errorf("cursor=%q, want '1750000003000'", cursor)
	}
}

// TestProcessInboxMessages_SkipsBeforeCursor asserts messages at or before the
// stored cursor are not processed (newN=0).
func TestProcessInboxMessages_SkipsBeforeCursor(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "inbox-test-hwm")

	msgs := []GmailMessage{
		{ID: "msg-old", InternalDate: "1750000000100", From: "x@y.com", Subject: "Old"},
	}
	// Cursor is already past these messages.
	newN, createdM, _ := processInboxMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "1750000000200", nil)
	if newN != 0 {
		t.Errorf("newN=%d, want 0 (all before cursor)", newN)
	}
	if createdM != 0 {
		t.Errorf("createdM=%d, want 0", createdM)
	}
}

// TestGmailCursor_CrossTenant asserts that cursor written for tenant A is not
// visible under tenant B's tenant_id filter (isolation at the query level).
func TestGmailCursor_CrossTenant(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenantA := seedBodyTenant(t, pool)
	tenantB := seedBodyTenant(t, pool)
	runA := insertBodyRun(t, pool, tenantA, "cursor-ct-a")

	// Write a cursor for tenant A.
	msgs := []GmailMessage{
		{ID: "ct-msg-1", InternalDate: "1750000010000", From: "a@a.com", Subject: "Task"},
	}
	_, _, _ = processInboxMessages(ctx, pool, nopLogger(), tenantA, runA, msgs, "", nil)

	// Cursor must exist for tenant A.
	var cursorA string
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1`,
		tenantA,
	).Scan(&cursorA); err != nil || cursorA == "" {
		t.Fatalf("tenant A cursor missing or empty: err=%v cursor=%q", err, cursorA)
	}

	// Tenant B must have no cursor row.
	var cursorB string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1`,
		tenantB,
	).Scan(&cursorB)
	if cursorB != "" {
		t.Errorf("cross-tenant leak: tenant B sees cursor=%q from tenant A", cursorB)
	}
}

// ---------- TestRelationshipKeeper ----------

// TestRelationshipKeeper_SurfacesStale seeds two people: one stale (>21d),
// one fresh. Asserts a reach-out commitment for the stale one only.
func TestRelationshipKeeper_SurfacesStale(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "relkeeper-test-stale")

	// Stale labeled contact (updated 30 days ago).
	staleID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO people (id, tenant_id, display_name, relationship, is_owner, updated_at)
		VALUES ($1::uuid, $2::uuid, 'Old Friend', 'college friend', false, now() - interval '30 days')
	`, staleID, tenant); err != nil {
		t.Fatalf("seed stale person: %v", err)
	}

	// Fresh labeled contact (updated 1 day ago) — should be skipped.
	if _, err := pool.Exec(ctx, `
		INSERT INTO people (tenant_id, display_name, relationship, is_owner, updated_at)
		VALUES ($1::uuid, 'New Friend', 'work friend', false, now() - interval '1 day')
	`, tenant); err != nil {
		t.Fatalf("seed fresh person: %v", err)
	}

	// Unlabeled contact (should be skipped regardless of age).
	if _, err := pool.Exec(ctx, `
		INSERT INTO people (tenant_id, display_name, relationship, is_owner, updated_at)
		VALUES ($1::uuid, 'Unknown', '', false, now() - interval '60 days')
	`, tenant); err != nil {
		t.Fatalf("seed unlabeled person: %v", err)
	}

	surfaced, err := runRelationshipKeeper(ctx, pool, nopLogger(), tenant, runID, nil)
	if err != nil {
		t.Fatalf("runRelationshipKeeper: %v", err)
	}
	if surfaced != 1 {
		t.Errorf("surfaced=%d, want 1", surfaced)
	}

	// Assert commitment title.
	var title string
	if err := pool.QueryRow(ctx, `
		SELECT title FROM commitments WHERE tenant_id = $1 AND kind = 'relationship'
	`, tenant).Scan(&title); err != nil {
		t.Fatalf("read commitment: %v", err)
	}
	if title != "Reach out to Old Friend" {
		t.Errorf("title=%q, want 'Reach out to Old Friend'", title)
	}

	// Assert relationship_swept journal event.
	var payload []byte
	if err := pool.QueryRow(ctx,
		`SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'relationship_swept'`, runID,
	).Scan(&payload); err != nil {
		t.Fatalf("relationship_swept event: %v", err)
	}
	var p map[string]any
	_ = json.Unmarshal(payload, &p)
	if p["surfaced"].(float64) != 1 {
		t.Errorf("event.surfaced=%v, want 1", p["surfaced"])
	}
}

// TestRelationshipKeeper_Idempotent verifies that running twice in the same
// ISO week creates no duplicate commitments.
func TestRelationshipKeeper_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID1 := insertBodyRun(t, pool, tenant, "relkeeper-idem-1")
	runID2 := insertBodyRun(t, pool, tenant, "relkeeper-idem-2")

	// Stale labeled contact.
	if _, err := pool.Exec(ctx, `
		INSERT INTO people (tenant_id, display_name, relationship, is_owner, updated_at)
		VALUES ($1::uuid, 'VIP Contact', 'mentor', false, now() - interval '25 days')
	`, tenant); err != nil {
		t.Fatalf("seed person: %v", err)
	}

	s1, err := runRelationshipKeeper(ctx, pool, nopLogger(), tenant, runID1, nil)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if s1 != 1 {
		t.Fatalf("first run surfaced=%d, want 1", s1)
	}

	s2, err := runRelationshipKeeper(ctx, pool, nopLogger(), tenant, runID2, nil)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if s2 != 0 {
		t.Errorf("second run surfaced=%d, want 0 (idempotent within ISO week)", s2)
	}

	// Exactly 1 commitment in the DB, not 2.
	var count int
	_ = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM commitments WHERE tenant_id = $1 AND kind = 'relationship'`,
		tenant,
	).Scan(&count)
	if count != 1 {
		t.Errorf("commitment count=%d, want 1", count)
	}
}

// TestRelationshipKeeper_NoOp verifies graceful exit when no people exist.
func TestRelationshipKeeper_NoOp(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "relkeeper-noop")

	surfaced, err := runRelationshipKeeper(ctx, pool, nopLogger(), tenant, runID, nil)
	if err != nil {
		t.Fatalf("runRelationshipKeeper on empty tenant: %v", err)
	}
	if surfaced != 0 {
		t.Errorf("surfaced=%d, want 0", surfaced)
	}

	// Journal event still emitted.
	var count int
	_ = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM journal_events WHERE run_id = $1 AND kind = 'relationship_swept'`,
		runID,
	).Scan(&count)
	if count != 1 {
		t.Errorf("relationship_swept event count=%d, want 1", count)
	}
}

// TestLoopDispatch_Role asserts that runLoopAgentIfPresent dispatches by Role
// and writes the role-appropriate loop_complete payload.
func TestLoopDispatch_Role(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	agentName := "dispatch-test-cos-" + uuid.NewString()[:8]

	// Build agent + version with a loop manifest (chief_of_staff role).
	// Cannot use ensureAgentAndVersion: it doesn't set current_version_id
	// and uses a non-loop manifest. Replicate SeedConciergeAgent's pattern.
	manifest := LoopManifest{
		Type: "loop",
		Role: "chief_of_staff",
		Name: agentName,
		Goal: "test dispatch",
		Tier: "macro",
		Cron: "0 8 * * *",
	}
	mJSON, _ := json.Marshal(manifest)

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1::uuid, $2, 'dispatch test')
		ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, tenant, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'loop-v1', decode(md5($2), 'hex'), 'local://loop', $3::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
		RETURNING id
	`, agentID, agentName+"-loop-v1", string(mJSON)).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID,
	); err != nil {
		t.Fatalf("promote: %v", err)
	}

	// Insert a run against this agent.
	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1::uuid, $2, $3, 'running', 'schedule', '{}'::jsonb)
		RETURNING id
	`, tenant, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM journal_events WHERE run_id = $1", runID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM runs WHERE id = $1", runID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM agent_versions WHERE agent_id = $1", agentID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM agents WHERE id = $1", agentID)
	})

	stubFn := func(_ context.Context, _, _, _ string) (string, error) {
		return "Today you have 0 items.", nil
	}

	dispatched := runLoopAgentIfPresent(ctx, pool, nopLogger(), tenant, agentName, runID, stubFn)
	if !dispatched {
		t.Fatal("runLoopAgentIfPresent returned false — manifest not detected as loop type")
	}

	// loop_complete event must carry brief_chars (chief_of_staff output key).
	var payload []byte
	if err := pool.QueryRow(ctx,
		`SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'loop_complete'`, runID,
	).Scan(&payload); err != nil {
		t.Fatalf("loop_complete event: %v", err)
	}
	var p map[string]any
	_ = json.Unmarshal(payload, &p)
	if _, ok := p["brief_chars"]; !ok {
		t.Errorf("loop_complete payload missing 'brief_chars' for chief_of_staff: %v", p)
	}
}

// ---------- TestFinancialSentinel ----------

// seedBill inserts a life_event with kind='bill' for the tenant.
func seedBill(t *testing.T, pool *pgxpool.Pool, tenantID, payee string, amount float64, daysAgo int) {
	t.Helper()
	ctx := context.Background()
	fieldsJSON := fmt.Sprintf(`{"payee":%q,"amount":%g}`, payee, amount)
	if _, err := pool.Exec(ctx, `
		INSERT INTO life_events (tenant_id, kind, channel, summary, fields, created_at)
		VALUES ($1::uuid, 'bill', 'test', 'Test bill', $2::jsonb, now() - ($3 * interval '1 day'))
	`, tenantID, fieldsJSON, daysAgo); err != nil {
		t.Fatalf("seedBill: %v", err)
	}
}

// TestFinancialSentinel_DetectsHike seeds two bills for the same payee
// ($100 old, $130 new = 30% hike, $30 absolute) and asserts one commitment is
// created with the payee + both amounts in the title.
func TestFinancialSentinel_DetectsHike(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "finsentinel-hike")

	// Older bill first (higher daysAgo = earlier), newer bill second.
	seedBill(t, pool, tenant, "Netflix", 100.00, 45)
	seedBill(t, pool, tenant, "Netflix", 130.00, 5)

	hikesN, err := runFinancialSentinel(ctx, pool, nopLogger(), tenant, runID, nil)
	if err != nil {
		t.Fatalf("runFinancialSentinel: %v", err)
	}
	if hikesN != 1 {
		t.Errorf("hikesN=%d, want 1", hikesN)
	}

	// Assert commitment title contains the payee and both amounts.
	var title string
	if err := pool.QueryRow(ctx, `
		SELECT title FROM commitments
		WHERE tenant_id = $1::uuid AND kind = 'finance'
	`, tenant).Scan(&title); err != nil {
		t.Fatalf("read commitment: %v", err)
	}
	if !strings.Contains(title, "Netflix") {
		t.Errorf("title=%q — missing payee", title)
	}
	if !strings.Contains(title, "130.00") || !strings.Contains(title, "100.00") {
		t.Errorf("title=%q — missing amount(s)", title)
	}

	// Assert financial_swept journal event was emitted.
	var payload []byte
	if err := pool.QueryRow(ctx, `
		SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'financial_swept'
	`, runID).Scan(&payload); err != nil {
		t.Fatalf("financial_swept event: %v", err)
	}
	var p map[string]any
	_ = json.Unmarshal(payload, &p)
	if p["hikes"].(float64) != 1 {
		t.Errorf("event.hikes=%v, want 1", p["hikes"])
	}
}

// TestFinancialSentinel_Idempotent verifies that running twice in the same
// calendar month creates no duplicate commitment.
func TestFinancialSentinel_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID1 := insertBodyRun(t, pool, tenant, "finsentinel-idem-1")
	runID2 := insertBodyRun(t, pool, tenant, "finsentinel-idem-2")

	seedBill(t, pool, tenant, "Hulu", 100.00, 50)
	seedBill(t, pool, tenant, "Hulu", 125.00, 3)

	h1, err := runFinancialSentinel(ctx, pool, nopLogger(), tenant, runID1, nil)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if h1 != 1 {
		t.Fatalf("first run hikesN=%d, want 1", h1)
	}

	h2, err := runFinancialSentinel(ctx, pool, nopLogger(), tenant, runID2, nil)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if h2 != 0 {
		t.Errorf("second run hikesN=%d, want 0 (idempotent within month)", h2)
	}

	// Exactly 1 commitment in the DB, not 2.
	var count int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM commitments WHERE tenant_id = $1::uuid AND kind = 'finance'
	`, tenant).Scan(&count)
	if count != 1 {
		t.Errorf("commitment count=%d, want 1", count)
	}
}

// TestFinancialSentinel_BelowThreshold verifies that a small increase (3%,
// below the 10% threshold) creates no commitment.
func TestFinancialSentinel_BelowThreshold(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "finsentinel-threshold")

	seedBill(t, pool, tenant, "Spotify", 100.00, 45)
	seedBill(t, pool, tenant, "Spotify", 103.00, 5) // +3%, +$3 — below both thresholds

	hikesN, err := runFinancialSentinel(ctx, pool, nopLogger(), tenant, runID, nil)
	if err != nil {
		t.Fatalf("runFinancialSentinel: %v", err)
	}
	if hikesN != 0 {
		t.Errorf("hikesN=%d, want 0 (below threshold)", hikesN)
	}

	var count int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM commitments WHERE tenant_id = $1::uuid AND kind = 'finance'
	`, tenant).Scan(&count)
	if count != 0 {
		t.Errorf("commitment count=%d, want 0", count)
	}
}

// TestFinancialSentinel_NoBills verifies graceful no-op when there are no bills.
func TestFinancialSentinel_NoBills(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "finsentinel-nobills")

	hikesN, err := runFinancialSentinel(ctx, pool, nopLogger(), tenant, runID, nil)
	if err != nil {
		t.Fatalf("runFinancialSentinel on empty tenant: %v", err)
	}
	if hikesN != 0 {
		t.Errorf("hikesN=%d, want 0", hikesN)
	}

	// financial_swept event still emitted.
	var count int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM journal_events WHERE run_id = $1 AND kind = 'financial_swept'
	`, runID).Scan(&count)
	if count != 1 {
		t.Errorf("financial_swept event count=%d, want 1", count)
	}
}

// ---------- TestDomainCoach ----------

// seedDomainRecord inserts a domain_records row directly (bypassing the handler).
// fields_encrypted is stored as plain JSON because secrets.EncryptString is a
// pass-through in tests (no LANTERN_CREDENTIAL_KEY set).
func seedDomainRecord(t *testing.T, pool *pgxpool.Pool, tenantID, domain, kind, title, fields string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO domain_records (tenant_id, domain, kind, title, fields_encrypted, source)
		VALUES ($1::uuid, $2, $3, $4, $5, 'gmail')
	`, tenantID, domain, kind, title, fields); err != nil {
		t.Fatalf("seedDomainRecord: %v", err)
	}
}

// seedDomainObligation inserts a commitment with source=domain and status='open'.
func seedDomainObligation(t *testing.T, pool *pgxpool.Pool, tenantID, domain, title string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status)
		VALUES ($1::uuid, $2, $3, $3, 'meso', 'normal', 'open')
	`, tenantID, title, domain); err != nil {
		t.Fatalf("seedDomainObligation: %v", err)
	}
}

// TestDomainCoach_CreatesCommitment seeds 2 health records + 1 open obligation,
// stubs the LLM, and asserts a single coaching commitment (kind='coaching') plus
// a domain_coached journal event are created.
func TestDomainCoach_CreatesCommitment(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM domain_records WHERE tenant_id = $1::uuid", tenant)
	})
	runID := insertBodyRun(t, pool, tenant, "coach-test-create")

	// Seed health records (fields stored as plain JSON — pass-through in test).
	seedDomainRecord(t, pool, tenant, "health", "lab_result", "Cholesterol panel", `{"value":"195 mg/dL","status":"normal"}`)
	seedDomainRecord(t, pool, tenant, "health", "appointment", "Annual physical", `{"date":"2026-05-10"}`)

	// Seed one open obligation from the health domain.
	seedDomainObligation(t, pool, tenant, "health", "Schedule follow-up with PCP")

	stubBrief := "Your cholesterol is normal. Annual physical done. Schedule the PCP follow-up soon."
	completeFn := func(_ context.Context, _, _, _ string) (string, error) {
		return stubBrief, nil
	}

	manifest := LoopManifest{Role: "domain_tracker", Domain: "health", Coach: true}
	err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID, manifest, completeFn)
	if err != nil {
		t.Fatalf("runDomainCoach: %v", err)
	}

	// Assert coaching commitment exists with kind='coaching'.
	var title, kind string
	if err := pool.QueryRow(ctx, `
		SELECT title, kind FROM commitments
		WHERE tenant_id = $1::uuid AND source = 'health' AND kind = 'coaching'
	`, tenant).Scan(&title, &kind); err != nil {
		t.Fatalf("read coaching commitment: %v", err)
	}
	if title != stubBrief {
		t.Errorf("title=%q, want %q", title, stubBrief)
	}
	if kind != "coaching" {
		t.Errorf("kind=%q, want 'coaching'", kind)
	}

	// Assert domain_coached journal event emitted (seq=2).
	var payload []byte
	if err := pool.QueryRow(ctx,
		`SELECT payload FROM journal_events WHERE run_id = $1 AND kind = 'domain_coached'`, runID,
	).Scan(&payload); err != nil {
		t.Fatalf("read domain_coached event: %v", err)
	}
	var p map[string]any
	_ = json.Unmarshal(payload, &p)
	if p["domain"] != "health" {
		t.Errorf("event domain=%v, want 'health'", p["domain"])
	}
	if int(p["brief_chars"].(float64)) != len(stubBrief) {
		t.Errorf("event brief_chars=%v, want %d", p["brief_chars"], len(stubBrief))
	}
}

// TestDomainCoach_Idempotent verifies that running twice in the same ISO week
// produces exactly ONE commitment row (the second run updates the title, not
// inserts a duplicate).
func TestDomainCoach_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM domain_records WHERE tenant_id = $1::uuid", tenant)
	})
	runID1 := insertBodyRun(t, pool, tenant, "coach-idem-1")
	runID2 := insertBodyRun(t, pool, tenant, "coach-idem-2")

	seedDomainRecord(t, pool, tenant, "vehicle", "service", "Oil change", `{"mileage":"35000"}`)

	call := 0
	briefs := []string{"First brief.", "Updated brief."}
	completeFn := func(_ context.Context, _, _, _ string) (string, error) {
		b := briefs[call]
		if call < len(briefs)-1 {
			call++
		}
		return b, nil
	}

	manifest := LoopManifest{Role: "domain_tracker", Domain: "vehicle", Coach: true}

	if err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID1, manifest, completeFn); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID2, manifest, completeFn); err != nil {
		t.Fatalf("second run: %v", err)
	}

	// Exactly 1 commitment row in the DB.
	var count int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM commitments
		WHERE tenant_id = $1::uuid AND source = 'vehicle' AND kind = 'coaching'
	`, tenant).Scan(&count)
	if count != 1 {
		t.Errorf("commitment count=%d, want 1 (idempotent within ISO week)", count)
	}

	// Title updated to the second brief.
	var title string
	_ = pool.QueryRow(ctx, `
		SELECT title FROM commitments
		WHERE tenant_id = $1::uuid AND source = 'vehicle' AND kind = 'coaching'
	`, tenant).Scan(&title)
	if title != "Updated brief." {
		t.Errorf("title=%q, want 'Updated brief.' (second run should update)", title)
	}
}

// TestDomainCoach_LLMFallback verifies that when the LLM fails the function
// still creates a commitment using the deterministic template brief.
func TestDomainCoach_LLMFallback(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM domain_records WHERE tenant_id = $1::uuid", tenant)
	})
	runID := insertBodyRun(t, pool, tenant, "coach-fallback")

	seedDomainRecord(t, pool, tenant, "career", "certification", "AWS Cloud Practitioner", `{}`)
	seedDomainObligation(t, pool, tenant, "career", "Renew AWS cert by Aug 2026")

	failFn := func(_ context.Context, _, _, _ string) (string, error) {
		return "", fmt.Errorf("LLM unavailable")
	}

	manifest := LoopManifest{Role: "domain_tracker", Domain: "career", Coach: true}
	if err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID, manifest, failFn); err != nil {
		t.Fatalf("runDomainCoach should not error on LLM failure: %v", err)
	}

	// Commitment must exist with non-empty title (template brief).
	var title string
	if err := pool.QueryRow(ctx, `
		SELECT title FROM commitments
		WHERE tenant_id = $1::uuid AND source = 'career' AND kind = 'coaching'
	`, tenant).Scan(&title); err != nil {
		t.Fatalf("coaching commitment not created on LLM failure: %v", err)
	}
	if title == "" {
		t.Error("template brief is empty")
	}
	if !strings.Contains(title, "career") {
		t.Errorf("template brief=%q — missing domain name", title)
	}

	// domain_coached journal event still emitted.
	var eventCount int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM journal_events WHERE run_id = $1 AND kind = 'domain_coached'
	`, runID).Scan(&eventCount)
	if eventCount != 1 {
		t.Errorf("domain_coached event count=%d, want 1", eventCount)
	}
}

// TestDomainCoach_EmptyDomain verifies graceful no-op when the domain has
// neither records nor obligations: no commitment created, no journal event.
func TestDomainCoach_EmptyDomain(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "coach-empty")

	manifest := LoopManifest{Role: "domain_tracker", Domain: "health", Coach: true}
	if err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID, manifest, nil); err != nil {
		t.Fatalf("runDomainCoach on empty domain: %v", err)
	}

	var count int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM commitments WHERE tenant_id = $1::uuid AND kind = 'coaching'
	`, tenant).Scan(&count)
	if count != 0 {
		t.Errorf("commitment count=%d, want 0 (empty domain → no-op)", count)
	}

	var eventCount int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM journal_events WHERE run_id = $1 AND kind = 'domain_coached'
	`, runID).Scan(&eventCount)
	if eventCount != 0 {
		t.Errorf("domain_coached event count=%d, want 0 (no-op)", eventCount)
	}
}

// Ensure the test file compiles even when time is unused directly.
var _ = time.Now
