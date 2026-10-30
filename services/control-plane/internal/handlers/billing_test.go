package handlers

// Tests for Stripe billing (ADR 0049).
//
// Stub-server tests (no DB) pin the behind-config contract and the request
// gates. TestRLSBilling_* use the enforced-RLS harness (DATABASE_URL) with an
// in-process fake Stripe — no real network — and walk the full lifecycle:
// checkout → subscription → duplicate delivery → payment failure → grace
// expiry downgrade → recovery → meter export idempotency → cancellation.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/billing"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const testWebhookSecret = "whsec_handler_test"

// ---------- fake Stripe ----------

type fakeStripeAPI struct {
	mu       sync.Mutex
	requests []fakeStripeReq
	failPath map[string]int
}

type fakeStripeReq struct {
	Path, Idem string
	Form       url.Values
}

func newFakeStripeAPI(t *testing.T) (*fakeStripeAPI, *httptest.Server) {
	f := &fakeStripeAPI{failPath: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk_test_handler" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		b, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(b))
		f.mu.Lock()
		f.requests = append(f.requests, fakeStripeReq{r.URL.Path, r.Header.Get("Idempotency-Key"), form})
		status := f.failPath[r.URL.Path]
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"type":"api_error","code":"","message":"boom"}}`))
			return
		}
		switch r.URL.Path {
		case "/v1/customers":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "cus_" + form.Get("metadata[pal_tenant_id]")})
		case "/v1/checkout/sessions":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://checkout.stripe.test/" + form.Get("customer")})
		case "/v1/billing_portal/sessions":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://portal.stripe.test/" + form.Get("customer")})
		case "/v1/billing/meter_events":
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeStripeAPI) count(path, customer string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if r.Path == path && (customer == "" || r.Form.Get("payload[stripe_customer_id]") == customer || r.Form.Get("customer") == customer) {
			n++
		}
	}
	return n
}

func (f *fakeStripeAPI) meterReqs(customer string) []fakeStripeReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeStripeReq
	for _, r := range f.requests {
		if r.Path == "/v1/billing/meter_events" && r.Form.Get("payload[stripe_customer_id]") == customer {
			out = append(out, r)
		}
	}
	return out
}

// ---------- helpers ----------

func enabledBillingCfg(apiBase string) billing.Config {
	return billing.Config{
		SecretKey:     "sk_test_handler",
		WebhookSecret: testWebhookSecret,
		APIBase:       apiBase,
		DashboardURL:  "http://dash.test",
		GraceDays:     7,
		PlanPrices:    map[string]string{"pro": "price_pro_test"},
		MeterTokens:   "pal_tokens",
		MeterRuns:     "pal_runs",
	}
}

func stubBillingServer(t *testing.T) *server.Server {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	pool, err := pgxpool.New(context.Background(), "postgres://x:x@127.0.0.1:1/x?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &server.Server{Pool: pool, Logger: logger}
}

func billingReq(t *testing.T, method, path, tenantID, role string, body any) *http.Request {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	if tenantID != "" {
		req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "user-billing", role)))
	}
	return req
}

func webhookReq(t *testing.T, h *BillingHandler, ev map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	payload, _ := json.Marshal(ev)
	req := httptest.NewRequest(http.MethodPost, "/v1/billing/webhook", bytes.NewReader(payload))
	req.Header.Set("Stripe-Signature", billing.SignPayload(payload, testWebhookSecret, h.now()))
	rr := httptest.NewRecorder()
	h.Webhook(rr, req)
	return rr
}

func decodeBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return out
}

// ---------- behind-config contract (no DB) ----------

func TestBilling_DisabledIsInert(t *testing.T) {
	srv := stubBillingServer(t)
	h := NewBillingHandler(srv, NewAuthHandler(srv, testJWTSecret), billing.Config{})
	if h.Enabled() {
		t.Fatal("enabled without a key")
	}
	tenant := uuid.NewString()
	for name, fn := range map[string]http.HandlerFunc{"checkout": h.Checkout, "portal": h.Portal, "webhook": h.Webhook} {
		rr := httptest.NewRecorder()
		fn(rr, billingReq(t, http.MethodPost, "/v1/billing/"+name, tenant, "owner", map[string]string{"planId": "pro"}))
		if rr.Code != http.StatusNotFound || decodeBody(t, rr)["code"] != "billing_disabled" {
			t.Fatalf("%s: got %d %s", name, rr.Code, rr.Body.String())
		}
	}
	// The loop must not start (and must not panic) when disabled.
	RunBillingLoop(context.Background(), h, time.Millisecond)
}

func TestBilling_WebhookGates(t *testing.T) {
	srv := stubBillingServer(t)
	auth := NewAuthHandler(srv, testJWTSecret)

	noSecret := enabledBillingCfg("http://127.0.0.1:1")
	noSecret.WebhookSecret = ""
	h := NewBillingHandler(srv, auth, noSecret)
	rr := httptest.NewRecorder()
	h.Webhook(rr, httptest.NewRequest(http.MethodPost, "/v1/billing/webhook", strings.NewReader(`{}`)))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing webhook secret must fail closed, got %d", rr.Code)
	}

	h = NewBillingHandler(srv, auth, enabledBillingCfg("http://127.0.0.1:1"))
	payload := []byte(`{"id":"evt_x","type":"invoice.paid","created":1,"data":{"object":{}}}`)
	for name, sig := range map[string]string{
		"missing":      "",
		"wrong secret": billing.SignPayload(payload, "whsec_attacker", time.Now()),
		"stale":        billing.SignPayload(payload, testWebhookSecret, time.Now().Add(-time.Hour)),
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/billing/webhook", bytes.NewReader(payload))
		if sig != "" {
			req.Header.Set("Stripe-Signature", sig)
		}
		rr := httptest.NewRecorder()
		h.Webhook(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("%s signature: got %d", name, rr.Code)
		}
	}

	// A validly signed event of a type we do not handle is acknowledged
	// without touching the DB (the stub pool would 500).
	rr = webhookReq(t, h, map[string]any{"id": "evt_y", "type": "customer.created", "created": 1, "data": map[string]any{"object": map[string]any{}}})
	if rr.Code != http.StatusOK || decodeBody(t, rr)["ignored"] != true {
		t.Fatalf("unhandled type: %d %s", rr.Code, rr.Body.String())
	}
}

func TestBilling_ManageRequiresOwnerOrAdmin(t *testing.T) {
	srv := stubBillingServer(t)
	h := NewBillingHandler(srv, NewAuthHandler(srv, testJWTSecret), enabledBillingCfg("http://127.0.0.1:1"))
	for _, role := range []string{"member", "viewer"} {
		for name, fn := range map[string]http.HandlerFunc{"checkout": h.Checkout, "portal": h.Portal} {
			rr := httptest.NewRecorder()
			fn(rr, billingReq(t, http.MethodPost, "/v1/billing/"+name, uuid.NewString(), role, map[string]string{"planId": "pro"}))
			if rr.Code != http.StatusForbidden {
				t.Fatalf("%s as %s: got %d", name, role, rr.Code)
			}
		}
	}
	rr := httptest.NewRecorder()
	h.Checkout(rr, billingReq(t, http.MethodPost, "/v1/billing/checkout", "", "", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated checkout: %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	h.Checkout(rr, billingReq(t, http.MethodPost, "/v1/billing/checkout", uuid.NewString(), "owner", map[string]string{}))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing planId: %d", rr.Code)
	}
}

// ---------- DB-backed lifecycle under enforced RLS ----------

type billingFixture struct {
	e       *enforcedServer
	h       *BillingHandler
	fake    *fakeStripeAPI
	planID  string
	priceID string
	clock   time.Time
	evSeq   int
}

func newBillingFixture(t *testing.T) *billingFixture {
	t.Helper()
	e := newEnforcedServer(t)
	fake, api := newFakeStripeAPI(t)
	ctx := context.Background()

	// A private test plan so the shared catalog rows are never mutated.
	suffix := uuid.NewString()[:8]
	planID := "tpro-" + suffix
	priceID := "price_tpro_" + suffix
	if _, err := e.superPool.Exec(ctx, `
		INSERT INTO billing_plans (id, name, monthly_price_cents, self_serve, stripe_price_id,
			stripe_metered_price_ids, max_cost_usd_per_day, budget_hard_fail, max_concurrent_vms,
			max_compute_hours_per_day, max_egress_gb_per_day, runtime_max_cost_usd_per_day, is_public)
		VALUES ($1, 'Test Pro', 2900, true, $2, '{price_meter_test}', 42.5, true, 9, 9.5, 4, 8.25, false)`,
		planID, priceID); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	// Registered before any tenant: cleanups run LIFO, so tenants (and their
	// billing_accounts referencing this plan) are gone first.
	t.Cleanup(func() {
		_, _ = e.superPool.Exec(context.Background(), `DELETE FROM billing_plans WHERE id = $1`, planID)
	})

	h := NewBillingHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret), enabledBillingCfg(api.URL))
	f := &billingFixture{e: e, h: h, fake: fake, planID: planID, priceID: priceID, clock: time.Now().UTC()}
	h.now = func() time.Time { return f.clock }
	return f
}

func (f *billingFixture) tenant(t *testing.T) string {
	t.Helper()
	id := seedEnforcedTenant(t, f.e, "billing-"+uuid.NewString()[:8])
	t.Cleanup(func() {
		_, _ = f.e.superPool.Exec(context.Background(), `DELETE FROM billing_webhook_events WHERE tenant_id = $1`, id)
	})
	return id
}

func (f *billingFixture) event(typ string, object map[string]any) map[string]any {
	f.evSeq++
	return map[string]any{
		"id":      fmt.Sprintf("evt_%s_%d", uuid.NewString()[:8], f.evSeq),
		"type":    typ,
		"created": f.clock.Unix() + int64(f.evSeq),
		"data":    map[string]any{"object": object},
	}
}

func (f *billingFixture) subscription(customer, subID, status, price string) map[string]any {
	return map[string]any{
		"id": subID, "customer": customer, "status": status,
		"items": map[string]any{"data": []any{
			map[string]any{"current_period_end": f.clock.Add(30 * 24 * time.Hour).Unix(), "price": map[string]any{"id": price}},
			map[string]any{"price": map[string]any{"id": "price_meter_test"}},
		}},
	}
}

type limitsSnapshot struct {
	budgetCap *float64
	hardFail  bool
	vms       int
	egress    int
}

func (f *billingFixture) limits(t *testing.T, tenantID string) limitsSnapshot {
	t.Helper()
	var s limitsSnapshot
	ctx := context.Background()
	if err := f.e.superPool.QueryRow(ctx, `
		SELECT max_cost_usd_per_day::float8, hard_fail FROM agent_budgets
		WHERE tenant_id = $1 AND agent_name = '*'`, tenantID).Scan(&s.budgetCap, &s.hardFail); err != nil && err != pgx.ErrNoRows {
		t.Fatalf("read budget: %v", err)
	}
	if err := f.e.superPool.QueryRow(ctx, `
		SELECT max_concurrent_vms, max_egress_gb_per_day FROM runtime_quotas WHERE tenant_id = $1`,
		tenantID).Scan(&s.vms, &s.egress); err != nil && err != pgx.ErrNoRows {
		t.Fatalf("read quota: %v", err)
	}
	return s
}

func (f *billingFixture) account(t *testing.T, tenantID string) map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	f.h.GetBilling(rr, billingReq(t, http.MethodGet, "/v1/billing", tenantID, "member", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GetBilling: %d %s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	acct, _ := body["account"].(map[string]any)
	return acct
}

func TestRLSBilling_Lifecycle(t *testing.T) {
	f := newBillingFixture(t)
	ctx := context.Background()
	tenantA := f.tenant(t)
	tenantB := f.tenant(t)
	customerA := "cus_" + tenantA

	// Pre-existing operator limits are untouched until billing owns them.
	if _, err := f.e.superPool.Exec(ctx, `
		INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
		VALUES ($1, '*', 777, false)`, tenantA); err != nil {
		t.Fatalf("seed operator budget: %v", err)
	}
	// Usage data that dunning must never delete.
	if _, err := f.e.superPool.Exec(ctx, `
		INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, cost_usd, runs_count, tokens_in, tokens_out)
		VALUES ($1, 'agent-x', $2, 1.5, 3, 1000, 234)`, tenantA, f.clock.AddDate(0, 0, -3).Format("2006-01-02")); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	// --- GET before anything: enabled, plans listed, implicit free/none.
	acct := f.account(t, tenantA)
	if acct["status"] != "none" || acct["effectivePlanId"] != "free" || acct["hasCustomer"] != false {
		t.Fatalf("initial account: %v", acct)
	}

	// --- Checkout (pro via PlanPrices override): one customer, one session.
	rr := httptest.NewRecorder()
	f.h.Checkout(rr, billingReq(t, http.MethodPost, "/v1/billing/checkout", tenantA, "owner", map[string]string{"planId": "pro"}))
	if rr.Code != http.StatusOK || decodeBody(t, rr)["url"] != "https://checkout.stripe.test/"+customerA {
		t.Fatalf("checkout: %d %s", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	f.h.Checkout(rr, billingReq(t, http.MethodPost, "/v1/billing/checkout", tenantA, "admin", map[string]string{"planId": "pro"}))
	if rr.Code != http.StatusOK {
		t.Fatalf("second checkout: %d %s", rr.Code, rr.Body.String())
	}
	if n := f.fake.count("/v1/customers", ""); n != 1 {
		t.Fatalf("customer created %d times, want 1 (stored id reused)", n)
	}
	for _, bad := range []string{"enterprise", "nope"} {
		rr = httptest.NewRecorder()
		f.h.Checkout(rr, billingReq(t, http.MethodPost, "/v1/billing/checkout", tenantA, "owner", map[string]string{"planId": bad}))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("checkout %s: %d", bad, rr.Code)
		}
	}
	if l := f.limits(t, tenantA); l.budgetCap == nil || *l.budgetCap != 777 {
		t.Fatalf("checkout alone must not touch limits: %+v", l)
	}

	// --- Portal works now that a customer exists; tenant B has none.
	rr = httptest.NewRecorder()
	f.h.Portal(rr, billingReq(t, http.MethodPost, "/v1/billing/portal", tenantA, "owner", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("portal: %d %s", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	f.h.Portal(rr, billingReq(t, http.MethodPost, "/v1/billing/portal", tenantB, "owner", nil))
	if rr.Code != http.StatusBadRequest || decodeBody(t, rr)["code"] != "no_customer" {
		t.Fatalf("portal without customer: %d %s", rr.Code, rr.Body.String())
	}

	// --- subscription.created (test plan) → paid limits applied.
	created := f.event("customer.subscription.created", f.subscription(customerA, "sub_A", "active", f.priceID))
	if rr := webhookReq(t, f.h, created); rr.Code != http.StatusOK {
		t.Fatalf("subscription.created: %d %s", rr.Code, rr.Body.String())
	}
	paid := f.limits(t, tenantA)
	if paid.budgetCap == nil || *paid.budgetCap != 42.5 || !paid.hardFail || paid.vms != 9 || paid.egress != 4 {
		t.Fatalf("paid limits not applied: %+v", paid)
	}
	acct = f.account(t, tenantA)
	if acct["planId"] != f.planID || acct["effectivePlanId"] != f.planID || acct["status"] != "active" {
		t.Fatalf("after subscription: %v", acct)
	}

	// --- Duplicate delivery of the same event is a no-op.
	rr = webhookReq(t, f.h, created)
	if rr.Code != http.StatusOK || decodeBody(t, rr)["duplicate"] != true {
		t.Fatalf("duplicate: %d %s", rr.Code, rr.Body.String())
	}

	// --- Out-of-order: an older subscription event is recorded, not applied.
	stale := f.event("customer.subscription.updated", f.subscription(customerA, "sub_A", "canceled", f.priceID))
	stale["created"] = f.clock.Unix() - 3600
	if rr := webhookReq(t, f.h, stale); rr.Code != http.StatusOK {
		t.Fatalf("stale event: %d", rr.Code)
	}
	if acct = f.account(t, tenantA); acct["status"] != "active" {
		t.Fatalf("stale event applied: %v", acct)
	}

	// --- A second checkout while subscribed is refused (use the portal).
	rr = httptest.NewRecorder()
	f.h.Checkout(rr, billingReq(t, http.MethodPost, "/v1/billing/checkout", tenantA, "owner", map[string]string{"planId": "pro"}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("checkout while subscribed: %d", rr.Code)
	}

	// --- Payment fails → grace; limits unchanged inside grace.
	if rr := webhookReq(t, f.h, f.event("invoice.payment_failed", map[string]any{"id": "in_1", "customer": customerA, "subscription": "sub_A"})); rr.Code != http.StatusOK {
		t.Fatalf("payment_failed: %d %s", rr.Code, rr.Body.String())
	}
	acct = f.account(t, tenantA)
	if acct["status"] != "past_due" || acct["graceUntil"] == nil || acct["effectivePlanId"] != f.planID {
		t.Fatalf("grace not started: %v", acct)
	}
	if n := f.h.SweepDunning(ctx); n != 0 {
		t.Fatalf("sweep inside grace downgraded %d", n)
	}

	// --- Grace expires → sweep moves to free limits; data stays.
	f.clock = f.clock.Add(8 * 24 * time.Hour)
	if n := f.h.SweepDunning(ctx); n < 1 {
		t.Fatalf("sweep after grace downgraded %d", n)
	}
	free := f.limits(t, tenantA)
	if free.budgetCap == nil || *free.budgetCap != 1 || free.vms != 2 {
		t.Fatalf("free limits not applied: %+v", free)
	}
	var usageRows int
	_ = f.e.superPool.QueryRow(ctx, `SELECT count(*) FROM agent_usage_daily WHERE tenant_id = $1`, tenantA).Scan(&usageRows)
	if usageRows != 1 {
		t.Fatalf("dunning removed data: %d usage rows", usageRows)
	}
	if acct = f.account(t, tenantA); acct["effectivePlanId"] != "free" || acct["planId"] != f.planID {
		t.Fatalf("after downgrade: %v", acct)
	}

	// --- Payment recovers → paid limits restored.
	if rr := webhookReq(t, f.h, f.event("invoice.paid", map[string]any{"id": "in_2", "customer": customerA, "subscription": "sub_A"})); rr.Code != http.StatusOK {
		t.Fatalf("invoice.paid: %d", rr.Code)
	}
	if l := f.limits(t, tenantA); l.budgetCap == nil || *l.budgetCap != 42.5 || l.vms != 9 {
		t.Fatalf("limits not restored: %+v", l)
	}

	// --- RLS: tenant B cannot see A's billing rows through the app pool.
	var visible int
	if err := f.e.srv.WithTenant(injectTenant(ctx, tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM billing_accounts WHERE tenant_id = $1`, tenantA).Scan(&visible)
	}); err != nil {
		t.Fatalf("cross-tenant read: %v", err)
	}
	if visible != 0 {
		t.Fatalf("RLS leak: tenant B saw %d of A's billing rows", visible)
	}
	if acctB := f.account(t, tenantB); acctB["status"] != "none" || acctB["hasCustomer"] != false {
		t.Fatalf("tenant B view: %v", acctB)
	}

	// --- A superseded subscription's deletion must not move the tenant.
	if rr := webhookReq(t, f.h, f.event("customer.subscription.deleted", f.subscription(customerA, "sub_OLD", "canceled", f.priceID))); rr.Code != http.StatusOK {
		t.Fatalf("old sub deleted: %d", rr.Code)
	}
	if acct = f.account(t, tenantA); acct["effectivePlanId"] != f.planID {
		t.Fatalf("superseded subscription moved tenant: %v", acct)
	}

	// --- Cancellation → free limits, nothing deleted.
	if rr := webhookReq(t, f.h, f.event("customer.subscription.deleted", f.subscription(customerA, "sub_A", "canceled", f.priceID))); rr.Code != http.StatusOK {
		t.Fatalf("subscription.deleted: %d", rr.Code)
	}
	if acct = f.account(t, tenantA); acct["status"] != "canceled" || acct["effectivePlanId"] != "free" {
		t.Fatalf("after cancel: %v", acct)
	}
	if l := f.limits(t, tenantA); l.budgetCap == nil || *l.budgetCap != 1 {
		t.Fatalf("free limits after cancel: %+v", l)
	}

	// --- An event for a customer PAL does not know is acknowledged, ignored.
	rr = webhookReq(t, f.h, f.event("invoice.paid", map[string]any{"id": "in_x", "customer": "cus_stranger"}))
	if rr.Code != http.StatusOK || decodeBody(t, rr)["ignored"] != true {
		t.Fatalf("unknown customer: %d %s", rr.Code, rr.Body.String())
	}
}

func TestRLSBilling_MeterExportIdempotent(t *testing.T) {
	f := newBillingFixture(t)
	ctx := context.Background()
	tenant := f.tenant(t)
	customer := "cus_" + tenant

	// Bind the customer via the metadata hint path (no prior checkout row).
	sub := f.subscription(customer, "sub_M", "active", f.priceID)
	sub["metadata"] = map[string]any{"pal_tenant_id": tenant}
	if rr := webhookReq(t, f.h, f.event("customer.subscription.created", sub)); rr.Code != http.StatusOK {
		t.Fatalf("subscription.created: %d %s", rr.Code, rr.Body.String())
	}

	day := func(n int) string { return f.clock.AddDate(0, 0, -n).Format("2006-01-02") }
	// metering_since was stamped today; usage before it must not be billed.
	if _, err := f.e.superPool.Exec(ctx, `
		INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, cost_usd, runs_count, tokens_in, tokens_out)
		VALUES ($1, 'a1', $2, 1, 2, 100, 50), ($1, 'a2', $2, 1, 1, 10, 0),
		       ($1, 'a1', $3, 1, 5, 7, 3), ($1, 'a1', $4, 1, 9, 9, 9)`,
		tenant, day(3), day(4), day(0)); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	f.h.ExportMeters(ctx)
	if n := len(f.fake.meterReqs(customer)); n != 0 {
		t.Fatalf("usage before metering_since was exported: %d", n)
	}

	if _, err := f.e.superPool.Exec(ctx,
		`UPDATE billing_accounts SET metering_since = $2 WHERE tenant_id = $1`, tenant, day(10)); err != nil {
		t.Fatal(err)
	}
	// Day -4 fails at Stripe first; day -3 succeeds.
	f.fake.mu.Lock()
	f.fake.failPath["/v1/billing/meter_events"] = http.StatusInternalServerError
	f.fake.mu.Unlock()
	f.h.ExportMeters(ctx)
	var failedRows int
	_ = f.e.superPool.QueryRow(ctx, `SELECT count(*) FROM billing_meter_exports WHERE tenant_id = $1 AND status = 'failed'`, tenant).Scan(&failedRows)
	if failedRows != 4 {
		t.Fatalf("want 4 failed exports (2 days x 2 meters), got %d", failedRows)
	}
	f.fake.mu.Lock()
	delete(f.fake.failPath, "/v1/billing/meter_events")
	f.fake.mu.Unlock()

	// Inside the 10-minute claim window nothing is retried.
	before := len(f.fake.meterReqs(customer))
	f.h.ExportMeters(ctx)
	if got := len(f.fake.meterReqs(customer)); got != before {
		t.Fatalf("retried inside claim window: %d -> %d", before, got)
	}
	// Age the claims; the retry reuses the same idempotency keys.
	if _, err := f.e.superPool.Exec(ctx,
		`UPDATE billing_meter_exports SET claimed_at = now() - interval '11 minutes' WHERE tenant_id = $1`, tenant); err != nil {
		t.Fatal(err)
	}
	f.h.ExportMeters(ctx)
	var sentRows int
	_ = f.e.superPool.QueryRow(ctx, `SELECT count(*) FROM billing_meter_exports WHERE tenant_id = $1 AND status = 'sent'`, tenant).Scan(&sentRows)
	if sentRows != 4 {
		t.Fatalf("want 4 sent exports, got %d", sentRows)
	}

	// A further pass sends nothing: 'sent' is final.
	before = len(f.fake.meterReqs(customer))
	f.h.ExportMeters(ctx)
	if got := len(f.fake.meterReqs(customer)); got != before {
		t.Fatalf("re-exported sent periods: %d -> %d", before, got)
	}

	// Values and keys: day -3 aggregates both agents; today is never exported.
	byKey := map[string]fakeStripeReq{}
	for _, r := range f.fake.meterReqs(customer) {
		if r.Idem != r.Form.Get("identifier") {
			t.Fatalf("Idempotency-Key %q != identifier %q", r.Idem, r.Form.Get("identifier"))
		}
		byKey[r.Idem] = r
	}
	d3, _ := time.Parse("2006-01-02", day(3))
	tok := byKey[billing.MeterIdempotencyKey(tenant, "pal_tokens", d3)]
	runs := byKey[billing.MeterIdempotencyKey(tenant, "pal_runs", d3)]
	if tok.Form.Get("payload[value]") != "160" || runs.Form.Get("payload[value]") != "3" {
		t.Fatalf("day -3 values: tokens=%q runs=%q", tok.Form.Get("payload[value]"), runs.Form.Get("payload[value]"))
	}
	d0, _ := time.Parse("2006-01-02", day(0))
	if _, ok := byKey[billing.MeterIdempotencyKey(tenant, "pal_tokens", d0)]; ok {
		t.Fatal("unsettled day (today) was exported")
	}
	if len(byKey) != 4 {
		t.Fatalf("distinct exported keys = %d, want 4", len(byKey))
	}
}
