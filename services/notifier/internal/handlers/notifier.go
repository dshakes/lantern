package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/dshakes/lantern/services/notifier/internal/delivery"
	"github.com/dshakes/lantern/services/notifier/internal/middleware"
	"github.com/dshakes/lantern/services/notifier/internal/server"
)

var tracer = otel.Tracer("lantern.notifier")

// NotifyRequest represents a request to send a notification.
type NotifyRequest struct {
	TenantID   string            `json:"tenant_id"`
	RunID      string            `json:"run_id"`
	Channel    string            `json:"channel"`
	Recipient  string            `json:"recipient"`
	Subject    string            `json:"subject"`
	Body       string            `json:"body"`
	TemplateID string            `json:"template_id"`
	Data       map[string]string `json:"data"`
}

// NotifyResponse represents the result of a notification request.
type NotifyResponse struct {
	NotificationID string `json:"notification_id"`
	Status         string `json:"status"`
}

// Subscription represents a notification subscription.
type Subscription struct {
	ID        string          `json:"id"`
	TenantID  string          `json:"tenant_id"`
	EventType string          `json:"event_type"`
	Channel   string          `json:"channel"`
	Config    json.RawMessage `json:"config"`
	Enabled   bool            `json:"enabled"`
	CreatedAt time.Time       `json:"created_at"`
}

// ListSubscriptionsRequest represents a request to list subscriptions.
type ListSubscriptionsRequest struct {
	TenantID string `json:"tenant_id"`
}

// ListSubscriptionsResponse represents the result of listing subscriptions.
type ListSubscriptionsResponse struct {
	Subscriptions []*Subscription `json:"subscriptions"`
}

// NotifierService implements the notification gRPC handlers.
type NotifierService struct {
	srv        *server.Server
	dispatcher *delivery.Dispatcher
}

// NewNotifierService creates a new NotifierService handler.
func NewNotifierService(srv *server.Server, dispatcher *delivery.Dispatcher) *NotifierService {
	return &NotifierService{srv: srv, dispatcher: dispatcher}
}

func (s *NotifierService) logger() *zap.Logger {
	return s.srv.Logger.Named("notifier_service")
}

// setRLSTenantID sets the session variable used by Postgres RLS policies.
func setRLSTenantID(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL app.tenant_id = '%s'", tenantID))
	return err
}

// Notify creates a notification and dispatches delivery.
func (s *NotifierService) Notify(ctx context.Context, req *NotifyRequest) (*NotifyResponse, error) {
	ctx, span := tracer.Start(ctx, "NotifierService.Notify")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("channel", req.Channel),
		attribute.String("recipient", req.Recipient),
	)

	if req.Channel == "" {
		return nil, status.Error(codes.InvalidArgument, "channel is required")
	}
	if req.Recipient == "" {
		return nil, status.Error(codes.InvalidArgument, "recipient is required")
	}
	if req.Body == "" {
		return nil, status.Error(codes.InvalidArgument, "body is required")
	}

	// Generate idempotency key from run_id + channel + recipient + body hash.
	idempotencyKey := generateIdempotencyKey(tenantID, req.RunID, req.Channel, req.Recipient)

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Check for idempotent duplicate.
	var existingID string
	var existingStatus string
	err = tx.QueryRow(ctx, `
		SELECT id, status FROM notifications
		WHERE idempotency_key = $1
	`, idempotencyKey).Scan(&existingID, &existingStatus)
	if err == nil {
		// Already exists — idempotent return.
		s.logger().Debug("idempotent duplicate notification",
			zap.String("notification_id", existingID),
			zap.String("idempotency_key", idempotencyKey),
		)
		return &NotifyResponse{
			NotificationID: existingID,
			Status:         existingStatus,
		}, nil
	}
	if err != pgx.ErrNoRows {
		return nil, status.Errorf(codes.Internal, "failed to check idempotency: %v", err)
	}

	// Insert notification.
	var notificationID string
	err = tx.QueryRow(ctx, `
		INSERT INTO notifications (tenant_id, run_id, channel, recipient, subject, body, template_id, status, idempotency_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
		RETURNING id
	`, tenantID, nilIfEmpty(req.RunID), req.Channel, req.Recipient, req.Subject, req.Body, nilIfEmpty(req.TemplateID), idempotencyKey).Scan(&notificationID)
	if err != nil {
		s.logger().Error("insert notification failed", zap.Error(err))
		return nil, status.Errorf(codes.Internal, "failed to insert notification: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	// Dispatch delivery asynchronously.
	go s.dispatchWithRetry(context.Background(), notificationID, tenantID, req, idempotencyKey)

	s.logger().Info("notification created",
		zap.String("notification_id", notificationID),
		zap.String("tenant_id", tenantID),
		zap.String("channel", req.Channel),
	)

	return &NotifyResponse{
		NotificationID: notificationID,
		Status:         "pending",
	}, nil
}

// dispatchWithRetry dispatches the notification and retries on failure with exponential backoff.
func (s *NotifierService) dispatchWithRetry(ctx context.Context, notificationID, tenantID string, req *NotifyRequest, idempotencyKey string) {
	n := &delivery.Notification{
		ID:             notificationID,
		TenantID:       tenantID,
		RunID:          req.RunID,
		Channel:        delivery.Channel(req.Channel),
		Recipient:      req.Recipient,
		Subject:        req.Subject,
		Body:           req.Body,
		TemplateID:     req.TemplateID,
		IdempotencyKey: idempotencyKey,
	}

	maxRetries := delivery.MaxRetries(n.Channel)

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := delivery.RetryDelay(attempt - 1)
			s.logger().Info("retrying delivery",
				zap.String("notification_id", notificationID),
				zap.Int("attempt", attempt),
				zap.Duration("delay", delay),
			)
			select {
			case <-ctx.Done():
				s.recordAttempt(ctx, notificationID, req.Channel, "cancelled", "context cancelled", 0)
				return
			case <-time.After(delay):
			}
		}

		result, err := s.dispatcher.Dispatch(ctx, n)
		if err != nil {
			s.logger().Error("dispatch error",
				zap.String("notification_id", notificationID),
				zap.Int("attempt", attempt),
				zap.Error(err),
			)
			s.recordAttempt(ctx, notificationID, req.Channel, "error", err.Error(), 0)
			continue
		}

		s.recordAttempt(ctx, notificationID, req.Channel,
			boolToStatus(result.Success), result.ErrorMessage, result.StatusCode)

		if result.Success {
			s.updateNotificationStatus(ctx, notificationID, "delivered")
			return
		}
	}

	// All retries exhausted.
	s.updateNotificationStatus(ctx, notificationID, "failed")
	s.logger().Error("notification delivery failed after all retries",
		zap.String("notification_id", notificationID),
		zap.Int("max_retries", maxRetries),
	)
}

// recordAttempt records a delivery attempt in the database.
func (s *NotifierService) recordAttempt(ctx context.Context, notificationID, channel, attemptStatus, errorMsg string, responseCode int) {
	_, err := s.srv.Pool.Exec(ctx, `
		INSERT INTO delivery_attempts (notification_id, channel, status, error, response_code)
		VALUES ($1, $2, $3, $4, $5)
	`, notificationID, channel, attemptStatus, nilIfEmpty(errorMsg), nilIntIfZero(responseCode))
	if err != nil {
		s.logger().Error("failed to record delivery attempt",
			zap.String("notification_id", notificationID),
			zap.Error(err),
		)
	}
}

// updateNotificationStatus updates the notification status.
func (s *NotifierService) updateNotificationStatus(ctx context.Context, notificationID, newStatus string) {
	_, err := s.srv.Pool.Exec(ctx, `
		UPDATE notifications SET status = $2 WHERE id = $1
	`, notificationID, newStatus)
	if err != nil {
		s.logger().Error("failed to update notification status",
			zap.String("notification_id", notificationID),
			zap.String("status", newStatus),
			zap.Error(err),
		)
	}
}

// ListSubscriptions returns all subscriptions for a tenant.
func (s *NotifierService) ListSubscriptions(ctx context.Context, req *ListSubscriptionsRequest) (*ListSubscriptionsResponse, error) {
	ctx, span := tracer.Start(ctx, "NotifierService.ListSubscriptions")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(attribute.String("tenant_id", tenantID))

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT id, tenant_id, event_type, channel, config, enabled, created_at
		FROM subscriptions
		WHERE tenant_id = $1
		ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}
	defer rows.Close()

	var subs []*Subscription
	for rows.Next() {
		var sub Subscription
		if err := rows.Scan(&sub.ID, &sub.TenantID, &sub.EventType, &sub.Channel, &sub.Config, &sub.Enabled, &sub.CreatedAt); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		subs = append(subs, &sub)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	return &ListSubscriptionsResponse{Subscriptions: subs}, nil
}

// generateIdempotencyKey produces a deterministic key for deduplication.
func generateIdempotencyKey(tenantID, runID, channel, recipient string) string {
	h := sha256.New()
	h.Write([]byte(tenantID))
	h.Write([]byte(":"))
	h.Write([]byte(runID))
	h.Write([]byte(":"))
	h.Write([]byte(channel))
	h.Write([]byte(":"))
	h.Write([]byte(recipient))
	return fmt.Sprintf("%x", h.Sum(nil))
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nilIntIfZero(i int) *int {
	if i == 0 {
		return nil
	}
	return &i
}

func boolToStatus(b bool) string {
	if b {
		return "success"
	}
	return "failed"
}
