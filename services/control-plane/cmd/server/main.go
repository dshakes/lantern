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
	"github.com/dshakes/lantern/services/control-plane/internal/scheduler"
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
	connectorExecutor := handlers.NewConnectorExecutor(srv, authHandler)
	surfaceHandler := handlers.NewSurfaceHandler(srv, authHandler)
	waPersonalHandler := handlers.NewWhatsAppPersonalHandler(srv, authHandler)
	shortcutsHandler := handlers.NewShortcutsHandler(srv, authHandler)
	apiKeyHandler := handlers.NewApiKeyHandler(srv, authHandler)
	deploymentHandler := handlers.NewDeploymentHandler(srv, authHandler)
	a2aHandler := handlers.NewA2AHandler(srv, authHandler)
	llmProxyHandler := handlers.NewLlmProxyHandler(srv, authHandler)
	gmailHandler := handlers.NewGmailHandler(srv, authHandler)
	sessionHandler := handlers.NewSessionHandler(srv, authHandler, llmProxyHandler)
	restHandler.SetLlmProxy(llmProxyHandler) // enables inline run execution

	// Futuristic surface: cost forecasting, policy budgets, marketplace,
	// MCP registry, eval-in-CI, A/B experiments.
	forecastHandler := handlers.NewForecastHandler(srv, authHandler)
	budgetHandler := handlers.NewBudgetHandler(srv, authHandler)
	marketplaceHandler := handlers.NewMarketplaceHandler(srv, authHandler)
	// W11c: marketplace.Invoke kicks off a seller-tenant run, so the
	// handler needs the run service + inline executor. We wire them
	// after construction to avoid a circular dependency in the imports.
	marketplaceHandler.SetExecutionDeps(runSvc, restHandler)
	mcpHandler := handlers.NewMCPHandler(srv, authHandler)
	evalHandler := handlers.NewEvalHandler(srv, authHandler)
	experimentHandler := handlers.NewExperimentHandler(srv, authHandler)

	// Frontier surface: verifiable receipts, RLHF feedback loop,
	// rehearsal of past failures against new agent versions.
	receiptHandler := handlers.NewReceiptHandler(srv, authHandler)
	feedbackHandler := handlers.NewFeedbackHandler(srv, authHandler)
	rehearseHandler := handlers.NewRehearseHandler(srv, authHandler)

	// --- HTTP server (health + auth + REST API) ---
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		// JSON body so dev-doctor (and humans) can see runtime config at a
		// glance — most importantly which LLM routing mode is active so
		// the user knows whether they're spending API credits or not.
		// Kept backward-compatible by also accepting old text 'ok' shape:
		// callers that just check status code still work.
		llmMode := "api"
		if os.Getenv("LANTERN_USE_CLAUDE_CODE") == "1" {
			llmMode = "claude-code-local"
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","llmMode":%q}`+"\n", llmMode)
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
	httpMux.HandleFunc("GET /auth/oauth/{provider}/start", authHandler.OAuthStart)
	httpMux.HandleFunc("GET /auth/oauth/{provider}/callback", authHandler.OAuthCallback)

	// REST API endpoints (direct, no gateway needed).
	httpMux.HandleFunc("GET /v1/agents", restHandler.ListAgents)
	httpMux.HandleFunc("POST /v1/agents", restHandler.CreateAgent)
	httpMux.HandleFunc("GET /v1/agents/{name}", restHandler.GetAgent)
	httpMux.HandleFunc("PATCH /v1/agents/{name}", restHandler.UpdateAgent)
	httpMux.HandleFunc("DELETE /v1/agents/{name}", restHandler.DeleteAgent)
	httpMux.HandleFunc("GET /v1/runs", restHandler.ListRuns)
	httpMux.HandleFunc("POST /v1/runs", restHandler.CreateRun)
	httpMux.HandleFunc("GET /v1/runs/{id}", restHandler.GetRun)
	httpMux.HandleFunc("POST /v1/runs/{id}/cancel", restHandler.CancelRun)
	httpMux.HandleFunc("DELETE /v1/runs/{id}", restHandler.DeleteRun)

	// Connector endpoints.
	httpMux.HandleFunc("POST /v1/connectors/install", connectorHandler.InstallConnector)
	httpMux.HandleFunc("GET /v1/connectors", connectorHandler.ListConnectors)
	httpMux.HandleFunc("GET /v1/connectors/oauth/callback", connectorHandler.OAuthCallback)
	httpMux.HandleFunc("POST /v1/connectors/oauth/start", connectorHandler.OAuthStart)
	httpMux.HandleFunc("GET /v1/connectors/gmail/messages", gmailHandler.GetMessages)
	// Connector executor — registered before {id} to avoid path conflict.
	httpMux.HandleFunc("GET /v1/connectors/{connectorId}/execute", connectorExecutor.Execute)
	httpMux.HandleFunc("POST /v1/connectors/{connectorId}/execute", connectorExecutor.Execute)
	httpMux.HandleFunc("GET /v1/connectors/{id}", connectorHandler.GetConnector)
	httpMux.HandleFunc("POST /v1/connectors/{id}/test", connectorHandler.TestConnector)
	httpMux.HandleFunc("DELETE /v1/connectors/{id}", connectorHandler.UninstallConnector)

	// Surface endpoints.
	httpMux.HandleFunc("POST /v1/surfaces", surfaceHandler.ConfigureSurface)
	httpMux.HandleFunc("GET /v1/surfaces", surfaceHandler.ListSurfaces)
	// WhatsApp-specific routes are registered before the generic /{id}
	// matchers so they're not shadowed.
	httpMux.HandleFunc("POST /v1/surfaces/whatsapp/heartbeat", surfaceHandler.BridgeHeartbeat)
	httpMux.HandleFunc("GET /v1/surfaces/whatsapp/status", surfaceHandler.WhatsAppStatus)

	// Personal-assistant futuristic endpoints (VIP contacts, contact
	// facts/memory, smart-draft VIP approval flow).
	httpMux.HandleFunc("GET /v1/whatsapp/vips", waPersonalHandler.ListVIPs)
	httpMux.HandleFunc("POST /v1/whatsapp/vips", waPersonalHandler.AddVIP)
	httpMux.HandleFunc("DELETE /v1/whatsapp/vips", waPersonalHandler.RemoveVIP)
	httpMux.HandleFunc("GET /v1/whatsapp/facts", waPersonalHandler.ListFacts)
	httpMux.HandleFunc("POST /v1/whatsapp/facts", waPersonalHandler.AddFact)
	httpMux.HandleFunc("DELETE /v1/whatsapp/facts/{id}", waPersonalHandler.DeleteFact)
	httpMux.HandleFunc("POST /v1/whatsapp/drafts", waPersonalHandler.CreateDraft)
	httpMux.HandleFunc("GET /v1/whatsapp/drafts", waPersonalHandler.ListDrafts)
	httpMux.HandleFunc("POST /v1/whatsapp/drafts/{id}/act", waPersonalHandler.ActOnDraft)

	// iOS Shortcuts / Siri endpoints — single-purpose actions that map
	// 1:1 to Shortcut steps. Plain-text responses so Siri can speak
	// them aloud. Authenticated via the standard bearer token.
	httpMux.HandleFunc("POST /v1/shortcuts/pause", shortcutsHandler.Pause)
	httpMux.HandleFunc("POST /v1/shortcuts/resume", shortcutsHandler.Resume)
	httpMux.HandleFunc("GET /v1/shortcuts/status", shortcutsHandler.Status)
	httpMux.HandleFunc("POST /v1/shortcuts/say", shortcutsHandler.Say)
	// Slack /lantern slash command. Signed via SLACK_SIGNING_SECRET when
	// configured (dev accepts unverified + warns); ephemeral JSON replies.
	slackCommandHandler := handlers.NewSlackCommandHandler(srv)
	httpMux.HandleFunc("POST /v1/surfaces/slack/command", slackCommandHandler.HandleCommand)
	httpMux.HandleFunc("PUT /v1/surfaces/{id}", surfaceHandler.UpdateSurface)
	httpMux.HandleFunc("DELETE /v1/surfaces/{id}", surfaceHandler.RemoveSurface)
	httpMux.HandleFunc("POST /v1/surfaces/{id}/test", surfaceHandler.TestSurface)

	// API key endpoints.
	httpMux.HandleFunc("POST /v1/api-keys", apiKeyHandler.CreateApiKey)
	httpMux.HandleFunc("GET /v1/api-keys", apiKeyHandler.ListApiKeys)
	httpMux.HandleFunc("DELETE /v1/api-keys/{id}", apiKeyHandler.RevokeApiKey)

	// LLM proxy / completions endpoint.
	httpMux.HandleFunc("POST /v1/completions", llmProxyHandler.Complete)
	httpMux.HandleFunc("POST /v1/vision/ocr", llmProxyHandler.OCR)

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

	// Cloud deploy endpoints (Gap 5: Managed Hosting).
	httpMux.HandleFunc("POST /v1/agents/{name}/deploy", deploymentHandler.DeployAgent)
	httpMux.HandleFunc("GET /v1/agents/{name}/deploy", deploymentHandler.GetCloudDeployment)
	httpMux.HandleFunc("POST /v1/agents/{name}/deploy/stop", deploymentHandler.StopDeployment)

	// A2A (Agent-to-Agent) protocol endpoints (Gap 4).
	httpMux.HandleFunc("GET /v1/agents/{name}/card", a2aHandler.GetAgentCard)
	httpMux.HandleFunc("POST /v1/agents/{name}/a2a/invoke", a2aHandler.InvokeAgent)
	httpMux.HandleFunc("GET /.well-known/agent.json", a2aHandler.AgentDirectory)

	// Workflow persistence endpoints (visual editor).
	httpMux.HandleFunc("PUT /v1/agents/{name}/workflow", restHandler.SaveWorkflow)
	httpMux.HandleFunc("GET /v1/agents/{name}/workflow", restHandler.GetWorkflow)

	// Schedule endpoints.
	httpMux.HandleFunc("POST /v1/schedules", restHandler.CreateSchedule)
	httpMux.HandleFunc("GET /v1/schedules", restHandler.ListSchedules)
	httpMux.HandleFunc("PUT /v1/schedules/{id}", restHandler.UpdateSchedule)
	httpMux.HandleFunc("DELETE /v1/schedules/{id}", restHandler.DeleteSchedule)

	// Session endpoints (interactive, long-lived agent sessions).
	httpMux.HandleFunc("POST /v1/sessions", sessionHandler.CreateSession)
	httpMux.HandleFunc("GET /v1/sessions", sessionHandler.ListSessions)
	httpMux.HandleFunc("POST /v1/sessions/{id}/messages", sessionHandler.SendMessage)
	httpMux.HandleFunc("GET /v1/sessions/{id}/events", sessionHandler.GetEvents)
	httpMux.HandleFunc("POST /v1/sessions/{id}/stop", sessionHandler.StopSession)
	httpMux.HandleFunc("DELETE /v1/sessions/{id}", sessionHandler.DeleteSession)
	httpMux.HandleFunc("GET /v1/sessions/{id}", sessionHandler.GetSession)

	// Pre-run cost forecaster.
	httpMux.HandleFunc("POST /v1/runs/forecast", forecastHandler.Forecast)

	// Policy-as-code budgets (per-agent cost + per-tool rate limits).
	httpMux.HandleFunc("PUT /v1/agents/{name}/budget", budgetHandler.UpsertBudget)
	httpMux.HandleFunc("GET /v1/agents/{name}/budget", budgetHandler.GetBudget)
	httpMux.HandleFunc("DELETE /v1/agents/{name}/budget", budgetHandler.DeleteBudget)
	httpMux.HandleFunc("GET /v1/budgets", budgetHandler.ListBudgets)

	// Marketplace — publish, fork, star agents.
	httpMux.HandleFunc("GET /v1/marketplace", marketplaceHandler.List)
	httpMux.HandleFunc("POST /v1/marketplace/publish", marketplaceHandler.Publish)
	httpMux.HandleFunc("GET /v1/marketplace/{slug}", marketplaceHandler.Get)
	httpMux.HandleFunc("DELETE /v1/marketplace/{slug}", marketplaceHandler.Unpublish)
	httpMux.HandleFunc("POST /v1/marketplace/{slug}/fork", marketplaceHandler.Fork)
	httpMux.HandleFunc("POST /v1/marketplace/{slug}/star", marketplaceHandler.Star)
	httpMux.HandleFunc("DELETE /v1/marketplace/{slug}/star", marketplaceHandler.Star)
	// W11c: cross-tenant invocations with HMAC-signed settlement.
	httpMux.HandleFunc("POST /v1/marketplace/{slug}/invoke", marketplaceHandler.Invoke)
	httpMux.HandleFunc("GET /v1/marketplace/invocations", marketplaceHandler.ListInvocations)

	// W11a: takeover handshake. Workflow approval nodes pause on these,
	// the dashboard surfaces them, an operator grants → optionally
	// exchanges WebRTC SDP → releases when done.
	takeoverHandler := handlers.NewTakeoverHandler(srv, authHandler)
	httpMux.HandleFunc("POST /v1/runs/{id}/takeover/request", takeoverHandler.Request)
	httpMux.HandleFunc("GET /v1/runs/{id}/takeover", takeoverHandler.ListForRun)
	httpMux.HandleFunc("POST /v1/runs/{id}/takeover/{takeoverId}/grant", takeoverHandler.Grant)
	httpMux.HandleFunc("POST /v1/runs/{id}/takeover/{takeoverId}/answer", takeoverHandler.Answer)
	httpMux.HandleFunc("POST /v1/runs/{id}/takeover/{takeoverId}/release", takeoverHandler.Release)

	// Agent templates — one-click create-agent + budget + schedule for
	// curated use cases (Inbox Concierge, Morning Brief). Borrows the
	// REST handler for agentSvc + pool access.
	templateHandler := handlers.NewTemplateHandler(restHandler, authHandler)
	httpMux.HandleFunc("GET /v1/agents/templates", templateHandler.ListTemplates)
	httpMux.HandleFunc("POST /v1/agents/from-template", templateHandler.Apply)
	httpMux.HandleFunc("GET /v1/agents/{name}/setup", templateHandler.SetupStatus)

	// W11d: voice channel. Phone-number management + provider webhooks
	// (Twilio today; LiveKit / Vapi pluggable via VoiceProvider).
	voiceHandler := handlers.NewVoiceHandler(srv, authHandler)
	httpMux.HandleFunc("POST /v1/voice/numbers", voiceHandler.CreateNumber)
	httpMux.HandleFunc("GET /v1/voice/numbers", voiceHandler.ListNumbers)
	httpMux.HandleFunc("DELETE /v1/voice/numbers/{id}", voiceHandler.DeleteNumber)
	httpMux.HandleFunc("GET /v1/voice/calls", voiceHandler.ListCalls)
	httpMux.HandleFunc("POST /v1/voice/webhook/{provider}", voiceHandler.Webhook)

	// MCP server registry + per-agent attachments.
	httpMux.HandleFunc("GET /v1/mcp/servers", mcpHandler.ListServers)
	httpMux.HandleFunc("GET /v1/mcp/servers/{slug}", mcpHandler.GetServer)
	httpMux.HandleFunc("POST /v1/agents/{name}/mcp-servers", mcpHandler.AttachToAgent)
	httpMux.HandleFunc("GET /v1/agents/{name}/mcp-servers", mcpHandler.ListAttachments)
	httpMux.HandleFunc("DELETE /v1/agents/{name}/mcp-servers/{slug}", mcpHandler.DetachFromAgent)

	// Eval suites + runs + baselines (foundation for lantern test --against=last-green).
	httpMux.HandleFunc("POST /v1/eval-suites", evalHandler.UpsertSuite)
	httpMux.HandleFunc("GET /v1/eval-suites", evalHandler.ListSuites)
	httpMux.HandleFunc("GET /v1/eval-suites/{id}", evalHandler.GetSuite)
	httpMux.HandleFunc("DELETE /v1/eval-suites/{id}", evalHandler.DeleteSuite)
	httpMux.HandleFunc("POST /v1/eval-runs", evalHandler.RecordRun)
	httpMux.HandleFunc("GET /v1/eval-runs", evalHandler.ListRuns)
	httpMux.HandleFunc("GET /v1/eval-runs/{id}", evalHandler.GetRun)
	httpMux.HandleFunc("POST /v1/eval-baselines", evalHandler.SetBaseline)
	httpMux.HandleFunc("GET /v1/eval-baselines", evalHandler.GetBaseline)

	// A/B experiments with auto-promotion.
	httpMux.HandleFunc("POST /v1/experiments", experimentHandler.Create)
	httpMux.HandleFunc("GET /v1/experiments", experimentHandler.List)
	httpMux.HandleFunc("GET /v1/experiments/{id}", experimentHandler.Get)
	httpMux.HandleFunc("POST /v1/experiments/{id}/record", experimentHandler.RecordOutcome)
	httpMux.HandleFunc("POST /v1/experiments/{id}/conclude", experimentHandler.Conclude)

	// Verifiable execution receipts — HMAC-signed, journal-bound run summaries.
	httpMux.HandleFunc("POST /v1/runs/{id}/receipt", receiptHandler.IssueReceipt)
	httpMux.HandleFunc("POST /v1/runs/receipts/verify", receiptHandler.VerifyReceipt)
	httpMux.HandleFunc("GET /.well-known/lantern-receipts", receiptHandler.WellKnown)

	// RLHF feedback loop — per-run thumbs + preferred-output capture.
	httpMux.HandleFunc("POST /v1/runs/{id}/feedback", feedbackHandler.SubmitFeedback)
	httpMux.HandleFunc("GET /v1/runs/{id}/feedback", feedbackHandler.ListFeedback)
	httpMux.HandleFunc("GET /v1/agents/{name}/feedback", feedbackHandler.AgentSummary)

	// Rehearsals — replay past failures against a candidate agent version.
	httpMux.HandleFunc("POST /v1/runs/rehearse", rehearseHandler.Rehearse)

	// Headless-agent runtime governance — REST surface in front of the
	// Firecracker-backed RuntimeScheduler at :50055. Quota-gated,
	// tenant-scoped, audit-logged.
	runtimeHandler := handlers.NewRuntimeHandler(srv, authHandler)
	httpMux.HandleFunc("POST /v1/runtime/schedule", runtimeHandler.Schedule)
	httpMux.HandleFunc("GET /v1/runtime/vms", runtimeHandler.ListVMs)
	httpMux.HandleFunc("GET /v1/runtime/vms/{id}", runtimeHandler.GetVM)
	httpMux.HandleFunc("GET /v1/runtime/vms/{id}/logs", runtimeHandler.StreamLogs)
	httpMux.HandleFunc("DELETE /v1/runtime/vms/{id}", runtimeHandler.TerminateVM)
	httpMux.HandleFunc("POST /v1/runtime/vms/{id}/exec", runtimeHandler.ExecVM)
	httpMux.HandleFunc("GET /v1/runtime/cluster", runtimeHandler.Cluster)
	httpMux.HandleFunc("GET /v1/runtime/quota", runtimeHandler.GetQuota)
	httpMux.HandleFunc("PUT /v1/runtime/quota", runtimeHandler.UpsertQuota)
	httpMux.HandleFunc("GET /v1/runtime/audit", runtimeHandler.ListAudit)

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

	// --- Cron scheduler ---
	// The scheduler fires due schedules by creating runs via the same inline
	// executor path used by POST /v1/runs.
	sched := scheduler.New(pool, logger, func(runID, tenantID, agentName string, input map[string]any) {
		restHandler.ExecuteScheduledRun(tenantID, agentName, input)
	})
	go sched.Start(ctx)
	defer sched.Stop()

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
		JWTSecret:   envOrDefault("JWT_SECRET", "lantern-dev-jwt-secret-do-not-use-in-production"),
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
