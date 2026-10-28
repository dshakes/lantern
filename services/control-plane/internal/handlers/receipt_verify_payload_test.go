package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// Regression: with a stored receipt, verify only compared signatures, so an
// edited payload (costUsd, status) carrying the original signature came back
// valid:true — the receipt proved nothing about its own contents.
func TestVerifyReceipt_RejectsEditedPayload(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)
	tenantID := uniqueTenantID("tenant-rcpt")
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupTenant(t, pool, tenantID) })

	ctx := middleware.InjectTenantID(context.Background(), tenantID)
	runID := seedCCRun(t, pool, tenantID, "receipt-verify-agent")
	h := &ReceiptHandler{srv: &server.Server{Pool: pool}}
	rc, err := h.buildReceipt(ctx, tenantID, runID)
	if err != nil {
		t.Fatalf("buildReceipt: %v", err)
	}
	if err := h.persistReceipt(ctx, tenantID, runID, rc); err != nil {
		t.Fatalf("persistReceipt: %v", err)
	}

	verify := func(r signedReceipt) map[string]any {
		body, _ := json.Marshal(r)
		w := httptest.NewRecorder()
		h.VerifyReceipt(w, httptest.NewRequest(http.MethodPost, "/v1/runs/receipts/verify", bytes.NewReader(body)))
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}

	if out := verify(*rc); out["valid"] != true {
		t.Fatalf("genuine receipt: %v", out)
	}
	edited := *rc
	edited.Payload.CostUsd = rc.Payload.CostUsd + 99
	if out := verify(edited); out["valid"] != false {
		t.Errorf("edited costUsd with the original signature must fail: %v", out)
	}
	edited = *rc
	edited.Payload.Status = "succeeded-but-not-really"
	if out := verify(edited); out["valid"] != false {
		t.Errorf("edited status with the original signature must fail: %v", out)
	}
	wrongSig := *rc
	wrongSig.Signature = "AAAA" + rc.Signature[4:]
	if out := verify(wrongSig); out["valid"] != false {
		t.Errorf("wrong signature must fail: %v", out)
	}
}
