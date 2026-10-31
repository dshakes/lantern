package engine

// agent_policy.go — per-agent least privilege for durable tool_call steps
// (ADR 0055). The control plane owns identities and policy documents; the
// engine reads the run's agent policy from the same database and evaluates it
// with the SAME evaluator (packages/agentpolicy) before it ever asks the
// runtime manager to run a tool. Deny = typed error + journal event + audit row.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/dshakes/pal/packages/agentpolicy"
	"github.com/dshakes/pal/services/workflow-engine/internal/journal"
)

// ErrToolDeniedByPolicy fails a tool_call step whose tool the run's agent
// policy does not allow.
var ErrToolDeniedByPolicy = errors.New("tool denied by agent policy")

// KindPolicyDenied is the journal kind for a policy denial (same string the
// control plane writes, so the run waterfall renders both identically).
const KindPolicyDenied = "policy_denied"

func trustDomain() string {
	if td := strings.ToLower(strings.TrimSpace(os.Getenv("PAL_TRUST_DOMAIN"))); td != "" {
		return td
	}
	return "pal.local"
}

// authorizeToolCall evaluates tool against the run's agent policy. Any failure
// to read the policy denies (fail closed).
func (se *StepExecutor) authorizeToolCall(ctx context.Context, state *RunState, stepID, tool string) error {
	if se.tenantPool() == nil {
		return fmt.Errorf("%w: no database to read the agent policy from", ErrToolDeniedByPolicy)
	}
	tx, err := se.beginTenantTx(ctx, state.TenantID)
	if err != nil {
		return fmt.Errorf("%w: policy unavailable: %v", ErrToolDeniedByPolicy, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var (
		agentID, agentName, versionID, mode string
		doc                                 []byte
		version                             int
	)
	// A missing policy row is classified exactly like the control plane does
	// (agentpolicy cutover marker): pre-existing agents legacy, new ones deny.
	err = tx.QueryRow(ctx, `
		SELECT a.id::text, a.name, COALESCE(r.agent_version_id::text, ''),
		       COALESCE(p.mode, CASE WHEN a.created_at < COALESCE((SELECT applied_at FROM agent_policy_cutover), '-infinity')
		                             THEN 'legacy_permissive' ELSE 'enforce' END),
		       COALESCE(p.document, '{}'::jsonb), COALESCE(p.version, 1)
		FROM runs r
		JOIN agents a ON a.id = r.agent_id
		LEFT JOIN agent_policies p ON p.agent_id = a.id
		WHERE r.id = $1`, state.RunID).Scan(&agentID, &agentName, &versionID, &mode, &doc, &version)
	if err != nil {
		return fmt.Errorf("%w: policy unavailable: %v", ErrToolDeniedByPolicy, err)
	}
	var p agentpolicy.Policy
	if err := json.Unmarshal(doc, &p); err != nil {
		return fmt.Errorf("%w: stored policy invalid", ErrToolDeniedByPolicy)
	}
	p.Mode, p.Version = agentpolicy.Mode(mode), version
	if p.Mode == agentpolicy.ModeLegacyPermissive {
		p = agentpolicy.LegacyPermissive()
	}
	if p, err = agentpolicy.Normalize(p); err != nil {
		return fmt.Errorf("%w: stored policy invalid", ErrToolDeniedByPolicy)
	}

	d := p.Evaluate(agentpolicy.Action{Kind: agentpolicy.KindTool, Target: tool})
	if d.Allowed && p.Budget.MaxToolCallsPerRun > 0 {
		var used int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_identity_audit
			WHERE run_id = $1 AND agent_id = $2 AND event = 'policy.allowed' AND action_kind = ANY($3)`,
			state.RunID, agentID, []string{"tool", "connector", "mcp"}).Scan(&used); err != nil {
			return fmt.Errorf("%w: budget unavailable: %v", ErrToolDeniedByPolicy, err)
		}
		if used >= p.Budget.MaxToolCallsPerRun {
			d = agentpolicy.Decision{Reason: fmt.Sprintf("budget.maxToolCallsPerRun (%d) exhausted", p.Budget.MaxToolCallsPerRun)}
		}
	}

	event, decision, attrs := "policy.allowed", "allow", map[string]any{"rule": d.Rule, "mode": mode, "policy_version": version, "via": "workflow-engine"}
	if !d.Allowed {
		event, decision = "policy.denied", "deny"
	}
	rawAttrs, _ := json.Marshal(attrs)
	principal := "spiffe://" + trustDomain() + "/tenant/" + state.TenantID + "/agent/" + agentID
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_identity_audit (tenant_id, agent_id, agent_name, agent_version_id, run_id, step_id,
		  event, action_kind, target, decision, reason, principal, attrs)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'tool', $8, $9, $10, $11, $12)`,
		state.TenantID, agentID, agentName, versionID, state.RunID, stepID, event, tool, decision, d.Reason, principal, rawAttrs); err != nil {
		return fmt.Errorf("%w: audit unavailable: %v", ErrToolDeniedByPolicy, err)
	}
	var entry *journal.JournalEntry
	if !d.Allowed {
		entry = &journal.JournalEntry{RunID: state.RunID, Kind: KindPolicyDenied, StepID: stepID, Attempt: 1,
			Payload: mustMarshal(map[string]any{"kind": "tool", "target": tool, "reason": d.Reason})}
		if err := journal.Append(ctx, tx, entry); err != nil {
			return fmt.Errorf("%w: journal: %v", ErrToolDeniedByPolicy, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("%w: commit: %v", ErrToolDeniedByPolicy, err)
	}
	if entry != nil {
		state.AppendJournal(*entry)
		return fmt.Errorf("%w: tool %q: %s", ErrToolDeniedByPolicy, tool, d.Reason)
	}
	return nil
}
