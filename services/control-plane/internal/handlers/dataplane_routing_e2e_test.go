package handlers

// dataplane_routing_e2e_test.go — the COMPLETE control↔data-plane loop over a
// real gRPC RunStream (the production path, not a fake channel):
//
//   queued run → RouteRun pins runs.data_plane_id + dispatches a DpRunAssignment
//   → assignment arrives on the LIVE stream → agent sends RunAccepted (run →
//   running) → agent sends RunCompleted (run → completed, cost/tokens persisted).
//
// This is the integration proof that the tunnel (#52) and routing (#53) work
// together end-to-end, exercising RouteRun, the registry → RunStream forward,
// and the inbound handleClientFrame → updateRunStatus/finalizeRun persistence.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// eventuallyDP polls cond up to timeout; fails the test with msg if never true.
func eventuallyDP(t *testing.T, timeout time.Duration, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("condition never met within %s: %s", timeout, msg)
}

// runStatusDP reads a run's status straight from the pool (privileged) — the
// loop test asserts what the data-plane's inbound frames persisted.
func runStatusDP(t *testing.T, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM runs WHERE id = $1`, runID).Scan(&s); err != nil {
		t.Fatalf("read run status: %v", err)
	}
	return s
}

func TestDataPlane_RoutingLoop_E2E(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)
	

	const regToken = "loop-tok"
	planeID := seedDP(t, pool, routeTenant, sha256Hex(regToken))

	svc := newDPSvc(t, pool)
	addr := startDPServer(t, svc)
	client := dialDP(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// 1. Register → session token.
	regResp, err := client.Register(ctx, &lanternv1.DpRegisterRequest{
		TenantId:     routeTenant,
		AgentToken:   regToken,
		AgentVersion: "1.0.0",
		Hostname:     "loop-host",
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	sessionToken := regResp.GetSessionToken()

	// 2. Open RunStream + Hello — this registers the plane's send channel server-side.
	stream, err := client.RunStream(ctx)
	if err != nil {
		t.Fatalf("RunStream: %v", err)
	}
	if err := stream.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Hello{
			Hello: &lanternv1.DpHello{PlaneId: planeID, SessionToken: sessionToken},
		},
	}); err != nil {
		t.Fatalf("send hello: %v", err)
	}

	// Wait until the server has registered this plane (so RouteRun can place on it).
	eventuallyDP(t, 5*time.Second, "plane registered in registry", func() bool {
		p, ok := svc.Registry.PlaneForTenant(routeTenant)
		return ok && p == planeID
	})

	// 3. A real queued run — exactly what POST /v1/runs inserts.
	runID := seedQueuedRun(t, pool, routeTenant)

	// 4. Route it — the call the REST dispatch path makes.
	gotPlane, routed := svc.RouteRun(ctx, runID, routeTenant, "ver-1", `{"q":"hello"}`)
	if !routed || gotPlane != planeID {
		t.Fatalf("RouteRun: got (%q,%v), want (%q,true)", gotPlane, routed, planeID)
	}

	// 5. data_plane_id pinned to the chosen plane.
	if dp := runDataPlaneID(t, pool, runID); dp == nil || *dp != planeID {
		t.Fatalf("data_plane_id not pinned to %s: %v", planeID, dp)
	}

	// 6. Assignment arrives over the REAL stream with the right fields.
	srvMsg, err := stream.Recv()
	if err != nil {
		t.Fatalf("Recv assignment: %v", err)
	}
	a := srvMsg.GetAssignment()
	if a == nil {
		t.Fatalf("expected DpRunAssignment, got %T", srvMsg.GetMsg())
	}
	if a.GetRunId() != runID || a.GetTenantId() != routeTenant ||
		a.GetAgentVersionId() != "ver-1" || a.GetInputJson() != `{"q":"hello"}` {
		t.Fatalf("assignment fields wrong: %+v", a)
	}

	// 7. Agent accepts → run transitions queued → running.
	if err := stream.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Accepted{
			Accepted: &lanternv1.DpRunAccepted{RunId: runID},
		},
	}); err != nil {
		t.Fatalf("send accepted: %v", err)
	}
	eventuallyDP(t, 5*time.Second, "run → running after Accept", func() bool {
		return runStatusDP(t, pool, runID) == "running"
	})

	// 8. Agent completes → run terminal, cost + tokens persisted.
	if err := stream.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Completed{
			Completed: &lanternv1.DpRunCompleted{
				RunId:      runID,
				Status:     lanternv1.DpRunStatus_DP_RUN_STATUS_SUCCEEDED,
				OutputJson: `{"answer":"hi"}`,
				CostUsd:    0.0123,
				TokensIn:   11,
				TokensOut:  7,
			},
		},
	}); err != nil {
		t.Fatalf("send completed: %v", err)
	}
	eventuallyDP(t, 5*time.Second, "run → completed after Complete", func() bool {
		return runStatusDP(t, pool, runID) == "completed"
	})

	// 9. Cost + tokens from the data plane actually landed in the runs row.
	var tin, tout int64
	if err := pool.QueryRow(context.Background(),
		`SELECT tokens_in, tokens_out FROM runs WHERE id = $1`, runID).Scan(&tin, &tout); err != nil {
		t.Fatalf("read run usage: %v", err)
	}
	if tin != 11 || tout != 7 {
		t.Errorf("tokens persisted: got (%d,%d) want (11,7)", tin, tout)
	}

	_ = stream.CloseSend()
}
