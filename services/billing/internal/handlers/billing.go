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

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/billing/internal/middleware"
	"github.com/dshakes/lantern/services/billing/internal/server"
)

var tracer = otel.Tracer("lantern.billing")

// BillingService implements the lantern.v1.BillingService gRPC server. Wire
// types come from gen/go (the proto is the source of truth, invariant #6);
// tenant is read from gRPC metadata (invariant #7), never the request body.
type BillingService struct {
	lanternv1.UnimplementedBillingServiceServer

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
func (s *BillingService) EmitUsage(ctx context.Context, req *lanternv1.EmitUsageRequest) (*lanternv1.EmitUsageResponse, error) {
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

		runID := nilIfEmpty(event.RunId)
		if runID == nil && req.RunId != "" {
			runID = &req.RunId
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO usage_events (tenant_id, run_id, event_type, quantity, unit, model_used, cost_usd, idempotency_key)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		`, tenantID, runID, event.EventType, event.Quantity, event.Unit,
			nilIfEmpty(event.ModelUsed), event.CostUsd, nilIfEmpty(event.IdempotencyKey))
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

	return &lanternv1.EmitUsageResponse{
		Accepted: accepted,
		Rejected: rejected,
	}, nil
}

// CheckBudget returns the current budget status for a tenant.
func (s *BillingService) CheckBudget(ctx context.Context, _ *lanternv1.CheckBudgetRequest) (*lanternv1.BudgetStatus, error) {
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
			return &lanternv1.BudgetStatus{}, nil
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

	bs := &lanternv1.BudgetStatus{
		MonthlyLimitUsd:   monthlyLimitUSD,
		CurrentSpendUsd:   totalSpend,
		RemainingUsd:      remaining,
		UsagePercentage:   usagePct,
		HardLimit:         hardLimit,
		HardLimitReached:  hardLimit && totalSpend >= monthlyLimitUSD,
		AlertThresholdPct: alertThresholdPct,
		AlertThresholdHit: usagePct >= float64(alertThresholdPct),
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
func (s *BillingService) GetUsage(ctx context.Context, req *lanternv1.GetUsageRequest) (*lanternv1.GetUsageResponse, error) {
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

	if req.From == nil || req.To == nil {
		return nil, status.Error(codes.InvalidArgument, "from and to timestamps are required")
	}
	from := req.From.AsTime()
	to := req.To.AsTime()

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

	rows, err := tx.Query(ctx, query, tenantID, from, to)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}
	defer rows.Close()

	var aggregations []*lanternv1.UsageAggregation
	var totalCost float64
	for rows.Next() {
		var agg lanternv1.UsageAggregation
		if err := rows.Scan(&agg.EventType, &agg.TotalQuantity, &agg.TotalCostUsd); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		totalCost += agg.TotalCostUsd
		aggregations = append(aggregations, &agg)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	return &lanternv1.GetUsageResponse{
		Aggregations: aggregations,
		TotalCostUsd: totalCost,
	}, nil
}

// SetBudget creates or updates a budget for a tenant.
func (s *BillingService) SetBudget(ctx context.Context, req *lanternv1.SetBudgetRequest) (*lanternv1.SetBudgetResponse, error) {
	ctx, span := tracer.Start(ctx, "BillingService.SetBudget")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.Float64("monthly_limit_usd", req.MonthlyLimitUsd),
	)

	if req.MonthlyLimitUsd <= 0 {
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
	`, tenantID, req.MonthlyLimitUsd, alertPct, req.HardLimit)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to upsert budget: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("budget set",
		zap.String("tenant_id", tenantID),
		zap.Float64("monthly_limit_usd", req.MonthlyLimitUsd),
		zap.Bool("hard_limit", req.HardLimit),
	)

	return &lanternv1.SetBudgetResponse{Success: true}, nil
}

// validateUsageEvent validates a single usage event.
func validateUsageEvent(e *lanternv1.UsageEvent) error {
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
	if e.CostUsd < 0 {
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
