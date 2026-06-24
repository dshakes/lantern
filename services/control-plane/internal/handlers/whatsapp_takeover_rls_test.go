package handlers

// ENFORCEMENT-ON proof for the whatsapp/feedback/receipts/takeover handler
// group after the P1.1b cutover to s.srv.WithTenant.
//
// Runs against the lantern_app-backed harness (newEnforcedServer). Proves:
//
//	(a) a SAME-TENANT caller still writes + reads its OWN takeover requests and
//	    WhatsApp VIP contacts (rows returned, NOT zero — the regression check), and
//	(b) a CROSS-TENANT caller sees zero of the other tenant's rows.
//
// marketplace*.go is intentionally NOT covered here: its tenant-scoped sites are
// cross-tenant by design and remain on the privileged Pool with // rls-exempt
// markers per ADR 0011, so there is nothing to assert under enforcement.
//
// Skipped automatically when DATABASE_URL is unset (harness skips).

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func newEnforcedTakeoverHandler(t *testing.T, e *enforcedServer) *TakeoverHandler {
	t.Helper()
	return NewTakeoverHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

func newEnforcedWhatsAppHandler(t *testing.T, e *enforcedServer) *WhatsAppPersonalHandler {
	t.Helper()
	return NewWhatsAppPersonalHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

// requestTakeoverID drives POST /v1/runs/{id}/takeover/request and returns the id.
func requestTakeoverID(t *testing.T, h *TakeoverHandler, tenantID, runID string) string {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"reason": "rls test"})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs/"+runID+"/takeover/request", bytes.NewReader(body))
	req.SetPathValue("id", runID)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.Request(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("request takeover under RLS: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.ID == "" {
		t.Fatalf("request takeover returned empty id: %s", rr.Body.String())
	}
	return out.ID
}

// listTakeoverIDs drives GET /v1/runs/{id}/takeover and returns the visible ids.
func listTakeoverIDs(t *testing.T, h *TakeoverHandler, tenantID, runID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/runs/"+runID+"/takeover", nil)
	req.SetPathValue("id", runID)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListForRun(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list takeovers under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var rows []struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &rows)
	ids := map[string]bool{}
	for _, r := range rows {
		ids[r.ID] = true
	}
	return ids
}

// TestRLSTakeover_SameTenant_RequestList proves a tenant can create + list its
// own takeover request under RLS.
func TestRLSTakeover_SameTenant_RequestList(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedTakeoverHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-tko-life-"+uuid.NewString()[:8])
	runID := uuid.NewString()

	id := requestTakeoverID(t, h, tenant, runID)
	if !listTakeoverIDs(t, h, tenant, runID)[id] {
		t.Fatalf("REGRESSION: same-tenant LIST takeovers under RLS did not return its own request %q — cutover broke same-tenant reads", id)
	}
}

// TestRLSTakeover_CrossTenant_Blocked proves tenant B cannot see tenant A's
// takeover request (even for the same run_id).
func TestRLSTakeover_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedTakeoverHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-tko-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-tko-iso-b-"+uuid.NewString()[:8])
	runID := uuid.NewString()

	idA := requestTakeoverID(t, h, tenantA, runID)

	// Tenant B querying the SAME run_id must see none of A's takeover rows.
	if listTakeoverIDs(t, h, tenantB, runID)[idA] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST takeovers under RLS leaked tenant A's request %q", idA)
	}
	if !listTakeoverIDs(t, h, tenantA, runID)[idA] {
		t.Errorf("REGRESSION: tenant A's own takeover %q missing from its LIST under RLS", idA)
	}

	// Direct AppPool count of A's takeover from B's tenant context must be zero.
	var leak int
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			"SELECT COUNT(*) FROM takeover_requests WHERE id = $1", idA,
		).Scan(&leak)
	})
	if leak != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's takeover_requests rows under RLS, want 0", leak)
	}
}

// addVIPJIDs drives GET /v1/whatsapp/vips and returns the set of JIDs.
func listVIPJIDs(t *testing.T, h *WhatsAppPersonalHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/whatsapp/vips", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListVIPs(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list VIPs under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		VIPs []struct {
			JID string `json:"jid"`
		} `json:"vips"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	jids := map[string]bool{}
	for _, v := range out.VIPs {
		jids[v.JID] = true
	}
	return jids
}

func addVIP(t *testing.T, h *WhatsAppPersonalHandler, tenantID, jid string) {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"jid": jid, "displayName": "RLS VIP"})
	req := httptest.NewRequest(http.MethodPost, "/v1/whatsapp/vips", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.AddVIP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("add VIP under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// TestRLSWhatsAppVIP_SameTenant_AddList proves a tenant can add + list its own
// VIP contact under RLS.
func TestRLSWhatsAppVIP_SameTenant_AddList(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedWhatsAppHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-vip-life-"+uuid.NewString()[:8])
	jid := "1512555" + uuid.NewString()[:6] + "@s.whatsapp.net"

	addVIP(t, h, tenant, jid)
	if !listVIPJIDs(t, h, tenant)[jid] {
		t.Fatalf("REGRESSION: same-tenant LIST VIPs under RLS did not return its own VIP %q — cutover broke same-tenant reads", jid)
	}
}

// TestRLSWhatsAppVIP_CrossTenant_Blocked proves tenant B cannot see tenant A's VIP.
func TestRLSWhatsAppVIP_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedWhatsAppHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-vip-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-vip-iso-b-"+uuid.NewString()[:8])
	jid := "1512556" + uuid.NewString()[:6] + "@s.whatsapp.net"

	addVIP(t, h, tenantA, jid)

	if listVIPJIDs(t, h, tenantB)[jid] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST VIPs under RLS leaked tenant A's VIP %q", jid)
	}
	if !listVIPJIDs(t, h, tenantA)[jid] {
		t.Errorf("REGRESSION: tenant A's own VIP %q missing from its LIST under RLS", jid)
	}
}
