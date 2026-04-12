package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/smtp"
	"os"
	"time"

	"go.uber.org/zap"
)

// EmailDeliverer delivers notifications via SMTP or Resend API.
type EmailDeliverer struct {
	smtpHost string
	smtpPort string
	smtpUser string
	smtpPass string
	fromAddr string
	resendKey string
	client   *http.Client
	logger   *zap.Logger
}

// NewEmailDeliverer creates a new EmailDeliverer, using Resend if API key is set,
// falling back to SMTP otherwise.
func NewEmailDeliverer(logger *zap.Logger) *EmailDeliverer {
	return &EmailDeliverer{
		smtpHost:  envOrDefault("SMTP_HOST", "localhost"),
		smtpPort:  envOrDefault("SMTP_PORT", "587"),
		smtpUser:  os.Getenv("SMTP_USER"),
		smtpPass:  os.Getenv("SMTP_PASS"),
		fromAddr:  envOrDefault("EMAIL_FROM", "noreply@lantern.dev"),
		resendKey: os.Getenv("RESEND_API_KEY"),
		client:    &http.Client{Timeout: 30 * time.Second},
		logger:    logger.Named("email"),
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// Channel returns the channel type.
func (e *EmailDeliverer) Channel() Channel {
	return ChannelEmail
}

// Deliver sends the notification via email.
func (e *EmailDeliverer) Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	_, span := tracer.Start(ctx, "EmailDeliverer.Deliver")
	defer span.End()

	if e.resendKey != "" {
		return e.deliverViaResend(ctx, n)
	}
	return e.deliverViaSMTP(ctx, n)
}

func (e *EmailDeliverer) deliverViaResend(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	payload := map[string]any{
		"from":    e.fromAddr,
		"to":      []string{n.Recipient},
		"subject": n.Subject,
		"html":    n.Body,
	}

	if n.IdempotencyKey != "" {
		payload["headers"] = map[string]string{
			"X-Idempotency-Key": n.IdempotencyKey,
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal resend payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create resend request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.resendKey)

	resp, err := e.client.Do(req)
	if err != nil {
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}
	defer resp.Body.Close()

	success := resp.StatusCode >= 200 && resp.StatusCode < 300
	result := &DeliveryResult{
		Success:     success,
		StatusCode:  resp.StatusCode,
		AttemptedAt: time.Now(),
	}

	if !success {
		result.ErrorMessage = fmt.Sprintf("resend API returned HTTP %d", resp.StatusCode)
		e.logger.Warn("resend API error",
			zap.Int("status", resp.StatusCode),
			zap.String("recipient", n.Recipient),
		)
	}

	return result, nil
}

func (e *EmailDeliverer) deliverViaSMTP(_ context.Context, n *Notification) (*DeliveryResult, error) {
	subject := n.Subject
	if subject == "" {
		subject = "Lantern Notification"
	}

	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s",
		e.fromAddr, n.Recipient, subject, n.Body)

	addr := fmt.Sprintf("%s:%s", e.smtpHost, e.smtpPort)

	var auth smtp.Auth
	if e.smtpUser != "" {
		auth = smtp.PlainAuth("", e.smtpUser, e.smtpPass, e.smtpHost)
	}

	err := smtp.SendMail(addr, auth, e.fromAddr, []string{n.Recipient}, []byte(msg))
	if err != nil {
		e.logger.Error("SMTP delivery failed",
			zap.String("recipient", n.Recipient),
			zap.Error(err),
		)
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}

	return &DeliveryResult{
		Success:     true,
		AttemptedAt: time.Now(),
	}, nil
}
