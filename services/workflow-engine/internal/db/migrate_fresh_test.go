package db

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestMigrateOnFreshDatabase runs the real migration set against an EMPTY
// database, which is the only place ordering bugs are visible.
//
// This exists because of one that shipped: a GRANT block was placed beside the
// table it was written for, ahead of another table it also referenced.
// Migrations run in slice order, so on a fresh database it aborted with
// `relation "run_locks" does not exist` — the service would not start at all.
//
// It passed a hand-check against the dev database because that database already
// had every table. A migration verified only against a database that has
// already been migrated is not verified: every CREATE TABLE IF NOT EXISTS is a
// no-op and ordering cannot fail. Hence a database created empty, here, on
// every run.
//
// Skips when DATABASE_URL is unset (plain unit runs); otherwise creates and
// drops its own scratch database, so it needs no fixture.
func TestMigrateOnFreshDatabase(t *testing.T) {
	admin := os.Getenv("DATABASE_URL")
	if admin == "" {
		t.Skip("DATABASE_URL unset — skipping fresh-database migration test")
	}
	ctx := context.Background()

	adminPool, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Skipf("cannot reach DATABASE_URL: %v", err)
	}
	defer adminPool.Close()

	const scratch = "wf_migrate_fresh_test"
	if _, err := adminPool.Exec(ctx, "DROP DATABASE IF EXISTS "+scratch); err != nil {
		t.Skipf("cannot drop scratch database (insufficient privileges?): %v", err)
	}
	if _, err := adminPool.Exec(ctx, "CREATE DATABASE "+scratch); err != nil {
		t.Skipf("cannot create scratch database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), "DROP DATABASE IF EXISTS "+scratch)
	})

	freshPool, err := pgxpool.New(ctx, swapDatabase(admin, scratch))
	if err != nil {
		t.Fatalf("connect to the fresh database: %v", err)
	}
	defer freshPool.Close()

	if err := Migrate(ctx, freshPool); err != nil {
		t.Fatalf("Migrate failed on a FRESH database (ordering bug?): %v", err)
	}
	// Re-running must also succeed; migrations are applied on every boot.
	if err := Migrate(ctx, freshPool); err != nil {
		t.Fatalf("Migrate is not idempotent: %v", err)
	}
}

// swapDatabase rewrites the database name in a postgres DSN.
func swapDatabase(dsn, name string) string {
	if i := strings.LastIndex(dsn, "/"); i >= 0 {
		rest := ""
		if q := strings.Index(dsn[i:], "?"); q >= 0 {
			rest = dsn[i+q:]
		}
		return fmt.Sprintf("%s/%s%s", dsn[:i], name, rest)
	}
	return dsn
}
