package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// DiscordDeliverer delivers notifications via Discord webhook URLs.
type DiscordDeliverer struct {
	client *http.Client
	logger *zap.Logger
}

// NewDiscordDeliverer creates a new DiscordDeliverer.
func NewDiscordDeliverer(logger *zap.Logger) *DiscordDeliverer {
	return &DiscordDeliverer{
		client: &http.Client{Timeout: 15 * time.Second},
		logger: logger.Named("discord"),
	}
}

// Channel returns the channel type.
func (d *DiscordDeliverer) Channel() Channel {
	return ChannelDiscord
}

// discordMessage represents the Discord webhook payload.
type discordMessage struct {
	Content string          `json:"content,omitempty"`
	Embeds  []discordEmbed  `json:"embeds,omitempty"`
}

type discordEmbed struct {
	Title       string              `json:"title,omitempty"`
	Description string              `json:"description,omitempty"`
	Color       int                 `json:"color,omitempty"`
	Footer      *discordEmbedFooter `json:"footer,omitempty"`
	Timestamp   string              `json:"timestamp,omitempty"`
}

type discordEmbedFooter struct {
	Text string `json:"text"`
}

// Deliver sends the notification to the Discord webhook URL (stored in Recipient).
func (d *DiscordDeliverer) Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	_, span := tracer.Start(ctx, "DiscordDeliverer.Deliver")
	defer span.End()

	msg := discordMessage{
		Embeds: []discordEmbed{
			{
				Title:       n.Subject,
				Description: n.Body,
				Color:       0x6366F1, // Lantern brand indigo.
				Footer: &discordEmbedFooter{
					Text: fmt.Sprintf("Lantern | Run: %s", n.RunID),
				},
				Timestamp: time.Now().UTC().Format(time.RFC3339),
			},
		},
	}

	body, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal discord payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.Recipient, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create discord request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := d.client.Do(req)
	if err != nil {
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	// Discord returns 204 No Content on success.
	success := resp.StatusCode >= 200 && resp.StatusCode < 300
	result := &DeliveryResult{
		Success:     success,
		StatusCode:  resp.StatusCode,
		AttemptedAt: time.Now(),
	}

	if !success {
		result.ErrorMessage = fmt.Sprintf("discord webhook returned HTTP %d", resp.StatusCode)
		d.logger.Warn("discord webhook error",
			zap.Int("status", resp.StatusCode),
		)
	}

	return result, nil
}
