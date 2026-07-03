package cluster_test

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
)

// TestReservation_CreateVMReducesEffectiveCapacity verifies that after
// CreateVM the node's reported free capacity is reduced by the VM's limits,
// so a concurrent Pick() won't over-commit.
func TestReservation_CreateVMReducesEffectiveCapacity(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024, // 8Gi
		LastHeartbeat:   time.Now(),
	})

	vm := &cluster.VM{
		Handle:   &lanternv1.VmHandle{VmId: "vm-1", Node: "n1", CreatedAt: timestamppb.Now()},
		Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "4Gi"}},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t1",
		NodeName: "n1",
	}
	s.CreateVM(vm)

	got, ok := s.GetNode("n1")
	if !ok {
		t.Fatal("node n1 not found")
	}
	if got.FreeVcpuMillis != 2000 {
		t.Errorf("FreeVcpuMillis: got %d, want 2000 (2 vCPU = 2000m reserved)", got.FreeVcpuMillis)
	}
	want4Gi := int64(4 * 1024 * 1024 * 1024)
	if got.FreeMemoryBytes != want4Gi {
		t.Errorf("FreeMemoryBytes: got %d, want %d (4Gi reserved)", got.FreeMemoryBytes, want4Gi)
	}
}

// TestReservation_DeleteVMReleasesCapacity verifies that DeleteVM releases
// the reservation, restoring the effective free capacity.
func TestReservation_DeleteVMReleasesCapacity(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})
	vm := &cluster.VM{
		Handle:   &lanternv1.VmHandle{VmId: "vm-2", Node: "n1", CreatedAt: timestamppb.Now()},
		Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "4Gi"}},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t1",
		NodeName: "n1",
	}
	s.CreateVM(vm)
	s.DeleteVM("vm-2")

	got, _ := s.GetNode("n1")
	if got.FreeVcpuMillis != 4000 {
		t.Errorf("after delete FreeVcpuMillis: got %d, want 4000", got.FreeVcpuMillis)
	}
}

// TestReservation_HeartbeatClearsReservation verifies that a heartbeat
// (UpsertNode) clears the pending reservation because the heartbeat's
// reported capacity is the authoritative real value.
func TestReservation_HeartbeatClearsReservation(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})
	vm := &cluster.VM{
		Handle:   &lanternv1.VmHandle{VmId: "vm-3", Node: "n1", CreatedAt: timestamppb.Now()},
		Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "4Gi"}},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t1",
		NodeName: "n1",
	}
	s.CreateVM(vm)

	// Heartbeat with the actual new free capacity (manager already accounts for the VM).
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  2000, // manager says 2000m free after spawning the VM
		FreeMemoryBytes: 4 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})

	got, _ := s.GetNode("n1")
	// After heartbeat, the reservation is cleared; the heartbeat value is authoritative.
	if got.FreeVcpuMillis != 2000 {
		t.Errorf("after heartbeat FreeVcpuMillis: got %d, want 2000", got.FreeVcpuMillis)
	}
}

// TestReservation_TwoVMsOnSameNode accumulates reservations correctly.
func TestReservation_TwoVMsOnSameNode(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:           "n1",
		FreeVcpuMillis: 8000,
		LastHeartbeat:  time.Now(),
	})

	for i, vmID := range []string{"vm-a", "vm-b"} {
		_ = i
		vm := &cluster.VM{
			Handle:   &lanternv1.VmHandle{VmId: vmID, Node: "n1", CreatedAt: timestamppb.Now()},
			Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2"}},
			State:    lanternv1.VmState_VM_STATE_PENDING,
			TenantID: "t1",
			NodeName: "n1",
		}
		s.CreateVM(vm)
	}

	got, _ := s.GetNode("n1")
	// 8000 - 2000 - 2000 = 4000
	if got.FreeVcpuMillis != 4000 {
		t.Errorf("FreeVcpuMillis after 2 VMs: got %d, want 4000", got.FreeVcpuMillis)
	}
}
