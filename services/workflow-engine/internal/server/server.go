package server

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/workflow-engine/internal/engine"
)

// Server holds shared dependencies for all gRPC service handlers.
type Server struct {
	Pool   *pgxpool.Pool
	Redis  *redis.Client
	Logger *zap.Logger
	Engine *engine.Engine
}
