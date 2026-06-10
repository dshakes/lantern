package store_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/store"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// openTestPool connects using DATABASE_URL. Skips the test if unset or if
// the database is unreachable — same pattern as control-plane runtime_test.go.
func openTestPool(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping DB test in -short mode")
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set — skipping (run `make dev-infra` first)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Skipf("pgxpool.New: %v — skipping (DB unreachable?)", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("DB ping failed: %v — skipping", err)
	}
	return pool, dbURL
}

func testLogger(t *testing.T) *zap.Logger {
	t.Helper()
	l, _ := zap.NewDevelopment()
	return l
}

// cleanupTables truncates scheduler tables. Opens its own connection so it is
// safe to call from t.Cleanup even after the test's main pool has been closed.
func cleanupTables(t *testing.T, dbURL string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Logf("cleanupTables: open pool: %v", err)
		return
	}
	defer pool.Close()
	for _, tbl := range []string{"sched_snapshots", "sched_vms", "sched_nodes"} {
		if _, err := pool.Exec(ctx, "DELETE FROM "+tbl); err != nil {
			t.Logf("cleanup %s: %v", tbl, err)
		}
	}
}

func newWriteThrough(t *testing.T, pool *pgxpool.Pool) (*cluster.InMemoryStore, *store.WriteThroughStore) {
	t.Helper()
	mem := cluster.NewInMemoryStore()
	wt := store.NewWriteThroughStore(mem, pool, testLogger(t))
	return mem, wt
}

func migrateDB(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}

// ---------------------------------------------------------------------------
// In-memory-only unit tests (no DB required)
// ---------------------------------------------------------------------------

// TestWriteThroughStore_NodePassthrough verifies that node mutations applied
// to the write-through store land in the wrapped InMemoryStore and are
// visible via read methods — without a DB.
func TestWriteThroughStore_NodePassthrough(t *testing.T) {
	mem := cluster.NewInMemoryStore()
	// Use a nil pool — DB writes silently no-op; only the memory path is tested.
	wt := store.NewWriteThroughStore(mem, nil, zap.NewNop())

	n := cluster.Node{
		Name:            "node-1",
		Address:         "node-1:50054",
		Region:          "us-east-1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 << 30,
		LastHeartbeat:   time.Now().UTC(),
	}
	wt.UpsertNode(n)

	got, ok := wt.GetNode("node-1")
	if !ok {
		t.Fatal("expected node-1 to be present after UpsertNode")
	}
	if got.Region != "us-east-1" {
		t.Errorf("region: got %q, want %q", got.Region, "us-east-1")
	}

	nodes := wt.ListNodes()
	if len(nodes) != 1 {
		t.Fatalf("expected 1 node, got %d", len(nodes))
	}

	wt.RemoveNode("node-1")
	if _, ok := wt.GetNode("node-1"); ok {
		t.Fatal("expected node-1 to be gone after RemoveNode")
	}
}

// TestWriteThroughStore_VMPassthrough verifies that VM lifecycle operations
// (create, update state, delete) work correctly through the write-through
// store without a DB.
func TestWriteThroughStore_VMPassthrough(t *testing.T) {
	mem := cluster.NewInMemoryStore()
	wt := store.NewWriteThroughStore(mem, nil, zap.NewNop())

	handle := &lanternv1.VmHandle{
		VmId:      "vm-test-001",
		Node:      "node-1",
		CreatedAt: timestamppb.Now(),
	}
	vm := &cluster.VM{
		Handle:      handle,
		Spec:        &lanternv1.AgentSpec{ImageDigest: "sha256:abc", TenantId: "t-1"},
		State:       lanternv1.VmState_VM_STATE_PENDING,
		TenantID:    "t-1",
		NodeName:    "node-1",
		LastEventAt: time.Now().UTC(),
	}

	wt.CreateVM(vm)

	got, ok := wt.GetVM("vm-test-001")
	if !ok {
		t.Fatal("expected VM to be present after CreateVM")
	}
	if got.State != lanternv1.VmState_VM_STATE_PENDING {
		t.Errorf("state: got %v, want PENDING", got.State)
	}

	ok = wt.UpdateVMState("vm-test-001", lanternv1.VmState_VM_STATE_RUNNING, "spawned", nil, time.Now().UTC())
	if !ok {
		t.Fatal("UpdateVMState returned false for known VM")
	}
	got, _ = wt.GetVM("vm-test-001")
	if got.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state after update: got %v, want RUNNING", got.State)
	}

	vms := wt.ListVMs("t-1", nil)
	if len(vms) != 1 {
		t.Fatalf("expected 1 VM for t-1, got %d", len(vms))
	}

	if ok := wt.DeleteVM("vm-test-001"); !ok {
		t.Fatal("DeleteVM returned false for known VM")
	}
	if _, ok := wt.GetVM("vm-test-001"); ok {
		t.Fatal("expected VM to be gone after DeleteVM")
	}
}

// TestWriteThroughStore_MarkDrainingIfStale verifies the reaper correctly
// flips nodes and that the write-through store propagates the flips.
func TestWriteThroughStore_MarkDrainingIfStale(t *testing.T) {
	mem := cluster.NewInMemoryStore()
	wt := store.NewWriteThroughStore(mem, nil, zap.NewNop())

	freshNode := cluster.Node{
		Name:          "fresh",
		LastHeartbeat: time.Now().UTC(),
	}
	staleNode := cluster.Node{
		Name:          "stale",
		LastHeartbeat: time.Now().UTC().Add(-2 * time.Minute),
	}
	wt.UpsertNode(freshNode)
	wt.UpsertNode(staleNode)

	flipped := wt.MarkDrainingIfStale(time.Now().UTC(), 30*time.Second)
	if len(flipped) != 1 || flipped[0] != "stale" {
		t.Errorf("expected [stale] flipped, got %v", flipped)
	}

	stale, ok := wt.GetNode("stale")
	if !ok {
		t.Fatal("stale node missing")
	}
	if !stale.Draining {
		t.Error("stale node should be draining")
	}

	fresh, _ := wt.GetNode("fresh")
	if fresh.Draining {
		t.Error("fresh node should not be draining")
	}
}

// ---------------------------------------------------------------------------
// DB-backed integration tests
// ---------------------------------------------------------------------------

// TestDB_NodePersistAndLoad verifies that UpsertNode writes to Postgres and
// LoadFromDB reads it back into a fresh InMemoryStore.
func TestDB_NodePersistAndLoad(t *testing.T) {
	pool, dbURL := openTestPool(t)
	defer pool.Close()
	migrateDB(t, pool)
	cleanupTables(t, dbURL)
	t.Cleanup(func() { cleanupTables(t, dbURL) })

	_, wt := newWriteThrough(t, pool)

	n := cluster.Node{
		Name:               "db-node-1",
		Address:            "db-node-1:50054",
		Region:             "us-west-2",
		Continent:          "na",
		AvailabilityZone:   "us-west-2a",
		IsSpot:             true,
		IsARM:              false,
		FreeVcpuMillis:     8000,
		FreeMemoryBytes:    16 << 30,
		WarmPoolExact:      map[string]int32{"sha256:abc/500m/512Mi": 2},
		WarmPoolImageOnly:  map[string]int32{"sha256:abc": 5},
		LastHeartbeat:      time.Now().UTC().Add(-5 * time.Second),
		RecentOOMCount:     1,
		RecentKernelEvents: 0,
	}
	wt.UpsertNode(n)

	// Load state into a fresh in-memory store.
	mem2 := cluster.NewInMemoryStore()
	wt2 := store.NewWriteThroughStore(mem2, pool, testLogger(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wt2.LoadFromDB(ctx, cluster.HeartbeatDeadline); err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}

	got, ok := wt2.GetNode("db-node-1")
	if !ok {
		t.Fatal("db-node-1 not found after LoadFromDB")
	}
	if got.Region != "us-west-2" {
		t.Errorf("region: got %q, want us-west-2", got.Region)
	}
	if !got.IsSpot {
		t.Error("IsSpot should be true")
	}
	if got.WarmPoolExact["sha256:abc/500m/512Mi"] != 2 {
		t.Errorf("warm_pool_exact: got %v", got.WarmPoolExact)
	}
}

// TestDB_StaleNodeLoadedAsDraining verifies that nodes whose heartbeat is
// older than HeartbeatDeadline are loaded with Draining=true.
func TestDB_StaleNodeLoadedAsDraining(t *testing.T) {
	pool, dbURL := openTestPool(t)
	defer pool.Close()
	migrateDB(t, pool)
	cleanupTables(t, dbURL)
	t.Cleanup(func() { cleanupTables(t, dbURL) })

	_, wt := newWriteThrough(t, pool)

	stale := cluster.Node{
		Name:          "stale-db-node",
		Address:       "stale:50054",
		LastHeartbeat: time.Now().UTC().Add(-5 * time.Minute), // well beyond deadline
	}
	wt.UpsertNode(stale)

	mem2 := cluster.NewInMemoryStore()
	wt2 := store.NewWriteThroughStore(mem2, pool, testLogger(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wt2.LoadFromDB(ctx, cluster.HeartbeatDeadline); err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}

	got, ok := wt2.GetNode("stale-db-node")
	if !ok {
		t.Fatal("stale-db-node not found after LoadFromDB")
	}
	if !got.Draining {
		t.Error("stale node should be loaded as draining")
	}
}

// TestDB_VMPersistAndLoad verifies that CreateVM writes to Postgres and
// LoadFromDB restores it, including tenant VM count.
func TestDB_VMPersistAndLoad(t *testing.T) {
	pool, dbURL := openTestPool(t)
	defer pool.Close()
	migrateDB(t, pool)
	cleanupTables(t, dbURL)
	t.Cleanup(func() { cleanupTables(t, dbURL) })

	_, wt := newWriteThrough(t, pool)

	handle := &lanternv1.VmHandle{
		VmId:             "vm-db-001",
		Node:             "node-1",
		AvailabilityZone: "us-east-1a",
		CreatedAt:        timestamppb.Now(),
	}
	vm := &cluster.VM{
		Handle:      handle,
		Spec:        &lanternv1.AgentSpec{ImageDigest: "sha256:xyz", TenantId: "t-db-1"},
		State:       lanternv1.VmState_VM_STATE_RUNNING,
		TenantID:    "t-db-1",
		NodeName:    "node-1",
		Reason:      "spawn ok",
		LastEventAt: time.Now().UTC(),
	}
	wt.CreateVM(vm)

	// Reload.
	mem2 := cluster.NewInMemoryStore()
	wt2 := store.NewWriteThroughStore(mem2, pool, testLogger(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wt2.LoadFromDB(ctx, cluster.HeartbeatDeadline); err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}

	got, ok := wt2.GetVM("vm-db-001")
	if !ok {
		t.Fatal("vm-db-001 not found after LoadFromDB")
	}
	if got.TenantID != "t-db-1" {
		t.Errorf("tenant: got %q, want t-db-1", got.TenantID)
	}
	if got.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state: got %v, want RUNNING", got.State)
	}
	// LoadFromDB calls IncrTenantVMs for each restored VM.
	if count := wt2.TenantLiveVMs("t-db-1"); count != 1 {
		t.Errorf("tenant live VMs: got %d, want 1", count)
	}
}

// TestDB_VMStateUpdatePersists verifies that UpdateVMState writes the new
// state to Postgres (reload reads it back).
func TestDB_VMStateUpdatePersists(t *testing.T) {
	pool, dbURL := openTestPool(t)
	defer pool.Close()
	migrateDB(t, pool)
	cleanupTables(t, dbURL)
	t.Cleanup(func() { cleanupTables(t, dbURL) })

	_, wt := newWriteThrough(t, pool)

	handle := &lanternv1.VmHandle{VmId: "vm-state-upd", Node: "n1", CreatedAt: timestamppb.Now()}
	vm := &cluster.VM{
		Handle:   handle,
		Spec:     &lanternv1.AgentSpec{ImageDigest: "sha256:s1", TenantId: "t-2"},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t-2",
		NodeName: "n1",
	}
	wt.CreateVM(vm)
	wt.UpdateVMState("vm-state-upd", lanternv1.VmState_VM_STATE_TERMINATED, "done", nil, time.Now().UTC())

	mem2 := cluster.NewInMemoryStore()
	wt2 := store.NewWriteThroughStore(mem2, pool, testLogger(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wt2.LoadFromDB(ctx, cluster.HeartbeatDeadline); err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}
	got, ok := wt2.GetVM("vm-state-upd")
	if !ok {
		t.Fatal("vm-state-upd not found after LoadFromDB")
	}
	if got.State != lanternv1.VmState_VM_STATE_TERMINATED {
		t.Errorf("state: got %v, want TERMINATED", got.State)
	}
}

// TestDB_SnapshotPersists verifies that PersistSnapshot writes a row to
// sched_snapshots and it can be read back.
func TestDB_SnapshotPersists(t *testing.T) {
	pool, dbURL := openTestPool(t)
	defer pool.Close()
	migrateDB(t, pool)
	cleanupTables(t, dbURL)
	t.Cleanup(func() { cleanupTables(t, dbURL) })

	_, wt := newWriteThrough(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp := &lanternv1.SnapshotResponse{
		SnapshotId: "snap-db-001",
		Sha256:     "deadbeef",
		Bytes:      1024,
	}
	wt.PersistSnapshot(ctx, "snap-db-001", "vm-001", "t-snap", "node-1", true, resp)

	var gotID, gotVMID, gotSHA string
	var gotBytes int64
	err := pool.QueryRow(ctx,
		`SELECT snapshot_id, vm_id, sha256, bytes FROM sched_snapshots WHERE snapshot_id=$1`,
		"snap-db-001",
	).Scan(&gotID, &gotVMID, &gotSHA, &gotBytes)
	if err != nil {
		t.Fatalf("query sched_snapshots: %v", err)
	}
	if gotID != "snap-db-001" {
		t.Errorf("snapshot_id: got %q", gotID)
	}
	if gotVMID != "vm-001" {
		t.Errorf("vm_id: got %q", gotVMID)
	}
	if gotSHA != "deadbeef" {
		t.Errorf("sha256: got %q", gotSHA)
	}
	if gotBytes != 1024 {
		t.Errorf("bytes: got %d", gotBytes)
	}
}

// TestDB_DeleteVMRemovesRow verifies that DeleteVM removes the sched_vms row.
func TestDB_DeleteVMRemovesRow(t *testing.T) {
	pool, dbURL := openTestPool(t)
	defer pool.Close()
	migrateDB(t, pool)
	cleanupTables(t, dbURL)
	t.Cleanup(func() { cleanupTables(t, dbURL) })

	_, wt := newWriteThrough(t, pool)

	handle := &lanternv1.VmHandle{VmId: "vm-del-001", Node: "n1", CreatedAt: timestamppb.Now()}
	vm := &cluster.VM{
		Handle:   handle,
		Spec:     &lanternv1.AgentSpec{ImageDigest: "sha256:del", TenantId: "t-del"},
		State:    lanternv1.VmState_VM_STATE_RUNNING,
		TenantID: "t-del",
		NodeName: "n1",
	}
	wt.CreateVM(vm)
	wt.DeleteVM("vm-del-001")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sched_vms WHERE vm_id = $1`, "vm-del-001",
	).Scan(&count); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if count != 0 {
		t.Errorf("expected VM row to be deleted, got count=%d", count)
	}
}
