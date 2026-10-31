package handlers

import (
	"context"
	"encoding/json"
	"github.com/dshakes/pal/packages/agentpolicy"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// A2AHandler provides REST endpoints for the A2A (Agent-to-Agent) protocol.
// Agents can publish Agent Cards for cross-platform discovery and invoke
// each other using the standardized A2A request format.
type A2AHandler struct {
	srv    *server.Server
	auth   *AuthHandler
	runSvc *RunService  // injected to support real invoke execution
	rest   *RESTHandler // for kicking off inline execution after invoke
}

// NewA2AHandler creates a new A2AHandler.
func NewA2AHandler(srv *server.Server, auth *AuthHandler) *A2AHandler {
	return &A2AHandler{srv: srv, auth: auth}
}

// SetExecutionDeps wires the run service + REST handler after construction
// so InvokeAgent can kick off a real run on behalf of the agent's tenant.
// Optional — if unset, InvokeAgent returns a clear 503.
func (h *A2AHandler) SetExecutionDeps(runSvc *RunService, rest *RESTHandler) {
	h.runSvc = runSvc
	h.rest = rest
}

func (h *A2AHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("a2a")
}

// ---------- Agent Card types ----------

// AgentCard represents the A2A Agent Card — a JSON manifest describing what
// an agent does, its capabilities, and how to interact with it.
type AgentCard struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Version      string            `json:"version"`
	Capabilities []string          `json:"capabilities"`
	Endpoint     string            `json:"endpoint"`
	Auth         AgentCardAuth     `json:"auth"`
	InputSchema  json.RawMessage   `json:"inputSchema"`
	OutputSchema json.RawMessage   `json:"outputSchema"`
	Provider     AgentCardProvider `json:"provider"`
	// SpiffeID is the agent's principal (ADR 0055); an agent caller mints a
	// token with this as its audience. JwksURI serves the verifying key.
	SpiffeID string `json:"spiffeId,omitempty"`
	JwksURI  string `json:"jwksUri,omitempty"`
}

// AgentCardAuth describes the authentication requirements for invoking an agent.
type AgentCardAuth struct {
	Type        string `json:"type"`
	Description string `json:"description"`
	Header      string `json:"header,omitempty"`
	Audience    string `json:"audience,omitempty"`
}

// agentCardIdentity fills the card's identity fields (ADR 0055 §8): agents
// authenticate as themselves with a short-lived, audience-bound agent token —
// never a long-lived API key.
func agentCardIdentity(card *AgentCard, tenantID, agentID string) {
	card.Auth = AgentCardAuth{Type: "agent-token", Header: AgentTokenHeader,
		Description: "Short-lived EdDSA agent token whose audience is this agent's SPIFFE id; human callers may use a PAL session instead"}
	if z := currentAgentAuthz(); z != nil && agentID != "" {
		card.SpiffeID = z.auth.SpiffeID(tenantID, agentID)
		card.Auth.Audience = card.SpiffeID
		card.JwksURI = "/.well-known/pal-agent-keys/" + agentID
	}
}

// AgentCardProvider identifies who hosts the agent.
type AgentCardProvider struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// nullableTenant maps an empty tenant ID to a typed SQL NULL so that the
// "tenant_id = $N" ownership clause never matches a real row for an
// anonymous caller. agents.tenant_id is UUID NOT NULL, so a NULL comparison
// is always false — leaving only the is_public clause in force.
func nullableTenant(tenantID string) any {
	if tenantID == "" {
		return nil
	}
	return tenantID
}

// callerTenant returns the authenticated caller's tenant ID, or "" when the
// request carries no valid credentials. A2A endpoints are optionally
// authenticated: an authed caller may see its OWN agents regardless of
// visibility; everyone else is restricted to is_public agents.
func (h *A2AHandler) callerTenant(r *http.Request) string {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return ""
	}
	return claims.TenantID
}

// ---------- GET /v1/agents/{name}/card ----------

// GetAgentCard returns the A2A Agent Card for a specific agent. This endpoint
// is optionally authenticated: a tenant may card its OWN agents (any
// visibility), while everyone else only sees agents marked is_public. An
// agent that is neither owned by the caller nor public returns 404 — never
// leaking the existence of another tenant's private agent.
func (h *A2AHandler) GetAgentCard(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name is required"})
		return
	}

	// Visibility scope: either the agent is public, or it is owned by the
	// authenticated caller's tenant. callerTenant is "" for anonymous
	// requests, which collapses the second clause to false (public-only).
	ctx := r.Context()
	tenantID := h.callerTenant(r)
	var (
		description *string
		labelsJSON  []byte
		version     string
		agentID     string
		ownerTenant string
	)
	// rls-exempt: public A2A card discovery — intentionally cross-tenant. Serves
	// anonymous callers (tenantID == "") and is gated by the explicit
	// `is_public = true OR tenant_id = $2` clause, not by RLS. Running under the
	// app role would hide other tenants' public agents from discovery.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT a.description, a.labels, COALESCE(av.version, '') AS version, a.id::text, a.tenant_id::text
		FROM agents a
		LEFT JOIN agent_versions av ON av.id = a.current_version_id
		WHERE a.name = $1 AND a.archived_at IS NULL
		  AND (a.is_public = true OR a.tenant_id = $2)
		LIMIT 1
	`, name, nullableTenant(tenantID)).Scan(&description, &labelsJSON, &version, &agentID, &ownerTenant)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if err != nil {
		h.logger().Error("get agent for card failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to fetch agent"})
		return
	}

	desc := ""
	if description != nil {
		desc = *description
	}

	// Extract capabilities from labels if present. Default to empty — never
	// fabricate capabilities the agent hasn't declared.
	caps := []string{}
	labels := make(map[string]string)
	if err := json.Unmarshal(labelsJSON, &labels); err == nil {
		if c, ok := labels["capabilities"]; ok && c != "" {
			var parsed []string
			if json.Unmarshal([]byte(c), &parsed) == nil {
				caps = parsed
			}
		}
	}

	defaultInput := json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}}}`)
	defaultOutput := json.RawMessage(`{"type":"object","properties":{"result":{"type":"string"}}}`)

	card := AgentCard{
		Name:         name,
		Description:  desc,
		Version:      version, // real version from agent_versions; "" when no version deployed yet
		Capabilities: caps,
		Endpoint:     derivePublicURL(r) + "/v1/agents/" + name + "/a2a/invoke",
		InputSchema:  defaultInput,
		OutputSchema: defaultOutput,
		Provider: AgentCardProvider{
			Name: "PAL",
			URL:  "https://dshakes.github.io/pal",
		},
	}

	agentCardIdentity(&card, ownerTenant, agentID)
	writeJSON(w, http.StatusOK, card)
}

// ---------- GET /.well-known/agent.json ----------

// AgentDirectory returns the platform's agent directory — only agents marked
// is_public, as Agent Cards. This follows the A2A well-known endpoint
// convention and is served to anonymous callers, so it must never list a
// tenant's private agents.
func (h *A2AHandler) AgentDirectory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// rls-exempt: public A2A directory — anonymous, cross-tenant by design,
	// gated by `is_public = true`. Must bypass RLS to list every tenant's
	// public agents in the well-known directory.
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT a.name, a.description, a.labels, COALESCE(av.version, '') AS version, a.id::text, a.tenant_id::text
		FROM agents a
		LEFT JOIN agent_versions av ON av.id = a.current_version_id
		WHERE a.archived_at IS NULL AND a.is_public = true
		ORDER BY a.created_at DESC
		LIMIT 100
	`)
	if err != nil {
		h.logger().Error("agent directory query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list agents"})
		return
	}
	defer rows.Close()

	cards := make([]AgentCard, 0)
	for rows.Next() {
		var (
			name        string
			description *string
			labelsJSON  []byte
			version     string
			agentID     string
			ownerTenant string
		)
		if err := rows.Scan(&name, &description, &labelsJSON, &version, &agentID, &ownerTenant); err != nil {
			h.logger().Error("scan agent row for directory failed", zap.Error(err))
			continue
		}

		desc := ""
		if description != nil {
			desc = *description
		}

		// Default to empty — never fabricate capabilities the agent hasn't declared.
		caps := []string{}
		labels := make(map[string]string)
		if err := json.Unmarshal(labelsJSON, &labels); err == nil {
			if c, ok := labels["capabilities"]; ok && c != "" {
				var parsed []string
				if json.Unmarshal([]byte(c), &parsed) == nil {
					caps = parsed
				}
			}
		}

		card := AgentCard{
			Name:         name,
			Description:  desc,
			Version:      version, // real version from agent_versions; "" when none deployed
			Capabilities: caps,
			Endpoint:     derivePublicURL(r) + "/v1/agents/" + name + "/a2a/invoke",
			InputSchema:  json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}}}`),
			OutputSchema: json.RawMessage(`{"type":"object","properties":{"result":{"type":"string"}}}`),
			Provider: AgentCardProvider{
				Name: "PAL",
				URL:  "https://dshakes.github.io/pal",
			},
		}
		agentCardIdentity(&card, ownerTenant, agentID)
		cards = append(cards, card)
	}
	if err := rows.Err(); err != nil {
		h.logger().Error("row iteration failed for agent directory", zap.Error(err))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"agents":   cards,
		"provider": map[string]string{"name": "PAL", "url": "https://dshakes.github.io/pal"},
	})
}

// ---------- POST /v1/agents/{name}/a2a/invoke ----------

// InvokeAgent handles an A2A invocation — it accepts a standardized A2A
// request, creates a run for the specified agent, and returns the result.
func (h *A2AHandler) InvokeAgent(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent name is required"})
		return
	}

	// The caller is either an AGENT presenting its own short-lived token
	// (ADR 0055 — the agent→agent path) or a human / API key.
	agentTok := strings.TrimSpace(r.Header.Get(AgentTokenHeader))
	var callerTenant string
	if agentTok != "" {
		callerTenant = unverifiedAgentTenant(agentTok) // only to resolve the name; verified below
	} else {
		claims, err := h.auth.validateRequest(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		callerTenant = claims.TenantID
	}

	var body struct {
		Message string         `json:"message"`
		Input   map[string]any `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Only invocable if the agent is the caller's own (same tenant) or is
	// explicitly is_public. Anything else returns 404 — we do NOT 403, to
	// avoid leaking the existence of another tenant's private agent.
	ctx := r.Context()
	var target agentRef
	// rls-exempt: authenticated A2A invoke is intentionally cross-tenant — a
	// caller may invoke its OWN agent OR any tenant's `is_public` agent (the
	// whole point of A2A). The explicit `is_public = true OR tenant_id = $2`
	// clause does the gating; RLS would block legitimate public invocations.
	// Own-tenant first so a name never resolves to a stranger's agent.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT id::text, name, tenant_id::text, COALESCE(current_version_id::text, ''), created_at FROM agents
		WHERE name = $1 AND archived_at IS NULL
		  AND (is_public = true OR tenant_id::text = $2)
		ORDER BY (tenant_id::text = $2) DESC, created_at
		LIMIT 1
	`, name, callerTenant).Scan(&target.ID, &target.Name, &target.TenantID, &target.VersionID, &target.CreatedAt)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if err != nil {
		h.logger().Error("lookup agent for a2a invoke failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to look up agent"})
		return
	}
	agentTenantID := target.TenantID
	z := currentAgentAuthz()

	// Caller identity + caller policy (outbound) + target policy (inbound).
	callerID := "tenant:" + callerTenant
	if agentTok != "" {
		if z == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "agent_token_invalid", "error": "agent identity not configured"})
			return
		}
		// The token must be bound to THIS target (audience = target SPIFFE id).
		caller, verr := z.agentCallerFromRequest(r, z.auth.SpiffeID(target.TenantID, target.ID))
		if verr != nil || caller.TenantID != callerTenant {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "agent_token_invalid", "error": "invalid agent token"})
			return
		}
		callerID = caller.SpiffeID
		cctx := withAgentPrincipal(middleware.InjectTenantID(ctx, caller.TenantID), caller)
		if err := caller.Authorize(cctx, agentpolicy.Action{Kind: agentpolicy.KindA2A, Target: target.Name,
			Aliases: []string{z.auth.SpiffeID(target.TenantID, target.ID)}}, ""); err != nil {
			writeAgentPolicyDenied(w, err)
			return
		}
	}
	if err := z.authorizeInbound(ctx, target, callerID, callerTenant, agentTok != ""); err != nil {
		writeAgentPolicyDenied(w, err)
		return
	}
	if h.rest == nil || h.runSvc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "A2A invoke requires execution deps — call SetExecutionDeps at boot",
		})
		return
	}

	// Merge body.Message into input for callers using the message-only form.
	input := body.Input
	if input == nil {
		input = map[string]any{}
	}
	if body.Message != "" {
		input["message"] = body.Message
	}

	// Execute on the agent's own tenant so the agent uses its own LLM keys
	// and budgets — same pattern as marketplace_invoke.go.
	agentCtx := middleware.InjectTenantID(context.Background(), agentTenantID)
	agentCtx = metadata.NewIncomingContext(agentCtx, metadata.Pairs("tenant_id", agentTenantID))

	inputStruct, _ := structpb.NewStruct(input)
	run, runErr := h.runSvc.CreateRun(agentCtx, &palv1.CreateRunRequest{
		AgentName:   name,
		Input:       inputStruct,
		TriggerKind: palv1.TriggerKind_TRIGGER_KIND_MANUAL,
	})
	if runErr != nil {
		h.logger().Error("a2a invoke: CreateRun failed",
			zap.String("agent", name),
			zap.String("agentTenant", agentTenantID),
			zap.Error(runErr),
		)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"status": "failed",
			"error":  runErr.Error(),
		})
		return
	}

	runID := run.GetId()
	h.logger().Info("a2a invoke: run created",
		zap.String("agent", name),
		zap.String("agentTenant", agentTenantID),
		zap.String("callerTenant", callerTenant),
		zap.String("caller", callerID),
		zap.String("runId", runID),
	)

	// Kick off inline execution on the agent's tenant. Tracked by inFlightRuns
	// so SIGTERM drain waits for it to finish.
	h.rest.inFlightRuns.Add(1)
	go func() {
		defer h.rest.inFlightRuns.Done()
		h.rest.executeRunInline(runID, agentTenantID, name, input)
	}()

	// Poll up to 60s for the run to complete. The inline executor runs in-process
	// so for most agents this resolves well within the timeout.
	deadline := time.Now().Add(60 * time.Second)
	var status string
	var outputRaw, errRaw []byte
	for time.Now().Before(deadline) {
		// rls-exempt: A2A invoke is intentionally cross-tenant — caller invokes
		// the agent's OWN tenant's run (scoped by agentTenantID). Same rationale
		// as marketplace invoke (ADR 0011).
		_ = h.srv.Pool.QueryRow(ctx, `
			SELECT status,
			       COALESCE(output, 'null'::jsonb),
			       COALESCE(error, 'null'::jsonb)
			FROM runs WHERE id = $1 AND tenant_id = $2
		`, runID, agentTenantID).Scan(&status, &outputRaw, &errRaw)
		if status == "succeeded" || status == "failed" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if status != "succeeded" {
		errMsg := "agent run did not succeed: " + status
		if len(errRaw) > 0 && string(errRaw) != "null" {
			errMsg = string(errRaw)
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"runId":  runID,
			"status": status,
			"error":  errMsg,
		})
		return
	}

	var output any
	_ = json.Unmarshal(outputRaw, &output)

	writeJSON(w, http.StatusOK, map[string]any{
		"runId":  runID,
		"status": "succeeded",
		"output": output,
	})
}
