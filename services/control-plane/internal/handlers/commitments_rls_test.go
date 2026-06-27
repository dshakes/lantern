package handlers

// RLS enforcement tests for the commitments domain. Uses the newEnforcedServer
// harness (lantern_app-backed AppPool) to prove RLS is genuinely enforced at
// the Postgres layer — not just GUC-scoped on the superuser pool.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// newEnforcedCommitmentHandler builds the handler on the RLS-enforced server.
func newEnforcedCommitmentHandler(t *testing.T, e *enforcedServer) *CommitmentHandler {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return NewCommitmentHandler(e.srv, auth)
}

// TestRLSCommitments_SameTenantWorks proves that a same-tenant create + read
// works correctly under genuine RLS enforcement (AppPool as lantern_app).
func TestRLSCommitments_SameTenantWorks(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedCommitmentHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-cm-"+uuid.NewString()[:8])

	// Create under RLS (WITH CHECK must admit the insert).
	rr := postCommitment(t, h, tenant, map[string]any{
		"title":   "Book dentist",
		"source":  "self",
		"urgency": "soon",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("REGRESSION: same-tenant create under RLS failed: %d; body: %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	// List reads own row (NOT zero).
	items := listCommitments(t, h, tenant, "")
	if len(items) != 1 {
		t.Fatalf("REGRESSION: same-tenant list under RLS returned %d rows, want 1", len(items))
	}
	if items[0].ID != created.ID {
		t.Errorf("id mismatch: listed=%q created=%q", items[0].ID, created.ID)
	}

	// GET own row works.
	got, code := getCommitment(t, h, tenant, created.ID)
	if code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant get under RLS: %d", code)
	}
	if got.Title != "Book dentist" {
		t.Errorf("title=%q, want 'Book dentist'", got.Title)
	}

	// done transition works.
	if rr2 := commitmentTransition(t, h, tenant, created.ID, "done", nil); rr2.Code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant done under RLS: %d; body: %s", rr2.Code, rr2.Body.String())
	}
}

// TestRLSCommitments_CrossTenantBlocked proves that cross-tenant reads and
// writes are blocked at the Postgres layer under genuine RLS enforcement.
func TestRLSCommitments_CrossTenantBlocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedCommitmentHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-cm-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-cm-b-"+uuid.NewString()[:8])

	// Seed a commitment as tenant A.
	rr := postCommitment(t, h, tenantA, map[string]any{
		"title": "Private task A", "source": "spouse",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("seed: %d; body: %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	// Tenant B list → zero rows (blocked at Postgres).
	if got := listCommitments(t, h, tenantB, ""); len(got) != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's commitments under RLS, want 0", len(got))
	}

	// Tenant B GET tenant A's row → 404.
	if _, code := getCommitment(t, h, tenantB, created.ID); code != http.StatusNotFound {
		t.Errorf("cross-tenant GET: got %d, want 404", code)
	}

	// Tenant B PUT on tenant A's row → 404.
	b, _ := json.Marshal(map[string]any{"tier": "nano"})
	req := httptest.NewRequest(http.MethodPut, "/v1/commitments/"+created.ID, strings.NewReader(string(b)))
	req.SetPathValue("id", created.ID)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantB, "user-x", "owner")))
	rrPut := httptest.NewRecorder()
	h.UpdateCommitment(rrPut, req)
	if rrPut.Code != http.StatusNotFound {
		t.Errorf("cross-tenant PUT: got %d, want 404", rrPut.Code)
	}

	// Tenant B done/dismiss on tenant A's row → 404.
	for _, action := range []string{"done", "dismiss"} {
		if rr2 := commitmentTransition(t, h, tenantB, created.ID, action, nil); rr2.Code != http.StatusNotFound {
			t.Errorf("cross-tenant %s: got %d, want 404", action, rr2.Code)
		}
	}
}
