package handlers

import (
	"context"
	"encoding/json"
	"fmt"
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
	res, err := s.Fork(ctx, "t", "vm-1", []ForkIdentity{{"a", "x"}, {"b", "y"}, {"c", "z"}})
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
		for _, body := range []string{`{"count":0}`, `{"count":101}`, `{"count":"x"}`, `not json`} {
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

// TestFork_ChildrenGetFreshIdentities: each fork child is minted its own agent
// identity; none inherits the source's instance id or token.
func TestFork_ChildrenGetFreshIdentities(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)
	tenant := uniqueTenantID("fork-id")
	seedTestTenant(t, pool, tenant)
	t.Cleanup(func() { cleanupTenant(t, pool, tenant) })

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenant, "00000000-0000-0000-0000-0000000000c1", "owner")
	src := "vm-fid-" + tenant[:8]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, node, state, spec, agent_instance_id, created_at)
		VALUES ($1, $2, 'node-a', 'running',
		        '{"env":{"LANTERN_AGENT_INSTANCE_ID":"inst-src","LANTERN_AGENT_INSTANCE_TOKEN":"[redacted]"}}', 'inst-src', now())
	`, src, tenant); err != nil {
		t.Fatal(err)
	}
	c1, c2 := "vm-fid-a-"+tenant[:8], "vm-fid-b-"+tenant[:8]
	sched.forkRes = ForkResult{SnapshotID: "snap-x", Forks: []ForkChildResult{{VMID: c1, State: "running"}, {VMID: c2, State: "running"}}}

	if w := doLifecycle(h, tok, "fork", src, `{"count":2}`); w.Code != http.StatusOK {
		t.Fatalf("fork: %d %s", w.Code, w.Body)
	}
	if strings.Contains(fmt.Sprint(sched.forkIdentities), "inst-src") {
		t.Fatal("source identity passed to the scheduler")
	}
	ids := sched.forkIdentities
	if len(ids) != 2 || ids[0].InstanceID == ids[1].InstanceID || ids[0].Token == ids[1].Token || ids[0].Token == "" {
		t.Fatalf("identities not distinct/fresh: %d minted", len(ids))
	}
	for i, vm := range []string{c1, c2} {
		var inst, envID string
		if err := pool.QueryRow(context.Background(),
			`SELECT agent_instance_id, spec->'env'->>'LANTERN_AGENT_INSTANCE_ID' FROM runtime_vms WHERE vm_id = $1`, vm,
		).Scan(&inst, &envID); err != nil {
			t.Fatal(err)
		}
		if inst == "inst-src" || inst != ids[i].InstanceID || envID != inst {
			t.Errorf("child %s: agent_instance_id %q, spec env id %q, want %q", vm, inst, envID, ids[i].InstanceID)
		}
	}
}

// TestFork_InsertFailureTerminatesChildren: if the children's runtime_vms rows
// cannot be written, the API must not return 200 with live, untracked children
// — every spawned child is terminated and no child row is left behind.
func TestFork_InsertFailureTerminatesChildren(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)
	tenant := uniqueTenantID("fork-fail")
	seedTestTenant(t, pool, tenant)
	t.Cleanup(func() { cleanupTenant(t, pool, tenant) })

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenant, "00000000-0000-0000-0000-0000000000c1", "owner")
	src := "vm-ff-" + tenant[:8]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, node, state, spec, created_at)
		VALUES ($1, $2, 'node-a', 'running', '{"env":{}}', now())
	`, src, tenant); err != nil {
		t.Fatal(err)
	}
	c1, c2 := "vm-ff-a-"+tenant[:8], "vm-ff-b-"+tenant[:8]
	// A NUL byte is rejected by Postgres text columns: the second insert fails.
	sched.forkRes = ForkResult{SnapshotID: "snap-x", Forks: []ForkChildResult{{VMID: c1, State: "running"}, {VMID: c2, State: "run\x00ning"}}}

	if w := doLifecycle(h, tok, "fork", src, `{"count":2}`); w.Code != http.StatusInternalServerError {
		t.Fatalf("fork with failing insert: %d %s, want 500", w.Code, w.Body)
	}
	calls := strings.Join(sched.calls, ",")
	for _, c := range []string{c1, c2} {
		if !strings.Contains(calls, "terminate:"+c) {
			t.Errorf("child %s not terminated; calls=%s", c, calls)
		}
	}
	var n int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM runtime_vms WHERE parent_vm_id = $1`, src).Scan(&n)
	if n != 0 {
		t.Errorf("%d child rows persisted after a failed fork, want 0 (all-or-nothing)", n)
	}
}

// TestMaxForkCount_env tests the env-configurable fork cap (no pool needed).
func TestMaxForkCount_env(t *testing.T) {
	t.Run("default", func(t *testing.T) {
		t.Setenv("LANTERN_MAX_FORK_COUNT", "")
		if got := maxForkCount(); got != maxForkCountDefault {
			t.Errorf("unset: got %d, want default %d", got, maxForkCountDefault)
		}
	})
	t.Run("custom value", func(t *testing.T) {
		t.Setenv("LANTERN_MAX_FORK_COUNT", "42")
		if got := maxForkCount(); got != 42 {
			t.Errorf("custom 42: got %d", got)
		}
	})
	t.Run("ceiling", func(t *testing.T) {
		t.Setenv("LANTERN_MAX_FORK_COUNT", "99999")
		if got := maxForkCount(); got != maxForkCountCeiling {
			t.Errorf("over ceiling: got %d, want %d", got, maxForkCountCeiling)
		}
	})
	t.Run("invalid defaults", func(t *testing.T) {
		t.Setenv("LANTERN_MAX_FORK_COUNT", "banana")
		if got := maxForkCount(); got != maxForkCountDefault {
			t.Errorf("invalid: got %d, want default %d", got, maxForkCountDefault)
		}
	})
}

// TestForkVM_CountValidation verifies 400 at 0, default-max+1, ceiling+1.
// Uses a no-DB handler (validation fires before the DB lookup).
func TestForkVM_CountValidation(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "00000000-0000-0000-0000-0000000000aa", "u1", "owner")
	// default cap + 1 → 400
	over := maxForkCount() + 1
	w := doLifecycle(h, tok, "fork", "vm-any", fmt.Sprintf(`{"count":%d}`, over))
	if w.Code != http.StatusBadRequest {
		t.Errorf("count=%d: got %d, want 400", over, w.Code)
	}
	// count=0 → 400
	if w := doLifecycle(h, tok, "fork", "vm-any", `{"count":0}`); w.Code != http.StatusBadRequest {
		t.Errorf("count=0: got %d, want 400", w.Code)
	}
}

// TestListVMs_IncludesForkLineage: list must surface snapshot_id/parent_vm_id
// exactly like GET /v1/runtime/vms/{id}.
func TestListVMs_IncludesForkLineage(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)
	tenant := uniqueTenantID("list-lin")
	seedTestTenant(t, pool, tenant)
	t.Cleanup(func() { cleanupTenant(t, pool, tenant) })
	child := "vm-ll-" + tenant[:8]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec, parent_vm_id, snapshot_id, created_at)
		VALUES ($1, $2, 'running', '{}', 'vm-parent', 'snap-1', now())
	`, child, tenant); err != nil {
		t.Fatal(err)
	}
	h := newTestRuntimeHandlerWithPool(t, pool, &recScheduler{})
	w := doListVMs(h, mintTestToken(t, tenant, "00000000-0000-0000-0000-0000000000c1", "owner"))
	var rows []vmRow
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil || len(rows) != 1 {
		t.Fatalf("list: %d %s (%v)", w.Code, w.Body, err)
	}
	if derefStr(rows[0].ParentVMID) != "vm-parent" || derefStr(rows[0].SnapshotID) != "snap-1" {
		t.Errorf("lineage missing from list: parent=%v snapshot=%v", rows[0].ParentVMID, rows[0].SnapshotID)
	}
}
