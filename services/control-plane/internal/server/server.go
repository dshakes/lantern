package server

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// Server holds shared dependencies for all gRPC service handlers.
type Server struct {
	Pool     *pgxpool.Pool
	Redis    *redis.Client
	Logger   *zap.Logger
	S3Bucket string
}
