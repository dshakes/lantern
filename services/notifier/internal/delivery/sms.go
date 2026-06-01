package delivery

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"
)

// SMSDeliverer delivers notifications as SMS via Twilio's Messages API.
//
// Credentials come from the environment so the notifier stays stateless:
//
//	TWILIO_ACCOUNT_SID          – Account SID (AC...). Required.
//	TWILIO_AUTH_TOKEN           – Auth token. Required.
//	TWILIO_MESSAGING_SERVICE_SID – Messaging Service SID (MG...). Preferred:
//	                               required for A2P 10DLC and lets Twilio pick
//	                               the sending number / handle failover.
//	TWILIO_FROM_NUMBER          – E.164 sender. Used when no messaging service
//	                               is configured.
//
// At least one of TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER must be
// set. The notification Recipient is the destination phone number (E.164).
type SMSDeliverer struct {
	accountSID       string
	authToken        string
	fromNumber       string
	messagingService string
	client           *http.Client
	logger           *zap.Logger
}

// NewSMSDeliverer constructs an SMSDeliverer from environment configuration.
// When credentials are absent the deliverer is still registered but every
// Deliver call returns a non-retryable configuration error.
func NewSMSDeliverer(logger *zap.Logger) *SMSDeliverer {
	d := &SMSDeliverer{
		accountSID:       os.Getenv("TWILIO_ACCOUNT_SID"),
		authToken:        os.Getenv("TWILIO_AUTH_TOKEN"),
		fromNumber:       os.Getenv("TWILIO_FROM_NUMBER"),
		messagingService: os.Getenv("TWILIO_MESSAGING_SERVICE_SID"),
		client:           &http.Client{Timeout: 15 * time.Second},
		logger:           logger.Named("sms"),
	}
	if d.accountSID == "" || d.authToken == "" {
		d.logger.Warn("Twilio SMS channel unconfigured — set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (and a messaging service or from number) to enable SMS notifications")
	}
	return d
}

// Channel returns the channel type.
func (d *SMSDeliverer) Channel() Channel { return ChannelSMS }

// Deliver sends the notification body as an SMS to n.Recipient.
func (d *SMSDeliverer) Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	_, span := tracer.Start(ctx, "SMSDeliverer.Deliver")
	defer span.End()

	if d.accountSID == "" || d.authToken == "" {
		// Misconfiguration, not a transient failure — surface it so the
		// caller stops retrying (see MaxRetries: 0 for SMS below).
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: "Twilio credentials not configured",
			AttemptedAt:  time.Now(),
		}, nil
	}
	if d.messagingService == "" && d.fromNumber == "" {
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: "no TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER configured",
			AttemptedAt:  time.Now(),
		}, nil
	}
	if n.Recipient == "" {
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: "empty SMS recipient",
			AttemptedAt:  time.Now(),
		}, nil
	}

	// SMS has no subject; prefix the body with it when present so the
	// recipient still gets the context.
	body := n.Body
	if n.Subject != "" {
		body = n.Subject + ": " + n.Body
	}

	form := url.Values{
		"To":   {n.Recipient},
		"Body": {body},
	}
	// Prefer a messaging service (A2P 10DLC, failover, number pooling); fall
	// back to an explicit from number.
	if d.messagingService != "" {
		form.Set("MessagingServiceSid", d.messagingService)
	} else {
		form.Set("From", d.fromNumber)
	}

	endpoint := fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json", d.accountSID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build SMS request: %w", err)
	}
	basic := base64.StdEncoding.EncodeToString([]byte(d.accountSID + ":" + d.authToken))
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := d.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send SMS: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		// Pull Twilio's structured error message when available.
		msg := strings.TrimSpace(string(respBody))
		var twErr struct {
			Message string `json:"message"`
			Code    int    `json:"code"`
		}
		if json.Unmarshal(respBody, &twErr) == nil && twErr.Message != "" {
			msg = fmt.Sprintf("twilio %d: %s", twErr.Code, twErr.Message)
		}
		return &DeliveryResult{
			Success:      false,
			StatusCode:   resp.StatusCode,
			ErrorMessage: msg,
			AttemptedAt:  time.Now(),
		}, nil
	}

	return &DeliveryResult{
		Success:     true,
		StatusCode:  resp.StatusCode,
		AttemptedAt: time.Now(),
	}, nil
}
