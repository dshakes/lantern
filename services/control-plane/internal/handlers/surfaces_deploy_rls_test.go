package handlers

// ENFORCEMENT-ON proof for the surfaces/schedules/deployments/api_keys/dataplane
// handler group after the P1.1b cutover to s.srv.WithTenant.
//
// Runs against the lantern_app-backed harness (newEnforcedServer). Proves:
//
//	(a) a SAME-TENANT caller still writes + reads its OWN surfaces, API keys, and
//	    deployments (rows returned, NOT zero — the regression check), and
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
)

func newEnforcedSurfaceHandler(t *testing.T, e *enforcedServer) *SurfaceHandler {
	t.Helper()
	return NewSurfaceHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

func newEnforcedApiKeyHandler(t *testing.T, e *enforcedServer) *ApiKeyHandler {
	t.Helper()
	return NewApiKeyHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

func newEnforcedDeploymentHandler(t *testing.T, e *enforcedServer) *DeploymentHandler {
	t.Helper()
	return NewDeploymentHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

// configureSurfaceID drives POST /v1/surfaces and returns the new id.
func configureSurfaceID(t *testing.T, h *SurfaceHandler, tenantID, surfaceID string) string {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{
		"surfaceId":   surfaceID,
		"displayName": "RLS Surface",
		"config":      map[string]any{"k": "v"},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/surfaces", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ConfigureSurface(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("configure surface under RLS: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.ID == "" {
		t.Fatalf("configure surface returned empty id: %s", rr.Body.String())
	}
	return out.ID
}

// listSurfaceIDs drives GET /v1/surfaces and returns the visible ids.
func listSurfaceIDs(t *testing.T, h *SurfaceHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/surfaces", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListSurfaces(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list surfaces under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
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

// TestRLSSurfaces_SameTenant_ConfigureList proves a tenant can configure + list
// its own surface under RLS.
func TestRLSSurfaces_SameTenant_ConfigureList(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedSurfaceHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-surf-life-"+uuid.NewString()[:8])
	id := configureSurfaceID(t, h, tenant, "slack")

	if !listSurfaceIDs(t, h, tenant)[id] {
		t.Fatalf("REGRESSION: same-tenant LIST surfaces under RLS did not return its own surface %q — cutover broke same-tenant reads", id)
	}
}

// TestRLSSurfaces_CrossTenant_Blocked proves tenant B cannot see tenant A's surface.
func TestRLSSurfaces_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedSurfaceHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-surf-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-surf-iso-b-"+uuid.NewString()[:8])

	idA := configureSurfaceID(t, h, tenantA, "telegram")

	if listSurfaceIDs(t, h, tenantB)[idA] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST surfaces under RLS leaked tenant A's surface %q", idA)
	}
	if !listSurfaceIDs(t, h, tenantA)[idA] {
		t.Errorf("REGRESSION: tenant A's own surface %q missing from its LIST under RLS", idA)
	}
}

// createApiKeyID drives POST /v1/api-keys and returns the new key id.
func createApiKeyID(t *testing.T, h *ApiKeyHandler, tenantID string) string {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"name": "rls-key", "scopes": []string{"read"}})
	req := httptest.NewRequest(http.MethodPost, "/v1/api-keys", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateApiKey(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create api key under RLS: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Key struct {
			ID string `json:"id"`
		} `json:"key"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.Key.ID == "" {
		t.Fatalf("create api key returned empty id: %s", rr.Body.String())
	}
	return out.Key.ID
}

// listApiKeyIDs drives GET /v1/api-keys and returns the visible ids.
func listApiKeyIDs(t *testing.T, h *ApiKeyHandler, tenantID string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/api-keys", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListApiKeys(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list api keys under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
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

// TestRLSApiKeys_SameTenant_CreateList proves a tenant can create + list its own
// API key under RLS.
func TestRLSApiKeys_SameTenant_CreateList(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedApiKeyHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-key-life-"+uuid.NewString()[:8])
	id := createApiKeyID(t, h, tenant)

	if !listApiKeyIDs(t, h, tenant)[id] {
		t.Fatalf("REGRESSION: same-tenant LIST api keys under RLS did not return its own key %q — cutover broke same-tenant reads", id)
	}
}

// TestRLSApiKeys_CrossTenant_Blocked proves tenant B cannot see tenant A's key.
func TestRLSApiKeys_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedApiKeyHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-key-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-key-iso-b-"+uuid.NewString()[:8])

	idA := createApiKeyID(t, h, tenantA)

	if listApiKeyIDs(t, h, tenantB)[idA] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST api keys under RLS leaked tenant A's key %q", idA)
	}

	// Direct AppPool count of A's key from B's tenant context must be zero.
	var leak int
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			"SELECT COUNT(*) FROM api_keys WHERE id = $1", idA,
		).Scan(&leak)
	})
	if leak != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's api_keys rows under RLS, want 0", leak)
	}
}

// createDeploymentID drives POST /v1/deployments and returns the new id.
func createDeploymentID(t *testing.T, h *DeploymentHandler, tenantID string) string {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"agentName": "dep-agent", "version": "1.0.0", "environment": "production"})
	req := httptest.NewRequest(http.MethodPost, "/v1/deployments", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.CreateDeployment(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create deployment under RLS: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.ID == "" {
		t.Fatalf("create deployment returned empty id: %s", rr.Body.String())
	}
	return out.ID
}

// getDeploymentStatus drives GET /v1/deployments/{id} and returns the status code.
func getDeploymentStatus(t *testing.T, h *DeploymentHandler, tenantID, id string) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/deployments/"+id, nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetDeployment(rr, req)
	return rr.Code
}

// TestRLSDeployments_SameTenant_CreateGet proves a tenant can create + read its
// own deployment under RLS.
func TestRLSDeployments_SameTenant_CreateGet(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedDeploymentHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-dep-life-"+uuid.NewString()[:8])
	id := createDeploymentID(t, h, tenant)

	if code := getDeploymentStatus(t, h, tenant, id); code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant GET deployment under RLS got %d, want 200 — cutover broke its own read", code)
	}
}

// TestRLSDeployments_CrossTenant_Blocked proves tenant B cannot read tenant A's
// deployment under RLS.
func TestRLSDeployments_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedDeploymentHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-dep-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-dep-iso-b-"+uuid.NewString()[:8])

	idA := createDeploymentID(t, h, tenantA)

	if code := getDeploymentStatus(t, h, tenantB, idA); code != http.StatusNotFound {
		t.Errorf("cross-tenant GET deployment under RLS: got %d, want 404", code)
	}
	if code := getDeploymentStatus(t, h, tenantA, idA); code != http.StatusOK {
		t.Errorf("REGRESSION: tenant A GET its own deployment under RLS got %d, want 200", code)
	}
}
