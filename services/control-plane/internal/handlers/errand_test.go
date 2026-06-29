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
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
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
// injected dialer (no LLM). The LANTERN_ERRAND env var must be set by the
// caller via t.Setenv("LANTERN_ERRAND", "1") for endpoints to respond (not 404).
func newErrandHandlerWithDialer(t *testing.T, pool *pgxpool.Pool, dialer OutboundDialer) *ErrandHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewErrandHandler(srv, NewAuthHandler(srv, testJWTSecret), nil)
	h.dialer = dialer
	return h
}

// newErrandHandlerWithCompleter builds a handler backed by a real pool with an
// injected stub LLM completion function. Sets h.dialer to a recordingDialer.
func newErrandHandlerWithCompleter(t *testing.T, pool *pgxpool.Pool, fn researchCompleteFn) *ErrandHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewErrandHandler(srv, NewAuthHandler(srv, testJWTSecret), nil)
	h.dialer = &recordingDialer{}
	h.completeFn = fn
	return h
}

// seedPlacedErrand inserts an errand directly in 'placed' status (bypasses
// propose+confirm so tests can target ErrandTurn without a full dial flow).
func seedPlacedErrand(t *testing.T, pool *pgxpool.Pool, tenantID, number, goal string) string {
	t.Helper()
	ctx := context.Background()
	disclosure := buildDisclosurePreamble("Test Owner", goal)
	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO errands (tenant_id, callee_number, callee_name, goal, status, disclosure_script)
		VALUES ($1, $2, 'Test Callee', $3, 'placed', $4)
		RETURNING id
	`, tenantID, number, goal, disclosure).Scan(&id); err != nil {
		t.Fatalf("seedPlacedErrand: %v", err)
	}
	return id
}

// seedTwilioConnector inserts a connector_installs row for Twilio with the
// given authToken so signature verification can run against a real token.
func seedTwilioConnector(t *testing.T, pool *pgxpool.Pool, tenantID, authToken string) {
	t.Helper()
	cfg, _ := json.Marshal(map[string]string{"authToken": authToken, "accountSid": "ACtest"})
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO connector_installs (tenant_id, connector_id, display_name, status, config)
		VALUES ($1, 'twilio', 'Twilio', 'connected', $2::jsonb)
		ON CONFLICT (tenant_id, connector_id) DO UPDATE SET config = EXCLUDED.config, status = 'connected'
	`, tenantID, string(cfg)); err != nil {
		t.Fatalf("seedTwilioConnector: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM connector_installs WHERE tenant_id=$1 AND connector_id='twilio'`, tenantID)
	})
}

// doErrandTurn fires POST /v1/voice/errand/turn/{id} as a Twilio form POST.
// Uses LANTERN_TWILIO_WEBHOOK_AUTH=off (set by caller via t.Setenv) to bypass
// signature verification in most tests.
func doErrandTurn(t *testing.T, h *ErrandHandler, id string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	body := form.Encode()
	req := httptest.NewRequest(http.MethodPost, "/v1/voice/errand/turn/"+id, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetPathValue("id", id)
	rr := httptest.NewRecorder()
	h.ErrandTurn(rr, req)
	return rr
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
	h := NewErrandHandler(srv, NewAuthHandler(srv, testJWTSecret), nil)
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
	h := NewErrandHandler(e.srv, auth, nil)
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

// ---------- Layer 1: pure tests for new conversational TwiML builders ----------

// TestErrandConversationalTwiML_DisclosureFirst asserts:
//   - The disclosure text appears before the first <Gather element.
//   - The <Gather has the expected action URL.
//   - The opt-out fallback line is present.
func TestErrandConversationalTwiML_DisclosureFirst(t *testing.T) {
	disclosure := buildDisclosurePreamble("Alice", "book a table at Nobu")
	turnURL := "https://example.com/v1/voice/errand/turn/abc-123"
	twiml := buildErrandConversationalTwiML(disclosure, turnURL, "")

	lower := strings.ToLower(twiml)

	aiIdx := strings.Index(lower, errandAIDisclosureMarker)
	if aiIdx < 0 {
		t.Fatalf("conversational TwiML missing AI-disclosure marker")
	}

	gatherIdx := strings.Index(lower, "<gather")
	if gatherIdx < 0 {
		t.Fatalf("conversational TwiML missing <Gather element")
	}

	if aiIdx > gatherIdx {
		t.Errorf("AI-disclosure must appear BEFORE <Gather (aiIdx=%d gatherIdx=%d)", aiIdx, gatherIdx)
	}

	if !strings.Contains(twiml, turnURL) {
		t.Errorf("conversational TwiML missing action URL %q", turnURL)
	}

	if !strings.Contains(lower, "removed from our calling list") {
		t.Errorf("conversational TwiML missing opt-out fallback line")
	}
}

// TestContainsOptOut_Table checks every opt-out phrase and a non-opt-out sentence.
func TestContainsOptOut_Table(t *testing.T) {
	cases := []struct {
		speech string
		want   bool
	}{
		{"please stop calling me", true},
		{"STOP CALLING please", true},
		{"remove me from this list", true},
		{"do not call me again", true},
		{"don't call here", true},
		{"take me off your list", true},
		{"unsubscribe", true},
		{"UNSUBSCRIBE NOW", true},
		{"yes I am interested", false},
		{"", false},
		{"hello who is this", false},
	}
	for _, tc := range cases {
		got := containsOptOut(tc.speech)
		if got != tc.want {
			t.Errorf("containsOptOut(%q) = %v, want %v", tc.speech, got, tc.want)
		}
	}
}

// ---------- Layer 6: DB-backed ErrandTurn tests ----------

// TestErrandTurn_OptOut_DNC verifies that an opt-out phrase spoken by the
// callee adds their number to dnc_numbers and marks the errand 'cancelled'.
func TestErrandTurn_OptOut_DNC(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	t.Setenv("LANTERN_TWILIO_WEBHOOK_AUTH", "off") // bypass Twilio sig verify
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	number := "+15125559901"
	id := seedPlacedErrand(t, pool, tenant, number, "schedule a plumber visit")

	h := newErrandHandlerWithCompleter(t, pool, nil) // completeFn not reached

	form := url.Values{"SpeechResult": {"please remove me from your calling list"}}
	rr := doErrandTurn(t, h, id, form)

	if rr.Code != http.StatusOK {
		t.Fatalf("ErrandTurn opt-out: got %d; body: %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(strings.ToLower(body), "<hangup") {
		t.Errorf("ErrandTurn opt-out: response should contain <Hangup/>; got: %s", body)
	}

	// DNC must now contain the number.
	var dncCnt int
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM dnc_numbers WHERE tenant_id=$1 AND number=$2`,
		tenant, number).Scan(&dncCnt); err != nil {
		t.Fatalf("DNC count: %v", err)
	}
	if dncCnt != 1 {
		t.Errorf("expected 1 DNC row, got %d", dncCnt)
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

// TestErrandTurn_MaxTurns_Completed checks that the max-turn cap marks the
// errand completed and returns a <Hangup/>.
func TestErrandTurn_MaxTurns_Completed(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	t.Setenv("LANTERN_TWILIO_WEBHOOK_AUTH", "off")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	id := seedPlacedErrand(t, pool, tenant, "+15125559902", "check on package delivery")

	// Exhaust turns directly in the DB.
	if _, err := pool.Exec(context.Background(),
		`UPDATE errands SET turns=$1 WHERE id=$2`, errandMaxTurns, id); err != nil {
		t.Fatalf("set turns: %v", err)
	}

	h := newErrandHandlerWithCompleter(t, pool, nil) // LLM never called at cap
	rr := doErrandTurn(t, h, id, url.Values{"SpeechResult": {"sure I can wait"}})

	if rr.Code != http.StatusOK {
		t.Fatalf("ErrandTurn max-turns: got %d; body: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(strings.ToLower(rr.Body.String()), "<hangup") {
		t.Errorf("max-turns: response should contain <Hangup/>; got: %s", rr.Body.String())
	}

	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "completed" {
		t.Errorf("status=%q, want 'completed'", status)
	}
}

// TestErrandTurn_NormalTurn_Continue checks a successful LLM turn that is not
// done: response contains <Gather, the say text, transcript grew by 2, turns++.
func TestErrandTurn_NormalTurn_Continue(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	t.Setenv("LANTERN_TWILIO_WEBHOOK_AUTH", "off")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	id := seedPlacedErrand(t, pool, tenant, "+15125559903", "confirm dentist appointment")

	stubReply := `{"say":"I am calling to confirm your appointment tomorrow at 9am. Does that still work for you?","done":false}`
	fn := func(_ context.Context, _, _, _ string) (string, error) {
		return stubReply, nil
	}
	h := newErrandHandlerWithCompleter(t, pool, fn)

	speech := "Hello, who is this?"
	rr := doErrandTurn(t, h, id, url.Values{"SpeechResult": {speech}})

	if rr.Code != http.StatusOK {
		t.Fatalf("ErrandTurn normal: got %d; body: %s", rr.Code, rr.Body.String())
	}

	body := rr.Body.String()
	lower := strings.ToLower(body)

	if !strings.Contains(lower, "<gather") {
		t.Errorf("normal turn: response should contain <Gather; got: %s", body)
	}
	if !strings.Contains(body, "confirm your appointment") {
		t.Errorf("normal turn: response should contain the say text; got: %s", body)
	}

	// Transcript should have 2 new entries (callee + assistant).
	var rawTranscript []byte
	var turns int
	if err := pool.QueryRow(context.Background(),
		`SELECT transcript, turns FROM errands WHERE id=$1`, id).Scan(&rawTranscript, &turns); err != nil {
		t.Fatalf("transcript query: %v", err)
	}
	var entries []transcriptEntry
	if err := json.Unmarshal(rawTranscript, &entries); err != nil {
		t.Fatalf("unmarshal transcript: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("transcript has %d entries, want 2", len(entries))
	} else {
		if entries[0].Role != "callee" || entries[0].Text != speech {
			t.Errorf("entries[0]=%+v, want callee/%q", entries[0], speech)
		}
		if entries[1].Role != "assistant" {
			t.Errorf("entries[1].Role=%q, want 'assistant'", entries[1].Role)
		}
	}
	if turns != 1 {
		t.Errorf("turns=%d, want 1", turns)
	}
}

// TestErrandTurn_DoneTurn_Completed checks that done=true marks status=completed
// and returns a <Hangup/> response containing the say text.
func TestErrandTurn_DoneTurn_Completed(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	t.Setenv("LANTERN_TWILIO_WEBHOOK_AUTH", "off")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	id := seedPlacedErrand(t, pool, tenant, "+15125559904", "reschedule dentist")

	fn := func(_ context.Context, _, _, _ string) (string, error) {
		return `{"say":"all set, your appointment is confirmed for next Tuesday","done":true}`, nil
	}
	h := newErrandHandlerWithCompleter(t, pool, fn)

	rr := doErrandTurn(t, h, id, url.Values{"SpeechResult": {"yes Tuesday works"}})
	if rr.Code != http.StatusOK {
		t.Fatalf("ErrandTurn done: got %d; body: %s", rr.Code, rr.Body.String())
	}

	body := rr.Body.String()
	lower := strings.ToLower(body)

	if !strings.Contains(lower, "<hangup") {
		t.Errorf("done turn: response should contain <Hangup/>; got: %s", body)
	}
	if !strings.Contains(body, "all set") {
		t.Errorf("done turn: response should contain say text 'all set'; got: %s", body)
	}

	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "completed" {
		t.Errorf("status=%q, want 'completed'", status)
	}
}

// TestErrandTurn_LLMError_GracefulEnd checks that an LLM error causes a graceful
// <Hangup/> response and marks the errand completed.
func TestErrandTurn_LLMError_GracefulEnd(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	t.Setenv("LANTERN_TWILIO_WEBHOOK_AUTH", "off")
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	id := seedPlacedErrand(t, pool, tenant, "+15125559905", "order flowers")

	fn := func(_ context.Context, _, _, _ string) (string, error) {
		return "", errors.New("llm unavailable")
	}
	h := newErrandHandlerWithCompleter(t, pool, fn)

	rr := doErrandTurn(t, h, id, url.Values{"SpeechResult": {"who is calling?"}})
	if rr.Code != http.StatusOK {
		t.Fatalf("ErrandTurn LLM error: got %d; body: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(strings.ToLower(rr.Body.String()), "<hangup") {
		t.Errorf("LLM error: response should contain <Hangup/>; got: %s", rr.Body.String())
	}

	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM errands WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "completed" {
		t.Errorf("status=%q, want 'completed'", status)
	}
}

// TestErrandTurn_BadSignature_403 verifies that a request with a wrong
// X-Twilio-Signature (when an authToken IS configured) returns 403.
func TestErrandTurn_BadSignature_403(t *testing.T) {
	t.Setenv("LANTERN_ERRAND", "1")
	// Do NOT set LANTERN_TWILIO_WEBHOOK_AUTH=off — signature verification must run.
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenant := seedErrandTenant(t, pool)
	id := seedPlacedErrand(t, pool, tenant, "+15125559906", "test signature check")

	// Seed a real (known) auth token so loadDecryptedConfig returns it.
	seedTwilioConnector(t, pool, tenant, "real-auth-token-abc123")

	h := newErrandHandlerWithCompleter(t, pool, nil)

	body := url.Values{"SpeechResult": {"hello"}}.Encode()
	req := httptest.NewRequest(http.MethodPost, "/v1/voice/errand/turn/"+id, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Twilio-Signature", "bad-signature-value")
	req.SetPathValue("id", id)
	rr := httptest.NewRecorder()
	h.ErrandTurn(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("bad signature: got %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}
