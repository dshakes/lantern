package handlers

// ENFORCEMENT-ON proof for the voice/runtime handler group (voice.go,
// runtime.go, runtime_report.go, runtime_secrets.go) after the P1.1b cutover to
// s.srv.WithTenant.
//
// Runs against the lantern_app-backed harness (newEnforcedServer): every query
// the handlers route through s.srv.WithTenant runs as the non-superuser
// `lantern_app` role with RLS genuinely enforced at Postgres. Proves:
//
//	(a) a SAME-TENANT caller still writes + reads its OWN voice numbers and
//	    runtime VMs (rows returned, NOT zero — the regression check), and
//	(b) a CROSS-TENANT caller sees zero of the other tenant's rows.
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

	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
)

// newEnforcedVoiceHandler builds the voice handler on the RLS-enforced server.
func newEnforcedVoiceHandler(t *testing.T, e *enforcedServer) *VoiceHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return NewVoiceHandler(e.srv, auth)
}

// newEnforcedRuntimeHandler builds the runtime handler on the RLS-enforced
// server with a recording scheduler stub.
func newEnforcedRuntimeHandler(t *testing.T, e *enforcedServer, sched SchedulerClient) *RuntimeHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return &RuntimeHandler{
		srv:       e.srv,
		auth:      auth,
		scheduler: sched,
		identity:  agentidentity.New(auth.JWTSecret()),
	}
}

// createVoiceNumberHTTP drives POST /v1/voice/numbers as the given tenant.
func createVoiceNumberHTTP(t *testing.T, h *VoiceHandler, tenantID, phone string) string {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{
		"agentName":      "voice-agent",
		"provider":       "twilio",
		"phoneNumber":    phone,
		"providerConfig": map[string]any{"accountSid": "AC_test", "authToken": "tok_test"},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/voice/numbers", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateNumber(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create voice number under RLS: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.ID == "" {
		t.Fatalf("create voice number returned empty id: %s", rr.Body.String())
	}
	return out.ID
}

// listVoiceNumberIDs drives GET /v1/voice/numbers and returns the visible IDs.
func listVoiceNumberIDs(t *testing.T, h *VoiceHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/voice/numbers", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListNumbers(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list voice numbers under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
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

// TestRLSVoice_SameTenant_CreateListDelete proves a tenant can create, list, and
// delete its own voice number under RLS — same-tenant writes/reads not broken.
func TestRLSVoice_SameTenant_CreateListDelete(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedVoiceHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-voice-life-"+uuid.NewString()[:8])
	phone := "+1512555" + uuid.NewString()[:4]

	id := createVoiceNumberHTTP(t, h, tenant, phone)

	if !listVoiceNumberIDs(t, h, tenant)[id] {
		t.Fatalf("REGRESSION: same-tenant LIST under RLS did not return its own voice number %q — cutover broke same-tenant reads", id)
	}

	// DELETE its own number → 204.
	tok := mintTestToken(t, tenant, "user-x", "owner")
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/voice/numbers/"+id, nil)
	delReq.SetPathValue("id", id)
	delReq.Header.Set("Authorization", bearerHeader(tok))
	delRR := httptest.NewRecorder()
	h.DeleteNumber(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Fatalf("same-tenant DELETE under RLS: got %d, want 204; body: %s", delRR.Code, delRR.Body.String())
	}
	if listVoiceNumberIDs(t, h, tenant)[id] {
		t.Errorf("voice number %q still listed after delete under RLS", id)
	}
}

// TestRLSVoice_CrossTenant_Blocked proves tenant B cannot see or delete tenant
// A's voice number under RLS.
func TestRLSVoice_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedVoiceHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-voice-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-voice-iso-b-"+uuid.NewString()[:8])

	phone := "+1512556" + uuid.NewString()[:4]
	idA := createVoiceNumberHTTP(t, h, tenantA, phone)

	// (1) Tenant B LIST must not contain A's number.
	if listVoiceNumberIDs(t, h, tenantB)[idA] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST under RLS leaked tenant A's voice number %q", idA)
	}

	// (2) Tenant B DELETE of A's number → 404 (RLS hides the row).
	tok := mintTestToken(t, tenantB, "user-x", "owner")
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/voice/numbers/"+idA, nil)
	delReq.SetPathValue("id", idA)
	delReq.Header.Set("Authorization", bearerHeader(tok))
	delRR := httptest.NewRecorder()
	h.DeleteNumber(delRR, delReq)
	if delRR.Code != http.StatusNotFound {
		t.Errorf("cross-tenant DELETE under RLS: got %d, want 404; body: %s", delRR.Code, delRR.Body.String())
	}

	// (3) Positive control: tenant A still sees its own number.
	if !listVoiceNumberIDs(t, h, tenantA)[idA] {
		t.Errorf("REGRESSION: tenant A's own voice number %q missing from its LIST under RLS", idA)
	}
}

// TestRLSRuntime_SameTenant_ScheduleListVM proves a tenant can schedule a VM
// (write to runtime_vms via WithTenant) and list it back under RLS.
func TestRLSRuntime_SameTenant_ScheduleListVM(t *testing.T) {
	e := newEnforcedServer(t)
	sched := &recScheduler{vmID: "vm-rls-" + uuid.NewString()[:8], node: "node-test", az: "az-test"}
	h := newEnforcedRuntimeHandler(t, e, sched)

	tenant := seedEnforcedTenant(t, e, "rls-rt-life-"+uuid.NewString()[:8])
	tok := mintTestToken(t, tenant, "user-x", "owner")

	w := doSchedule(h, tok, map[string]any{"imageDigest": "sha256:rlsdeadbeef", "isolation": "standard"})
	if w.Code != http.StatusCreated {
		t.Fatalf("same-tenant SCHEDULE under RLS: got %d, want 201; body: %s", w.Code, w.Body.String())
	}

	// LIST VMs → must see its own VM (not zero).
	listReq := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms", nil)
	listReq.Header.Set("Authorization", bearerHeader(tok))
	listRR := httptest.NewRecorder()
	h.ListVMs(listRR, listReq)
	if listRR.Code != http.StatusOK {
		t.Fatalf("same-tenant LIST VMs under RLS: got %d, want 200; body: %s", listRR.Code, listRR.Body.String())
	}
	var vms []struct {
		VmID string `json:"vmId"`
	}
	_ = json.Unmarshal(listRR.Body.Bytes(), &vms)
	found := false
	for _, v := range vms {
		if v.VmID == sched.vmID {
			found = true
		}
	}
	if !found {
		t.Fatalf("REGRESSION: same-tenant LIST VMs under RLS did not return its own VM %q (got %d) — cutover broke same-tenant reads", sched.vmID, len(vms))
	}
}

// TestRLSRuntime_CrossTenant_Blocked proves tenant B cannot see tenant A's VM
// under RLS (direct AppPool count is zero from B's tenant context).
func TestRLSRuntime_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	sched := &recScheduler{vmID: "vm-rls-iso-" + uuid.NewString()[:8], node: "node-test", az: "az-test"}
	h := newEnforcedRuntimeHandler(t, e, sched)

	tenantA := seedEnforcedTenant(t, e, "rls-rt-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-rt-iso-b-"+uuid.NewString()[:8])

	tokA := mintTestToken(t, tenantA, "user-x", "owner")
	if w := doSchedule(h, tokA, map[string]any{"imageDigest": "sha256:rlsiso", "isolation": "standard"}); w.Code != http.StatusCreated {
		t.Fatalf("schedule A under RLS: got %d; body: %s", w.Code, w.Body.String())
	}

	// (1) Tenant B LIST VMs must not contain A's VM.
	tokB := mintTestToken(t, tenantB, "user-x", "owner")
	listReq := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms", nil)
	listReq.Header.Set("Authorization", bearerHeader(tokB))
	listRR := httptest.NewRecorder()
	h.ListVMs(listRR, listReq)
	var vms []struct {
		VmID string `json:"vmId"`
	}
	_ = json.Unmarshal(listRR.Body.Bytes(), &vms)
	for _, v := range vms {
		if v.VmID == sched.vmID {
			t.Errorf("SECURITY VIOLATION: tenant B's LIST VMs under RLS leaked tenant A's VM %q", sched.vmID)
		}
	}

	// (2) Direct AppPool count of A's VM from B's tenant context must be zero.
	var leak int
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			"SELECT COUNT(*) FROM runtime_vms WHERE vm_id = $1", sched.vmID,
		).Scan(&leak)
	})
	if leak != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's runtime_vms rows under RLS, want 0", leak)
	}
}
