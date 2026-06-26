package handlers

// RLS ENFORCEMENT-ON integration harness.
//
// This is the reusable test harness for the staged handler cutover to
// s.srv.WithTenant (see CLAUDE.md "Local development" + ADR 0011). Unlike the
// catalog/GUC tests in internal/db/rls_test.go — which simulate the app role
// with `SET LOCAL ROLE lantern_app` inside the superuser pool — this harness
// constructs a *real* server.Server whose TenantPool() (AppPool) connects to
// Postgres AS the non-superuser `lantern_app` role over its own DSN. That means
// RLS is genuinely ENFORCED at the database for every query a handler routes
// through s.srv.WithTenant, exactly as production behaves under
// LANTERN_RLS_ENFORCE=1 + LANTERN_APP_DB_PASSWORD.
//
// The harness:
//  1. Opens the privileged (superuser) pool from DATABASE_URL — used for schema
//     migration + cross-tenant seeding (bypasses RLS, mirrors recovery sweeps).
//  2. Runs Migrate() so the schema, the RLS policies, and the `lantern_app`
//     LOGIN role all exist.
//  3. ALTER ROLE lantern_app PASSWORD '<test-pw>' — the role is created LOGIN
//     but password-less by the baseline migration; we set one for the test the
//     same way an operator does in prod (CLAUDE.md: "ALTER ROLE lantern_app
//     PASSWORD '<strong>'"). This is the documented setup, not a new scheme.
//  4. Builds the app-pool DSN by reusing the EXACT production logic
//     (cmd/server.buildAppPoolConfig): parse DATABASE_URL, swap user→lantern_app
//     and password, preserving every other DSN parameter. Replicated here as
//     buildLanternAppPool because that helper lives in package main.
//  5. Returns a *server.Server with Pool=superPool and AppPool=appPool, so
//     s.srv.WithTenant(...) routes through the RLS-subject role.
//
// Skips cleanly when DATABASE_URL is unset, and skips (does not fail) when the
// lantern_app role can't be made password-loginable on this DB — so it never
// breaks a contributor who only has a superuser DSN.

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// injectTenant is a thin alias over middleware.InjectTenantID for terse test
// call sites — it puts the tenant_id in the context so s.srv.WithTenant can
// resolve it via MustTenantID.
func injectTenant(ctx context.Context, tenantID string) context.Context {
	return middleware.InjectTenantID(ctx, tenantID)
}

// rlsAppPassword is the test-only password stamped onto the lantern_app role so
// the harness can open a real login connection as that (non-superuser) role.
// It never leaves the test process and is not a production credential.
const rlsAppPassword = "rls_harness_app_pw_do_not_use_in_prod"

// enforcedServer is the handle returned by newEnforcedServer: it carries the
// RLS-enforced Server plus the privileged pool for seeding/cleanup.
type enforcedServer struct {
	srv       *server.Server
	superPool *pgxpool.Pool // BYPASSRLS — for migration, seeding, assertions
	appPool   *pgxpool.Pool // connects as lantern_app — RLS ENFORCED
}

// newEnforcedServer builds a *server.Server whose TenantPool() is the
// lantern_app-backed AppPool, so RLS is actually enforced for any query routed
// through s.srv.WithTenant. This is THE harness every future cutover batch
// reuses. Skips (never fails) when DATABASE_URL is unset or the app role can't
// be set up on this DB.
func newEnforcedServer(t *testing.T) *enforcedServer {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping RLS enforcement DB test in -short mode")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set — skipping RLS enforcement integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	superPool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("pgxpool.New (super): %v — skipping (DB unreachable?)", err)
	}
	if err := superPool.Ping(ctx); err != nil {
		superPool.Close()
		t.Skipf("super pool ping: %v — skipping (DB unreachable?)", err)
	}
	t.Cleanup(superPool.Close)

	// Ensure schema + RLS policies + the lantern_app role exist.
	if err := db.Migrate(ctx, superPool, false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// Stamp a password on the lantern_app role so we can open a login pool as it.
	// The baseline migration creates the role LOGIN but password-less; this is
	// the documented prod setup step (ALTER ROLE lantern_app PASSWORD ...).
	if _, err := superPool.Exec(ctx,
		fmt.Sprintf("ALTER ROLE lantern_app PASSWORD %s", quoteLiteral(rlsAppPassword)),
	); err != nil {
		t.Skipf("ALTER ROLE lantern_app PASSWORD failed (%v) — caller may lack privilege; skipping enforcement test", err)
	}

	// Build the app-pool config the same way production does: parse DATABASE_URL,
	// swap the user to lantern_app and the password, preserving all other DSN
	// params (sslmode, host, search_path, …).
	appCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse DATABASE_URL for app pool: %v", err)
	}
	appCfg.ConnConfig.User = "lantern_app"
	appCfg.ConnConfig.Password = rlsAppPassword

	appPool, err := pgxpool.NewWithConfig(ctx, appCfg)
	if err != nil {
		t.Skipf("open lantern_app pool: %v — skipping enforcement test", err)
	}
	if err := appPool.Ping(ctx); err != nil {
		appPool.Close()
		t.Skipf("lantern_app pool ping: %v (role may not be loginable on this DB) — skipping enforcement test", err)
	}
	t.Cleanup(appPool.Close)

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{
		Pool:    superPool,
		AppPool: appPool, // TenantPool() returns this → RLS enforced
		Logger:  logger,
	}

	return &enforcedServer{srv: srv, superPool: superPool, appPool: appPool}
}

// quoteLiteral safely single-quotes a string literal for inline SQL (the role
// password). pgx has no parameter binding for ALTER ROLE, so we quote by hand:
// double any embedded single quotes. The value is a compile-time constant under
// test control, but we quote correctly regardless.
func quoteLiteral(s string) string {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '\'')
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out = append(out, '\'')
		}
		out = append(out, s[i])
	}
	out = append(out, '\'')
	return string(out)
}

// seedEnforcedTenant inserts a fresh tenant via the privileged pool (bypasses
// RLS) and registers cleanup. Returns the tenant id.
func seedEnforcedTenant(t *testing.T, e *enforcedServer, slug string) string {
	t.Helper()
	var id string
	if err := e.superPool.QueryRow(context.Background(), `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ($1, $1, 'personal', 'lantern-t-' || $1)
		RETURNING id
	`, slug).Scan(&id); err != nil {
		t.Fatalf("seed enforced tenant %q: %v", slug, err)
	}
	t.Cleanup(func() {
		_, _ = e.superPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// TestRLSHarness_EnforcesOnAppPool is a self-test for the harness itself: it
// proves the AppPool genuinely runs as a role that RLS applies to (cross-tenant
// reads return zero), independent of any handler under test. If this fails, the
// harness is not actually enforcing and every cutover test built on it is
// worthless — so it guards the guard.
func TestRLSHarness_EnforcesOnAppPool(t *testing.T) {
	e := newEnforcedServer(t)
	ctx := context.Background()

	tenantA := seedEnforcedTenant(t, e, "rls-harness-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-harness-"+uuid.NewString()[:8])

	// Seed a connector_install owned by tenant A via the privileged pool.
	connID := "github"
	if _, err := e.superPool.Exec(ctx, `
		INSERT INTO connector_installs (tenant_id, connector_id, display_name, status, config, scopes)
		VALUES ($1::uuid, $2, 'Harness GitHub', 'connected', '{}'::jsonb, '{}')
		ON CONFLICT (tenant_id, connector_id) DO NOTHING
	`, tenantA, connID); err != nil {
		t.Fatalf("seed connector for tenant A: %v", err)
	}

	// Tenant A (via WithTenant on the AppPool) sees its own row.
	var aCount int
	if err := e.srv.WithTenant(injectTenant(ctx, tenantA), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			"SELECT COUNT(*) FROM connector_installs WHERE connector_id = $1", connID,
		).Scan(&aCount)
	}); err != nil {
		t.Fatalf("tenant A read via AppPool: %v", err)
	}
	if aCount != 1 {
		t.Errorf("harness not scoping correctly: tenant A expected 1 own row, got %d", aCount)
	}

	// Tenant B (via WithTenant on the AppPool) must see ZERO — RLS enforced.
	var bCount int
	if err := e.srv.WithTenant(injectTenant(ctx, tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			"SELECT COUNT(*) FROM connector_installs WHERE connector_id = $1", connID,
		).Scan(&bCount)
	}); err != nil {
		t.Fatalf("tenant B read via AppPool: %v", err)
	}
	if bCount != 0 {
		t.Errorf("HARNESS NOT ENFORCING RLS: tenant B saw %d of tenant A's connector rows, want 0 — AppPool is not running as a RLS-subject role", bCount)
	}
}
