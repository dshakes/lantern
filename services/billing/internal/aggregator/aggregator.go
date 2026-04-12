package aggregator

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.uber.org/zap"
)

var tracer = otel.Tracer("lantern.billing.aggregator")

// NotifyFunc is called when a budget threshold is crossed.
// In production, this calls the notifier service.
type NotifyFunc func(ctx context.Context, tenantID string, usagePct float64, hardLimitReached bool)

// Aggregator runs a background loop that materializes usage_events into
// the aggregations table and checks budget thresholds.
type Aggregator struct {
	pool     *pgxpool.Pool
	logger   *zap.Logger
	interval time.Duration
	notify   NotifyFunc
}

// New creates a new Aggregator.
func New(pool *pgxpool.Pool, logger *zap.Logger, notify NotifyFunc) *Aggregator {
	return &Aggregator{
		pool:     pool,
		logger:   logger.Named("aggregator"),
		interval: 30 * time.Second,
		notify:   notify,
	}
}

// Run starts the aggregation loop. It blocks until the context is cancelled.
func (a *Aggregator) Run(ctx context.Context) {
	a.logger.Info("aggregator started", zap.Duration("interval", a.interval))

	ticker := time.NewTicker(a.interval)
	defer ticker.Stop()

	// Run once immediately on startup.
	a.runOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			a.logger.Info("aggregator stopped")
			return
		case <-ticker.C:
			a.runOnce(ctx)
		}
	}
}

func (a *Aggregator) runOnce(ctx context.Context) {
	ctx, span := tracer.Start(ctx, "Aggregator.runOnce")
	defer span.End()

	if err := a.aggregate(ctx); err != nil {
		a.logger.Error("aggregation failed", zap.Error(err))
	}

	if err := a.checkBudgets(ctx); err != nil {
		a.logger.Error("budget check failed", zap.Error(err))
	}
}

// aggregate materializes recent usage_events into the aggregations table.
// Uses INSERT ... ON CONFLICT DO UPDATE for atomic upserts.
func (a *Aggregator) aggregate(ctx context.Context) error {
	now := time.Now().UTC()
	periodStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	periodEnd := periodStart.AddDate(0, 1, 0)

	// Aggregate usage events by tenant and event_type for the current period.
	// This is idempotent: re-running produces the same result.
	_, err := a.pool.Exec(ctx, `
		INSERT INTO aggregations (tenant_id, period_start, period_end, event_type, total_quantity, total_cost_usd, updated_at)
		SELECT
			tenant_id,
			$1::timestamptz AS period_start,
			$2::timestamptz AS period_end,
			event_type,
			SUM(quantity) AS total_quantity,
			SUM(cost_usd) AS total_cost_usd,
			now() AS updated_at
		FROM usage_events
		WHERE created_at >= $1 AND created_at < $2
		GROUP BY tenant_id, event_type
		ON CONFLICT (tenant_id, period_start, event_type)
		DO UPDATE SET
			total_quantity = EXCLUDED.total_quantity,
			total_cost_usd = EXCLUDED.total_cost_usd,
			updated_at = now()
	`, periodStart, periodEnd)
	if err != nil {
		return fmt.Errorf("aggregation query failed: %w", err)
	}

	a.logger.Debug("aggregation completed",
		zap.Time("period_start", periodStart),
		zap.Time("period_end", periodEnd),
	)

	return nil
}

// checkBudgets queries all tenants with budgets and checks if any thresholds
// have been crossed, emitting alerts via the notify function.
func (a *Aggregator) checkBudgets(ctx context.Context) error {
	now := time.Now().UTC()
	periodStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

	rows, err := a.pool.Query(ctx, `
		SELECT
			b.tenant_id,
			b.monthly_limit_usd,
			b.alert_threshold_pct,
			b.hard_limit,
			COALESCE(SUM(ag.total_cost_usd), 0) AS current_spend
		FROM budgets b
		LEFT JOIN aggregations ag
			ON ag.tenant_id = b.tenant_id
			AND ag.period_start = $1
		GROUP BY b.tenant_id, b.monthly_limit_usd, b.alert_threshold_pct, b.hard_limit
	`, periodStart)
	if err != nil {
		return fmt.Errorf("budget check query failed: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			tenantID          string
			monthlyLimit      float64
			alertThresholdPct int
			hardLimit         bool
			currentSpend      float64
		)
		if err := rows.Scan(&tenantID, &monthlyLimit, &alertThresholdPct, &hardLimit, &currentSpend); err != nil {
			a.logger.Error("scan budget row failed", zap.Error(err))
			continue
		}

		if monthlyLimit <= 0 {
			continue
		}

		usagePct := (currentSpend / monthlyLimit) * 100
		hardLimitReached := hardLimit && currentSpend >= monthlyLimit

		// Check if alert threshold is crossed.
		if usagePct >= float64(alertThresholdPct) {
			a.logger.Warn("budget threshold crossed",
				zap.String("tenant_id", tenantID),
				zap.Float64("usage_pct", usagePct),
				zap.Int("threshold_pct", alertThresholdPct),
				zap.Bool("hard_limit_reached", hardLimitReached),
			)

			if a.notify != nil {
				a.notify(ctx, tenantID, usagePct, hardLimitReached)
			}
		}
	}

	return rows.Err()
}
