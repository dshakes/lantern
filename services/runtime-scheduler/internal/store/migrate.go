// Package store provides optional Postgres persistence for the scheduler's
// cluster state. When DATABASE_URL is set the scheduler runs in write-through
// mode: every mutation lands in memory first (keeping the hot-placement path
// off the DB), then is persisted asynchronously. On startup, state is loaded
// from the DB back into the InMemoryStore.
//
// Tables are prefixed `sched_` to avoid collisions with control-plane tables
// when both services share a dev Postgres instance.
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

var migrations = []string{
	// ------------------------------------------------------------------
	// sched_nodes — one row per registered runtime-manager node.
	// Upserted on every heartbeat; address is the gRPC dial target.
	// ------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS sched_nodes (
		name               TEXT        PRIMARY KEY,
		address            TEXT        NOT NULL DEFAULT '',
		region             TEXT        NOT NULL DEFAULT '',
		continent          TEXT        NOT NULL DEFAULT '',
		availability_zone  TEXT        NOT NULL DEFAULT '',
		is_spot            BOOLEAN     NOT NULL DEFAULT FALSE,
		is_arm             BOOLEAN     NOT NULL DEFAULT FALSE,
		free_vcpu_millis   BIGINT      NOT NULL DEFAULT 0,
		free_memory_bytes  BIGINT      NOT NULL DEFAULT 0,
		warm_pool_exact    JSONB       NOT NULL DEFAULT '{}'::jsonb,
		warm_pool_image_only JSONB     NOT NULL DEFAULT '{}'::jsonb,
		draining           BOOLEAN     NOT NULL DEFAULT FALSE,
		recent_oom_count   INT         NOT NULL DEFAULT 0,
		recent_kernel_events INT       NOT NULL DEFAULT 0,
		last_heartbeat     TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// ------------------------------------------------------------------
	// sched_vms — one row per scheduled VM. Enough to rebuild in-memory
	// state: id, tenant, owning node, state, original spec, timestamps.
	// ------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS sched_vms (
		vm_id              TEXT        PRIMARY KEY,
		tenant_id          TEXT        NOT NULL,
		node_name          TEXT        NOT NULL DEFAULT '',
		state              INT         NOT NULL DEFAULT 0,
		reason             TEXT        NOT NULL DEFAULT '',
		spec               JSONB       NOT NULL DEFAULT '{}'::jsonb,
		availability_zone  TEXT        NOT NULL DEFAULT '',
		created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_event_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_heartbeat_at  TIMESTAMPTZ,
		updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// ------------------------------------------------------------------
	// sched_snapshots — snapshot metadata persisted after a Snapshot RPC.
	// manager_snapshot_id is the id returned by the runtime-manager
	// (may be a stub); sha256/bytes come from SnapshotResponse.
	// ------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS sched_snapshots (
		snapshot_id        TEXT        PRIMARY KEY,
		vm_id              TEXT        NOT NULL,
		tenant_id          TEXT        NOT NULL,
		node_name          TEXT        NOT NULL DEFAULT '',
		keep_running       BOOLEAN     NOT NULL DEFAULT FALSE,
		manager_snapshot_id TEXT       NOT NULL DEFAULT '',
		sha256             TEXT        NOT NULL DEFAULT '',
		bytes              BIGINT      NOT NULL DEFAULT 0,
		created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
}

// Migrate runs all CREATE TABLE IF NOT EXISTS statements for the scheduler
// schema. Safe to call on every boot; all statements are idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	for i, stmt := range migrations {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("sched migration %d: %w", i, err)
		}
	}
	return nil
}
