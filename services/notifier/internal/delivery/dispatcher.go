package delivery

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
)

var tracer = otel.Tracer("lantern.notifier.delivery")

// Channel represents a notification delivery channel.
type Channel string

const (
	ChannelWebhook Channel = "webhook"
	ChannelEmail   Channel = "email"
	ChannelSlack   Channel = "slack"
	ChannelDiscord Channel = "discord"
)

// Notification represents a notification to be delivered.
type Notification struct {
	ID             string
	TenantID       string
	RunID          string
	Channel        Channel
	Recipient      string
	Subject        string
	Body           string
	TemplateID     string
	IdempotencyKey string
}

// DeliveryResult represents the result of a delivery attempt.
type DeliveryResult struct {
	Success      bool
	StatusCode   int
	ErrorMessage string
	AttemptedAt  time.Time
}

// Deliverer is the interface for all delivery channel implementations.
type Deliverer interface {
	Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error)
	Channel() Channel
}

// Dispatcher routes notifications to the appropriate channel and handles retries.
type Dispatcher struct {
	channels map[Channel]Deliverer
	logger   *zap.Logger
}

// NewDispatcher creates a new Dispatcher with the given channel implementations.
func NewDispatcher(logger *zap.Logger) *Dispatcher {
	d := &Dispatcher{
		channels: make(map[Channel]Deliverer),
		logger:   logger.Named("dispatcher"),
	}
	return d
}

// RegisterChannel registers a delivery channel implementation.
func (d *Dispatcher) RegisterChannel(deliverer Deliverer) {
	d.channels[deliverer.Channel()] = deliverer
	d.logger.Info("registered delivery channel", zap.String("channel", string(deliverer.Channel())))
}

// Dispatch sends a notification through the appropriate channel.
// Returns the delivery result. Retries are handled by the caller (the handler layer)
// using the recorded delivery attempts.
func (d *Dispatcher) Dispatch(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	ctx, span := tracer.Start(ctx, "Dispatcher.Dispatch")
	defer span.End()

	span.SetAttributes(
		attribute.String("tenant_id", n.TenantID),
		attribute.String("channel", string(n.Channel)),
		attribute.String("notification_id", n.ID),
	)

	deliverer, ok := d.channels[n.Channel]
	if !ok {
		return nil, fmt.Errorf("unsupported delivery channel: %s", n.Channel)
	}

	d.logger.Info("dispatching notification",
		zap.String("notification_id", n.ID),
		zap.String("channel", string(n.Channel)),
		zap.String("recipient", n.Recipient),
	)

	result, err := deliverer.Deliver(ctx, n)
	if err != nil {
		d.logger.Error("delivery failed",
			zap.String("notification_id", n.ID),
			zap.String("channel", string(n.Channel)),
			zap.Error(err),
		)
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}

	d.logger.Info("delivery completed",
		zap.String("notification_id", n.ID),
		zap.String("channel", string(n.Channel)),
		zap.Bool("success", result.Success),
	)

	return result, nil
}

// MaxRetries returns the maximum number of retry attempts for a channel.
func MaxRetries(ch Channel) int {
	switch ch {
	case ChannelWebhook:
		return 5
	case ChannelEmail:
		return 3
	case ChannelSlack, ChannelDiscord:
		return 3
	default:
		return 3
	}
}

// RetryDelay calculates exponential backoff delay for a given attempt number.
func RetryDelay(attempt int) time.Duration {
	base := time.Second
	delay := base * time.Duration(1<<uint(attempt))
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	return delay
}
