package handlers

// errand_test.go — compliance + behaviour tests for the errand-runner.
//
// Layer 1 (pure / no DB): TestDisclosurePreamble_* — proves buildDisclosurePreamble
//   always contains the required FCC/TCPA compliance phrases.
//
// Layer 2 (real DB, panicDialer): TestErrand_Propose* — stores 'proposed', never
//   dials; DNC numbers → 409.
//
// Layer 3 (real DB, recordingDialer): TestErrand_ConfirmAndCall_* — verifies the
//   sole dial path: owner-only, compliance preamble first, atomic (no double-dial),
//   idempotent, DNC-refused, non-owner 403.
//
// Layer 4 (no DB): TestErrand_GateOff_404 — all endpoints 404 when LANTERN_ERRAND unset.
//
// Layer 5 (RLS harness): TestRLSErrands_* — cross-tenant isolation at the Postgres layer.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- stub dialers ----------

// panicDialer is used in propose tests to assert no call is ever placed.
type panicDialer struct{}

func (panicDialer) PlaceCall(_ context.Context, _, _, _, _ string) (string, error) {
	panic("PlaceCall must never be called during errand propose")
}

// recordingDialer records every PlaceCall invocation; concurrency-safe.
type recordingDialer struct {
	mu    sync.Mutex
	calls []recordedCall
}

type recordedCall struct{ tenantID, from, to, twiml string }

func (d *recordingDialer) PlaceCall(_ context.Context, tenantID, from, to, twiml string) (string, error) {
	d.mu.Lock()
	d.calls = append(d.calls, recordedCall{tenantID: tenantID, from: from, to: to, twiml: twiml})
	d.mu.Unlock()
	return "CA" + uuid.NewString(), nil
}

func (d *recordingDialer) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.calls)
}

func (d *recordingDialer) last() recordedCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls[len(d.calls)-1]
}

// ---------- helpers ----------

// newErrandHandlerWithDialer builds a handler backed by a real pool, with an
// injected dialer. The LANTERN_ERRAND env var must be set by the caller via
// t.Setenv("LANTERN_ERRAND", "1") for endpoints to respond (not 404).
func newErrandHandlerWithDialer(t *testing.T, pool *pgxpool.Pool, dialer OutboundDialer) *ErrandHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewErrandHandler(srv, NewAuthHandler(srv, testJWTSecret))
	h.dialer = dialer
	return h
}

// seedErrandTenant inserts a minimal tenant and registers cleanup for errands
// and dnc_numbers rows.
func seedErrandTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "er-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Errand Test', 'personal', 'ns-er-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, slug); err != nil {
		t.Fatalf("seedErrandTenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2 := context.Background()
		_, _ = pool.Exec(ctx2, "DELETE FROM dnc_numbers WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(ctx2, "DELETE FROM errands WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(ctx2, "DELETE FROM tenants WHERE id = $1::uuid", id)
	})
	return id
}

// doPropose fires POST /v1/errands.
func doPropose(t *testing.T, h *ErrandHandler, tenant string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/errands", strings.NewReader(string(b)))
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.Propose(rr, req)
	return rr
}

// doConfirm fires POST /v1/errands/{id}/confirm-and-call.
func doConfirm(t *testing.T, h *ErrandHandler, tenant, id, role string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/errands/"+id+"/confirm-and-call", nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", role)))
	rr := httptest.NewRecorder()
	h.ConfirmAndCall(rr, req)
	return rr
}

// doOptOut fires POST /v1/errands/{id}/opt-out.
func doOptOut(t *testing.T, h *ErrandHandler, tenant, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/errands/"+id+"/opt-out", strings.NewReader(`{}`))
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.OptOut(rr, req)
	return rr
}

// proposeAndGetID proposes an errand and returns its ID.  Fails the test on
// non-201.
func proposeAndGetID(t *testing.T, h *ErrandHandler, tenant, number, goal string) string {
	t.Helper()
	rr := doPropose(t, h, tenant, map[string]any{
		"calleeNumber": number,
		"calleeName":   "Test Recipient",
		"goal":         goal,
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("propose: got %d; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode propose response: %v", err)
	}
	return out.ID
}

// seedDNC inserts a number into dnc_numbers directly (bypassing the handler).
func seedDNC(t *testing.T, pool *pgxpool.Pool, tenantID, number string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO dnc_numbers (tenant_id, number, reason) VALUES ($1, $2, 'test seed')
		 ON CONFLICT DO NOTHING`,
		tenantID, number); err != nil {
		t.Fatalf("seedDNC: %v", err)
	}
}

// ---------- Layer 1: pure compliance tests (no DB required) ----------

// TestDisclosurePreamble_AlwaysCompliant proves buildDisclosurePreamble always
// contains the FCC/TCPA-required AI-identification + recording-consent text,
// regardless of the ownerName/goal values passed.
func TestDisclosurePreamble_AlwaysCompliant(t *testing.T) {
	cases := []struct{ owner, goal string }{
		{"Alice", "reschedule my dentist appointment"},
		{"", "book a table at Nobu"},
		{"Bob", ""},
		{"", ""},
	}
	for _, tc := range cases {
		script := buildDisclosurePreamble(tc.owner, tc.goal)
		lower := strings.ToLower(script)
		if !strings.Contains(lower, errandAIDisclosureMarker) {
			t.Errorf("preamble missing AI-disclosure marker %q: owner=%q goal=%q\nscript: %s",
				errandAIDisclosureMarker, tc.owner, tc.goal, script)
		}
		if !strings.Contains(lower, errandRecordingMarker) {
			t.Errorf("preamble missing recording-consent marker %q: owner=%q goal=%q\nscript: %s",
				errandRecordingMarker, tc.owner, tc.goal, script)
		}
	}
}

// TestErrandTwiML_PreambleAlwaysFirst asserts that the TwiML produced by
// buildErrandTwiML always contains the disclosure text as the first <Say>
// content — the structural non-skipability proof.
func TestErrandTwiML_PreambleAlwaysFirst(t *testing.T) {
	script := buildDisclosurePreamble("Owner", "reschedule dentist")
	twiml := buildErrandTwiML(script)

	lower := strings.ToLower(twiml)
	aiIdx := strings.Index(lower, errandAIDisclosureMarker)
	recIdx := strings.Index(lower, errandRecordingMarker)
	sayIdx := strings.Index(lower, "<say")

	if aiIdx < 0 {
		t.Errorf("TwiML missing AI-disclosure marker")
	}
	if recIdx < 0 {
		t.Errorf("TwiML missing recording-consent marker")
	}
	// Both compliance markers must appear BEFORE the closing of the first <Say>.
	firstSayClose := strings.Index(lower, "</say>")
	if firstSayClose < 0 {
		t.Fatalf("TwiML has no </Say>")
	}
	if aiIdx > firstSayClose || aiIdx < sayIdx {
		t.Errorf("AI-disclosure not inside first <Say> (aiIdx=%d sayIdx=%d sayClose=%d)", aiIdx, sayIdx, firstSayClose)
	}
	if recIdx > firstSayClose || recIdx < sayIdx {
		t.Errorf("recording-consent not inside first <Say> (recIdx=%d sayIdx=%d sayClose=%d)", recIdx, sayIdx, firstSayClose)
	}
}

// ---------- Layer 4 (no DB): gate-off test ----------

// TestErrand_GateOff_404 confirms all endpoints return 404 when LANTERN_ERRAND
// is unset — the feature is off by default.
func TestErrand_GateOff_404(t *testing.T) {
	// No DB needed: gate check fires before any DB access.
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Logger: logger}
	h := NewErrandHandler(srv, NewAuthHandler(srv, testJWTSecret))
	// Do NOT set LANTERN_ERRAND.

	tenant := uuid.NewString()
	tok := bearerHeader(mintTestToken(t, tenant, "u", "owner"))

	endpoints := []struct {
		name string
		fn   func() *httptest.ResponseRecorder
	}{
		{"propose", func() *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/v1/errands", strings.NewReader(`{}`))
			req.Header.Set("Authorization", tok)
			rr := httptest.NewRecorder()
			h.Propose(rr, req)
			return rr
		}},
		{"confirm-and-call", func() *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/v1/errands/abc/confirm-and-call", nil)
			req.SetPathValue("id", "abc")
			req.Header.Set("Authorization", tok)
			rr := httptest.NewRecorder()
			h.ConfirmAndCall(rr, req)
			return rr
		}},
		{"opt-out", func() *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/v1/errands/abc/opt-out", strings.NewReader(`{}`))
			req.SetPathValue("id", "abc")
			req.Header.Set("Authorization", tok)
			rr := httptest.NewRecorder()
			h.OptOut(rr, req)
			return rr
		}},
		{"list", func() *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodGet, "/v1/errands", nil)
			req.Header.Set("Authorization", tok)
			rr := httptest.NewRecorder()
			h.List(rr, req)
			return rr
		}},
	}

	for _, ep := range endpoints {
		rr := ep.fn()
		if rr.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404 when LANTERN_ERRAND unset", ep.name, rr.Code)
		}
	}
}

// ---------- Layer 2 & 3: DB-backed tests ----------

// TestErrand_ProposeStoresProposed verifies a propose inserts a 'proposed' row
// and returns {id, disclosurePreview} containing the compliance markers.
func TestErrand_ProposeStoresProposed(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	// panicDialer: confirms no dial happens during propose.
	h := newErrandHandlerWithDialer(t, pool, panicDialer{})

	rr := doPropose(t, h, tenant, map[string]any{
		"calleeNumber": "+15125551234",
		"calleeName":   "Dr. Smith",
		"goal":         "reschedule my 9am dentist appointment to 11am",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("propose: got %d; body: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		ID                string `json:"id"`
		DisclosurePreview string `json:"disclosurePreview"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID == "" {
		t.Fatal("propose: got empty id")
	}

	// disclosurePreview must contain the compliance markers.
	lower := strings.ToLower(resp.DisclosurePreview)
	if !strings.Contains(lower, errandAIDisclosureMarker) {
		t.Errorf("disclosurePreview missing AI marker: %s", resp.DisclosurePreview)
	}
	if !strings.Contains(lower, errandRecordingMarker) {
		t.Errorf("disclosurePreview missing recording marker: %s", resp.DisclosurePreview)
	}

	// Verify stored status='proposed' directly.
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, resp.ID).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "proposed" {
		t.Errorf("status=%q, want 'proposed'", status)
	}
}

// TestErrand_ProposeDNC_409 confirms that proposing a call to a DNC number
// returns 409 and never touches the DB beyond the DNC check.
func TestErrand_ProposeDNC_409(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	dncNumber := "+15125550001"
	seedDNC(t, pool, tenant, dncNumber)

	h := newErrandHandlerWithDialer(t, pool, panicDialer{})
	rr := doPropose(t, h, tenant, map[string]any{
		"calleeNumber": dncNumber,
		"goal":         "confirm tomorrow's meeting",
	})
	if rr.Code != http.StatusConflict {
		t.Errorf("DNC propose: got %d, want 409; body: %s", rr.Code, rr.Body.String())
	}
}

// TestErrand_ConfirmAndCall_PlacesOneCall is the primary compliance proof:
//   - places exactly one call
//   - call's TwiML contains the AI-disclosure + recording phrases
//   - errand moves to 'placed'
func TestErrand_ConfirmAndCall_PlacesOneCall(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	rec := &recordingDialer{}
	h := newErrandHandlerWithDialer(t, pool, rec)

	id := proposeAndGetID(t, h, tenant, "+15125551111", "book a table at Nobu for Friday")

	rr := doConfirm(t, h, tenant, id, "owner")
	if rr.Code != http.StatusOK {
		t.Fatalf("confirm-and-call: got %d; body: %s", rr.Code, rr.Body.String())
	}

	// Exactly one call must have been placed.
	if rec.count() != 1 {
		t.Fatalf("expected 1 call placed, got %d", rec.count())
	}

	// The TwiML of that call must contain the compliance phrases.
	placed := rec.last()
	lower := strings.ToLower(placed.twiml)
	if !strings.Contains(lower, errandAIDisclosureMarker) {
		t.Errorf("placed call TwiML missing AI-disclosure marker\ntwiml: %s", placed.twiml)
	}
	if !strings.Contains(lower, errandRecordingMarker) {
		t.Errorf("placed call TwiML missing recording-consent marker\ntwiml: %s", placed.twiml)
	}
	// AI-disclosure must appear before the first </Say> (structurally first).
	firstSayClose := strings.Index(lower, "</say>")
	aiIdx := strings.Index(lower, errandAIDisclosureMarker)
	if aiIdx > firstSayClose {
		t.Errorf("AI-disclosure is NOT in the first <Say> block (idx=%d, firstSayClose=%d)", aiIdx, firstSayClose)
	}

	// Errand must be 'placed'.
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "placed" {
		t.Errorf("status=%q, want 'placed'", status)
	}
}

// TestErrand_ConfirmAndCall_Idempotent confirms that a second confirm on an
// already-placed errand returns 409 and places no additional call.
func TestErrand_ConfirmAndCall_Idempotent(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	rec := &recordingDialer{}
	h := newErrandHandlerWithDialer(t, pool, rec)

	id := proposeAndGetID(t, h, tenant, "+15125552222", "reschedule dentist")

	// First confirm: OK.
	if rr := doConfirm(t, h, tenant, id, "owner"); rr.Code != http.StatusOK {
		t.Fatalf("first confirm: got %d; body: %s", rr.Code, rr.Body.String())
	}

	// Second confirm: must return 409, no additional call.
	rr2 := doConfirm(t, h, tenant, id, "owner")
	if rr2.Code != http.StatusConflict {
		t.Errorf("second confirm: got %d, want 409; body: %s", rr2.Code, rr2.Body.String())
	}
	if rec.count() != 1 {
		t.Errorf("expected exactly 1 call total, got %d", rec.count())
	}
}

// TestErrand_ConfirmAndCall_Concurrent fires two confirms on the same errand
// from separate goroutines (under -race). Exactly one must succeed (200), the
// other must get 409. Exactly one call must be placed.
func TestErrand_ConfirmAndCall_Concurrent(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	rec := &recordingDialer{}
	h := newErrandHandlerWithDialer(t, pool, rec)

	id := proposeAndGetID(t, h, tenant, "+15125553333", "chase the invoice")

	var (
		ok409 atomic.Int32
		ok200 atomic.Int32
		wg    sync.WaitGroup
	)
	const concurrency = 5
	start := make(chan struct{})
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // all goroutines start as simultaneously as possible
			rr := doConfirm(t, h, tenant, id, "owner")
			switch rr.Code {
			case http.StatusOK:
				ok200.Add(1)
			case http.StatusConflict:
				ok409.Add(1)
			default:
				t.Errorf("unexpected status %d: %s", rr.Code, rr.Body.String())
			}
		}()
	}
	close(start)
	wg.Wait()

	if ok200.Load() != 1 {
		t.Errorf("expected exactly 1 success (200), got %d", ok200.Load())
	}
	if ok409.Load() != concurrency-1 {
		t.Errorf("expected %d conflicts (409), got %d", concurrency-1, ok409.Load())
	}
	if rec.count() != 1 {
		t.Errorf("expected exactly 1 call placed, got %d (double-dial detected)", rec.count())
	}
}

// TestErrand_ConfirmAndCall_NonOwner_403 proves that a non-owner caller cannot
// trigger a dial (the owner-only gate must fire before the dialer is reached).
func TestErrand_ConfirmAndCall_NonOwner_403(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	// panicDialer: confirms no call is placed even if the role check were absent.
	h := newErrandHandlerWithDialer(t, pool, panicDialer{})

	id := proposeAndGetID(t, h, tenant, "+15125554444", "cancel the gym subscription")

	rr := doConfirm(t, h, tenant, id, "user") // "user" role, not "owner"/"admin"
	if rr.Code != http.StatusForbidden {
		t.Errorf("non-owner confirm: got %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

// TestErrand_ConfirmAndCall_DNCRefused proves that a number added to DNC between
// propose-time and confirm-time is refused at confirm-time and no call is placed.
func TestErrand_ConfirmAndCall_DNCRefused(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	// panicDialer: confirms no call is placed on DNC match.
	h := newErrandHandlerWithDialer(t, pool, panicDialer{})

	dncNumber := "+15125555555"
	id := proposeAndGetID(t, h, tenant, dncNumber, "check on the shipment")

	// Simulate: recipient asked to be removed between propose and confirm.
	seedDNC(t, pool, tenant, dncNumber)

	rr := doConfirm(t, h, tenant, id, "owner")
	if rr.Code != http.StatusConflict {
		t.Errorf("DNC confirm: got %d, want 409; body: %s", rr.Code, rr.Body.String())
	}

	// Errand must be back to 'proposed' (tx was rolled back).
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "proposed" {
		t.Errorf("status after DNC-refused confirm=%q, want 'proposed' (tx should have rolled back)", status)
	}
}

// TestErrand_OptOut_AddsDNC proves that opt-out writes the number to dnc_numbers
// and marks the errand 'cancelled'.
func TestErrand_OptOut_AddsDNC(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	h := newErrandHandlerWithDialer(t, pool, panicDialer{})
	number := "+15125556666"
	id := proposeAndGetID(t, h, tenant, number, "check on the delivery")

	rr := doOptOut(t, h, tenant, id)
	if rr.Code != http.StatusOK {
		t.Fatalf("opt-out: got %d; body: %s", rr.Code, rr.Body.String())
	}

	// DNC must now contain the number.
	var cnt int
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM dnc_numbers WHERE tenant_id=$1 AND number=$2`,
		tenant, number).Scan(&cnt); err != nil {
		t.Fatalf("DNC count query: %v", err)
	}
	if cnt != 1 {
		t.Errorf("expected 1 DNC row, got %d", cnt)
	}

	// Errand must be 'cancelled'.
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "cancelled" {
		t.Errorf("status=%q, want 'cancelled'", status)
	}
}

// ---------- Layer 5: RLS enforcement tests ----------

// newEnforcedErrandHandler builds an ErrandHandler on the RLS-enforced server.
func newEnforcedErrandHandler(t *testing.T, e *enforcedServer) *ErrandHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	h := NewErrandHandler(e.srv, auth)
	h.dialer = &recordingDialer{}
	return h
}

// TestRLSErrands_SameTenantWorks proves propose + list work under genuine
// RLS enforcement (AppPool as lantern_app).
func TestRLSErrands_SameTenantWorks(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	e := newEnforcedServer(t)
	h := newEnforcedErrandHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-er-"+uuid.NewString()[:8])

	rr := doPropose(t, h, tenant, map[string]any{
		"calleeNumber": "+15125557777",
		"goal":         "RLS proof errand",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("REGRESSION: same-tenant propose under RLS: %d; body: %s", rr.Code, rr.Body.String())
	}

	// List must return the row.
	req := httptest.NewRequest(http.MethodGet, "/v1/errands", nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "u", "owner")))
	rrList := httptest.NewRecorder()
	h.List(rrList, req)
	if rrList.Code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant list under RLS: %d", rrList.Code)
	}
	var rows []map[string]any
	if err := json.Unmarshal(rrList.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("REGRESSION: same-tenant list returned 0 rows under RLS")
	}
}

// TestRLSErrands_CrossTenantBlocked proves cross-tenant reads are blocked at
// the Postgres layer under genuine RLS enforcement.
func TestRLSErrands_CrossTenantBlocked(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	e := newEnforcedServer(t)
	h := newEnforcedErrandHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-er-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-er-b-"+uuid.NewString()[:8])

	// Seed an errand as tenant A.
	rr := doPropose(t, h, tenantA, map[string]any{
		"calleeNumber": "+15125558888",
		"goal":         "private errand A",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("seed: %d; body: %s", rr.Code, rr.Body.String())
	}

	// Tenant B list → zero rows (blocked at Postgres).
	req := httptest.NewRequest(http.MethodGet, "/v1/errands", nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantB, "u", "owner")))
	rrList := httptest.NewRecorder()
	h.List(rrList, req)
	if rrList.Code != http.StatusOK {
		t.Fatalf("list as B: %d", rrList.Code)
	}
	var rows []map[string]any
	if err := json.Unmarshal(rrList.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B sees %d of tenant A's errands under RLS, want 0", len(rows))
	}
}
