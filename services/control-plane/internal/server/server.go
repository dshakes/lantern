package server

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
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
