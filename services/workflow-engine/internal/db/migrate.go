package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate runs the CREATE TABLE statements needed by the workflow engine.
// This is a spike-only approach: in production, use a proper migration tool
// (e.g., golang-migrate or Atlas). All statements are idempotent.
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
	// Journal events — the source of truth for all run execution.
	// Partitioned by run_id hash in production; flat table for the spike.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS journal_events (
		run_id     UUID NOT NULL,
		seq        BIGINT NOT NULL,
		kind       TEXT NOT NULL,
		step_id    TEXT,
		attempt    INT NOT NULL DEFAULT 1,
		payload    BYTEA NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (run_id, seq)
	)`,

	`CREATE INDEX IF NOT EXISTS journal_events_run_kind_idx
		ON journal_events (run_id, kind, seq)`,

	// ---------------------------------------------------------------
	// Step state — denormalized view of step execution for fast lookups.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS step_state (
		step_id    TEXT NOT NULL,
		run_id     UUID NOT NULL,
		status     TEXT NOT NULL,
		result     BYTEA,
		attempt    INT NOT NULL DEFAULT 1,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (run_id, step_id)
	)`,

	`CREATE INDEX IF NOT EXISTS step_state_status_idx
		ON step_state (run_id, status)`,

	// ---------------------------------------------------------------
	// Run locks — prevents two workers from executing the same run.
	// Advisory locks are the primary mechanism; this table provides
	// visibility and expiry-based recovery.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS run_locks (
		run_id      UUID PRIMARY KEY,
		worker_id   TEXT NOT NULL,
		acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		expires_at  TIMESTAMPTZ NOT NULL
	)`,
}
