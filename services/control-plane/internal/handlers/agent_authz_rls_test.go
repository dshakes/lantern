package handlers

// Integration tests for agent identity + per-agent policy (ADR 0055) on the
// RLS-ENFORCED harness (newEnforcedServer: tenant-scoped work runs as the
// non-superuser pal_app role). Point DATABASE_URL at a FRESH database.

import (
	"bytes"

	"go.uber.org/zap"

	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/dshakes/pal/services/control-plane/internal/server"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dshakes/pal/packages/agentpolicy"
	"github.com/dshakes/pal/services/control-plane/internal/agentidentity"
)

type authzEnv struct {
	e    *enforcedServer
	z    *AgentAuthz
	auth *AuthHandler
	api  *AgentIdentityHandler
}

func newAuthzEnv(t *testing.T) *authzEnv {
	t.Helper()
	e := newEnforcedServer(t)
	z := NewAgentAuthz(e.srv, []byte(testJWTSecret))
	SetAgentAuthz(z)
	t.Cleanup(func() { SetAgentAuthz(nil) })
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return &authzEnv{e: e, z: z, auth: auth, api: NewAgentIdentityHandler(e.srv, auth, z, nil)}
}

// seedAgent inserts an agent through the privileged pool. The 0038 trigger
// gives it a default-deny policy.
func (a *authzEnv) seedAgent(t *testing.T, tenantID, name string) agentRef {
	t.Helper()
	var r agentRef
	if err := a.e.superPool.QueryRow(context.Background(), `INSERT INTO agents (tenant_id, name) VALUES ($1, $2)
		RETURNING id::text, name, tenant_id::text, created_at`, tenantID, name).Scan(&r.ID, &r.Name, &r.TenantID, &r.CreatedAt); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	return r
}

func (a *authzEnv) setPolicy(t *testing.T, agentID string, p agentpolicy.Policy) {
	t.Helper()
	n, err := agentpolicy.Normalize(p)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := json.Marshal(n)
	if _, err := a.e.superPool.Exec(context.Background(), `UPDATE agent_policies SET mode=$2, document=$3, version=version+1 WHERE agent_id=$1`, agentID, string(n.Mode), doc); err != nil {
		t.Fatal(err)
	}
}

func (a *authzEnv) ownerToken(t *testing.T, tenantID, role string) string {
	t.Helper()
	tok, err := a.auth.generateToken(uuid.NewString(), tenantID, "owner@test.local", "Owner", role)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (a *authzEnv) do(t *testing.T, h http.HandlerFunc, method, path, tok string, body any, pathVals map[string]string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	for k, v := range pathVals {
		req.SetPathValue(k, v)
	}
	rr := httptest.NewRecorder()
	h(rr, req)
	return rr
}

func (a *authzEnv) auditCount(t *testing.T, tenantID, where string, args ...any) int {
	t.Helper()
	var n int
	q := `SELECT count(*) FROM agent_identity_audit WHERE tenant_id = $1 AND ` + where
	if err := a.e.superPool.QueryRow(context.Background(), q, append([]any{tenantID}, args...)...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRLSAgentAuthz_DefaultDenyThenAllowThenRevoke(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "aa-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "researcher")
	ctx := injectTenant(context.Background(), tenant)

	ctx, p, err := a.z.Establish(ctx, tenant, "researcher", "")
	if err != nil || p == nil {
		t.Fatalf("establish: %v %v", p, err)
	}
	if !strings.HasPrefix(p.SpiffeID, "spiffe://pal.local/tenant/"+tenant+"/agent/"+ag.ID) {
		t.Fatalf("spiffe id %q", p.SpiffeID)
	}

	// New agent: default deny, typed error, audited.
	err = p.Authorize(ctx, toolAction("web_search"), "")
	var d *AgentPolicyDeniedError
	if !errors.As(err, &d) || !errors.Is(err, ErrAgentPolicyDenied) || d.Kind != agentpolicy.KindTool {
		t.Fatalf("new agent must be denied with a typed error, got %v", err)
	}
	if n := a.auditCount(t, tenant, `event='policy.denied' AND target='web_search'`); n != 1 {
		t.Fatalf("deny audit rows = %d", n)
	}

	// dispatchTool (the session / run tool loop) refuses before executing.
	if _, err := dispatchTool(ctx, a.e.srv.Pool, tenant, "github__delete_repo", nil); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("dispatchTool must deny an unlisted connector action, got %v", err)
	}

	// Grant and re-check — policy is re-read on every call.
	a.setPolicy(t, ag.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, Tools: []string{"web_search"},
		Connectors: map[string][]string{"github": {"list_*"}}})
	if err := p.Authorize(ctx, toolAction("web_search"), ""); err != nil {
		t.Fatalf("granted tool denied: %v", err)
	}
	if err := p.Authorize(ctx, toolAction("github__list_prs"), ""); err != nil {
		t.Fatalf("granted connector action denied: %v", err)
	}
	if err := p.Authorize(ctx, toolAction("github__delete_repo"), ""); err == nil {
		t.Fatal("ungranted connector action allowed")
	}

	// A status-only revocation (no generation bump — e.g. an operator flipping
	// the row) must still deny: the status check is not just the key rotation.
	if _, err := a.e.superPool.Exec(context.Background(), `UPDATE agent_identities SET status='revoked' WHERE agent_id=$1`, ag.ID); err != nil {
		t.Fatal(err)
	}
	if err := p.Authorize(ctx, toolAction("web_search"), ""); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("status-revoked agent must be denied, got %v", err)
	}
	if _, err := a.e.superPool.Exec(context.Background(), `UPDATE agent_identities SET status='active' WHERE agent_id=$1`, ag.ID); err != nil {
		t.Fatal(err)
	}

	// Revoke mid-run: the very next call is denied, and Establish refuses.
	if _, err := a.z.revokeIdentity(ctx, tenant, ag.ID, "test", "compromised"); err != nil {
		t.Fatal(err)
	}
	if err := p.Authorize(ctx, toolAction("web_search"), ""); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("revoked agent must be denied mid-run, got %v", err)
	}
	if _, _, err := a.z.Establish(ctx, tenant, "researcher", ""); !errors.Is(err, ErrAgentIdentityRevoked) {
		t.Fatalf("revoked agent must not establish, got %v", err)
	}
	// Rotate re-issues on a fresh generation; the old principal re-mints.
	id, err := a.z.rotateIdentity(ctx, tenant, ag.ID, "test")
	if err != nil || id.Revoked || id.KeyGeneration != 3 {
		t.Fatalf("rotate: %+v %v", id, err)
	}
	if err := p.Authorize(ctx, toolAction("web_search"), ""); err != nil {
		t.Fatalf("after rotate: %v", err)
	}
}

func TestRLSAgentAuthz_UnregisteredAgentKeepsCallerAuthority(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "ab-"+uuid.NewString()[:8])
	ctx := injectTenant(context.Background(), tenant)
	_, p, err := a.z.Establish(ctx, tenant, "whatsapp-assistant", "")
	if err != nil || p != nil {
		t.Fatalf("unregistered name must yield no principal, got %v %v", p, err)
	}
	t.Setenv(envAgentPolicyStrict, "1")
	if _, _, err := a.z.Establish(ctx, tenant, "whatsapp-assistant", ""); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("strict mode must deny unregistered names, got %v", err)
	}
}

func TestRLSAgentAuthz_CrossTenantIsolation(t *testing.T) {
	a := newAuthzEnv(t)
	t1 := seedEnforcedTenant(t, a.e, "ac1-"+uuid.NewString()[:8])
	t2 := seedEnforcedTenant(t, a.e, "ac2-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, t1, "secret-agent")
	if _, err := a.z.ensureIdentity(injectTenant(context.Background(), t1), t1, ag.ID); err != nil {
		t.Fatal(err)
	}

	// Under RLS tenant 2 cannot see tenant 1's identity, policy or audit rows.
	ctx2 := injectTenant(context.Background(), t2)
	var n int
	if err := a.e.srv.WithTenant(ctx2, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx2, `SELECT (SELECT count(*) FROM agent_identities WHERE agent_id=$1)
			+ (SELECT count(*) FROM agent_policies WHERE agent_id=$1)
			+ (SELECT count(*) FROM agent_identity_audit WHERE agent_id=$1)`, ag.ID).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("cross-tenant read returned %d rows — RLS not enforced", n)
	}
	// ...and cannot write a policy row for it (WITH CHECK).
	err := a.e.srv.WithTenant(ctx2, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx2, `INSERT INTO agent_policies (agent_id, tenant_id, mode) VALUES ($1, $2, 'legacy_permissive')`, ag.ID, t1)
		return err
	})
	if err == nil {
		t.Fatal("cross-tenant policy write succeeded — RLS WITH CHECK missing")
	}

	// REST: tenant 2 asking for tenant 1's agent by name gets 404 everywhere.
	tok2 := a.ownerToken(t, t2, "owner")
	for _, c := range []struct {
		h    http.HandlerFunc
		meth string
	}{{a.api.GetPolicy, "GET"}, {a.api.GetIdentity, "GET"}, {a.api.ListAudit, "GET"}, {a.api.RotateIdentity, "POST"}} {
		if rr := a.do(t, c.h, c.meth, "/x", tok2, nil, map[string]string{"name": "secret-agent"}, nil); rr.Code != http.StatusNotFound {
			t.Errorf("cross-tenant %s: got %d want 404", c.meth, rr.Code)
		}
	}
}

func TestRLSAgentPolicyAPI_GetPutConflictValidateAudit(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "ad-"+uuid.NewString()[:8])
	a.seedAgent(t, tenant, "writer")
	tok := a.ownerToken(t, tenant, "owner")
	pv := map[string]string{"name": "writer"}

	rr := a.do(t, a.api.GetPolicy, "GET", "/x", tok, nil, pv, nil)
	if rr.Code != 200 {
		t.Fatalf("get: %d %s", rr.Code, rr.Body)
	}
	var got policyResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got.Policy.Mode != agentpolicy.ModeEnforce || len(got.Warnings) == 0 || !strings.HasPrefix(got.Warnings[0], "default_deny") {
		t.Fatalf("new agent should be default-deny with a warning: %+v", got)
	}

	body := map[string]any{"mode": "enforce", "tools": []string{"web_search"}, "version": got.Policy.Version}
	rr = a.do(t, a.api.PutPolicy, "PUT", "/x", tok, body, pv, nil)
	if rr.Code != 200 {
		t.Fatalf("put: %d %s", rr.Code, rr.Body)
	}
	var after policyResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &after)
	if after.Policy.Version != got.Policy.Version+1 || len(after.Policy.Tools) != 1 {
		t.Fatalf("read-back mismatch: %+v", after.Policy)
	}

	// Stale version → 409, nothing written.
	rr = a.do(t, a.api.PutPolicy, "PUT", "/x", tok, body, pv, nil)
	if rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), "version_conflict") {
		t.Fatalf("stale put: %d %s", rr.Code, rr.Body)
	}
	// Invalid → 400 naming the field; unknown field → 400.
	rr = a.do(t, a.api.PutPolicy, "PUT", "/x", tok, map[string]any{"egressHosts": []string{"https://x/y"}, "version": after.Policy.Version}, pv, nil)
	if rr.Code != 400 || !strings.Contains(rr.Body.String(), "egressHosts") {
		t.Fatalf("invalid put: %d %s", rr.Code, rr.Body)
	}
	rr = a.do(t, a.api.PutPolicy, "PUT", "/x", tok, map[string]any{"egresHosts": []string{"*"}, "version": after.Policy.Version}, pv, nil)
	if rr.Code != 400 {
		t.Fatalf("typo'd field must be rejected: %d", rr.Code)
	}

	// Audit API: the update is there and the chain verifies.
	rr = a.do(t, a.api.ListAudit, "GET", "/x?event=policy.updated", tok, nil, pv, nil)
	var al struct {
		Events     []auditEventJSON `json:"events"`
		ChainValid bool             `json:"chainValid"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &al)
	if rr.Code != 200 || len(al.Events) != 1 || !al.ChainValid {
		t.Fatalf("audit: %d %s", rr.Code, rr.Body)
	}
}

func TestRLSAgentIdentityAPI_TokenMintJWKSAndConfusion(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "ae-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "minty")
	pv := map[string]string{"name": "minty"}

	// Members cannot mint; owners can.
	if rr := a.do(t, a.api.MintToken, "POST", "/x", a.ownerToken(t, tenant, "member"), map[string]any{"audience": AudienceConnectors}, pv, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("member mint: %d", rr.Code)
	}
	rr := a.do(t, a.api.MintToken, "POST", "/x", a.ownerToken(t, tenant, "owner"), map[string]any{"audience": AudienceConnectors}, pv, nil)
	if rr.Code != 200 {
		t.Fatalf("owner mint: %d %s", rr.Code, rr.Body)
	}
	var minted struct{ Token, Jti string }
	_ = json.Unmarshal(rr.Body.Bytes(), &minted)
	// The token itself is never written to the audit log.
	var leaked int
	_ = a.e.superPool.QueryRow(context.Background(), `SELECT count(*) FROM agent_identity_audit WHERE attrs::text LIKE '%'||$1||'%' OR reason LIKE '%'||$1||'%'`, minted.Token[len(minted.Token)-20:]).Scan(&leaked)
	if leaked != 0 || a.auditCount(t, tenant, `event='token.minted' AND jti=$2`, minted.Jti) != 1 {
		t.Fatalf("mint audit wrong (leaked=%d)", leaked)
	}

	// An agent token is NOT a user session.
	if _, err := a.auth.ValidateToken(minted.Token); err == nil {
		t.Fatal("agent token accepted as a user session")
	}
	// Nor is an HS256 agent-instance token signed with the JWT secret (the
	// pre-ADR-0052 dev default).
	t.Setenv("PAL_AGENT_IDENTITY_SECRET", "")
	_, inst, err := agentidentity.New([]byte(testJWTSecret)).Issue(context.Background(), tenant, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.auth.ValidateToken(inst); err == nil {
		t.Fatal("agent-instance token accepted as a user session")
	}

	// Public JWKS serves the active key; it verifies the minted token.
	rr = a.do(t, a.api.AgentJWKS, "GET", "/x", "", nil, map[string]string{"agentId": ag.ID}, nil)
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"kty":"OKP"`) {
		t.Fatalf("jwks: %d %s", rr.Code, rr.Body)
	}
	if _, err := a.z.auth.Verify(context.Background(), minted.Token, AudienceConnectors, a.z.lookupIdentity); err != nil {
		t.Fatalf("verify minted: %v", err)
	}
	// Revoked → token dead, JWKS 404.
	if _, err := a.z.revokeIdentity(injectTenant(context.Background(), tenant), tenant, ag.ID, "t", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.z.auth.Verify(context.Background(), minted.Token, AudienceConnectors, a.z.lookupIdentity); !errors.Is(err, agentidentity.ErrAgentTokenRevoked) {
		t.Fatalf("revoked token verified: %v", err)
	}
	if rr := a.do(t, a.api.AgentJWKS, "GET", "/x", "", nil, map[string]string{"agentId": ag.ID}, nil); rr.Code != 404 {
		t.Fatalf("revoked jwks: %d", rr.Code)
	}
}

// mintFor mints an agent token for audience (test helper; same path as the API).
func (a *authzEnv) mintFor(t *testing.T, tenantID string, ag agentRef, audience string) string {
	t.Helper()
	id, err := a.z.ensureIdentity(injectTenant(context.Background(), tenantID), tenantID, ag.ID)
	if err != nil {
		t.Fatal(err)
	}
	tok, _, err := a.z.auth.Mint(agentidentity.MintRequest{Identity: id.IdentityRecord, AgentName: ag.Name, Audience: audience})
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestRLSConnectorExecute_AgentCaller(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "af-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "poster")
	ex := NewConnectorExecutor(a.e.srv, a.auth)
	pv := map[string]string{"connectorId": "slack"}

	tok := a.mintFor(t, tenant, ag, AudienceConnectors)
	rr := a.do(t, ex.Execute, "POST", "/v1/connectors/slack/execute?action=post_message", "", map[string]any{}, pv, map[string]string{AgentTokenHeader: tok})
	if rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), "agent_policy_denied") {
		t.Fatalf("unlisted action: %d %s", rr.Code, rr.Body)
	}
	// Wrong audience → 401, never downgraded to the user path.
	bad := a.mintFor(t, tenant, ag, AudienceDispatch)
	rr = a.do(t, ex.Execute, "POST", "/v1/connectors/slack/execute?action=post_message", a.ownerToken(t, tenant, "owner"), map[string]any{}, pv, map[string]string{AgentTokenHeader: bad})
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-audience token: %d %s", rr.Code, rr.Body)
	}
	// Allowed → passes policy and reaches the connector (not installed here,
	// so the downstream error is the connector's, not a policy 403).
	a.setPolicy(t, ag.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, Connectors: map[string][]string{"slack": {"post_message"}}})
	rr = a.do(t, ex.Execute, "POST", "/v1/connectors/slack/execute?action=post_message", "", map[string]any{}, pv, map[string]string{AgentTokenHeader: tok})
	if rr.Code == http.StatusForbidden || rr.Code == http.StatusUnauthorized {
		t.Fatalf("allowed action blocked: %d %s", rr.Code, rr.Body)
	}
}

func TestRLSA2AInvoke_BothPoliciesCrossTenant(t *testing.T) {
	a := newAuthzEnv(t)
	t1 := seedEnforcedTenant(t, a.e, "ag1-"+uuid.NewString()[:8])
	t2 := seedEnforcedTenant(t, a.e, "ag2-"+uuid.NewString()[:8])
	caller := a.seedAgent(t, t1, "buyer-bot")
	target := a.seedAgent(t, t2, "public-summarizer")
	if _, err := a.e.superPool.Exec(context.Background(), `UPDATE agents SET is_public=true WHERE id=$1`, target.ID); err != nil {
		t.Fatal(err)
	}
	h := NewA2AHandler(a.e.srv, a.auth) // no exec deps: a 503 means auth+policy PASSED
	pv := map[string]string{"name": "public-summarizer"}
	aud := a.z.auth.SpiffeID(t2, target.ID)
	tok := a.mintFor(t, t1, caller, aud)
	invoke := func(tok string) *httptest.ResponseRecorder {
		return a.do(t, h.InvokeAgent, "POST", "/x", "", map[string]any{"message": "hi"}, pv, map[string]string{AgentTokenHeader: tok})
	}

	// 1. Caller policy does not list the target.
	if rr := invoke(tok); rr.Code != 403 || !strings.Contains(rr.Body.String(), `"kind":"a2a"`) {
		t.Fatalf("caller-policy deny: %d %s", rr.Code, rr.Body)
	}
	// 2. Caller allows; target's inbound (default-deny) does not admit it.
	a.setPolicy(t, caller.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, A2ATargets: []string{aud}})
	if rr := invoke(tok); rr.Code != 403 || !strings.Contains(rr.Body.String(), "a2a_inbound") {
		t.Fatalf("target-inbound deny: %d %s", rr.Code, rr.Body)
	}
	// 3. Both allow → passes to execution (503: no exec deps in this test).
	a.setPolicy(t, target.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, A2AInbound: []string{"tenant:" + t1},
		Budget: agentpolicy.Budget{MaxA2AInboundPerMinute: 1}})
	if rr := invoke(tok); rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("both-allow: %d %s", rr.Code, rr.Body)
	}
	// 4. Per-caller rate isolation on the target.
	if rr := invoke(tok); rr.Code != 403 || !strings.Contains(rr.Body.String(), "maxA2AInboundPerMinute") {
		t.Fatalf("rate limit: %d %s", rr.Code, rr.Body)
	}
	// 5. A token for a DIFFERENT audience (another agent) is rejected.
	other := a.mintFor(t, t1, caller, a.z.auth.SpiffeID(t2, uuid.NewString()))
	if rr := invoke(other); rr.Code != 401 {
		t.Fatalf("wrong-audience: %d %s", rr.Code, rr.Body)
	}
	// 6. A forged tenant claim cannot steer resolution: re-sign is impossible,
	// and an unsigned edit fails verification.
	parts := strings.Split(tok, ".")
	var claims map[string]any
	raw, _ := jwt.NewParser().DecodeSegment(parts[1])
	_ = json.Unmarshal(raw, &claims)
	claims["tenant_id"] = t2
	forged, _ := json.Marshal(claims)
	if rr := invoke(parts[0] + "." + base64.RawURLEncoding.EncodeToString(forged) + "." + parts[2]); rr.Code != 401 {
		t.Fatalf("forged token: %d %s", rr.Code, rr.Body)
	}
	// Audit landed on BOTH chains.
	if a.auditCount(t, t1, `event='policy.denied' AND action_kind='a2a'`) == 0 || a.auditCount(t, t2, `event='a2a.invoke' AND decision='deny'`) == 0 {
		t.Fatal("A2A decisions must be audited on caller and target tenants")
	}
}

func TestRLSRuntime_ScheduleAndSecretsScopedToAgent(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "ah-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "vm-agent")
	rh := &RuntimeHandler{srv: a.e.srv}
	ctx := injectTenant(context.Background(), tenant)
	spec := agentSpecDTO{AgentName: "vm-agent", ImageDigest: "sha256:x",
		EgressRules: []map[string]any{{"pattern": "api.github.com"}},
		Secrets:     []map[string]any{{"envName": "K", "secretUri": "pal.secret/llm/openai"}}}

	if _, err := rh.authorizeScheduleForAgent(ctx, tenant, spec); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("egress outside policy must deny, got %v", err)
	}
	a.setPolicy(t, ag.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, EgressHosts: []string{"api.github.com"}})
	if _, err := rh.authorizeScheduleForAgent(ctx, tenant, spec); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("secret outside policy must deny, got %v", err)
	}
	a.setPolicy(t, ag.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, EgressHosts: []string{"api.github.com"}, Secrets: []string{"pal.secret/llm/*"}})
	p, err := rh.authorizeScheduleForAgent(ctx, tenant, spec)
	if err != nil || p == nil || p.AgentID != ag.ID {
		t.Fatalf("allowed schedule: %v %v", p, err)
	}
	spec.Network = "open"
	if _, err := rh.authorizeScheduleForAgent(ctx, tenant, spec); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("network=open without egress * must deny, got %v", err)
	}
	if _, err := rh.authorizeScheduleForAgent(ctx, tenant, agentSpecDTO{AgentName: "no-such-agent"}); !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatalf("unknown agent name must deny, got %v", err)
	}

	// Secret relay: a VM bound to the agent resolves only allowed refs.
	vmID := "vm-" + uuid.NewString()[:8]
	if _, err := a.e.superPool.Exec(context.Background(), `INSERT INTO runtime_vms (vm_id, tenant_id, node, az, isolation_class, state, spec, agent_id)
		VALUES ($1, $2, 'n', 'z', 'standard', 'running', '{}', $3)`, vmID, tenant, ag.ID); err != nil {
		t.Fatal(err)
	}
	sh := &RuntimeSecretsHandler{srv: a.e.srv}
	vp, err := sh.vmAgentPrincipal(ctx, tenant, vmID)
	if err != nil || vp == nil {
		t.Fatalf("vm principal: %v %v", vp, err)
	}
	if err := vp.Authorize(ctx, agentpolicy.Action{Kind: agentpolicy.KindSecret, Target: "pal.secret/llm/openai"}, ""); err != nil {
		t.Fatalf("allowed ref: %v", err)
	}
	if err := vp.Authorize(ctx, agentpolicy.Action{Kind: agentpolicy.KindSecret, Target: "pal.secret/connector/" + uuid.NewString() + "/oauth"}, ""); err == nil {
		t.Fatal("unlisted ref allowed")
	}
}

func TestRLSRunExecutor_RevokedAgentRunFails(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "ai-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "doomed")
	var versionID, runID string
	sp := a.e.superPool
	if err := sp.QueryRow(context.Background(), `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest) VALUES ($1,'v1','\x00','mem://x','{}') RETURNING id::text`, ag.ID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	if err := sp.QueryRow(context.Background(), `INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input) VALUES ($1,$2,$3,'running','manual','{}') RETURNING id::text`, tenant, ag.ID, versionID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = sp.Exec(context.Background(), `DELETE FROM runs WHERE id=$1`, runID) })
	if _, err := a.z.revokeIdentity(injectTenant(context.Background(), tenant), tenant, ag.ID, "t", "r"); err != nil {
		t.Fatal(err)
	}
	h := &RESTHandler{srv: a.e.srv}
	if _, err := h.establishRunPrincipal(injectTenant(context.Background(), tenant), runID, tenant, "doomed"); !errors.Is(err, ErrAgentIdentityRevoked) {
		t.Fatalf("got %v", err)
	}
	var status, code string
	_ = sp.QueryRow(context.Background(), `SELECT status, error->>'code' FROM runs WHERE id=$1`, runID).Scan(&status, &code)
	if status != "failed" || code != "agent_identity_revoked" {
		t.Fatalf("run %s/%s, want failed/agent_identity_revoked", status, code)
	}
}

func TestRLSAgentAudit_AppendOnlyAndBudget(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "aj-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "counted")
	a.setPolicy(t, ag.ID, agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, Tools: []string{"*"}, Budget: agentpolicy.Budget{MaxToolCallsPerRun: 2}})
	runID := uuid.NewString()
	ctx, p, err := a.z.Establish(injectTenant(context.Background(), tenant), tenant, "counted", runID)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := p.Authorize(ctx, toolAction("t"), ""); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if err := p.Authorize(ctx, toolAction("t"), ""); err == nil || !strings.Contains(err.Error(), "maxToolCallsPerRun") {
		t.Fatalf("third call must exhaust the budget, got %v", err)
	}

	// pal_app (the app role) can neither update nor delete audit rows, and the
	// trigger refuses even the privileged pool.
	actx := injectTenant(context.Background(), tenant)
	for _, q := range []string{`UPDATE agent_identity_audit SET reason='x' WHERE tenant_id=$1`, `DELETE FROM agent_identity_audit WHERE tenant_id=$1`} {
		if err := a.e.srv.WithTenant(actx, func(tx pgx.Tx) error { _, err := tx.Exec(actx, q, tenant); return err }); err == nil {
			t.Errorf("app role ran %q", q)
		}
		if _, err := a.e.superPool.Exec(context.Background(), q, tenant); err == nil {
			t.Errorf("privileged pool ran %q on an append-only table", q)
		}
	}
	var broken int64
	_ = a.e.superPool.QueryRow(context.Background(), `SELECT agent_identity_audit_verify($1)`, tenant).Scan(&broken)
	if broken != 0 {
		t.Fatalf("chain broken at %d", broken)
	}
}

func TestRLSAgentPolicy_LegacyClassificationOfHiddenAgents(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "ak-"+uuid.NewString()[:8])
	old := a.seedAgent(t, tenant, "old-timer")
	sp := a.e.superPool
	if _, err := sp.Exec(context.Background(), `DELETE FROM agent_policies WHERE agent_id=$1`, old.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.Exec(context.Background(), `UPDATE agents SET created_at='2001-01-01' WHERE id=$1`, old.ID); err != nil {
		t.Fatal(err)
	}
	ctx, p, err := a.z.Establish(injectTenant(context.Background(), tenant), tenant, "old-timer", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Authorize(ctx, toolAction("anything"), ""); err != nil {
		t.Fatalf("a pre-cutover agent the backfill missed must be legacy-permissive: %v", err)
	}
	var mode string
	_ = sp.QueryRow(context.Background(), `SELECT mode FROM agent_policies WHERE agent_id=$1`, old.ID).Scan(&mode)
	if mode != "legacy_permissive" {
		t.Fatalf("materialized mode %q", mode)
	}
}

func TestRLSAgentPolicyPropose_FromDefinitionUnderRLS(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "al-"+uuid.NewString()[:8])
	ag := a.seedAgent(t, tenant, "flow")
	sp := a.e.superPool
	wf := `{"nodes":[{"id":"n1","type":"connector","data":{"connector":"github","action":"list_prs"}},
		{"id":"n2","type":"tool","data":{"tool":"read_file"}},{"id":"n3","type":"subagent","data":{"agentName":"helper"}}],"edges":[]}`
	if _, err := sp.Exec(context.Background(), `UPDATE agents SET workflow=$2 WHERE id=$1`, ag.ID, wf); err != nil {
		t.Fatal(err)
	}
	slug := "fs-" + uuid.NewString()[:6]
	var mcpID string
	if err := sp.QueryRow(context.Background(), `INSERT INTO mcp_servers (slug, name, description) VALUES ($1,$1,'test') RETURNING id::text`, slug).Scan(&mcpID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = sp.Exec(context.Background(), `DELETE FROM mcp_servers WHERE id=$1`, mcpID) })
	if _, err := sp.Exec(context.Background(), `INSERT INTO agent_mcp_attachments (tenant_id, agent_name, mcp_server_id) VALUES ($1,'flow',$2)`, tenant, mcpID); err != nil {
		t.Fatal(err)
	}
	rr := a.do(t, a.api.ProposePolicy, "POST", "/x", a.ownerToken(t, tenant, "owner"), nil, map[string]string{"name": "flow"}, nil)
	if rr.Code != 200 {
		t.Fatalf("propose: %d %s", rr.Code, rr.Body)
	}
	var pr proposalResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &pr)
	p := pr.Proposal
	if p.Mode != agentpolicy.ModeEnforce || len(p.Connectors["github"]) != 1 || p.Connectors["github"][0] != "list_prs" ||
		len(p.Tools) != 1 || p.Tools[0] != "read_file" || len(p.A2ATargets) != 1 || len(p.MCPServers) != 1 || p.MCPServers[0] != slug {
		t.Fatalf("proposal not least-privilege from definition: %+v", p)
	}
	// Proposals never persist: the stored policy is still default-deny.
	rr = a.do(t, a.api.GetPolicy, "GET", "/x", a.ownerToken(t, tenant, "owner"), nil, map[string]string{"name": "flow"}, nil)
	if !strings.Contains(rr.Body.String(), `"tools":[]`) {
		t.Fatalf("propose must not persist: %s", rr.Body)
	}
	// Confirm with PUT (proposal carries the current version) and verify by read-back.
	rr = a.do(t, a.api.PutPolicy, "PUT", "/x", a.ownerToken(t, tenant, "owner"), p, map[string]string{"name": "flow"}, nil)
	var after policyResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &after)
	if rr.Code != 200 || !agentpolicy.Equal(after.Policy, p) {
		t.Fatalf("apply+read-back mismatch: %d %s", rr.Code, rr.Body)
	}
}

func TestRLSAgentPolicy_HandoffLabelGrantsOnlyHandoff(t *testing.T) {
	a := newAuthzEnv(t)
	tenant := seedEnforcedTenant(t, a.e, "am-"+uuid.NewString()[:8])
	if _, err := a.e.superPool.Exec(context.Background(), `INSERT INTO agents (tenant_id, name, labels)
		VALUES ($1, 'desk', '{"handoff":"human"}')`, tenant); err != nil {
		t.Fatal(err)
	}
	ctx, p, err := a.z.Establish(injectTenant(context.Background(), tenant), tenant, "desk", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Authorize(ctx, toolAction(handoffToolName), ""); err != nil {
		t.Fatalf("declared handoff must be granted: %v", err)
	}
	for _, tool := range []string{"web_search", "slack__post_message"} {
		if err := p.Authorize(ctx, toolAction(tool), ""); err == nil {
			t.Fatalf("%s must stay denied for a handoff agent", tool)
		}
	}
}

// Regression (independent review): a whitespace-only X-Pal-Agent-Token must
// not skip the user scope check — handlers trim it to "no agent token" and
// would then run the restricted key with no scope check.
func TestWithScopeOrAgent_WhitespaceHeaderStillScopeChecked(t *testing.T) {
	t.Setenv("PAL_AUTHZ_ENFORCE", "1")
	auth := NewAuthHandler(&server.Server{Logger: zap.NewNop()}, testJWTSecret)
	reached := false
	h := auth.WithScopeOrAgent(ScopeRunsExecute, func(w http.ResponseWriter, r *http.Request) { reached = true })
	tok := mintSvcToken(t, uuid.NewString(), []string{"runs:read"})
	for _, hv := range []string{" ", "\t", ""} {
		reached = false
		req := httptest.NewRequest(http.MethodPost, "/x", nil)
		req.Header.Set("Authorization", bearerHeader(tok))
		req.Header.Set(AgentTokenHeader, hv)
		rr := httptest.NewRecorder()
		h(rr, req)
		if reached || rr.Code != http.StatusForbidden {
			t.Fatalf("header %q: reached=%v code=%d — scope check skipped", hv, reached, rr.Code)
		}
	}
	// A real (non-blank) agent token goes to the handler, which verifies it.
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set(AgentTokenHeader, "eyJ.x.y")
	h(httptest.NewRecorder(), req)
	if !reached {
		t.Fatal("agent-token request must reach the handler (which verifies it)")
	}
}

// Regression (independent review): an unverified tenant claim must not turn
// A2A invoke into a cross-tenant existence oracle for PRIVATE agents.
func TestRLSA2AInvoke_ForgedTenantClaimIsNotAnOracle(t *testing.T) {
	a := newAuthzEnv(t)
	victim := seedEnforcedTenant(t, a.e, "an-"+uuid.NewString()[:8])
	a.seedAgent(t, victim, "secret-bot") // private
	h := NewA2AHandler(a.e.srv, a.auth)
	claims := map[string]any{"typ": "agent", "iss": "pal", "tenant_id": victim, "aud": []string{"x"}, "exp": 4102444800}
	raw, _ := json.Marshal(claims)
	forged := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA","kid":"`+uuid.NewString()+`.1"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString([]byte("sig"))
	codes := map[string]int{}
	for _, name := range []string{"secret-bot", "no-such-bot"} {
		rr := a.do(t, h.InvokeAgent, "POST", "/x", "", map[string]any{"message": "hi"}, map[string]string{"name": name},
			map[string]string{AgentTokenHeader: forged})
		codes[name] = rr.Code
	}
	if codes["secret-bot"] != http.StatusNotFound || codes["no-such-bot"] != http.StatusNotFound {
		t.Fatalf("existing private agent must look like a missing one: %v", codes)
	}
}
