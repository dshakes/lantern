// runtime-scheduler entrypoint. Boots:
//   - gRPC server on :50055 (RuntimeScheduler service + health + reflection)
//   - REST gateway on :8085 (POST /v1/schedule, GET /v1/vms, ...)
//   - background heartbeat reaper that marks stale nodes draining
//
// Wires:
//   - in-memory cluster store (swap to persistent via ClusterStore later)
//   - placement engine (cluster + scoring)
//   - runtime-manager dialer (stub today; real gRPC client next)
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/dialer"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/handlers"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/placement"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/scoring"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/store"
)

func main() {
	cfg := loadConfig()
	logger := mustInitLogger(cfg.LogLevel)
	defer logger.Sync() //nolint:errcheck

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// --- Cluster state + placement engine ---
	mem := cluster.NewInMemoryStore()

	// Optional Postgres persistence: activated when DATABASE_URL is set.
	// When absent the scheduler runs purely in-memory (original behaviour).
	var clusterStore cluster.ClusterStore = mem
	var snapPersister handlers.SnapshotPersister
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		logger.Info("DATABASE_URL set — enabling Postgres persistence")
		pool, err := pgxpool.New(ctx, dbURL)
		if err != nil {
			logger.Fatal("failed to open DB pool", zap.Error(err))
		}
		defer pool.Close()

		migrateCtx, migrateCancel := context.WithTimeout(ctx, 15*time.Second)
		if err := store.Migrate(migrateCtx, pool); err != nil {
			migrateCancel()
			logger.Fatal("DB migration failed", zap.Error(err))
		}
		migrateCancel()

		wt := store.NewWriteThroughStore(mem, pool, logger)
		loadCtx, loadCancel := context.WithTimeout(ctx, 15*time.Second)
		if err := wt.LoadFromDB(loadCtx, cluster.HeartbeatDeadline); err != nil {
			loadCancel()
			logger.Warn("failed to load persisted state — starting fresh", zap.Error(err))
		} else {
			loadCancel()
		}
		clusterStore = wt
		snapPersister = wt
		logger.Info("write-through store ready")
	} else {
		logger.Info("DATABASE_URL not set — using in-memory store only")
	}

	weights := scoring.Weights{
		WarmPool:  cfg.WeightWarmPool,
		Region:    cfg.WeightRegion,
		FairShare: cfg.WeightFairShare,
		Cost:      cfg.WeightCost,
		Health:    cfg.WeightHealth,
	}
	pl := &placement.Engine{Store: clusterStore, Weights: weights}

	var managerDialer dialer.ManagerDialer
	if os.Getenv("LANTERN_DIALER") == "stub" || os.Getenv("LANTERN_DEFAULT_MANAGER_ADDR") == "" {
		managerDialer = dialer.NewLogOnlyDialer(logger)
		logger.Info("using stub manager dialer (no LANTERN_DEFAULT_MANAGER_ADDR set)")
	} else {
		managerDialer = dialer.NewGRPCDialer(logger)
		logger.Info("using gRPC manager dialer")
	}
	defer managerDialer.Close()

	// --- Background heartbeat reaper ---
	cluster.StartHeartbeatReaper(ctx, clusterStore, cluster.HeartbeatDeadline, 5*time.Second, func(name string) {
		logger.Warn("node heartbeat expired, marking draining", zap.String("node", name))
	})

	// --- gRPC server ---
	schedSvc := handlers.NewSchedulerService(clusterStore, pl, managerDialer, logger, cfg.TenantMaxVMs)
	schedSvc.SnapshotPersister = snapPersister

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
	lanternv1.RegisterRuntimeSchedulerServer(grpcServer, schedSvc)

	healthSvc := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthSvc)
	healthSvc.SetServingStatus("lantern.v1.RuntimeScheduler", healthpb.HealthCheckResponse_SERVING)
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		logger.Fatal("failed to listen", zap.String("addr", cfg.GRPCAddr), zap.Error(err))
	}

	grpcErrCh := make(chan error, 1)
	go func() {
		logger.Info("gRPC server starting", zap.String("addr", cfg.GRPCAddr))
		grpcErrCh <- grpcServer.Serve(lis)
	}()

	// --- REST gateway ---
	rest := handlers.NewRESTHandler(schedSvc, clusterStore, []byte(cfg.JWTSecret), logger)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	mux.HandleFunc("POST /v1/schedule", rest.Schedule)
	mux.HandleFunc("GET /v1/vms", rest.ListVMs)
	mux.HandleFunc("DELETE /v1/vms/{id}", rest.TerminateVM)
	mux.HandleFunc("GET /v1/cluster", rest.GetCluster)
	mux.HandleFunc("POST /v1/nodes/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		rest.NodeHeartbeat(w, r, cfg.NodeToken)
	})

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	httpErrCh := make(chan error, 1)
	go func() {
		logger.Info("HTTP server starting", zap.String("addr", cfg.HTTPAddr))
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

	healthSvc.SetServingStatus("lantern.v1.RuntimeScheduler", healthpb.HealthCheckResponse_NOT_SERVING)
	grpcServer.GracefulStop()
	logger.Info("gRPC server stopped")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}
	logger.Info("runtime-scheduler shut down cleanly")
}

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

type config struct {
	GRPCAddr        string
	HTTPAddr        string
	JWTSecret       string
	NodeToken       string
	LogLevel        string
	TenantMaxVMs    int
	WeightWarmPool  float64
	WeightRegion    float64
	WeightFairShare float64
	WeightCost      float64
	WeightHealth    float64
}

func loadConfig() config {
	def := scoring.DefaultWeights()
	return config{
		GRPCAddr:        envOrDefault("LISTEN_ADDR", ":50055"),
		HTTPAddr:        envOrDefault("HTTP_ADDR", ":8085"),
		JWTSecret:       envOrDefault("JWT_SECRET", "lantern-dev-jwt-secret-do-not-use-in-production"),
		NodeToken:       os.Getenv("SCHEDULER_NODE_TOKEN"),
		LogLevel:        envOrDefault("LOG_LEVEL", "info"),
		TenantMaxVMs:    envInt("SCHEDULER_TENANT_MAX_VMS", 20),
		WeightWarmPool:  envFloat("SCHEDULER_WEIGHT_WARM_POOL", def.WarmPool),
		WeightRegion:    envFloat("SCHEDULER_WEIGHT_REGION", def.Region),
		WeightFairShare: envFloat("SCHEDULER_WEIGHT_FAIR_SHARE", def.FairShare),
		WeightCost:      envFloat("SCHEDULER_WEIGHT_COST", def.Cost),
		WeightHealth:    envFloat("SCHEDULER_WEIGHT_HEALTH", def.Health),
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func envFloat(key string, fallback float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
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

// ---------------------------------------------------------------------
// OpenTelemetry interceptors. Same pattern as services/scheduler.
// otelgrpc would be a dependency-heavy add; this lightweight wrapper
// gives us the same span-per-RPC behaviour while we wait for the rest
// of the platform to standardize on otelgrpc.
// ---------------------------------------------------------------------

func unaryTracingInterceptor() grpc.UnaryServerInterceptor {
	tracer := otel.Tracer("lantern.runtime-scheduler")
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
	tracer := otel.Tracer("lantern.runtime-scheduler")
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

func (w *wrappedStream) Context() context.Context { return w.ctx }
