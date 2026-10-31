package handlers

// Split-brain fencing tests for ADR 0046 (multi-region).
//
// Each test runs against its OWN freshly created database (never the shared
// DATABASE_URL database): arming the fence is cluster-global state and would
// fence every other DB test running against the same database.
//
//	DATABASE_URL=postgres://pal:pal@localhost:5432/pal?sslmode=disable \
//	    go test ./internal/handlers/ -run TestRegionFence -count=1 -v

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/db"
	"github.com/dshakes/pal/services/control-plane/internal/region"
)

// freshFenceDB creates a brand-new database, migrates it, and returns its
// config (so callers can open pools with different region/epoch sessions).
func freshFenceDB(t *testing.T) *pgxpool.Config {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping DB test in -short mode")
	}
	base := os.Getenv("DATABASE_URL")
	if base == "" {
		t.Skip("DATABASE_URL not set — skipping integration test (run `make dev-infra` first)")
	}
	ctx := context.Background()
	adminCfg, err := pgx.ParseConfig(base)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	adminCfg.Database = "postgres"
	admin, err := pgx.ConnectConfig(ctx, adminCfg)
	if err != nil {
		t.Skipf("connect admin db: %v — skipping (DB unreachable?)", err)
	}
	name := fmt.Sprintf("pal_fence_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		_ = admin.Close(ctx)
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		_ = admin.Close(context.Background())
	})

	cfg, err := pgxpool.ParseConfig(base)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ConnConfig.Database = name
	mig, err := pgxpool.NewWithConfig(ctx, cfg.Copy())
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer mig.Close()
	if err := db.Migrate(ctx, mig, true); err != nil {
		t.Fatalf("migrate fresh db: %v", err)
	}
	return cfg
}

// regionPool opens a pool whose sessions carry the given region identity,
// exactly as main.go wires it (region.Config.ApplyPgSession).
func regionPool(t *testing.T, base *pgxpool.Config, rc region.Config) *pgxpool.Pool {
	t.Helper()
	cfg := base.Copy()
	rc.ApplyPgSession(cfg.ConnConfig)
	p, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(p.Close)
	return p
}

// seedRun inserts an agent/version/run in the dev tenant and returns the run id.
func seedRun(t *testing.T, p *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	var agentID, versionID, runID string
	name := fmt.Sprintf("fence-agent-%d", time.Now().UnixNano())
	if err := p.QueryRow(ctx, `INSERT INTO agents (tenant_id, name, description) VALUES ($1, $2, 'fence') RETURNING id::text`,
		recoveryTestDevTenantID, name).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	if err := p.QueryRow(ctx, `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v1', decode(md5($2), 'hex'), 'local://t', '{}'::jsonb) RETURNING id::text`,
		agentID, name).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if err := p.QueryRow(ctx, `INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb, now()) RETURNING id::text`,
		recoveryTestDevTenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	return runID
}

func requireFenced(t *testing.T, what string, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55000" || !strings.HasPrefix(pgErr.Message, "pal_fence:") {
		t.Fatalf("%s: want pal_fence rejection (55000), got %v", what, err)
	}
}

func journal(ctx context.Context, p *pgxpool.Pool, runID string, seq int) error {
	_, err := p.Exec(ctx, `INSERT INTO journal_events (run_id, seq, kind, step_id, payload)
		VALUES ($1, $2, 'step_started', 's1', '{}')`, runID, seq)
	return err
}

// TestRegionFence_UnarmedIsInert: with no pal_region_fence row (every existing
// deployment), sessions with and without region identity write exactly as
// before, and the region column is stamped only when PAL_REGION is set.
func TestRegionFence_UnarmedIsInert(t *testing.T) {
	base := freshFenceDB(t)
	ctx := context.Background()
	plain := regionPool(t, base, region.Config{})
	east := regionPool(t, base, region.Config{Region: "us-east-1", FenceEpoch: 7})

	runID := seedRun(t, plain)
	if ok, release, err := acquireRunLease(ctx, plain, runID, zap.NewNop()); err != nil || !ok {
		t.Fatalf("unarmed lease: ok=%v err=%v", ok, err)
	} else {
		release()
	}
	if err := journal(ctx, plain, runID, 1); err != nil {
		t.Fatalf("unarmed journal (no region): %v", err)
	}
	if err := journal(ctx, east, runID, 2); err != nil {
		t.Fatalf("unarmed journal (region set, any epoch): %v", err)
	}
	var r1, r2 *string
	if err := plain.QueryRow(ctx, `SELECT region FROM journal_events WHERE run_id=$1 AND seq=1`, runID).Scan(&r1); err != nil {
		t.Fatal(err)
	}
	if err := plain.QueryRow(ctx, `SELECT region FROM journal_events WHERE run_id=$1 AND seq=2`, runID).Scan(&r2); err != nil {
		t.Fatal(err)
	}
	if r1 != nil || r2 == nil || *r2 != "us-east-1" {
		t.Fatalf("region stamping: want NULL then us-east-1, got %v / %v", r1, r2)
	}
	runID2 := seedRun(t, east)
	var runRegion *string
	if err := plain.QueryRow(ctx, `SELECT region FROM runs WHERE id=$1`, runID2).Scan(&runRegion); err != nil || runRegion == nil || *runRegion != "us-east-1" {
		t.Fatalf("runs.region: got %v err %v", runRegion, err)
	}
}

// TestRegionFence_SplitBrain simulates a failover while the old primary is
// still alive and can still reach the (now promoted) database:
//
//  1. region a (epoch 1) holds a live lease on a running run.
//  2. operator promotes region b: epoch -> 2.
//  3. region a's lease renewal, journal append, run-state update and lease
//     release are all rejected by the database.
//  4. region b steals the still-unexpired lease immediately and executes.
//  5. a session with no epoch at all is rejected once armed (fail closed).
func TestRegionFence_SplitBrain(t *testing.T) {
	base := freshFenceDB(t)
	ctx := context.Background()
	operator := regionPool(t, base, region.Config{}) // psql-equivalent: no epoch
	a := regionPool(t, base, region.Config{Region: "region-a", FenceEpoch: 1})
	b := regionPool(t, base, region.Config{Region: "region-b", FenceEpoch: 2})

	runID := seedRun(t, operator)

	// Arm the fence at epoch 1 with region a active.
	if _, err := operator.Exec(ctx, `INSERT INTO pal_region_fence (epoch, active_region) VALUES (1, 'region-a')`); err != nil {
		t.Fatalf("arm: %v", err)
	}
	ok, _, err := acquireRunLease(ctx, a, runID, zap.NewNop())
	if err != nil || !ok {
		t.Fatalf("region a lease: ok=%v err=%v", ok, err)
	}
	var epoch int64
	var lockRegion string
	if err := operator.QueryRow(ctx, `SELECT fence_epoch, region FROM run_locks WHERE run_id=$1`, runID).Scan(&epoch, &lockRegion); err != nil {
		t.Fatal(err)
	}
	if epoch != 1 || lockRegion != "region-a" {
		t.Fatalf("lease stamp: epoch=%d region=%q", epoch, lockRegion)
	}
	if err := journal(ctx, a, runID, 1); err != nil {
		t.Fatalf("region a journal at epoch 1: %v", err)
	}
	// Region b is not yet promoted: its epoch-2 writes are rejected too.
	requireFenced(t, "region b before promotion", journal(ctx, b, runID, 2))

	// --- Failover: promote region b. ---
	if _, err := operator.Exec(ctx, `UPDATE pal_region_fence SET epoch = 2, active_region = 'region-b', updated_at = now()`); err != nil {
		t.Fatalf("promote: %v", err)
	}

	// The stale primary keeps running and can still reach the database.
	_, err = a.Exec(ctx, `UPDATE run_locks SET expires_at = now() + interval '60 seconds' WHERE run_id=$1`, runID)
	requireFenced(t, "stale lease renewal", err)
	requireFenced(t, "stale journal append", journal(ctx, a, runID, 2))
	_, err = a.Exec(ctx, `UPDATE runs SET status='completed' WHERE id=$1`, runID)
	requireFenced(t, "stale run-state update", err)
	_, err = a.Exec(ctx, `DELETE FROM run_locks WHERE run_id=$1`, runID)
	requireFenced(t, "stale lease release", err)
	requireFenced(t, "session without epoch", journal(ctx, operator, runID, 2))

	// The new region does not wait out the stale lease's TTL.
	orphans, err := findOrphanedRuns(ctx, b)
	if err != nil {
		t.Fatalf("findOrphanedRuns: %v", err)
	}
	found := false
	for _, o := range orphans {
		found = found || o.runID == runID
	}
	if !found {
		t.Fatalf("stale-epoch lease not treated as orphaned")
	}
	ok, release, err := acquireRunLease(ctx, b, runID, zap.NewNop())
	if err != nil || !ok {
		t.Fatalf("region b steal of stale-epoch lease: ok=%v err=%v", ok, err)
	}
	if err := operator.QueryRow(ctx, `SELECT fence_epoch, region FROM run_locks WHERE run_id=$1`, runID).Scan(&epoch, &lockRegion); err != nil {
		t.Fatal(err)
	}
	if epoch != 2 {
		t.Fatalf("stolen lease epoch = %d, want 2", epoch)
	}
	if err := journal(ctx, b, runID, 2); err != nil {
		t.Fatalf("region b journal at epoch 2: %v", err)
	}
	if _, err := b.Exec(ctx, `UPDATE runs SET status='completed' WHERE id=$1`, runID); err != nil {
		t.Fatalf("region b run update: %v", err)
	}
	// A live current-epoch lease is NOT stealable by anyone.
	if stolen, err := acquireRecoveryLock(ctx, b, runID, "other-worker"); stolen || err != nil {
		t.Fatalf("live epoch-2 lease was stolen: stolen=%v err=%v", stolen, err)
	}
	release()
	var n int
	if err := operator.QueryRow(ctx, `SELECT count(*) FROM run_locks WHERE run_id=$1`, runID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("region b release: rows=%d err=%v", n, err)
	}
}
