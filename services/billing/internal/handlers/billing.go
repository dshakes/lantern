package handlers

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/dshakes/lantern/services/billing/internal/middleware"
	"github.com/dshakes/lantern/services/billing/internal/server"
)

var tracer = otel.Tracer("lantern.billing")

// UsageEvent represents a single usage event for metering.
type UsageEvent struct {
	RunID          string  `json:"run_id"`
	EventType      string  `json:"event_type"`
	Quantity       float64 `json:"quantity"`
	Unit           string  `json:"unit"`
	ModelUsed      string  `json:"model_used"`
	CostUSD        float64 `json:"cost_usd"`
	IdempotencyKey string  `json:"idempotency_key"`
}

// EmitUsageRequest represents a request to emit usage events.
type EmitUsageRequest struct {
	TenantID string        `json:"tenant_id"`
	RunID    string        `json:"run_id"`
	Events   []*UsageEvent `json:"events"`
}

// EmitUsageResponse represents the result of emitting usage events.
type EmitUsageResponse struct {
	Accepted int32 `json:"accepted"`
	Rejected int32 `json:"rejected"`
}

// BudgetStatus represents the current budget status for a tenant.
type BudgetStatus struct {
	MonthlyLimitUSD    float64 `json:"monthly_limit_usd"`
	CurrentSpendUSD    float64 `json:"current_spend_usd"`
	RemainingUSD       float64 `json:"remaining_usd"`
	UsagePercentage    float64 `json:"usage_percentage"`
	HardLimit          bool    `json:"hard_limit"`
	HardLimitReached   bool    `json:"hard_limit_reached"`
	AlertThresholdPct  int32   `json:"alert_threshold_pct"`
	AlertThresholdHit  bool    `json:"alert_threshold_hit"`
}

// CheckBudgetRequest represents a request to check budget status.
type CheckBudgetRequest struct {
	TenantID string `json:"tenant_id"`
}

// UsageAggregation represents an aggregated usage row.
type UsageAggregation struct {
	EventType     string  `json:"event_type"`
	TotalQuantity float64 `json:"total_quantity"`
	TotalCostUSD  float64 `json:"total_cost_usd"`
}

// GetUsageRequest represents a request to get aggregated usage.
type GetUsageRequest struct {
	TenantID string    `json:"tenant_id"`
	From     time.Time `json:"from"`
	To       time.Time `json:"to"`
	GroupBy  string    `json:"group_by"` // "event_type", "model", "day"
}

// GetUsageResponse represents the result of a usage query.
type GetUsageResponse struct {
	Aggregations []*UsageAggregation `json:"aggregations"`
	TotalCostUSD float64             `json:"total_cost_usd"`
}

// SetBudgetRequest represents a request to set a budget.
type SetBudgetRequest struct {
	TenantID          string  `json:"tenant_id"`
	MonthlyLimitUSD   float64 `json:"monthly_limit_usd"`
	AlertThresholdPct int32   `json:"alert_threshold_pct"`
	HardLimit         bool    `json:"hard_limit"`
}

// SetBudgetResponse represents the result of setting a budget.
type SetBudgetResponse struct {
	Success bool `json:"success"`
}

// BillingService implements the billing gRPC handlers.
type BillingService struct {
	srv *server.Server
}

// NewBillingService creates a new BillingService handler.
func NewBillingService(srv *server.Server) *BillingService {
	return &BillingService{srv: srv}
}

func (s *BillingService) logger() *zap.Logger {
	return s.srv.Logger.Named("billing_service")
}

// setRLSTenantID sets the session variable used by Postgres RLS policies.
func setRLSTenantID(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL app.tenant_id = '%s'", tenantID))
	return err
}

// EmitUsage batch-inserts usage events for metering.
func (s *BillingService) EmitUsage(ctx context.Context, req *EmitUsageRequest) (*EmitUsageResponse, error) {
	ctx, span := tracer.Start(ctx, "BillingService.EmitUsage")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.Int("event_count", len(req.Events)),
	)

	if len(req.Events) == 0 {
		return nil, status.Error(codes.InvalidArgument, "events list is empty")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	var accepted, rejected int32
	for _, event := range req.Events {
		if err := validateUsageEvent(event); err != nil {
			s.logger().Warn("rejected usage event",
				zap.String("tenant_id", tenantID),
				zap.String("event_type", event.EventType),
				zap.Error(err),
			)
			rejected++
			continue
		}

		runID := nilIfEmpty(event.RunID)
		if runID == nil && req.RunID != "" {
			runID = &req.RunID
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO usage_events (tenant_id, run_id, event_type, quantity, unit, model_used, cost_usd, idempotency_key)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		`, tenantID, runID, event.EventType, event.Quantity, event.Unit,
			nilIfEmpty(event.ModelUsed), event.CostUSD, nilIfEmpty(event.IdempotencyKey))
		if err != nil {
			s.logger().Error("insert usage event failed",
				zap.String("tenant_id", tenantID),
				zap.Error(err),
			)
			rejected++
			continue
		}
		accepted++
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("usage events emitted",
		zap.String("tenant_id", tenantID),
		zap.Int32("accepted", accepted),
		zap.Int32("rejected", rejected),
	)

	return &EmitUsageResponse{
		Accepted: accepted,
		Rejected: rejected,
	}, nil
}

// CheckBudget returns the current budget status for a tenant.
func (s *BillingService) CheckBudget(ctx context.Context, req *CheckBudgetRequest) (*BudgetStatus, error) {
	ctx, span := tracer.Start(ctx, "BillingService.CheckBudget")
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

	// Get budget.
	var monthlyLimitUSD float64
	var alertThresholdPct int32
	var hardLimit bool
	err = tx.QueryRow(ctx, `
		SELECT monthly_limit_usd, alert_threshold_pct, hard_limit
		FROM budgets
		WHERE tenant_id = $1
	`, tenantID).Scan(&monthlyLimitUSD, &alertThresholdPct, &hardLimit)
	if err != nil {
		if err == pgx.ErrNoRows {
			// No budget set — return unlimited.
			return &BudgetStatus{
				MonthlyLimitUSD:   0,
				CurrentSpendUSD:   0,
				RemainingUSD:      0,
				UsagePercentage:   0,
				HardLimit:         false,
				HardLimitReached:  false,
				AlertThresholdPct: 0,
				AlertThresholdHit: false,
			}, nil
		}
		return nil, status.Errorf(codes.Internal, "failed to query budget: %v", err)
	}

	// Get current period spend from aggregations.
	now := time.Now().UTC()
	periodStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	periodEnd := periodStart.AddDate(0, 1, 0)

	var currentSpend float64
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(total_cost_usd), 0)
		FROM aggregations
		WHERE tenant_id = $1
		  AND period_start >= $2
		  AND period_start < $3
	`, tenantID, periodStart, periodEnd).Scan(&currentSpend)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to query current spend: %v", err)
	}

	// Also include un-aggregated events from this period.
	var unaggregatedSpend float64
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(cost_usd), 0)
		FROM usage_events
		WHERE tenant_id = $1
		  AND created_at >= $2
		  AND created_at < $3
		  AND created_at > (
			SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
			FROM aggregations
			WHERE tenant_id = $1 AND period_start >= $2
		  )
	`, tenantID, periodStart, periodEnd).Scan(&unaggregatedSpend)
	if err != nil {
		s.logger().Warn("failed to query unaggregated spend", zap.Error(err))
	}

	totalSpend := currentSpend + unaggregatedSpend
	remaining := monthlyLimitUSD - totalSpend
	if remaining < 0 {
		remaining = 0
	}

	var usagePct float64
	if monthlyLimitUSD > 0 {
		usagePct = (totalSpend / monthlyLimitUSD) * 100
	}

	bs := &BudgetStatus{
		MonthlyLimitUSD:    monthlyLimitUSD,
		CurrentSpendUSD:    totalSpend,
		RemainingUSD:       remaining,
		UsagePercentage:    usagePct,
		HardLimit:          hardLimit,
		HardLimitReached:   hardLimit && totalSpend >= monthlyLimitUSD,
		AlertThresholdPct:  alertThresholdPct,
		AlertThresholdHit:  usagePct >= float64(alertThresholdPct),
	}

	if bs.HardLimitReached {
		s.logger().Warn("tenant hard budget limit reached",
			zap.String("tenant_id", tenantID),
			zap.Float64("spend", totalSpend),
			zap.Float64("limit", monthlyLimitUSD),
		)
	}

	return bs, nil
}

// GetUsage returns aggregated usage for a tenant over a time range.
func (s *BillingService) GetUsage(ctx context.Context, req *GetUsageRequest) (*GetUsageResponse, error) {
	ctx, span := tracer.Start(ctx, "BillingService.GetUsage")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("group_by", req.GroupBy),
	)

	if req.From.IsZero() || req.To.IsZero() {
		return nil, status.Error(codes.InvalidArgument, "from and to timestamps are required")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Query based on group_by parameter.
	var query string
	switch req.GroupBy {
	case "model":
		query = `
			SELECT COALESCE(model_used, 'unknown') AS event_type, SUM(quantity), SUM(cost_usd)
			FROM usage_events
			WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
			GROUP BY model_used
			ORDER BY SUM(cost_usd) DESC`
	case "day":
		query = `
			SELECT date_trunc('day', created_at)::text AS event_type, SUM(quantity), SUM(cost_usd)
			FROM usage_events
			WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
			GROUP BY date_trunc('day', created_at)
			ORDER BY date_trunc('day', created_at)`
	default:
		// Default: group by event_type.
		query = `
			SELECT event_type, SUM(quantity), SUM(cost_usd)
			FROM usage_events
			WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
			GROUP BY event_type
			ORDER BY SUM(cost_usd) DESC`
	}

	rows, err := tx.Query(ctx, query, tenantID, req.From, req.To)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}
	defer rows.Close()

	var aggregations []*UsageAggregation
	var totalCost float64
	for rows.Next() {
		var agg UsageAggregation
		if err := rows.Scan(&agg.EventType, &agg.TotalQuantity, &agg.TotalCostUSD); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		totalCost += agg.TotalCostUSD
		aggregations = append(aggregations, &agg)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	return &GetUsageResponse{
		Aggregations: aggregations,
		TotalCostUSD: totalCost,
	}, nil
}

// SetBudget creates or updates a budget for a tenant.
func (s *BillingService) SetBudget(ctx context.Context, req *SetBudgetRequest) (*SetBudgetResponse, error) {
	ctx, span := tracer.Start(ctx, "BillingService.SetBudget")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.Float64("monthly_limit_usd", req.MonthlyLimitUSD),
	)

	if req.MonthlyLimitUSD <= 0 {
		return nil, status.Error(codes.InvalidArgument, "monthly_limit_usd must be positive")
	}

	alertPct := req.AlertThresholdPct
	if alertPct <= 0 || alertPct > 100 {
		alertPct = 80
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO budgets (tenant_id, monthly_limit_usd, alert_threshold_pct, hard_limit, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (tenant_id)
		DO UPDATE SET monthly_limit_usd = $2, alert_threshold_pct = $3, hard_limit = $4, updated_at = now()
	`, tenantID, req.MonthlyLimitUSD, alertPct, req.HardLimit)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to upsert budget: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("budget set",
		zap.String("tenant_id", tenantID),
		zap.Float64("monthly_limit_usd", req.MonthlyLimitUSD),
		zap.Bool("hard_limit", req.HardLimit),
	)

	return &SetBudgetResponse{Success: true}, nil
}

// validateUsageEvent validates a single usage event.
func validateUsageEvent(e *UsageEvent) error {
	if e.EventType == "" {
		return fmt.Errorf("event_type is required")
	}
	validTypes := map[string]bool{
		"llm_tokens":      true,
		"compute_seconds": true,
		"storage_bytes":   true,
		"sandbox_hours":   true,
		"connector_calls": true,
	}
	if !validTypes[e.EventType] {
		return fmt.Errorf("invalid event_type: %s", e.EventType)
	}
	if e.Quantity <= 0 {
		return fmt.Errorf("quantity must be positive")
	}
	if e.Unit == "" {
		return fmt.Errorf("unit is required")
	}
	if e.CostUSD < 0 {
		return fmt.Errorf("cost_usd cannot be negative")
	}
	return nil
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
