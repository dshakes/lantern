package handlers

// Stripe billing — ADR 0049.
//
// Endpoints:
//
//	GET  /v1/billing           plans + this tenant's subscription state (read)
//	POST /v1/billing/checkout  {planId} → hosted Checkout URL (owner/admin, settings:write)
//	POST /v1/billing/portal    → Customer Portal URL (owner/admin, settings:write)
//	POST /v1/billing/webhook   Stripe → PAL; Stripe-Signature verified, no JWT
//
// Behind configuration: with PAL_STRIPE_SECRET_KEY unset, GET reports
// {enabled:false} with the plan catalog, checkout/portal answer 404
// {code:"billing_disabled"}, the webhook answers 404, and the background
// loop never starts — pre-billing behaviour, unchanged.
//
// Enforcement reuses the existing tables: a plan's limits are written to the
// tenant-wide agent_budgets row (agent_name '*') and to runtime_quotas, which
// CheckTenantBudget and the runtime quota gate already enforce. Billing adds
// no new enforcement path.
//
// Dunning: invoice.payment_failed starts a grace window
// (PAL_BILLING_GRACE_DAYS, default 7); when it expires the sweep moves the
// tenant onto free limits. Nothing is deleted. invoice.paid restores the paid
// plan's limits.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/billing"
	"github.com/dshakes/pal/services/control-plane/internal/db"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// BillingHandler serves the billing REST surface and runs the billing loop.
type BillingHandler struct {
	srv    *server.Server
	auth   *AuthHandler
	cfg    billing.Config
	stripe *billing.Client // nil when billing is disabled
	now    func() time.Time
}

// NewBillingHandler wires the handler. A disabled cfg yields a handler whose
// mutating routes report billing_disabled.
func NewBillingHandler(srv *server.Server, auth *AuthHandler, cfg billing.Config) *BillingHandler {
	h := &BillingHandler{srv: srv, auth: auth, cfg: cfg, now: time.Now}
	if cfg.Enabled() {
		h.stripe = billing.NewClient(cfg.SecretKey, cfg.APIBase, nil)
	}
	return h
}

// Enabled reports whether Stripe is configured.
func (h *BillingHandler) Enabled() bool { return h.stripe != nil }

func (h *BillingHandler) logger() *zap.Logger { return h.srv.Logger.Named("billing") }

func (h *BillingHandler) graceDuration() time.Duration {
	return time.Duration(h.cfg.GraceDays) * 24 * time.Hour
}

// ---------- plan catalog + account persistence ----------

type pgQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func loadBillingPlans(ctx context.Context, q pgQuerier, overrides map[string]string, publicOnly bool) ([]billing.Plan, error) {
	rows, err := q.Query(ctx, `
		SELECT id, name, description, monthly_price_cents, self_serve,
		       COALESCE(stripe_price_id, ''), stripe_metered_price_ids,
		       max_cost_usd_per_day::float8, budget_hard_fail,
		       max_concurrent_vms, max_compute_hours_per_day::float8,
		       max_egress_gb_per_day, runtime_max_cost_usd_per_day::float8,
		       features, sort_order, is_public
		FROM billing_plans
		ORDER BY sort_order, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []billing.Plan
	for rows.Next() {
		var p billing.Plan
		var featuresJSON []byte
		var isPublic bool
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.MonthlyPriceCents, &p.SelfServe,
			&p.StripePriceID, &p.StripeMeteredPriceIDs,
			&p.Limits.MaxCostUsdPerDay, &p.Limits.BudgetHardFail,
			&p.Limits.MaxConcurrentVMs, &p.Limits.MaxComputeHoursPerDay,
			&p.Limits.MaxEgressGBPerDay, &p.Limits.RuntimeMaxCostUsdPerDay,
			&featuresJSON, &p.SortOrder, &isPublic); err != nil {
			return nil, err
		}
		if publicOnly && !isPublic {
			continue
		}
		_ = json.Unmarshal(featuresJSON, &p.Features)
		if p.Features == nil {
			p.Features = []string{}
		}
		p.Purchasable = p.SelfServe && p.PriceID(overrides) != ""
		out = append(out, p)
	}
	return out, rows.Err()
}

func planByID(plans []billing.Plan, id string) (billing.Plan, bool) {
	for _, p := range plans {
		if p.ID == id {
			return p, true
		}
	}
	return billing.Plan{}, false
}

// billingAccountRow is a billing_accounts row.
type billingAccountRow struct {
	billing.Account
	CustomerID              string
	SubscriptionID          string
	CurrentPeriodEnd        *time.Time
	AppliedPlanID           string
	MeteringSince           *time.Time
	LastSubscriptionEventAt *time.Time
}

const billingAccountCols = `
	COALESCE(stripe_customer_id, ''), COALESCE(stripe_subscription_id, ''), plan_id, status,
	current_period_end, payment_failed_at, grace_until, downgraded_at,
	COALESCE(applied_plan_id, ''), metering_since, last_subscription_event_at`

func scanBillingAccount(row pgx.Row) (billingAccountRow, error) {
	var a billingAccountRow
	err := row.Scan(&a.CustomerID, &a.SubscriptionID, &a.PlanID, &a.Status,
		&a.CurrentPeriodEnd, &a.PaymentFailedAt, &a.GraceUntil, &a.DowngradedAt,
		&a.AppliedPlanID, &a.MeteringSince, &a.LastSubscriptionEventAt)
	return a, err
}

// readBillingAccount returns the tenant's account, or the implicit default
// (free, status none) when no row exists yet.
func readBillingAccount(ctx context.Context, tx pgx.Tx, tenantID string) (billingAccountRow, error) {
	a, err := scanBillingAccount(tx.QueryRow(ctx,
		`SELECT `+billingAccountCols+` FROM billing_accounts WHERE tenant_id = $1`, tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return billingAccountRow{Account: billing.Account{PlanID: billing.FreePlanID, Status: "none"}}, nil
	}
	return a, err
}

// lockBillingAccount ensures the row exists and locks it for the transaction.
func lockBillingAccount(ctx context.Context, tx pgx.Tx, tenantID string) (billingAccountRow, error) {
	if _, err := tx.Exec(ctx,
		`INSERT INTO billing_accounts (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, tenantID); err != nil {
		return billingAccountRow{}, err
	}
	return scanBillingAccount(tx.QueryRow(ctx,
		`SELECT `+billingAccountCols+` FROM billing_accounts WHERE tenant_id = $1 FOR UPDATE`, tenantID))
}

func saveBillingAccount(ctx context.Context, tx pgx.Tx, tenantID string, a billingAccountRow) error {
	_, err := tx.Exec(ctx, `
		UPDATE billing_accounts SET
			stripe_customer_id = NULLIF($2, ''),
			stripe_subscription_id = NULLIF($3, ''),
			plan_id = $4, status = $5, current_period_end = $6,
			payment_failed_at = $7, grace_until = $8, downgraded_at = $9,
			applied_plan_id = NULLIF($10, ''), metering_since = $11,
			last_subscription_event_at = $12, updated_at = now()
		WHERE tenant_id = $1`,
		tenantID, a.CustomerID, a.SubscriptionID, a.PlanID, a.Status, a.CurrentPeriodEnd,
		a.PaymentFailedAt, a.GraceUntil, a.DowngradedAt, a.AppliedPlanID, a.MeteringSince,
		a.LastSubscriptionEventAt)
	return err
}

// applyPlanLimits writes a plan's limits into the existing enforcement
// tables. The tenant-wide budget row is always written (NULL cap = no cap);
// runtime_quotas only when the plan manages it (MaxConcurrentVMs set).
func applyPlanLimits(ctx context.Context, tx pgx.Tx, tenantID string, p billing.Plan) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
			max_cost_usd_per_day = EXCLUDED.max_cost_usd_per_day,
			hard_fail = EXCLUDED.hard_fail,
			updated_at = now()`,
		tenantID, TenantBudgetAgent, p.Limits.MaxCostUsdPerDay, p.Limits.BudgetHardFail); err != nil {
		return err
	}
	l := p.Limits
	if l.MaxConcurrentVMs == nil {
		return nil
	}
	hours, egress, cost := 0.0, 0, 0.0
	if l.MaxComputeHoursPerDay != nil {
		hours = *l.MaxComputeHoursPerDay
	}
	if l.MaxEgressGBPerDay != nil {
		egress = *l.MaxEgressGBPerDay
	}
	if l.RuntimeMaxCostUsdPerDay != nil {
		cost = *l.RuntimeMaxCostUsdPerDay
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO runtime_quotas
		  (tenant_id, max_concurrent_vms, max_compute_hours_per_day,
		   max_egress_gb_per_day, max_cost_usd_per_day, hard_fail, updated_at)
		VALUES ($1, $2, $3, $4, $5, true, now())
		ON CONFLICT (tenant_id) DO UPDATE SET
		  max_concurrent_vms        = EXCLUDED.max_concurrent_vms,
		  max_compute_hours_per_day = EXCLUDED.max_compute_hours_per_day,
		  max_egress_gb_per_day     = EXCLUDED.max_egress_gb_per_day,
		  max_cost_usd_per_day      = EXCLUDED.max_cost_usd_per_day,
		  hard_fail                 = EXCLUDED.hard_fail,
		  updated_at                = now()`,
		tenantID, *l.MaxConcurrentVMs, hours, egress, cost)
	return err
}

// reconcileLimits writes the effective plan's limits when they differ from
// what was last applied. Idempotent: a replayed event is a no-op.
func (h *BillingHandler) reconcileLimits(ctx context.Context, tx pgx.Tx, tenantID string, a *billingAccountRow) error {
	if a.AppliedPlanID == "" && a.Status == "none" {
		// Never subscribed: billing has not taken ownership of this tenant's
		// limits, so whatever an operator configured stays untouched.
		return nil
	}
	eff := billing.EffectivePlan(a.Account, h.now())
	if eff == a.AppliedPlanID {
		return nil
	}
	plans, err := loadBillingPlans(ctx, tx, h.cfg.PlanPrices, false)
	if err != nil {
		return err
	}
	p, ok := planByID(plans, eff)
	if !ok {
		// A plan row was deleted out from under an account. Do not guess
		// limits; leave the last applied ones in place and surface it.
		h.logger().Error("effective plan missing from billing_plans; limits unchanged",
			zap.String("tenant", tenantID), zap.String("plan", eff))
		return nil
	}
	if err := applyPlanLimits(ctx, tx, tenantID, p); err != nil {
		return err
	}
	h.logger().Info("plan limits applied",
		zap.String("tenant", tenantID), zap.String("from", a.AppliedPlanID), zap.String("to", eff))
	a.AppliedPlanID = eff
	return nil
}

// ---------- REST: read ----------

type billingAccountDTO struct {
	PlanID           string     `json:"planId"`
	EffectivePlanID  string     `json:"effectivePlanId"`
	Status           string     `json:"status"`
	CurrentPeriodEnd *time.Time `json:"currentPeriodEnd,omitempty"`
	PaymentFailedAt  *time.Time `json:"paymentFailedAt,omitempty"`
	GraceUntil       *time.Time `json:"graceUntil,omitempty"`
	DowngradedAt     *time.Time `json:"downgradedAt,omitempty"`
	HasCustomer      bool       `json:"hasCustomer"`
}

// GetBilling handles GET /v1/billing.
func (h *BillingHandler) GetBilling(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	middleware.EnrichSpan(ctx, claims.TenantID, claims.Subject, "", "")

	var plans []billing.Plan
	var acct billingAccountRow
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		if plans, e = loadBillingPlans(ctx, tx, h.cfg.PlanPrices, true); e != nil {
			return e
		}
		acct, e = readBillingAccount(ctx, tx, claims.TenantID)
		return e
	}); dbErr != nil {
		h.logger().Error("GetBilling failed", zap.String("tenant", claims.TenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load billing"})
		return
	}
	if !h.Enabled() {
		for i := range plans {
			plans[i].Purchasable = false
		}
	}
	if plans == nil {
		plans = []billing.Plan{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": h.Enabled(),
		"plans":   plans,
		"account": billingAccountDTO{
			PlanID:           acct.PlanID,
			EffectivePlanID:  billing.EffectivePlan(acct.Account, h.now()),
			Status:           acct.Status,
			CurrentPeriodEnd: acct.CurrentPeriodEnd,
			PaymentFailedAt:  acct.PaymentFailedAt,
			GraceUntil:       acct.GraceUntil,
			DowngradedAt:     acct.DowngradedAt,
			HasCustomer:      acct.CustomerID != "",
		},
	})
}

// ---------- REST: checkout + portal ----------

func billingDisabled(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, map[string]string{
		"error": "billing is not configured on this deployment", "code": "billing_disabled",
	})
}

// canManageBilling: owner/admin sessions, or a service key holding
// settings:write. Members and viewers cannot change the subscription.
func canManageBilling(c *PalClaims) bool {
	switch c.Role {
	case "owner", "admin":
		return true
	case "service":
		return HasScope(c, ScopeSettingsWrite)
	}
	return false
}

func (h *BillingHandler) authorizeManage(w http.ResponseWriter, r *http.Request) (*PalClaims, bool) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false
	}
	if !canManageBilling(claims) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only a workspace owner or admin can manage billing"})
		return nil, false
	}
	return claims, true
}

// stripeFailure maps a Stripe error to a 502 without echoing request data.
func (h *BillingHandler) stripeFailure(w http.ResponseWriter, tenantID, op string, err error) {
	var se *billing.Error
	fields := []zap.Field{zap.String("tenant", tenantID), zap.String("op", op)}
	if errors.As(err, &se) {
		fields = append(fields, zap.Int("status", se.Status), zap.String("type", se.Type), zap.String("code", se.Code))
	} else {
		fields = append(fields, zap.Error(err))
	}
	h.logger().Error("stripe call failed", fields...)
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment provider unavailable", "code": "stripe_failed"})
}

// Checkout handles POST /v1/billing/checkout {planId}.
func (h *BillingHandler) Checkout(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		billingDisabled(w)
		return
	}
	claims, ok := h.authorizeManage(w, r)
	if !ok {
		return
	}
	var body struct {
		PlanID string `json:"planId"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || strings.TrimSpace(body.PlanID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "planId is required"})
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	middleware.EnrichSpan(ctx, tenantID, claims.Subject, "", "")

	var plan billing.Plan
	var acct billingAccountRow
	var found bool
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		plans, e := loadBillingPlans(ctx, tx, h.cfg.PlanPrices, true)
		if e != nil {
			return e
		}
		plan, found = planByID(plans, body.PlanID)
		acct, e = readBillingAccount(ctx, tx, tenantID)
		return e
	}); dbErr != nil {
		h.logger().Error("checkout: load failed", zap.String("tenant", tenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to start checkout"})
		return
	}
	if !found {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown plan", "code": "unknown_plan"})
		return
	}
	if !plan.Purchasable {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "this plan is not available for self-serve checkout", "code": "not_purchasable"})
		return
	}
	if acct.SubscriptionID != "" && !acctTerminal(acct.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "this workspace already has a subscription; change plans from the billing portal", "code": "has_subscription",
		})
		return
	}

	customerID, err := h.ensureCustomer(ctx, tenantID, claims, acct)
	if err != nil {
		h.stripeFailure(w, tenantID, "create_customer", err)
		return
	}
	url, err := h.stripe.CreateCheckoutSession(ctx, billing.CheckoutParams{
		TenantID:        tenantID,
		PlanID:          plan.ID,
		CustomerID:      customerID,
		PriceID:         plan.PriceID(h.cfg.PlanPrices),
		MeteredPriceIDs: plan.StripeMeteredPriceIDs,
		SuccessURL:      h.cfg.DashboardURL + "/settings?tab=billing&checkout=success",
		CancelURL:       h.cfg.DashboardURL + "/settings?tab=billing&checkout=cancel",
	})
	if err != nil {
		h.stripeFailure(w, tenantID, "checkout_session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func acctTerminal(status string) bool {
	return status == "canceled" || status == "incomplete_expired" || status == "none" || status == ""
}

// ensureCustomer returns the tenant's Stripe customer, creating it once. The
// create carries a per-tenant idempotency key and the store keeps the first
// id written, so concurrent checkouts converge on one customer.
func (h *BillingHandler) ensureCustomer(ctx context.Context, tenantID string, claims *PalClaims, acct billingAccountRow) (string, error) {
	if acct.CustomerID != "" {
		return acct.CustomerID, nil
	}
	cid, err := h.stripe.CreateCustomer(ctx, tenantID, claims.Email, claims.Name)
	if err != nil {
		return "", err
	}
	var stored string
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO billing_accounts (tenant_id, stripe_customer_id) VALUES ($1, $2)
			ON CONFLICT (tenant_id) DO UPDATE
			SET stripe_customer_id = COALESCE(billing_accounts.stripe_customer_id, EXCLUDED.stripe_customer_id),
			    updated_at = now()
			RETURNING stripe_customer_id`, tenantID, cid).Scan(&stored)
	}); dbErr != nil {
		return "", dbErr
	}
	return stored, nil
}

// Portal handles POST /v1/billing/portal.
func (h *BillingHandler) Portal(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		billingDisabled(w)
		return
	}
	claims, ok := h.authorizeManage(w, r)
	if !ok {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	middleware.EnrichSpan(ctx, tenantID, claims.Subject, "", "")
	var acct billingAccountRow
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		acct, e = readBillingAccount(ctx, tx, tenantID)
		return e
	}); dbErr != nil {
		h.logger().Error("portal: load failed", zap.String("tenant", tenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to open billing portal"})
		return
	}
	if acct.CustomerID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no billing account yet; choose a plan first", "code": "no_customer"})
		return
	}
	url, err := h.stripe.CreatePortalSession(ctx, acct.CustomerID, h.cfg.DashboardURL+"/settings?tab=billing")
	if err != nil {
		h.stripeFailure(w, tenantID, "portal_session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// ---------- webhook ----------

var handledBillingEvents = map[string]bool{
	"checkout.session.completed":    true,
	"customer.subscription.created": true,
	"customer.subscription.updated": true,
	"customer.subscription.deleted": true,
	"invoice.paid":                  true,
	"invoice.payment_failed":        true,
}

// Webhook handles POST /v1/billing/webhook. 2xx tells Stripe the event is
// handled (or deliberately ignored); 5xx makes Stripe redeliver, which is
// safe because processing is transactional and keyed by event id.
func (h *BillingHandler) Webhook(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		billingDisabled(w)
		return
	}
	if h.cfg.WebhookSecret == "" {
		// Fail closed: never accept unsigned billing events.
		h.logger().Error("webhook received but PAL_STRIPE_WEBHOOK_SECRET is unset; rejecting")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "webhook not configured"})
		return
	}
	payload, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	if err := billing.VerifySignature(payload, r.Header.Get("Stripe-Signature"), h.cfg.WebhookSecret,
		billing.DefaultSignatureTolerance, h.now()); err != nil {
		h.logger().Warn("webhook signature rejected", zap.Error(err))
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid signature"})
		return
	}
	var ev billing.Event
	if err := json.Unmarshal(payload, &ev); err != nil || ev.ID == "" || ev.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid event"})
		return
	}
	if !handledBillingEvents[ev.Type] {
		writeJSON(w, http.StatusOK, map[string]any{"received": true, "ignored": true})
		return
	}

	ctx := r.Context()
	tenantID, err := h.resolveWebhookTenant(ctx, ev)
	if err != nil {
		h.logger().Error("webhook tenant lookup failed", zap.String("event", ev.ID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "lookup failed"})
		return
	}
	if tenantID == "" {
		// Not ours (another integration on the same Stripe account) or a
		// customer created outside PAL. Acknowledge so Stripe stops retrying.
		h.logger().Warn("webhook event has no PAL tenant; ignoring", zap.String("event", ev.ID), zap.String("type", ev.Type))
		writeJSON(w, http.StatusOK, map[string]any{"received": true, "ignored": true})
		return
	}
	ctx = middleware.InjectTenantID(ctx, tenantID)
	middleware.EnrichSpan(ctx, tenantID, "", "", "")

	duplicate, err := h.processEvent(ctx, tenantID, ev)
	if err != nil {
		h.logger().Error("webhook processing failed", zap.String("tenant", tenantID),
			zap.String("event", ev.ID), zap.String("type", ev.Type), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "processing failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": true, "duplicate": duplicate})
}

// resolveWebhookTenant maps an event to a PAL tenant: by Stripe customer id
// first (the row written at checkout), then by the tenant id PAL stamped on
// the checkout session / subscription metadata. The hint is trusted only
// because the payload is signature-verified, and only adopted when that
// tenant has no different customer on file.
func (h *BillingHandler) resolveWebhookTenant(ctx context.Context, ev billing.Event) (string, error) {
	customerID, hint := billing.CustomerOf(ev)
	if customerID != "" {
		var tid string
		// rls-exempt: pre-tenant resolution of a signature-verified Stripe
		// event (no request tenant exists yet), like auth.go's key lookup.
		err := h.srv.Pool.QueryRow(ctx,
			`SELECT tenant_id::text FROM billing_accounts WHERE stripe_customer_id = $1`, customerID).Scan(&tid)
		if err == nil {
			return tid, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
	}
	if _, err := uuid.Parse(hint); err != nil {
		return "", nil
	}
	var existing *string
	// rls-exempt: same pre-tenant resolution; confirms the hinted tenant
	// exists and is not bound to a different Stripe customer.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT ba.stripe_customer_id FROM tenants t
		LEFT JOIN billing_accounts ba ON ba.tenant_id = t.id
		WHERE t.id = $1`, hint).Scan(&existing)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if existing != nil && *existing != "" && *existing != customerID {
		return "", nil
	}
	return hint, nil
}

// processEvent applies one event inside a tenant-scoped transaction. The
// event-id insert and the state change commit together, so a crash between
// them redelivers cleanly and a duplicate delivery is a no-op.
func (h *BillingHandler) processEvent(ctx context.Context, tenantID string, ev billing.Event) (bool, error) {
	duplicate := false
	err := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO billing_webhook_events (event_id, event_type, tenant_id)
			VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`, ev.ID, ev.Type, tenantID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			duplicate = true
			return nil
		}
		acct, err := lockBillingAccount(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		if err := h.applyEvent(ctx, tx, &acct, ev); err != nil {
			return err
		}
		if err := h.reconcileLimits(ctx, tx, tenantID, &acct); err != nil {
			return err
		}
		return saveBillingAccount(ctx, tx, tenantID, acct)
	})
	return duplicate, err
}

func (h *BillingHandler) applyEvent(ctx context.Context, tx pgx.Tx, acct *billingAccountRow, ev billing.Event) error {
	now := h.now()
	customerID, _ := billing.CustomerOf(ev)
	if acct.CustomerID == "" && customerID != "" {
		acct.CustomerID = customerID
	}
	switch ev.Type {
	case "checkout.session.completed":
		var cs billing.CheckoutSession
		if err := json.Unmarshal(ev.Data.Object, &cs); err != nil {
			return err
		}
		if cs.Subscription != "" && (acct.SubscriptionID == "" || acctTerminal(acct.Status)) {
			acct.SubscriptionID = cs.Subscription
		}

	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		var sub billing.Subscription
		if err := json.Unmarshal(ev.Data.Object, &sub); err != nil {
			return err
		}
		// A new subscription replaces the current one; updates/deletes of a
		// superseded subscription (e.g. the old plan after an upgrade) are
		// recorded but must not move the tenant.
		if ev.Type != "customer.subscription.created" && acct.SubscriptionID != "" && sub.ID != acct.SubscriptionID {
			return nil
		}
		if acct.LastSubscriptionEventAt != nil && ev.CreatedAt().Before(*acct.LastSubscriptionEventAt) {
			return nil // out-of-order delivery; a newer state is already applied
		}
		created := ev.CreatedAt()
		acct.LastSubscriptionEventAt = &created
		acct.SubscriptionID = sub.ID
		if pe := sub.PeriodEnd(); pe != nil {
			acct.CurrentPeriodEnd = pe
		}
		if ev.Type == "customer.subscription.deleted" {
			acct.Account = billing.OnSubscriptionDeleted(acct.Account, now)
			return nil
		}
		plans, err := loadBillingPlans(ctx, tx, h.cfg.PlanPrices, false)
		if err != nil {
			return err
		}
		planID := billing.PlanForPrices(plans, h.cfg.PlanPrices, sub.PriceIDs())
		if planID == "" && len(sub.PriceIDs()) > 0 {
			h.logger().Warn("subscription prices match no billing plan; plan unchanged",
				zap.String("subscription", sub.ID))
		}
		acct.Account = billing.OnSubscription(acct.Account, sub.Status, planID, now, h.graceDuration())
		if (sub.Status == "active" || sub.Status == "trialing") && acct.MeteringSince == nil {
			d := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
			acct.MeteringSince = &d
		}

	case "invoice.paid", "invoice.payment_failed":
		var inv billing.Invoice
		if err := json.Unmarshal(ev.Data.Object, &inv); err != nil {
			return err
		}
		if inv.Subscription != "" && acct.SubscriptionID != "" && inv.Subscription != acct.SubscriptionID {
			return nil
		}
		if ev.Type == "invoice.paid" {
			acct.Account = billing.OnInvoicePaid(acct.Account)
		} else {
			acct.Account = billing.OnInvoiceFailed(acct.Account, now, h.graceDuration())
		}
	}
	return nil
}

// ---------- background loop: dunning sweep + meter export ----------

// RunBillingLoop runs the dunning sweep and the Stripe meter export every
// interval (PAL_BILLING_SYNC_INTERVAL, default 1h). No-op when billing is
// disabled. Only started on a writable (non-standby) region.
func RunBillingLoop(ctx context.Context, h *BillingHandler, interval time.Duration) {
	if h == nil || !h.Enabled() {
		return
	}
	if interval <= 0 {
		interval = time.Hour
	}
	go func() {
		t := time.NewTimer(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			h.RunOnce(ctx)
			t.Reset(interval)
		}
	}()
}

// RunOnce performs one dunning sweep and one meter export pass.
func (h *BillingHandler) RunOnce(ctx context.Context) {
	ctx, span := otel.Tracer("pal.control-plane").Start(ctx, "billing.sync")
	defer span.End()
	downgraded := h.SweepDunning(ctx)
	sent, failed := h.ExportMeters(ctx)
	span.SetAttributes(
		attribute.Int("pal.billing.downgraded", downgraded),
		attribute.Int("pal.billing.meter_sent", sent),
		attribute.Int("pal.billing.meter_failed", failed),
	)
}

// SweepDunning downgrades every tenant whose grace window has expired.
// Returns the number downgraded.
func (h *BillingHandler) SweepDunning(ctx context.Context) int {
	// rls-exempt: background sweep with no request tenant; discovers due
	// tenants across the platform, then works each under WithTenantConn.
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT tenant_id::text FROM billing_accounts
		WHERE downgraded_at IS NULL AND grace_until IS NOT NULL AND grace_until < $1`, h.now())
	if err != nil {
		h.logger().Error("dunning sweep query failed", zap.Error(err))
		return 0
	}
	var due []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			due = append(due, t)
		}
	}
	rows.Close()
	n := 0
	for _, tenantID := range due {
		tctx := middleware.InjectTenantID(ctx, tenantID)
		err := db.WithTenantConn(tctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
			acct, err := lockBillingAccount(tctx, tx, tenantID)
			if err != nil {
				return err
			}
			next, changed := billing.Sweep(acct.Account, h.now())
			if !changed {
				return nil
			}
			acct.Account = next
			if err := h.reconcileLimits(tctx, tx, tenantID, &acct); err != nil {
				return err
			}
			n++
			return saveBillingAccount(tctx, tx, tenantID, acct)
		})
		if err != nil {
			h.logger().Error("dunning downgrade failed", zap.String("tenant", tenantID), zap.Error(err))
			continue
		}
		h.logger().Info("grace period expired; tenant moved to free limits (no data removed)", zap.String("tenant", tenantID))
	}
	return n
}

type meterClaim struct {
	meter  string
	period time.Time
	value  int64
	key    string
}

// ExportMeters pushes settled daily usage (from agent_usage_daily, the live
// metering rollup) to Stripe meter events, one event per (tenant, meter,
// day). Returns (sent, failed).
func (h *BillingHandler) ExportMeters(ctx context.Context) (int, int) {
	// rls-exempt: background export with no request tenant; lists billable
	// tenants across the platform, then works each under WithTenantConn.
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT tenant_id::text FROM billing_accounts
		WHERE stripe_customer_id IS NOT NULL AND metering_since IS NOT NULL
		  AND status IN ('active','trialing','past_due','unpaid')`)
	if err != nil {
		h.logger().Error("meter export query failed", zap.Error(err))
		return 0, 0
	}
	var tenants []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			tenants = append(tenants, t)
		}
	}
	rows.Close()
	sent, failed := 0, 0
	for _, tenantID := range tenants {
		s, f := h.exportTenantMeters(middleware.InjectTenantID(ctx, tenantID), tenantID)
		sent += s
		failed += f
	}
	return sent, failed
}

func (h *BillingHandler) exportTenantMeters(ctx context.Context, tenantID string) (int, int) {
	now := h.now()
	today, _ := time.Parse("2006-01-02", usageDate(now))
	// A day is exported once it is fully settled: strictly before yesterday,
	// so late reconciliations (voice call cost, async usage) have landed.
	// Stripe accepts meter events up to 35 days old; stay inside 30.
	settledBefore := today.AddDate(0, 0, -1)
	oldest := today.AddDate(0, 0, -30)

	var customerID string
	var claims []meterClaim
	err := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		acct, err := readBillingAccount(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		if acct.CustomerID == "" || acct.MeteringSince == nil {
			return nil
		}
		eff := billing.EffectivePlan(acct.Account, now)
		plans, err := loadBillingPlans(ctx, tx, h.cfg.PlanPrices, false)
		if err != nil {
			return err
		}
		p, ok := planByID(plans, eff)
		if !ok || len(p.StripeMeteredPriceIDs) == 0 {
			return nil // plan has no usage pricing: nothing to report
		}
		customerID = acct.CustomerID
		from := oldest
		if acct.MeteringSince.After(from) {
			from = *acct.MeteringSince
		}
		urows, err := tx.Query(ctx, `
			SELECT usage_date, COALESCE(SUM(tokens_in + tokens_out),0)::bigint, COALESCE(SUM(runs_count),0)::bigint
			FROM agent_usage_daily
			WHERE tenant_id = $1 AND usage_date >= $2 AND usage_date < $3
			GROUP BY usage_date ORDER BY usage_date`, tenantID, from, settledBefore)
		if err != nil {
			return err
		}
		type day struct {
			d            time.Time
			tokens, runs int64
		}
		var days []day
		for urows.Next() {
			var d day
			if err := urows.Scan(&d.d, &d.tokens, &d.runs); err != nil {
				urows.Close()
				return err
			}
			days = append(days, d)
		}
		urows.Close()
		if err := urows.Err(); err != nil {
			return err
		}
		for _, d := range days {
			for _, m := range []struct {
				name  string
				value int64
			}{{h.cfg.MeterTokens, d.tokens}, {h.cfg.MeterRuns, d.runs}} {
				if m.value <= 0 {
					continue
				}
				key := billing.MeterIdempotencyKey(tenantID, m.name, d.d)
				// Claim: a fresh row, or a failed/stale-pending one older than
				// 10 minutes. 'sent' is final. Two replicas cannot both claim.
				var claimed bool
				err := tx.QueryRow(ctx, `
					INSERT INTO billing_meter_exports (tenant_id, meter, period_start, value, idempotency_key, status, attempts, claimed_at)
					VALUES ($1, $2, $3, $4, $5, 'pending', 1, now())
					ON CONFLICT (tenant_id, meter, period_start) DO UPDATE SET
						value = EXCLUDED.value, status = 'pending',
						attempts = billing_meter_exports.attempts + 1, claimed_at = now()
					WHERE billing_meter_exports.status <> 'sent'
					  AND billing_meter_exports.claimed_at < now() - interval '10 minutes'
					RETURNING true`, tenantID, m.name, d.d, m.value, key).Scan(&claimed)
				if errors.Is(err, pgx.ErrNoRows) {
					continue
				}
				if err != nil {
					return err
				}
				claims = append(claims, meterClaim{meter: m.name, period: d.d, value: m.value, key: key})
			}
		}
		return nil
	})
	if err != nil {
		h.logger().Error("meter export claim failed", zap.String("tenant", tenantID), zap.Error(err))
		return 0, 0
	}

	sent, failed := 0, 0
	for _, c := range claims {
		sendErr := h.stripe.SendMeterEvent(ctx, billing.MeterEvent{
			EventName:  c.meter,
			CustomerID: customerID,
			Value:      c.value,
			Timestamp:  c.period.Add(12 * time.Hour),
			Identifier: c.key,
		})
		status, lastErr := "sent", ""
		if sendErr != nil {
			status = "failed"
			var se *billing.Error
			if errors.As(sendErr, &se) {
				lastErr = se.Type + " " + se.Code
			} else {
				lastErr = "transport error"
			}
			failed++
		} else {
			sent++
		}
		if err := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				UPDATE billing_meter_exports
				SET status = $4, last_error = NULLIF($5, ''),
				    exported_at = CASE WHEN $4 = 'sent' THEN now() ELSE exported_at END
				WHERE tenant_id = $1 AND meter = $2 AND period_start = $3`,
				tenantID, c.meter, c.period, status, lastErr)
			return e
		}); err != nil {
			h.logger().Error("meter export status update failed", zap.String("tenant", tenantID), zap.Error(err))
		}
		if sendErr != nil {
			h.logger().Warn("meter event failed; will retry", zap.String("tenant", tenantID),
				zap.String("meter", c.meter), zap.String("reason", lastErr))
		}
	}
	return sent, failed
}
