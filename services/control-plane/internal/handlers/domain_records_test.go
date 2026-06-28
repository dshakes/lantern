package handlers

// Tests for domain_records (CRUD + RLS + encryption) and runDomainTracker /
// processDomainMessages (extraction + commit + cursor + idempotency).
//
// DB-backed tests skip cleanly when DATABASE_URL is unset.
//
//	TestDomainRecord_CRUD               — create, list-decrypt, update, delete
//	TestDomainRecord_RLS_*              — cross-tenant 404 / list zero
//	TestDomainRecord_EncryptionRoundTrip — write encrypted, read decrypted
//	TestProcessDomainMessages_*         — extraction + cursor + idempotency
//	TestSeedLoopAgents_DomainTrackers   — care-coordinator/garage/upskill seeded

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ----------------------- helpers -----------------------

// domainTenant creates a fresh tenant for domain-record tests.
func domainTenant(t *testing.T) string {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()
	id := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Domain Test', 'personal', 'ns-dr-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, "dr-"+id[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM domain_records WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM commitments     WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM gmail_poll_cursors WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants         WHERE id        = $1::uuid", id)
	})
	return id
}

// newDomainHandler builds a handler under the real (privileged superuser) pool.
func newDomainHandler(t *testing.T) *DomainRecordHandler {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	srv := &server.Server{Pool: pool, Logger: nopLogger()}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewDomainRecordHandler(srv, auth)
}

// postDomainRecord issues POST /v1/domain-records.
func postDomainRecord(t *testing.T, h *DomainRecordHandler, tenantID string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/domain-records", strings.NewReader(string(b)))
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "owner-1", "owner")))
	rr := httptest.NewRecorder()
	h.CreateDomainRecord(rr, req)
	return rr
}

// listDomainRecords issues GET /v1/domain-records?domain=&kind=.
func listDomainRecords(t *testing.T, h *DomainRecordHandler, tenantID, domain, kind string) []domainRecordJSON {
	t.Helper()
	url := "/v1/domain-records"
	params := []string{}
	if domain != "" {
		params = append(params, "domain="+domain)
	}
	if kind != "" {
		params = append(params, "kind="+kind)
	}
	if len(params) > 0 {
		url += "?" + strings.Join(params, "&")
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "owner-1", "owner")))
	rr := httptest.NewRecorder()
	h.ListDomainRecords(rr, req)
	var items []domainRecordJSON
	_ = json.Unmarshal(rr.Body.Bytes(), &items)
	return items
}

// ----------------------- CRUD -----------------------

// TestDomainRecord_CRUD exercises the full lifecycle under the superuser pool
// (non-enforced, same as the commitments CRUD tests).
func TestDomainRecord_CRUD(t *testing.T) {
	h := newDomainHandler(t)
	tenant := domainTenant(t)

	// POST — create with fields JSON.
	fields := map[string]any{"doctor": "Dr. Smith", "date": "2026-07-15"}
	fieldsJSON, _ := json.Marshal(fields)
	rr := postDomainRecord(t, h, tenant, map[string]any{
		"domain":         "health",
		"kind":           "appointment",
		"title":          "Cardiology checkup",
		"fields":         json.RawMessage(fieldsJSON),
		"source":         "manual",
		"validUntil":     "2026-07-15",
		"idempotencyKey": "test-apt-1",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: got %d; body: %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("decode create response: %v; body: %s", err, rr.Body.String())
	}

	// GET list — decrypted fields should match what we stored.
	items := listDomainRecords(t, h, tenant, "health", "")
	if len(items) != 1 {
		t.Fatalf("list: got %d items, want 1", len(items))
	}
	if items[0].Title != "Cardiology checkup" {
		t.Errorf("title=%q, want 'Cardiology checkup'", items[0].Title)
	}
	if items[0].Domain != "health" {
		t.Errorf("domain=%q, want 'health'", items[0].Domain)
	}
	// Verify fields decryption — doctor key must be present.
	if len(items[0].Fields) == 0 {
		t.Error("fields are empty after decrypt, want populated JSON")
	}
	var gotFields map[string]any
	if err := json.Unmarshal(items[0].Fields, &gotFields); err != nil {
		t.Fatalf("decode fields: %v", err)
	}
	if gotFields["doctor"] != "Dr. Smith" {
		t.Errorf("fields.doctor=%v, want 'Dr. Smith'", gotFields["doctor"])
	}

	// PUT — update title.
	updateBody, _ := json.Marshal(map[string]any{"title": "Cardiology follow-up"})
	putReq := httptest.NewRequest(http.MethodPut, "/v1/domain-records/"+created.ID, strings.NewReader(string(updateBody)))
	putReq.SetPathValue("id", created.ID)
	putReq.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "owner-1", "owner")))
	putRR := httptest.NewRecorder()
	h.UpdateDomainRecord(putRR, putReq)
	if putRR.Code != http.StatusOK {
		t.Fatalf("update: got %d; body: %s", putRR.Code, putRR.Body.String())
	}

	// Confirm update.
	items2 := listDomainRecords(t, h, tenant, "health", "")
	if len(items2) != 1 || items2[0].Title != "Cardiology follow-up" {
		t.Errorf("after update: title=%q, want 'Cardiology follow-up'", func() string {
			if len(items2) > 0 {
				return items2[0].Title
			}
			return "<none>"
		}())
	}

	// DELETE.
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/domain-records/"+created.ID, nil)
	delReq.SetPathValue("id", created.ID)
	delReq.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "owner-1", "owner")))
	delRR := httptest.NewRecorder()
	h.DeleteDomainRecord(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d; body: %s", delRR.Code, delRR.Body.String())
	}

	// Confirm gone.
	if got := listDomainRecords(t, h, tenant, "health", ""); len(got) != 0 {
		t.Errorf("after delete: list returned %d rows, want 0", len(got))
	}
}

// TestDomainRecord_CrossTenantBlocked verifies cross-tenant isolation:
// tenant B cannot list or delete tenant A's records (404/empty).
func TestDomainRecord_CrossTenantBlocked(t *testing.T) {
	h := newDomainHandler(t)
	tenantA := domainTenant(t)
	tenantB := domainTenant(t)

	// Seed a record for tenant A.
	rr := postDomainRecord(t, h, tenantA, map[string]any{
		"domain": "health", "kind": "medication", "title": "Aspirin 81mg",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("seed: %d; %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	// Tenant B list → empty.
	if got := listDomainRecords(t, h, tenantB, "health", ""); len(got) != 0 {
		t.Errorf("ISOLATION: tenant B sees %d of tenant A's records, want 0", len(got))
	}

	// Tenant B DELETE → 404.
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/domain-records/"+created.ID, nil)
	delReq.SetPathValue("id", created.ID)
	delReq.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantB, "user-b", "owner")))
	delRR := httptest.NewRecorder()
	h.DeleteDomainRecord(delRR, delReq)
	if delRR.Code != http.StatusNotFound {
		t.Errorf("cross-tenant DELETE: got %d, want 404", delRR.Code)
	}
}

// TestDomainRecord_Idempotent verifies that creating the same idempotency key
// twice updates (UPSERT) rather than duplicating.
func TestDomainRecord_Idempotent(t *testing.T) {
	h := newDomainHandler(t)
	tenant := domainTenant(t)

	key := "idem-test-" + uuid.NewString()[:8]
	for i := 0; i < 2; i++ {
		rr := postDomainRecord(t, h, tenant, map[string]any{
			"domain":         "vehicle",
			"kind":           "insurance",
			"title":          fmt.Sprintf("GEICO Policy (update %d)", i),
			"idempotencyKey": key,
		})
		if rr.Code != http.StatusCreated {
			t.Fatalf("insert %d: got %d; body: %s", i, rr.Code, rr.Body.String())
		}
	}

	// Must be exactly one row.
	items := listDomainRecords(t, h, tenant, "vehicle", "")
	if len(items) != 1 {
		t.Errorf("idempotent upsert: got %d rows, want 1", len(items))
	}
}

// TestDomainRecord_ValidationErrors checks required-field and enum validation.
func TestDomainRecord_ValidationErrors(t *testing.T) {
	h := newDomainHandler(t)
	tenant := domainTenant(t)

	cases := []struct {
		body map[string]any
		want int
	}{
		{map[string]any{"domain": "bad", "kind": "x", "title": "t"}, http.StatusBadRequest},
		{map[string]any{"domain": "health", "kind": "", "title": "t"}, http.StatusBadRequest},
		{map[string]any{"domain": "health", "kind": "x", "title": ""}, http.StatusBadRequest},
		{map[string]any{"domain": "health", "kind": "x", "title": "t", "source": "invalid"}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		rr := postDomainRecord(t, h, tenant, tc.body)
		if rr.Code != tc.want {
			t.Errorf("body=%v: got %d, want %d; resp: %s", tc.body, rr.Code, tc.want, rr.Body.String())
		}
	}
}

// ----------------------- processDomainMessages -----------------------

// TestProcessDomainMessages_ExtractsAndCommits verifies that processDomainMessages
// upserts domain_records (with encrypted fields) and creates commitments for
// obligations when given a stubbed extractor returning 2 records + 1 obligation.
func TestProcessDomainMessages_ExtractsAndCommits(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := domainTenant(t)
	runID := insertBodyRun(t, pool, tenant, "domain-tracker-test-extract")

	msgs := []GmailMessage{
		{
			ID:           "health-msg-001",
			InternalDate: "1750000100000",
			From:         "labcorp@results.com",
			Subject:      "Your Lab Results Are Ready",
			Snippet:      "Cholesterol: 195 mg/dL (normal). Follow-up appointment recommended.",
		},
	}

	// Stub extractor returns 2 records + 1 obligation.
	stubExtraction := `{
		"records": [
			{"kind": "lab_result", "title": "Cholesterol panel", "fields": {"value": "195 mg/dL", "status": "normal"}},
			{"kind": "appointment", "title": "Follow-up appointment", "validUntil": "2026-09-01"}
		],
		"obligations": [
			{"title": "Schedule follow-up with PCP", "dueDate": "2026-08-01", "kind": "appointment"}
		]
	}`
	stubCompleteFn := func(_ context.Context, _, _, _ string) (string, error) {
		return stubExtraction, nil
	}

	recN, oblN, err := processDomainMessages(ctx, pool, nopLogger(), tenant, runID,
		"health", msgs, "", stubCompleteFn)
	if err != nil {
		t.Fatalf("processDomainMessages: %v", err)
	}
	if recN != 2 {
		t.Errorf("recN=%d, want 2", recN)
	}
	if oblN != 1 {
		t.Errorf("oblN=%d, want 1", oblN)
	}

	// Assert domain_records rows exist.
	var recCount int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM domain_records WHERE tenant_id = $1 AND domain = 'health'`,
		tenant,
	).Scan(&recCount); err != nil {
		t.Fatalf("count domain_records: %v", err)
	}
	if recCount != 2 {
		t.Errorf("domain_records count=%d, want 2", recCount)
	}

	// Assert fields_encrypted is set (non-empty) for the lab_result row.
	var fieldsEnc *string
	_ = pool.QueryRow(ctx,
		`SELECT fields_encrypted FROM domain_records WHERE tenant_id = $1 AND kind = 'lab_result'`,
		tenant,
	).Scan(&fieldsEnc)
	if fieldsEnc == nil || *fieldsEnc == "" {
		t.Error("fields_encrypted is empty for lab_result — encryption not applied")
	}

	// Assert commitment for the obligation.
	var oblCount int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM commitments WHERE tenant_id = $1 AND source = 'health'`,
		tenant,
	).Scan(&oblCount); err != nil {
		t.Fatalf("count commitments: %v", err)
	}
	if oblCount != 1 {
		t.Errorf("commitments count=%d, want 1", oblCount)
	}

	// Assert cursor was advanced for domain='health'.
	var cursor string
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'health'`,
		tenant,
	).Scan(&cursor); err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if cursor != "1750000100000" {
		t.Errorf("cursor=%q, want '1750000100000'", cursor)
	}
}

// TestProcessDomainMessages_Idempotent verifies that re-running with the same
// messages creates zero new records/obligations (ON CONFLICT DO NOTHING guard).
func TestProcessDomainMessages_Idempotent(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := domainTenant(t)
	runID := insertBodyRun(t, pool, tenant, "domain-tracker-idem")

	msgs := []GmailMessage{
		{ID: "idem-msg-1", InternalDate: "1750000200000",
			From: "clinic@health.com", Subject: "Appointment Confirmation", Snippet: "Confirmed for July 15"},
	}
	stub := func(_ context.Context, _, _, _ string) (string, error) {
		return `{"records":[{"kind":"appointment","title":"Clinic visit","fields":{}}],"obligations":[]}`, nil
	}

	r1, _, _ := processDomainMessages(ctx, pool, nopLogger(), tenant, runID, "health", msgs, "", stub)
	if r1 != 1 {
		t.Fatalf("first run: recN=%d, want 1", r1)
	}

	// Second run: same messages, reset cursor to "" to force re-processing;
	// the DB idempotency key must block duplicates.
	r2, _, _ := processDomainMessages(ctx, pool, nopLogger(), tenant, runID, "health", msgs, "", stub)
	if r2 != 0 {
		t.Errorf("second run: recN=%d, want 0 (idempotency guard)", r2)
	}

	// Still only 1 row.
	var count int
	_ = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM domain_records WHERE tenant_id = $1 AND domain = 'health'`,
		tenant,
	).Scan(&count)
	if count != 1 {
		t.Errorf("record count=%d, want 1", count)
	}
}

// TestProcessDomainMessages_CursorFilters verifies messages at or before the
// stored cursor are skipped.
func TestProcessDomainMessages_CursorFilters(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := domainTenant(t)
	runID := insertBodyRun(t, pool, tenant, "domain-tracker-cursor-filter")

	msgs := []GmailMessage{
		{ID: "old-msg", InternalDate: "1750000000100", From: "a@b.com", Subject: "Old"},
	}
	stub := func(_ context.Context, _, _, _ string) (string, error) {
		return `{"records":[{"kind":"report","title":"Old result","fields":{}}],"obligations":[]}`, nil
	}

	// Cursor is already past the message.
	recN, oblN, err := processDomainMessages(ctx, pool, nopLogger(), tenant, runID,
		"health", msgs, "1750000000200", stub)
	if err != nil {
		t.Fatalf("processDomainMessages: %v", err)
	}
	if recN != 0 || oblN != 0 {
		t.Errorf("recN=%d oblN=%d, want 0/0 (all before cursor)", recN, oblN)
	}
}

// TestProcessDomainMessages_NilLLM verifies graceful no-op when completeFn is nil.
func TestProcessDomainMessages_NilLLM(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := domainTenant(t)
	runID := insertBodyRun(t, pool, tenant, "domain-tracker-nil-llm")

	msgs := []GmailMessage{
		{ID: "no-llm-msg", InternalDate: "1750000300000", From: "a@b.com", Subject: "Test"},
	}

	recN, oblN, err := processDomainMessages(ctx, pool, nopLogger(), tenant, runID,
		"health", msgs, "", nil /* nil completeFn */)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if recN != 0 || oblN != 0 {
		t.Errorf("nil LLM: recN=%d oblN=%d, want 0/0", recN, oblN)
	}

	// Cursor still advanced (the message was seen, even if no records extracted).
	var cursor string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'health'`,
		tenant,
	).Scan(&cursor)
	if cursor != "1750000300000" {
		t.Errorf("cursor=%q, want '1750000300000' (message was seen)", cursor)
	}
}

// TestProcessDomainMessages_DomainCursorIsolation proves the per-domain cursor
// is independent: a 'health' sweep does not advance the 'vehicle' cursor.
func TestProcessDomainMessages_DomainCursorIsolation(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenant := domainTenant(t)
	runID := insertBodyRun(t, pool, tenant, "domain-cursor-isolation")

	msgs := []GmailMessage{
		{ID: "h-msg-1", InternalDate: "1750000400000", From: "lab@h.com", Subject: "Lab"},
	}
	processDomainMessages(ctx, pool, nopLogger(), tenant, runID, "health", msgs, "", nil) //nolint

	// 'health' cursor set.
	var healthCursor string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date,'') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'health'`,
		tenant,
	).Scan(&healthCursor)
	if healthCursor == "" {
		t.Error("health cursor not set")
	}

	// 'vehicle' cursor NOT set.
	var vehicleCursor string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date,'') FROM gmail_poll_cursors WHERE tenant_id = $1 AND domain = 'vehicle'`,
		tenant,
	).Scan(&vehicleCursor)
	if vehicleCursor != "" {
		t.Errorf("vehicle cursor should be empty but got %q", vehicleCursor)
	}
}

// ----------------------- SeedLoopAgents -----------------------

// TestSeedLoopAgents_DomainTrackers verifies that all 5 domain-tracker seeds
// (care-coordinator, garage, upskill, travel-concierge, household) are created idempotently.
func TestSeedLoopAgents_DomainTrackers(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	// SeedLoopAgents should be idempotent — run twice.
	SeedLoopAgents(ctx, pool, nopLogger())
	SeedLoopAgents(ctx, pool, nopLogger())

	const devTenantID = "00000000-0000-0000-0000-000000000001"

	type wantAgent struct {
		name   string
		domain string
	}
	agents := []wantAgent{
		{"care-coordinator", "health"},
		{"garage", "vehicle"},
		{"upskill", "career"},
		{"travel-concierge", "travel"},
		{"household", "home"},
	}

	for _, want := range agents {
		var agentID string
		if err := pool.QueryRow(ctx,
			`SELECT id FROM agents WHERE tenant_id = $1 AND name = $2`,
			devTenantID, want.name,
		).Scan(&agentID); err != nil {
			t.Errorf("seed agent %q not found: %v", want.name, err)
			continue
		}

		// Manifest must have role=domain_tracker, correct domain, non-empty query, Coach=true.
		var manifestJSON []byte
		_ = pool.QueryRow(ctx, `
			SELECT av.manifest
			FROM agent_versions av
			JOIN agents a ON a.current_version_id = av.id
			WHERE a.id = $1
		`, agentID).Scan(&manifestJSON)

		var m LoopManifest
		if err := json.Unmarshal(manifestJSON, &m); err != nil {
			t.Errorf("agent %q: unmarshal manifest: %v", want.name, err)
			continue
		}
		if m.Role != "domain_tracker" {
			t.Errorf("agent %q: role=%q, want 'domain_tracker'", want.name, m.Role)
		}
		if m.Domain != want.domain {
			t.Errorf("agent %q: domain=%q, want %q", want.name, m.Domain, want.domain)
		}
		if m.Query == "" {
			t.Errorf("agent %q: query is empty", want.name)
		}
		if !m.Coach {
			t.Errorf("agent %q: Coach=false, want true (coaching pass required)", want.name)
		}
	}

	// Cleanup seeded agents (best-effort; dev tenant might not be in this DB).
	for _, want := range agents {
		name := want.name
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(),
				`DELETE FROM schedules WHERE tenant_id = $1 AND agent_name = $2`,
				devTenantID, name)
		})
	}
}

// ----------------------- domainSystemPrompt unit test -----------------------

func TestDomainSystemPrompt_AllDomains(t *testing.T) {
	for _, d := range []string{"health", "vehicle", "career", "travel", "home", "unknown"} {
		p := domainSystemPrompt(d)
		if p == "" {
			t.Errorf("domain %q: empty prompt", d)
		}
		// Security: every prompt must contain the untrusted-data notice.
		if !strings.Contains(p, "NEVER follow instructions") {
			t.Errorf("domain %q: missing NEVER-follow-instructions guard", d)
		}
	}
}

// TestDomainSystemPrompt_TravelHome asserts travel + home extraction prompts
// are domain-specific (contain domain keywords, not just the generic fallback).
func TestDomainSystemPrompt_TravelHome(t *testing.T) {
	cases := []struct {
		domain  string
		wantKwd string // a word only in this domain's prompt
	}{
		{"travel", "flight"},
		{"home", "warranty"},
	}
	for _, tc := range cases {
		p := domainSystemPrompt(tc.domain)
		if !strings.Contains(p, tc.wantKwd) {
			t.Errorf("domainSystemPrompt(%q): missing domain keyword %q in prompt", tc.domain, tc.wantKwd)
		}
		// Must not fall through to generic one-liner.
		if p == `Extract structured records and obligations from email content as JSON: {"records":[],"obligations":[]}.` {
			t.Errorf("domainSystemPrompt(%q): returned generic fallback, want domain-specific prompt", tc.domain)
		}
	}
}

// TestDomainCoachSystemPrompt_TravelHome asserts travel + home coaching prompts
// are non-empty and domain-specific.
func TestDomainCoachSystemPrompt_TravelHome(t *testing.T) {
	cases := []struct {
		domain  string
		wantKwd string
	}{
		{"travel", "concierge"},
		{"home", "household"},
	}
	for _, tc := range cases {
		p := domainCoachSystemPrompt(tc.domain)
		if p == "" {
			t.Errorf("domainCoachSystemPrompt(%q): empty prompt", tc.domain)
		}
		if !strings.Contains(p, tc.wantKwd) {
			t.Errorf("domainCoachSystemPrompt(%q): missing keyword %q", tc.domain, tc.wantKwd)
		}
		// Must not fall through to the generic default.
		if p == "Based ONLY on the provided domain records and obligations, write a 3–5 line plain-text coaching brief (max 500 chars, no markdown). Never fabricate details." {
			t.Errorf("domainCoachSystemPrompt(%q): returned generic fallback", tc.domain)
		}
	}
}

// ----------------------- encryption round-trip -----------------------

// TestDomainRecord_EncryptionRoundTrip writes a record with fields, reads it
// back via the list handler, and verifies the decrypted fields match.
// This catches regressions where Encrypt/Decrypt diverge in the handler path.
func TestDomainRecord_EncryptionRoundTrip(t *testing.T) {
	h := newDomainHandler(t)
	tenant := domainTenant(t)

	original := map[string]any{
		"medication": "Metformin 500mg",
		"frequency":  "twice daily",
		"prescriber": "Dr. Patel",
		"started":    "2026-01-01",
	}
	fieldsJSON, _ := json.Marshal(original)

	rr := postDomainRecord(t, h, tenant, map[string]any{
		"domain": "health", "kind": "medication",
		"title":  "Metformin",
		"fields": json.RawMessage(fieldsJSON),
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d; %s", rr.Code, rr.Body.String())
	}

	items := listDomainRecords(t, h, tenant, "health", "medication")
	if len(items) != 1 {
		t.Fatalf("list: got %d items, want 1", len(items))
	}

	var got map[string]any
	if err := json.Unmarshal(items[0].Fields, &got); err != nil {
		t.Fatalf("decode decrypted fields: %v", err)
	}
	for k, want := range original {
		if got[k] != want {
			t.Errorf("fields[%q]=%v, want %v", k, got[k], want)
		}
	}
}

// ----------------------- RLS enforcement -----------------------

// TestRLSDomainRecords_SameTenantWorks proves create+list under the
// RLS-enforced AppPool (lantern_app role).
func TestRLSDomainRecords_SameTenantWorks(t *testing.T) {
	e := newEnforcedServer(t)
	auth := NewAuthHandler(e.srv, testJWTSecret)
	h := NewDomainRecordHandler(e.srv, auth)

	tenant := seedEnforcedTenant(t, e, "rls-dr-"+uuid.NewString()[:8])

	rr := postDomainRecord(t, h, tenant, map[string]any{
		"domain": "vehicle", "kind": "service", "title": "Oil change",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("REGRESSION: same-tenant create under RLS failed: %d; %s", rr.Code, rr.Body.String())
	}

	items := listDomainRecords(t, h, tenant, "vehicle", "")
	if len(items) != 1 {
		t.Fatalf("REGRESSION: same-tenant list under RLS returned %d rows, want 1", len(items))
	}
}

// TestRLSDomainRecords_CrossTenantBlocked proves cross-tenant isolation
// via the AppPool (genuinely enforced by Postgres RLS).
func TestRLSDomainRecords_CrossTenantBlocked(t *testing.T) {
	e := newEnforcedServer(t)
	auth := NewAuthHandler(e.srv, testJWTSecret)
	h := NewDomainRecordHandler(e.srv, auth)

	tenantA := seedEnforcedTenant(t, e, "rls-dr-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-dr-b-"+uuid.NewString()[:8])

	// Create under tenant A.
	rr := postDomainRecord(t, h, tenantA, map[string]any{
		"domain": "health", "kind": "medication", "title": "Private RX",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("seed: %d; %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	// Tenant B list → zero rows.
	if got := listDomainRecords(t, h, tenantB, "health", ""); len(got) != 0 {
		t.Errorf("SECURITY: tenant B sees %d of tenant A's records, want 0", len(got))
	}

	// Tenant B DELETE → 404.
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/domain-records/"+created.ID, nil)
	delReq.SetPathValue("id", created.ID)
	delReq.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantB, "user-b", "owner")))
	delRR := httptest.NewRecorder()
	h.DeleteDomainRecord(delRR, delReq)
	if delRR.Code != http.StatusNotFound {
		t.Errorf("cross-tenant DELETE: got %d, want 404", delRR.Code)
	}
}

// ----------------------- time compile check -----------------------

var _ = time.Now // keep time import alive for test helpers that may use it
