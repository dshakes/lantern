package delivery

import (
	"context"
	"testing"

	"go.uber.org/zap"
)

func TestSMSChannelType(t *testing.T) {
	d := NewSMSDeliverer(zap.NewNop())
	if d.Channel() != ChannelSMS {
		t.Fatalf("expected channel %q, got %q", ChannelSMS, d.Channel())
	}
}

func TestSMSUnconfiguredFailsClosed(t *testing.T) {
	// No TWILIO_* env set: Deliver must return a non-success result without
	// an error (so the dispatcher records a failed attempt rather than
	// panicking or making a doomed HTTP call).
	t.Setenv("TWILIO_ACCOUNT_SID", "")
	t.Setenv("TWILIO_AUTH_TOKEN", "")
	d := NewSMSDeliverer(zap.NewNop())

	res, err := d.Deliver(context.Background(), &Notification{
		Channel:   ChannelSMS,
		Recipient: "+15125550000",
		Body:      "hello",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Success {
		t.Fatal("expected failure when credentials are unconfigured")
	}
}

func TestSMSMissingSenderFailsClosed(t *testing.T) {
	// Credentials present but neither messaging service nor from number set.
	t.Setenv("TWILIO_ACCOUNT_SID", "AC123")
	t.Setenv("TWILIO_AUTH_TOKEN", "token")
	t.Setenv("TWILIO_MESSAGING_SERVICE_SID", "")
	t.Setenv("TWILIO_FROM_NUMBER", "")
	d := NewSMSDeliverer(zap.NewNop())

	res, err := d.Deliver(context.Background(), &Notification{
		Channel:   ChannelSMS,
		Recipient: "+15125550000",
		Body:      "hello",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Success {
		t.Fatal("expected failure when no sender is configured")
	}
}

func TestSMSMaxRetries(t *testing.T) {
	if got := MaxRetries(ChannelSMS); got != 2 {
		t.Fatalf("expected 2 retries for SMS, got %d", got)
	}
}
