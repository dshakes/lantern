package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// TestSchedule_Confidential_PersistsFlag proves the full HTTP → specMap →
// agentSpecFromMap → runtime_vms path carries `confidential:true` and persists
// it on the shadow row (ADR 0023).
func TestSchedule_Confidential_PersistsFlag(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-cc")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	sched := &recScheduler{vmID: "vm-cc-test-1", node: "cc-node", az: "az-cc"}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-cc-1", "owner")

	w := doSchedule(h, tok, map[string]any{
		"imageDigest":  "sha256:cc",
		"isolation":    "standard",
		"confidential": true,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var confidential bool
	if err := pool.QueryRow(context.Background(), `
		SELECT confidential FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2
	`, "vm-cc-test-1", tenantID).Scan(&confidential); err != nil {
		t.Fatalf("query runtime_vms.confidential: %v", err)
	}
	if !confidential {
		t.Error("runtime_vms.confidential = false, want true (confidential flag must persist)")
	}
}

// seedCCRun inserts an agent + promoted version + a completed run, returning
// the run id. Satisfies the runs FK constraints the receipt query joins on.
func seedCCRun(t *testing.T, pool *pgxpool.Pool, tenantID, agentName string) string {
	t.Helper()
	ctx := context.Background()
	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'cc receipt test fixture') RETURNING id::text
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-cc', decode(md5($2), 'hex'), 'local://cc', '{}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("seed version: %v", err)
	}
	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'completed', 'api', '{}'::jsonb) RETURNING id::text
	`, tenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, "DELETE FROM runs WHERE id=$1::uuid", runID)
		_, _ = pool.Exec(bg, "DELETE FROM agent_versions WHERE agent_id=$1::uuid", agentID)
		_, _ = pool.Exec(bg, "DELETE FROM agents WHERE id=$1::uuid", agentID)
	})
	return runID
}

// TestBuildReceipt_ConfidentialComputeBlock proves that a receipt for a
// confidential run carries the additive confidential_compute block with
// attested=false (the measurement is RECORDED, never validated on hardware).
func TestBuildReceipt_ConfidentialComputeBlock(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-ccr")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	ctx := middleware.InjectTenantID(context.Background(), tenantID)
	runID := seedCCRun(t, pool, tenantID, "cc-receipt-agent")

	if _, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, run_id, state, spec, confidential, cc_tech, attestation)
		VALUES ($1, $2, $3, 'running', '{}'::jsonb, TRUE, 'sev-snp',
		        '{"runtime_class":"kata-qemu-snp","measurement_sha256":"abc123"}'::jsonb)
	`, "vm-ccr-1", tenantID, runID); err != nil {
		t.Fatalf("seed confidential runtime_vms: %v", err)
	}

	h := &ReceiptHandler{srv: &server.Server{Pool: pool}}
	rc, err := h.buildReceipt(ctx, tenantID, runID)
	if err != nil {
		t.Fatalf("buildReceipt: %v", err)
	}
	block := rc.Payload.ConfidentialCompute
	if block == nil {
		t.Fatal("confidential run must carry a confidentialCompute block")
	}
	if !block.Requested {
		t.Error("block.Requested = false, want true")
	}
	if block.Attested {
		t.Error("block.Attested = true, want false (UNVERIFIED — never validated on hardware)")
	}
	if block.Tech != "sev-snp" {
		t.Errorf("block.Tech = %q, want sev-snp", block.Tech)
	}
	if block.RuntimeClass != "kata-qemu-snp" {
		t.Errorf("block.RuntimeClass = %q, want kata-qemu-snp", block.RuntimeClass)
	}
	if block.MeasurementSHA256 != "abc123" {
		t.Errorf("block.MeasurementSHA256 = %q, want abc123", block.MeasurementSHA256)
	}
}

// TestBuildReceipt_NonConfidential_OmitsBlock proves the block is absent (nil)
// for a non-confidential run — existing receipts stay byte-identical.
func TestBuildReceipt_NonConfidential_OmitsBlock(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-ccn")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	ctx := middleware.InjectTenantID(context.Background(), tenantID)
	runID := seedCCRun(t, pool, tenantID, "cc-noncc-agent")

	// No runtime_vms row at all → not confidential.
	h := &ReceiptHandler{srv: &server.Server{Pool: pool}}
	rc, err := h.buildReceipt(ctx, tenantID, runID)
	if err != nil {
		t.Fatalf("buildReceipt: %v", err)
	}
	if rc.Payload.ConfidentialCompute != nil {
		t.Error("non-confidential run must NOT carry a confidentialCompute block")
	}
}

// TestBuildReceipt_SoftwareMeasurement verifies the host-asserted measurement
// (ADR 0031) lands in the signed receipt payload for a NON-confidential VM,
// independent of the confidential-compute block.
func TestBuildReceipt_SoftwareMeasurement(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-swm")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	ctx := middleware.InjectTenantID(context.Background(), tenantID)
	runID := seedCCRun(t, pool, tenantID, "swm-agent")

	const m = "5f2b8c0d9e1a4b7c6d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c"
	if _, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, run_id, state, spec, software_measurement)
		VALUES ($1, $2, $3, 'running', '{}'::jsonb, $4)
	`, "vm-swm-1", tenantID, runID, m); err != nil {
		t.Fatalf("seed runtime_vms: %v", err)
	}

	h := &ReceiptHandler{srv: &server.Server{Pool: pool}}
	rc, err := h.buildReceipt(ctx, tenantID, runID)
	if err != nil {
		t.Fatalf("buildReceipt: %v", err)
	}
	if rc.Payload.SoftwareMeasurement != m {
		t.Errorf("SoftwareMeasurement = %q, want %q", rc.Payload.SoftwareMeasurement, m)
	}
	if rc.Payload.ConfidentialCompute != nil {
		t.Error("non-confidential run must NOT carry a confidentialCompute block")
	}
}

// measurementScheduler reports one live VM for one tenant (errors for any
// other tenant so the sweep never touches rows it does not own).
type measurementScheduler struct {
	recScheduler
	tenant string
	states map[string]VMStateInfo
}

func (m *measurementScheduler) ListStates(_ context.Context, tenantID string) (map[string]VMStateInfo, error) {
	if tenantID != m.tenant {
		return nil, errors.New("not this test's tenant")
	}
	return m.states, nil
}

// TestReconcile_SoftwareMeasurement_WriteOnce (ADR 0031, S3): the reconciler
// records the scheduler-reported measurement even when the VM's state is
// unchanged, and never overwrites or clears it on later sweeps.
func TestReconcile_SoftwareMeasurement_WriteOnce(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)

	tenantID := uniqueTenantID("tenant-rec-swm")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })
	ctx := context.Background()
	const vmID = "vm-rec-swm"
	if _, err := pool.Exec(ctx, `
		INSERT INTO runtime_vms (vm_id, tenant_id, state, spec)
		VALUES ($1, $2, 'running', '{}'::jsonb)
	`, vmID, tenantID); err != nil {
		t.Fatalf("seed runtime_vms: %v", err)
	}
	read := func() string {
		var m *string
		if err := pool.QueryRow(ctx, `SELECT software_measurement FROM runtime_vms WHERE vm_id = $1`, vmID).Scan(&m); err != nil {
			t.Fatalf("read measurement: %v", err)
		}
		if m == nil {
			return ""
		}
		return *m
	}

	first := strings.Repeat("1a", 32)
	sched := &measurementScheduler{tenant: tenantID, states: map[string]VMStateInfo{
		vmID: {State: "running", SoftwareMeasurement: first}, // state unchanged
	}}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)

	h.reconcileOnce()
	if got := read(); got != first {
		t.Fatalf("after first sweep measurement = %q, want %q", got, first)
	}
	sched.states[vmID] = VMStateInfo{State: "running", SoftwareMeasurement: strings.Repeat("2b", 32)}
	h.reconcileOnce()
	if got := read(); got != first {
		t.Fatalf("measurement overwritten: %q, want %q (write-once)", got, first)
	}
	sched.states[vmID] = VMStateInfo{State: "running"}
	h.reconcileOnce()
	if got := read(); got != first {
		t.Fatalf("measurement cleared: %q, want %q", got, first)
	}
}
