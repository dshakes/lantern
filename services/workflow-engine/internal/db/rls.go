// Row-Level Security helpers for the workflow engine.
//
// The engine writes run state for every tenant on the platform, and until now
// it set `app.tenant_id` NOWHERE — so with LANTERN_RLS_ENFORCE=1 its queries
// were unprotected by the policies the rest of the platform relies on
// (invariant #7). This is the missing primitive, deliberately identical in
// shape to the control-plane's db.WithTenantConn so the two services behave the
// same way under the same policies.
//
// A WORKER IS NOT A REQUEST HANDLER, and that difference is the whole design
// here. The control plane always has a caller's tenant in context. The engine
// does not: it polls for work across ALL tenants, and only once it has claimed
// a run does it know whose work it is doing. So the split is:
//
//   - Cross-tenant by necessity (the scheduler's poll, lock bookkeeping,
//     journal writes): NOT scoped, each marked `rls-exempt:` with the reason.
//     journal_events and run_locks are in the platform's documented RLS-exempt
//     set anyway — they have no tenant_id column to police.
//   - Tenant known (everything that reads or writes a specific run's state):
//     scoped through WithTenant below, so a bug that loses the tenant filter
//     is caught by the database rather than silently crossing tenants.
//
// The GUC is set with is_local = true, so it is scoped to the transaction and
// cannot leak to the next user of a pooled connection.
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WithTenant runs fn inside a transaction with `app.tenant_id` set to tenantID,
// so RLS policies admit exactly that tenant's rows.
//
// An empty tenantID is refused rather than run unscoped: under enforcement an
// unset GUC matches nothing, which would turn a missing tenant into confusing
// "row not found" failures instead of an obvious programming error.
func WithTenant(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(pgx.Tx) error) error {
	if tenantID == "" {
		return fmt.Errorf("db.WithTenant: empty tenant_id")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("db.WithTenant: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return fmt.Errorf("db.WithTenant: set_config: %w", err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("db.WithTenant: commit: %w", err)
	}
	return nil
}

// SetTenantOnTx sets the tenant GUC on an ALREADY-OPEN transaction.
//
// Several engine paths open a transaction to write a journal entry and update
// run status together; those must stay one transaction, so they set the GUC on
// the transaction they already have rather than nesting another.
func SetTenantOnTx(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if tenantID == "" {
		return fmt.Errorf("db.SetTenantOnTx: empty tenant_id")
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return fmt.Errorf("db.SetTenantOnTx: set_config: %w", err)
	}
	return nil
}
