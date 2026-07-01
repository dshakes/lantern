package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// A2AHandler provides REST endpoints for the A2A (Agent-to-Agent) protocol.
// Agents can publish Agent Cards for cross-platform discovery and invoke
// each other using the standardized A2A request format.
type A2AHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewA2AHandler creates a new A2AHandler.
func NewA2AHandler(srv *server.Server, auth *AuthHandler) *A2AHandler {
	return &A2AHandler{srv: srv, auth: auth}
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
}

// AgentCardAuth describes the authentication requirements for invoking an agent.
type AgentCardAuth struct {
	Type        string `json:"type"`
	Description string `json:"description"`
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
	)
	// rls-exempt: public A2A card discovery — intentionally cross-tenant. Serves
	// anonymous callers (tenantID == "") and is gated by the explicit
	// `is_public = true OR tenant_id = $2` clause, not by RLS. Running under the
	// app role would hide other tenants' public agents from discovery.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT a.description, a.labels, COALESCE(av.version, '') AS version
		FROM agents a
		LEFT JOIN agent_versions av ON av.id = a.current_version_id
		WHERE a.name = $1 AND a.archived_at IS NULL
		  AND (a.is_public = true OR a.tenant_id = $2)
		LIMIT 1
	`, name, nullableTenant(tenantID)).Scan(&description, &labelsJSON, &version)
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
		Endpoint:     "https://api.lantern.run/v1/agents/" + name + "/a2a/invoke",
		Auth: AgentCardAuth{
			Type:        "bearer",
			Description: "Lantern API key",
		},
		InputSchema:  defaultInput,
		OutputSchema: defaultOutput,
		Provider: AgentCardProvider{
			Name: "Lantern",
			URL:  "https://lantern.run",
		},
	}

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
		SELECT a.name, a.description, a.labels, COALESCE(av.version, '') AS version
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
		)
		if err := rows.Scan(&name, &description, &labelsJSON, &version); err != nil {
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

		cards = append(cards, AgentCard{
			Name:         name,
			Description:  desc,
			Version:      version, // real version from agent_versions; "" when none deployed
			Capabilities: caps,
			Endpoint:     "https://api.lantern.run/v1/agents/" + name + "/a2a/invoke",
			Auth: AgentCardAuth{
				Type:        "bearer",
				Description: "Lantern API key",
			},
			InputSchema:  json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}}}`),
			OutputSchema: json.RawMessage(`{"type":"object","properties":{"result":{"type":"string"}}}`),
			Provider: AgentCardProvider{
				Name: "Lantern",
				URL:  "https://lantern.run",
			},
		})
	}
	if err := rows.Err(); err != nil {
		h.logger().Error("row iteration failed for agent directory", zap.Error(err))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"agents":   cards,
		"provider": map[string]string{"name": "Lantern", "url": "https://lantern.run"},
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

	// The invoke endpoint requires authentication.
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
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
	var agentID, agentTenantID string
	// rls-exempt: authenticated A2A invoke is intentionally cross-tenant — a
	// caller may invoke its OWN agent OR any tenant's `is_public` agent (the
	// whole point of A2A). The explicit `is_public = true OR tenant_id = $2`
	// clause does the gating; RLS would block legitimate public invocations.
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, tenant_id FROM agents
		WHERE name = $1 AND archived_at IS NULL
		  AND (is_public = true OR tenant_id = $2)
		LIMIT 1
	`, name, claims.TenantID).Scan(&agentID, &agentTenantID)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if err != nil {
		h.logger().Error("lookup agent for a2a invoke failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to look up agent"})
		return
	}

	h.logger().Info("a2a invoke (not yet wired to real execution)",
		zap.String("agent", name),
		zap.String("agentTenant", agentTenantID),
		zap.String("callerTenant", claims.TenantID),
	)

	// ponytail: 501 until A2AHandler is wired to RESTHandler.executeRunInline
	// (requires sharing InFlightRuns + RunService — same work as marketplace_invoke.go).
	// Returning a fabricated "completed" status here would tell callers the agent ran
	// when it never did. 501 is honest; upgrade to real execution when wiring is done.
	writeJSON(w, http.StatusNotImplemented, map[string]string{
		"error": "A2A invoke is not yet wired to a real execution backend; the agent was not executed",
	})
}
