package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DefaultSignatureTolerance is Stripe's recommended replay window.
const DefaultSignatureTolerance = 5 * time.Minute

var (
	ErrNoSignature      = errors.New("billing: missing Stripe-Signature")
	ErrBadSignature     = errors.New("billing: signature mismatch")
	ErrStaleSignature   = errors.New("billing: signature timestamp outside tolerance")
	ErrMalformedSigHead = errors.New("billing: malformed Stripe-Signature")
)

// VerifySignature checks a Stripe-Signature header ("t=<unix>,v1=<hex>[,v1=…]")
// against the raw request body: HMAC-SHA256 over "<t>.<body>" keyed by the
// endpoint secret, constant-time compared, timestamp within tolerance.
func VerifySignature(payload []byte, header, secret string, tolerance time.Duration, now time.Time) error {
	if strings.TrimSpace(header) == "" {
		return ErrNoSignature
	}
	if secret == "" {
		return ErrBadSignature
	}
	var ts int64
	var sigs [][]byte
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return ErrMalformedSigHead
			}
			ts = n
		case "v1":
			b, err := hex.DecodeString(v)
			if err == nil {
				sigs = append(sigs, b)
			}
		}
	}
	if ts == 0 || len(sigs) == 0 {
		return ErrMalformedSigHead
	}
	if tolerance > 0 {
		d := now.Sub(time.Unix(ts, 0))
		if d < -tolerance || d > tolerance {
			return ErrStaleSignature
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte("."))
	mac.Write(payload)
	want := mac.Sum(nil)
	for _, s := range sigs {
		if hmac.Equal(s, want) {
			return nil
		}
	}
	return ErrBadSignature
}

// SignPayload produces a valid Stripe-Signature header. Used by tests and by
// operators' local replay tooling; never by the request path.
func SignPayload(payload []byte, secret string, ts time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.", ts.Unix())
	mac.Write(payload)
	return fmt.Sprintf("t=%d,v1=%s", ts.Unix(), hex.EncodeToString(mac.Sum(nil)))
}

// Event is the subset of a Stripe event the handler consumes.
type Event struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Created int64  `json:"created"`
	Data    struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

// CreatedAt is the event's Stripe creation time.
func (e Event) CreatedAt() time.Time { return time.Unix(e.Created, 0).UTC() }

// Subscription is the subset of a Stripe subscription object we read.
type Subscription struct {
	ID               string            `json:"id"`
	Customer         string            `json:"customer"`
	Status           string            `json:"status"`
	CurrentPeriodEnd int64             `json:"current_period_end"`
	Metadata         map[string]string `json:"metadata"`
	Items            struct {
		Data []struct {
			CurrentPeriodEnd int64 `json:"current_period_end"`
			Price            struct {
				ID string `json:"id"`
			} `json:"price"`
		} `json:"data"`
	} `json:"items"`
}

// PriceIDs lists every price on the subscription.
func (s Subscription) PriceIDs() []string {
	out := make([]string, 0, len(s.Items.Data))
	for _, it := range s.Items.Data {
		if it.Price.ID != "" {
			out = append(out, it.Price.ID)
		}
	}
	return out
}

// PeriodEnd handles both API shapes: current_period_end at the top level
// (older versions) or per item (2025+).
func (s Subscription) PeriodEnd() *time.Time {
	end := s.CurrentPeriodEnd
	if end == 0 {
		for _, it := range s.Items.Data {
			if it.CurrentPeriodEnd > end {
				end = it.CurrentPeriodEnd
			}
		}
	}
	if end == 0 {
		return nil
	}
	t := time.Unix(end, 0).UTC()
	return &t
}

// Invoice is the subset of a Stripe invoice we read.
type Invoice struct {
	ID           string `json:"id"`
	Customer     string `json:"customer"`
	Subscription string `json:"subscription"`
}

// CheckoutSession is the subset of a completed checkout session we read.
type CheckoutSession struct {
	ID                string `json:"id"`
	Customer          string `json:"customer"`
	Subscription      string `json:"subscription"`
	ClientReferenceID string `json:"client_reference_id"`
}

// CustomerOf extracts the Stripe customer id (and, when present, the PAL
// tenant id we stamped in metadata / client_reference_id) from an event's
// object, whatever its type.
func CustomerOf(e Event) (customerID, tenantHint string) {
	var probe struct {
		Customer          string            `json:"customer"`
		ClientReferenceID string            `json:"client_reference_id"`
		Metadata          map[string]string `json:"metadata"`
	}
	_ = json.Unmarshal(e.Data.Object, &probe)
	tenantHint = probe.ClientReferenceID
	if tenantHint == "" && probe.Metadata != nil {
		tenantHint = probe.Metadata["pal_tenant_id"]
	}
	return probe.Customer, tenantHint
}
