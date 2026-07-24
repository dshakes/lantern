package handlers

import (
	"context"
	"net/http"
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
