package billing

import (
	"fmt"
	"time"
)

// FreePlanID is the plan every downgrade lands on. It must exist in
// billing_plans (seeded by migration 0035).
const FreePlanID = "free"

// Plan is one row of billing_plans. Plans are data: prices, limits and Stripe
// price ids live in the table so operators change them without a deploy.
type Plan struct {
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	Description           string   `json:"description"`
	MonthlyPriceCents     *int     `json:"monthlyPriceCents"`
	SelfServe             bool     `json:"selfServe"`
	StripePriceID         string   `json:"-"`
	StripeMeteredPriceIDs []string `json:"-"`
	Features              []string `json:"features"`
	SortOrder             int      `json:"-"`
	Limits                Limits   `json:"limits"`
	// Purchasable is computed: self-serve and a Stripe price is wired.
	Purchasable bool `json:"purchasable"`
}

// Limits is what a plan writes into the existing enforcement tables. A nil
// pointer means "no cap" for the budget and "operator-managed, leave as is"
// for the runtime quota (gated on MaxConcurrentVMs).
type Limits struct {
	MaxCostUsdPerDay        *float64 `json:"maxCostUsdPerDay"`
	BudgetHardFail          bool     `json:"budgetHardFail"`
	MaxConcurrentVMs        *int     `json:"maxConcurrentVMs"`
	MaxComputeHoursPerDay   *float64 `json:"maxComputeHoursPerDay"`
	MaxEgressGBPerDay       *int     `json:"maxEgressGBPerDay"`
	RuntimeMaxCostUsdPerDay *float64 `json:"runtimeMaxCostUsdPerDay"`
}

// PriceID returns the plan's flat Stripe price, honouring a config override.
func (p Plan) PriceID(overrides map[string]string) string {
	if v := overrides[p.ID]; v != "" {
		return v
	}
	return p.StripePriceID
}

// PlanForPrices maps a subscription's price ids to a plan: the first plan
// whose flat price appears on the subscription. "" when none matches (an
// unknown price is never guessed into a paid plan).
func PlanForPrices(plans []Plan, overrides map[string]string, priceIDs []string) string {
	set := make(map[string]bool, len(priceIDs))
	for _, p := range priceIDs {
		set[p] = true
	}
	for _, pl := range plans {
		if id := pl.PriceID(overrides); id != "" && set[id] {
			return pl.ID
		}
	}
	return ""
}

// Account is the dunning-relevant state of a billing_accounts row.
type Account struct {
	PlanID          string
	Status          string
	PaymentFailedAt *time.Time
	GraceUntil      *time.Time
	DowngradedAt    *time.Time
}

// Subscription statuses that end paid service.
func terminalStatus(s string) bool { return s == "canceled" || s == "incomplete_expired" }

// EffectivePlan is the plan whose limits should be enforced right now.
// Cancellation, an expired grace period, or a recorded downgrade all mean
// free limits — the paid plan_id is kept so a later payment restores it.
func EffectivePlan(a Account, now time.Time) string {
	if a.PlanID == "" {
		return FreePlanID
	}
	if terminalStatus(a.Status) || a.DowngradedAt != nil {
		return FreePlanID
	}
	if a.GraceUntil != nil && now.After(*a.GraceUntil) {
		return FreePlanID
	}
	return a.PlanID
}

// OnSubscription applies a customer.subscription.created/updated event.
// planID is the plan resolved from the subscription's prices ("" = unknown,
// keep the current plan).
func OnSubscription(a Account, status, planID string, now time.Time, grace time.Duration) Account {
	a.Status = status
	switch status {
	case "active", "trialing":
		if planID != "" {
			a.PlanID = planID
		}
		a.PaymentFailedAt, a.GraceUntil, a.DowngradedAt = nil, nil, nil
	case "past_due", "unpaid":
		if planID != "" {
			a.PlanID = planID
		}
		a = startGrace(a, now, grace)
	case "canceled", "incomplete_expired":
		a = downgrade(a, now)
	default:
		// "incomplete" / "paused" / unknown: record the status only. The plan
		// does not change until Stripe confirms payment.
	}
	return a
}

// OnSubscriptionDeleted applies customer.subscription.deleted: free limits
// now. Data is never deleted; plan_id is kept for the record.
func OnSubscriptionDeleted(a Account, now time.Time) Account {
	a.Status = "canceled"
	return downgrade(a, now)
}

// OnInvoicePaid clears dunning and restores the paid plan.
func OnInvoicePaid(a Account) Account {
	if !terminalStatus(a.Status) {
		a.Status = "active"
	}
	a.PaymentFailedAt, a.GraceUntil = nil, nil
	if !terminalStatus(a.Status) {
		a.DowngradedAt = nil
	}
	return a
}

// OnInvoiceFailed starts (or continues) the grace period. A repeat failure
// never extends an existing grace window.
func OnInvoiceFailed(a Account, now time.Time, grace time.Duration) Account {
	if !terminalStatus(a.Status) {
		a.Status = "past_due"
	}
	return startGrace(a, now, grace)
}

// Sweep is the periodic dunning step: an expired grace window becomes a
// recorded downgrade. Returns the new state and whether it changed.
func Sweep(a Account, now time.Time) (Account, bool) {
	if a.DowngradedAt == nil && a.GraceUntil != nil && now.After(*a.GraceUntil) {
		return downgrade(a, now), true
	}
	return a, false
}

func startGrace(a Account, now time.Time, grace time.Duration) Account {
	if a.PaymentFailedAt == nil {
		t := now
		a.PaymentFailedAt = &t
	}
	if a.GraceUntil == nil {
		g := a.PaymentFailedAt.Add(grace)
		a.GraceUntil = &g
	}
	return a
}

func downgrade(a Account, now time.Time) Account {
	if a.DowngradedAt == nil {
		t := now
		a.DowngradedAt = &t
	}
	return a
}

// MeterIdempotencyKey is the stable key for one (tenant, meter, period)
// export. The same key is used on every attempt, so a retry after a lost
// response — or two replicas racing — is deduplicated by Stripe.
func MeterIdempotencyKey(tenantID, meter string, period time.Time) string {
	return fmt.Sprintf("pal-meter:%s:%s:%s", tenantID, meter, period.Format("2006-01-02"))
}
