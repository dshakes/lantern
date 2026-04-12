package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate runs the core CREATE TABLE statements needed by the billing service.
// All statements are idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	for i, stmt := range migrations {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("migration %d failed: %w", i, err)
		}
	}
	return nil
}

var migrations = []string{
	// ---------------------------------------------------------------
	// Usage events — raw metering events
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS usage_events (
		id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id   UUID NOT NULL,
		run_id      UUID,
		event_type  TEXT NOT NULL,
		quantity    NUMERIC(20,6) NOT NULL,
		unit        TEXT NOT NULL,
		model_used  TEXT,
		cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
		idempotency_key TEXT,
		created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS usage_events_tenant_type_created_idx
		ON usage_events (tenant_id, event_type, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS usage_events_tenant_created_idx
		ON usage_events (tenant_id, created_at DESC)`,

	`CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_idx
		ON usage_events (idempotency_key) WHERE idempotency_key IS NOT NULL`,

	// ---------------------------------------------------------------
	// Aggregations — materialized usage summaries by period
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS aggregations (
		tenant_id      UUID NOT NULL,
		period_start   TIMESTAMPTZ NOT NULL,
		period_end     TIMESTAMPTZ NOT NULL,
		event_type     TEXT NOT NULL,
		total_quantity NUMERIC(20,6) NOT NULL DEFAULT 0,
		total_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
		updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (tenant_id, period_start, event_type)
	)`,

	// ---------------------------------------------------------------
	// Budgets — per-tenant spending limits
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS budgets (
		tenant_id          UUID PRIMARY KEY,
		monthly_limit_usd  NUMERIC(12,2) NOT NULL,
		alert_threshold_pct INT NOT NULL DEFAULT 80,
		hard_limit         BOOLEAN NOT NULL DEFAULT false,
		created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// ---------------------------------------------------------------
	// Invoices
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS invoices (
		id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id    UUID NOT NULL,
		period_start TIMESTAMPTZ NOT NULL,
		period_end   TIMESTAMPTZ NOT NULL,
		total_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
		status       TEXT NOT NULL DEFAULT 'draft',
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS invoices_tenant_period_idx
		ON invoices (tenant_id, period_start DESC)`,

	// ---------------------------------------------------------------
	// Row-Level Security policies
	// ---------------------------------------------------------------
	`ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'usage_events' AND policyname = 'tenant_isolation_usage_events'
		) THEN
			CREATE POLICY tenant_isolation_usage_events ON usage_events
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE aggregations ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'aggregations' AND policyname = 'tenant_isolation_aggregations'
		) THEN
			CREATE POLICY tenant_isolation_aggregations ON aggregations
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE budgets ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'budgets' AND policyname = 'tenant_isolation_budgets'
		) THEN
			CREATE POLICY tenant_isolation_budgets ON budgets
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE invoices ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'invoices' AND policyname = 'tenant_isolation_invoices'
		) THEN
			CREATE POLICY tenant_isolation_invoices ON invoices
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,
}
