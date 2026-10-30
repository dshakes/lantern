// Package billing is PAL's payment integration (ADR 0049): a minimal Stripe
// REST client, webhook signature verification, and the pure plan / dunning
// rules the control-plane's billing handler applies.
//
// Everything is behind configuration. With no PAL_STRIPE_SECRET_KEY the
// control-plane never constructs a Client and billing stays exactly as it was
// before this package existed (metering only).
//
// The secret key and webhook secret are never logged, traced, or included in
// returned errors (invariant #10). Stripe errors are surfaced by type/code and
// Stripe's own message, which never echoes the key.
package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultAPIBase is Stripe's production API origin. Tests point the client at
// an httptest server instead (no real network).
const DefaultAPIBase = "https://api.stripe.com"

// Config is the Stripe configuration resolved from the environment.
type Config struct {
	SecretKey     string // PAL_STRIPE_SECRET_KEY — never logged
	WebhookSecret string // PAL_STRIPE_WEBHOOK_SECRET — never logged
	APIBase       string // PAL_STRIPE_API_BASE (tests / proxies); default DefaultAPIBase
	DashboardURL  string // PAL_DASHBOARD_URL — success/cancel/return URLs
	GraceDays     int    // PAL_BILLING_GRACE_DAYS — dunning grace before downgrade
	// PlanPrices overrides billing_plans.stripe_price_id per plan
	// (PAL_STRIPE_PLAN_PRICES="pro=price_123,team=price_456"). Optional: the
	// plan rows are the source of truth; this exists so a deployment can wire
	// its own Stripe account's price ids without a SQL update.
	PlanPrices map[string]string
	// Meter event names (PAL_STRIPE_METER_TOKENS / PAL_STRIPE_METER_RUNS).
	MeterTokens string
	MeterRuns   string
}

// Enabled reports whether Stripe is configured. Disabled = pre-billing
// behaviour everywhere.
func (c Config) Enabled() bool { return c.SecretKey != "" }

// ConfigFromEnv reads the Stripe configuration. A missing secret key yields a
// disabled Config (no error): billing is opt-in.
func ConfigFromEnv() Config {
	c := Config{
		SecretKey:     strings.TrimSpace(os.Getenv("PAL_STRIPE_SECRET_KEY")),
		WebhookSecret: strings.TrimSpace(os.Getenv("PAL_STRIPE_WEBHOOK_SECRET")),
		APIBase:       strings.TrimRight(strings.TrimSpace(os.Getenv("PAL_STRIPE_API_BASE")), "/"),
		DashboardURL:  strings.TrimRight(strings.TrimSpace(os.Getenv("PAL_DASHBOARD_URL")), "/"),
		GraceDays:     7,
		PlanPrices:    parsePlanPrices(os.Getenv("PAL_STRIPE_PLAN_PRICES")),
		MeterTokens:   strings.TrimSpace(os.Getenv("PAL_STRIPE_METER_TOKENS")),
		MeterRuns:     strings.TrimSpace(os.Getenv("PAL_STRIPE_METER_RUNS")),
	}
	if c.APIBase == "" {
		c.APIBase = DefaultAPIBase
	}
	if c.DashboardURL == "" {
		c.DashboardURL = "http://localhost:3001"
	}
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("PAL_BILLING_GRACE_DAYS"))); err == nil && v >= 0 && v <= 60 {
		c.GraceDays = v
	}
	if c.MeterTokens == "" {
		c.MeterTokens = "pal_tokens"
	}
	if c.MeterRuns == "" {
		c.MeterRuns = "pal_runs"
	}
	return c
}

func parsePlanPrices(s string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if ok && k != "" && v != "" {
			out[k] = v
		}
	}
	return out
}

// Client is a minimal Stripe REST client: form-encoded requests, JSON
// responses, an Idempotency-Key on every mutating call. It deliberately does
// not retry — callers are either request-scoped (the user retries) or the
// periodic billing loop (the next tick retries with the same idempotency key).
type Client struct {
	secretKey string
	base      string
	http      *http.Client
}

// NewClient builds a client. base "" means DefaultAPIBase.
func NewClient(secretKey, base string, hc *http.Client) *Client {
	if base == "" {
		base = DefaultAPIBase
	}
	if hc == nil {
		hc = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{secretKey: secretKey, base: strings.TrimRight(base, "/"), http: hc}
}

// Error is a Stripe API error. It carries Stripe's type/code/message and the
// HTTP status — never request parameters or credentials.
type Error struct {
	Status  int
	Type    string
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("stripe: %d %s %s: %s", e.Status, e.Type, e.Code, e.Message)
}

// ErrNotConfigured is returned by handler paths when Stripe is disabled.
var ErrNotConfigured = errors.New("billing: stripe not configured")

func (c *Client) post(ctx context.Context, path string, form url.Values, idemKey string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, strings.NewReader(encodeForm(form)))
	if err != nil {
		return fmt.Errorf("stripe: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Stripe-Version", "2024-06-20")
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// net/http errors carry the URL (no credentials: the key is a header).
		return fmt.Errorf("stripe: %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("stripe: read %s: %w", path, err)
	}
	if resp.StatusCode >= 300 {
		var env struct {
			Error struct {
				Type    string `json:"type"`
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &env)
		return &Error{Status: resp.StatusCode, Type: env.Error.Type, Code: env.Error.Code, Message: env.Error.Message}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("stripe: decode %s: %w", path, err)
	}
	return nil
}

// encodeForm is url.Values.Encode with a stable key order (Encode already
// sorts; kept explicit so bracketed keys like line_items[0][price] stay
// grouped and the fake server in tests sees deterministic bodies).
func encodeForm(v url.Values) string {
	keys := make([]string, 0, len(v))
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		for _, val := range v[k] {
			if b.Len() > 0 {
				b.WriteByte('&')
			}
			b.WriteString(url.QueryEscape(k))
			b.WriteByte('=')
			b.WriteString(url.QueryEscape(val))
		}
	}
	return b.String()
}

// CreateCustomer creates a Stripe customer tagged with the PAL tenant id. The
// idempotency key is per tenant, so a double-click (or a retry after a lost
// response) never creates two customers.
func (c *Client) CreateCustomer(ctx context.Context, tenantID, email, name string) (string, error) {
	form := url.Values{}
	form.Set("metadata[pal_tenant_id]", tenantID)
	if email != "" {
		form.Set("email", email)
	}
	if name != "" {
		form.Set("name", name)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := c.post(ctx, "/v1/customers", form, "pal-customer:"+tenantID, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", errors.New("stripe: customer create returned no id")
	}
	return out.ID, nil
}

// CheckoutParams describes a subscription Checkout Session.
type CheckoutParams struct {
	TenantID        string
	PlanID          string
	CustomerID      string
	PriceID         string   // flat recurring price (quantity 1)
	MeteredPriceIDs []string // usage prices (no quantity)
	SuccessURL      string
	CancelURL       string
	IdempotencyKey  string
}

// CreateCheckoutSession returns the hosted Checkout URL.
func (c *Client) CreateCheckoutSession(ctx context.Context, p CheckoutParams) (string, error) {
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("customer", p.CustomerID)
	form.Set("client_reference_id", p.TenantID)
	form.Set("success_url", p.SuccessURL)
	form.Set("cancel_url", p.CancelURL)
	form.Set("subscription_data[metadata][pal_tenant_id]", p.TenantID)
	form.Set("subscription_data[metadata][pal_plan_id]", p.PlanID)
	form.Set("line_items[0][price]", p.PriceID)
	form.Set("line_items[0][quantity]", "1")
	for i, mp := range p.MeteredPriceIDs {
		form.Set(fmt.Sprintf("line_items[%d][price]", i+1), mp)
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := c.post(ctx, "/v1/checkout/sessions", form, p.IdempotencyKey, &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", errors.New("stripe: checkout session returned no url")
	}
	return out.URL, nil
}

// CreatePortalSession returns a Customer Portal URL for self-serve plan and
// payment-method management.
func (c *Client) CreatePortalSession(ctx context.Context, customerID, returnURL string) (string, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", returnURL)
	var out struct {
		URL string `json:"url"`
	}
	if err := c.post(ctx, "/v1/billing_portal/sessions", form, "", &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", errors.New("stripe: portal session returned no url")
	}
	return out.URL, nil
}

// MeterEvent is one usage report.
type MeterEvent struct {
	EventName  string
	CustomerID string
	Value      int64
	Timestamp  time.Time
	// Identifier dedups at Stripe (unique per meter); also sent as the
	// Idempotency-Key header.
	Identifier string
}

// SendMeterEvent reports usage to a Stripe billing meter.
func (c *Client) SendMeterEvent(ctx context.Context, e MeterEvent) error {
	form := url.Values{}
	form.Set("event_name", e.EventName)
	form.Set("payload[stripe_customer_id]", e.CustomerID)
	form.Set("payload[value]", strconv.FormatInt(e.Value, 10))
	form.Set("identifier", e.Identifier)
	form.Set("timestamp", strconv.FormatInt(e.Timestamp.Unix(), 10))
	return c.post(ctx, "/v1/billing/meter_events", form, e.Identifier, nil)
}
