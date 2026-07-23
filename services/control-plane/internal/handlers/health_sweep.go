package handlers

// health_sweep.go — periodic TCP reachability probe for peer services.
//
// A background loop dials each configured peer service on a ticker. On the
// first state TRANSITION (up→down or down→up) it texts the owner via the
// same sendSelfNote helper the loop agents use, and logs at Warn/Info.
// Only one alert fires per service per transition — no storms.
//
// Configured services (only probed when the address env var is set):
//
//   - model-router:       LANTERN_MODEL_ROUTER_ADDR (default model-router:50053)
//     Probed only when LANTERN_USE_MODEL_ROUTER=1/true/on OR the addr env
//     is explicitly set to a non-default value.
//   - runtime-scheduler:  LANTERN_SCHEDULER_GRPC_ADDR
//   - runtime-manager:    LANTERN_DEFAULT_MANAGER_ADDR
//   - workflow-engine:    LANTERN_WORKFLOW_ENGINE_ADDR (optional)
//
// LANTERN_WORKFLOW_ENGINE_ADDR: gRPC address of the workflow-engine service
// (default: workflow-engine:50052). The control-plane does not dial the
// engine yet (grpc client not wired); set this env var to opt into TCP
// reachability monitoring before that cutover.
//
// Interval: LANTERN_HEALTH_SWEEP_INTERVAL (Go duration string, e.g. "90s").
// Default 60s. Set to "0" or "off" to disable entirely.
//
// GET /v1/system/health (JWT-authed): read-only snapshot for the dashboard.
// Response shape:
//
//	{
//	  "services": [
//	    {
//	      "name": "runtime-manager",
//	      "addr": "localhost:50054",
//	      "up": false,
//	      "consecutiveFailures": 5,
//	      "lastChecked": "2026-07-23T10:00:00Z",
//	      "lastTransition": "2026-07-23T09:57:00Z"
//	    }
//	  ]
//	}

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// downThreshold is the number of consecutive failed probes before a service
// is declared DOWN and the owner is alerted.
const downThreshold = 3

// healthSweepOwnerTenantID is the tenant that receives health-sweep alerts.
// Background sweeps run without a request JWT, so we use the fixed dev/owner
// tenant (identical to devTenantID in loop_agent.go and the CLAUDE.md dev seed).
// In a multi-tenant managed-cloud deployment a separate config knob would be
// appropriate; for the personal-assistant single-owner use case this is correct.
const healthSweepOwnerTenantID = "00000000-0000-0000-0000-000000000001"

// probeTracker is the pure, non-goroutine-safe state machine for one service.
// The caller's mutex serialises all access.
//
// Start state: declaredUp=true (assumed up) so the first N consecutive
// failures produce a "down" transition — identical UX to a service that was
// running before the sweep started.
type probeTracker struct {
	declaredUp          bool
	consecutiveFailures int
	lastChecked         time.Time
	lastTransition      time.Time
}

// newProbeTracker returns a tracker starting in the "assumed up" state.
func newProbeTracker() probeTracker {
	return probeTracker{declaredUp: true}
}

// observe records one probe result and returns the transition that occurred:
//
//	"down" — service just crossed the down threshold (send alert).
//	"up"   — service recovered after being declared down (send alert).
//	""     — no state change (no alert needed).
func (t *probeTracker) observe(ok bool) string {
	t.lastChecked = time.Now()
	if ok {
		t.consecutiveFailures = 0
		if !t.declaredUp {
			// Recovery: was declared down, first success → UP transition.
			t.declaredUp = true
			t.lastTransition = t.lastChecked
			return "up"
		}
		return ""
	}
	// Probe failed.
	t.consecutiveFailures++
	if t.declaredUp && t.consecutiveFailures >= downThreshold {
		// Crossed the threshold: declare down.
		t.declaredUp = false
		t.lastTransition = t.lastChecked
		return "down"
	}
	return ""
}

// ServiceHealth is the per-service data returned by the REST snapshot.
type ServiceHealth struct {
	Name                string    `json:"name"`
	Addr                string    `json:"addr"`
	Up                  bool      `json:"up"`
	ConsecutiveFailures int       `json:"consecutiveFailures"`
	LastChecked         time.Time `json:"lastChecked"`
	LastTransition      time.Time `json:"lastTransition"`
}

// serviceEntry pairs a name + address with its probe state.
type serviceEntry struct {
	name    string
	addr    string
	tracker probeTracker
}

// HealthSweeper runs periodic TCP probes against configured peer services
// and exposes the results for the REST endpoint and owner alerts.
type HealthSweeper struct {
	mu       sync.Mutex
	services []serviceEntry
	logger   *zap.Logger
	auth     *AuthHandler // nil-safe; required for the HTTP endpoint JWT check
}

// NewHealthSweeper builds a sweeper from the current environment.
// Only services whose controlling env var is set are included in the probe list.
// Pass logger=nil only in unit tests that exercise probeTracker in isolation.
func NewHealthSweeper(logger *zap.Logger, auth *AuthHandler) *HealthSweeper {
	hs := &HealthSweeper{
		logger: logger,
		auth:   auth,
	}

	add := func(name, addr string) {
		if addr == "" {
			return
		}
		hs.services = append(hs.services, serviceEntry{
			name:    name,
			addr:    addr,
			tracker: newProbeTracker(),
		})
	}

	// model-router: probe when USE_MODEL_ROUTER is on OR the addr is
	// explicitly set (operator may want monitoring without the cutover active).
	mrAddr := strings.TrimSpace(os.Getenv("LANTERN_MODEL_ROUTER_ADDR"))
	mrOn := func() bool {
		v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_USE_MODEL_ROUTER")))
		return v == "1" || v == "true" || v == "on"
	}()
	if mrOn && mrAddr == "" {
		mrAddr = "model-router:50053"
	}
	add("model-router", mrAddr)

	add("runtime-scheduler", strings.TrimSpace(os.Getenv("LANTERN_SCHEDULER_GRPC_ADDR")))
	add("runtime-manager", strings.TrimSpace(os.Getenv("LANTERN_DEFAULT_MANAGER_ADDR")))
	add("workflow-engine", strings.TrimSpace(os.Getenv("LANTERN_WORKFLOW_ENGINE_ADDR")))

	return hs
}

// Snapshot returns the current health state for all probed services.
// The returned slice is a copy — callers may read it freely.
func (hs *HealthSweeper) Snapshot() []ServiceHealth {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	out := make([]ServiceHealth, len(hs.services))
	for i, s := range hs.services {
		out[i] = ServiceHealth{
			Name:                s.name,
			Addr:                s.addr,
			Up:                  s.tracker.declaredUp,
			ConsecutiveFailures: s.tracker.consecutiveFailures,
			LastChecked:         s.tracker.lastChecked,
			LastTransition:      s.tracker.lastTransition,
		}
	}
	return out
}

// ServeHealth handles GET /v1/system/health.
func (hs *HealthSweeper) ServeHealth(w http.ResponseWriter, r *http.Request) {
	if hs.auth != nil {
		if _, err := hs.auth.validateRequest(r); err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"services": hs.Snapshot(),
	})
}

// tick runs one probe pass over all services, updating state and sending
// transition alerts. It holds the mutex for the full pass so Snapshot()
// is never read mid-update.
func (hs *HealthSweeper) tick() {
	hs.mu.Lock()
	defer hs.mu.Unlock()

	for i := range hs.services {
		s := &hs.services[i]
		ok := tcpProbe(s.addr)
		transition := s.tracker.observe(ok)
		switch transition {
		case "down":
			msg := fmt.Sprintf("⚠️ lantern: %s DOWN (%s) — %d failed probes",
				s.name, s.addr, downThreshold)
			hs.logger.Warn("health sweep: service DOWN",
				zap.String("service", s.name),
				zap.String("addr", s.addr),
			)
			if err := sendSelfNote(healthSweepOwnerTenantID, msg); err != nil {
				hs.logger.Warn("health sweep: alert delivery failed",
					zap.String("service", s.name),
					zap.Error(err),
				)
			}
		case "up":
			msg := fmt.Sprintf("✅ lantern: %s back up (%s)", s.name, s.addr)
			hs.logger.Info("health sweep: service UP",
				zap.String("service", s.name),
				zap.String("addr", s.addr),
			)
			if err := sendSelfNote(healthSweepOwnerTenantID, msg); err != nil {
				hs.logger.Warn("health sweep: alert delivery failed",
					zap.String("service", s.name),
					zap.Error(err),
				)
			}
		}
	}
}

// RunHealthSweepLoop starts the health sweep goroutine, which runs until ctx
// is cancelled. Call it from main.go alongside RunRecoveryLoop.
//
// When interval <= 0, healthSweepInterval() is used to read the env var.
// When the resolved interval is 0 (env = "0" or "off"), the loop is disabled
// and this function returns immediately.
//
// The first probe fires immediately (before the first tick) so the REST
// endpoint has non-zero data right after startup.
func RunHealthSweepLoop(ctx context.Context, hs *HealthSweeper, interval time.Duration) {
	if hs == nil {
		return
	}
	if len(hs.services) == 0 {
		hs.logger.Info("health sweep: no peer services configured — loop skipped")
		return
	}
	if interval <= 0 {
		interval = healthSweepInterval()
	}
	if interval <= 0 {
		hs.logger.Info("health sweep: disabled (LANTERN_HEALTH_SWEEP_INTERVAL=0/off)")
		return
	}

	go func() {
		// Immediate first probe — fills the snapshot before the first HTTP request.
		hs.tick()

		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				hs.tick()
			}
		}
	}()
}

// healthSweepInterval reads LANTERN_HEALTH_SWEEP_INTERVAL.
// Returns 60s when unset.
// Returns 0 when "0" or "off" (caller should disable the loop).
func healthSweepInterval() time.Duration {
	v := strings.TrimSpace(os.Getenv("LANTERN_HEALTH_SWEEP_INTERVAL"))
	if v == "" {
		return 60 * time.Second
	}
	if v == "0" || strings.EqualFold(v, "off") {
		return 0
	}
	if d, err := time.ParseDuration(v); err == nil && d > 0 {
		return d
	}
	return 60 * time.Second
}

// tcpProbe dials addr with a 3-second timeout and reports whether a TCP
// connection was established. A successful connect proves "process is up
// and listening" without requiring the gRPC health-check protocol or any
// new dependency.
func tcpProbe(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
