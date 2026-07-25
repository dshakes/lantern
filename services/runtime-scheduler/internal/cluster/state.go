// Package cluster tracks the in-memory cluster state used by the
// RuntimeScheduler: registered nodes, their warm-pool inventory,
// per-tenant live-VM counts, and an event bus for status fan-out.
//
// The interface is deliberately small (see ClusterStore) so it can be
// swapped for a persistent backend later (etcd, Postgres, or a custom
// Raft store) without touching call sites. The default implementation
// — InMemoryStore — is goroutine-safe and good enough for a single
// scheduler replica.
package cluster

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/scoring"
)

// HeartbeatDeadline is how long a node may go without a heartbeat
// before it is auto-marked draining.
const HeartbeatDeadline = 30 * time.Second

// Node captures all the per-node state the scheduler cares about. The
// runtime-manager publishes a Heartbeat (POST /v1/nodes/heartbeat) that
// upserts this struct.
type Node struct {
	Name               string
	Address            string // gRPC address used by the dialer
	Region             string
	Continent          string
	AvailabilityZone   string
	IsSpot             bool
	IsARM              bool
	FreeVcpuMillis     int64
	FreeMemoryBytes    int64
	WarmPoolExact      map[string]int32
	WarmPoolImageOnly  map[string]int32
	RunningVms         int64
	Draining           bool
	LastHeartbeat      time.Time
	RecentOOMCount     int
	RecentKernelEvents int
	// CCCapable is true when this node can run confidential-compute workloads
	// (Kata-CC on SEV-SNP/TDX). Advertised by the runtime-manager heartbeat;
	// the placement engine only places `confidential` workloads on such nodes.
	CCCapable bool
	// CCTech is the CC hardware technology the node exposes (e.g. "sev-snp"/"tdx"),
	// "" when unknown. Carried for the receipt/evidence trail.
	CCTech string
}

// VM is the scheduler-side record for a placed workload. We keep enough
// state here to satisfy List / Events / Terminate without round-tripping
// to the manager.
type VM struct {
	Handle        *lanternv1.VmHandle
	Spec          *lanternv1.AgentSpec
	State         lanternv1.VmState
	TenantID      string
	NodeName      string
	Usage         *lanternv1.ResourceUsage
	LastEventAt   time.Time
	LastHeartbeat time.Time
	Reason        string
}

// ClusterStore is the abstract interface for cluster state. Implementors
// must be goroutine-safe. The scheduler depends only on this interface
// so we can swap InMemoryStore for a persistent backend later.
type ClusterStore interface {
	UpsertNode(n Node)
	RemoveNode(name string)
	ListNodes() []Node
	GetNode(name string) (Node, bool)
	MarkDrainingIfStale(now time.Time, deadline time.Duration) []string

	CreateVM(v *VM)
	UpdateVMState(vmID string, state lanternv1.VmState, reason string, usage *lanternv1.ResourceUsage, at time.Time) bool
	GetVM(vmID string) (*VM, bool)
	ListVMs(tenantID string, filter func(*VM) bool) []*VM
	DeleteVM(vmID string) bool

	IncrTenantVMs(tenantID string, delta int)
	TenantLiveVMs(tenantID string) int

	Subscribe(vmID, tenantID string) (<-chan *lanternv1.StatusEvent, func())
	Publish(ev *lanternv1.StatusEvent, tenantID string)
}

// capReservation holds the pending capacity subtracted from a node by a
// Schedule call before the next heartbeat reconciles the real free capacity.
type capReservation struct {
	vcpuMillis int64
	memBytes   int64
}

// vmCapEntry records the capacity a single VM reserved so DeleteVM can
// release it accurately without waiting for the next heartbeat.
type vmCapEntry struct {
	nodeName   string
	vcpuMillis int64
	memBytes   int64
}

// InMemoryStore is the default ClusterStore. All maps are guarded by mu.
type InMemoryStore struct {
	mu          sync.RWMutex
	nodes       map[string]*Node
	vms         map[string]*VM
	tenantVMs   map[string]int
	subscribers map[string]map[string]subscriber // tenantID -> id -> sub

	// nodeReservations tracks aggregate pending capacity per node between
	// Pick() and the next heartbeat (which provides the real free capacity).
	// Guarded by mu. ponytail: in-process map; reconciled on each heartbeat.
	nodeReservations map[string]capReservation
	vmCapReserved    map[string]vmCapEntry // keyed by vm_id
}

type subscriber struct {
	vmID string
	ch   chan *lanternv1.StatusEvent
}

// NewInMemoryStore returns a freshly initialized in-memory cluster store.
func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		nodes:            make(map[string]*Node),
		vms:              make(map[string]*VM),
		tenantVMs:        make(map[string]int),
		subscribers:      make(map[string]map[string]subscriber),
		nodeReservations: make(map[string]capReservation),
		vmCapReserved:    make(map[string]vmCapEntry),
	}
}

// ---------------------------------------------------------------------
// Node operations
// ---------------------------------------------------------------------

func (s *InMemoryStore) UpsertNode(n Node) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n.WarmPoolExact == nil {
		n.WarmPoolExact = map[string]int32{}
	}
	if n.WarmPoolImageOnly == nil {
		n.WarmPoolImageOnly = map[string]int32{}
	}
	existing, ok := s.nodes[n.Name]
	if ok {
		// Preserve running_vms — that's authoritative on this side.
		n.RunningVms = existing.RunningVms
	}
	cp := n
	s.nodes[n.Name] = &cp
	// Heartbeat provides accurate free capacity from the manager — clear any
	// pending reservation for this node. The FreeVcpuMillis/FreeMemoryBytes
	// in the heartbeat already reflect running VMs.
	delete(s.nodeReservations, n.Name)
}

func (s *InMemoryStore) RemoveNode(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.nodes, name)
}

func (s *InMemoryStore) ListNodes() []Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		cp := *n
		s.applyReservation(&cp)
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (s *InMemoryStore) GetNode(name string) (Node, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n, ok := s.nodes[name]
	if !ok {
		return Node{}, false
	}
	cp := *n
	s.applyReservation(&cp)
	return cp, true
}

// applyReservation subtracts pending capacity reservations from a node copy.
// Must be called under mu (read or write lock).
func (s *InMemoryStore) applyReservation(n *Node) {
	if r, ok := s.nodeReservations[n.Name]; ok {
		n.FreeVcpuMillis -= r.vcpuMillis
		if n.FreeVcpuMillis < 0 {
			n.FreeVcpuMillis = 0
		}
		n.FreeMemoryBytes -= r.memBytes
		if n.FreeMemoryBytes < 0 {
			n.FreeMemoryBytes = 0
		}
	}
}

// MarkDrainingIfStale finds nodes whose last heartbeat is older than
// `deadline` and flips them to draining. Returns the names that were
// flipped. Caller (the heartbeat reaper) logs them.
func (s *InMemoryStore) MarkDrainingIfStale(now time.Time, deadline time.Duration) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var flipped []string
	for name, n := range s.nodes {
		if n.Draining {
			continue
		}
		if now.Sub(n.LastHeartbeat) > deadline {
			n.Draining = true
			flipped = append(flipped, name)
		}
	}
	return flipped
}

// ---------------------------------------------------------------------
// VM operations
// ---------------------------------------------------------------------

func (s *InMemoryStore) CreateVM(v *VM) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vms[v.Handle.VmId] = v
	if n, ok := s.nodes[v.NodeName]; ok {
		n.RunningVms++
	}
	// Reserve capacity atomically so the next Pick() sees reduced free capacity
	// before the node's next heartbeat reconciles the real value.
	if v.Spec != nil && v.Spec.Limits != nil {
		vcpu := parseVcpuMillisCluster(v.Spec.Limits.Vcpu)
		mem := parseMemBytesCluster(v.Spec.Limits.Memory)
		if vcpu > 0 || mem > 0 {
			r := s.nodeReservations[v.NodeName]
			r.vcpuMillis += vcpu
			r.memBytes += mem
			s.nodeReservations[v.NodeName] = r
			s.vmCapReserved[v.Handle.VmId] = vmCapEntry{
				nodeName:   v.NodeName,
				vcpuMillis: vcpu,
				memBytes:   mem,
			}
		}
	}
}

func (s *InMemoryStore) UpdateVMState(vmID string, state lanternv1.VmState, reason string, usage *lanternv1.ResourceUsage, at time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.vms[vmID]
	if !ok {
		return false
	}
	// Node occupancy is decremented on the NON-TERMINAL → TERMINAL edge.
	// Previously only DeleteVM decremented, so a VM that reached TERMINATED
	// or FAILED without being deleted kept occupying its node forever — the
	// node kept advertising VMs it was no longer running, which skewed both
	// placement load scoring and the cluster view. Guarded on the edge so a
	// repeated terminal update cannot double-decrement.
	if !isTerminalVMState(v.State) && isTerminalVMState(state) {
		if n, exists := s.nodes[v.NodeName]; exists && n.RunningVms > 0 {
			n.RunningVms--
		}
		s.releaseReservationLocked(vmID)
	}
	v.State = state
	v.Reason = reason
	if usage != nil {
		v.Usage = usage
	}
	v.LastEventAt = at
	return true
}

// isTerminalVMState reports whether a VM occupies no further node capacity.
func isTerminalVMState(s lanternv1.VmState) bool {
	return s == lanternv1.VmState_VM_STATE_TERMINATED ||
		s == lanternv1.VmState_VM_STATE_FAILED
}

func (s *InMemoryStore) GetVM(vmID string) (*VM, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.vms[vmID]
	if !ok {
		return nil, false
	}
	cp := *v
	return &cp, true
}

func (s *InMemoryStore) ListVMs(tenantID string, filter func(*VM) bool) []*VM {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*VM, 0)
	for _, v := range s.vms {
		if tenantID != "" && v.TenantID != tenantID {
			continue
		}
		if filter != nil && !filter(v) {
			continue
		}
		cp := *v
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Handle.VmId < out[j].Handle.VmId
	})
	return out
}

func (s *InMemoryStore) DeleteVM(vmID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.vms[vmID]
	if !ok {
		return false
	}
	delete(s.vms, vmID)
	// Only decrement when the VM was still occupying the node — a VM already
	// moved to a terminal state gave its slot back in UpdateVMState.
	if !isTerminalVMState(v.State) {
		if n, exists := s.nodes[v.NodeName]; exists && n.RunningVms > 0 {
			n.RunningVms--
		}
	}
	s.releaseReservationLocked(vmID)
	return true
}

// releaseReservationLocked returns a VM's pending capacity reservation so
// subsequent Pick() calls see the freed capacity before the next heartbeat.
// Idempotent. Caller must hold s.mu.
func (s *InMemoryStore) releaseReservationLocked(vmID string) {
	cap, ok := s.vmCapReserved[vmID]
	if !ok {
		return
	}
	r := s.nodeReservations[cap.nodeName]
	r.vcpuMillis -= cap.vcpuMillis
	if r.vcpuMillis < 0 {
		r.vcpuMillis = 0
	}
	r.memBytes -= cap.memBytes
	if r.memBytes < 0 {
		r.memBytes = 0
	}
	if r.vcpuMillis == 0 && r.memBytes == 0 {
		delete(s.nodeReservations, cap.nodeName)
	} else {
		s.nodeReservations[cap.nodeName] = r
	}
	delete(s.vmCapReserved, vmID)
}

// ---------------------------------------------------------------------
// Tenant accounting
// ---------------------------------------------------------------------

func (s *InMemoryStore) IncrTenantVMs(tenantID string, delta int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenantVMs[tenantID] += delta
	if s.tenantVMs[tenantID] < 0 {
		s.tenantVMs[tenantID] = 0
	}
}

func (s *InMemoryStore) TenantLiveVMs(tenantID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tenantVMs[tenantID]
}

// ---------------------------------------------------------------------
// Event fan-out (used by RuntimeScheduler.Events)
// ---------------------------------------------------------------------

// Subscribe returns a channel that receives status events for the given
// (vm_id, tenant_id) filter and a cancel function the caller MUST call
// when finished. Empty vmID means "all VMs for this tenant".
func (s *InMemoryStore) Subscribe(vmID, tenantID string) (<-chan *lanternv1.StatusEvent, func()) {
	ch := make(chan *lanternv1.StatusEvent, 32)
	subID := uuid.NewString()

	s.mu.Lock()
	if _, ok := s.subscribers[tenantID]; !ok {
		s.subscribers[tenantID] = map[string]subscriber{}
	}
	s.subscribers[tenantID][subID] = subscriber{vmID: vmID, ch: ch}
	s.mu.Unlock()

	cancel := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if subs, ok := s.subscribers[tenantID]; ok {
			delete(subs, subID)
			if len(subs) == 0 {
				delete(s.subscribers, tenantID)
			}
		}
		close(ch)
	}
	return ch, cancel
}

// Publish fans an event out to all matching subscribers. Non-blocking
// per-subscriber send: if a subscriber's buffer is full, the event is
// dropped (back-pressure: slow clients lose updates, fast ones don't).
func (s *InMemoryStore) Publish(ev *lanternv1.StatusEvent, tenantID string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	subs, ok := s.subscribers[tenantID]
	if !ok {
		return
	}
	for _, sub := range subs {
		if sub.vmID != "" && sub.vmID != ev.VmId {
			continue
		}
		select {
		case sub.ch <- ev:
		default:
			// dropped — slow consumer
		}
	}
}

// ---------------------------------------------------------------------
// Helpers used by handlers
// ---------------------------------------------------------------------

// SizeKey returns the canonical "vcpu/memory" string the warm-pool
// inventory is keyed by. Centralized here so scheduler and manager
// agree without a comment dance.
func SizeKey(limits *lanternv1.ResourceLimits) string {
	if limits == nil {
		return ""
	}
	return fmt.Sprintf("%s/%s", limits.Vcpu, limits.Memory)
}

// BuildNodeSnapshot adapts an in-memory Node into the slim NodeSnapshot
// the scoring package consumes. Keeping the adapter here means scoring
// stays free of cluster.* imports.
func BuildNodeSnapshot(n Node) scoring.NodeSnapshot {
	return scoring.NodeSnapshot{
		Name:               n.Name,
		Region:             n.Region,
		AvailabilityZone:   n.AvailabilityZone,
		Continent:          n.Continent,
		WarmPoolExact:      n.WarmPoolExact,
		WarmPoolImageOnly:  n.WarmPoolImageOnly,
		IsSpot:             n.IsSpot,
		IsARM:              n.IsARM,
		RecentOOMCount:     n.RecentOOMCount,
		RecentKernelEvents: n.RecentKernelEvents,
		Draining:           n.Draining,
		FreeVcpuMillis:     n.FreeVcpuMillis,
		FreeMemoryBytes:    n.FreeMemoryBytes,
	}
}

// ---------------------------------------------------------------------------
// Capacity parsing helpers (mirrors placement/quantities.go; kept here so
// cluster has no import on placement and the reservation logic is self-contained).
// ---------------------------------------------------------------------------

// parseVcpuMillisCluster parses K8s-style CPU strings ("500m", "2") into millis.
func parseVcpuMillisCluster(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if strings.HasSuffix(s, "m") {
		n, err := strconv.ParseInt(strings.TrimSuffix(s, "m"), 10, 64)
		if err != nil {
			return 0
		}
		return n
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int64(f * 1000)
}

// parseMemBytesCluster parses K8s-style memory strings ("512Mi", "2Gi") into bytes.
func parseMemBytesCluster(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	var mul int64 = 1
	num := s
	switch {
	case strings.HasSuffix(s, "Ki"):
		mul, num = 1024, strings.TrimSuffix(s, "Ki")
	case strings.HasSuffix(s, "Mi"):
		mul, num = 1024*1024, strings.TrimSuffix(s, "Mi")
	case strings.HasSuffix(s, "Gi"):
		mul, num = 1024*1024*1024, strings.TrimSuffix(s, "Gi")
	case strings.HasSuffix(s, "Ti"):
		mul, num = 1024*1024*1024*1024, strings.TrimSuffix(s, "Ti")
	case strings.HasSuffix(s, "K"):
		mul, num = 1000, strings.TrimSuffix(s, "K")
	case strings.HasSuffix(s, "M"):
		mul, num = 1000*1000, strings.TrimSuffix(s, "M")
	case strings.HasSuffix(s, "G"):
		mul, num = 1000*1000*1000, strings.TrimSuffix(s, "G")
	}
	n, err := strconv.ParseInt(strings.TrimSpace(num), 10, 64)
	if err != nil {
		return 0
	}
	return n * mul
}

// StartHeartbeatReaper periodically calls MarkDrainingIfStale. Cancel
// the returned context to stop it.
//
// isLeader gates the MUTATING reap: when it returns false (a standby replica)
// the whole tick body is skipped so MarkDrainingIfStale never flips node state
// off-leader. A nil isLeader means always-reap (single-node / dev).
func StartHeartbeatReaper(ctx context.Context, store ClusterStore, deadline, tick time.Duration, isLeader func() bool, onDrain func(name string)) {
	go func() {
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				if isLeader != nil && !isLeader() {
					continue // standby: do not mutate node state
				}
				flipped := store.MarkDrainingIfStale(now, deadline)
				if onDrain != nil {
					for _, name := range flipped {
						onDrain(name)
					}
				}
			}
		}
	}()
}
