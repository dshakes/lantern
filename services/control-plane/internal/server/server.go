package server

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

// Server holds shared dependencies for all gRPC service handlers.
type Server struct {
	// Pool is the privileged Postgres pool (connects as the 'lantern' superuser).
	// Used by migrations, recovery sweeps, marketplace cross-tenant queries, and
	// any code path that must bypass Row-Level Security (e.g. orphan-run recovery).
	Pool *pgxpool.Pool

	// AppPool is the application Postgres pool for tenant-scoped reads/writes.
	// When LANTERN_RLS_ENFORCE=1 and LANTERN_APP_DB_PASSWORD are set, AppPool
	// connects as 'lantern_app' (non-superuser, subject to RLS policies on
	// 'agents' and 'runs'). Otherwise AppPool == Pool (alias; zero behaviour
	// change). Handlers that carry a tenant context should prefer AppPool;
	// privileged admin paths (recovery, migrations) must use Pool.
	//
	// See: internal/db/rls.go WithTenantConn for the canonical usage pattern.
	AppPool *pgxpool.Pool

	Redis    *redis.Client
	Logger   *zap.Logger
	S3Bucket string
}

// TenantPool returns AppPool when it is set, falling back to Pool.
// All handler code that needs an RLS-capable pool should call this rather than
// accessing AppPool directly; it is nil-safe for test helpers that only set Pool.
func (s *Server) TenantPool() *pgxpool.Pool {
	if s.AppPool != nil {
		return s.AppPool
	}
	return s.Pool
}

// WithTenant is the centralized tenant-scoped DB accessor. It pulls the
// tenant_id from the request context (set by the gRPC tenant interceptor or
// middleware.InjectTenantID on REST paths), begins a transaction on the
// RLS-capable TenantPool(), sets the app.tenant_id GUC transaction-local, and
// runs fn inside that transaction.
//
// Returns codes.Unauthenticated when the context carries no tenant_id — a
// missing tenant must never silently fall through to an unscoped query.
//
// When LANTERN_RLS_ENFORCE=1 (TenantPool() == lantern_app, non-superuser),
// Postgres enforces the tenant_isolation policies automatically; otherwise the
// GUC still scopes application reads consistently. Callers must NOT commit or
// roll back the transaction themselves — WithTenant owns the tx lifecycle.
func (s *Server) WithTenant(ctx context.Context, fn func(pgx.Tx) error) error {
	tid, err := middleware.MustTenantID(ctx)
	if err != nil {
		return err
	}
	return db.WithTenantConn(ctx, s.TenantPool(), tid, fn)
}
