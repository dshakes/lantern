package handlers

// DB-backed tests for the life-event store + REST API. They skip cleanly when
// DATABASE_URL is unset (openTestPool / newEnforcedServer skip, never fail).
//
// Two layers:
//   - TestLifeEvent_* : handler-level behaviour over a real pool (create, list,
//     tenant-scoping, idempotency upsert, undo/dismiss transitions + cross-tenant
//     404, prefs upsert/get).
//   - TestRLSLifeEvents_* : the enforcement-on proof on the lantern_app-backed
//     harness — same-tenant read/write works, cross-tenant is blocked at Postgres.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newTestLifeEventHandler builds a LifeEventHandler backed by a real pool (the
// privileged superuser pool — RLS not enforced at the role level, but every
// query is still GUC-scoped through WithTenant, which is what we assert here).
func newTestLifeEventHandler(t *testing.T, pool *pgxpool.Pool) *LifeEventHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewLifeEventHandler(srv, auth)
}

// seedLifeEventTenant inserts a minimal tenant via the given pool and registers
// cleanup of the tenant + its life-event rows.
func seedLifeEventTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "le-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Life Event Test', 'personal', 'ns-le-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM life_events WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM life_event_prefs WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants WHERE id = $1::uuid", id)
	})
	return id
}

// postLifeEvent fires POST /v1/life-events as the given tenant and returns the
// recorder.
func postLifeEvent(t *testing.T, h *LifeEventHandler, tenant string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/life-events", strings.NewReader(string(b)))
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.CreateLifeEvent(rr, req)
	return rr
}

// listLifeEvents fires GET /v1/life-events?<query> as the given tenant.
func listLifeEvents(t *testing.T, h *LifeEventHandler, tenant, query string) []lifeEventJSON {
	t.Helper()
	url := "/v1/life-events"
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.ListLifeEvents(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list life events: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var out []lifeEventJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list response: %v; body: %s", err, rr.Body.String())
	}
	return out
}

// TestLifeEvent_CreateAndList covers the happy path: create one event, then see
// it in the tenant's feed with the fields preserved.
func TestLifeEvent_CreateAndList(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestLifeEventHandler(t, pool)
	tenant := seedLifeEventTenant(t, pool)

	rr := postLifeEvent(t, h, tenant, map[string]any{
		"kind":          "bill",
		"channel":       "whatsapp",
		"urgency":       "high",
		"summary":       "Electric bill $84 due Fri",
		"fields":        map[string]any{"amount": 84, "due": "2026-07-03"},
		"sourcePreview": "Your bill of $84.00 is due...",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("create response missing id: %v; body: %s", err, rr.Body.String())
	}

	events := listLifeEvents(t, h, tenant, "")
	if len(events) != 1 {
		t.Fatalf("expected 1 event in feed, got %d", len(events))
	}
	e := events[0]
	if e.ID != created.ID {
		t.Errorf("feed id %q != created id %q", e.ID, created.ID)
	}
	if e.Kind != "bill" || e.Channel != "whatsapp" || e.Urgency != "high" {
		t.Errorf("unexpected event fields: %+v", e)
	}
	if e.Status != "suggested" {
		t.Errorf("expected default status 'suggested', got %q", e.Status)
	}
	if !strings.Contains(string(e.Fields), `"amount"`) {
		t.Errorf("fields jsonb not round-tripped: %s", e.Fields)
	}
}

// TestLifeEvent_TenantScoped proves tenant B cannot see tenant A's events
// through the feed (GUC scoping in WithTenant).
func TestLifeEvent_TenantScoped(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestLifeEventHandler(t, pool)
	tenantA := seedLifeEventTenant(t, pool)
	tenantB := seedLifeEventTenant(t, pool)

	if rr := postLifeEvent(t, h, tenantA, map[string]any{
		"kind": "delivery", "channel": "imessage", "summary": "Package arriving today",
	}); rr.Code != http.StatusCreated {
		t.Fatalf("create for tenant A: got %d; body: %s", rr.Code, rr.Body.String())
	}

	if got := listLifeEvents(t, h, tenantA, ""); len(got) != 1 {
		t.Errorf("tenant A should see its own event, got %d", len(got))
	}
	if got := listLifeEvents(t, h, tenantB, ""); len(got) != 0 {
		t.Errorf("SECURITY: tenant B saw %d of tenant A's events, want 0", len(got))
	}
}

// TestLifeEvent_IdempotencyUpsert proves a re-emit with the same idempotency key
// updates the existing row (status/action_taken) rather than duplicating it.
func TestLifeEvent_IdempotencyUpsert(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestLifeEventHandler(t, pool)
	tenant := seedLifeEventTenant(t, pool)

	key := "wa-msg-" + uuid.NewString()
	rr1 := postLifeEvent(t, h, tenant, map[string]any{
		"kind": "appointment", "channel": "whatsapp", "status": "suggested",
		"summary": "Dentist Tue 3pm", "idempotencyKey": key,
	})
	if rr1.Code != http.StatusCreated {
		t.Fatalf("first emit: got %d; body: %s", rr1.Code, rr1.Body.String())
	}
	var first, second struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr1.Body.Bytes(), &first)

	// Re-emit same key with an outcome.
	rr2 := postLifeEvent(t, h, tenant, map[string]any{
		"kind": "appointment", "channel": "whatsapp", "status": "auto_acted",
		"summary": "Dentist Tue 3pm", "idempotencyKey": key, "actionTaken": "calendar.created",
	})
	if rr2.Code != http.StatusCreated {
		t.Fatalf("second emit: got %d; body: %s", rr2.Code, rr2.Body.String())
	}
	_ = json.Unmarshal(rr2.Body.Bytes(), &second)

	if first.ID != second.ID {
		t.Errorf("idempotent re-emit returned a different id: %q vs %q", first.ID, second.ID)
	}

	events := listLifeEvents(t, h, tenant, "")
	if len(events) != 1 {
		t.Fatalf("expected 1 row after idempotent re-emit, got %d", len(events))
	}
	if events[0].Status != "auto_acted" || events[0].ActionTaken != "calendar.created" {
		t.Errorf("re-emit did not update row: status=%q action=%q", events[0].Status, events[0].ActionTaken)
	}
}

// TestLifeEvent_UndoDismissTransitions covers the undo/dismiss state flips and
// the cross-tenant 404 guard.
func TestLifeEvent_UndoDismissTransitions(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestLifeEventHandler(t, pool)
	tenantA := seedLifeEventTenant(t, pool)
	tenantB := seedLifeEventTenant(t, pool)

	mkEvent := func(tenant string) string {
		rr := postLifeEvent(t, h, tenant, map[string]any{
			"kind": "travel", "channel": "imessage", "status": "auto_acted",
			"summary": "Flight UA123 check-in open",
		})
		if rr.Code != http.StatusCreated {
			t.Fatalf("create: got %d; body: %s", rr.Code, rr.Body.String())
		}
		var c struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(rr.Body.Bytes(), &c)
		return c.ID
	}

	transition := func(tenant, id, action string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/life-events/"+id+"/"+action, nil)
		req.SetPathValue("id", id)
		req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
		rr := httptest.NewRecorder()
		if action == "undo" {
			h.UndoLifeEvent(rr, req)
		} else {
			h.DismissLifeEvent(rr, req)
		}
		return rr
	}

	// Undo own event → 200, status flips.
	id := mkEvent(tenantA)
	if rr := transition(tenantA, id, "undo"); rr.Code != http.StatusOK {
		t.Fatalf("undo own event: got %d; body: %s", rr.Code, rr.Body.String())
	}
	if got := listLifeEvents(t, h, tenantA, "status=undone"); len(got) != 1 || got[0].ID != id {
		t.Errorf("expected undone event in filtered feed, got %d rows", len(got))
	}

	// Dismiss own event → 200.
	id2 := mkEvent(tenantA)
	if rr := transition(tenantA, id2, "dismiss"); rr.Code != http.StatusOK {
		t.Fatalf("dismiss own event: got %d; body: %s", rr.Code, rr.Body.String())
	}
	if got := listLifeEvents(t, h, tenantA, "status=dismissed"); len(got) != 1 || got[0].ID != id2 {
		t.Errorf("expected dismissed event in filtered feed, got %d rows", len(got))
	}

	// Cross-tenant undo → 404 (tenant B cannot touch tenant A's row).
	id3 := mkEvent(tenantA)
	if rr := transition(tenantB, id3, "undo"); rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant undo: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
	if rr := transition(tenantB, id3, "dismiss"); rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant dismiss: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

// TestLifeEvent_PrefsUpsertAndGet covers default synthesis + upsert of the
// per-kind trust toggles.
func TestLifeEvent_PrefsUpsertAndGet(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestLifeEventHandler(t, pool)
	tenant := seedLifeEventTenant(t, pool)

	getPrefs := func() map[string]string {
		req := httptest.NewRequest(http.MethodGet, "/v1/life-events/prefs", nil)
		req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
		rr := httptest.NewRecorder()
		h.ListLifeEventPrefs(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("get prefs: got %d; body: %s", rr.Code, rr.Body.String())
		}
		var prefs []lifeEventPrefJSON
		if err := json.Unmarshal(rr.Body.Bytes(), &prefs); err != nil {
			t.Fatalf("decode prefs: %v", err)
		}
		out := make(map[string]string, len(prefs))
		for _, p := range prefs {
			out[p.Kind] = p.Mode
		}
		return out
	}

	// Defaults: every known kind present, all 'ask'.
	defaults := getPrefs()
	if len(defaults) != len(lifeEventKinds) {
		t.Fatalf("expected %d default prefs, got %d", len(lifeEventKinds), len(defaults))
	}
	for _, kind := range lifeEventKinds {
		if defaults[kind] != "ask" {
			t.Errorf("default mode for %q = %q, want 'ask'", kind, defaults[kind])
		}
	}

	// Upsert delivery → auto.
	upsert := func(kind, mode string) *httptest.ResponseRecorder {
		b, _ := json.Marshal(lifeEventPrefJSON{Kind: kind, Mode: mode})
		req := httptest.NewRequest(http.MethodPut, "/v1/life-events/prefs", strings.NewReader(string(b)))
		req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
		rr := httptest.NewRecorder()
		h.UpsertLifeEventPref(rr, req)
		return rr
	}
	if rr := upsert("delivery", "auto"); rr.Code != http.StatusOK {
		t.Fatalf("upsert delivery=auto: got %d; body: %s", rr.Code, rr.Body.String())
	}
	if got := getPrefs(); got["delivery"] != "auto" {
		t.Errorf("after upsert delivery=%q, want 'auto'", got["delivery"])
	}

	// Update same kind → off (proves ON CONFLICT update path).
	if rr := upsert("delivery", "off"); rr.Code != http.StatusOK {
		t.Fatalf("upsert delivery=off: got %d; body: %s", rr.Code, rr.Body.String())
	}
	if got := getPrefs(); got["delivery"] != "off" {
		t.Errorf("after re-upsert delivery=%q, want 'off'", got["delivery"])
	}

	// Invalid mode → 400.
	if rr := upsert("bill", "maybe"); rr.Code != http.StatusBadRequest {
		t.Errorf("invalid mode: got %d, want 400", rr.Code)
	}
}

// TestRLSLifeEvents_Enforced is the catalog-gate companion: on the
// lantern_app-backed harness (RLS genuinely enforced at Postgres), a same-tenant
// insert + read works and a cross-tenant read returns zero rows for both the
// life_events and life_event_prefs tables.
func TestRLSLifeEvents_Enforced(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedLifeEventHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-le-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-le-"+uuid.NewString()[:8])

	// Same-tenant write through the handler (WithTenant on the AppPool → RLS
	// WITH CHECK must admit the insert).
	rr := postLifeEvent(t, h, tenantA, map[string]any{
		"kind": "fraud_alert", "channel": "whatsapp", "urgency": "high",
		"summary": "Suspicious sign-in flagged",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("REGRESSION: same-tenant create under RLS failed: %d; body: %s", rr.Code, rr.Body.String())
	}

	// Same-tenant read sees its own row (NOT zero).
	if got := listLifeEvents(t, h, tenantA, ""); len(got) != 1 {
		t.Fatalf("REGRESSION: same-tenant read under RLS returned %d rows, want 1", len(got))
	}

	// Cross-tenant read is blocked at Postgres → zero rows.
	if got := listLifeEvents(t, h, tenantB, ""); len(got) != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's life_events under RLS, want 0", len(got))
	}

	// Prefs table: same-tenant upsert works, cross-tenant read sees defaults only.
	b, _ := json.Marshal(lifeEventPrefJSON{Kind: "fraud_alert", Mode: "auto"})
	prefReq := httptest.NewRequest(http.MethodPut, "/v1/life-events/prefs", strings.NewReader(string(b)))
	prefReq.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantA, "user-x", "owner")))
	prefRR := httptest.NewRecorder()
	h.UpsertLifeEventPref(prefRR, prefReq)
	if prefRR.Code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant pref upsert under RLS failed: %d; body: %s", prefRR.Code, prefRR.Body.String())
	}

	// Tenant A reads its stored pref; tenant B gets only defaults (no leak).
	readMode := func(tenant string) string {
		req := httptest.NewRequest(http.MethodGet, "/v1/life-events/prefs", nil)
		req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
		rrp := httptest.NewRecorder()
		h.ListLifeEventPrefs(rrp, req)
		if rrp.Code != http.StatusOK {
			t.Fatalf("get prefs for %s: %d", tenant, rrp.Code)
		}
		var prefs []lifeEventPrefJSON
		_ = json.Unmarshal(rrp.Body.Bytes(), &prefs)
		for _, p := range prefs {
			if p.Kind == "fraud_alert" {
				return p.Mode
			}
		}
		return ""
	}
	if m := readMode(tenantA); m != "auto" {
		t.Errorf("tenant A fraud_alert pref = %q, want 'auto'", m)
	}
	if m := readMode(tenantB); m != "ask" {
		t.Errorf("SECURITY: tenant B fraud_alert pref = %q, want default 'ask' (no cross-tenant leak)", m)
	}
}

// newEnforcedLifeEventHandler builds the handler on the RLS-enforced server.
func newEnforcedLifeEventHandler(t *testing.T, e *enforcedServer) *LifeEventHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return NewLifeEventHandler(e.srv, auth)
}

// mustMigrate applies the schema once for the handler-level tests (newEnforcedServer
// already migrates for the RLS test). Idempotent.
func mustMigrate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}
