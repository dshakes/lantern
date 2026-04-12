package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate runs the core CREATE TABLE statements needed by the notifier service.
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
	// Notifications
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS notifications (
		id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id   UUID NOT NULL,
		run_id      UUID,
		channel     TEXT NOT NULL,
		recipient   TEXT NOT NULL,
		subject     TEXT,
		body        TEXT NOT NULL,
		template_id TEXT,
		status      TEXT NOT NULL DEFAULT 'pending',
		idempotency_key TEXT UNIQUE,
		created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS notifications_tenant_status_idx
		ON notifications (tenant_id, status, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS notifications_run_idx
		ON notifications (run_id) WHERE run_id IS NOT NULL`,

	// ---------------------------------------------------------------
	// Delivery attempts
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS delivery_attempts (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
		channel         TEXT NOT NULL,
		status          TEXT NOT NULL,
		error           TEXT,
		response_code   INT,
		attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS delivery_attempts_notification_idx
		ON delivery_attempts (notification_id, attempted_at DESC)`,

	// ---------------------------------------------------------------
	// Subscriptions
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS subscriptions (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL,
		event_type TEXT NOT NULL,
		channel    TEXT NOT NULL,
		config     JSONB NOT NULL DEFAULT '{}'::jsonb,
		enabled    BOOLEAN NOT NULL DEFAULT true,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, event_type, channel)
	)`,

	`CREATE INDEX IF NOT EXISTS subscriptions_tenant_event_idx
		ON subscriptions (tenant_id, event_type) WHERE enabled = true`,

	// ---------------------------------------------------------------
	// Row-Level Security policies
	// ---------------------------------------------------------------
	`ALTER TABLE notifications ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'notifications' AND policyname = 'tenant_isolation_notifications'
		) THEN
			CREATE POLICY tenant_isolation_notifications ON notifications
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'subscriptions' AND policyname = 'tenant_isolation_subscriptions'
		) THEN
			CREATE POLICY tenant_isolation_subscriptions ON subscriptions
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,
}
