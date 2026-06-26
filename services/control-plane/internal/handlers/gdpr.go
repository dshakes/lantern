package handlers

// gdpr.go — GDPR / right-to-erasure tenant purge endpoint.
//
// DELETE /v1/tenants/{id}
//
// Security:
//   - Bearer JWT required (standard auth middleware path via validateRequest).
//   - Caller's role must be "owner".
//   - Caller's tenant_id must match the path {id} — no cross-tenant purge.
//
// Effect:
//   - Opens a single transaction and cascade-deletes all rows belonging to the
//     tenant across every tenant_id-bearing table (enumerated from migrate.go),
//     then deletes the tenant row itself.
//   - Returns a JSON summary of rows deleted per table.
//   - On success the tenant's JWT is invalidated naturally (the tenant row is
//     gone; any subsequent request will fail the tenant lookup).
//
// Audit: a structured log line is emitted before the transaction commits so
// there is an immutable record even if the commit fails.

import (
	"fmt"
	"net/http"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// GDPRHandler handles tenant self-erasure.
type GDPRHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewGDPRHandler constructs a GDPRHandler.
func NewGDPRHandler(srv *server.Server, auth *AuthHandler) *GDPRHandler {
	return &GDPRHandler{srv: srv, auth: auth}
}

func (h *GDPRHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("gdpr")
}

// DeleteTenant handles DELETE /v1/tenants/{id}.
func (h *GDPRHandler) DeleteTenant(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// --- Auth: owner JWT required ---
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if claims.Role != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner role required"})
		return
	}

	// --- Path param ---
	targetID := r.PathValue("id")
	if targetID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tenant id is required"})
		return
	}

	// --- Tenant must match self (no cross-tenant purge) ---
	if claims.TenantID != targetID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "may only purge your own tenant"})
		return
	}

	ctx := r.Context()
	log := h.logger()

	// Audit before commit so the record is always present.
	// claims.Subject is the user ID (JWT "sub" field).
	log.Warn("GDPR tenant purge initiated",
		zap.String("tenant_id", targetID),
		zap.String("initiated_by_user", claims.Subject),
	)

	// --- Cascade-delete in a single transaction ---
	//
	// CRITICAL ordering: respect FK RESTRICT constraints from migrate.go:
	//   runs.agent_id          → agents(id)          ON DELETE RESTRICT (line 144)
	//   runs.agent_version_id  → agent_versions(id)  ON DELETE RESTRICT (line 145)
	//
	// Therefore: delete runs (and their children) BEFORE agent_versions and agents.
	// Deleting agents before runs causes a FK RESTRICT violation and rolls back
	// the entire transaction, leaving secrets (llm_provider_configs, api_keys,
	// connector_installs) intact — the erasure fails silently with a 500.
	//
	// Correct leaf-to-root order:
	//   1. Children of runs (journal_events, run_locks — via run_id sub-select)
	//   2. Other run-level tables (run_feedback, run_receipts, takeover_requests)
	//   3. runs themselves (now safe: no RESTRICT referencing runs remains)
	//   4. Children of agents/agent_versions:
	//      agent_versions (via agent_id sub-select), marketplace_agents (via source_agent_id)
	//   5. agents
	//   6. All other tenant-scoped tables (no inter-table RESTRICT constraints)
	//   7. users
	//   8. tenants (root — last)
	//
	// Tables enumerated from internal/db/migrate.go (every table with a
	// tenant_id column, including additive ALTER TABLE columns).

	// step runs a parameterised DELETE and records the count in deleted.
	// tableName and col are internal constants (safe for fmt.Sprintf).
	deleted := make(map[string]int64)
	// rls-exempt: admin/system GDPR erasure purges a whole tenant leaf-to-root
	// (down to the tenants row itself). It must bypass RLS so the privileged
	// pool can delete every tenant-scoped table; running under the app role
	// would let RLS hide rows from the purge and leave PII behind.
	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		log.Error("GDPR: failed to begin transaction", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	step := func(table, col string, args ...any) bool {
		q := fmt.Sprintf(`DELETE FROM %s WHERE %s = $1`, table, col)
		tag, execErr := tx.Exec(ctx, q, args...)
		if execErr != nil {
			log.Error("GDPR: delete failed", zap.String("table", table), zap.Error(execErr))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return false
		}
		deleted[table] += tag.RowsAffected()
		return true
	}
	stepSQL := func(table, sql string, args ...any) bool {
		tag, execErr := tx.Exec(ctx, sql, args...)
		if execErr != nil {
			log.Error("GDPR: delete failed", zap.String("table", table), zap.Error(execErr))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return false
		}
		deleted[table] += tag.RowsAffected()
		return true
	}

	// ── 1. Children of runs (reference run_id, not tenant_id) ──────────────
	if !stepSQL("journal_events",
		`DELETE FROM journal_events WHERE run_id IN (SELECT id FROM runs WHERE tenant_id = $1)`,
		targetID) {
		return
	}
	if !stepSQL("run_locks",
		`DELETE FROM run_locks WHERE run_id IN (SELECT id FROM runs WHERE tenant_id = $1)`,
		targetID) {
		return
	}

	// ── 2. Other run-scoped tables with direct tenant_id ───────────────────
	// (run_feedback and run_receipts reference run_id loosely but have tenant_id;
	//  takeover_requests has tenant_id and a run_id column but no hard FK on runs)
	for _, t := range []string{"run_feedback", "run_receipts", "takeover_requests"} {
		if !step(t, "tenant_id", targetID) {
			return
		}
	}

	// ── 3. runs — now safe: no RESTRICT child rows remain ─────────────────
	// Delete child runs (subagent children) before parent runs to satisfy
	// the self-referential parent_run_id FK (implicit NO ACTION).
	if !stepSQL("runs",
		`DELETE FROM runs WHERE tenant_id = $1`,
		targetID) {
		return
	}

	// ── 4. Children of agents / agent_versions ─────────────────────────────
	// agent_versions: FK ON DELETE CASCADE from agents, but we delete explicitly
	// to capture the count.  Must precede agents (no RESTRICT from agents→av,
	// but av.agent_id is CASCADE — deleting agents would cascade-wipe av rows
	// without incrementing our counter; delete explicitly for the audit count).
	if !stepSQL("agent_versions",
		`DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)`,
		targetID) {
		return
	}
	// marketplace_agents: source_agent_id → agents ON DELETE CASCADE.
	// Must be deleted before agents so we count it; the CASCADE would handle it
	// implicitly but silently.
	if !stepSQL("marketplace_agents",
		`DELETE FROM marketplace_agents WHERE source_tenant_id = $1`,
		targetID) {
		return
	}

	// ── 5. agents ──────────────────────────────────────────────────────────
	if !step("agents", "tenant_id", targetID) {
		return
	}

	// ── 6. Remaining tenant-scoped tables (no inter-table RESTRICT) ────────
	// marketplace_invocations has both buyer and seller columns.
	if !stepSQL("marketplace_invocations",
		`DELETE FROM marketplace_invocations WHERE buyer_tenant_id = $1 OR seller_tenant_id = $1`,
		targetID) {
		return
	}

	for _, t := range []string{
		"memory_events", "person_handles", "people",
		"whatsapp_pending_drafts", "whatsapp_vip_contacts", "whatsapp_contact_facts",
		"side_effect_receipts",
		"runtime_vm_logs", "runtime_audit_events", "runtime_vms", "runtime_quotas",
		"voice_calls", "voice_numbers",
		"agent_experiments",
		"eval_baselines", "eval_runs", "eval_suites",
		"agent_mcp_attachments", "marketplace_stars",
		"cost_forecasts", "agent_usage_daily", "agent_budgets",
		"schedules", "llm_provider_configs",
		"data_planes", "deployments", "api_keys",
		"surface_configs", "connector_installs", "sessions",
	} {
		if !step(t, "tenant_id", targetID) {
			return
		}
	}

	// ── 7. users ────────────────────────────────────────────────────────────
	if !step("users", "tenant_id", targetID) {
		return
	}

	// ── 8. tenant (root) ────────────────────────────────────────────────────
	if !step("tenants", "id", targetID) {
		return
	}

	if err := tx.Commit(ctx); err != nil {
		log.Error("GDPR: transaction commit failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	log.Warn("GDPR tenant purge complete",
		zap.String("tenant_id", targetID),
		zap.String("initiated_by_user", claims.Subject),
	)

	writeJSON(w, http.StatusOK, map[string]any{
		"tenant_id": targetID,
		"deleted":   deleted,
	})
}
