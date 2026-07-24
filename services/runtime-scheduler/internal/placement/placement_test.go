package placement_test

import (
	"testing"
	"time"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/placement"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/scoring"
)

func newEngine(store cluster.ClusterStore) *placement.Engine {
	return &placement.Engine{Store: store, Weights: scoring.DefaultWeights()}
}

// TestHint_RejectsInsufficientVCPU verifies that a node hint to a node without
// enough vCPU returns an error instead of over-committing the node.
func TestHint_RejectsInsufficientVCPU(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:           "n1",
		FreeVcpuMillis: 500, // only 500m free
		LastHeartbeat:  time.Now(),
	})

	e := newEngine(s)
	spec := &lanternv1.AgentSpec{
		ImageDigest: "sha256:abc",
		TenantId:    "t1",
		Limits:      &lanternv1.ResourceLimits{Vcpu: "2"}, // needs 2000m
	}
	hint := &lanternv1.PlacementHint{Node: "n1"}

	_, err := e.Pick(spec, hint, 10)
	if err == nil {
		t.Fatal("expected error for hinted node with insufficient vCPU, got nil")
	}
}

// TestHint_RejectsInsufficientMemory verifies the same for memory.
func TestHint_RejectsInsufficientMemory(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  8000,
		FreeMemoryBytes: 512 * 1024 * 1024, // 512Mi free
		LastHeartbeat:   time.Now(),
	})

	e := newEngine(s)
	spec := &lanternv1.AgentSpec{
		ImageDigest: "sha256:abc",
		TenantId:    "t1",
		Limits:      &lanternv1.ResourceLimits{Memory: "2Gi"}, // needs 2Gi
	}
	hint := &lanternv1.PlacementHint{Node: "n1"}

	_, err := e.Pick(spec, hint, 10)
	if err == nil {
		t.Fatal("expected error for hinted node with insufficient memory, got nil")
	}
}

// TestHint_AcceptsAdequateCapacity verifies that a valid hint with enough
// capacity still succeeds.
func TestHint_AcceptsAdequateCapacity(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  8000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})

	e := newEngine(s)
	spec := &lanternv1.AgentSpec{
		ImageDigest: "sha256:abc",
		TenantId:    "t1",
		Limits:      &lanternv1.ResourceLimits{Vcpu: "2", Memory: "2Gi"},
	}
	hint := &lanternv1.PlacementHint{Node: "n1"}

	d, err := e.Pick(spec, hint, 10)
	if err != nil {
		t.Fatalf("expected success, got: %v", err)
	}
	if d.NodeName != "n1" {
		t.Errorf("NodeName: got %q, want n1", d.NodeName)
	}
}

// Confidential workloads must land ONLY on CC-capable nodes.
func TestConfidential_PlacesOnlyOnCCNode(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name: "plain", FreeVcpuMillis: 8000, FreeMemoryBytes: 8 << 30, LastHeartbeat: time.Now(),
	})
	s.UpsertNode(cluster.Node{
		Name: "cc", CCCapable: true, CCTech: "sev-snp",
		FreeVcpuMillis: 8000, FreeMemoryBytes: 8 << 30, LastHeartbeat: time.Now(),
	})
	e := newEngine(s)
	spec := &lanternv1.AgentSpec{
		ImageDigest:  "sha256:abc",
		TenantId:     "t1",
		Confidential: true,
		Limits:       &lanternv1.ResourceLimits{Vcpu: "2", Memory: "2Gi"},
	}
	d, err := e.Pick(spec, nil, 10)
	if err != nil {
		t.Fatalf("expected placement on the CC node, got error: %v", err)
	}
	if d.NodeName != "cc" {
		t.Errorf("confidential workload placed on %q, want cc", d.NodeName)
	}
}

// With NO CC-capable node, a confidential workload hits the no-suitable-node
// path (upstream → microvm_unavailable). Never downgraded onto a plain node.
func TestConfidential_NoCCNode_NoSuitableNode(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name: "plain", FreeVcpuMillis: 8000, FreeMemoryBytes: 8 << 30, LastHeartbeat: time.Now(),
	})
	e := newEngine(s)
	spec := &lanternv1.AgentSpec{
		ImageDigest: "sha256:abc", TenantId: "t1", Confidential: true,
		Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "2Gi"},
	}
	if _, err := e.Pick(spec, nil, 10); err == nil {
		t.Fatal("expected no-suitable-node error for confidential workload with no CC node, got nil")
	}
}

// A non-confidential workload is unaffected by the CC filter — places anywhere.
func TestNonConfidential_PlacesOnPlainNode(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name: "plain", FreeVcpuMillis: 8000, FreeMemoryBytes: 8 << 30, LastHeartbeat: time.Now(),
	})
	e := newEngine(s)
	spec := &lanternv1.AgentSpec{
		ImageDigest: "sha256:abc", TenantId: "t1", // Confidential defaults false
		Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "2Gi"},
	}
	d, err := e.Pick(spec, nil, 10)
	if err != nil {
		t.Fatalf("non-confidential workload should place on any node, got error: %v", err)
	}
	if d.NodeName != "plain" {
		t.Errorf("got %q, want plain", d.NodeName)
	}
}
