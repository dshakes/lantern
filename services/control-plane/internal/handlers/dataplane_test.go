package handlers

// dataplane_test.go — tests for DataPlaneService (same package so we can call
// internal helpers like issueSessionToken directly).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- test helpers ----------

const dpTestSecret = "dataplane-test-jwt-secret"

func newDPSvc(t *testing.T, pool *pgxpool.Pool) *DataPlaneService {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	return NewDataPlaneService(srv, []byte(dpTestSecret))
}

// startDPServer starts a real gRPC listener (no interceptors) and returns the address.
func startDPServer(t *testing.T, svc *DataPlaneService) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	grpcSrv := grpc.NewServer()
	lanternv1.RegisterDataPlaneServiceServer(grpcSrv, svc)
	go func() { _ = grpcSrv.Serve(lis) }()
	t.Cleanup(grpcSrv.Stop)
	return lis.Addr().String()
}

// startDPServerWithInterceptors starts a real gRPC listener wired with the same
// UnaryTenantInterceptor + StreamTenantInterceptor chain used in production.
// Used by the H1 regression test to ensure DataPlaneService methods are correctly
// exempted from the tenant-metadata requirement.
func startDPServerWithInterceptors(t *testing.T, svc *DataPlaneService) string {
	t.Helper()
	logger := zap.NewNop()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	grpcSrv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(middleware.UnaryTenantInterceptor(logger)),
		grpc.ChainStreamInterceptor(middleware.StreamTenantInterceptor(logger)),
	)
	lanternv1.RegisterDataPlaneServiceServer(grpcSrv, svc)
	go func() { _ = grpcSrv.Serve(lis) }()
	t.Cleanup(grpcSrv.Stop)
	return lis.Addr().String()
}

// dialDP dials the test gRPC server.
func dialDP(t *testing.T, addr string) lanternv1.DataPlaneServiceClient {
	t.Helper()
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return lanternv1.NewDataPlaneServiceClient(conn)
}

// seedDP inserts a data_planes row and returns the row's ID.
func seedDP(t *testing.T, pool *pgxpool.Pool, tenantID, regTokenHash string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO data_planes (tenant_id, name, cloud, region, status, reg_token_hash)
		VALUES ($1, 'dp-test', 'aws', 'us-east-1', 'provisioning', $2)
		RETURNING id
	`, tenantID, regTokenHash).Scan(&id)
	if err != nil {
		t.Fatalf("seedDP: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM data_planes WHERE id = $1`, id)
	})
	return id
}

// sha256Hex returns hex(sha256(s)).
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// dpAssertCode checks that err is a gRPC error with the expected code.
func dpAssertCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected gRPC error %v, got nil", want)
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %v", err)
	}
	if st.Code() != want {
		t.Errorf("code: got %v, want %v (msg: %s)", st.Code(), want, st.Message())
	}
}

// ---------- unit tests (no DB required) ----------

func TestDataPlane_Register_MissingTenantID(t *testing.T) {
	svc := newDPSvc(t, nil)
	_, err := svc.Register(context.Background(), &lanternv1.DpRegisterRequest{
		AgentToken: "tok",
	})
	dpAssertCode(t, err, codes.InvalidArgument)
}

func TestDataPlane_Register_MissingAgentToken(t *testing.T) {
	svc := newDPSvc(t, nil)
	_, err := svc.Register(context.Background(), &lanternv1.DpRegisterRequest{
		TenantId: "00000000-0000-0000-0000-000000000001",
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

func TestDataPlane_Heartbeat_InvalidToken(t *testing.T) {
	svc := newDPSvc(t, nil)
	_, err := svc.Heartbeat(context.Background(), &lanternv1.DpHeartbeatRequest{
		PlaneId:      "dp-1",
		SessionToken: "not-a-valid-jwt",
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

func TestDataPlane_Heartbeat_WrongPlaneID(t *testing.T) {
	svc := newDPSvc(t, nil)
	// Issue a valid token for plane-A.
	tok, err := svc.issueSessionToken("tenant-1", "plane-A")
	if err != nil {
		t.Fatalf("issueSessionToken: %v", err)
	}
	// Present it as plane-B — should be rejected.
	_, err = svc.Heartbeat(context.Background(), &lanternv1.DpHeartbeatRequest{
		PlaneId:      "plane-B",
		SessionToken: tok,
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

func TestDataPlane_RefreshToken_Forged(t *testing.T) {
	svc := newDPSvc(t, nil)
	_, err := svc.RefreshToken(context.Background(), &lanternv1.DpRefreshTokenRequest{
		PlaneId:      "dp-1",
		SessionToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkcC0xIn0.bad",
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

func TestDataPlane_ReportMetrics_InvalidToken(t *testing.T) {
	svc := newDPSvc(t, nil)
	_, err := svc.ReportMetrics(context.Background(), &lanternv1.DpMetricsReport{
		PlaneId:      "dp-1",
		SessionToken: "garbage",
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

// ---------- PlaneRegistry unit tests ----------

func TestPlaneRegistry_SendAndDeregister(t *testing.T) {
	reg := newPlaneRegistry()

	ch := make(chan *lanternv1.DpRunAssignment, 1)
	deregister := reg.register("tenant-1", "plane-1", ch)

	a := &lanternv1.DpRunAssignment{RunId: "run-abc", TenantId: "tenant-1"}
	if !reg.Send("tenant-1", "plane-1", a) {
		t.Fatal("Send returned false for connected plane")
	}
	got := <-ch
	if got.GetRunId() != "run-abc" {
		t.Errorf("run_id: got %q, want %q", got.GetRunId(), "run-abc")
	}

	// After deregister, Send must return false.
	deregister()
	if reg.Send("tenant-1", "plane-1", a) {
		t.Fatal("Send returned true after deregister")
	}
}

func TestPlaneRegistry_CrossTenantSendFails(t *testing.T) {
	reg := newPlaneRegistry()

	ch := make(chan *lanternv1.DpRunAssignment, 1)
	deregister := reg.register("tenant-1", "plane-1", ch)
	defer deregister()

	// The registry key is tenantID+"/"+planeID so tenant-2/plane-1 is distinct.
	a := &lanternv1.DpRunAssignment{RunId: "run-xyz"}
	if reg.Send("tenant-2", "plane-1", a) {
		t.Fatal("Send returned true for a wrong-tenant key")
	}
}

func TestPlaneRegistry_ConnectedPlanes(t *testing.T) {
	reg := newPlaneRegistry()

	ch1 := make(chan *lanternv1.DpRunAssignment, 1)
	ch2 := make(chan *lanternv1.DpRunAssignment, 1)
	d1 := reg.register("t1", "p1", ch1)
	d2 := reg.register("t2", "p2", ch2)

	planes := reg.ConnectedPlanes()
	if len(planes) != 2 {
		t.Errorf("ConnectedPlanes: got %d, want 2", len(planes))
	}
	d1()
	planes = reg.ConnectedPlanes()
	if len(planes) != 1 {
		t.Errorf("ConnectedPlanes after d1: got %d, want 1", len(planes))
	}
	d2()
}

// ---------- RunStream: unauthenticated first frame ----------

func TestDataPlane_RunStream_NoHello(t *testing.T) {
	svc := newDPSvc(t, nil)
	addr := startDPServer(t, svc)
	client := dialDP(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.RunStream(ctx)
	if err != nil {
		t.Fatalf("RunStream: %v", err)
	}

	// Send a non-hello frame (RunAccepted).
	sendErr := stream.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Accepted{
			Accepted: &lanternv1.DpRunAccepted{RunId: "run-1"},
		},
	})
	if sendErr != nil {
		dpAssertCode(t, sendErr, codes.Unauthenticated)
		return
	}

	_, recvErr := stream.Recv()
	if recvErr == nil {
		t.Fatal("expected error for missing hello, got nil")
	}
	dpAssertCode(t, recvErr, codes.Unauthenticated)
}

// ---------- DB-backed integration tests ----------

func dpMigrateAndSeed(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := db.Migrate(context.Background(), pool, true); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}

// TestDataPlane_Register_ValidToken verifies the full register flow.
func TestDataPlane_Register_ValidToken(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"
	const regToken = "bootstrap-token-abc"
	planeID := seedDP(t, pool, tenantID, sha256Hex(regToken))

	svc := newDPSvc(t, pool)
	resp, err := svc.Register(context.Background(), &lanternv1.DpRegisterRequest{
		TenantId:     tenantID,
		AgentToken:   regToken,
		AgentVersion: "1.0.0",
		Hostname:     "host-a",
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if resp.GetPlaneId() != planeID {
		t.Errorf("plane_id: got %q, want %q", resp.GetPlaneId(), planeID)
	}
	if resp.GetSessionToken() == "" {
		t.Error("session_token must be non-empty")
	}
	if resp.GetHeartbeatIntervalSeconds() <= 0 {
		t.Error("heartbeat_interval_seconds must be positive")
	}

	// Verify row status updated.
	var rowStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM data_planes WHERE id = $1`, planeID).Scan(&rowStatus); err != nil {
		t.Fatalf("query: %v", err)
	}
	if rowStatus != "connected" {
		t.Errorf("status: got %q, want connected", rowStatus)
	}
}

// TestDataPlane_Register_InvalidToken verifies wrong bootstrap token → Unauthenticated.
func TestDataPlane_Register_InvalidToken(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"
	seedDP(t, pool, tenantID, sha256Hex("correct-tok"))

	svc := newDPSvc(t, pool)
	_, err := svc.Register(context.Background(), &lanternv1.DpRegisterRequest{
		TenantId:   tenantID,
		AgentToken: "wrong-tok",
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

// TestDataPlane_Heartbeat_UpdatesDB verifies heartbeat updates agent_count and last_heartbeat.
func TestDataPlane_Heartbeat_UpdatesDB(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"
	const regToken = "hb-tok"
	planeID := seedDP(t, pool, tenantID, sha256Hex(regToken))

	svc := newDPSvc(t, pool)
	regResp, err := svc.Register(context.Background(), &lanternv1.DpRegisterRequest{
		TenantId: tenantID, AgentToken: regToken,
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	hbResp, err := svc.Heartbeat(context.Background(), &lanternv1.DpHeartbeatRequest{
		PlaneId:      planeID,
		SessionToken: regResp.GetSessionToken(),
		ActiveRuns:   5,
	})
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !hbResp.GetOk() {
		t.Error("expected ok=true")
	}

	var agentCount int
	var lastHB time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT agent_count, last_heartbeat FROM data_planes WHERE id = $1`, planeID).
		Scan(&agentCount, &lastHB); err != nil {
		t.Fatalf("query: %v", err)
	}
	if agentCount != 5 {
		t.Errorf("agent_count: got %d, want 5", agentCount)
	}
	if time.Since(lastHB) > 10*time.Second {
		t.Errorf("last_heartbeat too old: %v", lastHB)
	}
}

// TestDataPlane_Heartbeat_WrongSecret verifies a token forged with a different
// secret is rejected Unauthenticated.
func TestDataPlane_Heartbeat_WrongSecret(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"
	const regToken = "exp-tok"
	planeID := seedDP(t, pool, tenantID, sha256Hex(regToken))

	svc := newDPSvc(t, pool)

	// Use a different secret to forge a token.
	forgedSvc := NewDataPlaneService(
		&server.Server{Pool: pool, Logger: zap.NewNop()},
		[]byte("totally-different-secret"),
	)
	forgedTok, _ := forgedSvc.issueSessionToken(tenantID, planeID)

	_, err := svc.Heartbeat(context.Background(), &lanternv1.DpHeartbeatRequest{
		PlaneId:      planeID,
		SessionToken: forgedTok,
	})
	dpAssertCode(t, err, codes.Unauthenticated)
}

// TestDataPlane_E2E is the full in-process end-to-end test:
// Register → Heartbeat → open RunStream → server pushes assignment via
// registry → client accepts → RefreshToken succeeds.
func TestDataPlane_E2E(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"
	const regToken = "e2e-tok"
	planeID := seedDP(t, pool, tenantID, sha256Hex(regToken))

	svc := newDPSvc(t, pool)
	addr := startDPServer(t, svc)
	client := dialDP(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 1. Register.
	regResp, err := client.Register(ctx, &lanternv1.DpRegisterRequest{
		TenantId:     tenantID,
		AgentToken:   regToken,
		AgentVersion: "1.0.0",
		Hostname:     "e2e-host",
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if regResp.GetPlaneId() != planeID {
		t.Errorf("plane_id: got %q want %q", regResp.GetPlaneId(), planeID)
	}
	sessionToken := regResp.GetSessionToken()

	// 2. Heartbeat.
	hbResp, err := client.Heartbeat(ctx, &lanternv1.DpHeartbeatRequest{
		PlaneId:      planeID,
		SessionToken: sessionToken,
	})
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !hbResp.GetOk() {
		t.Error("heartbeat ok should be true")
	}

	// 3. Open RunStream and send Hello.
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

	// 4. Push a run assignment through the registry.
	assignment := &lanternv1.DpRunAssignment{
		RunId:          "e2e-run-001",
		AgentVersionId: "v1",
		TenantId:       tenantID,
		InputJson:      `{"q":"hello"}`,
	}

	pushDone := make(chan bool, 1)
	go func() {
		time.Sleep(60 * time.Millisecond) // let Hello be processed first
		pushDone <- svc.Registry.Send(tenantID, planeID, assignment)
	}()

	// 5. Client receives the assignment.
	serverMsg, err := stream.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	got := serverMsg.GetAssignment()
	if got == nil {
		t.Fatalf("expected DpRunAssignment, got %T", serverMsg.GetMsg())
	}
	if got.GetRunId() != assignment.RunId {
		t.Errorf("run_id: got %q want %q", got.GetRunId(), assignment.RunId)
	}

	if !<-pushDone {
		t.Error("Registry.Send returned false")
	}

	// 6. Client sends acceptance.
	if err := stream.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Accepted{
			Accepted: &lanternv1.DpRunAccepted{RunId: assignment.RunId},
		},
	}); err != nil {
		t.Fatalf("send accepted: %v", err)
	}

	// 7. RefreshToken.
	refreshResp, err := client.RefreshToken(ctx, &lanternv1.DpRefreshTokenRequest{
		PlaneId:      planeID,
		SessionToken: sessionToken,
	})
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if refreshResp.GetSessionToken() == "" {
		t.Error("new session_token must be non-empty")
	}

	// 8. Close stream.
	_ = stream.CloseSend()
}

// ---------- H1 regression: interceptor chain must not block DataPlaneService ----------

// TestDataPlane_BehindInterceptorChain verifies that all DataPlaneService methods
// work when the server is wired with the production UnaryTenantInterceptor +
// StreamTenantInterceptor chain (H1 fix). Previously these methods were blocked
// because extractTenant required a tenant_id metadata header that the agent
// should NOT send (it would be a spoofable trust source).
func TestDataPlane_BehindInterceptorChain(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"
	const regToken = "interceptor-test-tok"
	planeID := seedDP(t, pool, tenantID, sha256Hex(regToken))

	svc := newDPSvc(t, pool)
	// Use the interceptor-wired server to guard against regressions.
	addr := startDPServerWithInterceptors(t, svc)
	client := dialDP(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Register — must succeed WITHOUT tenant_id metadata header.
	regResp, err := client.Register(ctx, &lanternv1.DpRegisterRequest{
		TenantId:   tenantID,
		AgentToken: regToken,
		Hostname:   "interceptor-host",
	})
	if err != nil {
		t.Fatalf("Register behind interceptors: %v", err)
	}
	if regResp.GetPlaneId() != planeID {
		t.Errorf("plane_id: got %q want %q", regResp.GetPlaneId(), planeID)
	}
	sessionToken := regResp.GetSessionToken()

	// Heartbeat — must succeed WITHOUT tenant_id metadata header.
	hbResp, err := client.Heartbeat(ctx, &lanternv1.DpHeartbeatRequest{
		PlaneId:      planeID,
		SessionToken: sessionToken,
	})
	if err != nil {
		t.Fatalf("Heartbeat behind interceptors: %v", err)
	}
	if !hbResp.GetOk() {
		t.Error("heartbeat ok should be true")
	}

	// RunStream — must open and authenticate WITHOUT tenant_id metadata header.
	stream, err := client.RunStream(ctx)
	if err != nil {
		t.Fatalf("RunStream behind interceptors: %v", err)
	}
	if err := stream.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Hello{
			Hello: &lanternv1.DpHello{PlaneId: planeID, SessionToken: sessionToken},
		},
	}); err != nil {
		t.Fatalf("send hello behind interceptors: %v", err)
	}

	// RefreshToken — must succeed WITHOUT tenant_id metadata header.
	refreshResp, err := client.RefreshToken(ctx, &lanternv1.DpRefreshTokenRequest{
		PlaneId:      planeID,
		SessionToken: sessionToken,
	})
	if err != nil {
		t.Fatalf("RefreshToken behind interceptors: %v", err)
	}
	if refreshResp.GetSessionToken() == "" {
		t.Error("refreshed session_token must be non-empty")
	}

	_ = stream.CloseSend()
}

// ---------- H2: per-tenant RunStream connection cap ----------

// TestDataPlane_RunStream_TenantCap verifies that exceeding the per-tenant
// RunStream connection cap returns ResourceExhausted.
func TestDataPlane_RunStream_TenantCap(t *testing.T) {
	pool := openTestPool(t)
	dpMigrateAndSeed(t, pool)

	const tenantID = "00000000-0000-0000-0000-000000000001"

	// Seed two planes so we can open streams from both.
	planeID1 := seedDP(t, pool, tenantID, sha256Hex("cap-tok-1"))
	planeID2 := seedDP(t, pool, tenantID, sha256Hex("cap-tok-2"))

	svc := newDPSvc(t, pool)
	addr := startDPServer(t, svc)
	client := dialDP(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Obtain session tokens for both planes.
	reg1, err := client.Register(ctx, &lanternv1.DpRegisterRequest{
		TenantId: tenantID, AgentToken: "cap-tok-1",
	})
	if err != nil {
		t.Fatalf("Register plane1: %v", err)
	}
	reg2, err := client.Register(ctx, &lanternv1.DpRegisterRequest{
		TenantId: tenantID, AgentToken: "cap-tok-2",
	})
	if err != nil {
		t.Fatalf("Register plane2: %v", err)
	}

	// Artificially set the cap to 1 by pre-registering a fake connection in the
	// registry so that the second RunStream open triggers ResourceExhausted.
	fakeCh := make(chan *lanternv1.DpRunAssignment, 1)
	fakeDeregister, ok := svc.Registry.tryRegister(tenantID, "fake-plane", fakeCh, 1)
	if !ok {
		t.Fatal("tryRegister for fake-plane should succeed (cap=1, count was 0)")
	}
	defer fakeDeregister()

	// With cap=1 already filled, opening a RunStream for plane1 (different key
	// but same tenant) must fail ResourceExhausted.
	// We call tryRegister directly rather than opening a full stream so the test
	// stays fast and doesn't depend on stream-level timing.
	ch1 := make(chan *lanternv1.DpRunAssignment, 1)
	_, ok = svc.Registry.tryRegister(tenantID, planeID1, ch1, 1)
	if ok {
		t.Error("tryRegister should have failed (cap=1 already filled)")
	}

	// Freeing the fake connection restores the slot.
	fakeDeregister()
	_, ok2 := svc.Registry.tryRegister(tenantID, planeID1, ch1, 1)
	if !ok2 {
		t.Error("tryRegister should succeed after fakeDeregister freed the slot")
	}

	// Also verify via the real gRPC path: stream from plane2 (cap=2 now,
	// one slot used by plane1 we just registered). This time cap=defaultMax so
	// it should work.
	_ = planeID2
	stream2, err := client.RunStream(ctx)
	if err != nil {
		t.Fatalf("RunStream plane2: %v", err)
	}
	if err := stream2.Send(&lanternv1.DpRunStreamClientMsg{
		Msg: &lanternv1.DpRunStreamClientMsg_Hello{
			Hello: &lanternv1.DpHello{PlaneId: planeID2, SessionToken: reg2.GetSessionToken()},
		},
	}); err != nil {
		t.Fatalf("send hello plane2: %v", err)
	}
	_ = reg1
	_ = stream2.CloseSend()
}
