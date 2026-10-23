package handlers

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// doLifecycle fires POST /v1/runtime/vms/{id}/{op} at the matching handler.
func doLifecycle(h *RuntimeHandler, tok, op, vmID, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/vms/"+vmID+"/"+op, strings.NewReader(body))
	req.SetPathValue("id", vmID)
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	map[string]http.HandlerFunc{"pause": h.PauseVM, "resume": h.ResumeVM, "fork": h.ForkVM}[op](w, req)
	return w
}

// Pre-DB paths: no pool needed.
func TestLifecycle_AuthAndScope(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	for _, op := range []string{"pause", "resume", "fork"} {
		if w := doLifecycle(h, "", op, "vm-1", ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without token: %d, want 401", op, w.Code)
		}
		// member role is read-only on the runtime.
		tok := mintTestToken(t, "00000000-0000-0000-0000-0000000000aa", "u1", "member")
		h.srv.Pool = nil
		if w := doLifecycle(h, tok, op, "vm-1", ""); w.Code != http.StatusForbidden {
			t.Errorf("%s as member: %d, want 403", op, w.Code)
		}
	}
}

func TestStubScheduler_Lifecycle(t *testing.T) {
	s := &stubSchedulerClient{logger: zap.NewNop()}
	ctx := context.Background()
	if _, err := s.Resume(ctx, "t", "vm-1"); status.Code(err) != grpccodes.FailedPrecondition {
		t.Fatalf("resume of a running stub vm: %v, want FailedPrecondition", err)
	}
	snap1, _ := s.Pause(ctx, "t", "vm-1")
	snap2, _ := s.Pause(ctx, "t", "vm-1")
	if snap1 == "" || snap1 != snap2 {
		t.Fatalf("pause must be idempotent: %q vs %q", snap1, snap2)
	}
	res, err := s.Fork(ctx, "t", "vm-1", 3)
	if err != nil || len(res.Forks) != 3 || res.SnapshotID != snap1 {
		t.Fatalf("fork of paused stub vm = %+v, %v", res, err)
	}
	if snap, err := s.Resume(ctx, "t", "vm-1"); err != nil || snap != snap1 {
		t.Fatalf("resume = %q, %v", snap, err)
	}
}

func TestWriteLifecycleErr_Mapping(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	cases := []struct {
		code grpccodes.Code
		want int
	}{
		{grpccodes.NotFound, 404},
		{grpccodes.PermissionDenied, 404},
		{grpccodes.FailedPrecondition, 409},
		{grpccodes.ResourceExhausted, 402},
		{grpccodes.InvalidArgument, 400},
		{grpccodes.Unavailable, 502},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		h.writeLifecycleErr(w, "Pause", "vm-1", status.Error(tc.code, "x"))
		if w.Code != tc.want {
			t.Errorf("%v → %d, want %d", tc.code, w.Code, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// DB-backed
// ---------------------------------------------------------------------------

func seedLifecycleVM(t *testing.T, h *RuntimeHandler, tenantID, vmID, state string) {
	t.Helper()
	if _, err := h.srv.Pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, node, isolation_class, state, spec, created_at)
		VALUES ($1, $2, 'node-a', 'standard', $3, '{"image_digest":"sha256:x"}', now())
	`, vmID, tenantID, state); err != nil {
		t.Fatalf("seed vm: %v", err)
	}
}

func vmShadow(t *testing.T, h *RuntimeHandler, vmID string) (state string, snap, parent *string) {
	t.Helper()
	if err := h.srv.Pool.QueryRow(context.Background(),
		`SELECT state, snapshot_id, parent_vm_id FROM runtime_vms WHERE vm_id = $1`, vmID,
	).Scan(&state, &snap, &parent); err != nil {
		t.Fatalf("read vm %s: %v", vmID, err)
	}
	return state, snap, parent
}

func TestLifecycle_DB(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)
	tenant := uniqueTenantID("lc")
	other := uniqueTenantID("lc-other")
	seedTestTenant(t, pool, tenant)
	seedTestTenant(t, pool, other)
	t.Cleanup(func() { cleanupTenant(t, pool, tenant); cleanupTenant(t, pool, other) })

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenant, "00000000-0000-0000-0000-0000000000b1", "owner")
	otherTok := mintTestToken(t, other, "00000000-0000-0000-0000-0000000000b2", "owner")
	vm := "vm-lc-" + tenant[:8]
	seedLifecycleVM(t, h, tenant, vm, "running")

	t.Run("other tenant gets 404 and the scheduler is never called", func(t *testing.T) {
		for _, op := range []string{"pause", "resume", "fork"} {
			if w := doLifecycle(h, otherTok, op, vm, ""); w.Code != http.StatusNotFound {
				t.Errorf("%s cross-tenant: %d, want 404", op, w.Code)
			}
		}
		if len(sched.calls) != 0 {
			t.Errorf("scheduler called for cross-tenant request: %v", sched.calls)
		}
	})

	t.Run("pause", func(t *testing.T) {
		w := doLifecycle(h, tok, "pause", vm, "")
		if w.Code != http.StatusOK {
			t.Fatalf("pause: %d %s", w.Code, w.Body)
		}
		var resp map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["state"] != "paused" || resp["snapshotId"] != "snap-"+vm || resp["vmId"] != vm {
			t.Errorf("pause resp = %v", resp)
		}
		if sched.lastTenant != tenant {
			t.Errorf("scheduler got tenant %q, want the JWT tenant", sched.lastTenant)
		}
		if st, snap, _ := vmShadow(t, h, vm); st != "paused" || snap == nil || *snap != "snap-"+vm {
			t.Errorf("shadow row = %s / %v", st, snap)
		}
	})

	t.Run("GET returns snapshotId", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms/"+vm, nil)
		req.SetPathValue("id", vm)
		req.Header.Set("Authorization", bearerHeader(tok))
		w := httptest.NewRecorder()
		h.GetVM(w, req)
		if !strings.Contains(w.Body.String(), `"snapshotId":"snap-`+vm+`"`) {
			t.Errorf("GET body missing snapshotId: %s", w.Body)
		}
	})

	t.Run("resume wrong state → 409", func(t *testing.T) {
		sched.lifecycleErr = status.Error(grpccodes.FailedPrecondition, "vm is RUNNING")
		defer func() { sched.lifecycleErr = nil }()
		if w := doLifecycle(h, tok, "resume", vm, ""); w.Code != http.StatusConflict {
			t.Errorf("resume: %d, want 409", w.Code)
		}
	})

	t.Run("resume", func(t *testing.T) {
		w := doLifecycle(h, tok, "resume", vm, "")
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"running"`) {
			t.Fatalf("resume: %d %s", w.Code, w.Body)
		}
		if st, _, _ := vmShadow(t, h, vm); st != "running" {
			t.Errorf("shadow state = %s", st)
		}
	})

	t.Run("fork validates count", func(t *testing.T) {
		for _, body := range []string{`{"count":0}`, `{"count":11}`, `{"count":"x"}`, `not json`} {
			if w := doLifecycle(h, tok, "fork", vm, body); w.Code != http.StatusBadRequest {
				t.Errorf("fork %s: %d, want 400", body, w.Code)
			}
		}
	})

	t.Run("fork inserts child rows incl. failed child", func(t *testing.T) {
		sched.forkRes = ForkResult{SnapshotID: "snap-f", Forks: []ForkChildResult{
			{VMID: "vm-child-ok-" + tenant[:8], State: "running"},
			{VMID: "vm-child-bad-" + tenant[:8], State: "failed", Error: "boot failed"},
		}}
		w := doLifecycle(h, tok, "fork", vm, `{"count":2}`)
		if w.Code != http.StatusOK {
			t.Fatalf("fork: %d %s", w.Code, w.Body)
		}
		var resp struct {
			SourceVMID string            `json:"sourceVmId"`
			SnapshotID string            `json:"snapshotId"`
			Forks      []ForkChildResult `json:"forks"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if resp.SourceVMID != vm || resp.SnapshotID != "snap-f" || len(resp.Forks) != 2 || resp.Forks[1].Error == "" {
			t.Errorf("fork resp = %+v", resp)
		}
		st, snap, parent := vmShadow(t, h, "vm-child-ok-"+tenant[:8])
		if st != "running" || snap == nil || *snap != "snap-f" || parent == nil || *parent != vm {
			t.Errorf("child row = %s / %v / %v", st, snap, parent)
		}
		if st, _, _ := vmShadow(t, h, "vm-child-bad-"+tenant[:8]); st != "failed" {
			t.Errorf("failed child state = %s", st)
		}
	})

	t.Run("fork default count is 1", func(t *testing.T) {
		sched.forkRes = ForkResult{}
		if w := doLifecycle(h, tok, "fork", vm, ""); w.Code != http.StatusOK {
			t.Fatalf("fork: %d %s", w.Code, w.Body)
		}
		if last := sched.calls[len(sched.calls)-1]; last != "fork:"+vm+":1" {
			t.Errorf("last call = %s", last)
		}
	})

	t.Run("fork over runtime quota → 402, scheduler not called", func(t *testing.T) {
		// 2 live (source + ok child) with max 3: forking 2 would make 4.
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO runtime_quotas (tenant_id, max_concurrent_vms, hard_fail) VALUES ($1, 3, true)
			 ON CONFLICT (tenant_id) DO UPDATE SET max_concurrent_vms = 3, hard_fail = true`, tenant); err != nil {
			t.Fatal(err)
		}
		n := len(sched.calls)
		if w := doLifecycle(h, tok, "fork", vm, `{"count":2}`); w.Code != http.StatusPaymentRequired {
			t.Errorf("fork over quota: %d, want 402", w.Code)
		}
		if len(sched.calls) != n {
			t.Errorf("scheduler called despite quota denial")
		}
	})

	t.Run("terminated vm → 409", func(t *testing.T) {
		dead := "vm-dead-" + tenant[:8]
		seedLifecycleVM(t, h, tenant, dead, "terminated")
		if w := doLifecycle(h, tok, "pause", dead, ""); w.Code != http.StatusConflict {
			t.Errorf("pause terminated: %d, want 409", w.Code)
		}
	})
}

func TestManagerTransportCreds_ProdVsDev(t *testing.T) {
	t.Setenv("LANTERN_RUNTIME_MANAGER_TLS_CA", "")
	t.Setenv("LANTERN_RUNTIME_MANAGER_TLS_CERT", "")
	t.Setenv("LANTERN_RUNTIME_MANAGER_TLS_KEY", "")
	if c, err := ManagerTransportCreds(false); err != nil || c.Info().SecurityProtocol != "insecure" {
		t.Errorf("dev unset = %v, %v; want insecure", c, err)
	}
	if _, err := ManagerTransportCreds(true); err == nil {
		t.Error("prod unset must fail loudly")
	}
	t.Setenv("LANTERN_RUNTIME_MANAGER_TLS_CERT", "/x.pem")
	if _, err := ManagerTransportCreds(false); err == nil {
		t.Error("half-configured cert/key must fail")
	}
}

// TestManagerClient_SendsServiceToken: the manager rejects calls without
// x-lantern-service-token once LANTERN_GRPC_SERVICE_TOKEN is set.
func TestManagerClient_SendsServiceToken(t *testing.T) {
	got := make(chan string, 1)
	srv := grpc.NewServer(grpc.UnaryInterceptor(func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, hd grpc.UnaryHandler) (any, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		v := md.Get("x-lantern-service-token")
		if len(v) == 0 {
			v = []string{""}
		}
		got <- v[0]
		return hd(ctx, req)
	}))
	lanternv1.RegisterRuntimeManagerServer(srv, lanternv1.UnimplementedRuntimeManagerServer{})
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	t.Setenv("LANTERN_DEFAULT_MANAGER_ADDR", lis.Addr().String())
	c, err := NewGRPCSchedulerClient("127.0.0.1:1", "s3cret", zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := c.managerClient("")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = mgr.Stop(context.Background(), &lanternv1.StopRequest{VmId: "vm-1"})
	if v := <-got; v != "s3cret" {
		t.Errorf("manager saw token %q, want s3cret", v)
	}
}
