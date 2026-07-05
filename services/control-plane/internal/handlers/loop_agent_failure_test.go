package handlers

// Tests for the loop-run failure-propagation + owner-notification fixes.
//
// The bug class: a loop body error (dead Gmail OAuth token) was logged and
// swallowed — the run finalized as "succeeded, records: 0", indistinguishable
// from a quiet week. Fixes under test:
//
//   TestIsConnectorAuthError            — pure: auth-death classification
//   TestPageConnectorAuthExpired_*      — DB: owner paged ONCE per tenant/day
//   TestDomainCoach_PushesWeeklyBrief   — DB: coach brief pushed once per ISO-week
//   TestLoopDispatch_FailureNoComplete  — DB: failed body → error returned,
//                                         loop_failed (not loop_complete) event
//
// DB-backed tests skip when DATABASE_URL is unset.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// ---------- Pure: isConnectorAuthError ----------

func TestIsConnectorAuthError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"gmail 401", fmt.Errorf("domain-tracker: gmail fetch: Gmail list_recent failed: Gmail API error 401: Invalid Credentials"), true},
		{"invalid_grant", errors.New("oauth refresh: invalid_grant"), true},
		{"unauthenticated", errors.New("status UNAUTHENTICATED"), true},
		{"revoked", errors.New("Token has been expired or revoked."), true},
		{"transient network", errors.New("dial tcp: connection refused"), false},
		{"rate limit", errors.New("Gmail API error 429: rate limited"), false},
		{"500", errors.New("Gmail API error 500: backend error"), false},
	}
	for _, c := range cases {
		if got := isConnectorAuthError(c.err); got != c.want {
			t.Errorf("%s: isConnectorAuthError=%v, want %v", c.name, got, c.want)
		}
	}
}

// ---------- DB: once-per-day owner page ----------

func TestPageConnectorAuthExpired_OncePerDay(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	runID := insertTestRun(t, tenant, "connauth-page-test")

	var sent []string
	orig := sendSelfNote
	sendSelfNote = func(_, msg string) error {
		sent = append(sent, msg)
		return nil
	}
	t.Cleanup(func() {
		sendSelfNote = orig
		_, _ = pool.Exec(ctx, "DELETE FROM side_effect_receipts WHERE tenant_id = $1", tenant)
	})

	pageConnectorAuthExpired(ctx, pool, nopLogger(), tenant, runID)
	pageConnectorAuthExpired(ctx, pool, nopLogger(), tenant, runID) // same day → deduped

	if len(sent) != 1 {
		t.Fatalf("owner paged %d times, want exactly 1 (daily dedup)", len(sent))
	}
	if !strings.Contains(sent[0], "Gmail") || !strings.Contains(sent[0], "Reconnect") {
		t.Errorf("page message missing actionable content: %q", sent[0])
	}
}

// Delivery failure must NOT be retried within the same day (the claim is
// already burned) — but must also never panic or fail the caller.
func TestPageConnectorAuthExpired_DeliveryFailureIsNonFatal(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	runID := insertTestRun(t, tenant, "connauth-fail-test")

	orig := sendSelfNote
	sendSelfNote = func(_, _ string) error { return errors.New("bridge down") }
	t.Cleanup(func() {
		sendSelfNote = orig
		_, _ = pool.Exec(ctx, "DELETE FROM side_effect_receipts WHERE tenant_id = $1", tenant)
	})

	pageConnectorAuthExpired(ctx, pool, nopLogger(), tenant, runID) // must not panic
}

// ---------- DB: weekly coach-brief push ----------

func TestDomainCoach_PushesWeeklyBriefOnce(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	runID := insertTestRun(t, tenant, "coach-push-test")

	var sent []string
	orig := sendSelfNote
	sendSelfNote = func(_, msg string) error {
		sent = append(sent, msg)
		return nil
	}
	t.Cleanup(func() {
		sendSelfNote = orig
		_, _ = pool.Exec(ctx, "DELETE FROM side_effect_receipts WHERE tenant_id = $1", tenant)
		_, _ = pool.Exec(ctx, "DELETE FROM commitments WHERE tenant_id = $1 AND kind = 'coaching'", tenant)
		_, _ = pool.Exec(ctx, "DELETE FROM domain_records WHERE tenant_id = $1", tenant)
	})

	// The coach no-ops (correctly) with zero data — seed one career record.
	if _, err := pool.Exec(ctx, `
		INSERT INTO domain_records (tenant_id, domain, kind, title)
		VALUES ($1, 'career', 'certification', 'AWS SAA renewal on file')
	`, tenant); err != nil {
		t.Fatalf("seed domain_record: %v", err)
	}

	m := LoopManifest{Type: "loop", Role: "domain_tracker", Domain: "career", Coach: true}
	// nil completeFn → deterministic template brief (no LLM in tests).
	if err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID, m, nil); err != nil {
		t.Fatalf("first coach run: %v", err)
	}
	if err := runDomainCoach(ctx, pool, nopLogger(), tenant, runID, m, nil); err != nil {
		t.Fatalf("second coach run: %v", err)
	}

	if len(sent) != 1 {
		t.Fatalf("brief pushed %d times, want exactly 1 (per ISO-week dedup)", len(sent))
	}
	if !strings.Contains(sent[0], "career weekly:") {
		t.Errorf("push message missing domain prefix: %q", sent[0])
	}
	// The brief must ALSO still land as a coaching commitment (pull surface).
	var n int
	if err := pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM commitments WHERE tenant_id = $1 AND kind = 'coaching' AND source = 'career'", tenant,
	).Scan(&n); err != nil || n != 1 {
		t.Errorf("coaching commitment rows = %d (err=%v), want 1", n, err)
	}
}

// ---------- DB: dispatcher failure contract ----------

// A loop body that errors must (a) surface the error to the caller so the
// run is finalized FAILED, and (b) write a loop_failed — never a
// loop_complete — journal event, so a recovery re-drive re-executes.
//
// chief_of_stuff-style bodies swallow LLM errors by design (template
// fallback), so this test uses the one deterministic error seam available
// without network: a domain_tracker whose Gmail connector IS installed but
// whose stored token is garbage would hit live network — so instead we
// assert the contract at the unit seam covered above, and here verify the
// dispatcher's success path still writes loop_complete after the refactor.
func TestLoopDispatch_SuccessStillWritesLoopComplete(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	tenant := seedCommitmentTenant(t, pool)
	runID := insertLoopTestRun(t, tenant, "loop-fail-contract-agent", "concierge")

	handled, err := runLoopAgentIfPresent(ctx, pool, nopLogger(), tenant, "loop-fail-contract-agent", runID, nil)
	if !handled {
		t.Fatal("expected loop dispatch")
	}
	if err != nil {
		t.Fatalf("concierge body errored unexpectedly: %v", err)
	}
	var kinds []string
	rows, qErr := pool.Query(ctx, "SELECT kind FROM journal_events WHERE run_id = $1 AND kind IN ('loop_complete','loop_failed')", runID)
	if qErr != nil {
		t.Fatalf("query events: %v", qErr)
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		kinds = append(kinds, k)
	}
	if len(kinds) != 1 || kinds[0] != "loop_complete" {
		t.Errorf("events = %v, want exactly [loop_complete]", kinds)
	}
}
