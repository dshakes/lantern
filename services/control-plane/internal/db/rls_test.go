package db_test

// TestRLSEnforcement_CrossTenant is a live-DB integration test that proves
// Row-Level Security actually denies cross-tenant reads on the 'agents' table.
//
// It exercises the 'lantern_app' non-owner role, which lacks BYPASSRLS and
// is therefore subject to the tenant_isolation_agents policy:
//
//	USING (tenant_id::text = current_setting('app.tenant_id', true))
//
// Test strategy
// -------------
//  1. Run Migrate() as the superuser pool to ensure the schema + role exist.
//  2. Open a *second* pool that connects as 'lantern_app' (SET ROLE inside
//     a transaction mimics that without needing a second DSN).
//  3. As tenant A (with GUC set), INSERT an agent and verify SELECT sees it.
//  4. Switch GUC to tenant B: the tenant-A row must NOT be visible.
//  5. Switch GUC back to tenant A: the row is visible again (proves it is
//     the policy, not a missing row).
//
// Skipped when DATABASE_URL is unset (same pattern as runtime_test.go).

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
)

// openSuperPool opens a pool using DATABASE_URL (the superuser / migration
// connection). Skips the test if DATABASE_URL is unset or the DB is
// unreachable.
func openSuperPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping DB test in -short mode")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set — skipping RLS integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("pgxpool.New: %v — skipping (DB unreachable?)", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("pool.Ping: %v — skipping (DB unreachable?)", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedRLSTenant inserts a minimal tenant row so FK constraints are satisfied.
// Cleaned up in t.Cleanup.
func seedRLSTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	slug := fmt.Sprintf("rls-test-%s", tenantID[:8])
	ns := "ns-rls-" + tenantID[:8]
	_, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'RLS Test Tenant', 'personal', $3)
		ON CONFLICT (id) DO NOTHING
	`, tenantID, slug, ns)
	if err != nil {
		t.Fatalf("seedRLSTenant %s: %v", tenantID, err)
	}
	t.Cleanup(func() {
		// Delete the test agent first (FK child), then the tenant.
		_, _ = pool.Exec(context.Background(),
			"DELETE FROM agents WHERE tenant_id = $1::uuid", tenantID)
		_, _ = pool.Exec(context.Background(),
			"DELETE FROM tenants WHERE id = $1::uuid", tenantID)
	})
}

// TestRLSEnforcement_CrossTenant is the proof that RLS denies cross-tenant
// reads when the connection operates as the non-owner 'lantern_app' role.
func TestRLSEnforcement_CrossTenant(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	// Ensure schema + lantern_app role exist.
	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	seedRLSTenant(t, superPool, tenantA)
	seedRLSTenant(t, superPool, tenantB)

	agentName := "rls-proof-agent-" + tenantA[:8]

	// -------------------------------------------------------------------------
	// Step 1 – Insert the agent as tenant A (using a transaction with the GUC
	// set) operating as lantern_app (the non-owner, non-superuser role).
	// We use SET LOCAL ROLE inside the transaction so we don't need a separate
	// DSN for the test — the effect is identical to the pool connecting as
	// lantern_app from the start.
	// -------------------------------------------------------------------------
	func() {
		tx, err := superPool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin tx for insert: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		// Drop to the app role for this transaction.
		if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
			t.Fatalf("SET LOCAL ROLE lantern_app: %v — is the role created? run Migrate first", err)
		}
		// Set the tenant GUC (transaction-local).
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantA); err != nil {
			t.Fatalf("set_config tenant A: %v", err)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO agents (tenant_id, name, description, labels)
			VALUES ($1::uuid, $2, 'RLS proof row', '{}')
			ON CONFLICT (tenant_id, name) DO NOTHING
		`, tenantA, agentName)
		if err != nil {
			t.Fatalf("insert agent as tenant A: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit insert: %v", err)
		}
	}()

	// -------------------------------------------------------------------------
	// Step 2 – Within-tenant read: tenant A must see its own row.
	// -------------------------------------------------------------------------
	t.Run("WithinTenantA_CanRead", func(t *testing.T) {
		count := queryAgentCount(t, superPool, ctx, tenantA, agentName)
		if count != 1 {
			t.Errorf("tenant A: expected 1 visible row for its own agent, got %d", count)
		}
	})

	// -------------------------------------------------------------------------
	// Step 3 – Cross-tenant read: tenant B must NOT see tenant A's row.
	// This is the critical RLS enforcement proof.
	// -------------------------------------------------------------------------
	t.Run("CrossTenant_DeniedByRLS", func(t *testing.T) {
		count := queryAgentCount(t, superPool, ctx, tenantB, agentName)
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: tenant B can see %d row(s) that belong to tenant A — RLS not enforced", count)
		}
	})

	// -------------------------------------------------------------------------
	// Step 4 – Verify the row still exists (sanity: policy, not deletion).
	// -------------------------------------------------------------------------
	t.Run("WithinTenantA_StillVisible", func(t *testing.T) {
		count := queryAgentCount(t, superPool, ctx, tenantA, agentName)
		if count != 1 {
			t.Errorf("tenant A: row disappeared — expected 1, got %d", count)
		}
	})

	// -------------------------------------------------------------------------
	// Step 5 – No GUC set at all: empty string matches no tenant_id.
	// -------------------------------------------------------------------------
	t.Run("NoGUC_SeesNothing", func(t *testing.T) {
		var count int
		err := runAsAppRole(superPool, ctx, func(tx pgx.Tx) error {
			// Explicitly set GUC to empty (simulates a forgotten set_config call).
			if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', '', true)"); err != nil {
				return fmt.Errorf("set_config empty: %w", err)
			}
			return tx.QueryRow(ctx,
				"SELECT COUNT(*) FROM agents WHERE name = $1", agentName,
			).Scan(&count)
		})
		if err != nil {
			t.Fatalf("no-GUC query: %v", err)
		}
		if count != 0 {
			t.Errorf("no GUC: expected 0 visible rows, got %d — RLS not enforced", count)
		}
	})
}

// queryAgentCount opens a transaction as lantern_app, sets the tenant GUC,
// and returns how many agents with the given name are visible.
func queryAgentCount(t *testing.T, pool *pgxpool.Pool, ctx context.Context, tenantID, agentName string) int {
	t.Helper()
	var count int
	err := runAsAppRole(pool, ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
			return fmt.Errorf("set_config: %w", err)
		}
		return tx.QueryRow(ctx,
			"SELECT COUNT(*) FROM agents WHERE name = $1", agentName,
		).Scan(&count)
	})
	if err != nil {
		t.Fatalf("queryAgentCount(tenant=%s): %v", tenantID, err)
	}
	return count
}

// runAsAppRole opens a transaction, drops to 'lantern_app' via SET LOCAL ROLE
// (so RLS is enforced as if the pool were connected as that role), runs f,
// and commits. It rolls back on any error from f.
func runAsAppRole(pool *pgxpool.Pool, ctx context.Context, f func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
		return fmt.Errorf("SET LOCAL ROLE lantern_app: %w", err)
	}
	if err := f(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
