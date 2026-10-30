package delivery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"
)

// Outbound webhooks carry the X-Pal-* headers.
func TestWebhookDeliver_Headers(t *testing.T) {
	got := make(chan http.Header, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Clone()
	}))
	defer srv.Close()

	d := NewWebhookDeliverer(zap.NewNop())
	if _, err := d.Deliver(context.Background(), &Notification{
		ID: "n1", TenantID: "t1", Recipient: srv.URL, Body: "hi", IdempotencyKey: "k1",
	}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	h := <-got
	for _, name := range []string{"Signature", "Delivery-ID", "Idempotency-Key"} {
		if h.Get("X-Pal-"+name) == "" {
			t.Errorf("missing X-Pal-%s header", name)
		}
	}
}
