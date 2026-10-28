package handlers

// gdpr.go — GDPR right-to-erasure purge and Art. 20 data export.
//
// DELETE /v1/tenants/{id}
// GET    /v1/tenants/{id}/export  (see ExportTenant)
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
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"

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

	// --- Cascade-delete in a single transaction (shared with the kiosk sweep) ---
	deleted, err := purgeTenantRows(ctx, h.srv.Pool, log, targetID)
	if err != nil {
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

// purgeTenantRows cascade-deletes every row of one tenant (leaf-to-root, then
// the tenants row) in a single transaction on the privileged pool and returns
// rows deleted per table. Shared by DELETE /v1/tenants/{id} and the kiosk
// expiry sweep so both exercise the one erasure code path.
func purgeTenantRows(ctx context.Context, pool *pgxpool.Pool, log *zap.Logger, targetID string) (map[string]int64, error) {
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
	var failed error
	// rls-exempt: admin/system GDPR erasure purges a whole tenant leaf-to-root
	// (down to the tenants row itself). It must bypass RLS so the privileged
	// pool can delete every tenant-scoped table; running under the app role
	// would let RLS hide rows from the purge and leave PII behind.
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Error("GDPR: failed to begin transaction", zap.Error(err))
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	step := func(table, col string, args ...any) bool {
		q := fmt.Sprintf(`DELETE FROM %s WHERE %s = $1`, table, col)
		tag, execErr := tx.Exec(ctx, q, args...)
		if execErr != nil {
			log.Error("GDPR: delete failed", zap.String("table", table), zap.Error(execErr))
			failed = execErr
			return false
		}
		deleted[table] += tag.RowsAffected()
		return true
	}
	stepSQL := func(table, sql string, args ...any) bool {
		tag, execErr := tx.Exec(ctx, sql, args...)
		if execErr != nil {
			log.Error("GDPR: delete failed", zap.String("table", table), zap.Error(execErr))
			failed = execErr
			return false
		}
		deleted[table] += tag.RowsAffected()
		return true
	}

	// ── 1. Children of runs (reference run_id, not tenant_id) ──────────────
	if !stepSQL("journal_events",
		`DELETE FROM journal_events WHERE run_id IN (SELECT id FROM runs WHERE tenant_id = $1)`,
		targetID) {
		return nil, failed
	}
	if !stepSQL("run_locks",
		`DELETE FROM run_locks WHERE run_id IN (SELECT id FROM runs WHERE tenant_id = $1)`,
		targetID) {
		return nil, failed
	}

	// ── 2. Other run-scoped tables with direct tenant_id ───────────────────
	// (run_feedback and run_receipts reference run_id loosely but have tenant_id;
	//  takeover_requests has tenant_id and a run_id column but no hard FK on runs)
	for _, t := range []string{"run_feedback", "run_receipts", "takeover_requests"} {
		if !step(t, "tenant_id", targetID) {
			return nil, failed
		}
	}

	// ── 3. runs — now safe: no RESTRICT child rows remain ─────────────────
	// Delete child runs (subagent children) before parent runs to satisfy
	// the self-referential parent_run_id FK (implicit NO ACTION).
	if !stepSQL("runs",
		`DELETE FROM runs WHERE tenant_id = $1`,
		targetID) {
		return nil, failed
	}

	// ── 4. Children of agents / agent_versions ─────────────────────────────
	// agent_versions: FK ON DELETE CASCADE from agents, but we delete explicitly
	// to capture the count.  Must precede agents (no RESTRICT from agents→av,
	// but av.agent_id is CASCADE — deleting agents would cascade-wipe av rows
	// without incrementing our counter; delete explicitly for the audit count).
	if !stepSQL("agent_versions",
		`DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)`,
		targetID) {
		return nil, failed
	}
	// marketplace_agents: source_agent_id → agents ON DELETE CASCADE.
	// Must be deleted before agents so we count it; the CASCADE would handle it
	// implicitly but silently.
	if !stepSQL("marketplace_agents",
		`DELETE FROM marketplace_agents WHERE source_tenant_id = $1`,
		targetID) {
		return nil, failed
	}

	// ── 5. agents ──────────────────────────────────────────────────────────
	if !step("agents", "tenant_id", targetID) {
		return nil, failed
	}

	// ── 6. Remaining tenant-scoped tables (no inter-table RESTRICT) ────────
	// marketplace_invocations has both buyer and seller columns.
	if !stepSQL("marketplace_invocations",
		`DELETE FROM marketplace_invocations WHERE buyer_tenant_id = $1 OR seller_tenant_id = $1`,
		targetID) {
		return nil, failed
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
			return nil, failed
		}
	}

	// ── 6b. Every other table with a tenant_id column ──────────────────────
	// The explicit list above predates later tables (life_events, commitments,
	// domain_records, errands, …) that have no FK to tenants, so nothing
	// cascaded them and erasure left their rows — including health PII —
	// behind. Sweeping the catalog keeps the purge complete as tables are added.
	sweep, err := tx.Query(ctx, `
		SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
		WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'users'
		ORDER BY c.relname`)
	if err != nil {
		log.Error("GDPR: list tenant tables failed", zap.Error(err))
		return nil, err
	}
	var rest []string
	for sweep.Next() {
		var t string
		if err = sweep.Scan(&t); err != nil {
			break
		}
		rest = append(rest, t)
	}
	sweep.Close()
	if err == nil {
		err = sweep.Err()
	}
	if err != nil {
		log.Error("GDPR: read tenant tables failed", zap.Error(err))
		return nil, err
	}
	for _, t := range rest {
		// Identifier comes from the catalog, quoted by pgx — not user input.
		if !stepSQL(t, fmt.Sprintf(`DELETE FROM %s WHERE tenant_id = $1`, pgx.Identifier{t}.Sanitize()), targetID) {
			return nil, failed
		}
	}

	// ── 7. users ────────────────────────────────────────────────────────────
	if !step("users", "tenant_id", targetID) {
		return nil, failed
	}

	// ── 8. tenant (root) ────────────────────────────────────────────────────
	if !step("tenants", "id", targetID) {
		return nil, failed
	}

	if err := tx.Commit(ctx); err != nil {
		log.Error("GDPR: transaction commit failed", zap.Error(err))
		return nil, err
	}
	return deleted, nil
}

// exportRedacted reports whether a column holds credential material that must
// not leave the system, even to its owner: password/key hashes, anything
// encrypted at rest, webhook/signing secrets, and the provider/connector config
// blobs that embed keys. The rule is structural — any `_`-separated name
// segment in exportSecretSegments redacts the column — so a new credential
// column is excluded by default instead of leaking until someone adds it to a
// list. TestExportRedacted_Catalog pins the classification of every
// tenant-table column that trips the pattern.
func exportRedacted(table, column string) bool {
	switch {
	case column == "provider_config":
		return true
	case table == "connector_installs" && column == "config":
		return true
	case exportNotSecret[column]:
		return false
	}
	for _, seg := range strings.Split(column, "_") {
		if exportSecretSegments[seg] {
			return true
		}
	}
	return false
}

var exportSecretSegments = map[string]bool{
	"secret": true, "secrets": true, "password": true, "passwd": true,
	"hash": true, "enc": true, "encrypted": true, "ciphertext": true,
	"token": true, "credential": true, "credentials": true, "key": true,
}

// exportNotSecret: columns whose name has a "key" segment but which are the
// tenant's own non-credential data (dedup keys, the displayed key prefix).
var exportNotSecret = map[string]bool{
	"idempotency_key": true, "idem_key": true, "replay_key": true, "key_prefix": true,
}

// ExportTenant handles GET /v1/tenants/{id}/export: every row of every table
// with a tenant_id column (found from the catalog, so new tables are included
// without touching this code), plus the tenant row, as one JSON document.
// ponytail: buffered in memory; stream per table if exports outgrow a response.
// Owner JWT only; another tenant's id is 404 so existence never leaks.
func (h *GDPRHandler) ExportTenant(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if claims.Role != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner role required"})
		return
	}
	tenantID := r.PathValue("id")
	if tenantID != claims.TenantID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	tables := map[string]json.RawMessage{}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// pg_catalog, not information_schema: the latter hides tables the
		// role can't read, which would silently drop them from the export
		// instead of failing loudly on a missing grant.
		rows, err := tx.Query(ctx, `
			SELECT c.relname, a.attname
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
			WHERE n.nspname = 'public' AND c.relkind = 'r'
			  AND EXISTS (SELECT 1 FROM pg_attribute t
				WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
			ORDER BY c.relname, a.attnum`)
		if err != nil {
			return fmt.Errorf("list tenant tables: %w", err)
		}
		drop := map[string][]string{}
		var order []string
		for rows.Next() {
			var table, col string
			if err := rows.Scan(&table, &col); err != nil {
				rows.Close()
				return fmt.Errorf("scan catalog row: %w", err)
			}
			if _, seen := drop[table]; !seen {
				order = append(order, table)
				drop[table] = []string{}
			}
			if exportRedacted(table, col) {
				drop[table] = append(drop[table], col)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read catalog: %w", err)
		}

		for _, table := range order {
			// Identifier comes from the catalog, quoted by pgx — not user input.
			q := fmt.Sprintf(`SELECT COALESCE(jsonb_agg(to_jsonb(t) - $2::text[]), '[]'::jsonb) FROM %s t WHERE t.tenant_id = $1`,
				pgx.Identifier{table}.Sanitize())
			var doc json.RawMessage
			if err := tx.QueryRow(ctx, q, tenantID, drop[table]).Scan(&doc); err != nil {
				return fmt.Errorf("export %s: %w", table, err)
			}
			tables[table] = doc
		}
		var tenant json.RawMessage
		if err := tx.QueryRow(ctx, `SELECT to_jsonb(t) FROM tenants t WHERE t.id = $1`, tenantID).Scan(&tenant); err != nil {
			return fmt.Errorf("export tenant row: %w", err)
		}
		tables["tenants"] = json.RawMessage("[" + string(tenant) + "]")
		return nil
	})
	if err != nil {
		h.logger().Error("GDPR export failed", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.logger().Info("GDPR tenant export",
		zap.String("tenant_id", tenantID), zap.String("initiated_by_user", claims.Subject), zap.Int("tables", len(tables)))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="lantern-export-%s.json"`, tenantID))
	writeJSON(w, http.StatusOK, map[string]any{
		"tenantId":   tenantID,
		"exportedAt": time.Now().UTC().Format(time.RFC3339),
		"tables":     tables,
	})
}
