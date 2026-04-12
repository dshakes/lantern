package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/dshakes/lantern/services/data-plane-agent/internal/dispatcher"
	"github.com/dshakes/lantern/services/data-plane-agent/internal/reporter"
	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

func main() {
	cfg := loadConfig()

	logger := mustInitLogger(cfg.LogLevel)
	defer logger.Sync() //nolint:errcheck

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	logger.Info("starting data-plane-agent",
		zap.String("control_plane_endpoint", cfg.ControlPlaneEndpoint),
		zap.String("tenant_id", cfg.TenantID),
	)

	// --- Reporter: sends status updates and metrics back to the control plane ---
	rep := reporter.New(logger)

	// --- Dispatcher: receives run assignments and dispatches to the local workflow engine ---
	disp := dispatcher.New(cfg.WorkflowEngineAddr, cfg.RuntimeManagerAddr, logger)

	// --- Tunnel: maintains the gRPC connection to the control plane ---
	tunnelCfg := tunnel.Config{
		ControlPlaneEndpoint:  cfg.ControlPlaneEndpoint,
		TenantID:              cfg.TenantID,
		AgentToken:            cfg.AgentToken,
		HeartbeatInterval:     time.Duration(cfg.HeartbeatIntervalSec) * time.Second,
		ReconnectInitialDelay: time.Duration(cfg.ReconnectInitialDelayMs) * time.Millisecond,
		ReconnectMaxDelay:     time.Duration(cfg.ReconnectMaxDelayMs) * time.Millisecond,
		ReconnectJitterPct:    cfg.ReconnectJitterPct,
		TLSInsecureSkipVerify: cfg.TLSInsecureSkipVerify,
	}

	tun := tunnel.New(tunnelCfg, disp, rep, logger)

	// Start the tunnel in the background.
	tunnelErrCh := make(chan error, 1)
	go func() {
		tunnelErrCh <- tun.Run(ctx)
	}()

	// --- HTTP health/status server ---
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	httpMux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !tun.IsConnected() {
			http.Error(w, "not connected to control plane", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	httpMux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		status := tun.Status()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"connected":%t,"plane_id":%q,"tenant_id":%q,"uptime_seconds":%d,"active_runs":%d,"last_heartbeat":%q}`,
			status.Connected,
			status.PlaneID,
			status.TenantID,
			int(status.Uptime.Seconds()),
			status.ActiveRuns,
			status.LastHeartbeat.Format(time.RFC3339),
		)
		fmt.Fprintln(w)
	})

	httpServer := &http.Server{
		Addr:              ":8090",
		Handler:           httpMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	httpErrCh := make(chan error, 1)
	go func() {
		logger.Info("HTTP status server starting", zap.String("addr", ":8090"))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			httpErrCh <- err
		}
		close(httpErrCh)
	}()

	// --- Wait for shutdown ---
	select {
	case <-ctx.Done():
		logger.Info("received shutdown signal")
	case err := <-tunnelErrCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			logger.Fatal("tunnel failed", zap.Error(err))
		}
	case err := <-httpErrCh:
		logger.Fatal("HTTP server failed", zap.Error(err))
	}

	// Graceful shutdown.
	tun.Shutdown()
	logger.Info("tunnel stopped")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}
	logger.Info("HTTP server stopped")

	logger.Info("data-plane-agent shut down cleanly")
}

// config holds values read from environment variables.
type config struct {
	ControlPlaneEndpoint  string
	TenantID              string
	AgentToken            string
	WorkflowEngineAddr    string
	RuntimeManagerAddr    string
	LogLevel              string
	HeartbeatIntervalSec  int
	ReconnectInitialDelayMs int
	ReconnectMaxDelayMs     int
	ReconnectJitterPct      int
	TLSInsecureSkipVerify   bool
}

func loadConfig() config {
	return config{
		ControlPlaneEndpoint:    envOrDefault("CONTROL_PLANE_ENDPOINT", "https://api.lantern.run"),
		TenantID:                envOrDefault("TENANT_ID", ""),
		AgentToken:              envOrDefault("AGENT_TOKEN", ""),
		WorkflowEngineAddr:      envOrDefault("WORKFLOW_ENGINE_ADDR", "localhost:50052"),
		RuntimeManagerAddr:      envOrDefault("RUNTIME_MANAGER_ADDR", "localhost:50054"),
		LogLevel:                envOrDefault("LOG_LEVEL", "info"),
		HeartbeatIntervalSec:    envOrDefaultInt("HEARTBEAT_INTERVAL_SECONDS", 30),
		ReconnectInitialDelayMs: envOrDefaultInt("RECONNECT_INITIAL_DELAY_MS", 1000),
		ReconnectMaxDelayMs:     envOrDefaultInt("RECONNECT_MAX_DELAY_MS", 60000),
		ReconnectJitterPct:      envOrDefaultInt("RECONNECT_JITTER_PERCENT", 20),
		TLSInsecureSkipVerify:   envOrDefault("TLS_INSECURE_SKIP_VERIFY", "false") == "true",
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrDefaultInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return fallback
	}
	return n
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
