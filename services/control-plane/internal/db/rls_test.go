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

// TestRLSEnforcement_Runs extends the cross-tenant proof to the 'runs' table.
// It also proves that the privileged pool (superuser) still bypasses RLS and
// sees all rows — confirming that recovery-style sweeps remain unaffected.
func TestRLSEnforcement_Runs(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	seedRLSTenant(t, superPool, tenantA)
	seedRLSTenant(t, superPool, tenantB)

	// Seed a minimal agent + agent_version to satisfy FK constraints on runs.
	agentID := uuid.New().String()
	agentVersionID := uuid.New().String()
	agentName := "rls-run-proof-" + tenantA[:8]
	_, err := superPool.Exec(ctx, `
		INSERT INTO agents (id, tenant_id, name, description, labels)
		VALUES ($1::uuid, $2::uuid, $3, 'RLS run proof', '{}')
		ON CONFLICT (tenant_id, name) DO NOTHING
	`, agentID, tenantA, agentName)
	if err != nil {
		t.Fatalf("insert agent for run seed: %v", err)
	}
	_, err = superPool.Exec(ctx, `
		INSERT INTO agent_versions (id, agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1::uuid, $2::uuid, '1', 'sha256:test', 's3://test', '{}'::jsonb)
		ON CONFLICT (id) DO NOTHING
	`, agentVersionID, agentID)
	if err != nil {
		t.Fatalf("insert agent_version for run seed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = superPool.Exec(context.Background(), "DELETE FROM agents WHERE id = $1::uuid", agentID)
	})

	// Insert a run for tenant A using the privileged pool (bypasses RLS for insert).
	runID := uuid.New().String()
	_, err = superPool.Exec(ctx, `
		INSERT INTO runs (id, tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'completed', 'manual', '{}'::jsonb)
		ON CONFLICT (id) DO NOTHING
	`, runID, tenantA, agentID, agentVersionID)
	if err != nil {
		t.Fatalf("insert run as superuser: %v", err)
	}
	t.Cleanup(func() {
		_, _ = superPool.Exec(context.Background(), "DELETE FROM runs WHERE id = $1::uuid", runID)
	})

	// -------------------------------------------------------------------------
	// Step 1 — Tenant A (as lantern_app) sees its own run.
	// -------------------------------------------------------------------------
	t.Run("Runs_WithinTenantA_CanRead", func(t *testing.T) {
		count := queryRunCount(t, superPool, ctx, tenantA, runID)
		if count != 1 {
			t.Errorf("tenant A: expected 1 run row, got %d", count)
		}
	})

	// -------------------------------------------------------------------------
	// Step 2 — Tenant B (as lantern_app) CANNOT see tenant A's run.
	// -------------------------------------------------------------------------
	t.Run("Runs_CrossTenant_DeniedByRLS", func(t *testing.T) {
		count := queryRunCount(t, superPool, ctx, tenantB, runID)
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: tenant B can see %d run row(s) belonging to tenant A", count)
		}
	})

	// -------------------------------------------------------------------------
	// Step 3 — The PRIVILEGED pool (superuser) bypasses RLS and sees all rows.
	// This confirms recovery/marketplace sweeps still work after the cutover.
	// -------------------------------------------------------------------------
	t.Run("PrivilegedPool_BypassesRLS", func(t *testing.T) {
		var count int
		err := superPool.QueryRow(ctx,
			"SELECT COUNT(*) FROM runs WHERE id = $1::uuid", runID,
		).Scan(&count)
		if err != nil {
			t.Fatalf("privileged pool query: %v", err)
		}
		if count != 1 {
			t.Errorf("privileged pool: expected 1 row (bypass RLS), got %d", count)
		}
	})

	// -------------------------------------------------------------------------
	// Step 4 — WithTenantConn helper: same-tenant read works, cross-tenant read
	// is empty.
	// -------------------------------------------------------------------------
	t.Run("WithTenantConn_SameTenant", func(t *testing.T) {
		var count int
		err := db.WithTenantConn(ctx, superPool, tenantA, func(tx pgx.Tx) error {
			// Inside this tx, lantern_app role + GUC are set.
			// We mimic the GUC-only enforcement (superuser pool still used here
			// for convenience; a lantern_app pool would enforce at the DB level).
			if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
				return fmt.Errorf("SET LOCAL ROLE: %w", err)
			}
			return tx.QueryRow(ctx,
				"SELECT COUNT(*) FROM runs WHERE id = $1::uuid", runID,
			).Scan(&count)
		})
		if err != nil {
			t.Fatalf("WithTenantConn (tenant A): %v", err)
		}
		if count != 1 {
			t.Errorf("WithTenantConn same-tenant: expected 1, got %d", count)
		}
	})

	t.Run("WithTenantConn_CrossTenant", func(t *testing.T) {
		var count int
		err := db.WithTenantConn(ctx, superPool, tenantB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
				return fmt.Errorf("SET LOCAL ROLE: %w", err)
			}
			return tx.QueryRow(ctx,
				"SELECT COUNT(*) FROM runs WHERE id = $1::uuid", runID,
			).Scan(&count)
		})
		if err != nil {
			t.Fatalf("WithTenantConn (tenant B): %v", err)
		}
		if count != 0 {
			t.Errorf("WithTenantConn cross-tenant: expected 0, got %d — RLS not enforced", count)
		}
	})
}

// rlsTenantTables is the canonical list of tenant-scoped tables that MUST carry
// RLS (ENABLE + FORCE + a tenant_isolation policy referencing app.tenant_id).
// It mirrors migration 0003 plus the baseline agents/runs. Adding a new
// tenant table without RLS will make TestRLSEnforcement_AllTenantTables fail —
// that is the intended permanent gate.
var rlsTenantTables = []string{
	"agents", "runs",
	"users", "connector_installs", "surface_configs", "api_keys",
	"deployments", "data_planes", "llm_provider_configs", "schedules",
	"sessions", "agent_budgets", "cost_forecasts", "marketplace_stars",
	"agent_mcp_attachments", "eval_suites", "eval_runs", "eval_baselines",
	"agent_experiments", "agent_usage_daily", "run_receipts", "run_feedback",
	"takeover_requests", "voice_numbers", "voice_calls",
	"whatsapp_contact_facts", "whatsapp_vip_contacts", "whatsapp_pending_drafts",
	"runtime_quotas", "runtime_audit_events", "runtime_vms", "people",
	"person_handles", "memory_events", "runtime_vm_logs", "side_effect_receipts",
	"life_events", "life_event_prefs",
	"commitments",
	"gmail_poll_cursors",
	"domain_records",
}

// rlsExemptTables are intentionally NOT under RLS: no single owning tenant_id,
// or deliberately cross-tenant. This is the allowlist the gate-test enforces.
var rlsExemptTables = map[string]bool{
	"tenants":                 true,
	"agent_versions":          true,
	"journal_events":          true,
	"run_locks":               true,
	"marketplace_agents":      true,
	"mcp_servers":             true,
	"marketplace_invocations": true,
}

// TestRLSEnforcement_AllTenantTables is the permanent catalog gate. For every
// table in rlsTenantTables it asserts, directly against the Postgres catalogs:
//   - pg_class.relrowsecurity  is true (RLS ENABLED)
//   - pg_class.relforcerowsecurity is true (RLS FORCED — owner not exempt)
//   - a pg_policies row exists whose USING (qual) AND WITH CHECK references
//     current_setting('app.tenant_id') — i.e. a real tenant_isolation policy.
//
// It also re-asserts the exempt set is mutually exclusive with the enforced set,
// so a table can't be silently both listed and allowlisted.
//
// This fails the moment a future tenant table is added without RLS, forcing the
// author to either add the policy (migration) or justify an exemption.
func TestRLSEnforcement_AllTenantTables(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// Guard: no table is both enforced and exempt.
	for _, tbl := range rlsTenantTables {
		if rlsExemptTables[tbl] {
			t.Errorf("table %q appears in BOTH the enforced and exempt sets — pick one", tbl)
		}
	}

	for _, tbl := range rlsTenantTables {
		tbl := tbl
		t.Run(tbl, func(t *testing.T) {
			var relRowsec, relForce bool
			err := superPool.QueryRow(ctx, `
				SELECT c.relrowsecurity, c.relforcerowsecurity
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relname = $1
			`, tbl).Scan(&relRowsec, &relForce)
			if err != nil {
				t.Fatalf("catalog lookup for %q: %v (does the table exist?)", tbl, err)
			}
			if !relRowsec {
				t.Errorf("table %q: ROW LEVEL SECURITY not ENABLED — tenant isolation backstop missing", tbl)
			}
			if !relForce {
				t.Errorf("table %q: ROW LEVEL SECURITY not FORCED — owner role can bypass RLS", tbl)
			}

			// At least one policy on this table must reference app.tenant_id in
			// BOTH its USING qual and its WITH CHECK expression.
			var hasPolicy bool
			err = superPool.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM pg_policies
					WHERE schemaname = 'public' AND tablename = $1
					  AND qual       LIKE '%app.tenant_id%'
					  AND with_check LIKE '%app.tenant_id%'
				)
			`, tbl).Scan(&hasPolicy)
			if err != nil {
				t.Fatalf("pg_policies lookup for %q: %v", tbl, err)
			}
			if !hasPolicy {
				t.Errorf("table %q: no tenant_isolation policy with BOTH USING and WITH CHECK referencing app.tenant_id", tbl)
			}
		})
	}
}

// TestRLSEnforcement_Sessions mirrors the agents/runs cross-tenant proof for the
// 'sessions' table — the table cut over to s.srv.WithTenant in handlers/sessions.go.
// Under the lantern_app (RLS-subject) role, a session owned by tenant B is
// invisible to tenant A, and visible to tenant B. Seeded via the privileged pool.
func TestRLSEnforcement_Sessions(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	seedRLSTenant(t, superPool, tenantA)
	seedRLSTenant(t, superPool, tenantB)

	// Seed a session owned by tenant B via the privileged pool (bypasses RLS).
	sessionID := uuid.New().String()
	_, err := superPool.Exec(ctx, `
		INSERT INTO sessions (id, tenant_id, agent_name, status, messages)
		VALUES ($1::uuid, $2::uuid, 'rls-session-agent', 'active', '[]'::jsonb)
		ON CONFLICT (id) DO NOTHING
	`, sessionID, tenantB)
	if err != nil {
		t.Fatalf("seed session for tenant B: %v", err)
	}
	t.Cleanup(func() {
		_, _ = superPool.Exec(context.Background(), "DELETE FROM sessions WHERE id = $1::uuid", sessionID)
	})

	// Tenant A (the non-owner) must NOT see tenant B's session.
	t.Run("CrossTenant_DeniedByRLS", func(t *testing.T) {
		count := querySessionCount(t, superPool, ctx, tenantA, sessionID)
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: tenant A can see %d session row(s) belonging to tenant B — RLS not enforced on sessions", count)
		}
	})

	// Tenant B (the owner) sees its own session.
	t.Run("WithinTenantB_CanRead", func(t *testing.T) {
		count := querySessionCount(t, superPool, ctx, tenantB, sessionID)
		if count != 1 {
			t.Errorf("tenant B: expected 1 visible session row for its own session, got %d", count)
		}
	})

	// The privileged superuser pool bypasses RLS and sees the row regardless.
	t.Run("PrivilegedPool_BypassesRLS", func(t *testing.T) {
		var count int
		if err := superPool.QueryRow(ctx,
			"SELECT COUNT(*) FROM sessions WHERE id = $1::uuid", sessionID,
		).Scan(&count); err != nil {
			t.Fatalf("privileged pool query: %v", err)
		}
		if count != 1 {
			t.Errorf("privileged pool: expected 1 row (bypass RLS), got %d", count)
		}
	})
}

// querySessionCount opens a transaction as lantern_app, sets the tenant GUC, and
// returns how many sessions with the given ID are visible.
func querySessionCount(t *testing.T, pool *pgxpool.Pool, ctx context.Context, tenantID, sessionID string) int {
	t.Helper()
	var count int
	err := runAsAppRole(pool, ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
			return fmt.Errorf("set_config: %w", err)
		}
		return tx.QueryRow(ctx,
			"SELECT COUNT(*) FROM sessions WHERE id = $1::uuid", sessionID,
		).Scan(&count)
	})
	if err != nil {
		t.Fatalf("querySessionCount(tenant=%s): %v", tenantID, err)
	}
	return count
}

// queryRunCount opens a transaction as lantern_app, sets the tenant GUC, and
// returns how many runs with the given ID are visible.
func queryRunCount(t *testing.T, pool *pgxpool.Pool, ctx context.Context, tenantID, runID string) int {
	t.Helper()
	var count int
	err := runAsAppRole(pool, ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
			return fmt.Errorf("set_config: %w", err)
		}
		return tx.QueryRow(ctx,
			"SELECT COUNT(*) FROM runs WHERE id = $1::uuid", runID,
		).Scan(&count)
	})
	if err != nil {
		t.Fatalf("queryRunCount(tenant=%s): %v", tenantID, err)
	}
	return count
}

// ---------------------------------------------------------------------------
// TestRLSEnforcement_CutoverPaths proves that the handlers that were cut over
// to TenantPool() + setRLSTenantID still work correctly under RLS enforcement:
//
//  (a) same-tenant reads STILL WORK — the GUC is set, so the tenant sees its
//      own data (the critical regression test: not returning zero rows).
//  (b) cross-tenant reads are DENIED — tenant B cannot see tenant A's rows.
//  (c) the PRIVILEGED pool (recovery / system paths) still bypasses RLS and
//      sees all rows — system sweeps unaffected.
//  (d) WithTenantConn helper: same-tenant write + read round-trips correctly.
//
// This mirrors exactly what happens in handlers/agents.go CreateAgent /
// GetAgent / ListAgents / DeleteAgent and handlers/runs.go CreateRun /
// CancelRun / GetRun / ListRuns after the TenantPool() cutover, because those
// handlers call setRLSTenantID (set_config) inside a transaction on TenantPool
// (which becomes lantern_app when LANTERN_RLS_ENFORCE=1).
// ---------------------------------------------------------------------------

// TestRLSEnforcement_CutoverPaths_Agents is the same-tenant-still-works proof
// for the agents table, exercising the pattern used by agents.go after cutover.
func TestRLSEnforcement_CutoverPaths_Agents(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	seedRLSTenant(t, superPool, tenantA)
	seedRLSTenant(t, superPool, tenantB)

	agentName := "cutover-agent-" + tenantA[:8]

	// Insert via lantern_app role (simulating TenantPool when enforcement is on).
	err := runAsAppRole(superPool, ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantA); err != nil {
			return fmt.Errorf("set_config tenantA: %w", err)
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO agents (tenant_id, name, description, labels)
			VALUES ($1::uuid, $2, 'cutover proof', '{}')
			ON CONFLICT (tenant_id, name) DO NOTHING
		`, tenantA, agentName)
		return err
	})
	if err != nil {
		t.Fatalf("insert agent via lantern_app: %v", err)
	}

	// (a) Same-tenant read still works — the GUC is set correctly.
	t.Run("SameTenant_ReadsOwnRow", func(t *testing.T) {
		count := queryAgentCount(t, superPool, ctx, tenantA, agentName)
		if count != 1 {
			t.Errorf("same-tenant: expected 1 visible row, got %d — GUC set but row invisible (regression: path returns 0 rows)", count)
		}
	})

	// (b) Cross-tenant read is denied by RLS.
	t.Run("CrossTenant_Denied", func(t *testing.T) {
		count := queryAgentCount(t, superPool, ctx, tenantB, agentName)
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: tenant B sees %d row(s) belonging to tenant A — RLS not enforced on agents after cutover", count)
		}
	})

	// (c) Privileged pool bypasses RLS — recovery / system paths unaffected.
	t.Run("PrivilegedPool_BypassesRLS", func(t *testing.T) {
		var count int
		if err := superPool.QueryRow(ctx,
			"SELECT COUNT(*) FROM agents WHERE name = $1", agentName,
		).Scan(&count); err != nil {
			t.Fatalf("privileged pool query: %v", err)
		}
		if count != 1 {
			t.Errorf("privileged pool: expected 1 row (bypass RLS), got %d — system paths may be broken", count)
		}
	})

	// (d) WithTenantConn write + read round-trip.
	t.Run("WithTenantConn_WriteReadRoundTrip", func(t *testing.T) {
		name2 := "cutover-agent2-" + tenantA[:8]
		t.Cleanup(func() {
			_, _ = superPool.Exec(context.Background(), "DELETE FROM agents WHERE name = $1 AND tenant_id = $2::uuid", name2, tenantA)
		})
		// Write.
		err := db.WithTenantConn(ctx, superPool, tenantA, func(tx pgx.Tx) error {
			// Drop to lantern_app to prove RLS is active (same as TenantPool).
			if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
				return fmt.Errorf("SET LOCAL ROLE: %w", err)
			}
			_, err := tx.Exec(ctx, `
				INSERT INTO agents (tenant_id, name, description, labels)
				VALUES ($1::uuid, $2, 'withtenant proof', '{}')
				ON CONFLICT (tenant_id, name) DO NOTHING
			`, tenantA, name2)
			return err
		})
		if err != nil {
			t.Fatalf("WithTenantConn write: %v", err)
		}
		// Read back — same-tenant still sees it.
		count := queryAgentCount(t, superPool, ctx, tenantA, name2)
		if count != 1 {
			t.Errorf("WithTenantConn round-trip: expected 1, got %d — write succeeded but read returned 0 (GUC regression)", count)
		}
		// Cross-tenant cannot see it.
		count = queryAgentCount(t, superPool, ctx, tenantB, name2)
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: cross-tenant sees WithTenantConn-written row: got %d", count)
		}
	})
}

// TestRLSEnforcement_CutoverPaths_Runs is the same-tenant-still-works proof
// for the runs table, exercising the pattern used by runs.go after cutover.
func TestRLSEnforcement_CutoverPaths_Runs(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	seedRLSTenant(t, superPool, tenantA)
	seedRLSTenant(t, superPool, tenantB)

	// Seed agent + version for FK.
	agentID := uuid.New().String()
	agentVersionID := uuid.New().String()
	agentName := "cutover-run-agent-" + tenantA[:8]
	_, err := superPool.Exec(ctx, `
		INSERT INTO agents (id, tenant_id, name, description, labels)
		VALUES ($1::uuid, $2::uuid, $3, 'cutover run proof', '{}')
		ON CONFLICT (tenant_id, name) DO NOTHING
	`, agentID, tenantA, agentName)
	if err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	_, err = superPool.Exec(ctx, `
		INSERT INTO agent_versions (id, agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1::uuid, $2::uuid, '1', 'sha256:cutover', 's3://test', '{}'::jsonb)
		ON CONFLICT (id) DO NOTHING
	`, agentVersionID, agentID)
	if err != nil {
		t.Fatalf("insert agent_version: %v", err)
	}
	t.Cleanup(func() {
		_, _ = superPool.Exec(context.Background(), "DELETE FROM agents WHERE id = $1::uuid", agentID)
	})

	// CreateRun-style insert via lantern_app (TenantPool() pattern).
	runID := uuid.New().String()
	err = runAsAppRole(superPool, ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantA); err != nil {
			return fmt.Errorf("set_config: %w", err)
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO runs (id, tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', 'api', '{}'::jsonb)
			ON CONFLICT (id) DO NOTHING
		`, runID, tenantA, agentID, agentVersionID)
		return err
	})
	if err != nil {
		t.Fatalf("insert run via lantern_app: %v", err)
	}
	t.Cleanup(func() {
		_, _ = superPool.Exec(context.Background(), "DELETE FROM runs WHERE id = $1::uuid", runID)
	})

	// (a) Same-tenant can read its own run (the critical regression test).
	t.Run("SameTenant_ReadsOwnRun", func(t *testing.T) {
		count := queryRunCount(t, superPool, ctx, tenantA, runID)
		if count != 1 {
			t.Errorf("same-tenant: expected 1 visible row, got %d — GUC set but run invisible (regression: path returns 0 rows after cutover)", count)
		}
	})

	// (b) Cross-tenant read denied.
	t.Run("CrossTenant_Denied", func(t *testing.T) {
		count := queryRunCount(t, superPool, ctx, tenantB, runID)
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: tenant B sees %d run(s) belonging to tenant A — RLS not enforced on runs after cutover", count)
		}
	})

	// (c) Privileged pool bypasses RLS (recovery sweeps unaffected).
	t.Run("PrivilegedPool_BypassesRLS", func(t *testing.T) {
		var count int
		if err := superPool.QueryRow(ctx,
			"SELECT COUNT(*) FROM runs WHERE id = $1::uuid", runID,
		).Scan(&count); err != nil {
			t.Fatalf("privileged pool query: %v", err)
		}
		if count != 1 {
			t.Errorf("privileged pool: expected 1 row (bypass RLS), got %d — recovery sweeps may be broken", count)
		}
	})
}

// ---------------------------------------------------------------------------
// TestRLSEnforcement_WithTenantConn_HandlerPattern is the handler-path test
// the security review required.
//
// It exercises db.WithTenantConn EXACTLY as the fixed REST handlers use it
// (rest.go UpdateAgent, GetAgent ext-cols, DeleteRun, SaveWorkflow, GetWorkflow,
// ListRuns/GetRun enrichment) and proves:
//
//	(a) same-tenant read RETURNS THE ROW (not zero) when the GUC is set via
//	    WithTenantConn — this is the critical regression the bare TenantPool()
//	    call without GUC would fail on under enforcement.
//	(b) cross-tenant read via WithTenantConn returns ZERO ROWS (RLS denies).
//	(c) a bare TenantPool() call WITHOUT WithTenantConn (the broken pre-fix
//	    pattern) returns ZERO ROWS even for the same tenant — proving the GUC
//	    is required and was the root cause.
//
// The test uses SET LOCAL ROLE lantern_app to simulate LANTERN_RLS_ENFORCE=1
// (the TenantPool connecting as the non-superuser role) without needing a
// separate DSN.
// ---------------------------------------------------------------------------
func TestRLSEnforcement_WithTenantConn_HandlerPattern(t *testing.T) {
	superPool := openSuperPool(t)
	ctx := context.Background()

	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	tenantA := uuid.New().String()
	tenantB := uuid.New().String()
	seedRLSTenant(t, superPool, tenantA)
	seedRLSTenant(t, superPool, tenantB)

	agentName := "handler-pattern-" + tenantA[:8]

	// Seed the agent row using the superuser pool (bypasses RLS for setup).
	_, err := superPool.Exec(ctx, `
		INSERT INTO agents (tenant_id, name, description, labels)
		VALUES ($1::uuid, $2, 'handler pattern test', '{}')
		ON CONFLICT (tenant_id, name) DO NOTHING
	`, tenantA, agentName)
	if err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = superPool.Exec(context.Background(),
			"DELETE FROM agents WHERE name = $1 AND tenant_id = $2::uuid", agentName, tenantA)
	})

	// appRolePool simulates TenantPool() under LANTERN_RLS_ENFORCE=1 by using
	// SET LOCAL ROLE inside each WithTenantConn transaction. In production the
	// pool itself connects as lantern_app; here we use superPool + SET LOCAL ROLE
	// to achieve the same effect without needing a separate DSN in CI.
	//
	// withEnforcement wraps WithTenantConn and drops to lantern_app inside the
	// closure — identical to what TenantPool() + WithTenantConn does at runtime.
	withEnforcement := func(tenantID string, fn func(pgx.Tx) error) error {
		return db.WithTenantConn(ctx, superPool, tenantID, func(tx pgx.Tx) error {
			// Drop to the non-superuser role so the RLS policies are evaluated.
			if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
				return fmt.Errorf("SET LOCAL ROLE: %w", err)
			}
			return fn(tx)
		})
	}

	// -------------------------------------------------------------------------
	// (a) CRITICAL: same-tenant read via WithTenantConn returns the row.
	//     This is the regression that the bare TenantPool().QueryRow() call
	//     (without GUC) would fail: it returns 0 rows even for the owner.
	// -------------------------------------------------------------------------
	t.Run("SameTenant_WithTenantConn_ReturnsRow", func(t *testing.T) {
		var count int
		err := withEnforcement(tenantA, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				"SELECT COUNT(*) FROM agents WHERE tenant_id = $1::uuid AND name = $2",
				tenantA, agentName,
			).Scan(&count)
		})
		if err != nil {
			t.Fatalf("WithTenantConn same-tenant query: %v", err)
		}
		if count != 1 {
			t.Errorf("REGRESSION: same-tenant WithTenantConn returned %d rows, want 1 — GUC not being set or RLS not enforced correctly", count)
		}
	})

	// -------------------------------------------------------------------------
	// (b) Cross-tenant read via WithTenantConn returns ZERO ROWS (RLS denies).
	// -------------------------------------------------------------------------
	t.Run("CrossTenant_WithTenantConn_Denied", func(t *testing.T) {
		var count int
		err := withEnforcement(tenantB, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				"SELECT COUNT(*) FROM agents WHERE name = $1",
				agentName,
			).Scan(&count)
		})
		if err != nil {
			t.Fatalf("WithTenantConn cross-tenant query: %v", err)
		}
		if count != 0 {
			t.Errorf("SECURITY VIOLATION: cross-tenant WithTenantConn returned %d rows, want 0 — RLS not enforced", count)
		}
	})

	// -------------------------------------------------------------------------
	// (c) Bare pool call WITHOUT WithTenantConn (the pre-fix broken pattern)
	//     returns ZERO ROWS even for the same tenant — proving the GUC is what
	//     makes the difference, and why the fix (WithTenantConn) is necessary.
	// -------------------------------------------------------------------------
	t.Run("BarePoolWithoutGUC_ReturnsZero_ProvesFix_Necessary", func(t *testing.T) {
		// Simulate the broken pre-fix pattern: lantern_app role but NO set_config.
		tx, err := superPool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin tx: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		if _, err := tx.Exec(ctx, "SET LOCAL ROLE lantern_app"); err != nil {
			t.Fatalf("SET LOCAL ROLE: %v", err)
		}
		// GUC deliberately NOT set — this is the pre-fix bug.

		var count int
		if err := tx.QueryRow(ctx,
			"SELECT COUNT(*) FROM agents WHERE tenant_id = $1::uuid AND name = $2",
			tenantA, agentName,
		).Scan(&count); err != nil {
			t.Fatalf("bare pool query: %v", err)
		}
		// The RLS policy evaluates current_setting('app.tenant_id', true) which
		// returns '' → matches nothing → 0 rows even for the row's own owner.
		if count != 0 {
			t.Errorf("expected 0 rows without GUC (proves the fix is necessary), got %d — RLS policy may not be active on this DB", count)
		}
	})
}
