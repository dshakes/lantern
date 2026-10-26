package handlers_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/handlers"
)

// lifecycleDialer records manager calls and fails on demand.
type lifecycleDialer struct {
	mu          sync.Mutex
	snapErr     error
	stopErr     error
	spawnFailAt map[int]bool // 0-based spawn call index → fail
	spawns      []*lanternv1.SpawnRequest
	snaps       []*lanternv1.SnapshotRequest
	stops       []string
	onStop      func() // runs inside Stop, before it returns (crash/race window)
	onSpawn     func() // runs inside Spawn, before it returns
}

func (d *lifecycleDialer) Spawn(_ context.Context, _ string, req *lanternv1.SpawnRequest) (*lanternv1.SpawnResponse, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	i := len(d.spawns)
	d.spawns = append(d.spawns, req)
	if d.onSpawn != nil {
		d.onSpawn()
	}
	if d.spawnFailAt[i] {
		return nil, errors.New("boot failed")
	}
	return &lanternv1.SpawnResponse{Handle: req.Handle, FromSnapshot: true}, nil
}

func (d *lifecycleDialer) Stop(_ context.Context, _ string, req *lanternv1.StopRequest) (*lanternv1.StopResponse, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stops = append(d.stops, req.VmId)
	if d.onStop != nil {
		d.onStop()
	}
	if d.stopErr != nil {
		return nil, d.stopErr
	}
	return &lanternv1.StopResponse{Ok: true}, nil
}

func (d *lifecycleDialer) Snapshot(_ context.Context, _ string, req *lanternv1.SnapshotRequest) (*lanternv1.SnapshotResponse, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.snaps = append(d.snaps, req)
	if d.snapErr != nil {
		return nil, d.snapErr
	}
	return &lanternv1.SnapshotResponse{SnapshotId: "snap-" + req.VmId}, nil
}

func (d *lifecycleDialer) Close() {}

// seedVM puts a VM straight into the store in `state`, holding a quota slot
// unless it is PAUSED (matching what Schedule / Pause leave behind).
func seedVM(store cluster.ClusterStore, id, tenant string, state lanternv1.VmState, snap string) {
	store.CreateVM(&cluster.VM{
		Handle:     &lanternv1.VmHandle{VmId: id, Node: "n1"},
		Spec:       &lanternv1.AgentSpec{ImageDigest: "sha256:abc", TenantId: tenant, Labels: map[string]string{"k": "v"}},
		State:      state,
		TenantID:   tenant,
		NodeName:   "n1",
		SnapshotID: snap,
	})
	if state != lanternv1.VmState_VM_STATE_PAUSED {
		store.IncrTenantVMs(tenant, 1)
	}
}

func wantCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	if got := status.Code(err); got != want {
		t.Fatalf("code = %v (%v), want %v", got, err, want)
	}
}

func TestPause(t *testing.T) {
	tests := []struct {
		name      string
		state     lanternv1.VmState
		snap      string
		d         *lifecycleDialer
		wantCode  codes.Code
		wantState lanternv1.VmState
		wantQuota int
		wantSnaps int
	}{
		{"running → paused frees slot", lanternv1.VmState_VM_STATE_RUNNING, "", &lifecycleDialer{}, codes.OK, lanternv1.VmState_VM_STATE_PAUSED, 0, 1},
		{"already paused is idempotent", lanternv1.VmState_VM_STATE_PAUSED, "snap-old", &lifecycleDialer{}, codes.OK, lanternv1.VmState_VM_STATE_PAUSED, 0, 0},
		{"pending is wrong state", lanternv1.VmState_VM_STATE_PENDING, "", &lifecycleDialer{}, codes.FailedPrecondition, lanternv1.VmState_VM_STATE_PENDING, 1, 0},
		{"snapshot failure keeps running", lanternv1.VmState_VM_STATE_RUNNING, "", &lifecycleDialer{snapErr: errors.New("boom")}, codes.Unavailable, lanternv1.VmState_VM_STATE_RUNNING, 1, 1},
		{"stop failure keeps running + slot", lanternv1.VmState_VM_STATE_RUNNING, "", &lifecycleDialer{stopErr: errors.New("boom")}, codes.Unavailable, lanternv1.VmState_VM_STATE_RUNNING, 1, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := cluster.NewInMemoryStore()
			addNode(store, "n1", 8000, 16<<30)
			seedVM(store, "vm-1", "t1", tc.state, tc.snap)
			svc := newService(store, tc.d)

			resp, err := svc.Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"})
			wantCode(t, err, tc.wantCode)
			vm, _ := store.GetVM("vm-1")
			if vm.State != tc.wantState {
				t.Errorf("state = %v, want %v", vm.State, tc.wantState)
			}
			if got := store.TenantLiveVMs("t1"); got != tc.wantQuota {
				t.Errorf("quota = %d, want %d", got, tc.wantQuota)
			}
			if len(tc.d.snaps) != tc.wantSnaps {
				t.Errorf("snapshots = %d, want %d", len(tc.d.snaps), tc.wantSnaps)
			}
			if err == nil {
				want := tc.snap
				if want == "" {
					want = "snap-vm-1"
				}
				if resp.SnapshotId != want || vm.SnapshotID != want {
					t.Errorf("snapshot = resp %q / store %q, want %q", resp.SnapshotId, vm.SnapshotID, want)
				}
			}
		})
	}
}

func TestPause_TwiceReleasesQuotaOnce(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	seedVM(store, "vm-2", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	d := &lifecycleDialer{}
	svc := newService(store, d)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := svc.Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"}); err != nil {
				t.Errorf("Pause: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := store.TenantLiveVMs("t1"); got != 1 {
		t.Errorf("quota = %d, want 1 (vm-2 still running, vm-1 released exactly once)", got)
	}
	if len(d.stops) != 1 {
		t.Errorf("manager Stop called %d times, want 1", len(d.stops))
	}
}

func TestResume(t *testing.T) {
	tests := []struct {
		name      string
		state     lanternv1.VmState
		hardCap   int
		otherLive int
		d         *lifecycleDialer
		wantCode  codes.Code
		wantState lanternv1.VmState
		wantQuota int
	}{
		{"paused → running takes slot", lanternv1.VmState_VM_STATE_PAUSED, 20, 0, &lifecycleDialer{}, codes.OK, lanternv1.VmState_VM_STATE_RUNNING, 1},
		{"running is wrong state", lanternv1.VmState_VM_STATE_RUNNING, 20, 0, &lifecycleDialer{}, codes.FailedPrecondition, lanternv1.VmState_VM_STATE_RUNNING, 1},
		{"quota exhausted stays paused", lanternv1.VmState_VM_STATE_PAUSED, 2, 2, &lifecycleDialer{}, codes.ResourceExhausted, lanternv1.VmState_VM_STATE_PAUSED, 2},
		{"spawn failure releases slot, stays paused", lanternv1.VmState_VM_STATE_PAUSED, 20, 0, &lifecycleDialer{spawnFailAt: map[int]bool{0: true}}, codes.Unavailable, lanternv1.VmState_VM_STATE_PAUSED, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := cluster.NewInMemoryStore()
			addNode(store, "n1", 8000, 16<<30)
			seedVM(store, "vm-1", "t1", tc.state, "snap-1")
			store.IncrTenantVMs("t1", tc.otherLive)
			svc := newService(store, tc.d)
			svc.TenantHardCap = tc.hardCap

			resp, err := svc.Resume(ctxWithTenant("t1"), &lanternv1.ResumeRequest{VmId: "vm-1"})
			wantCode(t, err, tc.wantCode)
			vm, _ := store.GetVM("vm-1")
			if vm.State != tc.wantState {
				t.Errorf("state = %v, want %v", vm.State, tc.wantState)
			}
			if got := store.TenantLiveVMs("t1"); got != tc.wantQuota {
				t.Errorf("quota = %d, want %d", got, tc.wantQuota)
			}
			if err == nil {
				sp := tc.d.spawns[0]
				if sp.Handle.VmId != "vm-1" || sp.Spec.RestoreSnapshotId != "snap-1" {
					t.Errorf("spawn = (vm %q, snap %q), want (vm-1, snap-1)", sp.Handle.VmId, sp.Spec.RestoreSnapshotId)
				}
				if resp.State != lanternv1.VmState_VM_STATE_RUNNING || resp.SnapshotId != "snap-1" {
					t.Errorf("resp = %+v", resp)
				}
				if vm.Spec.RestoreSnapshotId != "" {
					t.Error("stored spec was mutated with restore_snapshot_id")
				}
			}
		})
	}
}

func TestPauseResume_NodeOccupancy(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	svc := newService(store, &lifecycleDialer{})
	running := func() int64 { n, _ := store.GetNode("n1"); return n.RunningVms }

	if _, err := svc.Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if got := running(); got != 0 {
		t.Errorf("after pause RunningVms = %d, want 0", got)
	}
	if _, err := svc.Resume(ctxWithTenant("t1"), &lanternv1.ResumeRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if got := running(); got != 1 {
		t.Errorf("after resume RunningVms = %d, want 1", got)
	}
}

func TestFork(t *testing.T) {
	tests := []struct {
		name       string
		state      lanternv1.VmState
		count      int32
		hardCap    int
		d          *lifecycleDialer
		wantCode   codes.Code
		wantOK     int
		wantFailed int
		wantQuota  int
		wantSnaps  int
	}{
		{"running source: fresh snapshot, keeps running", lanternv1.VmState_VM_STATE_RUNNING, 3, 20, &lifecycleDialer{}, codes.OK, 3, 0, 4, 1},
		{"paused source: reuses pause snapshot", lanternv1.VmState_VM_STATE_PAUSED, 2, 20, &lifecycleDialer{}, codes.OK, 2, 0, 2, 0},
		{"partial failure releases failed slots", lanternv1.VmState_VM_STATE_RUNNING, 3, 20, &lifecycleDialer{spawnFailAt: map[int]bool{1: true}}, codes.OK, 2, 1, 3, 1},
		{"quota is all-or-nothing, checked before any snapshot", lanternv1.VmState_VM_STATE_RUNNING, 3, 3, &lifecycleDialer{}, codes.ResourceExhausted, 0, 0, 1, 0},
		{"count 0 rejected", lanternv1.VmState_VM_STATE_RUNNING, 0, 20, &lifecycleDialer{}, codes.InvalidArgument, 0, 0, 1, 0},
		{"count 11 rejected", lanternv1.VmState_VM_STATE_RUNNING, 11, 20, &lifecycleDialer{}, codes.OK, 11, 0, 12, 1},
		{"count over cap rejected", lanternv1.VmState_VM_STATE_RUNNING, 1001, 2000, &lifecycleDialer{}, codes.InvalidArgument, 0, 0, 1, 0},
		{"failed source rejected", lanternv1.VmState_VM_STATE_FAILED, 1, 20, &lifecycleDialer{}, codes.FailedPrecondition, 0, 0, 1, 0},
		{"snapshot failure", lanternv1.VmState_VM_STATE_RUNNING, 1, 20, &lifecycleDialer{snapErr: errors.New("boom")}, codes.Unavailable, 0, 0, 1, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := cluster.NewInMemoryStore()
			addNode(store, "n1", 8000, 16<<30)
			snap := ""
			if tc.state == lanternv1.VmState_VM_STATE_PAUSED {
				snap = "snap-paused"
			}
			seedVM(store, "vm-src", "t1", tc.state, snap)
			svc := newService(store, tc.d)
			svc.TenantHardCap = tc.hardCap

			resp, err := svc.Fork(ctxWithTenant("t1"), &lanternv1.ForkRequest{VmId: "vm-src", Count: tc.count, Identities: idents(int(tc.count))})
			wantCode(t, err, tc.wantCode)
			if got := store.TenantLiveVMs("t1"); got != tc.wantQuota {
				t.Errorf("quota = %d, want %d", got, tc.wantQuota)
			}
			if len(tc.d.snaps) != tc.wantSnaps {
				t.Errorf("snapshots = %d, want %d", len(tc.d.snaps), tc.wantSnaps)
			}
			if tc.wantSnaps == 1 && !tc.d.snaps[0].KeepRunning {
				t.Error("fork snapshot of a running source must keep_running")
			}
			if err != nil {
				return
			}
			src, _ := store.GetVM("vm-src")
			if src.State != tc.state {
				t.Errorf("source state = %v, want unchanged %v", src.State, tc.state)
			}
			var ok, failed int
			for _, c := range resp.Forks {
				child, found := store.GetVM(c.VmId)
				if !found {
					t.Fatalf("child %s not in store", c.VmId)
				}
				if child.ParentVMID != "vm-src" || child.SnapshotID != resp.SnapshotId || child.TenantID != "t1" {
					t.Errorf("child row = parent %q snap %q tenant %q", child.ParentVMID, child.SnapshotID, child.TenantID)
				}
				if child.State != c.State {
					t.Errorf("child %s store state %v != reported %v", c.VmId, child.State, c.State)
				}
				switch c.State {
				case lanternv1.VmState_VM_STATE_RUNNING:
					ok++
				case lanternv1.VmState_VM_STATE_FAILED:
					failed++
					if c.Error == "" {
						t.Error("failed child must carry an error")
					}
				}
			}
			if ok != tc.wantOK || failed != tc.wantFailed {
				t.Errorf("forks ok=%d failed=%d, want %d/%d", ok, failed, tc.wantOK, tc.wantFailed)
			}
			for _, sp := range tc.d.spawns {
				if sp.Spec.RestoreSnapshotId != resp.SnapshotId || sp.Handle.VmId == "vm-src" {
					t.Errorf("spawn = vm %q snap %q", sp.Handle.VmId, sp.Spec.RestoreSnapshotId)
				}
			}
		})
	}
}

func TestLifecycle_TenantIsolation(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	seedVM(store, "vm-p", "t1", lanternv1.VmState_VM_STATE_PAUSED, "snap-p")
	d := &lifecycleDialer{}
	svc := newService(store, d)
	other := ctxWithTenant("t2")

	_, err := svc.Pause(other, &lanternv1.PauseRequest{VmId: "vm-1"})
	wantCode(t, err, codes.NotFound)
	_, err = svc.Resume(other, &lanternv1.ResumeRequest{VmId: "vm-p"})
	wantCode(t, err, codes.NotFound)
	_, err = svc.Fork(other, &lanternv1.ForkRequest{VmId: "vm-1", Count: 1, Identities: idents(1)})
	wantCode(t, err, codes.NotFound)
	_, err = svc.Pause(other, &lanternv1.PauseRequest{VmId: "nope"})
	wantCode(t, err, codes.NotFound)
	_, err = svc.Pause(context.Background(), &lanternv1.PauseRequest{VmId: "vm-1"})
	if err == nil {
		t.Error("no tenant in ctx must be rejected")
	}
	if len(d.snaps)+len(d.spawns)+len(d.stops) != 0 {
		t.Error("manager was called for a cross-tenant request")
	}
}

func TestTerminate_PausedVM_NoStopNoDoubleFree(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	d := &lifecycleDialer{}
	svc := newService(store, d)
	if _, err := svc.Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	store.IncrTenantVMs("t1", 1) // some other live VM
	if _, err := svc.Terminate(ctxWithTenant("t1"), &lanternv1.TerminateRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if got := store.TenantLiveVMs("t1"); got != 1 {
		t.Errorf("quota = %d, want 1 (paused VM already released its slot)", got)
	}
	if len(d.stops) != 1 {
		t.Errorf("Stop calls = %d, want 1 (from Pause only)", len(d.stops))
	}
}

func TestReconcile_IgnoresPausedVM(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-p", "t1", lanternv1.VmState_VM_STATE_PAUSED, "snap-p")
	// The node no longer runs it — expected for a paused VM.
	if got := handlers.ReconcileNodeInventory(store, "n1", nil, true, time.Now().Add(time.Hour)); len(got) != 0 {
		t.Errorf("reconcile terminated paused VM: %v", got)
	}
	if vm, _ := store.GetVM("vm-p"); vm.State != lanternv1.VmState_VM_STATE_PAUSED {
		t.Errorf("state = %v", vm.State)
	}
}

// idents mints n distinct fake fork identities.
func idents(n int) []*lanternv1.ForkIdentity {
	out := make([]*lanternv1.ForkIdentity, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, &lanternv1.ForkIdentity{
			AgentInstanceId:    fmt.Sprintf("inst-child-%d", i),
			AgentInstanceToken: fmt.Sprintf("tok-child-%d", i),
		})
	}
	return out
}

func TestFork_ChildrenGetOwnIdentity(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	store.CreateVM(&cluster.VM{
		Handle: &lanternv1.VmHandle{VmId: "vm-src", Node: "n1"},
		Spec: &lanternv1.AgentSpec{ImageDigest: "sha256:abc", Env: map[string]string{
			"LANTERN_AGENT_INSTANCE_ID": "inst-src", "LANTERN_AGENT_INSTANCE_TOKEN": "tok-src", "KEEP": "me",
		}},
		State: lanternv1.VmState_VM_STATE_RUNNING, TenantID: "t1", NodeName: "n1",
	})
	store.IncrTenantVMs("t1", 1)
	d := &lifecycleDialer{}
	svc := newService(store, d)

	resp, err := svc.Fork(ctxWithTenant("t1"), &lanternv1.ForkRequest{VmId: "vm-src", Count: 2, Identities: idents(2)})
	if err != nil {
		t.Fatal(err)
	}
	// Build a map from spawned identity → ForkChild so the check is order-agnostic.
	// With parallel spawning, d.spawns order is non-deterministic, but every spawned
	// identity must appear in exactly one ForkChild in resp.Forks.
	forkByID := make(map[string]*lanternv1.ForkChild, len(resp.Forks))
	for _, fc := range resp.Forks {
		forkByID[fc.AgentInstanceId] = fc
	}

	seenIDs, seenToks := map[string]bool{}, map[string]bool{}
	for i, sp := range d.spawns {
		id, tok := sp.Spec.Env["LANTERN_AGENT_INSTANCE_ID"], sp.Spec.Env["LANTERN_AGENT_INSTANCE_TOKEN"]
		if id == "inst-src" || tok == "tok-src" || id == "" || tok == "" {
			t.Errorf("child %d spawned with identity (%q, %q)", i, id, tok)
		}
		if seenIDs[id] || seenToks[tok] {
			t.Errorf("child %d reuses another child's identity", i)
		}
		seenIDs[id], seenToks[tok] = true, true
		if sp.Spec.Env["KEEP"] != "me" {
			t.Error("non-identity env must be inherited")
		}
		// Every spawned identity must have a matching ForkChild entry.
		// (Order-agnostic: parallel spawns arrive in non-deterministic order.)
		if _, ok := forkByID[id]; !ok {
			t.Errorf("spawn identity %q has no matching ForkChild in resp.Forks", id)
		}
	}
	if src, _ := store.GetVM("vm-src"); src.Spec.Env["LANTERN_AGENT_INSTANCE_TOKEN"] != "tok-src" {
		t.Error("source spec was mutated")
	}
}

func TestFork_RequiresOneIdentityPerChild(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-src", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	d := &lifecycleDialer{}
	svc := newService(store, d)
	for _, ids := range [][]*lanternv1.ForkIdentity{nil, idents(1), {{AgentInstanceId: "x"}, {AgentInstanceId: "y", AgentInstanceToken: "t"}}} {
		_, err := svc.Fork(ctxWithTenant("t1"), &lanternv1.ForkRequest{VmId: "vm-src", Count: 2, Identities: ids})
		wantCode(t, err, codes.InvalidArgument)
	}
	if len(d.spawns)+len(d.snaps) != 0 || store.TenantLiveVMs("t1") != 1 {
		t.Error("rejected fork touched the manager or quota")
	}
}

// A resumed VM must not be terminated by a pre-pause inventory confirmation
// plus a heartbeat that has not caught up with the respawn yet.
func TestReconcile_ResumedVMGetsGrace(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	old := time.Now().Add(-time.Hour)
	store.CreateVM(&cluster.VM{
		Handle: &lanternv1.VmHandle{VmId: "vm-1", Node: "n1", CreatedAt: timestamppb.New(old)},
		Spec:   &lanternv1.AgentSpec{ImageDigest: "sha256:abc"},
		State:  lanternv1.VmState_VM_STATE_RUNNING, TenantID: "t1", NodeName: "n1",
	})
	store.IncrTenantVMs("t1", 1)
	store.MarkVMsSeenOnNode("n1", []string{"vm-1"}, old.Add(time.Minute)) // confirmed long before pause
	svc := newService(store, &lifecycleDialer{})
	if _, err := svc.Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Resume(ctxWithTenant("t1"), &lanternv1.ResumeRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}

	// Stale inventory (does not list the respawned VM) right after resume.
	if got := handlers.ReconcileNodeInventory(store, "n1", nil, true, time.Now()); len(got) != 0 {
		t.Fatalf("resumed VM terminated inside the grace window: %v", got)
	}
	if vm, _ := store.GetVM("vm-1"); vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Fatalf("state = %v", vm.State)
	}
	// Past the grace window an absent VM is reconciled as usual.
	if got := handlers.ReconcileNodeInventory(store, "n1", nil, true, time.Now().Add(2*time.Hour)); len(got) != 1 {
		t.Fatalf("after grace: terminated %v, want vm-1", got)
	}
}

// Once the node confirms the resumed VM, a later omission is authoritative
// immediately (no grace needed).
func TestReconcile_ResumedVMConfirmedThenGone(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_PAUSED, "snap-1")
	svc := newService(store, &lifecycleDialer{})
	if _, err := svc.Resume(ctxWithTenant("t1"), &lanternv1.ResumeRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Second)
	handlers.ReconcileNodeInventory(store, "n1", []string{"vm-1"}, true, now)
	if got := handlers.ReconcileNodeInventory(store, "n1", nil, true, now.Add(time.Second)); len(got) != 1 {
		t.Fatalf("confirmed-then-gone resumed VM not reconciled: %v", got)
	}
}

func TestTerminate_LogsOrphanedSnapshot(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-p", "t1", lanternv1.VmState_VM_STATE_PAUSED, "snap-shared")
	seedVM(store, "vm-c", "t1", lanternv1.VmState_VM_STATE_RUNNING, "snap-shared") // fork child
	svc := newService(store, &lifecycleDialer{})
	svc.Logger = zap.New(core)
	orphaned := func() int { return logs.FilterMessageSnippet("snapshot orphaned").Len() }

	if _, err := svc.Terminate(ctxWithTenant("t1"), &lanternv1.TerminateRequest{VmId: "vm-p"}); err != nil {
		t.Fatal(err)
	}
	if orphaned() != 0 {
		t.Fatal("snapshot still referenced by the fork child — not orphaned yet")
	}
	if _, err := svc.Terminate(ctxWithTenant("t1"), &lanternv1.TerminateRequest{VmId: "vm-c"}); err != nil {
		t.Fatal(err)
	}
	if orphaned() != 1 {
		t.Fatalf("orphan logs = %d, want 1 after the last reference is gone", orphaned())
	}
}

// countedOnReload mirrors loadVMs: every non-terminal, non-PAUSED row takes a
// concurrent-VM slot after a scheduler restart.
func countedOnReload(st lanternv1.VmState) bool {
	return st != lanternv1.VmState_VM_STATE_PAUSED &&
		st != lanternv1.VmState_VM_STATE_TERMINATED &&
		st != lanternv1.VmState_VM_STATE_FAILED
}

// reloadVM rebuilds a store as loadVMs would after a crash: the persisted row
// only (no in-memory InventorySeenAt/RespawnedAt), slot counted per loadVMs.
func reloadVM(id string, st lanternv1.VmState, reason, snap string, lastEvent time.Time) cluster.ClusterStore {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	store.CreateVM(&cluster.VM{
		Handle: &lanternv1.VmHandle{VmId: id, Node: "n1"},
		Spec:   &lanternv1.AgentSpec{ImageDigest: "sha256:abc"},
		State:  st, Reason: reason, TenantID: "t1", NodeName: "n1", SnapshotID: snap, LastEventAt: lastEvent,
	})
	if countedOnReload(st) {
		store.IncrTenantVMs("t1", 1)
	}
	return store
}

// A crash while Pause's Stop is in flight must not leave the persisted row
// PAUSED: the VM may still be running, and PAUSED is excluded from quota and
// reconciliation on reload.
func TestPause_CrashDuringStopNeverUndercounts(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	var during *cluster.VM
	d := &lifecycleDialer{}
	d.onStop = func() { during, _ = store.GetVM("vm-1") }
	if _, err := newService(store, d).Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if !countedOnReload(during.State) {
		t.Fatalf("state persisted while Stop in flight = %v; a crash here reloads a possibly-running VM outside quota", during.State)
	}
	if during.SnapshotID == "" {
		t.Error("snapshot must be persisted before Stop")
	}
}

// A crash while Resume's Spawn is in flight must not leave the row PAUSED.
func TestResume_CrashDuringSpawnNeverUndercounts(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_PAUSED, "snap-1")
	var during *cluster.VM
	d := &lifecycleDialer{}
	d.onSpawn = func() { during, _ = store.GetVM("vm-1") }
	if _, err := newService(store, d).Resume(ctxWithTenant("t1"), &lanternv1.ResumeRequest{VmId: "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if !countedOnReload(during.State) {
		t.Fatalf("state persisted while Spawn in flight = %v; a crash here reloads a running VM outside quota", during.State)
	}
}

// After a restart, reconciliation settles a row left mid-Pause / mid-Resume.
func TestReconcile_ResolvesInterruptedLifecycle(t *testing.T) {
	old := time.Now().Add(-time.Hour)
	tests := []struct {
		name      string
		state     lanternv1.VmState
		reason    string
		live      []string
		wantState lanternv1.VmState
		wantQuota int
	}{
		{"pausing, node stopped it → paused, slot freed", lanternv1.VmState_VM_STATE_DRAINING, handlers.ReasonPausing, nil, lanternv1.VmState_VM_STATE_PAUSED, 0},
		{"pausing, still running → stays counted", lanternv1.VmState_VM_STATE_DRAINING, handlers.ReasonPausing, []string{"vm-1"}, lanternv1.VmState_VM_STATE_DRAINING, 1},
		{"resuming, never came up → paused, slot freed", lanternv1.VmState_VM_STATE_SPAWNING, handlers.ReasonResuming, nil, lanternv1.VmState_VM_STATE_PAUSED, 0},
		{"resuming, came up → stays counted", lanternv1.VmState_VM_STATE_SPAWNING, handlers.ReasonResuming, []string{"vm-1"}, lanternv1.VmState_VM_STATE_SPAWNING, 1},
		{"plain draining still terminates", lanternv1.VmState_VM_STATE_DRAINING, "user", nil, lanternv1.VmState_VM_STATE_TERMINATED, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := reloadVM("vm-1", tc.state, tc.reason, "snap-1", old)
			handlers.ReconcileNodeInventory(store, "n1", tc.live, true, time.Now())
			vm, _ := store.GetVM("vm-1")
			if vm.State != tc.wantState {
				t.Errorf("state = %v, want %v", vm.State, tc.wantState)
			}
			if got := store.TenantLiveVMs("t1"); got != tc.wantQuota {
				t.Errorf("quota = %d, want %d", got, tc.wantQuota)
			}
			if vm.SnapshotID != "snap-1" {
				t.Errorf("snapshot = %q, want kept", vm.SnapshotID)
			}
		})
	}
}

// Reconciliation and Pause both resolving the same pausing VM release its slot
// exactly once.
func TestPause_RacingReconcileReleasesOnce(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	seedVM(store, "vm-2", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	d := &lifecycleDialer{}
	// The node stops vm-1 and its heartbeat lands before Pause finishes.
	d.onStop = func() {
		handlers.ReconcileNodeInventory(store, "n1", []string{"vm-2"}, true, time.Now().Add(time.Hour))
	}
	resp, err := newService(store, d).Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"})
	if err != nil {
		t.Fatal(err)
	}
	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_PAUSED || resp.State != lanternv1.VmState_VM_STATE_PAUSED {
		t.Errorf("state = %v / resp %v, want PAUSED", vm.State, resp.State)
	}
	if got := store.TenantLiveVMs("t1"); got != 1 {
		t.Errorf("quota = %d, want 1 (vm-2 only; vm-1 released exactly once)", got)
	}
}

// If reconciliation gives up on a resume (spawn outlived the grace) the VM is
// recorded PAUSED with no slot, so Resume must stop what it spawned rather
// than leave it running uncounted.
func TestResume_RacingReconcileStopsSpawnedVM(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_PAUSED, "snap-1")
	d := &lifecycleDialer{}
	d.onSpawn = func() {
		handlers.ReconcileNodeInventory(store, "n1", nil, true, time.Now().Add(time.Hour))
	}
	_, err := newService(store, d).Resume(ctxWithTenant("t1"), &lanternv1.ResumeRequest{VmId: "vm-1"})
	wantCode(t, err, codes.Unavailable)
	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_PAUSED {
		t.Errorf("state = %v, want PAUSED", vm.State)
	}
	if got := store.TenantLiveVMs("t1"); got != 0 {
		t.Errorf("quota = %d, want 0", got)
	}
	if len(d.stops) != 1 {
		t.Errorf("Stop calls = %d, want 1 (the orphaned respawn)", len(d.stops))
	}
}

// A VM whose node is not registered must not be dialed with an empty address:
// the dialer treats "" as "use the default manager", which in a multi-node
// cluster is some other node's manager. Each path fails before touching it.
func TestLifecycle_UnregisteredNodeNeverDialed(t *testing.T) {
	tests := []struct {
		name string
		call func(*handlers.SchedulerService) error
	}{
		{"pause", func(s *handlers.SchedulerService) error {
			_, err := s.Pause(ctxWithTenant("t1"), &lanternv1.PauseRequest{VmId: "vm-1"})
			return err
		}},
		{"snapshot", func(s *handlers.SchedulerService) error {
			_, err := s.Snapshot(ctxWithTenant("t1"), &lanternv1.SnapshotRequest{VmId: "vm-1"})
			return err
		}},
		{"terminate", func(s *handlers.SchedulerService) error {
			_, err := s.Terminate(ctxWithTenant("t1"), &lanternv1.TerminateRequest{VmId: "vm-1"})
			return err
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := cluster.NewInMemoryStore() // node "n1" never registered
			seedVM(store, "vm-1", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
			d := &lifecycleDialer{}
			svc := newService(store, d)

			wantCode(t, tc.call(svc), codes.Unavailable)
			if len(d.snaps)+len(d.stops) != 0 {
				t.Errorf("manager dialed: snaps=%d stops=%d", len(d.snaps), len(d.stops))
			}
			if vm, _ := store.GetVM("vm-1"); vm.State != lanternv1.VmState_VM_STATE_RUNNING {
				t.Errorf("state = %v, want RUNNING", vm.State)
			}
		})
	}
}
