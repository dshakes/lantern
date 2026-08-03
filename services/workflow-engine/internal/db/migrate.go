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

	// Grant the RLS role access to the tables THIS service creates.
	//
	// The control-plane's baseline migration creates lantern_app and grants it
	// on the tables it owns — but step_state, journal_events and run_locks are
	// created here, so nothing ever granted them. Under LANTERN_RLS_ENFORCE=1
	// tenant-scoped transactions run as lantern_app and write all three in the
	// SAME transaction as the run update, so without this the engine fails on
	// ordinary work with permission errors the moment enforcement is switched
	// on. The service that creates a table is the one that should grant it.
	//
	// Guarded on the role existing: dev and test databases have no lantern_app,
	// and a bare GRANT to a missing role aborts the migration.
	`DO $$
	BEGIN
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lantern_app') THEN
			GRANT USAGE ON SCHEMA public TO lantern_app;
			GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE step_state TO lantern_app;
			GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE journal_events TO lantern_app;
			GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE run_locks TO lantern_app;
		END IF;
	END
	$$;`,

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
