package handlers

// DB-backed tests for the inbox_triage loop-agent body.
//
// Skip when DATABASE_URL is unset (mirrors the rest of the loop-agent test
// suite). Test harness is identical to loop_agent_bodies_test.go.
//
// Cases covered:
//   TestProcessTriageMessages_Action       — action msg → cross_app commitment with sendable draft
//   TestProcessTriageMessages_Fyi          — fyi msg    → email/fyi commitment
//   TestProcessTriageMessages_Noise        — noise msg  → no commitment
//   TestProcessTriageMessages_MalformedLLM — bad JSON   → fallback to fyi (no throw)
//   TestProcessTriageMessages_ActionEmptyBody — action with empty draft → downgraded to fyi
//   TestProcessTriageMessages_Idempotent   — re-run same msgs → 0 new commitments
//   TestProcessTriageMessages_CursorAdvances — cursor advances to max internalDate
//   TestInboxTriageCursor_Separate         — 'inbox-triage' cursor is isolated from 'inbox'

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// stubTriageFn returns a researchCompleteFn that maps msg.ID → canned JSON.
// Unknown IDs fall through to a default fyi response.
func stubTriageFn(byID map[string]string) researchCompleteFn {
	return func(_ context.Context, _, _, userPrompt string) (string, error) {
		for id, resp := range byID {
			// The user prompt contains the snippet; we key by matching a known
			// substring of the message ID that will appear in the snippet field.
			// Tests inject the msg ID into the Snippet for easy keying.
			if len(userPrompt) > 0 {
				for _, part := range []string{id} {
					if len(part) > 0 && contains(userPrompt, part) {
						return resp, nil
					}
				}
			}
		}
		// Default: fyi
		return `{"category":"fyi","reason":"default","replyTo":"","replySubject":"","replyBody":""}`, nil
	}
}

// contains is a simple substring check (avoids importing strings in test).
func contains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && func() bool {
		for i := 0; i <= len(s)-len(sub); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	}()
}

// TestProcessTriageMessages_Action verifies that an "action" verdict with a
// non-empty draft body creates a kind='cross_app' status='suggested' commitment
// whose action_plan unmarshals to a crossAppPlan with ProposedAction.Connector=="gmail",
// Action=="send_message", and non-empty Params["body"].
func TestProcessTriageMessages_Action(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-action")

	msgID := "triage-action-msg-1"
	msgs := []GmailMessage{
		{
			ID:           msgID,
			InternalDate: "1760000000001",
			From:         "boss@company.com",
			Subject:      "Need your sign-off on the proposal",
			Snippet:      msgID, // embed id so stubTriageFn can key on it
		},
	}

	draft := "Hi, I reviewed the proposal and am happy to sign off. Let me know if you need anything else."
	completeFn := stubTriageFn(map[string]string{
		msgID: fmt.Sprintf(`{"category":"action","reason":"needs reply","replyTo":"boss@company.com","replySubject":"Re: Need your sign-off","replyBody":%q}`, draft),
	})

	actionN, fyiN, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("processTriageMessages: %v", err)
	}
	if actionN != 1 {
		t.Errorf("actionN=%d, want 1", actionN)
	}
	if fyiN != 0 {
		t.Errorf("fyiN=%d, want 0", fyiN)
	}

	// Assert commitment exists with correct shape.
	var kind, status, urgency, actionPlanJSON string
	if err := pool.QueryRow(ctx, `
		SELECT kind, status, urgency, action_plan::text
		FROM commitments
		WHERE tenant_id = $1 AND idempotency_key = $2
	`, tenant, msgID).Scan(&kind, &status, &urgency, &actionPlanJSON); err != nil {
		t.Fatalf("read commitment: %v", err)
	}
	if kind != "cross_app" {
		t.Errorf("kind=%q, want 'cross_app'", kind)
	}
	if status != "suggested" {
		t.Errorf("status=%q, want 'suggested'", status)
	}
	if urgency != "soon" {
		t.Errorf("urgency=%q, want 'soon'", urgency)
	}

	// action_plan must unmarshal to a crossAppPlan with correct connector/action/body.
	var plan crossAppPlan
	if err := json.Unmarshal([]byte(actionPlanJSON), &plan); err != nil {
		t.Fatalf("unmarshal action_plan: %v", err)
	}
	if plan.ProposedAction.Connector != "gmail" {
		t.Errorf("ProposedAction.Connector=%q, want 'gmail'", plan.ProposedAction.Connector)
	}
	if plan.ProposedAction.Action != "send_message" {
		t.Errorf("ProposedAction.Action=%q, want 'send_message'", plan.ProposedAction.Action)
	}
	body, _ := plan.ProposedAction.Params["body"].(string)
	if body == "" {
		t.Error("ProposedAction.Params[\"body\"] is empty")
	}
}

// TestProcessTriageMessages_Fyi verifies that a "fyi" verdict creates a
// kind='email' urgency='fyi' commitment and no cross_app commitment.
func TestProcessTriageMessages_Fyi(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-fyi")

	msgID := "triage-fyi-msg-1"
	msgs := []GmailMessage{
		{
			ID:           msgID,
			InternalDate: "1760000001000",
			From:         "updates@service.com",
			Subject:      "Your monthly statement is ready",
			Snippet:      msgID,
		},
	}

	completeFn := stubTriageFn(map[string]string{
		msgID: `{"category":"fyi","reason":"informational","replyTo":"","replySubject":"","replyBody":""}`,
	})

	actionN, fyiN, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("processTriageMessages: %v", err)
	}
	if actionN != 0 {
		t.Errorf("actionN=%d, want 0", actionN)
	}
	if fyiN != 1 {
		t.Errorf("fyiN=%d, want 1", fyiN)
	}

	var kind, urgency string
	if err := pool.QueryRow(ctx, `
		SELECT kind, urgency FROM commitments
		WHERE tenant_id = $1 AND idempotency_key = $2
	`, tenant, msgID).Scan(&kind, &urgency); err != nil {
		t.Fatalf("read commitment: %v", err)
	}
	if kind != "email" {
		t.Errorf("kind=%q, want 'email'", kind)
	}
	if urgency != "fyi" {
		t.Errorf("urgency=%q, want 'fyi'", urgency)
	}
}

// TestProcessTriageMessages_Noise verifies that a "noise" verdict creates
// NO commitment at all.
func TestProcessTriageMessages_Noise(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-noise")

	msgID := "triage-noise-msg-1"
	msgs := []GmailMessage{
		{
			ID:           msgID,
			InternalDate: "1760000002000",
			From:         "deals@shopping.com",
			Subject:      "50% off today only!",
			Snippet:      msgID,
		},
	}

	completeFn := stubTriageFn(map[string]string{
		msgID: `{"category":"noise","reason":"promotional","replyTo":"","replySubject":"","replyBody":""}`,
	})

	actionN, fyiN, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("processTriageMessages: %v", err)
	}
	if actionN != 0 || fyiN != 0 {
		t.Errorf("actionN=%d fyiN=%d, want both 0 for noise", actionN, fyiN)
	}

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM commitments WHERE tenant_id = $1 AND idempotency_key = $2`,
		tenant, msgID,
	).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("commitment count=%d, want 0 for noise msg", count)
	}
}

// TestProcessTriageMessages_MalformedLLM verifies that when the LLM returns
// unparseable JSON the message is treated as fyi (graceful degradation, no throw).
func TestProcessTriageMessages_MalformedLLM(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-malformed")

	msgID := "triage-malformed-msg-1"
	msgs := []GmailMessage{
		{
			ID:           msgID,
			InternalDate: "1760000003000",
			From:         "someone@example.com",
			Subject:      "Quick question",
			Snippet:      msgID,
		},
	}

	// LLM returns garbage JSON.
	completeFn := stubTriageFn(map[string]string{
		msgID: `not valid json at all {{{`,
	})

	actionN, fyiN, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("processTriageMessages must not error on bad LLM JSON: %v", err)
	}
	if actionN != 0 {
		t.Errorf("actionN=%d, want 0", actionN)
	}
	if fyiN != 1 {
		t.Errorf("fyiN=%d, want 1 (malformed → fyi fallback)", fyiN)
	}

	// Commitment must exist as fyi.
	var kind, urgency string
	if err := pool.QueryRow(ctx, `
		SELECT kind, urgency FROM commitments
		WHERE tenant_id = $1 AND idempotency_key = $2
	`, tenant, msgID).Scan(&kind, &urgency); err != nil {
		t.Fatalf("read fyi commitment after malformed LLM: %v", err)
	}
	if kind != "email" || urgency != "fyi" {
		t.Errorf("kind=%q urgency=%q, want email/fyi", kind, urgency)
	}
}

// TestProcessTriageMessages_ActionEmptyBody verifies that an "action" verdict
// with an empty replyBody is downgraded to a fyi commitment (not a cross_app
// commitment proposing to send an empty email).
func TestProcessTriageMessages_ActionEmptyBody(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-empty-body")

	msgID := "triage-emptybody-msg-1"
	msgs := []GmailMessage{
		{
			ID:           msgID,
			InternalDate: "1760000004000",
			From:         "colleague@co.com",
			Subject:      "Check this out",
			Snippet:      msgID,
		},
	}

	// LLM says action but leaves replyBody empty.
	completeFn := stubTriageFn(map[string]string{
		msgID: `{"category":"action","reason":"needs reply","replyTo":"colleague@co.com","replySubject":"Re: Check this out","replyBody":""}`,
	})

	actionN, fyiN, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("processTriageMessages: %v", err)
	}
	if actionN != 0 {
		t.Errorf("actionN=%d, want 0 (empty draft → downgrade)", actionN)
	}
	if fyiN != 1 {
		t.Errorf("fyiN=%d, want 1 (downgraded to fyi)", fyiN)
	}

	// Must be an email/fyi commitment, not a cross_app one.
	var kind, urgency string
	if err := pool.QueryRow(ctx, `
		SELECT kind, urgency FROM commitments
		WHERE tenant_id = $1 AND idempotency_key = $2
	`, tenant, msgID).Scan(&kind, &urgency); err != nil {
		t.Fatalf("read commitment: %v", err)
	}
	if kind != "email" {
		t.Errorf("kind=%q, want 'email' (downgraded)", kind)
	}
	if urgency != "fyi" {
		t.Errorf("urgency=%q, want 'fyi'", urgency)
	}
}

// TestProcessTriageMessages_Idempotent verifies that re-running with the same
// messages (and empty cursor to force re-processing) creates 0 new commitments
// — the ON CONFLICT idempotency key guards dedup.
func TestProcessTriageMessages_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-idem")

	msgID := "triage-idem-msg-1"
	msgs := []GmailMessage{
		{
			ID:           msgID,
			InternalDate: "1760000005000",
			From:         "partner@biz.com",
			Subject:      "Contract review needed",
			Snippet:      msgID,
		},
	}
	draft := "Thanks for sending this over. I'll review and get back to you by end of week."
	completeFn := stubTriageFn(map[string]string{
		msgID: fmt.Sprintf(`{"category":"action","reason":"needs reply","replyTo":"partner@biz.com","replySubject":"Re: Contract review","replyBody":%q}`, draft),
	})

	actionN1, _, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if actionN1 != 1 {
		t.Fatalf("first run actionN=%d, want 1", actionN1)
	}

	// Second run with same msgs, empty cursor (force re-processing).
	actionN2, fyiN2, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if actionN2 != 0 || fyiN2 != 0 {
		t.Errorf("second run: actionN=%d fyiN=%d, want both 0 (idempotency guard)", actionN2, fyiN2)
	}

	// Exactly 1 commitment row in the DB.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM commitments WHERE tenant_id = $1 AND idempotency_key = $2`,
		tenant, msgID,
	).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("commitment count=%d, want 1 (idempotent)", count)
	}
}

// TestProcessTriageMessages_CursorAdvances verifies the 'inbox-triage' cursor
// is advanced to the max internalDate of the processed batch.
func TestProcessTriageMessages_CursorAdvances(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-cursor")

	msgs := []GmailMessage{
		{ID: "tc-1", InternalDate: "1760000006000", From: "a@b.com", Subject: "First", Snippet: "tc-1"},
		{ID: "tc-2", InternalDate: "1760000007000", From: "a@b.com", Subject: "Second", Snippet: "tc-2"},
	}

	// completeFn returns fyi for both (we only care about cursor, not commitments).
	completeFn := func(_ context.Context, _, _, _ string) (string, error) {
		return `{"category":"fyi","reason":"test","replyTo":"","replySubject":"","replyBody":""}`, nil
	}

	if _, _, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", completeFn); err != nil {
		t.Fatalf("processTriageMessages: %v", err)
	}

	// Cursor domain must be 'inbox-triage', not 'inbox'.
	var cursor string
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'inbox-triage'`,
		tenant,
	).Scan(&cursor); err != nil {
		t.Fatalf("read inbox-triage cursor: %v", err)
	}
	if cursor != "1760000007000" {
		t.Errorf("cursor=%q, want '1760000007000'", cursor)
	}
}

// TestInboxTriageCursor_Separate verifies that the 'inbox-triage' cursor is
// separate from the 'inbox' cursor used by inbox_autopilot — they must not
// advance each other.
func TestInboxTriageCursor_Separate(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := seedBodyTenant(t, pool)
	runID := insertBodyRun(t, pool, tenant, "triage-cursor-sep")

	msgs := []GmailMessage{
		{ID: "sep-1", InternalDate: "1760000009000", From: "x@y.com", Subject: "Test", Snippet: "sep-1"},
	}

	fyiFn := func(_ context.Context, _, _, _ string) (string, error) {
		return `{"category":"fyi","reason":"test","replyTo":"","replySubject":"","replyBody":""}`, nil
	}

	// Run processInboxMessages (autopilot) against the same messages.
	if _, _, err := processInboxMessages(ctx, pool, nopLogger(), tenant, runID, msgs, ""); err != nil {
		t.Fatalf("processInboxMessages: %v", err)
	}
	// Run processTriageMessages (triage) against the same messages.
	if _, _, err := processTriageMessages(ctx, pool, nopLogger(), tenant, runID, msgs, "", fyiFn); err != nil {
		t.Fatalf("processTriageMessages: %v", err)
	}

	// Both cursor rows must exist under their own domain keys.
	var inboxCursor, triageCursor string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'inbox'`,
		tenant,
	).Scan(&inboxCursor)
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'inbox-triage'`,
		tenant,
	).Scan(&triageCursor)

	if inboxCursor == "" {
		t.Error("inbox cursor missing after processInboxMessages")
	}
	if triageCursor == "" {
		t.Error("inbox-triage cursor missing after processTriageMessages")
	}
	// They should be the same value but stored independently (not the same row).
	var domainCount int
	_ = pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT domain) FROM gmail_poll_cursors WHERE tenant_id = $1`,
		tenant,
	).Scan(&domainCount)
	if domainCount < 2 {
		t.Errorf("domain count=%d, want ≥2 (inbox and inbox-triage are separate rows)", domainCount)
	}
}
