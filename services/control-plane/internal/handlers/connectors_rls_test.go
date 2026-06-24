package handlers

// ENFORCEMENT-ON proof for the connectors handler group (connectors.go,
// connector_auth.go, connector_executor.go) after the P1.1b cutover to
// s.srv.WithTenant.
//
// These tests run against the lantern_app-backed harness (newEnforcedServer):
// every query the handlers route through s.srv.WithTenant is executed by the
// non-superuser `lantern_app` role with RLS genuinely enforced at Postgres —
// NOT simulated. They prove the two properties the cutover must guarantee:
//
//	(a) a SAME-TENANT caller still reads + writes its OWN rows (returns rows,
//	    NOT zero — the critical "we didn't break it" regression check), and
//	(b) a CROSS-TENANT caller sees zero rows / cannot act.
//
// Skipped automatically when DATABASE_URL is unset (harness skips).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// newEnforcedConnectorHandlers builds the connectors install/list/get/uninstall
// handler + the executor on the RLS-enforced server.
func newEnforcedConnectorHandlers(t *testing.T, e *enforcedServer) (*ConnectorHandler, *ConnectorExecutor) {
	t.Helper()
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return NewConnectorHandler(e.srv, auth), NewConnectorExecutor(e.srv, auth)
}

// TestRLSConnectors_SameTenant_FullLifecycle proves that under RLS enforcement
// the owning tenant can install, list, get, and uninstall its connector — i.e.
// the WithTenant cutover did NOT break same-tenant reads/writes (the rows are
// visible, not silently zero).
func TestRLSConnectors_SameTenant_FullLifecycle(t *testing.T) {
	e := newEnforcedServer(t)
	h, _ := newEnforcedConnectorHandlers(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-conn-life-"+uuid.NewString()[:8])

	// INSTALL (write through WithTenant → must succeed under RLS WITH CHECK).
	id := installConnectorID(t, h, e.srv, tenant, "github", "RLS GitHub", map[string]any{
		"personalAccessToken": "pat_rls_same_tenant_token",
	})

	// LIST (read through WithTenant → must SEE its own row, not zero).
	ids := listConnectorIDs(t, h, tenant)
	if !ids[id] {
		t.Fatalf("REGRESSION: same-tenant LIST under RLS did not return the tenant's own connector %q (got %d rows) — cutover broke same-tenant reads", id, len(ids))
	}

	// GET (read through WithTenant → 200 with the row).
	if rr := getConnectorHTTP(t, h, tenant, id); rr.Code != http.StatusOK {
		t.Fatalf("same-tenant GET under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	// EXECUTE (executor credential read through WithTenant → resolves the
	// tenant's own connector under RLS; must NOT report "not installed" for its
	// owner). We drive the executor through WithTenant exactly like the HTTP
	// Execute handler does.
	var execErr error
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenant), func(tx pgx.Tx) error {
		_, execErr = executeConnectorAction(context.Background(), tx, tenant, "github", "list_repos", map[string]any{"limit": 1})
		return nil // a downstream API error is expected (bogus token); don't roll back the read
	})
	if execErr != nil && isConnectorNotInstalled(execErr) {
		t.Errorf("REGRESSION: executor under RLS reported tenant's OWN connector as not installed: %v", execErr)
	}

	// UNINSTALL (delete through WithTenant → 204, then gone).
	tok := mintTestToken(t, tenant, "user-x", "owner")
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/connectors/"+id, nil)
	delReq.SetPathValue("id", id)
	delReq.Header.Set("Authorization", bearerHeader(tok))
	delRR := httptest.NewRecorder()
	h.UninstallConnector(delRR, delReq)
	if delRR.Code != http.StatusNoContent {
		t.Fatalf("same-tenant UNINSTALL under RLS: got %d, want 204; body: %s", delRR.Code, delRR.Body.String())
	}
	if listConnectorIDs(t, h, tenant)[id] {
		t.Errorf("connector %q still listed after uninstall under RLS", id)
	}
}

// TestRLSConnectors_CrossTenant_Blocked proves that under RLS enforcement
// tenant B cannot see, get, or execute tenant A's connector — the credentials
// never cross the tenant boundary even with the privileged-pool seed.
func TestRLSConnectors_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h, _ := newEnforcedConnectorHandlers(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-conn-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-conn-iso-b-"+uuid.NewString()[:8])

	idA := installConnectorID(t, h, e.srv, tenantA, "slack", "A Slack", map[string]any{
		"botToken": "bot-token-tenant-a-secret",
	})

	// (1) Tenant B GET of A's connector → 404 (RLS hides the row).
	if rr := getConnectorHTTP(t, h, tenantB, idA); rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant GET under RLS: got %d, want 404; body: %s", rr.Code, rr.Body.String())
	}

	// (2) Tenant B LIST must not contain A's connector.
	if listConnectorIDs(t, h, tenantB)[idA] {
		t.Errorf("SECURITY VIOLATION: tenant B's LIST under RLS leaked tenant A's connector %q", idA)
	}

	// (3) Executor scoped to tenant B must NOT resolve A's slack install — it
	// reports "not installed" for B (credentials don't cross the boundary).
	var execErr error
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		_, execErr = executeConnectorAction(context.Background(), tx, tenantB, "slack", "list_channels", nil)
		return nil // don't roll back on the expected not-installed error
	})
	if execErr == nil || !isConnectorNotInstalled(execErr) {
		t.Errorf("SECURITY VIOLATION: tenant B executor under RLS resolved tenant A's connector: err=%v", execErr)
	}

	// (4) Positive control: tenant A still sees its own connector under RLS.
	if !listConnectorIDs(t, h, tenantA)[idA] {
		t.Errorf("REGRESSION: tenant A's own connector %q missing from its LIST under RLS", idA)
	}
}
