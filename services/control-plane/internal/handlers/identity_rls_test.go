package handlers

// ENFORCEMENT-ON proof for the identity/people/memory handler group
// (identity.go) after the P1.1b cutover to s.srv.WithTenant.
//
// Runs against the lantern_app-backed harness (newEnforcedServer): every query
// the handlers route through s.srv.WithTenant is executed by the non-superuser
// `lantern_app` role with RLS genuinely enforced at Postgres. Proves:
//
//	(a) a SAME-TENANT caller still resolves people, ingests events, and reads
//	    them back (rows returned, NOT zero — the critical regression check), and
//	(b) a CROSS-TENANT caller sees zero of the other tenant's people.
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

// newEnforcedIdentityHandler builds the identity handler on the RLS-enforced
// server. The LLM proxy is nil — embeddings degrade gracefully, and none of the
// DB-isolation assertions depend on them.
func newEnforcedIdentityHandler(t *testing.T, e *enforcedServer) *IdentityHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return NewIdentityHandler(e.srv, auth, nil)
}

// resolvePersonHTTP drives POST /v1/people/resolve as the given tenant and
// returns the decoded body.
func resolvePersonHTTP(t *testing.T, h *IdentityHandler, tenantID, channel, handle, displayName string) map[string]any {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]string{"channel": channel, "handle": handle, "displayName": displayName})
	req := httptest.NewRequest(http.MethodPost, "/v1/people/resolve", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ResolvePerson(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("resolve person under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode resolve body: %v", err)
	}
	return out
}

// listPeopleIDs drives GET /v1/people as the given tenant and returns the set
// of person IDs visible to it.
func listPeopleIDs(t *testing.T, h *IdentityHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/people", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListPeople(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list people under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		People []struct {
			ID string `json:"id"`
		} `json:"people"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list people: %v", err)
	}
	ids := map[string]bool{}
	for _, p := range out.People {
		ids[p.ID] = true
	}
	return ids
}

// TestRLSIdentity_SameTenant_ResolveIngestRead proves that under RLS enforcement
// the owning tenant can resolve a person, ingest a memory event, and read both
// back — the WithTenant cutover did NOT break same-tenant reads/writes.
func TestRLSIdentity_SameTenant_ResolveIngestRead(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedIdentityHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-id-life-"+uuid.NewString()[:8])

	// RESOLVE (lookup→insert→handle attach through WithTenant, under RLS WITH CHECK).
	resolved := resolvePersonHTTP(t, h, tenant, "whatsapp", "15125550111", "RLS Contact")
	personID, _ := resolved["personId"].(string)
	if personID == "" {
		t.Fatalf("resolve returned empty personId: %v", resolved)
	}

	// LIST (read through WithTenant → must SEE its own person, not zero).
	if !listPeopleIDs(t, h, tenant)[personID] {
		t.Fatalf("REGRESSION: same-tenant LIST under RLS did not return its own person %q — cutover broke same-tenant reads", personID)
	}

	// INGEST (write a memory_event through WithTenant → must succeed).
	tok := mintTestToken(t, tenant, "user-x", "owner")
	ingBody, _ := json.Marshal(map[string]any{
		"personId": personID,
		"channel":  "whatsapp",
		"kind":     "message",
		"content":  "rls same-tenant timeline event",
	})
	ingReq := httptest.NewRequest(http.MethodPost, "/v1/memory/events", bytes.NewReader(ingBody))
	ingReq.Header.Set("Authorization", bearerHeader(tok))
	ingRR := httptest.NewRecorder()
	h.IngestEvent(ingRR, ingReq)
	if ingRR.Code != http.StatusCreated {
		t.Fatalf("same-tenant INGEST under RLS: got %d, want 201; body: %s", ingRR.Code, ingRR.Body.String())
	}

	// CONTEXT read of the event back (through WithTenant).
	ctxReq := httptest.NewRequest(http.MethodGet, "/v1/memory/context?personId="+personID, nil)
	ctxReq.Header.Set("Authorization", bearerHeader(tok))
	ctxRR := httptest.NewRecorder()
	h.GetContext(ctxRR, ctxReq)
	if ctxRR.Code != http.StatusOK {
		t.Fatalf("same-tenant CONTEXT under RLS: got %d, want 200; body: %s", ctxRR.Code, ctxRR.Body.String())
	}
	var ctxOut struct {
		Events []map[string]any `json:"events"`
	}
	_ = json.Unmarshal(ctxRR.Body.Bytes(), &ctxOut)
	if len(ctxOut.Events) == 0 {
		t.Errorf("REGRESSION: same-tenant CONTEXT under RLS returned zero events for its own person — cutover broke the timeline read")
	}
}

// TestRLSIdentity_CrossTenant_Blocked proves that under RLS enforcement tenant B
// cannot see tenant A's people, and a resolve by B for A's handle creates a
// DISTINCT person in B's tenant (never crosses the boundary).
func TestRLSIdentity_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedIdentityHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-id-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-id-iso-b-"+uuid.NewString()[:8])

	a := resolvePersonHTTP(t, h, tenantA, "whatsapp", "15125550222", "A Person")
	personA, _ := a["personId"].(string)
	if personA == "" {
		t.Fatalf("resolve A returned empty personId: %v", a)
	}

	// (1) Tenant B LIST must not contain A's person.
	if listPeopleIDs(t, h, tenantB)[personA] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST under RLS leaked tenant A's person %q", personA)
	}

	// (2) Tenant B resolving the SAME handle must mint a DISTINCT person row in
	// B's tenant — it can never resolve to A's person under RLS.
	b := resolvePersonHTTP(t, h, tenantB, "whatsapp", "15125550222", "B Person")
	personB, _ := b["personId"].(string)
	if personB == "" || personB == personA {
		t.Errorf("SECURITY VIOLATION: tenant B resolve under RLS returned tenant A's person (a=%q b=%q)", personA, personB)
	}

	// (3) Positive control: tenant A still sees its own person.
	if !listPeopleIDs(t, h, tenantA)[personA] {
		t.Errorf("REGRESSION: tenant A's own person %q missing from its LIST under RLS", personA)
	}

	// (4) Direct AppPool count of A's person from B's tenant context must be zero.
	var leak int
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			"SELECT COUNT(*) FROM people WHERE id = $1", personA,
		).Scan(&leak)
	})
	if leak != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's people rows under RLS, want 0", leak)
	}
}
