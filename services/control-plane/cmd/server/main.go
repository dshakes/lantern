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
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/handlers"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/scheduler"
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"github.com/dshakes/lantern/services/control-plane/internal/telemetry"
)

func main() {
	cfg := loadConfig()

	logger := mustInitLogger(cfg.LogLevel)
	defer logger.Sync() //nolint:errcheck

	// --- Startup security guards ---
	// Fail closed in production; warn and continue in dev (LANTERN_ENV unset).
	runStartupGuards(logger)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// --- OpenTelemetry ---
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT / LANTERN_OTEL_ENABLED=1 are unset,
	// so the default path is unchanged (no collector required, no spans exported).
	otelShutdown, err := telemetry.InitTracer(ctx, "lantern.control-plane")
	if err != nil {
		logger.Warn("tracing init failed; continuing without traces", zap.Error(err))
		otelShutdown = func(context.Context) error { return nil }
	}
	defer func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		if err := otelShutdown(shutdownCtx); err != nil {
			logger.Warn("tracing shutdown error", zap.Error(err))
		}
	}()

	// --- Postgres ---
	pgCfg, err := parsePgxPoolConfig(cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("failed to parse DATABASE_URL", zap.Error(err))
	}
	pool, err := pgxpool.NewWithConfig(ctx, pgCfg)
	if err != nil {
		logger.Fatal("failed to create pgx pool", zap.Error(err))
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		logger.Fatal("failed to ping database", zap.Error(err))
	}
	logger.Info("connected to postgres")

	// Run migrations. seedDev=true injects the fixed dev tenant + admin account
	// so `make dev` works without manual bootstrapping. In prod (LANTERN_ENV set)
	// we skip those rows — a static-password seed is a backdoor.
	seedDev := !handlers.IsProd()
	if seedDev {
		logger.Info("dev mode: seeding dev tenant + admin user (set LANTERN_ENV=prod to disable)")
	} else {
		logger.Info("prod mode: skipping dev seed — provision an admin account manually")
	}
	if err := db.Migrate(ctx, pool, seedDev); err != nil {
		logger.Fatal("failed to run migrations", zap.Error(err))
	}
	logger.Info("migrations complete")

	// Seed the Concierge loop agent for the dev tenant (idempotent, no-op in prod
	// because the dev tenant row doesn't exist there).
	if seedDev {
		handlers.SeedLoopAgents(ctx, pool, logger)
	}

	// --- Redis ---
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Fatal("failed to parse REDIS_URL", zap.Error(err))
	}
	redisOpts.PoolSize = envIntMain("LANTERN_REDIS_POOL_SIZE", 20)
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close() //nolint:errcheck

	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Fatal("failed to ping redis", zap.Error(err))
	}
	logger.Info("connected to redis")

	// --- RLS app pool (dual-pool, flag-gated, default no-op) ---
	//
	// When LANTERN_RLS_ENFORCE=1 AND LANTERN_APP_DB_PASSWORD is set, create a
	// second pool that connects as 'lantern_app' (non-superuser, subject to RLS
	// policies on 'agents' and 'runs'). Otherwise appPool aliases the privileged
	// pool — zero behaviour change with no env vars set.
	//
	// The privileged pool (pool) remains the sole connection for:
	//   - migrations (Migrate() must run as the schema owner)
	//   - recovery sweeps (findOrphanedRuns — must bypass RLS)
	//   - marketplace cross-tenant queries
	//   - janitor goroutines
	//
	// Operator cutover steps (when ready to enforce RLS on all handler paths):
	//   1. CREATE ROLE lantern_app LOGIN (done by Migrate).
	//   2. ALTER ROLE lantern_app PASSWORD '<strong>';
	//   3. Set LANTERN_APP_DB_PASSWORD=<strong> + LANTERN_RLS_ENFORCE=1.
	//   4. Route remaining handler paths through srv.AppPool + db.WithTenantConn.
	//      Add // TODO(rls-cutover) comments on each site still using Pool directly.
	appPool := pool // alias — superuser path, RLS bypassed
	if os.Getenv("LANTERN_RLS_ENFORCE") == "1" {
		appPwd := os.Getenv("LANTERN_APP_DB_PASSWORD")
		if appPwd != "" {
			appCfg, cfgErr := buildAppPoolConfig(cfg.DatabaseURL, appPwd)
			if cfgErr != nil {
				logger.Fatal("failed to build lantern_app pool config", zap.Error(cfgErr))
			}
			applyPgxPoolTuning(appCfg)
			p, err := pgxpool.NewWithConfig(ctx, appCfg)
			if err != nil {
				logger.Fatal("failed to create lantern_app pool", zap.Error(err))
			}
			if err := p.Ping(ctx); err != nil {
				logger.Fatal("failed to ping lantern_app pool", zap.Error(err))
			}
			appPool = p
			defer p.Close()
			logger.Info("RLS enforcement active — AppPool connects as lantern_app")
		} else {
			logger.Warn("LANTERN_RLS_ENFORCE=1 but LANTERN_APP_DB_PASSWORD is unset — AppPool aliased to privileged pool; RLS not enforced at runtime")
		}
	}

	// --- Server struct ---
	srv := &server.Server{
		Pool:     pool,
		AppPool:  appPool,
		Redis:    rdb,
		Logger:   logger,
		S3Bucket: cfg.S3Bucket,
	}

	// --- gRPC server ---
	// Audit H2: the gateway→control-plane channel must be encryptable. Load
	// server-side TLS credentials when configured; in prod require them, in dev
	// fall back to plaintext with a WARN (mirrors runStartupGuards' fail-closed
	// pattern).
	// Service-token auth must run BEFORE tenant extraction: only callers holding
	// the shared token may set a tenant_id. Empty token → pass-through (dev);
	// runStartupGuards already refused to boot with an empty token in prod.
	grpcServiceToken := os.Getenv("LANTERN_GRPC_SERVICE_TOKEN")
	grpcOpts := []grpc.ServerOption{
		grpc.ChainUnaryInterceptor(
			middleware.UnaryServiceAuthInterceptor(logger, grpcServiceToken),
			middleware.UnaryTenantInterceptor(logger),
			unaryTracingInterceptor(),
		),
		grpc.ChainStreamInterceptor(
			middleware.StreamServiceAuthInterceptor(logger, grpcServiceToken),
			middleware.StreamTenantInterceptor(logger),
			streamTracingInterceptor(),
		),
	}
	if creds := grpcTLSCreds(logger); creds != nil {
		grpcOpts = append(grpcOpts, grpc.Creds(creds))
	}
	grpcServer := grpc.NewServer(grpcOpts...)

	// Register services.
	agentSvc := handlers.NewAgentService(srv)
	runSvc := handlers.NewRunService(srv)
	lanternv1.RegisterAgentServiceServer(grpcServer, agentSvc)
	lanternv1.RegisterRunServiceServer(grpcServer, runSvc)

	// DataPlaneService — authenticated tunnel for customer-VPC data-plane agents.
	// Registered on the same :50051 gRPC listener; agents dial out to it.
	dpSvc := handlers.NewDataPlaneService(srv, []byte(handlers.GetJWTSecret()))
	lanternv1.RegisterDataPlaneServiceServer(grpcServer, dpSvc)

	// Health check.
	healthSvc := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthSvc)
	healthSvc.SetServingStatus("lantern.v1.AgentService", healthpb.HealthCheckResponse_SERVING)
	healthSvc.SetServingStatus("lantern.v1.RunService", healthpb.HealthCheckResponse_SERVING)
	healthSvc.SetServingStatus("lantern.v1.DataPlaneService", healthpb.HealthCheckResponse_SERVING)

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

	// SAFETY: warn loudly when LANTERN_USE_CLAUDE_CODE is set. The local CLI
	// is excluded from all user-facing paths (bridge replies, SMS, voice,
	// sessions) unconditionally. It can only serve the developer-dashboard
	// "Generate spec/code" path (Complete with empty AgentName). If you see
	// this in prod logs, remove LANTERN_USE_CLAUDE_CODE from the deployment.
	if os.Getenv("LANTERN_USE_CLAUDE_CODE") == "1" {
		logger.Warn("LANTERN_USE_CLAUDE_CODE=1 is set — claude-code is enabled for dev-only dashboard paths; it is EXCLUDED from all user-facing reply paths (bridge contacts, SMS, voice, sessions)")
	}

	// --- Domain-specific handlers ---
	connectorHandler := handlers.NewConnectorHandler(srv, authHandler)
	connectorExecutor := handlers.NewConnectorExecutor(srv, authHandler)
	llmProxyHandler := handlers.NewLlmProxyHandler(srv, authHandler)
	smsHandler := handlers.NewSMSHandler(logger, srv.Pool, llmProxyHandler)
	messagingHandler := handlers.NewMessagingHandler(logger, srv.Pool, llmProxyHandler)
	surfaceHandler := handlers.NewSurfaceHandler(srv, authHandler)
	signalHandler := handlers.NewSignalHandler(srv)
	waPersonalHandler := handlers.NewWhatsAppPersonalHandler(srv, authHandler)
	identityHandler := handlers.NewIdentityHandler(srv, authHandler, llmProxyHandler)
	jarvisHandler := handlers.NewJarvisHandler(srv, authHandler, llmProxyHandler)
	shortcutsHandler := handlers.NewShortcutsHandler(srv, authHandler)
	apiKeyHandler := handlers.NewApiKeyHandler(srv, authHandler)
	deploymentHandler := handlers.NewDeploymentHandler(srv, authHandler)
	a2aHandler := handlers.NewA2AHandler(srv, authHandler)
	gmailHandler := handlers.NewGmailHandler(srv, authHandler)
	sessionHandler := handlers.NewSessionHandler(srv, authHandler, llmProxyHandler)
	lifeEventHandler := handlers.NewLifeEventHandler(srv, authHandler)
	commitmentHandler := handlers.NewCommitmentHandler(srv, authHandler)
	commitmentHandler.SetLlmProxy(llmProxyHandler) // enables ResearchCommitment
	crossAppHandler := handlers.NewCrossAppHandler(srv, authHandler)
	crossAppHandler.SetLlmProxy(llmProxyHandler) // enables cross-app LLM composition
	domainRecordHandler := handlers.NewDomainRecordHandler(srv, authHandler)
	loopAgentHandler := handlers.NewLoopAgentHandler(srv, authHandler, llmProxyHandler)
	restHandler.SetLlmProxy(llmProxyHandler) // enables inline run execution
	restHandler.SetDataPlaneRouter(dpSvc)    // routes runs to a connected data plane when one is live

	// Futuristic surface: cost forecasting, policy budgets, marketplace,
	// MCP registry, eval-in-CI, A/B experiments.
	usageHandler := handlers.NewUsageHandler(srv, authHandler)
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
	// One-time-code exchange: the OAuth callback redirects with ?code=… (not
	// the JWT in the URL); the dashboard POSTs the code here to get the token.
	httpMux.HandleFunc("POST /auth/oauth/exchange", authHandler.OAuthExchange)

	// REST API endpoints (direct, no gateway needed).
	httpMux.HandleFunc("GET /v1/agents", restHandler.ListAgents)
	httpMux.HandleFunc("POST /v1/agents", restHandler.CreateAgent)
	httpMux.HandleFunc("GET /v1/agents/{name}", restHandler.GetAgent)
	httpMux.HandleFunc("PATCH /v1/agents/{name}", restHandler.UpdateAgent)
	httpMux.HandleFunc("DELETE /v1/agents/{name}", restHandler.DeleteAgent)
	httpMux.HandleFunc("GET /v1/runs", restHandler.ListRuns)
	httpMux.HandleFunc("POST /v1/runs", restHandler.CreateRun)
	httpMux.HandleFunc("GET /v1/runs/{id}", restHandler.GetRun)
	httpMux.HandleFunc("GET /v1/runs/{id}/events", restHandler.GetRunEvents)
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
	// Twilio webhooks — owner's private agent channel. NO auth
	// middleware (Twilio HMAC verification is done inside the handler).
	httpMux.HandleFunc("POST /v1/sms/twilio/webhook", smsHandler.SMSWebhook)
	httpMux.HandleFunc("POST /v1/messaging/twilio/inbound", messagingHandler.InboundWebhook)
	httpMux.HandleFunc("POST /v1/voice/twilio/webhook", smsHandler.VoiceWebhook)
	httpMux.HandleFunc("POST /v1/voice/twilio/turn", smsHandler.VoiceTurn)
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

	// Personal device signals — iPhone Shortcuts POST app-context here
	// THROUGH the cloudflared tunnel (API :8080, not dashboard :3001). NO
	// JWT/tenant scope; gated by the LANTERN_SIGNAL_TOKEN shared secret
	// (fail-closed when unset), mirroring the bridge-heartbeat pattern.
	httpMux.HandleFunc("POST /v1/signals", signalHandler.IngestSignal)
	httpMux.HandleFunc("GET /v1/signals", signalHandler.ListSignals)

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

	// Identity graph + unified cross-channel timeline (Jarvis memory).
	httpMux.HandleFunc("POST /v1/people/resolve", identityHandler.ResolvePerson)
	// /merge and /duplicates are registered before the bare GET /v1/people so
	// the more-specific paths are not shadowed by a wildcard.
	httpMux.HandleFunc("POST /v1/people/merge", identityHandler.MergePeople)
	httpMux.HandleFunc("GET /v1/people/duplicates", identityHandler.ListDuplicates)
	httpMux.HandleFunc("POST /v1/people/relationship", identityHandler.StampRelationship)
	httpMux.HandleFunc("GET /v1/people", identityHandler.ListPeople)
	httpMux.HandleFunc("POST /v1/memory/events", identityHandler.IngestEvent)
	httpMux.HandleFunc("GET /v1/memory/context", identityHandler.GetContext)

	// Proactive Jarvis — daily brief from the unified timeline.
	httpMux.HandleFunc("GET /v1/jarvis/brief", jarvisHandler.Brief)

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
	httpMux.HandleFunc("POST /v1/audio/transcriptions", llmProxyHandler.Transcribe)
	// Streaming no-tools completion for the bridges' "first-sentence-fast"
	// path. text/event-stream with per-token `data:` chunks + final
	// `data: [DONE]`. No tool-call loop — tool-using queries should go
	// through /v1/sessions/{id}/messages (full agentic pipeline).
	httpMux.HandleFunc("POST /v1/jarvis/stream-completion", llmProxyHandler.HandleStreamCompletion)
	// Outbound TTS — OpenAI tts-1. Returns raw audio bytes (mp3 by
	// default). Used by the bridges' voice-out path when the owner
	// opts in via LANTERN_VOICE_OUT=on.
	httpMux.HandleFunc("POST /v1/voice/tts", llmProxyHandler.HandleTTS)

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

	// Life-event engine (bridges' "Automations" feed + per-category trust toggles).
	httpMux.HandleFunc("POST /v1/life-events", lifeEventHandler.CreateLifeEvent)
	httpMux.HandleFunc("GET /v1/life-events", lifeEventHandler.ListLifeEvents)
	httpMux.HandleFunc("GET /v1/life-events/prefs", lifeEventHandler.ListLifeEventPrefs)
	httpMux.HandleFunc("PUT /v1/life-events/prefs", lifeEventHandler.UpsertLifeEventPref)
	httpMux.HandleFunc("POST /v1/life-events/{id}/undo", lifeEventHandler.UndoLifeEvent)
	httpMux.HandleFunc("POST /v1/life-events/{id}/dismiss", lifeEventHandler.DismissLifeEvent)

	// Concierge agent commitment tracker.
	httpMux.HandleFunc("POST /v1/commitments", commitmentHandler.CreateCommitment)
	httpMux.HandleFunc("GET /v1/commitments", commitmentHandler.ListCommitments)
	httpMux.HandleFunc("GET /v1/commitments/{id}", commitmentHandler.GetCommitment)
	httpMux.HandleFunc("PUT /v1/commitments/{id}", commitmentHandler.UpdateCommitment)
	httpMux.HandleFunc("POST /v1/commitments/{id}/snooze", commitmentHandler.SnoozeCommitment)
	httpMux.HandleFunc("POST /v1/commitments/{id}/done", commitmentHandler.DoneCommitment)
	httpMux.HandleFunc("POST /v1/commitments/{id}/dismiss", commitmentHandler.DismissCommitment)
	// Stage 2: LLM-powered research + cited action plan.
	httpMux.HandleFunc("POST /v1/commitments/{id}/research", commitmentHandler.ResearchCommitment)
	// Cross-app workflows (LANTERN_CROSS_APP=on, default OFF).
	// Propose: autonomous read + LLM compose → stored proposal (no side-effect).
	// Execute-action: SOLE side-effect path; requires explicit owner confirm.
	httpMux.HandleFunc("POST /v1/cross-app/propose", crossAppHandler.Propose)
	httpMux.HandleFunc("POST /v1/commitments/{id}/execute-action", crossAppHandler.ExecuteAction)

	// Domain-tracker agents: encrypted PII store for health / vehicle / career records.
	httpMux.HandleFunc("POST /v1/domain-records", domainRecordHandler.CreateDomainRecord)
	httpMux.HandleFunc("GET /v1/domain-records", domainRecordHandler.ListDomainRecords)
	httpMux.HandleFunc("PUT /v1/domain-records/{id}", domainRecordHandler.UpdateDomainRecord)
	httpMux.HandleFunc("DELETE /v1/domain-records/{id}", domainRecordHandler.DeleteDomainRecord)

	// Loop-agent platform primitive (Stage 3).
	// Must be registered before the generic /v1/agents/{name} patterns to avoid shadowing.
	httpMux.HandleFunc("POST /v1/agents/loop", loopAgentHandler.CreateLoopAgent)

	// Pre-run cost forecaster.
	httpMux.HandleFunc("POST /v1/runs/forecast", forecastHandler.Forecast)

	// Accurate spend + run-health aggregation (agent_usage_daily + runs).
	httpMux.HandleFunc("GET /v1/usage", usageHandler.GetUsage)

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
	httpMux.HandleFunc("POST /v1/voice/calls/status/{provider}", voiceHandler.CallStatus)
	httpMux.HandleFunc("POST /v1/voice/token", voiceHandler.MintToken)
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

	// Agent-instance identity public-key discovery. No auth (public endpoint).
	// Ed25519 mode: returns {algorithm, publicKey, keyFingerprint}.
	// HS256 mode (default): returns {algorithm:"HS256"} only — no secret emitted.
	httpMux.HandleFunc("GET /.well-known/lantern-agent-identity", handlers.AgentIdentityWellKnown)

	// Log the active agent-identity signing mode once at startup.
	{
		alg, fp := agentidentity.StartupInfo()
		if fp != "" {
			logger.Info("agent-identity: Ed25519 signing active",
				zap.String("algorithm", alg),
				zap.String("pubKeyFingerprint", fp),
			)
		} else {
			logger.Warn("agent-identity: Ed25519 key not configured — using HS256 fallback",
				zap.String("algorithm", alg),
				zap.String("env", "LANTERN_AGENT_IDENTITY_ED25519_SEED"),
			)
		}
	}

	// RLHF feedback loop — per-run thumbs + preferred-output capture.
	httpMux.HandleFunc("POST /v1/runs/{id}/feedback", feedbackHandler.SubmitFeedback)
	httpMux.HandleFunc("GET /v1/runs/{id}/feedback", feedbackHandler.ListFeedback)
	httpMux.HandleFunc("GET /v1/agents/{name}/feedback", feedbackHandler.AgentSummary)

	// Rehearsals — replay past failures against a candidate agent version.
	httpMux.HandleFunc("POST /v1/runs/rehearse", rehearseHandler.Rehearse)

	// GDPR right-to-erasure: owner deletes their own tenant + all its data.
	gdprHandler := handlers.NewGDPRHandler(srv, authHandler)
	httpMux.HandleFunc("DELETE /v1/tenants/{id}", gdprHandler.DeleteTenant)

	// Errand-runner v1: owner-confirmed outbound AI calls (FCC/TCPA compliant).
	// Gated by LANTERN_ERRAND=1/true/on; all endpoints 404 when off (default).
	// confirm-and-call is the SOLE dial path and requires owner/admin role.
	errandHandler := handlers.NewErrandHandler(srv, authHandler, llmProxyHandler)
	httpMux.HandleFunc("POST /v1/errands", errandHandler.Propose)
	httpMux.HandleFunc("GET /v1/errands", errandHandler.List)
	httpMux.HandleFunc("POST /v1/errands/{id}/confirm-and-call", errandHandler.ConfirmAndCall)
	httpMux.HandleFunc("POST /v1/errands/{id}/opt-out", errandHandler.OptOut)
	// ErrandTurn: Twilio <Gather> callback — unauthenticated by JWT,
	// authenticated by X-Twilio-Signature (see ErrandTurn handler).
	httpMux.HandleFunc("POST /v1/voice/errand/turn/{id}", errandHandler.ErrandTurn)

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
	httpMux.HandleFunc("GET /v1/runtime/metrics", runtimeHandler.LiveMetrics)
	// Secret relay — service-to-service endpoint for the runtime-manager to
	// resolve lantern.secret/... refs. Fail-closed when
	// LANTERN_RUNTIME_SECRET_TOKEN is unset (see ADR 0008).
	runtimeSecretsHandler := handlers.NewRuntimeSecretsHandler(srv, authHandler)
	httpMux.HandleFunc("POST /v1/runtime/secrets/resolve", runtimeSecretsHandler.ResolveSecrets)
	// Report ingestion — runtime-manager forwards harness telemetry here.
	// Auth: same shared token as the secret relay (fail-closed when unset).
	runtimeReportHandler := handlers.NewRuntimeReportHandler(srv)
	httpMux.HandleFunc("POST /v1/runtime/report", runtimeReportHandler.Report)
	// Wire the prometheus metrics store so LiveMetrics can surface per-VM counters.
	runtimeHandler.SetMetricsStore(runtimeReportHandler)
	// runtime_vm_logs retention: delete rows older than LANTERN_RUNTIME_LOG_RETENTION_DAYS
	// (default 14) once per hour. Stops cleanly when ctx is cancelled.
	go runtimeReportHandler.RunLogRetentionJanitor(ctx)

	// side_effect_receipts retention: delete rows older than
	// LANTERN_SIDE_EFFECT_RETENTION_DAYS (default 30) once per hour.
	go handlers.RunSideEffectReceiptsJanitor(ctx, pool, logger)

	// High-growth table retention: journal_events (90d), runtime_audit_events
	// (365d), agent_usage_daily (400d). Env-configurable; see retention_janitor.go.
	go handlers.RunRetentionJanitor(ctx, pool, logger)

	// Wrap the whole mux in otelhttp so EVERY HTTP request gets a server span
	// (invariant #9). The span name is a low-cardinality route template
	// ("GET /v1/runs/{id}") rather than the raw path, so traces group by route.
	// Tenant/user/run identifiers are attached as span attributes inside the
	// handlers (RESTHandler.contextWithTenant → middleware.EnrichSpan), where
	// the JWT has already been validated — we never re-parse it here.
	//
	// Safe when telemetry is disabled: with the no-op global TracerProvider,
	// otelhttp creates non-recording spans and adds negligible overhead.
	tracedHTTP := otelhttp.NewHandler(
		handlers.CORSMiddleware(httpMux),
		"lantern.control-plane.http",
		otelhttp.WithSpanNameFormatter(httpSpanName),
	)
	httpServer := &http.Server{
		Addr:              ":8080",
		Handler:           tracedHTTP,
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

	// Periodic crash-recovery watchdog: re-drives orphaned runs every
	// LANTERN_RECOVERY_INTERVAL (default 30s). Non-blocking; first sweep
	// fires 2s after the HTTP server starts so /readyz serves first.
	handlers.RunRecoveryLoop(ctx, restHandler, logger, 0)

	// Per-tenant spawn rate limiter (Phase-3 resiliency): throttles a burst of
	// run-creations / runtime-schedules per tenant, returning HTTP 429 before any
	// work side-effect. Redis-backed when available (distributed); falls back to
	// per-replica in-memory token-bucket on Redis unavailability.
	spawnLimiter := handlers.NewSpawnRateLimiter()
	spawnLimiter.SetRedis(rdb)
	defer spawnLimiter.Stop()
	restHandler.SetSpawnLimiter(spawnLimiter)
	runtimeHandler.SetSpawnLimiter(spawnLimiter)

	// Gmail + Calendar → unified timeline ingestion (Phase 2c).
	go handlers.NewMemoryIngestor(pool, logger, identityHandler).Run(ctx)

	// Proactive Jarvis morning brief (opt-in via LANTERN_JARVIS_BRIEF_HOUR).
	go jarvisHandler.RunBriefScheduler(ctx)

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
	healthSvc.SetServingStatus("lantern.v1.DataPlaneService", healthpb.HealthCheckResponse_NOT_SERVING)

	grpcServer.GracefulStop()
	logger.Info("gRPC server stopped")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}
	logger.Info("HTTP server stopped")

	// Drain in-flight inline runs (SIGTERM graceful drain).
	// The durable-replay recovery loop covers any runs that exceed the timeout.
	drainTimeout := envDurationMain("LANTERN_DRAIN_TIMEOUT", 30*time.Second)
	logger.Info("draining in-flight runs", zap.Duration("timeout", drainTimeout))
	restHandler.DrainInFlightRuns(drainTimeout)
	logger.Info("in-flight runs drained")

	logger.Info("control-plane shut down cleanly")
}

// rlsGuardDecision evaluates whether the RLS enforcement env vars are correctly
// configured for a production environment.
//
// It returns (fatal bool, message string). When fatal is true, main.go should
// call logger.Fatal with message; the caller decides — this keeps the function
// pure and testable without triggering os.Exit in tests.
//
// Rules:
//   - prod (LANTERN_ENV=prod/production/staging): FATAL when either
//     LANTERN_RLS_ENFORCE != "1" or LANTERN_APP_DB_PASSWORD is empty.
//     A prod server that does not connect as lantern_app could silently leak
//     data across tenants if a WHERE clause is forgotten.
//   - dev (LANTERN_ENV unset): optional; returns fatal=false with a warn
//     message so the caller can log a WARN and continue.
func rlsGuardDecision(isProd bool, rlsEnforce, appPwd string) (fatal bool, message string) {
	if isProd {
		if rlsEnforce != "1" {
			return true, "LANTERN_RLS_ENFORCE is not set to '1' — production refuses to start without RLS enforcement; set LANTERN_RLS_ENFORCE=1 and LANTERN_APP_DB_PASSWORD"
		}
		if appPwd == "" {
			return true, "LANTERN_APP_DB_PASSWORD is unset — production refuses to start without the lantern_app role password; set LANTERN_APP_DB_PASSWORD to enable RLS enforcement"
		}
		return false, ""
	}
	// Dev: advisory only.
	if rlsEnforce != "1" || appPwd == "" {
		return false, "LANTERN_RLS_ENFORCE is unset or LANTERN_APP_DB_PASSWORD is missing — RLS not enforced at runtime (acceptable in dev; required in production)"
	}
	return false, ""
}

// runStartupGuards enforces fail-closed security checks before the server
// starts accepting traffic.
//
// In production (LANTERN_ENV=prod/production/staging) any missing secret is
// fatal — we refuse to boot rather than silently operate insecurely.
// In dev (LANTERN_ENV unset) we WARN and continue so `make dev` still works
// out-of-the-box with no env configuration.
func runStartupGuards(logger *zap.Logger) {
	prod := handlers.IsProd()

	// C1 — JWT secret
	jwtSecret := handlers.GetJWTSecret()
	if jwtSecret == "" {
		// GetJWTSecret returns "" only when isProd() and the secret is
		// missing or is the well-known dev value.
		logger.Fatal("JWT_SECRET is unset or is the dev default — set a strong random secret via JWT_SECRET")
	}
	if !prod {
		// Dev warning already printed to stderr by GetJWTSecret(); nothing more needed.
		_ = jwtSecret
	}

	// H1 — Receipt signing secret
	receiptSecret := os.Getenv("LANTERN_RECEIPT_SECRET")
	if prod && receiptSecret == "" {
		logger.Fatal("LANTERN_RECEIPT_SECRET is unset — set a strong random secret to secure run receipts and marketplace invocation signatures")
	}
	if !prod && receiptSecret == "" {
		logger.Warn("LANTERN_RECEIPT_SECRET is unset — using insecure dev default; set LANTERN_RECEIPT_SECRET in production")
	}

	// Secrets (connector keys / LLM API keys at rest)
	encEnabled, encErr := secrets.EncryptionEnabled()
	if encErr != nil {
		// Malformed key — fatal in all environments.
		logger.Fatal("LANTERN_CREDENTIAL_KEY is malformed", zap.Error(encErr))
	}
	if prod && !encEnabled {
		logger.Fatal("LANTERN_CREDENTIAL_KEY is unset — connector tokens and LLM API keys would be stored in plaintext; set a 32-byte AES-256 key")
	}
	if !prod && !encEnabled {
		logger.Warn("LANTERN_CREDENTIAL_KEY is unset — connector credentials stored in plaintext (acceptable in dev, required in production)")
	}

	// G1 — RLS enforcement (multi-tenant isolation, invariant #7)
	// Production must connect as the non-superuser 'lantern_app' role so that
	// Postgres enforces the tenant_isolation_{agents,runs} RLS policies even if
	// a handler forgets a WHERE clause.  Dev is advisory-only so `make dev`
	// works without any DB role management.
	rlsFatal, rlsMsg := rlsGuardDecision(prod, os.Getenv("LANTERN_RLS_ENFORCE"), os.Getenv("LANTERN_APP_DB_PASSWORD"))
	if rlsFatal {
		logger.Fatal(rlsMsg)
	}
	if rlsMsg != "" {
		logger.Warn(rlsMsg)
	}

	// gRPC service-token auth (trust boundary on :50051).
	// Without a token, any caller reachable to :50051 can set an arbitrary
	// tenant_id and read/write that tenant's data. Production must require it.
	if prod && os.Getenv("LANTERN_GRPC_SERVICE_TOKEN") == "" {
		logger.Fatal("LANTERN_GRPC_SERVICE_TOKEN is unset — the control-plane gRPC port (:50051) would accept any caller-supplied tenant_id; set a strong random shared token (also set it on the gateway)")
	}
	if !prod && os.Getenv("LANTERN_GRPC_SERVICE_TOKEN") == "" {
		logger.Warn("LANTERN_GRPC_SERVICE_TOKEN is unset — control-plane gRPC accepts unauthenticated callers (acceptable in dev, required in production)")
	}

	// R1 — Runtime scheduler address (W12 microVM path).
	// In prod the stub fabricates VM IDs and spawns nothing — that is silent
	// data corruption, not a graceful degradation. Refuse to start.
	// In dev the stub is intentional (no real scheduler needed).
	schedulerFatal, schedulerMsg := handlers.CheckSchedulerAddr(prod, os.Getenv("LANTERN_SCHEDULER_GRPC_ADDR"))
	if schedulerFatal {
		logger.Fatal(schedulerMsg)
	}
	if !prod && os.Getenv("LANTERN_SCHEDULER_GRPC_ADDR") == "" {
		logger.Warn("LANTERN_SCHEDULER_GRPC_ADDR is unset — using stub scheduler (acceptable in dev, required in production)")
	}
}

// grpcTLSCreds resolves server-side TLS credentials for the gRPC server,
// applying the prod-vs-dev fail-closed policy (audit H2, gateway→control-plane).
//
//   - configured + valid → returns creds; the server serves over TLS.
//   - misconfigured (half-set or unloadable cert/key) → Fatal in all envs.
//   - unset in prod → Fatal: the gateway hop must be encryptable.
//   - unset in dev → WARN + returns nil: plaintext, so `make dev` still works.
func grpcTLSCreds(logger *zap.Logger) credentials.TransportCredentials {
	creds, err := handlers.GRPCServerTLS()
	if err != nil {
		logger.Fatal("control-plane gRPC TLS is misconfigured", zap.Error(err))
	}
	if creds != nil {
		logger.Info("control-plane gRPC server: TLS enabled (LANTERN_CONTROL_PLANE_TLS_CERT/KEY)")
		return creds
	}
	if handlers.IsProd() {
		logger.Fatal("control-plane gRPC TLS is unset — set LANTERN_CONTROL_PLANE_TLS_CERT and LANTERN_CONTROL_PLANE_TLS_KEY to encrypt the gateway→control-plane channel")
	}
	logger.Warn("control-plane gRPC server: TLS unset — serving plaintext (acceptable in dev, required in production)")
	return nil
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
//
// It runs AFTER UnaryTenantInterceptor in the chain, so tenant_id is already in
// the context; we stamp it (plus run_id/step_id when the caller supplies them in
// metadata) onto the span. This satisfies invariant #9: a gRPC span is filterable
// by tenant/run, not just method name.
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
		enrichGRPCSpan(ctx)
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
		enrichGRPCSpan(ctx)
		wrapped := &wrappedStream{ServerStream: ss, ctx: ctx}
		return handler(srv, wrapped)
	}
}

// httpSpanName produces a low-cardinality span name from the request so traces
// group by route rather than by concrete id. Path segments that look like ids
// (UUIDs, hex digests, long numeric/opaque tokens) are collapsed to "{id}":
//
//	GET /v1/runs/9f3c.../events  ->  "GET /v1/runs/{id}/events"
//
// The concrete run/step id is preserved as a span ATTRIBUTE by the handlers,
// not in the name, so cardinality stays bounded while traces remain filterable.
func httpSpanName(_ string, r *http.Request) string {
	return r.Method + " " + templatePath(r.URL.Path)
}

// templatePath replaces id-like path segments with "{id}".
func templatePath(p string) string {
	if p == "" || p == "/" {
		return p
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		if looksLikeID(s) {
			segs[i] = "{id}"
		}
	}
	return strings.Join(segs, "/")
}

// looksLikeID reports whether a path segment is a concrete identifier (UUID,
// hex digest, or a long opaque/numeric token) rather than a static route word.
func looksLikeID(s string) bool {
	if len(s) < 8 {
		return false
	}
	var digits, hyphens, hex, other int
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
			digits++
			hex++
		case (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'):
			hex++
		case c == '-':
			hyphens++
		default:
			other++
		}
	}
	// UUID-shaped (hex + hyphens, nothing else) or all-hex digest.
	if other == 0 && hex+hyphens == len(s) && (hyphens > 0 || hex == len(s)) {
		return true
	}
	// Long mostly-numeric token (e.g. snowflake-style ids).
	if other == 0 && digits >= 12 {
		return true
	}
	return false
}

// enrichGRPCSpan stamps tenant_id (from the tenant interceptor's context) and,
// when present in incoming metadata, run_id/step_id onto the active span. No-op
// safe when telemetry is disabled (EnrichSpan guards on span.IsRecording()).
func enrichGRPCSpan(ctx context.Context) {
	tenantID, _ := middleware.TenantIDFromContext(ctx)
	var runID, stepID string
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("run_id"); len(v) > 0 {
			runID = v[0]
		}
		if v := md.Get("step_id"); len(v) > 0 {
			stepID = v[0]
		}
	}
	// gRPC callers don't carry an end-user id; user_id stays empty here.
	middleware.EnrichSpan(ctx, tenantID, "", runID, stepID)
}

// wrappedStream overrides Context() to propagate the traced context.
type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
	return w.ctx
}

// parsePgxPoolConfig parses DATABASE_URL into a *pgxpool.Config and applies
// the env-driven tunables (LANTERN_PG_MAX_CONNS, LANTERN_PG_MAX_CONN_LIFETIME,
// LANTERN_PG_MAX_CONN_IDLE_TIME). Sane defaults:
//
//	LANTERN_PG_MAX_CONNS           default 20
//	LANTERN_PG_MAX_CONN_LIFETIME   default 1h
//	LANTERN_PG_MAX_CONN_IDLE_TIME  default 30m
func parsePgxPoolConfig(databaseURL string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	applyPgxPoolTuning(cfg)
	return cfg, nil
}

// applyPgxPoolTuning writes the env-driven tunables onto an already-parsed
// *pgxpool.Config. Called for both the privileged pool and the AppPool so
// both benefit from the same env configuration.
func applyPgxPoolTuning(cfg *pgxpool.Config) {
	cfg.MaxConns = int32(envIntMain("LANTERN_PG_MAX_CONNS", 20))
	cfg.MaxConnLifetime = envDurationMain("LANTERN_PG_MAX_CONN_LIFETIME", time.Hour)
	cfg.MaxConnIdleTime = envDurationMain("LANTERN_PG_MAX_CONN_IDLE_TIME", 30*time.Minute)
}

// envIntMain reads an integer env var, falling back to fallback when absent or
// non-positive. Named with the Main suffix to avoid collision with the
// envIntOrDefault helper in spawn_ratelimit.go (different package).
func envIntMain(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

// envDurationMain reads a time.Duration env var (e.g. "1h30m"), falling back
// to fallback when absent or unparseable.
func envDurationMain(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return fallback
}

// buildAppPoolConfig returns a *pgxpool.Config for the 'lantern_app' non-superuser
// role by parsing DATABASE_URL and mutating ONLY the user and password on the
// parsed config — no string re-serialization. This preserves every other DSN
// parameter (sslmode incl. verify-full, search_path, connect_timeout, multi-host,
// application_name, …) exactly as the privileged pool has them, and is immune to
// URL-reserved characters in the password (no manual percent-encoding needed).
// The password is never logged; the config is used in-process only.
func buildAppPoolConfig(databaseURL, appPassword string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL for app pool: %w", err)
	}
	cfg.ConnConfig.User = "lantern_app"
	cfg.ConnConfig.Password = appPassword
	return cfg, nil
}
