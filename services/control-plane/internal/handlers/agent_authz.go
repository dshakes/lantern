package handlers

// agent_authz.go — agent identity + per-agent least-privilege policy
// enforcement (ADR 0055).
//
// Shape:
//
//	ctx, p, err := authz.Establish(ctx, tenantID, agentName, runID)   // once per run/session turn
//	...
//	if err := principalFrom(ctx).Authorize(ctx, action, stepID); err != nil { deny }   // every dispatch
//
// Establish mints an audience-bound agent token and verifies it through the
// same verifier external tokens use; the AgentPrincipal it places in ctx is
// derived from the VERIFIED claims. Authorize re-reads identity status and the
// policy on every call (one indexed query), so a revoke or a policy edit lands
// on the next tool call of an in-flight run, then writes one audit row.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"

	"github.com/dshakes/pal/packages/agentpolicy"
	"github.com/dshakes/pal/services/control-plane/internal/agentidentity"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// Audiences (ADR 0055 §2).
const (
	AudienceDispatch   = "pal:dispatch"
	AudienceConnectors = "pal:connectors"
	AudienceRuntime    = "pal:runtime"
	marketplaceAudPfx  = "pal:marketplace/"

	// AgentTokenHeader carries an agent token on agent-as-caller requests.
	AgentTokenHeader = "X-Pal-Agent-Token"

	envAgentPolicyStrict = "PAL_AGENT_POLICY_STRICT"
)

var (
	// ErrAgentPolicyDenied is wrapped by every policy denial.
	ErrAgentPolicyDenied = errors.New("agent policy denied")
	// ErrAgentIdentityRevoked: the agent's identity is revoked; it may not run.
	ErrAgentIdentityRevoked = errors.New("agent identity revoked")
)

// AgentPolicyDeniedError is the typed denial returned by Authorize.
type AgentPolicyDeniedError struct {
	Kind   agentpolicy.Kind
	Target string
	Reason string
}

func (e *AgentPolicyDeniedError) Error() string {
	return fmt.Sprintf("agent policy denied %s %q: %s", e.Kind, e.Target, e.Reason)
}

func (e *AgentPolicyDeniedError) Unwrap() error { return ErrAgentPolicyDenied }

// writeAgentPolicyDenied renders a denial as 403 {code:agent_policy_denied}.
func writeAgentPolicyDenied(w http.ResponseWriter, err error) bool {
	var d *AgentPolicyDeniedError
	if !errors.As(err, &d) {
		return false
	}
	writeJSON(w, http.StatusForbidden, map[string]string{
		"code": "agent_policy_denied", "kind": string(d.Kind), "target": d.Target, "error": d.Error(),
	})
	return true
}

// AgentAuthz owns identity rows, token mint/verify, policy reads and audit.
type AgentAuthz struct {
	srv  *server.Server
	auth *agentidentity.Authority
}

// NewAgentAuthz builds the enforcer. fallbackSecret is the JWT secret (dev
// root-key fallback; see agentidentity.NewAuthority).
func NewAgentAuthz(srv *server.Server, fallbackSecret []byte) *AgentAuthz {
	auth, source := agentidentity.Default(fallbackSecret)
	if srv != nil && srv.Logger != nil {
		lvl := srv.Logger.Info
		if strings.Contains(source, "fallback") {
			lvl = srv.Logger.Warn
		}
		lvl("agent identity root key", zap.String("source", source), zap.Duration("token_ttl", auth.TTL()))
	}
	return &AgentAuthz{srv: srv, auth: auth}
}

func (z *AgentAuthz) logger() *zap.Logger {
	if z.srv != nil && z.srv.Logger != nil {
		return z.srv.Logger
	}
	return zap.NewNop()
}

// ---------- principal in context ----------

type agentPrincipalKey struct{}

// AgentPrincipal is a verified agent acting in this context.
type AgentPrincipal struct {
	TenantID       string
	AgentID        string
	AgentName      string
	AgentVersionID string
	RunID          string
	SpiffeID       string

	z        *AgentAuthz
	audience string
	mu       sync.Mutex
	jti      string
	exp      time.Time
	gen      int
}

func withAgentPrincipal(ctx context.Context, p *AgentPrincipal) context.Context {
	return context.WithValue(ctx, agentPrincipalKey{}, p)
}

// principalFrom returns the agent principal in ctx, or nil.
func principalFrom(ctx context.Context) *AgentPrincipal {
	p, _ := ctx.Value(agentPrincipalKey{}).(*AgentPrincipal)
	return p
}

// ---------- identity rows ----------

type identityRow struct {
	agentidentity.IdentityRecord
	RevokedReason *string
	CreatedAt     time.Time
	RotatedAt     *time.Time
	RevokedAt     *time.Time
}

func scanIdentity(row pgx.Row) (identityRow, error) {
	var r identityRow
	var status string
	var pub []byte
	err := row.Scan(&r.AgentID, &r.TenantID, &r.SpiffeID, &r.KeyGeneration, &pub, &status,
		&r.RevokedReason, &r.CreatedAt, &r.RotatedAt, &r.RevokedAt)
	r.PublicKey = pub
	r.Revoked = status == "revoked"
	return r, err
}

const identityCols = `agent_id::text, tenant_id::text, spiffe_id, key_generation, public_key, status, revoked_reason, created_at, rotated_at, revoked_at`

// lookupIdentity resolves an identity by agent id for token verification.
// rls-exempt: pre-auth key resolution — the token's kid names the agent and
// the tenant is the OUTPUT of verification (same as API-key validation). Only
// the public half is read.
func (z *AgentAuthz) lookupIdentity(ctx context.Context, agentID string) (agentidentity.IdentityRecord, error) {
	r, err := scanIdentity(z.srv.Pool.QueryRow(ctx, `SELECT `+identityCols+` FROM agent_identities WHERE agent_id = $1`, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return agentidentity.IdentityRecord{}, agentidentity.ErrAgentTokenUnknownKey
	}
	return r.IdentityRecord, err
}

// ensureIdentity returns the agent's identity, creating generation 1 on first
// use. Tenant-scoped (ctx must carry tenantID).
func (z *AgentAuthz) ensureIdentity(ctx context.Context, tenantID, agentID string) (identityRow, error) {
	ctx = middleware.InjectTenantID(ctx, tenantID)
	var r identityRow
	created := false
	err := z.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var err error
		r, err = scanIdentity(tx.QueryRow(ctx, `SELECT `+identityCols+` FROM agent_identities WHERE agent_id = $1`, agentID))
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		pub, err := z.auth.PublicKey(tenantID, agentID, 1)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO agent_identities (agent_id, tenant_id, spiffe_id, key_generation, public_key)
			VALUES ($1, $2, $3, 1, $4) ON CONFLICT (agent_id) DO NOTHING`,
			agentID, tenantID, z.auth.SpiffeID(tenantID, agentID), []byte(pub))
		if err != nil {
			return err
		}
		created = tag.RowsAffected() == 1
		r, err = scanIdentity(tx.QueryRow(ctx, `SELECT `+identityCols+` FROM agent_identities WHERE agent_id = $1`, agentID))
		return err
	})
	if err != nil {
		return identityRow{}, fmt.Errorf("agent identity: %w", err)
	}
	if created {
		z.audit(ctx, auditEntry{TenantID: tenantID, AgentID: agentID, Event: "identity.created",
			Principal: r.SpiffeID, Attrs: map[string]any{"key_generation": 1}})
	}
	return r, nil
}

// rotateIdentity bumps the key generation (re-activating a revoked identity).
func (z *AgentAuthz) rotateIdentity(ctx context.Context, tenantID, agentID, actor string) (identityRow, error) {
	if _, err := z.ensureIdentity(ctx, tenantID, agentID); err != nil {
		return identityRow{}, err
	}
	ctx = middleware.InjectTenantID(ctx, tenantID)
	var r identityRow
	err := z.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var gen int
		if err := tx.QueryRow(ctx, `SELECT key_generation FROM agent_identities WHERE agent_id = $1 FOR UPDATE`, agentID).Scan(&gen); err != nil {
			return err
		}
		pub, err := z.auth.PublicKey(tenantID, agentID, gen+1)
		if err != nil {
			return err
		}
		r, err = scanIdentity(tx.QueryRow(ctx, `
			UPDATE agent_identities SET key_generation = $2, public_key = $3, status = 'active',
			       revoked_reason = NULL, revoked_at = NULL, rotated_at = now()
			WHERE agent_id = $1 RETURNING `+identityCols, agentID, gen+1, []byte(pub)))
		return err
	})
	if err != nil {
		return identityRow{}, fmt.Errorf("rotate agent identity: %w", err)
	}
	z.audit(ctx, auditEntry{TenantID: tenantID, AgentID: agentID, Event: "identity.rotated", Principal: actor,
		Attrs: map[string]any{"key_generation": r.KeyGeneration}})
	return r, nil
}

// revokeIdentity marks the identity revoked and bumps the generation so every
// outstanding token dies with it.
func (z *AgentAuthz) revokeIdentity(ctx context.Context, tenantID, agentID, actor, reason string) (identityRow, error) {
	if _, err := z.ensureIdentity(ctx, tenantID, agentID); err != nil {
		return identityRow{}, err
	}
	ctx = middleware.InjectTenantID(ctx, tenantID)
	var r identityRow
	err := z.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var gen int
		if err := tx.QueryRow(ctx, `SELECT key_generation FROM agent_identities WHERE agent_id = $1 FOR UPDATE`, agentID).Scan(&gen); err != nil {
			return err
		}
		pub, err := z.auth.PublicKey(tenantID, agentID, gen+1)
		if err != nil {
			return err
		}
		r, err = scanIdentity(tx.QueryRow(ctx, `
			UPDATE agent_identities SET key_generation = $2, public_key = $3, status = 'revoked',
			       revoked_reason = $4, revoked_at = now()
			WHERE agent_id = $1 RETURNING `+identityCols, agentID, gen+1, []byte(pub), reason))
		return err
	})
	if err != nil {
		return identityRow{}, fmt.Errorf("revoke agent identity: %w", err)
	}
	z.audit(ctx, auditEntry{TenantID: tenantID, AgentID: agentID, Event: "identity.revoked", Principal: actor, Reason: reason,
		Attrs: map[string]any{"key_generation": r.KeyGeneration}})
	return r, nil
}

// ---------- policies ----------

type policyRow struct {
	Policy    agentpolicy.Policy
	UpdatedAt time.Time
	UpdatedBy string
}

// loadPolicy reads the agent's policy. A missing row (an agent the 0038
// backfill could not see, or a race with the insert trigger) is classified by
// the agent's created_at against the cutover marker and inserted, so a
// pre-existing agent is never default-denied and a new one never permitted.
func (z *AgentAuthz) loadPolicy(ctx context.Context, tx pgx.Tx, tenantID, agentID string) (policyRow, error) {
	var (
		mode    string
		doc     []byte
		version int
		pr      policyRow
	)
	err := tx.QueryRow(ctx, `SELECT mode, document, version, updated_at, updated_by FROM agent_policies WHERE agent_id = $1`, agentID).
		Scan(&mode, &doc, &version, &pr.UpdatedAt, &pr.UpdatedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		var legacy bool
		if err := tx.QueryRow(ctx, `
			SELECT a.created_at < COALESCE((SELECT applied_at FROM agent_policy_cutover), '-infinity')
			FROM agents a WHERE a.id = $1 AND a.tenant_id = $2`, agentID, tenantID).Scan(&legacy); err != nil {
			return policyRow{}, fmt.Errorf("classify agent for policy: %w", err)
		}
		p, by := agentpolicy.EmptyEnforce(), "system:default-deny"
		if legacy {
			p, by = agentpolicy.LegacyPermissive(), "system:legacy-classified"
		}
		raw, _ := json.Marshal(p)
		if _, err := tx.Exec(ctx, `INSERT INTO agent_policies (agent_id, tenant_id, mode, document, updated_by)
			VALUES ($1, $2, $3, $4, $5) ON CONFLICT (agent_id) DO NOTHING`, agentID, tenantID, string(p.Mode), raw, by); err != nil {
			return policyRow{}, fmt.Errorf("insert default policy: %w", err)
		}
		return z.loadPolicy(ctx, tx, tenantID, agentID)
	}
	if err != nil {
		return policyRow{}, fmt.Errorf("load agent policy: %w", err)
	}
	if err := json.Unmarshal(doc, &pr.Policy); err != nil {
		return policyRow{}, fmt.Errorf("decode agent policy: %w", err)
	}
	pr.Policy.Mode = agentpolicy.Mode(mode)
	pr.Policy.Version = version
	// Stored documents were normalized on write; re-normalizing makes a
	// hand-edited row fail closed (an invalid document denies, below).
	n, err := agentpolicy.Normalize(pr.Policy)
	if err != nil {
		return policyRow{}, fmt.Errorf("stored agent policy invalid: %w", err)
	}
	pr.Policy = n
	return pr, nil
}

// ---------- establish ----------

// agentRef is a registered agent's identifying columns.
type agentRef struct {
	ID, Name, TenantID, VersionID string
	CreatedAt                     time.Time
}

func (z *AgentAuthz) agentByName(ctx context.Context, tenantID, name string) (agentRef, bool, error) {
	ctx = middleware.InjectTenantID(ctx, tenantID)
	var a agentRef
	err := z.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id::text, name, tenant_id::text, COALESCE(current_version_id::text, ''), created_at
			FROM agents WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL`, tenantID, name).
			Scan(&a.ID, &a.Name, &a.TenantID, &a.VersionID, &a.CreatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return agentRef{}, false, nil
	}
	return a, err == nil, err
}

// Establish puts a verified principal for (tenant, agent) into ctx. An agent
// name with no agents row is not an agent (e.g. a bridge persona session):
// ctx is returned unchanged with a nil principal — unless
// PAL_AGENT_POLICY_STRICT=1, where it is denied. A revoked identity returns
// ErrAgentIdentityRevoked; the caller must not run the agent.
func (z *AgentAuthz) Establish(ctx context.Context, tenantID, agentName, runID string) (context.Context, *AgentPrincipal, error) {
	if z == nil || agentName == "" {
		return ctx, nil, nil
	}
	a, ok, err := z.agentByName(ctx, tenantID, agentName)
	if err != nil {
		return ctx, nil, fmt.Errorf("resolve agent for identity: %w", err)
	}
	if !ok {
		if strictAgentPolicy() {
			return ctx, nil, &AgentPolicyDeniedError{Kind: "agent", Target: agentName, Reason: "unregistered agent name (PAL_AGENT_POLICY_STRICT=1)"}
		}
		return ctx, nil, nil
	}
	return z.establishFor(ctx, a, runID, AudienceDispatch)
}

func (z *AgentAuthz) establishFor(ctx context.Context, a agentRef, runID, audience string) (context.Context, *AgentPrincipal, error) {
	p := &AgentPrincipal{TenantID: a.TenantID, AgentID: a.ID, AgentName: a.Name, AgentVersionID: a.VersionID,
		RunID: runID, z: z, audience: audience}
	if err := p.refreshToken(ctx); err != nil {
		return ctx, nil, err
	}
	return withAgentPrincipal(ctx, p), p, nil
}

func strictAgentPolicy() bool {
	v := strings.ToLower(os.Getenv(envAgentPolicyStrict))
	return v == "1" || v == "true" || v == "on"
}

// refreshToken mints a fresh token and verifies it through the external
// verifier, so the principal is only ever derived from verified claims.
func (p *AgentPrincipal) refreshToken(ctx context.Context) error {
	id, err := p.z.ensureIdentity(ctx, p.TenantID, p.AgentID)
	if err != nil {
		return err
	}
	if id.Revoked {
		p.z.audit(ctx, p.entry("token.rejected", "", "", "deny", "identity revoked"))
		return ErrAgentIdentityRevoked
	}
	tok, _, err := p.z.auth.Mint(agentidentity.MintRequest{Identity: id.IdentityRecord, AgentName: p.AgentName,
		AgentVersionID: p.AgentVersionID, RunID: p.RunID, Audience: p.audience})
	if err != nil {
		return fmt.Errorf("mint agent token: %w", err)
	}
	c, err := p.z.auth.Verify(ctx, tok, p.audience, p.z.lookupIdentity)
	if err != nil {
		return fmt.Errorf("verify freshly minted agent token: %w", err)
	}
	p.mu.Lock()
	p.SpiffeID, p.jti, p.exp, p.gen = c.Subject, c.ID, c.ExpiresAt.Time, c.Generation
	p.mu.Unlock()
	p.z.audit(ctx, p.entry("token.minted", "", "", "", ""))
	return nil
}

// ---------- authorize ----------

// countedKinds are the actions that consume budget.maxToolCallsPerRun.
var countedKinds = []string{string(agentpolicy.KindTool), string(agentpolicy.KindConnector), string(agentpolicy.KindMCP)}

// Authorize evaluates one action against the agent's CURRENT identity and
// policy, audits the decision, and returns a typed error on deny. Infra
// failures deny (fail closed).
func (p *AgentPrincipal) Authorize(ctx context.Context, a agentpolicy.Action, stepID string) error {
	if p == nil {
		return nil
	}
	deny := func(reason string) error {
		e := p.entry("policy.denied", string(a.Kind), actionTarget(a), "deny", reason)
		e.StepID = stepID
		p.z.audit(ctx, e)
		p.z.journalDeny(ctx, p.RunID, stepID, a, reason)
		p.span(ctx, a, "deny", reason)
		return &AgentPolicyDeniedError{Kind: a.Kind, Target: actionTarget(a), Reason: reason}
	}

	var (
		status string
		gen    int
		pr     policyRow
		used   int
	)
	err := p.z.srv.WithTenant(middleware.InjectTenantID(ctx, p.TenantID), func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT status, key_generation FROM agent_identities WHERE agent_id = $1`, p.AgentID).Scan(&status, &gen); err != nil {
			return err
		}
		var err error
		if pr, err = p.z.loadPolicy(ctx, tx, p.TenantID, p.AgentID); err != nil {
			return err
		}
		if pr.Policy.Budget.MaxToolCallsPerRun > 0 && p.RunID != "" && isCounted(a.Kind) {
			return tx.QueryRow(ctx, `SELECT count(*) FROM agent_identity_audit
				WHERE run_id = $1 AND agent_id = $2 AND event = 'policy.allowed' AND action_kind = ANY($3)`,
				p.RunID, p.AgentID, countedKinds).Scan(&used)
		}
		return nil
	})
	if err != nil {
		p.z.logger().Error("agent authorize: state read failed — denying", zap.String("agent_id", p.AgentID), zap.Error(err))
		return deny("policy unavailable (fail closed)")
	}
	if status == "revoked" {
		return deny("agent identity revoked")
	}
	p.mu.Lock()
	stale := gen != p.gen || time.Until(p.exp) < time.Minute
	p.mu.Unlock()
	if stale {
		// Rotated mid-run or close to expiry: re-mint (SVID-style rotation).
		if err := p.refreshToken(ctx); err != nil {
			return deny("agent token refresh failed")
		}
	}
	d := pr.Policy.Evaluate(a)
	if !d.Allowed {
		return deny(d.Reason)
	}
	if max := pr.Policy.Budget.MaxToolCallsPerRun; max > 0 && isCounted(a.Kind) && used >= max {
		return deny(fmt.Sprintf("budget.maxToolCallsPerRun (%d) exhausted", max))
	}
	e := p.entry("policy.allowed", string(a.Kind), actionTarget(a), "allow", "")
	e.StepID = stepID
	e.Attrs = map[string]any{"rule": d.Rule, "mode": string(pr.Policy.Mode), "policy_version": pr.Policy.Version}
	p.z.audit(ctx, e)
	p.span(ctx, a, "allow", d.Rule)
	return nil
}

func isCounted(k agentpolicy.Kind) bool {
	for _, c := range countedKinds {
		if string(k) == c {
			return true
		}
	}
	return false
}

func actionTarget(a agentpolicy.Action) string {
	if a.Sub != "" {
		return a.Target + "." + a.Sub
	}
	return a.Target
}

func (p *AgentPrincipal) entry(event, kind, target, decision, reason string) auditEntry {
	p.mu.Lock()
	jti, spiffe := p.jti, p.SpiffeID
	p.mu.Unlock()
	return auditEntry{TenantID: p.TenantID, AgentID: p.AgentID, AgentName: p.AgentName, AgentVersionID: p.AgentVersionID,
		RunID: p.RunID, Event: event, ActionKind: kind, Target: target, Decision: decision, Reason: reason,
		Principal: spiffe, JTI: jti}
}

func (p *AgentPrincipal) span(ctx context.Context, a agentpolicy.Action, decision, detail string) {
	span := trace.SpanFromContext(ctx)
	if !span.IsRecording() {
		return
	}
	span.SetAttributes(
		attribute.String(middleware.AttrTenantID, p.TenantID),
		attribute.String("pal.agent_id", p.AgentID),
		attribute.String("pal.agent_version", p.AgentVersionID),
	)
	if p.RunID != "" {
		span.SetAttributes(attribute.String(middleware.AttrRunID, p.RunID))
	}
	span.AddEvent("agent.policy", trace.WithAttributes(
		attribute.String("pal.policy.decision", decision),
		attribute.String("pal.policy.kind", string(a.Kind)),
		attribute.String("pal.policy.target", actionTarget(a)),
		attribute.String("pal.policy.detail", detail),
	))
}

// ---------- audit + journal ----------

type auditEntry struct {
	TenantID, AgentID, AgentName, AgentVersionID, RunID, StepID string
	Event, ActionKind, Target, Decision, Reason, Principal, JTI string
	Attrs                                                       map[string]any
}

// audit appends one row to the hash-chained audit log. Best-effort with a
// loud log: a failed audit write must not turn into a silent allow (Authorize
// has already decided), but it must be visible. Never carries token material.
func (z *AgentAuthz) audit(ctx context.Context, e auditEntry) {
	if e.Attrs == nil {
		e.Attrs = map[string]any{}
	}
	attrs, _ := json.Marshal(e.Attrs)
	var agentID any
	if e.AgentID != "" {
		agentID = e.AgentID
	}
	actx := middleware.InjectTenantID(context.WithoutCancel(ctx), e.TenantID)
	err := z.srv.WithTenant(actx, func(tx pgx.Tx) error {
		_, err := tx.Exec(actx, `
			INSERT INTO agent_identity_audit (tenant_id, agent_id, agent_name, agent_version_id, run_id, step_id,
			  event, action_kind, target, decision, reason, principal, jti, attrs)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
			e.TenantID, agentID, e.AgentName, e.AgentVersionID, e.RunID, e.StepID, e.Event, e.ActionKind,
			truncate(e.Target, 512), e.Decision, truncate(e.Reason, 512), e.Principal, e.JTI, attrs)
		return err
	})
	if err != nil {
		z.logger().Error("agent identity audit write failed", zap.String("event", e.Event),
			zap.String("tenant_id", e.TenantID), zap.String("agent_id", e.AgentID), zap.Error(err))
	}
}

// journalDeny records a policy_denied event in the run's journal so the run
// waterfall shows WHY a step did not happen. Session principals (no run id)
// skip it — their audit row is the record.
func (z *AgentAuthz) journalDeny(ctx context.Context, runID, stepID string, a agentpolicy.Action, reason string) {
	if runID == "" || strings.HasPrefix(runID, "session:") {
		return
	}
	if stepID == "" {
		stepID = "policy"
	}
	raw, _ := json.Marshal(map[string]any{"kind": string(a.Kind), "target": actionTarget(a), "reason": reason})
	for i := 0; i < maxJournalRetries; i++ {
		// rls-exempt: journal_events is an RLS-exempt child table keyed by run_id.
		tag, err := z.srv.Pool.Exec(context.WithoutCancel(ctx), `
			INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
			SELECT $1, COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1), 0) + 1, 'policy_denied', $2, 1, $3
			WHERE EXISTS (SELECT 1 FROM runs WHERE id::text = $1)
			ON CONFLICT (run_id, seq) DO NOTHING`, runID, stepID, raw)
		if err != nil || tag.RowsAffected() > 0 {
			return
		}
	}
}

// ---------- verified agent callers (REST) ----------

// agentCallerFromRequest verifies an X-Pal-Agent-Token for one audience.
// Returns (nil, nil) when no agent token is presented. A presented but invalid
// token is an error (never silently downgraded to the user path).
func (z *AgentAuthz) agentCallerFromRequest(r *http.Request, audience string) (*AgentPrincipal, error) {
	tok := strings.TrimSpace(r.Header.Get(AgentTokenHeader))
	if tok == "" {
		return nil, nil
	}
	if z == nil {
		return nil, errors.New("agent identity not configured")
	}
	c, err := z.auth.Verify(r.Context(), tok, audience, z.lookupIdentity)
	if err != nil {
		// No verified tenant to write an audit row under; log the class of
		// failure only (never the token).
		z.logger().Info("agent token rejected", zap.String("audience", audience), zap.Error(err))
		return nil, err
	}
	p := &AgentPrincipal{TenantID: c.TenantID, AgentID: c.AgentID, AgentName: c.AgentName,
		AgentVersionID: c.AgentVersionID, RunID: c.RunID, SpiffeID: c.Subject, z: z, audience: audience,
		jti: c.ID, exp: c.ExpiresAt.Time, gen: c.Generation}
	e := p.entry("token.verified", "", "", "", "")
	e.Attrs = map[string]any{"audience": audience}
	z.audit(r.Context(), e)
	return p, nil
}

// ---------- process wiring ----------

// activeAgentAuthz is set once at boot (cmd/server) and read by the free
// dispatch helpers. nil disables identity establishment (unit tests that build
// handlers directly); production wiring is asserted at startup.
var activeAgentAuthz *AgentAuthz

// SetAgentAuthz installs the process-wide enforcer.
func SetAgentAuthz(z *AgentAuthz) { activeAgentAuthz = z }

// currentAgentAuthz returns the process-wide enforcer (may be nil).
func currentAgentAuthz() *AgentAuthz { return activeAgentAuthz }

// toolAction maps a tool-loop tool name to the policy action it needs.
// Connector tools are "<connector>__<action>"; everything else is a tool.
func toolAction(name string) agentpolicy.Action {
	if conn, act, ok := strings.Cut(name, "__"); ok && !isPersonalDocsTool(name) {
		return agentpolicy.Action{Kind: agentpolicy.KindConnector, Target: conn, Sub: act}
	}
	return agentpolicy.Action{Kind: agentpolicy.KindTool, Target: name}
}

// authorizeInbound decides whether caller may invoke target (the target's
// a2aInbound rules + per-caller rate isolation), auditing on the TARGET
// tenant's chain. callerID is the caller's SPIFFE id, or "tenant:<id>" for a
// human/API-key caller. Same-tenant human callers are the owner and always
// pass (but are still audited).
func (z *AgentAuthz) authorizeInbound(ctx context.Context, target agentRef, callerID, callerTenant string, callerIsAgent bool) error {
	if z == nil {
		return nil
	}
	same := callerTenant == target.TenantID
	act := agentpolicy.Action{Kind: agentpolicy.KindA2AInbound, Target: callerID,
		Aliases: []string{"tenant:" + callerTenant}, SameTenant: same}
	var (
		pr     policyRow
		recent int
	)
	tctx := middleware.InjectTenantID(ctx, target.TenantID)
	err := z.srv.WithTenant(tctx, func(tx pgx.Tx) error {
		var err error
		if pr, err = z.loadPolicy(tctx, tx, target.TenantID, target.ID); err != nil {
			return err
		}
		if pr.Policy.Budget.MaxA2AInboundPerMinute > 0 {
			return tx.QueryRow(tctx, `SELECT count(*) FROM agent_identity_audit
				WHERE agent_id = $1 AND event = 'a2a.invoke' AND decision = 'allow' AND principal = $2
				  AND created_at > now() - interval '1 minute'`, target.ID, callerID).Scan(&recent)
		}
		return nil
	})
	entry := auditEntry{TenantID: target.TenantID, AgentID: target.ID, AgentName: target.Name,
		AgentVersionID: target.VersionID, Event: "a2a.invoke", ActionKind: string(agentpolicy.KindA2AInbound),
		Target: callerID, Principal: callerID, Attrs: map[string]any{"caller_tenant": callerTenant, "caller_is_agent": callerIsAgent}}
	deny := func(reason string) error {
		entry.Decision, entry.Reason = "deny", reason
		z.audit(ctx, entry)
		return &AgentPolicyDeniedError{Kind: agentpolicy.KindA2AInbound, Target: target.Name, Reason: reason}
	}
	if err != nil {
		z.logger().Error("a2a inbound: policy read failed — denying", zap.Error(err))
		return deny("policy unavailable (fail closed)")
	}
	if !(same && !callerIsAgent) {
		if d := pr.Policy.Evaluate(act); !d.Allowed {
			return deny(d.Reason)
		}
	}
	if max := pr.Policy.Budget.MaxA2AInboundPerMinute; max > 0 && recent >= max {
		return deny(fmt.Sprintf("budget.maxA2AInboundPerMinute (%d) exceeded for this caller", max))
	}
	entry.Decision = "allow"
	z.audit(ctx, entry)
	return nil
}

// unverifiedAgentTenant reads the tenant_id claim of an agent token WITHOUT
// verifying it. Only for choosing which agent a name refers to before the
// token is verified against that agent's audience; the verified claims must
// then match (a forged tenant fails the signature check).
func unverifiedAgentTenant(tok string) string {
	var c agentidentity.AgentClaims
	if _, _, err := jwt.NewParser().ParseUnverified(tok, &c); err != nil {
		return ""
	}
	return c.TenantID
}
