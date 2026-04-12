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

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/handlers"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
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

	// Run migrations for the spike (in production, use a proper migration tool).
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
		Pool:     pool,
		Redis:    rdb,
		Logger:   logger,
		S3Bucket: cfg.S3Bucket,
	}

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
	agentSvc := handlers.NewAgentService(srv)
	runSvc := handlers.NewRunService(srv)
	lanternv1.RegisterAgentServiceServer(grpcServer, agentSvc)
	lanternv1.RegisterRunServiceServer(grpcServer, runSvc)

	// Health check.
	healthSvc := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthSvc)
	healthSvc.SetServingStatus("lantern.v1.AgentService", healthpb.HealthCheckResponse_SERVING)
	healthSvc.SetServingStatus("lantern.v1.RunService", healthpb.HealthCheckResponse_SERVING)

	// Reflection for grpcurl / grpcui.
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

	// --- Auth handler ---
	jwtSecret := handlers.GetJWTSecret()
	authHandler := handlers.NewAuthHandler(srv, jwtSecret)

	// --- REST handler (wraps gRPC handlers for direct HTTP access) ---
	restHandler := handlers.NewRESTHandler(srv, authHandler, agentSvc, runSvc)

	// --- Domain-specific handlers ---
	connectorHandler := handlers.NewConnectorHandler(srv, authHandler)
	surfaceHandler := handlers.NewSurfaceHandler(srv, authHandler)
	apiKeyHandler := handlers.NewApiKeyHandler(srv, authHandler)
	deploymentHandler := handlers.NewDeploymentHandler(srv, authHandler)
	llmProxyHandler := handlers.NewLlmProxyHandler(srv, authHandler)

	// --- HTTP server (health + auth + REST API) ---
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

	// Auth endpoints.
	httpMux.HandleFunc("POST /auth/signup", authHandler.Signup)
	httpMux.HandleFunc("POST /auth/login", authHandler.Login)
	httpMux.HandleFunc("GET /auth/me", authHandler.GetMe)

	// REST API endpoints (direct, no gateway needed).
	httpMux.HandleFunc("GET /v1/agents", restHandler.ListAgents)
	httpMux.HandleFunc("POST /v1/agents", restHandler.CreateAgent)
	httpMux.HandleFunc("GET /v1/agents/{name}", restHandler.GetAgent)
	httpMux.HandleFunc("DELETE /v1/agents/{name}", restHandler.DeleteAgent)
	httpMux.HandleFunc("GET /v1/runs", restHandler.ListRuns)
	httpMux.HandleFunc("POST /v1/runs", restHandler.CreateRun)
	httpMux.HandleFunc("GET /v1/runs/{id}", restHandler.GetRun)
	httpMux.HandleFunc("POST /v1/runs/{id}/cancel", restHandler.CancelRun)

	// Connector endpoints.
	httpMux.HandleFunc("POST /v1/connectors/install", connectorHandler.InstallConnector)
	httpMux.HandleFunc("GET /v1/connectors", connectorHandler.ListConnectors)
	httpMux.HandleFunc("GET /v1/connectors/oauth/callback", connectorHandler.OAuthCallback)
	httpMux.HandleFunc("POST /v1/connectors/oauth/start", connectorHandler.OAuthStart)
	httpMux.HandleFunc("GET /v1/connectors/{id}", connectorHandler.GetConnector)
	httpMux.HandleFunc("POST /v1/connectors/{id}/test", connectorHandler.TestConnector)
	httpMux.HandleFunc("DELETE /v1/connectors/{id}", connectorHandler.UninstallConnector)

	// Surface endpoints.
	httpMux.HandleFunc("POST /v1/surfaces", surfaceHandler.ConfigureSurface)
	httpMux.HandleFunc("GET /v1/surfaces", surfaceHandler.ListSurfaces)
	httpMux.HandleFunc("PUT /v1/surfaces/{id}", surfaceHandler.UpdateSurface)
	httpMux.HandleFunc("DELETE /v1/surfaces/{id}", surfaceHandler.RemoveSurface)
	httpMux.HandleFunc("POST /v1/surfaces/{id}/test", surfaceHandler.TestSurface)

	// API key endpoints.
	httpMux.HandleFunc("POST /v1/api-keys", apiKeyHandler.CreateApiKey)
	httpMux.HandleFunc("GET /v1/api-keys", apiKeyHandler.ListApiKeys)
	httpMux.HandleFunc("DELETE /v1/api-keys/{id}", apiKeyHandler.RevokeApiKey)

	// LLM proxy / completions endpoint.
	httpMux.HandleFunc("POST /v1/completions", llmProxyHandler.Complete)

	// Agent AI generation endpoints.
	httpMux.HandleFunc("POST /v1/agents/generate-spec", llmProxyHandler.GenerateAgentSpec)
	httpMux.HandleFunc("POST /v1/agents/generate-code", llmProxyHandler.GenerateAgentCode)

	// LLM provider settings endpoints.
	httpMux.HandleFunc("POST /v1/settings/llm-providers", llmProxyHandler.SaveLlmProvider)
	httpMux.HandleFunc("GET /v1/settings/llm-providers", llmProxyHandler.ListLlmProviders)
	httpMux.HandleFunc("POST /v1/settings/llm-providers/{provider}/test", llmProxyHandler.TestLlmProvider)

	// Deployment endpoints.
	httpMux.HandleFunc("POST /v1/deployments", deploymentHandler.CreateDeployment)
	httpMux.HandleFunc("GET /v1/deployments", deploymentHandler.ListDeployments)
	httpMux.HandleFunc("GET /v1/deployments/{id}", deploymentHandler.GetDeployment)
	httpMux.HandleFunc("POST /v1/data-planes", deploymentHandler.RegisterDataPlane)
	httpMux.HandleFunc("GET /v1/data-planes", deploymentHandler.ListDataPlanes)
	httpMux.HandleFunc("DELETE /v1/data-planes/{id}", deploymentHandler.RemoveDataPlane)

	httpServer := &http.Server{
		Addr:              ":8080",
		Handler:           handlers.CORSMiddleware(httpMux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	httpErrCh := make(chan error, 1)
	go func() {
		logger.Info("HTTP health server starting", zap.String("addr", ":8080"))
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

	// Graceful shutdown: stop accepting, drain in-flight.
	healthSvc.SetServingStatus("lantern.v1.AgentService", healthpb.HealthCheckResponse_NOT_SERVING)
	healthSvc.SetServingStatus("lantern.v1.RunService", healthpb.HealthCheckResponse_NOT_SERVING)

	grpcServer.GracefulStop()
	logger.Info("gRPC server stopped")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}
	logger.Info("HTTP server stopped")

	logger.Info("control-plane shut down cleanly")
}

// config holds values read from environment variables.
type config struct {
	DatabaseURL string
	RedisURL    string
	ListenAddr  string
	S3Bucket    string
	LogLevel    string
	JWTSecret   string
}

func loadConfig() config {
	return config{
		DatabaseURL: envOrDefault("DATABASE_URL", "postgres://localhost:5432/lantern?sslmode=disable"),
		RedisURL:    envOrDefault("REDIS_URL", "redis://localhost:6379/0"),
		ListenAddr:  envOrDefault("LISTEN_ADDR", ":50051"),
		S3Bucket:    envOrDefault("S3_BUCKET", "lantern-bundles-dev"),
		LogLevel:    envOrDefault("LOG_LEVEL", "info"),
		JWTSecret:   envOrDefault("JWT_SECRET", "lantern-dev-secret-change-me-in-production"),
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

// unaryTracingInterceptor returns a gRPC unary interceptor that creates OTel spans.
func unaryTracingInterceptor() grpc.UnaryServerInterceptor {
	tracer := otel.Tracer("lantern.control-plane")
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

// streamTracingInterceptor returns a gRPC stream interceptor that creates OTel spans.
func streamTracingInterceptor() grpc.StreamServerInterceptor {
	tracer := otel.Tracer("lantern.control-plane")
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

// wrappedStream overrides Context() to propagate the traced context.
type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
	return w.ctx
}
