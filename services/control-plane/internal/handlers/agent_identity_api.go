package handlers

// agent_identity_api.go — REST surface for agent identity + policy (ADR 0055).
//
//	GET    /v1/agents/{name}/policy           agents:read
//	PUT    /v1/agents/{name}/policy           agents:write   (optimistic concurrency on version)
//	POST   /v1/agents/{name}/policy/propose   agents:read    (never persists)
//	GET    /v1/agents/{name}/identity         agents:read
//	POST   /v1/agents/{name}/identity/rotate  agents:write
//	POST   /v1/agents/{name}/identity/revoke  agents:write
//	POST   /v1/agents/{name}/identity/token   admin (JWT owner/admin)
//	GET    /v1/agents/{name}/audit            agents:read
//	GET    /.well-known/pal-agent-keys/{agentId}   public JWKS

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/packages/agentpolicy"
	"github.com/dshakes/pal/services/control-plane/internal/agentidentity"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/server"
	"github.com/dshakes/pal/services/control-plane/internal/workflow"
)

// policyProposer is the LLM seam the propose endpoint uses (capability-
// addressed through the model-router seam; invariant #6).
type policyProposer interface {
	CompleteInternalWithUsage(ctx context.Context, tenantID, system, user string) (string, int64, int64, float64, error)
}

// AgentIdentityHandler serves the identity/policy/audit endpoints.
type AgentIdentityHandler struct {
	srv  *server.Server
	auth *AuthHandler
	z    *AgentAuthz
	llm  policyProposer
}

// NewAgentIdentityHandler wires the handler. llm may be nil (propose then
// returns only the deterministic part).
func NewAgentIdentityHandler(srv *server.Server, auth *AuthHandler, z *AgentAuthz, llm policyProposer) *AgentIdentityHandler {
	return &AgentIdentityHandler{srv: srv, auth: auth, z: z, llm: llm}
}

func (h *AgentIdentityHandler) logger() *zap.Logger { return h.z.logger().Named("agent-identity") }

// resolve authenticates the caller and finds the named agent in ITS tenant.
// A missing agent (including another tenant's) is a 404.
func (h *AgentIdentityHandler) resolve(w http.ResponseWriter, r *http.Request) (context.Context, *PalClaims, agentRef, bool) {
	claims := claimsFromCtx(r.Context())
	if claims == nil {
		c, err := h.auth.validateRequest(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return nil, nil, agentRef{}, false
		}
		claims = c
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	a, ok, err := h.z.agentByName(ctx, claims.TenantID, r.PathValue("name"))
	if err != nil {
		h.logger().Error("resolve agent", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load agent"})
		return nil, nil, agentRef{}, false
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return nil, nil, agentRef{}, false
	}
	return ctx, claims, a, true
}

func actorOf(c *PalClaims) string {
	if c.Role == "service" {
		return "api-key:" + c.TenantID
	}
	if c.Email != "" {
		return "user:" + c.Email
	}
	return "user:" + c.Subject
}

// ---------- policy ----------

type policyResponse struct {
	AgentName string             `json:"agentName"`
	AgentID   string             `json:"agentId"`
	Policy    agentpolicy.Policy `json:"policy"`
	UpdatedAt time.Time          `json:"updatedAt"`
	UpdatedBy string             `json:"updatedBy"`
	Warnings  []string           `json:"warnings"`
}

func policyWarnings(p agentpolicy.Policy) []string {
	w := []string{}
	if p.Mode == agentpolicy.ModeLegacyPermissive {
		w = append(w, "legacy_permissive: this agent predates per-agent policy and may use every tool, connector, host and secret in the workspace — replace it with a least-privilege policy")
	}
	if p.Mode == agentpolicy.ModeEnforce && len(p.Tools) == 0 && len(p.Connectors) == 0 && len(p.MCPServers) == 0 {
		w = append(w, "default_deny: this agent cannot call any tool yet")
	}
	for _, h := range p.EgressHosts {
		if h == "*" && p.Mode == agentpolicy.ModeEnforce {
			w = append(w, "egress_any: egressHosts contains \"*\" (any host)")
		}
	}
	for _, s := range p.Secrets {
		if s == "*" && p.Mode == agentpolicy.ModeEnforce {
			w = append(w, "secrets_any: secrets contains \"*\" (every workspace secret)")
		}
	}
	return w
}

func (h *AgentIdentityHandler) readPolicy(ctx context.Context, a agentRef) (policyResponse, error) {
	var pr policyRow
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var err error
		pr, err = h.z.loadPolicy(ctx, tx, a.TenantID, a.ID)
		return err
	})
	if err != nil {
		return policyResponse{}, err
	}
	return policyResponse{AgentName: a.Name, AgentID: a.ID, Policy: pr.Policy, UpdatedAt: pr.UpdatedAt,
		UpdatedBy: pr.UpdatedBy, Warnings: policyWarnings(pr.Policy)}, nil
}

// GetPolicy — GET /v1/agents/{name}/policy
func (h *AgentIdentityHandler) GetPolicy(w http.ResponseWriter, r *http.Request) {
	ctx, _, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	resp, err := h.readPolicy(ctx, a)
	if err != nil {
		h.logger().Error("get policy", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load policy"})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// PutPolicy — PUT /v1/agents/{name}/policy. The body's version must equal the
// stored version (409 otherwise), so two editors cannot silently overwrite
// each other's grants.
func (h *AgentIdentityHandler) PutPolicy(w http.ResponseWriter, r *http.Request) {
	ctx, claims, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	p, err := agentpolicy.Decode(raw)
	if err != nil {
		var ve *agentpolicy.ValidationError
		if errors.As(err, &ve) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": ve.Msg, "field": ve.Field})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	doc, _ := json.Marshal(p)
	var newVersion int
	var before agentpolicy.Policy
	conflict := false
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		cur, err := h.z.loadPolicy(ctx, tx, a.TenantID, a.ID) // also materializes a missing row
		if err != nil {
			return err
		}
		before = cur.Policy
		if p.Version != cur.Policy.Version {
			conflict = true
			return nil
		}
		return tx.QueryRow(ctx, `
			UPDATE agent_policies SET mode = $2, document = $3, version = version + 1,
			       updated_by = $4, updated_at = now()
			WHERE agent_id = $1 AND version = $5 RETURNING version`,
			a.ID, string(p.Mode), doc, actorOf(claims), p.Version).Scan(&newVersion)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		conflict = true // lost a race between read and update
		err = nil
	}
	if err != nil {
		h.logger().Error("put policy", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save policy"})
		return
	}
	if conflict {
		writeJSON(w, http.StatusConflict, map[string]any{"code": "version_conflict",
			"error": "policy changed since it was read; reload and retry"})
		return
	}
	h.z.audit(ctx, auditEntry{TenantID: a.TenantID, AgentID: a.ID, AgentName: a.Name, AgentVersionID: a.VersionID,
		Event: "policy.updated", Principal: actorOf(claims), Attrs: map[string]any{
			"version": newVersion, "mode_before": string(before.Mode), "mode_after": string(p.Mode),
			"hash_before": before.Hash(), "hash_after": p.Hash(),
		}})
	resp, err := h.readPolicy(ctx, a)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "saved, but read-back failed"})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------- propose ----------

type proposalRationale struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

type proposalResponse struct {
	Proposal   agentpolicy.Policy  `json:"proposal"`
	Rationale  []proposalRationale `json:"rationale"`
	Sources    []string            `json:"sources"`
	Unresolved []string            `json:"unresolved"`
}

// ProposePolicy — POST /v1/agents/{name}/policy/propose. Builds the smallest
// policy the agent's own definition needs: deterministically from its
// workflow graph, MCP attachments and labels, then (when an LLM is
// configured) a reasoned pick of installed connector actions / web search from
// its purpose — every LLM pick is validated against the tenant's REAL catalog,
// so nothing that does not exist can be granted. Never persists: the caller
// confirms with PUT and verifies with GET.
func (h *AgentIdentityHandler) ProposePolicy(w http.ResponseWriter, r *http.Request) {
	ctx, _, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	cur, err := h.readPolicy(ctx, a)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load policy"})
		return
	}
	var (
		description, systemPrompt string
		labels, wf                []byte
		mcpSlugs                  []string
	)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT COALESCE(description, ''), COALESCE(system_prompt, ''),
				COALESCE(labels, '{}'::jsonb), COALESCE(workflow, 'null'::jsonb)
			FROM agents WHERE id = $1`, a.ID).Scan(&description, &systemPrompt, &labels, &wf); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT s.slug FROM agent_mcp_attachments m JOIN mcp_servers s ON s.id = m.mcp_server_id
			WHERE m.tenant_id = $1 AND m.agent_name = $2 ORDER BY s.slug`, a.TenantID, a.Name)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				return err
			}
			mcpSlugs = append(mcpSlugs, s)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("propose: load agent", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load agent definition"})
		return
	}
	// rls-exempt: shared connector-catalog helper takes a *Pool and
	// self-scopes by tenantID; reused identically across handlers.
	catalog, _ := toolsForTenant(ctx, h.srv.Pool, a.TenantID)
	resp := proposeFromDefinition(wf, labels, mcpSlugs, catalogNames(catalog))
	if h.llm != nil && (description != "" || systemPrompt != "") {
		h.addLLMPicks(ctx, a, description, systemPrompt, catalogNames(catalog), &resp)
	} else if h.llm == nil {
		resp.Unresolved = append(resp.Unresolved, "no LLM configured: only the workflow/MCP-derived grants are proposed")
	}
	n, err := agentpolicy.Normalize(resp.Proposal)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "proposal failed validation: " + err.Error()})
		return
	}
	n.Version = cur.Policy.Version // ready to PUT as-is
	resp.Proposal = n
	writeJSON(w, http.StatusOK, resp)
}

func catalogNames(tools []map[string]any) []string {
	out := make([]string, 0, len(tools))
	for _, t := range tools {
		fn, _ := t["function"].(map[string]any)
		if n, _ := fn["name"].(string); n != "" {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// proposeFromDefinition is the deterministic half of propose (pure).
func proposeFromDefinition(workflowJSON, labelsJSON []byte, mcpSlugs, catalog []string) proposalResponse {
	resp := proposalResponse{
		Proposal: agentpolicy.Policy{Mode: agentpolicy.ModeEnforce, Connectors: map[string][]string{},
			A2AInbound: []string{"tenant:self"}, Budget: agentpolicy.Budget{MaxToolCallsPerRun: 50}},
		Rationale:  []proposalRationale{{Field: "a2aInbound", Reason: "only agents and people in this workspace may invoke it"}, {Field: "budget.maxToolCallsPerRun", Reason: "bounded runaway tool loops (50 per run)"}},
		Sources:    []string{},
		Unresolved: []string{},
	}
	inCatalog := map[string]bool{}
	for _, c := range catalog {
		inCatalog[c] = true
	}
	var def workflow.Definition
	if len(workflowJSON) > 0 && string(workflowJSON) != "null" && json.Unmarshal(workflowJSON, &def) == nil && len(def.Nodes) > 0 {
		resp.Sources = append(resp.Sources, "workflow")
		for _, n := range def.Nodes {
			switch n.Type {
			case "tool":
				if t, _ := n.Data["tool"].(string); t != "" {
					resp.Proposal.Tools = append(resp.Proposal.Tools, t)
					resp.Rationale = append(resp.Rationale, proposalRationale{"tools." + t, "workflow node " + n.ID + " calls it"})
				}
			case "connector":
				c, _ := n.Data["connector"].(string)
				act, _ := n.Data["action"].(string)
				if c != "" && act != "" {
					resp.Proposal.Connectors[c] = append(resp.Proposal.Connectors[c], act)
					resp.Rationale = append(resp.Rationale, proposalRationale{"connectors." + c, "workflow node " + n.ID + " runs " + act})
					if !inCatalog[c+"__"+act] {
						resp.Unresolved = append(resp.Unresolved, fmt.Sprintf("connector %s is not installed in this workspace (node %s)", c, n.ID))
					}
				}
			case "subagent":
				if t, _ := n.Data["agentName"].(string); t != "" {
					resp.Proposal.A2ATargets = append(resp.Proposal.A2ATargets, t)
					resp.Rationale = append(resp.Rationale, proposalRationale{"a2aTargets." + t, "workflow node " + n.ID + " delegates to it"})
				}
			}
		}
	}
	if len(mcpSlugs) > 0 {
		resp.Sources = append(resp.Sources, "mcp_attachments")
		for _, s := range mcpSlugs {
			resp.Proposal.MCPServers = append(resp.Proposal.MCPServers, s)
			resp.Rationale = append(resp.Rationale, proposalRationale{"mcpServers." + s, "attached to the agent"})
		}
	}
	if on, _ := handoffConfig(labelsJSON); on {
		resp.Sources = append(resp.Sources, "labels")
		resp.Proposal.Tools = append(resp.Proposal.Tools, handoffToolName)
		resp.Rationale = append(resp.Rationale, proposalRationale{"tools." + handoffToolName, "handoff=human label"})
	}
	return resp
}

// addLLMPicks asks the model which of the tenant's REAL tools the agent's
// purpose needs. The model can only choose from the list; anything else it
// says is dropped and reported.
func (h *AgentIdentityHandler) addLLMPicks(ctx context.Context, a agentRef, description, systemPrompt string, catalog []string, resp *proposalResponse) {
	choices := append([]string{"web_search"}, catalog...)
	system := `You design least-privilege permissions for an AI agent. From the AVAILABLE TOOLS list, pick ONLY the tools the agent's stated purpose clearly requires. Prefer read-only actions; include a write/send action only if the purpose explicitly needs it. Never invent a tool. Reply with strict JSON: {"picks":[{"tool":"<exact name from the list>","why":"<one short sentence>"}]}. Return {"picks":[]} if none are needed.`
	user := fmt.Sprintf("AGENT NAME: %s\nDESCRIPTION: %s\nSYSTEM PROMPT (truncated): %s\n\nAVAILABLE TOOLS:\n%s",
		a.Name, truncate(description, 1500), truncate(systemPrompt, 3000), strings.Join(choices, "\n"))
	text, _, _, _, err := h.llm.CompleteInternalWithUsage(ctx, a.TenantID, system, user)
	if err != nil {
		resp.Unresolved = append(resp.Unresolved, "purpose-based suggestions unavailable (LLM call failed); only definition-derived grants are proposed")
		return
	}
	var out struct {
		Picks []struct {
			Tool string `json:"tool"`
			Why  string `json:"why"`
		} `json:"picks"`
	}
	if err := json.Unmarshal([]byte(extractJSONObject(text)), &out); err != nil {
		resp.Unresolved = append(resp.Unresolved, "purpose-based suggestions were not valid JSON; ignored")
		return
	}
	valid := map[string]bool{}
	for _, c := range choices {
		valid[c] = true
	}
	resp.Sources = append(resp.Sources, "llm")
	for _, p := range out.Picks {
		if !valid[p.Tool] {
			resp.Unresolved = append(resp.Unresolved, fmt.Sprintf("model suggested %q, which is not an available tool — dropped", truncate(p.Tool, 80)))
			continue
		}
		why := truncate(strings.TrimSpace(p.Why), 200)
		act := toolAction(p.Tool)
		if act.Kind == agentpolicy.KindConnector {
			resp.Proposal.Connectors[act.Target] = append(resp.Proposal.Connectors[act.Target], act.Sub)
			resp.Rationale = append(resp.Rationale, proposalRationale{"connectors." + act.Target, why})
		} else {
			resp.Proposal.Tools = append(resp.Proposal.Tools, p.Tool)
			resp.Rationale = append(resp.Rationale, proposalRationale{"tools." + p.Tool, why})
		}
	}
}

// ---------- identity ----------

type identityResponse struct {
	AgentID         string         `json:"agentId"`
	SpiffeID        string         `json:"spiffeId"`
	KeyGeneration   int            `json:"keyGeneration"`
	Status          string         `json:"status"`
	PublicKeyJWK    map[string]any `json:"publicKeyJwk"`
	JwksURI         string         `json:"jwksUri"`
	TokenTTLSeconds int            `json:"tokenTtlSeconds"`
	CreatedAt       time.Time      `json:"createdAt"`
	RotatedAt       *time.Time     `json:"rotatedAt"`
	RevokedAt       *time.Time     `json:"revokedAt"`
	RevokedReason   *string        `json:"revokedReason"`
}

func (h *AgentIdentityHandler) identityJSON(r identityRow) identityResponse {
	status := "active"
	if r.Revoked {
		status = "revoked"
	}
	return identityResponse{AgentID: r.AgentID, SpiffeID: r.SpiffeID, KeyGeneration: r.KeyGeneration, Status: status,
		PublicKeyJWK: agentidentity.PublicJWK(r.AgentID, r.KeyGeneration, r.PublicKey),
		JwksURI:      "/.well-known/pal-agent-keys/" + r.AgentID, TokenTTLSeconds: int(h.z.auth.TTL().Seconds()),
		CreatedAt: r.CreatedAt, RotatedAt: r.RotatedAt, RevokedAt: r.RevokedAt, RevokedReason: r.RevokedReason}
}

// GetIdentity — GET /v1/agents/{name}/identity (creates generation 1 lazily).
func (h *AgentIdentityHandler) GetIdentity(w http.ResponseWriter, r *http.Request) {
	ctx, _, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	id, err := h.z.ensureIdentity(ctx, a.TenantID, a.ID)
	if err != nil {
		h.logger().Error("get identity", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load identity"})
		return
	}
	writeJSON(w, http.StatusOK, h.identityJSON(id))
}

// RotateIdentity — POST /v1/agents/{name}/identity/rotate
func (h *AgentIdentityHandler) RotateIdentity(w http.ResponseWriter, r *http.Request) {
	ctx, claims, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	id, err := h.z.rotateIdentity(ctx, a.TenantID, a.ID, actorOf(claims))
	if err != nil {
		h.logger().Error("rotate identity", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to rotate identity"})
		return
	}
	writeJSON(w, http.StatusOK, h.identityJSON(id))
}

// RevokeIdentity — POST /v1/agents/{name}/identity/revoke {reason}
func (h *AgentIdentityHandler) RevokeIdentity(w http.ResponseWriter, r *http.Request) {
	ctx, claims, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body)
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "reason is required", "field": "reason"})
		return
	}
	id, err := h.z.revokeIdentity(ctx, a.TenantID, a.ID, actorOf(claims), truncate(body.Reason, 500))
	if err != nil {
		h.logger().Error("revoke identity", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to revoke identity"})
		return
	}
	writeJSON(w, http.StatusOK, h.identityJSON(id))
}

// MintToken — POST /v1/agents/{name}/identity/token {audience, runId?}.
// Lets the agent's OWNER obtain a token to act as the agent (like
// generateIdToken on a service account). Owner/admin sessions or an
// admin-scoped key only. The token is returned once and never logged.
func (h *AgentIdentityHandler) MintToken(w http.ResponseWriter, r *http.Request) {
	ctx, claims, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	if !canMintAgentToken(claims) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "minting an agent token requires an owner/admin session or an admin-scoped key"})
		return
	}
	var body struct {
		Audience string `json:"audience"`
		RunID    string `json:"runId"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body); err != nil || strings.TrimSpace(body.Audience) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "audience is required", "field": "audience"})
		return
	}
	if body.RunID != "" && uuid.Validate(body.RunID) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "runId must be a UUID", "field": "runId"})
		return
	}
	id, err := h.z.ensureIdentity(ctx, a.TenantID, a.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load identity"})
		return
	}
	if id.Revoked {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "agent_identity_revoked", "error": "identity is revoked; rotate to re-issue"})
		return
	}
	tok, c, err := h.z.auth.Mint(agentidentity.MintRequest{Identity: id.IdentityRecord, AgentName: a.Name,
		AgentVersionID: a.VersionID, RunID: body.RunID, Audience: strings.TrimSpace(body.Audience)})
	if err != nil {
		h.logger().Error("mint agent token", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to mint token"})
		return
	}
	h.z.audit(ctx, auditEntry{TenantID: a.TenantID, AgentID: a.ID, AgentName: a.Name, AgentVersionID: a.VersionID,
		RunID: body.RunID, Event: "token.minted", Principal: actorOf(claims), JTI: c.ID,
		Attrs: map[string]any{"audience": c.Audience[0], "on_behalf": true}})
	writeJSON(w, http.StatusOK, map[string]any{"token": tok, "expiresAt": c.ExpiresAt.Time, "jti": c.ID, "audience": c.Audience[0]})
}

func canMintAgentToken(c *PalClaims) bool {
	if c.Role == "service" {
		for _, s := range c.Scopes {
			if s == ScopeAdmin {
				return true
			}
		}
		return false
	}
	return c.Role == "owner" || c.Role == "admin"
}

// ---------- audit ----------

type auditEventJSON struct {
	ID             int64     `json:"id"`
	Event          string    `json:"event"`
	ActionKind     string    `json:"actionKind"`
	Target         string    `json:"target"`
	Decision       string    `json:"decision"`
	Reason         string    `json:"reason"`
	RunID          string    `json:"runId"`
	StepID         string    `json:"stepId"`
	AgentVersionID string    `json:"agentVersionId"`
	JTI            string    `json:"jti"`
	Principal      string    `json:"principal"`
	CreatedAt      time.Time `json:"createdAt"`
}

// ListAudit — GET /v1/agents/{name}/audit?limit=&event=. chainValid
// recomputes the tenant's whole hash chain in the database.
func (h *AgentIdentityHandler) ListAudit(w http.ResponseWriter, r *http.Request) {
	ctx, _, a, ok := h.resolve(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	event := r.URL.Query().Get("event")
	events := []auditEventJSON{}
	var brokenAt int64
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, event, action_kind, target, decision, reason, run_id, step_id, agent_version_id, jti, principal, created_at
			FROM agent_identity_audit
			WHERE tenant_id = $1 AND agent_id = $2 AND ($3 = '' OR event = $3)
			ORDER BY chain_seq DESC LIMIT $4`, a.TenantID, a.ID, event, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e auditEventJSON
			if err := rows.Scan(&e.ID, &e.Event, &e.ActionKind, &e.Target, &e.Decision, &e.Reason, &e.RunID,
				&e.StepID, &e.AgentVersionID, &e.JTI, &e.Principal, &e.CreatedAt); err != nil {
				return err
			}
			events = append(events, e)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT agent_identity_audit_verify($1)`, a.TenantID).Scan(&brokenAt)
	})
	if err != nil {
		h.logger().Error("list audit", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load audit"})
		return
	}
	resp := map[string]any{"events": events, "chainValid": brokenAt == 0}
	if brokenAt != 0 {
		resp["chainBrokenAt"] = brokenAt
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------- public JWKS ----------

// AgentJWKS — GET /.well-known/pal-agent-keys/{agentId}. Public: lets any
// verifier (another platform's A2A server) check an agent token offline. Only
// the CURRENT key of an ACTIVE identity is published; a revoked agent has no
// valid key. Unknown and revoked look identical (404).
func (h *AgentIdentityHandler) AgentJWKS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("agentId")
	if uuid.Validate(id) != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	rec, err := h.z.lookupIdentity(r.Context(), id)
	if err != nil || rec.Revoked {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=60")
	writeJSON(w, http.StatusOK, map[string]any{"keys": []any{agentidentity.PublicJWK(rec.AgentID, rec.KeyGeneration, rec.PublicKey)}})
}
