package server

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Server holds shared dependencies for all gRPC service handlers.
type Server struct {
	Pool   *pgxpool.Pool
	Logger *zap.Logger
}
