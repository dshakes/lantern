package db

// WithTenantConn is the canonical "tenant-scoped read/write" primitive for the
// RLS app pool. It:
//  1. Acquires a connection from pool.
//  2. Begins a transaction.
//  3. Sets the app.tenant_id GUC (transaction-local) to tenantID.
//  4. Runs fn inside that transaction.
//  5. Commits on success; rolls back on any fn error.
//
// When pool is the AppPool (lantern_app role, non-superuser), Postgres enforces
// the tenant_isolation_{agents,runs} RLS policies automatically. When pool is
// the privileged Pool (lantern superuser, the default with no env vars set),
// the RLS policies are technically bypassed at the DB level — but the GUC is
// still set, which provides application-level tenant scoping consistent with
// the existing setRLSTenantID helper used by gRPC handlers.
//
// The fn receives the transaction; callers must NOT commit or roll back the
// transaction themselves.
//
// Usage:
//
//	err := db.WithTenantConn(ctx, srv.AppPool, tenantID, func(tx pgx.Tx) error {
//	    return tx.QueryRow(ctx, "SELECT ... FROM runs WHERE ...", ...).Scan(...)
//	})

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WithTenantConn begins a transaction on pool, sets the app.tenant_id GUC to
// tenantID (transaction-local), and calls fn. Returns fn's error on failure.
func WithTenantConn(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("db.WithTenantConn: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return fmt.Errorf("db.WithTenantConn: set_config: %w", err)
	}

	if err := fn(tx); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("db.WithTenantConn: commit: %w", err)
	}
	return nil
}
