package handlers

// dataplane_routing_test.go — tests for the dispatch-path run router
// (DataPlaneService.RouteRun + PlaneRegistry.PlaneForTenant). Same package so we
// can drive the registry and the unexported helpers directly.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

const routeTenant = "00000000-0000-0000-0000-000000000001"

// seedQueuedRun creates the agent → agent_version → queued run FK chain and
// returns the run id. data_plane_id starts NULL.
func seedQueuedRun(t *testing.T, pool *pgxpool.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, 'route-agent', 'routing test agent')
		ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, tenantID).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}

	var avID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v1', '\xdeadbeef', 's3://bucket/key', '{}')
		ON CONFLICT (agent_id, version) DO UPDATE SET bundle_uri = EXCLUDED.bundle_uri
		RETURNING id
	`, agentID).Scan(&avID); err != nil {
		t.Fatalf("seed agent_version: %v", err)
	}

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'queued', 'manual', '{}')
		RETURNING id
	`, tenantID, agentID, avID).Scan(&runID); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID) })
	return runID
}

func runDataPlaneID(t *testing.T, pool *pgxpool.Pool, runID string) *string {
	t.Helper()
	var dp *string
	if err := pool.QueryRow(context.Background(),
		`SELECT data_plane_id FROM runs WHERE id = $1`, runID).Scan(&dp); err != nil {
		t.Fatalf("read data_plane_id: %v", err)
	}
	return dp
}

// TestRouteRun_NoPlaneConnected: with no plane registered, RouteRun declines and
// the run is left unpinned for inline execution.
func TestRouteRun_NoPlaneConnected(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)
	svc := newDPSvc(t, pool)
	runID := seedQueuedRun(t, pool, routeTenant)

	planeID, routed := svc.RouteRun(context.Background(), runID, routeTenant, "", `{}`)
	if routed || planeID != "" {
		t.Fatalf("expected no routing, got (%q, %v)", planeID, routed)
	}
	if dp := runDataPlaneID(t, pool, runID); dp != nil {
		t.Fatalf("data_plane_id should stay NULL, got %q", *dp)
	}
}

// TestRouteRun_PlaneConnected_PinsAndSends: a connected plane gets the assignment
// and the run is pinned to it.
func TestRouteRun_PlaneConnected_PinsAndSends(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)
	svc := newDPSvc(t, pool)
	runID := seedQueuedRun(t, pool, routeTenant)

	ch := make(chan *lanternv1.DpRunAssignment, 1)
	dereg := svc.Registry.register(routeTenant, "plane-A", ch)
	defer dereg()

	planeID, routed := svc.RouteRun(context.Background(), runID, routeTenant, "ver-1", `{"prompt":"hi"}`)
	if !routed || planeID != "plane-A" {
		t.Fatalf("expected routing to plane-A, got (%q, %v)", planeID, routed)
	}

	select {
	case a := <-ch:
		if a.GetRunId() != runID || a.GetTenantId() != routeTenant ||
			a.GetAgentVersionId() != "ver-1" || a.GetInputJson() != `{"prompt":"hi"}` {
			t.Fatalf("assignment fields wrong: %+v", a)
		}
	default:
		t.Fatal("expected an assignment on the plane channel")
	}

	dp := runDataPlaneID(t, pool, runID)
	if dp == nil || *dp != "plane-A" {
		t.Fatalf("data_plane_id should be plane-A, got %v", dp)
	}
}

// TestRouteRun_DeliveryFailure_RollsBackPin: when the plane is connected but the
// channel can't accept the assignment, the pin is rolled back so inline can run.
func TestRouteRun_DeliveryFailure_RollsBackPin(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)
	svc := newDPSvc(t, pool)
	runID := seedQueuedRun(t, pool, routeTenant)

	// Unbuffered channel with no reader → Send hits the default branch → false.
	ch := make(chan *lanternv1.DpRunAssignment)
	dereg := svc.Registry.register(routeTenant, "plane-B", ch)
	defer dereg()

	planeID, routed := svc.RouteRun(context.Background(), runID, routeTenant, "ver-1", `{}`)
	if routed || planeID != "" {
		t.Fatalf("expected delivery failure → no routing, got (%q, %v)", planeID, routed)
	}
	if dp := runDataPlaneID(t, pool, runID); dp != nil {
		t.Fatalf("data_plane_id should be rolled back to NULL, got %q", *dp)
	}
}

// TestRouteRun_NonQueuedRun_NotHijacked: a run already past 'queued' is never
// pinned or dispatched (guards against double-execution on a re-dispatch).
func TestRouteRun_NonQueuedRun_NotHijacked(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)
	svc := newDPSvc(t, pool)
	runID := seedQueuedRun(t, pool, routeTenant)
	if _, err := pool.Exec(context.Background(),
		`UPDATE runs SET status = 'running' WHERE id = $1`, runID); err != nil {
		t.Fatalf("set running: %v", err)
	}

	ch := make(chan *lanternv1.DpRunAssignment, 1)
	dereg := svc.Registry.register(routeTenant, "plane-A", ch)
	defer dereg()

	planeID, routed := svc.RouteRun(context.Background(), runID, routeTenant, "ver-1", `{}`)
	if routed || planeID != "" {
		t.Fatalf("expected no routing for a running run, got (%q, %v)", planeID, routed)
	}
	if len(ch) != 0 {
		t.Fatal("no assignment should have been sent for a non-queued run")
	}
	if dp := runDataPlaneID(t, pool, runID); dp != nil {
		t.Fatalf("data_plane_id should stay NULL, got %q", *dp)
	}
}

// TestPlaneForTenant_DeterministicAndScoped: selection is tenant-scoped and
// deterministic (smallest planeID).
func TestPlaneForTenant_DeterministicAndScoped(t *testing.T) {
	r := newPlaneRegistry()
	ch := make(chan *lanternv1.DpRunAssignment, 1)
	defer r.register("t-1", "plane-z", ch)()
	defer r.register("t-1", "plane-a", ch)()
	defer r.register("t-2", "plane-other", ch)()

	got, ok := r.PlaneForTenant("t-1")
	if !ok || got != "plane-a" {
		t.Fatalf("PlaneForTenant(t-1): got (%q,%v), want (plane-a,true)", got, ok)
	}
	if _, ok := r.PlaneForTenant("t-3"); ok {
		t.Fatal("PlaneForTenant(t-3): expected no plane")
	}
}
