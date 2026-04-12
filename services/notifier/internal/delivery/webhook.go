package delivery

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// WebhookDeliverer delivers notifications via HTTP POST with HMAC signature.
type WebhookDeliverer struct {
	client *http.Client
	logger *zap.Logger
}

// NewWebhookDeliverer creates a new WebhookDeliverer.
func NewWebhookDeliverer(logger *zap.Logger) *WebhookDeliverer {
	return &WebhookDeliverer{
		client: &http.Client{Timeout: 30 * time.Second},
		logger: logger.Named("webhook"),
	}
}

// Channel returns the channel type.
func (w *WebhookDeliverer) Channel() Channel {
	return ChannelWebhook
}

// webhookPayload is the JSON payload sent to webhook endpoints.
type webhookPayload struct {
	ID             string `json:"id"`
	TenantID       string `json:"tenant_id"`
	RunID          string `json:"run_id,omitempty"`
	Subject        string `json:"subject,omitempty"`
	Body           string `json:"body"`
	Timestamp      string `json:"timestamp"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

// Deliver sends the notification to the webhook URL (stored in Recipient).
func (w *WebhookDeliverer) Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	ctx, span := tracer.Start(ctx, "WebhookDeliverer.Deliver")
	defer span.End()

	payload := webhookPayload{
		ID:             n.ID,
		TenantID:       n.TenantID,
		RunID:          n.RunID,
		Subject:        n.Subject,
		Body:           n.Body,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
		IdempotencyKey: n.IdempotencyKey,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal webhook payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.Recipient, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create webhook request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Lantern-Notifier/1.0")

	// HMAC-SHA256 signature for webhook verification.
	// The signing secret would come from the subscription config in production.
	// Here we use the tenant_id as a derived key.
	signature := computeHMAC(body, n.TenantID)
	req.Header.Set("X-Lantern-Signature", "sha256="+signature)
	req.Header.Set("X-Lantern-Delivery-ID", n.ID)

	if n.IdempotencyKey != "" {
		req.Header.Set("X-Lantern-Idempotency-Key", n.IdempotencyKey)
	}

	resp, err := w.client.Do(req)
	if err != nil {
		w.logger.Error("webhook delivery failed",
			zap.String("url", n.Recipient),
			zap.Error(err),
		)
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}
	defer resp.Body.Close()

	// Read and discard body to allow connection reuse.
	_, _ = io.Copy(io.Discard, resp.Body)

	success := resp.StatusCode >= 200 && resp.StatusCode < 300
	result := &DeliveryResult{
		Success:    success,
		StatusCode: resp.StatusCode,
		AttemptedAt: time.Now(),
	}

	if !success {
		result.ErrorMessage = fmt.Sprintf("webhook returned HTTP %d", resp.StatusCode)
		w.logger.Warn("webhook returned non-2xx",
			zap.String("url", n.Recipient),
			zap.Int("status", resp.StatusCode),
		)
	}

	return result, nil
}

// computeHMAC generates an HMAC-SHA256 signature for the given payload.
func computeHMAC(payload []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}
