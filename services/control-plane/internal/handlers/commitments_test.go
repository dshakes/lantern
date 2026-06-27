package handlers

// DB-backed tests for the commitment store + REST API. They skip cleanly when
// DATABASE_URL is unset (openTestPool / newEnforcedServer skip, never fail).
//
// Two layers:
//   - TestCommitment_* : handler-level behaviour over a real pool (create, list,
//     get, update, idempotency upsert, done/dismiss/snooze transitions, filter by
//     status/tier, cross-tenant 404).
//   - TestRLSCommitments_* : enforcement-on proof via the lantern_app-backed
//     harness — same-tenant read/write works, cross-tenant is blocked at Postgres.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newTestCommitmentHandler builds a CommitmentHandler backed by a real
// (privileged superuser) pool — RLS GUC-scoped through WithTenant.
func newTestCommitmentHandler(t *testing.T, pool *pgxpool.Pool) *CommitmentHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewCommitmentHandler(srv, auth)
}

// seedCommitmentTenant inserts a minimal tenant and registers cleanup.
func seedCommitmentTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "cm-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Commitment Test', 'personal', 'ns-cm-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM commitments WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants WHERE id = $1::uuid", id)
	})
	return id
}

// postCommitment fires POST /v1/commitments as the given tenant.
func postCommitment(t *testing.T, h *CommitmentHandler, tenant string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/commitments", strings.NewReader(string(b)))
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.CreateCommitment(rr, req)
	return rr
}

// listCommitments fires GET /v1/commitments?<query> as the given tenant.
func listCommitments(t *testing.T, h *CommitmentHandler, tenant, query string) []commitmentJSON {
	t.Helper()
	url := "/v1/commitments"
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.ListCommitments(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list commitments: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var out []commitmentJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list response: %v; body: %s", err, rr.Body.String())
	}
	return out
}

// getCommitment fires GET /v1/commitments/{id}.
func getCommitment(t *testing.T, h *CommitmentHandler, tenant, id string) (commitmentJSON, int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/commitments/"+id, nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.GetCommitment(rr, req)
	if rr.Code != http.StatusOK {
		return commitmentJSON{}, rr.Code
	}
	var out commitmentJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode get response: %v; body: %s", err, rr.Body.String())
	}
	return out, rr.Code
}

// commitmentTransition fires POST /v1/commitments/{id}/{action}.
func commitmentTransition(t *testing.T, h *CommitmentHandler, tenant, id, action string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *strings.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	} else {
		r = strings.NewReader("")
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+id+"/"+action, r)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	switch action {
	case "done":
		h.DoneCommitment(rr, req)
	case "dismiss":
		h.DismissCommitment(rr, req)
	case "snooze":
		h.SnoozeCommitment(rr, req)
	}
	return rr
}

// createdID is a helper that extracts the id from a 201 response.
func createdID(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil || resp.ID == "" {
		t.Fatalf("missing id in response: %v; body: %s", err, rr.Body.String())
	}
	return resp.ID
}

// ---------- Tests ----------

// TestCommitment_CreateAndList happy path: create one commitment, list it back.
func TestCommitment_CreateAndList(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenant := seedCommitmentTenant(t, pool)

	rr := postCommitment(t, h, tenant, map[string]any{
		"title":         "File Q2 tax return",
		"source":        "self",
		"kind":          "legal",
		"tier":          "macro",
		"urgency":       "soon",
		"sourcePreview": "Don't forget taxes due July",
	})
	id := createdID(t, rr)

	items := listCommitments(t, h, tenant, "")
	if len(items) != 1 {
		t.Fatalf("expected 1 commitment, got %d", len(items))
	}
	c := items[0]
	if c.ID != id {
		t.Errorf("id mismatch: feed=%q created=%q", c.ID, id)
	}
	if c.Title != "File Q2 tax return" {
		t.Errorf("title=%q, want 'File Q2 tax return'", c.Title)
	}
	if c.Source != "self" || c.Kind != "legal" || c.Tier != "macro" || c.Urgency != "soon" {
		t.Errorf("unexpected fields: source=%q kind=%q tier=%q urgency=%q", c.Source, c.Kind, c.Tier, c.Urgency)
	}
	if c.Status != "open" {
		t.Errorf("expected default status 'open', got %q", c.Status)
	}
	if c.SourcePreview != "Don't forget taxes due July" {
		t.Errorf("sourcePreview=%q", c.SourcePreview)
	}
}

// TestCommitment_Defaults verifies tier and urgency defaults apply.
func TestCommitment_Defaults(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenant := seedCommitmentTenant(t, pool)

	rr := postCommitment(t, h, tenant, map[string]any{
		"title":  "Buy birthday card",
		"source": "self",
	})
	id := createdID(t, rr)

	c, code := getCommitment(t, h, tenant, id)
	if code != http.StatusOK {
		t.Fatalf("get: %d", code)
	}
	if c.Tier != "meso" {
		t.Errorf("default tier=%q, want 'meso'", c.Tier)
	}
	if c.Urgency != "normal" {
		t.Errorf("default urgency=%q, want 'normal'", c.Urgency)
	}
}

// TestCommitment_TenantScoped proves tenant B cannot see tenant A's commitments.
func TestCommitment_TenantScoped(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenantA := seedCommitmentTenant(t, pool)
	tenantB := seedCommitmentTenant(t, pool)

	rr := postCommitment(t, h, tenantA, map[string]any{
		"title": "Call plumber", "source": "spouse",
	})
	id := createdID(t, rr)

	if got := listCommitments(t, h, tenantA, ""); len(got) != 1 {
		t.Errorf("tenant A should see its own commitment, got %d", len(got))
	}
	if got := listCommitments(t, h, tenantB, ""); len(got) != 0 {
		t.Errorf("SECURITY: tenant B saw %d of tenant A's commitments, want 0", len(got))
	}

	// Cross-tenant GET → 404.
	if _, code := getCommitment(t, h, tenantB, id); code != http.StatusNotFound {
		t.Errorf("cross-tenant get: got %d, want 404", code)
	}
}

// TestCommitment_IdempotencyUpsert verifies a re-capture with the same key
// returns the same id rather than creating a duplicate row.
func TestCommitment_IdempotencyUpsert(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenant := seedCommitmentTenant(t, pool)

	key := "wa-task-" + uuid.NewString()
	rr1 := postCommitment(t, h, tenant, map[string]any{
		"title": "Renew passport", "source": "self", "idempotencyKey": key,
	})
	id1 := createdID(t, rr1)

	// Re-emit same key (updated urgency should NOT change status — UPSERT keeps existing).
	rr2 := postCommitment(t, h, tenant, map[string]any{
		"title": "Renew passport", "source": "self",
		"urgency": "now", "idempotencyKey": key,
	})
	id2 := createdID(t, rr2)

	if id1 != id2 {
		t.Errorf("idempotent re-capture returned a different id: %q vs %q", id1, id2)
	}

	items := listCommitments(t, h, tenant, "")
	if len(items) != 1 {
		t.Fatalf("expected 1 row after idempotent re-capture, got %d", len(items))
	}
}

// TestCommitment_StatusFilters verifies ?status= and ?tier= query params work.
func TestCommitment_StatusFilters(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenant := seedCommitmentTenant(t, pool)

	id1 := createdID(t, postCommitment(t, h, tenant, map[string]any{
		"title": "Task A", "source": "self", "tier": "nano",
	}))
	_ = createdID(t, postCommitment(t, h, tenant, map[string]any{
		"title": "Task B", "source": "self", "tier": "mega",
	}))

	// Mark id1 done so we have two different statuses.
	if rr := commitmentTransition(t, h, tenant, id1, "done", nil); rr.Code != http.StatusOK {
		t.Fatalf("done: %d; body: %s", rr.Code, rr.Body.String())
	}

	openItems := listCommitments(t, h, tenant, "status=open")
	if len(openItems) != 1 {
		t.Errorf("?status=open: expected 1, got %d", len(openItems))
	}

	doneItems := listCommitments(t, h, tenant, "status=done")
	if len(doneItems) != 1 || doneItems[0].ID != id1 {
		t.Errorf("?status=done: expected 1 with id %q, got %d", id1, len(doneItems))
	}

	nanoItems := listCommitments(t, h, tenant, "tier=nano")
	if len(nanoItems) != 1 || nanoItems[0].Status != "done" {
		t.Errorf("?tier=nano: expected 1 done item, got %d", len(nanoItems))
	}

	megaItems := listCommitments(t, h, tenant, "tier=mega")
	if len(megaItems) != 1 {
		t.Errorf("?tier=mega: expected 1, got %d", len(megaItems))
	}
}

// TestCommitment_Transitions covers done/dismiss/snooze and cross-tenant 404.
func TestCommitment_Transitions(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenantA := seedCommitmentTenant(t, pool)
	tenantB := seedCommitmentTenant(t, pool)

	mk := func() string {
		return createdID(t, postCommitment(t, h, tenantA, map[string]any{
			"title": "Task", "source": "vip",
		}))
	}

	// done
	id := mk()
	if rr := commitmentTransition(t, h, tenantA, id, "done", nil); rr.Code != http.StatusOK {
		t.Fatalf("done: %d; body: %s", rr.Code, rr.Body.String())
	}
	if got, _ := getCommitment(t, h, tenantA, id); got.Status != "done" {
		t.Errorf("after done, status=%q, want 'done'", got.Status)
	}

	// dismiss
	id2 := mk()
	if rr := commitmentTransition(t, h, tenantA, id2, "dismiss", nil); rr.Code != http.StatusOK {
		t.Fatalf("dismiss: %d; body: %s", rr.Code, rr.Body.String())
	}
	if got, _ := getCommitment(t, h, tenantA, id2); got.Status != "dismissed" {
		t.Errorf("after dismiss, status=%q, want 'dismissed'", got.Status)
	}

	// snooze with until
	id3 := mk()
	until := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	if rr := commitmentTransition(t, h, tenantA, id3, "snooze", map[string]string{"until": until}); rr.Code != http.StatusOK {
		t.Fatalf("snooze: %d; body: %s", rr.Code, rr.Body.String())
	}
	if got, _ := getCommitment(t, h, tenantA, id3); got.Status != "snoozed" || got.NextNudgeAt == "" {
		t.Errorf("after snooze: status=%q nextNudgeAt=%q", got.Status, got.NextNudgeAt)
	}

	// cross-tenant transitions → 404
	id4 := mk()
	for _, action := range []string{"done", "dismiss"} {
		if rr := commitmentTransition(t, h, tenantB, id4, action, nil); rr.Code != http.StatusNotFound {
			t.Errorf("cross-tenant %s: got %d, want 404", action, rr.Code)
		}
	}
	if rr := commitmentTransition(t, h, tenantB, id4, "snooze", map[string]string{"until": until}); rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant snooze: got %d, want 404", rr.Code)
	}
}

// TestCommitment_Update verifies PUT /v1/commitments/{id} updates mutable fields.
func TestCommitment_Update(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenantA := seedCommitmentTenant(t, pool)
	tenantB := seedCommitmentTenant(t, pool)

	id := createdID(t, postCommitment(t, h, tenantA, map[string]any{
		"title": "Draft proposal", "source": "self", "tier": "micro",
	}))

	// Update tier + urgency.
	b, _ := json.Marshal(map[string]any{"tier": "macro", "urgency": "now", "status": "in_progress"})
	req := httptest.NewRequest(http.MethodPut, "/v1/commitments/"+id, strings.NewReader(string(b)))
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantA, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.UpdateCommitment(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("update: %d; body: %s", rr.Code, rr.Body.String())
	}

	got, code := getCommitment(t, h, tenantA, id)
	if code != http.StatusOK {
		t.Fatalf("get after update: %d", code)
	}
	if got.Tier != "macro" || got.Urgency != "now" || got.Status != "in_progress" {
		t.Errorf("update not reflected: tier=%q urgency=%q status=%q", got.Tier, got.Urgency, got.Status)
	}

	// Cross-tenant PUT → 404.
	req2 := httptest.NewRequest(http.MethodPut, "/v1/commitments/"+id, strings.NewReader(`{"tier":"nano"}`))
	req2.SetPathValue("id", id)
	req2.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantB, "user-x", "owner")))
	rr2 := httptest.NewRecorder()
	h.UpdateCommitment(rr2, req2)
	if rr2.Code != http.StatusNotFound {
		t.Errorf("cross-tenant update: got %d, want 404", rr2.Code)
	}
}

// TestCommitment_ValidationErrors covers required-field and enum validation.
func TestCommitment_ValidationErrors(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenant := seedCommitmentTenant(t, pool)

	cases := []struct {
		name string
		body map[string]any
	}{
		{"missing title", map[string]any{"source": "self"}},
		{"missing source", map[string]any{"title": "x"}},
		{"bad tier", map[string]any{"title": "x", "source": "self", "tier": "huge"}},
		{"bad urgency", map[string]any{"title": "x", "source": "self", "urgency": "critical"}},
		{"bad source", map[string]any{"title": "x", "source": "wat"}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			rr := postCommitment(t, h, tenant, tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("%s: got %d, want 400; body: %s", tc.name, rr.Code, rr.Body.String())
			}
		})
	}
}

// Regression (review finding): a title of multi-byte runes longer than the cap
// must clamp on a RUNE boundary — a naive byte-slice corrupts non-ASCII text
// (Telugu, emoji) by splitting a codepoint into garbage bytes.
func TestCommitment_UTF8TitleClampNoCorruption(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	tenant := seedCommitmentTenant(t, pool)

	long := strings.Repeat("🔥", 600) // 600 runes, 2400 bytes — over the 500 cap
	rr := postCommitment(t, h, tenant, map[string]any{"title": long, "source": "self"})
	_ = createdID(t, rr) // fails the test if not created

	items := listCommitments(t, h, tenant, "")
	if len(items) != 1 {
		t.Fatalf("want 1 commitment, got %d", len(items))
	}
	got := items[0].Title
	if !utf8.ValidString(got) {
		t.Fatalf("title corrupted — not valid UTF-8 after clamp")
	}
	if n := utf8.RuneCountInString(got); n != 500 {
		t.Errorf("clamped to %d runes, want 500", n)
	}
}
