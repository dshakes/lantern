package handlers

// Exec must be dispatched to the runtime-manager on the VM's OWN node.
//
// Regression: Exec originally dialed managerClient("") — always the default
// manager address. On a single-node dev box that is indistinguishable from
// correct, but in a multi-node deployment a workload placed on node-B would
// have its exec sent to node-A's manager, which has no such container. These
// tests pin the node actually threaded through from runtime_vms.node.

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedRuntimeVM inserts a runtime_vms row placed on the given node.
func seedRuntimeVM(t *testing.T, pool *pgxpool.Pool, tenantID, vmID, node string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, node, az, isolation_class, state, spec)
		VALUES ($1, $2, $3, 'az-1', 'docker', 'running', '{}'::jsonb)
		ON CONFLICT (vm_id) DO UPDATE SET node = EXCLUDED.node, state = 'running'
	`, vmID, tenantID, node)
	if err != nil {
		t.Fatalf("seed runtime_vms: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, vmID)
	})
}

func TestExecVM_DispatchesToVMsOwnNode(t *testing.T) {
	pool := openTestPool(t) // skips when DATABASE_URL unset
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)

	const wantNode = "node-b-far-away"
	vmID := "vm-" + uuid.NewString()
	seedRuntimeVM(t, pool, tenantID, vmID, wantNode)

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-1", "owner")

	w := doExec(h, tok, vmID)
	if w.Code != http.StatusOK {
		t.Fatalf("ExecVM: got %d, body=%s", w.Code, w.Body.String())
	}
	if sched.execNode != wantNode {
		t.Errorf("exec dispatched to node %q, want %q — a default address misroutes in multi-node deployments", sched.execNode, wantNode)
	}
}

// A NULL node (placement not recorded) must degrade to the default manager
// rather than erroring — that is the single-node dev path.
func TestExecVM_NullNodeFallsBackToDefaultManager(t *testing.T) {
	pool := openTestPool(t)
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)

	vmID := "vm-" + uuid.NewString()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, node, az, isolation_class, state, spec)
		VALUES ($1, $2, NULL, 'az-1', 'docker', 'running', '{}'::jsonb)
	`, vmID, tenantID); err != nil {
		t.Fatalf("seed runtime_vms: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, vmID)
	})

	sched := &recScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-1", "owner")

	w := doExec(h, tok, vmID)
	if w.Code != http.StatusOK {
		t.Fatalf("ExecVM: got %d, body=%s", w.Code, w.Body.String())
	}
	if sched.execNode != "" {
		t.Errorf("exec node = %q, want \"\" (resolves to the default manager)", sched.execNode)
	}
}
