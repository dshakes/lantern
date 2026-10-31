package pal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ---------- Agent identity + policy (ADR 0055) ----------

// ErrAgentPolicyDenied matches (via errors.Is) any *AgentPolicyDeniedError.
var ErrAgentPolicyDenied = errors.New("pal: agent policy denied")

// ErrPolicyVersionConflict matches (via errors.Is) a PUT that lost an
// optimistic-concurrency race (409 version_conflict).
var ErrPolicyVersionConflict = errors.New("pal: agent policy version conflict")

// AgentPolicyDeniedError is returned when the server denies a dispatch
// because the agent's policy does not allow it
// (403 {"code":"agent_policy_denied", kind, target, error}). Match it with
// errors.As, or errors.Is(err, ErrAgentPolicyDenied).
type AgentPolicyDeniedError struct {
	Kind    string
	Target  string
	Message string
	API     *APIError
}

func (e *AgentPolicyDeniedError) Error() string {
	return fmt.Sprintf("pal: agent policy denied %s %q: %s", e.Kind, e.Target, e.Message)
}

// Is makes errors.Is(err, ErrAgentPolicyDenied) true.
func (e *AgentPolicyDeniedError) Is(target error) bool { return target == ErrAgentPolicyDenied }

// Unwrap exposes the underlying *APIError (Status 403, raw Body).
func (e *AgentPolicyDeniedError) Unwrap() error { return e.API }

// PolicyVersionConflictError is returned by PutAgentPolicy on 409
// version_conflict. Re-read the policy and retry.
type PolicyVersionConflictError struct{ API *APIError }

func (e *PolicyVersionConflictError) Error() string {
	return "pal: agent policy version conflict (re-read the policy and retry): " + e.API.Body
}
func (e *PolicyVersionConflictError) Is(target error) bool { return target == ErrPolicyVersionConflict }
func (e *PolicyVersionConflictError) Unwrap() error        { return e.API }

// newAPIError builds the most specific error for a >= 400 response.
func newAPIError(status int, body string) error {
	base := &APIError{Status: status, Body: body}
	var env struct {
		Code   string `json:"code"`
		Kind   string `json:"kind"`
		Target string `json:"target"`
		Error  string `json:"error"`
	}
	if json.Unmarshal([]byte(body), &env) != nil {
		return base
	}
	switch {
	case status == http.StatusForbidden && env.Code == "agent_policy_denied":
		return &AgentPolicyDeniedError{Kind: env.Kind, Target: env.Target, Message: env.Error, API: base}
	case status == http.StatusConflict && env.Code == "version_conflict":
		return &PolicyVersionConflictError{API: base}
	}
	return base
}

// Policy modes.
const (
	PolicyModeEnforce          = "enforce"
	PolicyModeLegacyPermissive = "legacy_permissive"
)

// PolicyBudget caps per-run / per-minute agent activity.
type PolicyBudget struct {
	MaxToolCallsPerRun     int `json:"maxToolCallsPerRun"`
	MaxA2AInboundPerMinute int `json:"maxA2AInboundPerMinute"`
}

// AgentPolicy is an agent's least-privilege allowlist.
type AgentPolicy struct {
	Mode        string              `json:"mode"`
	Tools       []string            `json:"tools"`
	Connectors  map[string][]string `json:"connectors"`
	MCPServers  []string            `json:"mcpServers"`
	EgressHosts []string            `json:"egressHosts"`
	A2ATargets  []string            `json:"a2aTargets"`
	A2AInbound  []string            `json:"a2aInbound"`
	Secrets     []string            `json:"secrets"`
	Budget      PolicyBudget        `json:"budget"`
	Version     int                 `json:"version"`
}

// AgentPolicyResponse is the GET/PUT policy envelope.
type AgentPolicyResponse struct {
	AgentName string      `json:"agentName"`
	AgentID   string      `json:"agentId"`
	Policy    AgentPolicy `json:"policy"`
	UpdatedAt string      `json:"updatedAt"`
	UpdatedBy string      `json:"updatedBy"`
	Warnings  []string    `json:"warnings"`
}

// PolicyRationale explains one field of a proposal.
type PolicyRationale struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

// PolicyProposal is a least-privilege proposal; it is never persisted.
type PolicyProposal struct {
	Proposal   AgentPolicy       `json:"proposal"`
	Rationale  []PolicyRationale `json:"rationale"`
	Sources    []string          `json:"sources"`
	Unresolved []string          `json:"unresolved"`
}

// AgentIdentity is an agent's cryptographic identity.
type AgentIdentity struct {
	AgentID         string          `json:"agentId"`
	SpiffeID        string          `json:"spiffeId"`
	KeyGeneration   int             `json:"keyGeneration"`
	Status          string          `json:"status"` // "active" | "revoked"
	PublicKeyJWK    json.RawMessage `json:"publicKeyJwk"`
	JWKSURI         string          `json:"jwksUri"`
	TokenTTLSeconds int             `json:"tokenTtlSeconds"`
	CreatedAt       time.Time       `json:"createdAt"`
	RotatedAt       *time.Time      `json:"rotatedAt"`
	RevokedAt       *time.Time      `json:"revokedAt"`
	RevokedReason   *string         `json:"revokedReason"`
}

// AgentToken is a minted agent-identity JWT.
type AgentToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	JTI       string `json:"jti"`
	Audience  string `json:"audience"`
}

// AgentAuditEvent is one row of the agent's hash-chained audit log.
type AgentAuditEvent struct {
	ID             int64  `json:"id"`
	Event          string `json:"event"`
	ActionKind     string `json:"actionKind"`
	Target         string `json:"target"`
	Decision       string `json:"decision"`
	Reason         string `json:"reason"`
	RunID          string `json:"runId"`
	StepID         string `json:"stepId"`
	AgentVersionID string `json:"agentVersionId"`
	JTI            string `json:"jti"`
	Principal      string `json:"principal"`
	CreatedAt      string `json:"createdAt"`
}

// AgentAuditList is the audit listing plus chain-integrity verdict.
type AgentAuditList struct {
	Events     []AgentAuditEvent `json:"events"`
	ChainValid bool              `json:"chainValid"`
}

// AuditOptions filters ListAgentAudit.
type AuditOptions struct {
	Limit int
	Event string
}

func agentPath(name, suffix string) string {
	return "/v1/agents/" + url.PathEscape(name) + suffix
}

// GetAgentPolicy returns the agent's policy and any warnings.
func (c *Client) GetAgentPolicy(ctx context.Context, name string) (*AgentPolicyResponse, error) {
	var out AgentPolicyResponse
	if err := c.do(ctx, http.MethodGet, agentPath(name, "/policy"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PutAgentPolicy replaces the policy. p.Version must be the version last read;
// a mismatch yields *PolicyVersionConflictError.
func (c *Client) PutAgentPolicy(ctx context.Context, name string, p AgentPolicy) (*AgentPolicyResponse, error) {
	var out AgentPolicyResponse
	if err := c.do(ctx, http.MethodPut, agentPath(name, "/policy"), p, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ProposeAgentPolicy asks the server for a least-privilege proposal.
func (c *Client) ProposeAgentPolicy(ctx context.Context, name string) (*PolicyProposal, error) {
	var out PolicyProposal
	if err := c.do(ctx, http.MethodPost, agentPath(name, "/policy/propose"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetAgentIdentity returns the agent's identity.
func (c *Client) GetAgentIdentity(ctx context.Context, name string) (*AgentIdentity, error) {
	var out AgentIdentity
	if err := c.do(ctx, http.MethodGet, agentPath(name, "/identity"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RotateAgentIdentity rotates the agent's signing key.
func (c *Client) RotateAgentIdentity(ctx context.Context, name string) (*AgentIdentity, error) {
	var out AgentIdentity
	if err := c.do(ctx, http.MethodPost, agentPath(name, "/identity/rotate"), map[string]any{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeAgentIdentity revokes the agent's identity.
func (c *Client) RevokeAgentIdentity(ctx context.Context, name, reason string) (*AgentIdentity, error) {
	var out AgentIdentity
	if err := c.do(ctx, http.MethodPost, agentPath(name, "/identity/revoke"), map[string]string{"reason": reason}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MintAgentToken mints a short-lived agent token (admin only). runID is optional.
func (c *Client) MintAgentToken(ctx context.Context, name, audience, runID string) (*AgentToken, error) {
	body := map[string]string{"audience": audience}
	if runID != "" {
		body["runId"] = runID
	}
	var out AgentToken
	if err := c.do(ctx, http.MethodPost, agentPath(name, "/identity/token"), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListAgentAudit lists the agent's audit events and chain integrity.
func (c *Client) ListAgentAudit(ctx context.Context, name string, opts AuditOptions) (*AgentAuditList, error) {
	q := url.Values{}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Event != "" {
		q.Set("event", opts.Event)
	}
	path := agentPath(name, "/audit")
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out AgentAuditList
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
