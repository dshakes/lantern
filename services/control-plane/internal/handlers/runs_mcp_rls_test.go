package handlers

// ENFORCEMENT-ON proof for the final P1.1b cutover batch — the runs CRUD path
// (runs.go: CreateRun / ListRuns / GetRun on the gRPC RunService) and the MCP
// attachment path (mcp_registry.go: AttachToAgent / ListAttachments /
// DetachFromAgent).
//
// Runs against the lantern_app-backed harness (newEnforcedServer): every query
// the handlers route through s.srv.WithTenant — or through TenantPool().Begin +
// setRLSTenantID for the runs CRUD — executes as the non-superuser lantern_app
// role with RLS genuinely enforced at Postgres. Proves the two properties the
// cutover must guarantee:
//
//	(a) a SAME-TENANT caller still reads/writes its OWN rows (rows returned,
//	    NOT zero — the regression check), and
//	(b) a CROSS-TENANT caller sees zero rows / cannot act.
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

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"google.golang.org/protobuf/types/known/structpb"
)

// ---------- runs CRUD (gRPC RunService) ----------

// newEnforcedRunService builds the RunService + AgentService on the RLS-enforced
// server.
func newEnforcedRunService(t *testing.T, e *enforcedServer) (*RunService, *AgentService) {
	t.Helper()
	return NewRunService(e.srv), NewAgentService(e.srv)
}

// seedEnforcedAgentWithVersion creates an agent + a promoted version for the
// tenant via the privileged pool (bypasses RLS for setup, mirroring real
// deploys) and returns the agent name. CreateRun requires a promoted version.
func seedEnforcedAgentWithVersion(t *testing.T, e *enforcedServer, tenantID, agentName string) {
	t.Helper()
	ctx := context.Background()
	var agentID string
	if err := e.superPool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1::uuid, $2, 'rls runs test agent')
		RETURNING id
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("seed agent %q: %v", agentName, err)
	}
	var versionID string
	if err := e.superPool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, '0.1.0-rls-runs', 'sha256:rls-runs', 's3://test/bundle.tar.gz', '{}'::jsonb)
		RETURNING id
	`, agentID).Scan(&versionID); err != nil {
		t.Fatalf("seed agent version: %v", err)
	}
	if _, err := e.superPool.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID,
	); err != nil {
		t.Fatalf("promote version: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = e.superPool.Exec(bg, `DELETE FROM runs WHERE agent_id = $1`, agentID)
		_, _ = e.superPool.Exec(bg, `DELETE FROM agent_versions WHERE id = $1`, versionID)
		_, _ = e.superPool.Exec(bg, `DELETE FROM agents WHERE id = $1`, agentID)
	})
}

// createRunID drives RunService.CreateRun as the given tenant and returns the
// new run id.
func createRunID(t *testing.T, rs *RunService, tenantID, agentName string) string {
	t.Helper()
	input, _ := structpb.NewStruct(map[string]any{"message": "hello"})
	run, err := rs.CreateRun(injectTenant(context.Background(), tenantID), &lanternv1.CreateRunRequest{
		AgentName: agentName,
		Input:     input,
	})
	if err != nil {
		t.Fatalf("CreateRun under RLS for tenant %s: %v", tenantID, err)
	}
	return run.GetId()
}

// TestRLSRuns_SameTenant_CreateListGet proves that under RLS enforcement the
// owning tenant can create a run and then read it back via ListRuns + GetRun —
// i.e. the TenantPool + setRLSTenantID path did NOT break same-tenant access.
func TestRLSRuns_SameTenant_CreateListGet(t *testing.T) {
	e := newEnforcedServer(t)
	rs, _ := newEnforcedRunService(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-runs-life-"+uuid.NewString()[:8])
	agent := "rls-runs-agent"
	seedEnforcedAgentWithVersion(t, e, tenant, agent)

	runID := createRunID(t, rs, tenant, agent)

	// GET — the owner must see its own run.
	got, err := rs.GetRun(injectTenant(context.Background(), tenant), &lanternv1.GetRunRequest{Id: runID})
	if err != nil {
		t.Fatalf("REGRESSION: same-tenant GetRun under RLS failed for its own run: %v", err)
	}
	if got.GetId() != runID {
		t.Fatalf("GetRun returned id %q, want %q", got.GetId(), runID)
	}

	// LIST — the owner's run must appear.
	list, err := rs.ListRuns(injectTenant(context.Background(), tenant), &lanternv1.ListRunsRequest{})
	if err != nil {
		t.Fatalf("same-tenant ListRuns under RLS: %v", err)
	}
	found := false
	for _, r := range list.GetRuns() {
		if r.GetId() == runID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("REGRESSION: same-tenant ListRuns under RLS did not return the tenant's own run %q (got %d runs)", runID, len(list.GetRuns()))
	}
}

// TestRLSRuns_CrossTenant_Blocked proves that under RLS enforcement tenant B
// cannot GET or LIST tenant A's run — the run never crosses the tenant boundary
// even though it was created via the privileged-pool seed.
func TestRLSRuns_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	rs, _ := newEnforcedRunService(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-runs-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-runs-iso-b-"+uuid.NewString()[:8])
	agent := "rls-runs-agent"
	seedEnforcedAgentWithVersion(t, e, tenantA, agent)

	runID := createRunID(t, rs, tenantA, agent)

	// (1) Tenant B GET of A's run → NotFound (RLS hides the row; the WHERE
	// tenant_id filter and RLS both refuse it, surfaced as NotFound not denied).
	if _, err := rs.GetRun(injectTenant(context.Background(), tenantB), &lanternv1.GetRunRequest{Id: runID}); err == nil {
		t.Errorf("SECURITY VIOLATION: tenant B GetRun under RLS resolved tenant A's run %q", runID)
	}

	// (2) Tenant B LIST must not contain A's run.
	list, err := rs.ListRuns(injectTenant(context.Background(), tenantB), &lanternv1.ListRunsRequest{})
	if err != nil {
		t.Fatalf("tenant B ListRuns under RLS: %v", err)
	}
	for _, r := range list.GetRuns() {
		if r.GetId() == runID {
			t.Errorf("SECURITY VIOLATION: tenant B's ListRuns under RLS leaked tenant A's run %q", runID)
		}
	}

	// (3) Positive control: tenant A still sees its own run.
	if _, err := rs.GetRun(injectTenant(context.Background(), tenantA), &lanternv1.GetRunRequest{Id: runID}); err != nil {
		t.Errorf("REGRESSION: tenant A GetRun its own run under RLS failed: %v", err)
	}
}

// ---------- MCP attachments (HTTP MCPHandler) ----------

// newEnforcedMCPHandler builds the MCPHandler on the RLS-enforced server.
func newEnforcedMCPHandler(t *testing.T, e *enforcedServer) *MCPHandler {
	t.Helper()
	return NewMCPHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

// seedMCPServer inserts a global-catalog mcp_servers row (no tenant_id) via the
// privileged pool and returns its slug. Registered for cleanup.
func seedMCPServer(t *testing.T, e *enforcedServer) string {
	t.Helper()
	slug := "rls-mcp-" + uuid.NewString()[:8]
	if _, err := e.superPool.Exec(context.Background(), `
		INSERT INTO mcp_servers (slug, name, description, category, transport, auth_type, manifest, tags)
		VALUES ($1, $1, 'rls test server', 'testing', 'http', 'none', '{}'::jsonb, '{}')
	`, slug); err != nil {
		t.Fatalf("seed mcp server: %v", err)
	}
	t.Cleanup(func() {
		_, _ = e.superPool.Exec(context.Background(), `DELETE FROM mcp_servers WHERE slug = $1`, slug)
	})
	return slug
}

// attachMCP drives POST /v1/agents/{name}/mcp-servers as the given tenant.
func attachMCP(t *testing.T, h *MCPHandler, tenantID, agentName, serverSlug string) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"serverSlug": serverSlug, "config": map[string]any{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/agents/"+agentName+"/mcp-servers", bytes.NewReader(body))
	req.SetPathValue("name", agentName)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.AttachToAgent(rr, req)
	return rr
}

// listMCPSlugs drives GET /v1/agents/{name}/mcp-servers and returns the set of
// attached server slugs visible to the tenant.
func listMCPSlugs(t *testing.T, h *MCPHandler, tenantID, agentName string) map[string]bool {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/"+agentName+"/mcp-servers", nil)
	req.SetPathValue("name", agentName)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ListAttachments(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("ListAttachments under RLS for tenant %s: got %d; body: %s", tenantID, rr.Code, rr.Body.String())
	}
	var out []struct {
		ServerSlug string `json:"serverSlug"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	set := map[string]bool{}
	for _, a := range out {
		set[a.ServerSlug] = true
	}
	return set
}

// TestRLSMCPAttachments_SameTenant_AttachListDetach proves the owning tenant can
// attach an MCP server, see it in its list, and detach it — the WithTenant
// cutover on agent_mcp_attachments did NOT break same-tenant reads/writes.
func TestRLSMCPAttachments_SameTenant_AttachListDetach(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedMCPHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-mcp-life-"+uuid.NewString()[:8])
	agent := "rls-mcp-agent"
	slug := seedMCPServer(t, e)

	if rr := attachMCP(t, h, tenant, agent, slug); rr.Code != http.StatusOK {
		t.Fatalf("same-tenant attach under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	if !listMCPSlugs(t, h, tenant, agent)[slug] {
		t.Fatalf("REGRESSION: same-tenant ListAttachments under RLS did not return its own attachment %q — cutover broke same-tenant reads", slug)
	}

	// DETACH → then it's gone.
	tok := mintTestToken(t, tenant, "user-x", "owner")
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/agents/"+agent+"/mcp-servers/"+slug, nil)
	delReq.SetPathValue("name", agent)
	delReq.SetPathValue("slug", slug)
	delReq.Header.Set("Authorization", bearerHeader(tok))
	delRR := httptest.NewRecorder()
	h.DetachFromAgent(delRR, delReq)
	if delRR.Code != http.StatusOK {
		t.Fatalf("same-tenant detach under RLS: got %d, want 200; body: %s", delRR.Code, delRR.Body.String())
	}
	if listMCPSlugs(t, h, tenant, agent)[slug] {
		t.Errorf("attachment %q still listed after detach under RLS", slug)
	}
}

// TestRLSMCPAttachments_CrossTenant_Blocked proves tenant B cannot see tenant
// A's MCP attachment under RLS, while A still can.
func TestRLSMCPAttachments_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedMCPHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-mcp-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-mcp-iso-b-"+uuid.NewString()[:8])
	agent := "rls-mcp-agent"
	slug := seedMCPServer(t, e)

	if rr := attachMCP(t, h, tenantA, agent, slug); rr.Code != http.StatusOK {
		t.Fatalf("tenant A attach under RLS: got %d; body: %s", rr.Code, rr.Body.String())
	}

	// (1) Tenant B's list of the same agent name must NOT contain A's attachment.
	if listMCPSlugs(t, h, tenantB, agent)[slug] {
		t.Errorf("SECURITY VIOLATION: tenant B's ListAttachments under RLS leaked tenant A's attachment %q", slug)
	}

	// (2) Positive control: tenant A still sees its own attachment.
	if !listMCPSlugs(t, h, tenantA, agent)[slug] {
		t.Errorf("REGRESSION: tenant A's own MCP attachment %q missing from its list under RLS", slug)
	}

	// Verify the cross-tenant proof was meaningful via the privileged pool: the
	// row exists exactly once, owned by tenant A.
	var owner string
	if err := e.superPool.QueryRow(context.Background(), `
		SELECT a.tenant_id::text
		FROM agent_mcp_attachments a JOIN mcp_servers s ON s.id = a.mcp_server_id
		WHERE s.slug = $1
	`, slug).Scan(&owner); err != nil {
		t.Fatalf("verify attachment ownership: %v", err)
	}
	if owner != tenantA {
		t.Errorf("attachment owner = %q, want tenant A %q", owner, tenantA)
	}
}
