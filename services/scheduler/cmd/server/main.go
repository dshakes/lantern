package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"github.com/dshakes/lantern/services/scheduler/internal/cron"
	"github.com/dshakes/lantern/services/scheduler/internal/db"
	"github.com/dshakes/lantern/services/scheduler/internal/handlers"
	"github.com/dshakes/lantern/services/scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/scheduler/internal/runclient"
	"github.com/dshakes/lantern/services/scheduler/internal/server"
)

func main() {
	cfg := loadConfig()

	logger := mustInitLogger(cfg.LogLevel)
	defer logger.Sync() //nolint:errcheck

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// --- Postgres ---
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("failed to create pgx pool", zap.Error(err))
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		logger.Fatal("failed to ping database", zap.Error(err))
	}
	logger.Info("connected to postgres")

	if err := db.Migrate(ctx, pool); err != nil {
		logger.Fatal("failed to run migrations", zap.Error(err))
	}
	logger.Info("migrations complete")

	// --- Redis ---
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Fatal("failed to parse REDIS_URL", zap.Error(err))
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close() //nolint:errcheck

	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Fatal("failed to ping redis", zap.Error(err))
	}
	logger.Info("connected to redis")

	// --- Server struct ---
	srv := &server.Server{
		Pool:   pool,
		Redis:  rdb,
		Logger: logger,
	}

	// --- Run creator: long-lived gRPC client to the control-plane RunService ---
	// A fired schedule creates a run via RunService.CreateRun (invariant #2) with
	// the schedule's tenant_id in metadata (invariant #7). The conn is shared by
	// the cron ticker and the delayed-run processor for the whole process life.
	runClient, err := runclient.New(cfg.ControlPlaneAddr, cfg.ServiceToken, logger)
	if err != nil {
		logger.Fatal("failed to create control-plane run client", zap.Error(err))
	}
	defer func() {
		if err := runClient.Close(); err != nil {
			logger.Warn("run client close failed", zap.Error(err))
		}
	}()
	createRun := runClient.CreateRun
	logger.Info("control-plane run client ready",
		zap.String("control_plane_addr", cfg.ControlPlaneAddr),
		zap.Bool("service_token_set", cfg.ServiceToken != ""),
	)

	// Initialize schedule next_fire_at for schedules that don't have one.
	if err := cron.InitScheduleNextFireTimes(ctx, pool, logger); err != nil {
		logger.Error("failed to initialize schedule fire times", zap.Error(err))
	}

	// --- Cron ticker background goroutine ---
	ticker := cron.NewTicker(pool, logger, createRun)
	go ticker.Run(ctx)

	// --- Delayed run processor background goroutine ---
	delayedProc := cron.NewDelayedProcessor(pool, logger, createRun)
	go delayedProc.Run(ctx)

	// --- gRPC server ---
	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			middleware.UnaryTenantInterceptor(logger),
			unaryTracingInterceptor(),
		),
		grpc.ChainStreamInterceptor(
			middleware.StreamTenantInterceptor(logger),
			streamTracingInterceptor(),
		),
	)

	// Register services.
	schedulerSvc := handlers.NewSchedulerService(srv, createRun)
	_ = schedulerSvc // Registered via gRPC service descriptor when proto is generated.

	// Health check.
	healthSvc := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthSvc)
	healthSvc.SetServingStatus("lantern.v1.SchedulerService", healthpb.HealthCheckResponse_SERVING)

	reflection.Register(grpcServer)

	// --- Start gRPC listener ---
	lis, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		logger.Fatal("failed to listen", zap.String("addr", cfg.ListenAddr), zap.Error(err))
	}

	grpcErrCh := make(chan error, 1)
	go func() {
		logger.Info("gRPC server starting", zap.String("addr", cfg.ListenAddr))
		grpcErrCh <- grpcServer.Serve(lis)
	}()

	// --- HTTP health server ---
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	httpMux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "database not ready", http.StatusServiceUnavailable)
			return
		}
		if err := rdb.Ping(r.Context()).Err(); err != nil {
			http.Error(w, "redis not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	httpErrCh := make(chan error, 1)
	go func() {
		logger.Info("HTTP health server starting", zap.String("addr", cfg.HTTPAddr))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			httpErrCh <- err
		}
		close(httpErrCh)
	}()

	// --- Wait for shutdown ---
	select {
	case <-ctx.Done():
		logger.Info("received shutdown signal")
	case err := <-grpcErrCh:
		logger.Fatal("gRPC server failed", zap.Error(err))
	case err := <-httpErrCh:
		logger.Fatal("HTTP server failed", zap.Error(err))
	}

	healthSvc.SetServingStatus("lantern.v1.SchedulerService", healthpb.HealthCheckResponse_NOT_SERVING)

	grpcServer.GracefulStop()
	logger.Info("gRPC server stopped")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}
	logger.Info("HTTP server stopped")

	logger.Info("scheduler service shut down cleanly")
}

type config struct {
	DatabaseURL      string
	RedisURL         string
	ListenAddr       string
	HTTPAddr         string
	ControlPlaneAddr string
	ServiceToken     string
	LogLevel         string
}

func loadConfig() config {
	return config{
		DatabaseURL:      envOrDefault("DATABASE_URL", "postgres://localhost:5432/lantern?sslmode=disable"),
		RedisURL:         envOrDefault("REDIS_URL", "redis://localhost:6379/0"),
		ListenAddr:       envOrDefault("LISTEN_ADDR", ":50058"),
		HTTPAddr:         envOrDefault("HTTP_ADDR", ":8088"),
		ControlPlaneAddr: envOrDefault("CONTROL_PLANE_ADDR", "localhost:50051"),
		// Shared service token for the control-plane's optional service-token
		// interceptor. When unset, nothing is attached (additive, dev pass-through).
		ServiceToken: os.Getenv("LANTERN_GRPC_SERVICE_TOKEN"),
		LogLevel:     envOrDefault("LOG_LEVEL", "info"),
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustInitLogger(level string) *zap.Logger {
	var zapLevel zapcore.Level
	if err := zapLevel.UnmarshalText([]byte(level)); err != nil {
		zapLevel = zapcore.InfoLevel
	}

	cfg := zap.NewProductionConfig()
	cfg.Level = zap.NewAtomicLevelAt(zapLevel)
	cfg.EncoderConfig.TimeKey = "ts"
	cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	logger, err := cfg.Build()
	if err != nil {
		panic(fmt.Sprintf("failed to build logger: %v", err))
	}
	return logger
}

func unaryTracingInterceptor() grpc.UnaryServerInterceptor {
	tracer := otel.Tracer("lantern.scheduler")
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		ctx, span := tracer.Start(ctx, info.FullMethod)
		defer span.End()
		return handler(ctx, req)
	}
}

func streamTracingInterceptor() grpc.StreamServerInterceptor {
	tracer := otel.Tracer("lantern.scheduler")
	return func(
		srv any,
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		ctx, span := tracer.Start(ss.Context(), info.FullMethod)
		defer span.End()
		wrapped := &wrappedStream{ServerStream: ss, ctx: ctx}
		return handler(srv, wrapped)
	}
}

type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
	return w.ctx
}
