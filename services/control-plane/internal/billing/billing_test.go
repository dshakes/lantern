package billing

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

const testSecret = "whsec_test_secret"

func TestVerifySignature(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"id":"evt_1","type":"invoice.paid"}`)
	good := SignPayload(body, testSecret, now)

	cases := []struct {
		name    string
		payload []byte
		header  string
		secret  string
		at      time.Time
		want    error
	}{
		{"valid", body, good, testSecret, now, nil},
		{"valid within tolerance", body, good, testSecret, now.Add(4 * time.Minute), nil},
		{"stale", body, good, testSecret, now.Add(6 * time.Minute), ErrStaleSignature},
		{"future", body, good, testSecret, now.Add(-6 * time.Minute), ErrStaleSignature},
		{"tampered body", []byte(`{"id":"evt_1","type":"invoice.payment_failed"}`), good, testSecret, now, ErrBadSignature},
		{"wrong secret", body, good, "whsec_other", now, ErrBadSignature},
		{"empty secret never verifies", body, good, "", now, ErrBadSignature},
		{"missing header", body, "", testSecret, now, ErrNoSignature},
		{"no v1", body, "t=1800000000", testSecret, now, ErrMalformedSigHead},
		{"bad t", body, "t=abc,v1=00", testSecret, now, ErrMalformedSigHead},
		{"rotated secret: second v1 matches", body,
			good + ",v1=" + strings.Repeat("0", 64), testSecret, now, nil},
		{"only a wrong v1", body, "t=1800000000,v1=" + strings.Repeat("ab", 32), testSecret, now, ErrBadSignature},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifySignature(tc.payload, tc.header, tc.secret, DefaultSignatureTolerance, tc.at)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func ptrTime(t time.Time) *time.Time { return &t }

func TestDunningLifecycle(t *testing.T) {
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	grace := 7 * 24 * time.Hour
	a := Account{PlanID: FreePlanID, Status: "none"}

	a = OnSubscription(a, "active", "pro", t0, grace)
	if got := EffectivePlan(a, t0); got != "pro" {
		t.Fatalf("after activation: %s", got)
	}

	failAt := t0.Add(24 * time.Hour)
	a = OnInvoiceFailed(a, failAt, grace)
	if a.Status != "past_due" || a.GraceUntil == nil || !a.GraceUntil.Equal(failAt.Add(grace)) {
		t.Fatalf("grace not started: %+v", a)
	}
	if got := EffectivePlan(a, failAt.Add(time.Hour)); got != "pro" {
		t.Fatalf("inside grace must keep paid limits, got %s", got)
	}
	// A second failure must not extend the window.
	a = OnInvoiceFailed(a, failAt.Add(3*24*time.Hour), grace)
	if !a.GraceUntil.Equal(failAt.Add(grace)) {
		t.Fatalf("repeat failure extended grace: %v", a.GraceUntil)
	}
	// Sweep before expiry: nothing.
	if _, changed := Sweep(a, failAt.Add(grace-time.Minute)); changed {
		t.Fatal("sweep downgraded inside grace")
	}
	after := failAt.Add(grace + time.Minute)
	if got := EffectivePlan(a, after); got != FreePlanID {
		t.Fatalf("expired grace must be free, got %s", got)
	}
	a, changed := Sweep(a, after)
	if !changed || a.DowngradedAt == nil {
		t.Fatalf("sweep did not record downgrade: %+v", a)
	}
	if a.PlanID != "pro" {
		t.Fatalf("downgrade must keep plan_id for restore, got %s", a.PlanID)
	}
	// Payment recovers: paid limits restored.
	a = OnInvoicePaid(a)
	if got := EffectivePlan(a, after); got != "pro" || a.DowngradedAt != nil || a.GraceUntil != nil {
		t.Fatalf("payment did not restore: %s %+v", got, a)
	}
	// Cancellation: free, plan kept, not restorable by a stray invoice.paid.
	a = OnSubscriptionDeleted(a, after)
	if got := EffectivePlan(a, after); got != FreePlanID {
		t.Fatalf("canceled must be free, got %s", got)
	}
	a = OnInvoicePaid(a)
	if got := EffectivePlan(a, after); got != FreePlanID {
		t.Fatalf("invoice.paid after cancel must not restore, got %s", got)
	}
}

func TestOnSubscriptionStatuses(t *testing.T) {
	now := time.Now()
	g := time.Hour
	base := Account{PlanID: "pro", Status: "active"}
	if a := OnSubscription(base, "incomplete", "team", now, g); a.PlanID != "pro" {
		t.Fatalf("incomplete must not change plan, got %s", a.PlanID)
	}
	if a := OnSubscription(base, "active", "", now, g); a.PlanID != "pro" {
		t.Fatalf("unknown price must not change plan, got %s", a.PlanID)
	}
	if a := OnSubscription(base, "unpaid", "pro", now, g); a.GraceUntil == nil {
		t.Fatal("unpaid must start grace")
	}
	if a := OnSubscription(base, "canceled", "pro", now, g); EffectivePlan(a, now) != FreePlanID {
		t.Fatal("canceled must be free")
	}
	down := Account{PlanID: "pro", Status: "past_due", DowngradedAt: ptrTime(now), GraceUntil: ptrTime(now)}
	if a := OnSubscription(down, "active", "pro", now, g); EffectivePlan(a, now) != "pro" {
		t.Fatal("reactivation must restore")
	}
	if EffectivePlan(Account{}, now) != FreePlanID {
		t.Fatal("empty plan must be free")
	}
}

func TestPlanForPrices(t *testing.T) {
	plans := []Plan{{ID: "free"}, {ID: "pro", StripePriceID: "price_pro"}, {ID: "team", StripePriceID: "price_team"}}
	if got := PlanForPrices(plans, nil, []string{"price_metered", "price_team"}); got != "team" {
		t.Fatalf("got %q", got)
	}
	if got := PlanForPrices(plans, nil, []string{"price_unknown"}); got != "" {
		t.Fatalf("unknown price guessed %q", got)
	}
	if got := PlanForPrices(plans, map[string]string{"pro": "price_override"}, []string{"price_override"}); got != "pro" {
		t.Fatalf("override not honoured: %q", got)
	}
	// An empty price id never matches an empty plan price.
	if got := PlanForPrices(plans, nil, []string{""}); got != "" {
		t.Fatalf("empty price matched %q", got)
	}
}

func TestMeterIdempotencyKeyStable(t *testing.T) {
	d := time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC)
	k1 := MeterIdempotencyKey("t1", "pal_tokens", d)
	k2 := MeterIdempotencyKey("t1", "pal_tokens", d.Add(5*time.Hour))
	if k1 != k2 || k1 != "pal-meter:t1:pal_tokens:2026-10-03" {
		t.Fatalf("unstable key: %s %s", k1, k2)
	}
	if MeterIdempotencyKey("t2", "pal_tokens", d) == k1 || MeterIdempotencyKey("t1", "pal_runs", d) == k1 {
		t.Fatal("key collides across tenant/meter")
	}
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv("PAL_STRIPE_SECRET_KEY", "")
	if ConfigFromEnv().Enabled() {
		t.Fatal("enabled without a key")
	}
	t.Setenv("PAL_STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("PAL_STRIPE_PLAN_PRICES", " pro=price_a , team = price_b ,bad, =x")
	t.Setenv("PAL_BILLING_GRACE_DAYS", "3")
	t.Setenv("PAL_STRIPE_API_BASE", "http://fake/")
	c := ConfigFromEnv()
	if !c.Enabled() || c.GraceDays != 3 || c.APIBase != "http://fake" {
		t.Fatalf("config: %+v", c)
	}
	if c.PlanPrices["pro"] != "price_a" || c.PlanPrices["team"] != "price_b" || len(c.PlanPrices) != 2 {
		t.Fatalf("plan prices: %v", c.PlanPrices)
	}
	if c.MeterTokens != "pal_tokens" || c.MeterRuns != "pal_runs" || c.DashboardURL != "http://localhost:3001" {
		t.Fatalf("defaults: %+v", c)
	}
	t.Setenv("PAL_BILLING_GRACE_DAYS", "999")
	if ConfigFromEnv().GraceDays != 7 {
		t.Fatal("out-of-range grace accepted")
	}
}

// fakeStripe is an in-process Stripe stand-in: no real network.
type fakeStripe struct {
	mu       sync.Mutex
	requests []recorded
	fail     map[string]int // path → HTTP status to return
}

type recorded struct {
	Path, Auth, Idem string
	Form             url.Values
}

func (f *fakeStripe) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(b))
		f.mu.Lock()
		f.requests = append(f.requests, recorded{r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Idempotency-Key"), form})
		status := f.fail[r.URL.Path]
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"type": "invalid_request_error", "code": "resource_missing", "message": "No such price"}})
			return
		}
		switch r.URL.Path {
		case "/v1/customers":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "cus_123"})
		case "/v1/checkout/sessions":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "cs_1", "url": "https://checkout.stripe.test/cs_1"})
		case "/v1/billing_portal/sessions":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://billing.stripe.test/p_1"})
		case "/v1/billing/meter_events":
			_ = json.NewEncoder(w).Encode(map[string]string{"identifier": form.Get("identifier")})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
}

func TestClient_AgainstFakeStripe(t *testing.T) {
	f := &fakeStripe{fail: map[string]int{}}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	c := NewClient("sk_test_secret_value", srv.URL, srv.Client())
	ctx := context.Background()

	cid, err := c.CreateCustomer(ctx, "tenant-1", "a@b.co", "Ada")
	if err != nil || cid != "cus_123" {
		t.Fatalf("customer: %v %s", err, cid)
	}
	u, err := c.CreateCheckoutSession(ctx, CheckoutParams{
		TenantID: "tenant-1", PlanID: "pro", CustomerID: cid, PriceID: "price_pro",
		MeteredPriceIDs: []string{"price_tok"}, SuccessURL: "http://d/s", CancelURL: "http://d/c",
	})
	if err != nil || !strings.HasPrefix(u, "https://checkout.stripe.test/") {
		t.Fatalf("checkout: %v %s", err, u)
	}
	pu, err := c.CreatePortalSession(ctx, cid, "http://d/r")
	if err != nil || pu == "" {
		t.Fatalf("portal: %v", err)
	}
	ts := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	if err := c.SendMeterEvent(ctx, MeterEvent{EventName: "pal_tokens", CustomerID: cid, Value: 42, Timestamp: ts, Identifier: "pal-meter:k"}); err != nil {
		t.Fatalf("meter: %v", err)
	}

	f.mu.Lock()
	reqs := append([]recorded(nil), f.requests...)
	f.mu.Unlock()
	if len(reqs) != 4 {
		t.Fatalf("requests: %d", len(reqs))
	}
	for _, r := range reqs {
		if r.Auth != "Bearer sk_test_secret_value" {
			t.Fatalf("auth header on %s: %q", r.Path, r.Auth)
		}
	}
	if reqs[0].Idem != "pal-customer:tenant-1" || reqs[0].Form.Get("metadata[pal_tenant_id]") != "tenant-1" {
		t.Fatalf("customer request: %+v", reqs[0])
	}
	co := reqs[1].Form
	if co.Get("mode") != "subscription" || co.Get("client_reference_id") != "tenant-1" ||
		co.Get("line_items[0][price]") != "price_pro" || co.Get("line_items[0][quantity]") != "1" ||
		co.Get("line_items[1][price]") != "price_tok" || co.Get("line_items[1][quantity]") != "" ||
		co.Get("subscription_data[metadata][pal_tenant_id]") != "tenant-1" {
		t.Fatalf("checkout form: %v", co)
	}
	me := reqs[3]
	if me.Idem != "pal-meter:k" || me.Form.Get("identifier") != "pal-meter:k" ||
		me.Form.Get("payload[value]") != "42" || me.Form.Get("payload[stripe_customer_id]") != cid ||
		me.Form.Get("timestamp") != "1791028800" {
		t.Fatalf("meter request: %+v", me)
	}
}

func TestClient_ErrorNeverLeaksKey(t *testing.T) {
	f := &fakeStripe{fail: map[string]int{"/v1/checkout/sessions": 400}}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	c := NewClient("sk_test_must_not_leak", srv.URL, srv.Client())
	_, err := c.CreateCheckoutSession(context.Background(), CheckoutParams{TenantID: "t", CustomerID: "c", PriceID: "p"})
	var se *Error
	if !errors.As(err, &se) || se.Status != 400 || se.Code != "resource_missing" {
		t.Fatalf("error mapping: %v", err)
	}
	if strings.Contains(err.Error(), "sk_test_must_not_leak") {
		t.Fatal("secret key leaked into error")
	}
}

func TestSubscriptionPeriodEndShapes(t *testing.T) {
	var top, items Subscription
	_ = json.Unmarshal([]byte(`{"id":"sub","current_period_end":1800000000}`), &top)
	_ = json.Unmarshal([]byte(`{"id":"sub","items":{"data":[{"current_period_end":1800000500,"price":{"id":"price_pro"}}]}}`), &items)
	if top.PeriodEnd() == nil || top.PeriodEnd().Unix() != 1800000000 {
		t.Fatal("top-level period end")
	}
	if items.PeriodEnd() == nil || items.PeriodEnd().Unix() != 1800000500 || items.PriceIDs()[0] != "price_pro" {
		t.Fatal("item-level period end / price")
	}
	var none Subscription
	if none.PeriodEnd() != nil {
		t.Fatal("zero period end must be nil")
	}
}

func TestCustomerOf(t *testing.T) {
	var ev Event
	_ = json.Unmarshal([]byte(`{"id":"evt","type":"checkout.session.completed","data":{"object":{"customer":"cus_1","client_reference_id":"tid"}}}`), &ev)
	if c, h := CustomerOf(ev); c != "cus_1" || h != "tid" {
		t.Fatalf("%s %s", c, h)
	}
	_ = json.Unmarshal([]byte(`{"id":"evt","type":"customer.subscription.created","data":{"object":{"customer":"cus_2","metadata":{"pal_tenant_id":"tid2"}}}}`), &ev)
	if c, h := CustomerOf(ev); c != "cus_2" || h != "tid2" {
		t.Fatalf("%s %s", c, h)
	}
}
