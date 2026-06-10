package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
)

// WriteThroughStore wraps an InMemoryStore and persists every mutation to
// Postgres. Reads always come from memory so the hot placement path is never
// blocked by DB latency.
//
// Persistence is synchronous within each mutating method. The caller already
// holds a gRPC / HTTP request context, so context cancellation propagates
// cleanly. If the DB write fails it is logged but NOT returned to the caller —
// an unavailable DB degrades to in-memory-only mode rather than failing
// placement.
type WriteThroughStore struct {
	cluster.ClusterStore // embedded — all read methods + pub/sub come from here
	mem                  *cluster.InMemoryStore
	pool                 *pgxpool.Pool
	logger               *zap.Logger
}

// NewWriteThroughStore wraps mem with Postgres persistence.
func NewWriteThroughStore(mem *cluster.InMemoryStore, pool *pgxpool.Pool, logger *zap.Logger) *WriteThroughStore {
	return &WriteThroughStore{
		ClusterStore: mem,
		mem:          mem,
		pool:         pool,
		logger:       logger.Named("sched_store"),
	}
}

// ---------------------------------------------------------------------------
// LoadFromDB rebuilds the in-memory store from persisted state on boot.
// ---------------------------------------------------------------------------

// LoadFromDB fetches all nodes and VMs from Postgres and inserts them into
// the wrapped InMemoryStore. Nodes whose last_heartbeat is older than
// deadline are loaded with Draining=true per existing scheduler semantics.
func (s *WriteThroughStore) LoadFromDB(ctx context.Context, deadline time.Duration) error {
	if err := s.loadNodes(ctx, deadline); err != nil {
		return fmt.Errorf("sched store load nodes: %w", err)
	}
	if err := s.loadVMs(ctx); err != nil {
		return fmt.Errorf("sched store load vms: %w", err)
	}
	return nil
}

func (s *WriteThroughStore) loadNodes(ctx context.Context, deadline time.Duration) error {
	rows, err := s.pool.Query(ctx, `
		SELECT name, address, region, continent, availability_zone,
		       is_spot, is_arm, free_vcpu_millis, free_memory_bytes,
		       warm_pool_exact, warm_pool_image_only,
		       draining, recent_oom_count, recent_kernel_events, last_heartbeat
		FROM sched_nodes`)
	if err != nil {
		return fmt.Errorf("query sched_nodes: %w", err)
	}
	defer rows.Close()

	now := time.Now().UTC()
	count := 0
	for rows.Next() {
		var n cluster.Node
		var wpExactJSON, wpImageJSON []byte
		if err := rows.Scan(
			&n.Name, &n.Address, &n.Region, &n.Continent, &n.AvailabilityZone,
			&n.IsSpot, &n.IsARM, &n.FreeVcpuMillis, &n.FreeMemoryBytes,
			&wpExactJSON, &wpImageJSON,
			&n.Draining, &n.RecentOOMCount, &n.RecentKernelEvents, &n.LastHeartbeat,
		); err != nil {
			return fmt.Errorf("scan sched_nodes row: %w", err)
		}
		if err := json.Unmarshal(wpExactJSON, &n.WarmPoolExact); err != nil {
			n.WarmPoolExact = map[string]int32{}
		}
		if err := json.Unmarshal(wpImageJSON, &n.WarmPoolImageOnly); err != nil {
			n.WarmPoolImageOnly = map[string]int32{}
		}
		// Apply staleness rule: mark draining if heartbeat is too old.
		if !n.Draining && now.Sub(n.LastHeartbeat) > deadline {
			n.Draining = true
		}
		s.mem.UpsertNode(n)
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sched_nodes rows: %w", err)
	}
	s.logger.Info("loaded nodes from DB", zap.Int("count", count))
	return nil
}

func (s *WriteThroughStore) loadVMs(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT vm_id, tenant_id, node_name, state, reason,
		       spec, availability_zone, created_at, last_event_at, last_heartbeat_at
		FROM sched_vms`)
	if err != nil {
		return fmt.Errorf("query sched_vms: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var vmID, tenantID, nodeName, reason, az string
		var stateInt int32
		var specJSON []byte
		var createdAt, lastEventAt time.Time
		var lastHeartbeatAt *time.Time

		if err := rows.Scan(
			&vmID, &tenantID, &nodeName, &stateInt, &reason,
			&specJSON, &az, &createdAt, &lastEventAt, &lastHeartbeatAt,
		); err != nil {
			return fmt.Errorf("scan sched_vms row: %w", err)
		}

		var spec lanternv1.AgentSpec
		_ = json.Unmarshal(specJSON, &spec) // best-effort; nil fields are fine

		handle := &lanternv1.VmHandle{
			VmId:             vmID,
			Node:             nodeName,
			AvailabilityZone: az,
		}
		vm := &cluster.VM{
			Handle:      handle,
			Spec:        &spec,
			State:       lanternv1.VmState(stateInt),
			TenantID:    tenantID,
			NodeName:    nodeName,
			Reason:      reason,
			LastEventAt: lastEventAt,
		}
		if lastHeartbeatAt != nil {
			vm.LastHeartbeat = *lastHeartbeatAt
		}
		s.mem.CreateVM(vm)
		s.mem.IncrTenantVMs(tenantID, 1)
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sched_vms rows: %w", err)
	}
	s.logger.Info("loaded VMs from DB", zap.Int("count", count))
	return nil
}

// ---------------------------------------------------------------------------
// Write-through mutations
// ---------------------------------------------------------------------------

// UpsertNode writes through to memory then to Postgres.
func (s *WriteThroughStore) UpsertNode(n cluster.Node) {
	s.mem.UpsertNode(n)
	if s.pool == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.persistNode(ctx, n)
}

func (s *WriteThroughStore) persistNode(ctx context.Context, n cluster.Node) {
	wpExact, _ := json.Marshal(n.WarmPoolExact)
	wpImage, _ := json.Marshal(n.WarmPoolImageOnly)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sched_nodes
			(name, address, region, continent, availability_zone,
			 is_spot, is_arm, free_vcpu_millis, free_memory_bytes,
			 warm_pool_exact, warm_pool_image_only,
			 draining, recent_oom_count, recent_kernel_events, last_heartbeat, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
		ON CONFLICT (name) DO UPDATE SET
			address              = EXCLUDED.address,
			region               = EXCLUDED.region,
			continent            = EXCLUDED.continent,
			availability_zone    = EXCLUDED.availability_zone,
			is_spot              = EXCLUDED.is_spot,
			is_arm               = EXCLUDED.is_arm,
			free_vcpu_millis     = EXCLUDED.free_vcpu_millis,
			free_memory_bytes    = EXCLUDED.free_memory_bytes,
			warm_pool_exact      = EXCLUDED.warm_pool_exact,
			warm_pool_image_only = EXCLUDED.warm_pool_image_only,
			draining             = EXCLUDED.draining,
			recent_oom_count     = EXCLUDED.recent_oom_count,
			recent_kernel_events = EXCLUDED.recent_kernel_events,
			last_heartbeat       = EXCLUDED.last_heartbeat,
			updated_at           = now()`,
		n.Name, n.Address, n.Region, n.Continent, n.AvailabilityZone,
		n.IsSpot, n.IsARM, n.FreeVcpuMillis, n.FreeMemoryBytes,
		wpExact, wpImage,
		n.Draining, n.RecentOOMCount, n.RecentKernelEvents, n.LastHeartbeat,
	)
	if err != nil {
		s.logger.Warn("sched_nodes upsert failed",
			zap.String("node", n.Name), zap.Error(err))
	}
}

// RemoveNode removes from memory and from Postgres.
func (s *WriteThroughStore) RemoveNode(name string) {
	s.mem.RemoveNode(name)
	if s.pool == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.pool.Exec(ctx, `DELETE FROM sched_nodes WHERE name = $1`, name); err != nil {
		s.logger.Warn("sched_nodes delete failed",
			zap.String("node", name), zap.Error(err))
	}
}

// MarkDrainingIfStale marks stale nodes draining in memory then syncs each
// flipped node to Postgres.
func (s *WriteThroughStore) MarkDrainingIfStale(now time.Time, deadline time.Duration) []string {
	flipped := s.mem.MarkDrainingIfStale(now, deadline)
	if len(flipped) == 0 || s.pool == nil {
		return flipped
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, name := range flipped {
		if _, err := s.pool.Exec(ctx,
			`UPDATE sched_nodes SET draining = TRUE, updated_at = now() WHERE name = $1`, name,
		); err != nil {
			s.logger.Warn("sched_nodes drain update failed",
				zap.String("node", name), zap.Error(err))
		}
	}
	return flipped
}

// CreateVM writes through to memory then to Postgres.
func (s *WriteThroughStore) CreateVM(v *cluster.VM) {
	s.mem.CreateVM(v)
	if s.pool == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.persistVM(ctx, v)
}

func (s *WriteThroughStore) persistVM(ctx context.Context, v *cluster.VM) {
	specJSON, _ := json.Marshal(v.Spec)
	az := ""
	if v.Handle != nil {
		az = v.Handle.AvailabilityZone
	}
	var lhAt *time.Time
	if !v.LastHeartbeat.IsZero() {
		t := v.LastHeartbeat
		lhAt = &t
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sched_vms
			(vm_id, tenant_id, node_name, state, reason,
			 spec, availability_zone, last_event_at, last_heartbeat_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (vm_id) DO UPDATE SET
			state             = EXCLUDED.state,
			reason            = EXCLUDED.reason,
			spec              = EXCLUDED.spec,
			availability_zone = EXCLUDED.availability_zone,
			last_event_at     = EXCLUDED.last_event_at,
			last_heartbeat_at = EXCLUDED.last_heartbeat_at,
			updated_at        = now()`,
		v.Handle.VmId, v.TenantID, v.NodeName, int32(v.State), v.Reason,
		specJSON, az, v.LastEventAt, lhAt,
	)
	if err != nil {
		s.logger.Warn("sched_vms insert failed",
			zap.String("vm_id", v.Handle.VmId), zap.Error(err))
	}
}

// UpdateVMState updates memory then syncs to Postgres.
func (s *WriteThroughStore) UpdateVMState(vmID string, state lanternv1.VmState, reason string, usage *lanternv1.ResourceUsage, at time.Time) bool {
	ok := s.mem.UpdateVMState(vmID, state, reason, usage, at)
	if !ok {
		return false
	}
	if s.pool == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.pool.Exec(ctx,
		`UPDATE sched_vms SET state=$1, reason=$2, last_event_at=$3, updated_at=now() WHERE vm_id=$4`,
		int32(state), reason, at, vmID,
	); err != nil {
		s.logger.Warn("sched_vms state update failed",
			zap.String("vm_id", vmID), zap.Error(err))
	}
	return true
}

// DeleteVM removes from memory and from Postgres.
func (s *WriteThroughStore) DeleteVM(vmID string) bool {
	ok := s.mem.DeleteVM(vmID)
	if !ok {
		return false
	}
	if s.pool == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.pool.Exec(ctx, `DELETE FROM sched_vms WHERE vm_id = $1`, vmID); err != nil {
		s.logger.Warn("sched_vms delete failed",
			zap.String("vm_id", vmID), zap.Error(err))
	}
	return true
}

// ---------------------------------------------------------------------------
// Snapshot persistence (called by the Snapshot RPC handler)
// ---------------------------------------------------------------------------

// PersistSnapshot implements handlers.SnapshotPersister. It records snapshot
// metadata returned by the runtime-manager into sched_snapshots.
func (s *WriteThroughStore) PersistSnapshot(
	ctx context.Context,
	snapshotID, vmID, tenantID, nodeName string,
	keepRunning bool,
	resp *lanternv1.SnapshotResponse,
) {
	if s.pool == nil {
		return
	}
	// The manager's snapshot id may differ from the scheduler's local hint.
	managerSnapID := ""
	var sha256 string
	var bytes int64
	if resp != nil {
		managerSnapID = resp.SnapshotId
		sha256 = resp.Sha256
		bytes = resp.Bytes
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sched_snapshots
			(snapshot_id, vm_id, tenant_id, node_name, keep_running,
			 manager_snapshot_id, sha256, bytes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (snapshot_id) DO NOTHING`,
		snapshotID, vmID, tenantID, nodeName, keepRunning,
		managerSnapID, sha256, bytes,
	); err != nil {
		s.logger.Warn("sched_snapshots insert failed",
			zap.String("snapshot_id", snapshotID), zap.Error(err))
	}
}
