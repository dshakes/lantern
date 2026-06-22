package scheduler

// Integration tests for the distributed-locking scheduler.
//
// Skipped automatically when DATABASE_URL is unset (same convention as the
// handlers and db packages). Run against a real Postgres instance:
//
//	export DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern_ga2?sslmode=disable"
//	go test -race -count=1 ./internal/scheduler/...

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// noopLogger returns a zap logger that discards all output.
func noopLogger(t *testing.T) *zap.Logger {
	t.Helper()
	return zap.NewNop()
}

// openTestPool opens a pool using DATABASE_URL. Skips the test if unset or DB
// is unreachable — identical pattern to db/rls_test.go.
func openTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping DB test in -short mode")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set — skipping scheduler integration test")
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

// ensureSchema creates the schedules table (and its dependency) if they do not
// exist. The gate command runs db.Migrate; these DDL statements handle running
// the test against a DB that already has the schema.
func ensureSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS tenants (
			id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			slug          TEXT NOT NULL UNIQUE,
			tier          TEXT NOT NULL DEFAULT 'free',
			k8s_namespace TEXT NOT NULL DEFAULT '',
			settings      JSONB DEFAULT '{}'::jsonb,
			created_at    TIMESTAMPTZ DEFAULT now(),
			updated_at    TIMESTAMPTZ DEFAULT now()
		)`,
		`CREATE TABLE IF NOT EXISTS schedules (
			id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			agent_name     TEXT NOT NULL,
			cron_expr      TEXT NOT NULL,
			input_template JSONB DEFAULT '{}'::jsonb,
			config         JSONB DEFAULT '{}'::jsonb,
			enabled        BOOLEAN NOT NULL DEFAULT true,
			next_fire_at   TIMESTAMPTZ,
			last_fired_at  TIMESTAMPTZ,
			created_at     TIMESTAMPTZ DEFAULT now(),
			updated_at     TIMESTAMPTZ DEFAULT now(),
			UNIQUE(tenant_id, agent_name)
		)`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatalf("ensureSchema: %v", err)
		}
	}
}

// seedTenant inserts a test tenant and returns its UUID string.
// Column list matches the real schema from internal/db/migrate.go.
func seedTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	nano := time.Now().UnixNano()
	slug := fmt.Sprintf("sched-test-%d", nano)
	name := fmt.Sprintf("Sched Test %d", nano)
	ns := fmt.Sprintf("ns-sched-%d", nano)
	var id string
	err := pool.QueryRow(ctx,
		`INSERT INTO tenants (slug, name, tier, k8s_namespace)
		 VALUES ($1, $2, 'personal', $3)
		 RETURNING id::text`,
		slug, name, ns,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seedTenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}

// insertSchedule inserts a schedule row and registers cleanup.
func insertSchedule(t *testing.T, pool *pgxpool.Pool, tenantID, agentName, cronExpr string, nextFireAt time.Time, enabled bool) string {
	t.Helper()
	ctx := context.Background()
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO schedules (tenant_id, agent_name, cron_expr, next_fire_at, enabled)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id`,
		tenantID, agentName, cronExpr, nextFireAt, enabled,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insertSchedule: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM schedules WHERE id = $1`, id)
	})
	return id
}

// TestConcurrentPoll_ExactlyOnce is the key correctness test.
//
// Two scheduler instances share the same pool and call poll() concurrently
// against a single due schedule row. The total fire count must be exactly 1.
func TestConcurrentPoll_ExactlyOnce(t *testing.T) {
	pool := openTestPool(t)
	ensureSchema(t, pool)

	tenantID := seedTenant(t, pool)
	_ = insertSchedule(t, pool, tenantID, "agent-concurrent", "* * * * *",
		time.Now().Add(-1*time.Second), true)

	var fired atomic.Int64
	makeExecutor := func() ExecutorFunc {
		return func(_, _, _ string, _ map[string]any) {
			fired.Add(1)
		}
	}

	logger := noopLogger(t)
	s1 := New(pool, logger, makeExecutor())
	s2 := New(pool, logger, makeExecutor())

	ctx := context.Background()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s1.poll(ctx) }()
	go func() { defer wg.Done(); s2.poll(ctx) }()
	wg.Wait()

	if got := fired.Load(); got != 1 {
		t.Errorf("concurrent poll: want exactly 1 fire, got %d", got)
	}
}

// TestNextFireAtAdvances checks that after a poll, next_fire_at moves forward
// so a second poll in the same window does not fire again.
func TestNextFireAtAdvances(t *testing.T) {
	pool := openTestPool(t)
	ensureSchema(t, pool)

	tenantID := seedTenant(t, pool)
	schedID := insertSchedule(t, pool, tenantID, "agent-advance", "* * * * *",
		time.Now().Add(-1*time.Second), true)

	logger := noopLogger(t)
	var fired atomic.Int64
	s := New(pool, logger, func(_, _, _ string, _ map[string]any) { fired.Add(1) })

	s.poll(context.Background())
	if fired.Load() != 1 {
		t.Fatalf("expected 1 fire, got %d", fired.Load())
	}

	// next_fire_at must be in the future after the poll.
	var nextFireAt time.Time
	err := pool.QueryRow(context.Background(),
		`SELECT next_fire_at FROM schedules WHERE id = $1`, schedID,
	).Scan(&nextFireAt)
	if err != nil {
		t.Fatalf("reading next_fire_at: %v", err)
	}
	if !nextFireAt.After(time.Now()) {
		t.Errorf("next_fire_at %v should be in the future", nextFireAt)
	}

	// A second immediate poll must not fire again.
	s.poll(context.Background())
	if fired.Load() != 1 {
		t.Errorf("second poll should not fire again; total fires = %d", fired.Load())
	}
}

// TestDisabledScheduleNotFired ensures a disabled schedule is never claimed.
func TestDisabledScheduleNotFired(t *testing.T) {
	pool := openTestPool(t)
	ensureSchema(t, pool)

	tenantID := seedTenant(t, pool)
	_ = insertSchedule(t, pool, tenantID, "agent-disabled", "* * * * *",
		time.Now().Add(-1*time.Second), false /* disabled */)

	logger := noopLogger(t)
	var fired atomic.Int64
	s := New(pool, logger, func(_, _, _ string, _ map[string]any) { fired.Add(1) })

	s.poll(context.Background())

	if fired.Load() != 0 {
		t.Errorf("disabled schedule must not fire; got %d fires", fired.Load())
	}
}

// TestNotYetDueScheduleNotFired ensures a schedule with next_fire_at in the
// future is not claimed.
func TestNotYetDueScheduleNotFired(t *testing.T) {
	pool := openTestPool(t)
	ensureSchema(t, pool)

	tenantID := seedTenant(t, pool)
	_ = insertSchedule(t, pool, tenantID, "agent-future", "* * * * *",
		time.Now().Add(10*time.Minute), true)

	logger := noopLogger(t)
	var fired atomic.Int64
	s := New(pool, logger, func(_, _, _ string, _ map[string]any) { fired.Add(1) })

	s.poll(context.Background())

	if fired.Load() != 0 {
		t.Errorf("future schedule must not fire; got %d fires", fired.Load())
	}
}

// TestBadCronExprDisablesSchedule checks that a schedule with an invalid cron
// expression is disabled in-place and never fired.
func TestBadCronExprDisablesSchedule(t *testing.T) {
	pool := openTestPool(t)
	ensureSchema(t, pool)

	tenantID := seedTenant(t, pool)
	schedID := insertSchedule(t, pool, tenantID, "agent-badcron", "not-a-cron",
		time.Now().Add(-1*time.Second), true)

	logger := noopLogger(t)
	var fired atomic.Int64
	s := New(pool, logger, func(_, _, _ string, _ map[string]any) { fired.Add(1) })

	s.poll(context.Background())

	if fired.Load() != 0 {
		t.Errorf("bad-cron schedule must not fire; got %d fires", fired.Load())
	}

	var enabled bool
	err := pool.QueryRow(context.Background(),
		`SELECT enabled FROM schedules WHERE id = $1`, schedID,
	).Scan(&enabled)
	if err != nil {
		t.Fatalf("reading enabled flag: %v", err)
	}
	if enabled {
		t.Error("schedule with bad cron expr should be disabled after poll")
	}
}
