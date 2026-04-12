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

// SlackDeliverer delivers notifications via Slack incoming webhook URLs.
type SlackDeliverer struct {
	client *http.Client
	logger *zap.Logger
}

// NewSlackDeliverer creates a new SlackDeliverer.
func NewSlackDeliverer(logger *zap.Logger) *SlackDeliverer {
	return &SlackDeliverer{
		client: &http.Client{Timeout: 15 * time.Second},
		logger: logger.Named("slack"),
	}
}

// Channel returns the channel type.
func (s *SlackDeliverer) Channel() Channel {
	return ChannelSlack
}

// slackMessage represents the Slack webhook payload.
type slackMessage struct {
	Text        string           `json:"text,omitempty"`
	Blocks      []slackBlock     `json:"blocks,omitempty"`
	Attachments []slackAttachment `json:"attachments,omitempty"`
}

type slackBlock struct {
	Type string         `json:"type"`
	Text *slackTextObj  `json:"text,omitempty"`
}

type slackTextObj struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type slackAttachment struct {
	Color  string `json:"color,omitempty"`
	Text   string `json:"text,omitempty"`
	Footer string `json:"footer,omitempty"`
}

// Deliver sends the notification to the Slack webhook URL (stored in Recipient).
func (s *SlackDeliverer) Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	_, span := tracer.Start(ctx, "SlackDeliverer.Deliver")
	defer span.End()

	msg := slackMessage{
		Blocks: []slackBlock{
			{
				Type: "header",
				Text: &slackTextObj{
					Type: "plain_text",
					Text: n.Subject,
				},
			},
			{
				Type: "section",
				Text: &slackTextObj{
					Type: "mrkdwn",
					Text: n.Body,
				},
			},
		},
		Attachments: []slackAttachment{
			{
				Color:  "#6366f1",
				Footer: fmt.Sprintf("Lantern | Run: %s", n.RunID),
			},
		},
	}

	if n.Subject == "" {
		msg.Blocks = msg.Blocks[1:]
	}

	body, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal slack payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.Recipient, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create slack request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	success := resp.StatusCode == http.StatusOK
	result := &DeliveryResult{
		Success:     success,
		StatusCode:  resp.StatusCode,
		AttemptedAt: time.Now(),
	}

	if !success {
		result.ErrorMessage = fmt.Sprintf("slack webhook returned HTTP %d", resp.StatusCode)
		s.logger.Warn("slack webhook error",
			zap.Int("status", resp.StatusCode),
		)
	}

	return result, nil
}
