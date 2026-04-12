package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate runs the core CREATE TABLE statements needed by the scheduler service.
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
	// Schedules — cron-based triggers
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS schedules (
		id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id      UUID NOT NULL,
		agent_name     TEXT NOT NULL,
		cron_expr      TEXT NOT NULL,
		timezone       TEXT NOT NULL DEFAULT 'UTC',
		input_template JSONB NOT NULL DEFAULT '{}'::jsonb,
		enabled        BOOLEAN NOT NULL DEFAULT true,
		next_fire_at   TIMESTAMPTZ,
		last_fire_at   TIMESTAMPTZ,
		created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, agent_name, cron_expr)
	)`,

	`CREATE INDEX IF NOT EXISTS schedules_next_fire_idx
		ON schedules (next_fire_at) WHERE enabled = true`,

	`CREATE INDEX IF NOT EXISTS schedules_tenant_idx
		ON schedules (tenant_id)`,

	// ---------------------------------------------------------------
	// Trigger state — for event-driven and polling triggers
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS trigger_state (
		id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id    UUID NOT NULL,
		agent_name   TEXT NOT NULL,
		trigger_type TEXT NOT NULL,
		config       JSONB NOT NULL DEFAULT '{}'::jsonb,
		last_cursor  TEXT,
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS trigger_state_tenant_idx
		ON trigger_state (tenant_id, agent_name)`,

	// ---------------------------------------------------------------
	// Delayed runs — one-shot future triggers
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS delayed_runs (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL,
		agent_name TEXT NOT NULL,
		input      JSONB NOT NULL DEFAULT '{}'::jsonb,
		fire_at    TIMESTAMPTZ NOT NULL,
		status     TEXT NOT NULL DEFAULT 'pending',
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS delayed_runs_fire_idx
		ON delayed_runs (fire_at) WHERE status = 'pending'`,

	`CREATE INDEX IF NOT EXISTS delayed_runs_tenant_idx
		ON delayed_runs (tenant_id)`,

	// ---------------------------------------------------------------
	// Dead letter — failed trigger attempts
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS dead_letter (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL,
		agent_name TEXT NOT NULL,
		input      JSONB NOT NULL DEFAULT '{}'::jsonb,
		error      TEXT NOT NULL,
		attempts   INT NOT NULL DEFAULT 1,
		schedule_id UUID,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS dead_letter_tenant_idx
		ON dead_letter (tenant_id, created_at DESC)`,

	// ---------------------------------------------------------------
	// Row-Level Security policies
	// ---------------------------------------------------------------
	`ALTER TABLE schedules ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'schedules' AND policyname = 'tenant_isolation_schedules'
		) THEN
			CREATE POLICY tenant_isolation_schedules ON schedules
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE trigger_state ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'trigger_state' AND policyname = 'tenant_isolation_trigger_state'
		) THEN
			CREATE POLICY tenant_isolation_trigger_state ON trigger_state
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE delayed_runs ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'delayed_runs' AND policyname = 'tenant_isolation_delayed_runs'
		) THEN
			CREATE POLICY tenant_isolation_delayed_runs ON delayed_runs
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE dead_letter ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'dead_letter' AND policyname = 'tenant_isolation_dead_letter'
		) THEN
			CREATE POLICY tenant_isolation_dead_letter ON dead_letter
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,
}
