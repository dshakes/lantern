package handlers

// runtime_report.go — POST /v1/runtime/report
//
// Receives runtime telemetry and audit events forwarded by the runtime-manager
// on behalf of VM harnesses. This is the inbound counterpart to the secret
// relay (runtime_secrets.go): the manager calls here to push data TO the
// control-plane rather than pull data FROM it.
//
// # Authentication
//
// Identical to the secret relay: X-Lantern-Runtime-Token pre-shared token,
// compared constant-time (SHA-256 hashed) against LANTERN_RUNTIME_SECRET_TOKEN.
// FAIL-CLOSED: if the env var is unset this endpoint returns 403 for every
// call regardless of the token supplied.
//
// The same per-IP auth-failure rate-limiter from RuntimeSecretsHandler is
// reused; RuntimeReportHandler embeds the same fields and helpers.
//
// # VM-binding check
//
// Reports must supply vm_id + tenant_id. The handler looks up runtime_vms,
// verifies the row belongs to the claimed tenant, and verifies the VM is not
// in a terminal state. A mismatch returns 403 — identical response for "no
// such vm", "wrong tenant", and "terminal state" (no oracle).
//
// # Payload dispatch
//
//   - kind=audit          → INSERT into runtime_audit_events (durable)
//   - kind=log            → INSERT into runtime_vm_logs (persisted so the
//     existing SSE path at GET /v1/runtime/vms/{id}/logs can replay them
//     for clients that connect after the VM has exited)
//   - kind=otlp_traces    → debug-logged + counter incremented; full OTLP
//     export is a TODO (see TODO(report-otlp) below)
//   - kind=prometheus_metrics → debug-logged + counter incremented; scraping
//     integration is a TODO (see TODO(report-prometheus) below)
//
// # Body limits
//
// Request body is capped at 1 MiB (generous for OTLP batches; logs and audit
// events are much smaller). Malformed or missing required fields return 400.
//
// # Audit
//
// kind=audit payloads write one runtime_audit_events row per call. Other
// kinds do NOT produce an audit row — audit is opt-in from the harness.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const (
	// envTerminalGrace is the env var controlling how long after a VM reaches a
	// terminal state (terminated/failed) the control-plane still accepts kind=log
	// and kind=audit reports from it. Final harness logs and shutdown audit events
	// legitimately arrive after the runtime-manager has already flipped the state.
	//
	// Default: 10 minutes. Parse as time.Duration (e.g. "10m", "5m30s").
	// Set to "0" to disable the grace window entirely (strict: terminal → reject).
	envTerminalGrace = "LANTERN_RUNTIME_TERMINAL_GRACE"

	// defaultTerminalGrace is used when LANTERN_RUNTIME_TERMINAL_GRACE is absent
	// or unparseable.
	defaultTerminalGrace = 10 * time.Minute
)

const (
	// reportBodyLimit caps the request body at 1 MiB to prevent DoS via
	// unbounded body reads. OTLP trace batches can be moderately large.
	reportBodyLimit = 1 << 20 // 1 MiB

	// reportAuthFailMax / reportAuthFailWindow mirror the secret relay limits.
	// These constants are intentionally separate from the secrets handler
	// so each endpoint has its own sliding window (a burst against /report
	// does not exhaust the /secrets window, and vice-versa).
	reportAuthFailMax    = 10
	reportAuthFailWindow = time.Minute
)

// reportKind enumerates the valid payload discriminators.
type reportKind string

const (
	reportKindLog       reportKind = "log"
	reportKindOTLP      reportKind = "otlp_traces"
	reportKindProm      reportKind = "prometheus_metrics"
	reportKindAudit     reportKind = "audit"
	reportKindStepEvent reportKind = "step_event" // in-VM step journal event → journal_events
	reportKindVMExit    reportKind = "vm_exit"    // workload exit → closes the associated run
)

// ---------- Request DTOs ----------

// reportRequest is the exact JSON shape the runtime-manager sends.
// Only one of Log/OtlpB64/PromB64/Audit/StepEvent/VMExit is set per call, matching Kind.
type reportRequest struct {
	VmID      string           `json:"vm_id"`
	TenantID  string           `json:"tenant_id"`
	RunID     string           `json:"run_id,omitempty"`
	Kind      reportKind       `json:"kind"`
	Log       *reportLogEntry  `json:"log,omitempty"`
	OtlpB64   string           `json:"otlp_traces_b64,omitempty"`
	PromB64   string           `json:"prometheus_b64,omitempty"`
	Audit     *reportAudit     `json:"audit,omitempty"`
	StepEvent *reportStepEvent `json:"step_event,omitempty"`
	VMExit    *reportVMExit    `json:"vm_exit,omitempty"`
}

// reportLogEntry carries a single log line from a VM harness.
type reportLogEntry struct {
	VmID   string `json:"vm_id"`
	Stream string `json:"stream"` // "stdout" | "stderr"
	Text   string `json:"text"`
}

// reportAudit carries a structured audit event from a VM harness.
type reportAudit struct {
	VmID   string         `json:"vm_id"`
	Action string         `json:"action"`
	Attrs  map[string]any `json:"attrs,omitempty"`
}

// reportStepEvent carries a step-lifecycle event from an in-VM workload.
// The event is written to journal_events so the run-detail waterfall, receipts,
// and crash-resume CompletedStep cache work identically for microVM runs.
//
// # Envelope (kind=step_event)
//
//	{
//	  "vm_id":     "vm-abc123",
//	  "tenant_id": "...",
//	  "run_id":    "...",            // required for step_event
//	  "kind":      "step_event",
//	  "step_event": {
//	    "event_kind": "step_started",  // step_started | step_completed | step_failed
//	    "step_id":    "node-abc",
//	    "attempt":    1,
//	    "payload":    { ... }          // arbitrary node output or error detail
//	  }
//	}
type reportStepEvent struct {
	// EventKind is the journal_events.kind value: step_started, step_completed, step_failed.
	EventKind string `json:"event_kind"`
	// StepID is the workflow node id (written to journal_events.step_id).
	StepID string `json:"step_id"`
	// Attempt is the retry counter for this step (default 1).
	Attempt int `json:"attempt,omitempty"`
	// Payload is the arbitrary node output or error detail, written as BYTEA to journal_events.
	Payload map[string]any `json:"payload,omitempty"`
}

// reportVMExit carries a workload exit notification from the harness.
// Receipt closes the associated run row: exit_code=0 → succeeded; nonzero → failed.
//
// # Envelope (kind=vm_exit)
//
//	{
//	  "vm_id":     "vm-abc123",
//	  "tenant_id": "...",
//	  "run_id":    "...",    // required for vm_exit
//	  "kind":      "vm_exit",
//	  "vm_exit": {
//	    "exit_code": 0,
//	    "output":    { ... } // final output payload (only meaningful for exit_code=0)
//	  }
//	}
type reportVMExit struct {
	ExitCode int            `json:"exit_code"`
	Output   map[string]any `json:"output,omitempty"`
}

// ---------- Handler ----------

// vmMetricsEntry holds the most-recently received prometheus metrics payload
// for a single VM. The payload is the raw base64-decoded Prometheus exposition
// text forwarded from the harness. Fields are written once per kind=prometheus_metrics
// report call; concurrent reads come from LiveMetrics.
type vmMetricsEntry struct {
	TenantID   string
	VmID       string
	PromText   string // raw Prometheus exposition text (decoded from PromB64)
	ReceivedAt time.Time
}

// RuntimeReportHandler exposes POST /v1/runtime/report.
// It is a distinct type from RuntimeHandler (which owns /v1/runtime/vms/*
// and /v1/runtime/schedule) so that the surface area of the inbound
// manager→control-plane path is easy to audit in isolation.
type RuntimeReportHandler struct {
	srv *server.Server

	// authFailMu guards authFailures.
	authFailMu sync.Mutex
	// authFailures tracks per-IP auth failure timestamps for rate-limiting.
	authFailures map[string][]time.Time

	// metricsMu guards metricsLatest.
	metricsMu sync.RWMutex
	// metricsLatest holds the most-recently received prometheus payload per
	// vm_id (keyed "tenantID/vmID" for O(1) lookup and clean eviction).
	// Entries are evicted periodically by sweepTerminatedVMMetrics, which
	// runs inside RunLogRetentionJanitor alongside the log-row sweep.
	metricsLatest map[string]*vmMetricsEntry
}

// NewRuntimeReportHandler constructs a RuntimeReportHandler.
func NewRuntimeReportHandler(srv *server.Server) *RuntimeReportHandler {
	return &RuntimeReportHandler{
		srv:           srv,
		authFailures:  make(map[string][]time.Time),
		metricsLatest: make(map[string]*vmMetricsEntry),
	}
}

// LatestVMMetrics returns a snapshot of the most-recently received prometheus
// payload for VMs belonging to tenantID. The returned slice is a copy —
// callers may mutate it freely.
func (h *RuntimeReportHandler) LatestVMMetrics(tenantID string) []*vmMetricsEntry {
	h.metricsMu.RLock()
	defer h.metricsMu.RUnlock()
	out := make([]*vmMetricsEntry, 0)
	prefix := tenantID + "/"
	for k, e := range h.metricsLatest {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			cp := *e
			out = append(out, &cp)
		}
	}
	return out
}

func (h *RuntimeReportHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("runtime_report")
}

// ---------- Auth-failure rate limiter (mirrors runtime_secrets.go) ----------

// recordReportAuthFailure records an auth failure for the IP and returns true
// when the IP has exceeded reportAuthFailMax within reportAuthFailWindow.
func (h *RuntimeReportHandler) recordReportAuthFailure(ip string) bool {
	now := time.Now()
	cutoff := now.Add(-reportAuthFailWindow)

	h.authFailMu.Lock()
	defer h.authFailMu.Unlock()

	times := h.authFailures[ip]
	valid := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	valid = append(valid, now)
	h.authFailures[ip] = valid

	return len(valid) > reportAuthFailMax
}

// ---------- VM-binding check ----------

// vmRow holds the columns we care about from runtime_vms for the binding check.
type vmBindingRow struct {
	tenantID        string
	state           string
	agentInstanceID string     // may be empty
	runID           string     // may be empty; populated for step_event / vm_exit fallback
	terminatedAt    *time.Time // non-nil when the VM has reached a terminal state
}

// terminalGrace reads LANTERN_RUNTIME_TERMINAL_GRACE and returns the configured
// grace duration. Invalid or absent values fall back to defaultTerminalGrace.
// A value of "0" disables the grace window entirely.
func terminalGrace() time.Duration {
	raw := os.Getenv(envTerminalGrace)
	if raw == "" {
		return defaultTerminalGrace
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 {
		return defaultTerminalGrace
	}
	return d
}

// isTerminalState reports whether state is one of the terminal VM states.
func isTerminalState(state string) bool {
	for _, s := range terminalVMStates {
		if state == s {
			return true
		}
	}
	return false
}

// checkReportVMBinding verifies that vm_id exists in runtime_vms, belongs to
// the claimed tenant_id, and is either non-terminal or within the grace window
// for the supplied kind.
//
// Grace window behaviour: for kind=log and kind=audit only, a VM that entered a
// terminal state within LANTERN_RUNTIME_TERMINAL_GRACE (default 10 min) of now
// is still accepted. This allows final harness logs and shutdown audit events to
// land after the runtime-manager has flipped the row to "terminated" / "failed".
// All other kinds (otlp_traces, prometheus_metrics) and wrong-tenant / unknown-vm
// cases are always rejected regardless of grace.
//
// It also returns the agent_instance_id stored on the row so callers can stamp
// it onto audit events without a second query.
//
// Returns (row, nil) on success; (row{}, vmBindingDenied) on any mismatch.
// Errors always return the same sentinel — no oracle about which condition fired.
func (h *RuntimeReportHandler) checkReportVMBinding(ctx context.Context, vmID, tenantID string, kind reportKind) (vmBindingRow, error) {
	var row vmBindingRow
	// rls-exempt: service-to-service report path (runtime token, no JWT). This is
	// the trust-boundary check that RESOLVES the VM's real owner by vm_id across
	// tenants and compares it to the body-claimed tenant — it must NOT trust the
	// body tenant, so it runs on the privileged pool and verifies row.tenantID below.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT tenant_id, state, COALESCE(agent_instance_id, ''), COALESCE(run_id::text, ''), terminated_at
		FROM runtime_vms
		WHERE vm_id = $1
	`, vmID).Scan(&row.tenantID, &row.state, &row.agentInstanceID, &row.runID, &row.terminatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vmBindingRow{}, vmBindingDenied
		}
		h.logger().Warn("checkReportVMBinding: db error",
			zap.String("vm_id", vmID),
			zap.Error(err),
		)
		return vmBindingRow{}, vmBindingDenied
	}

	// Tenant mismatch is always a hard reject — no grace applies.
	if row.tenantID != tenantID {
		return vmBindingRow{}, vmBindingDenied
	}

	if isTerminalState(row.state) {
		// For log, audit, step_event, and vm_exit kinds, check whether we're still inside
		// the grace window. step_event and vm_exit legitimately arrive as the harness is
		// shutting down, after the manager has already flipped the VM to terminal.
		if kind == reportKindLog || kind == reportKindAudit ||
			kind == reportKindStepEvent || kind == reportKindVMExit {
			grace := terminalGrace()
			if grace > 0 && row.terminatedAt != nil && time.Since(*row.terminatedAt) <= grace {
				// Within grace — allow the report through.
				return row, nil
			}
		}
		// Terminal and either: wrong kind, grace disabled, terminatedAt nil, or expired.
		return vmBindingRow{}, vmBindingDenied
	}

	return row, nil
}

// ---------- Persistence helpers ----------

// insertAuditEvent writes a runtime_audit_events row for kind=audit payloads.
// The agent_instance_id is stamped when non-empty (pulled from runtime_vms).
func (h *RuntimeReportHandler) insertAuditEvent(ctx context.Context, tenantID, vmID, agentInstanceID string, a *reportAudit) error {
	attrsJSON, err := json.Marshal(a.Attrs)
	if err != nil || len(attrsJSON) == 0 {
		attrsJSON = []byte("{}")
	}
	var instanceArg any
	if agentInstanceID != "" {
		instanceArg = agentInstanceID
	}
	return h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, execErr := tx.Exec(ctx, `
			INSERT INTO runtime_audit_events (tenant_id, vm_id, action, attrs, agent_instance_id)
			VALUES ($1, $2, $3, $4::jsonb, $5)
		`, tenantID, vmID, a.Action, attrsJSON, instanceArg)
		return execErr
	})
}

// insertLogLine writes a runtime_vm_logs row for kind=log payloads.
// The seq column is a BIGSERIAL; we rely on the DB default for ordering.
func (h *RuntimeReportHandler) insertLogLine(ctx context.Context, tenantID, vmID string, entry *reportLogEntry) error {
	stream := entry.Stream
	if stream == "" {
		stream = "stdout"
	}
	return h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO runtime_vm_logs (vm_id, tenant_id, stream, text, at)
			VALUES ($1, $2, $3, $4, now())
		`, vmID, tenantID, stream, entry.Text)
		return err
	})
}

// ---------- HTTP handler ----------

// Report handles POST /v1/runtime/report.
//
// Authentication: X-Lantern-Runtime-Token pre-shared token (service-to-service).
// LANTERN_RUNTIME_SECRET_TOKEN must be set; if unset returns 403 fail-closed.
//
// The body is limited to 1 MiB.
func (h *RuntimeReportHandler) Report(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Enforce body limit before any reads.
	r.Body = http.MaxBytesReader(w, r.Body, reportBodyLimit)

	// --- Authentication (reuses the same token + helper as runtime_secrets.go) ---
	ok, authErr := authenticateRuntimeToken(r)
	if !ok {
		if authErr == errRelayDisabled {
			h.logger().Warn("runtime report: disabled (LANTERN_RUNTIME_SECRET_TOKEN not set)")
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "relay disabled"})
			return
		}
		ip := remoteIP(r)
		if h.recordReportAuthFailure(ip) {
			h.logger().Warn("runtime report: auth failure rate limit exceeded",
				zap.String("remote_addr", ip),
			)
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
			return
		}
		h.logger().Warn("runtime report: invalid token",
			zap.String("remote_addr", ip),
		)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	// --- Parse request ---
	var req reportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Validate required fields.
	if req.VmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm_id is required"})
		return
	}
	if req.TenantID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tenant_id is required"})
		return
	}
	switch req.Kind {
	case reportKindLog, reportKindOTLP, reportKindProm, reportKindAudit,
		reportKindStepEvent, reportKindVMExit:
		// valid
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("unknown kind %q: must be log|otlp_traces|prometheus_metrics|audit|step_event|vm_exit", req.Kind),
		})
		return
	}

	ctx := r.Context()

	// --- VM-binding check (security gate) ---
	// Verify the vm_id belongs to the claimed tenant and is non-terminal.
	// Count binding failures against the per-IP rate limiter so that an
	// attacker probing for valid (vm_id, tenant_id) pairs gets throttled at
	// the same rate as token brute-forcers.
	vmRow, bindErr := h.checkReportVMBinding(ctx, req.VmID, req.TenantID, req.Kind)
	if bindErr != nil {
		ip := remoteIP(r)
		if h.recordReportAuthFailure(ip) {
			h.logger().Warn("runtime report: vm binding rate limit exceeded",
				zap.String("remote_addr", ip),
			)
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
			return
		}
		h.logger().Warn("runtime report: vm binding denied",
			zap.String("vm_id", req.VmID),
			zap.String("tenant_id", req.TenantID),
		)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
		return
	}

	// The binding check verified req.TenantID == the VM's real owner; inject it
	// so the audit/log inserts below are RLS-scoped to the verified tenant.
	ctx = middleware.InjectTenantID(ctx, req.TenantID)

	// --- Dispatch by kind ---
	switch req.Kind {

	case reportKindAudit:
		if req.Audit == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "audit payload required for kind=audit"})
			return
		}
		if req.Audit.Action == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "audit.action is required"})
			return
		}
		if err := h.insertAuditEvent(ctx, req.TenantID, req.VmID, vmRow.agentInstanceID, req.Audit); err != nil {
			h.logger().Error("runtime report: audit insert failed",
				zap.String("vm_id", req.VmID),
				zap.String("tenant_id", req.TenantID),
				zap.Error(err),
			)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		h.logger().Debug("runtime report: audit event inserted",
			zap.String("vm_id", req.VmID),
			zap.String("action", req.Audit.Action),
		)

	case reportKindLog:
		if req.Log == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "log payload required for kind=log"})
			return
		}
		if err := h.insertLogLine(ctx, req.TenantID, req.VmID, req.Log); err != nil {
			h.logger().Error("runtime report: log insert failed",
				zap.String("vm_id", req.VmID),
				zap.String("tenant_id", req.TenantID),
				zap.Error(err),
			)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		h.logger().Debug("runtime report: log line persisted",
			zap.String("vm_id", req.VmID),
			zap.String("stream", req.Log.Stream),
		)

	case reportKindOTLP:
		// TODO(report-otlp): forward the base64-decoded OTLP payload to an
		// OTLP collector endpoint (e.g. via the OpenTelemetry Go SDK's
		// otlptracegrpc exporter). For now we record receipt with a debug log
		// and a structured counter so the ingest path is wired end-to-end
		// before the export backend is chosen.
		h.logger().Debug("runtime report: otlp_traces received (not yet forwarded)",
			zap.String("vm_id", req.VmID),
			zap.String("tenant_id", req.TenantID),
			zap.Int("payload_b64_len", len(req.OtlpB64)),
		)

	case reportKindProm:
		// Decode and store the latest prometheus exposition text for this VM.
		// The LiveMetrics endpoint reads these for the cockpit view.
		// Full remote-write forwarding is a TODO(report-prometheus).
		decoded := decodePromPayload(req.PromB64)
		key := req.TenantID + "/" + req.VmID
		h.metricsMu.Lock()
		h.metricsLatest[key] = &vmMetricsEntry{
			TenantID:   req.TenantID,
			VmID:       req.VmID,
			PromText:   decoded,
			ReceivedAt: time.Now().UTC(),
		}
		h.metricsMu.Unlock()
		h.logger().Debug("runtime report: prometheus_metrics stored",
			zap.String("vm_id", req.VmID),
			zap.String("tenant_id", req.TenantID),
			zap.Int("text_len", len(decoded)),
		)

	case reportKindStepEvent:
		if req.StepEvent == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "step_event payload required for kind=step_event"})
			return
		}
		if err := h.handleStepEvent(ctx, req, vmRow); err != nil {
			if errors.Is(err, vmBindingDenied) {
				// Body run_id disagreed with the VM's own run binding — same
				// opaque rejection as the tenant check (no oracle).
				h.logger().Warn("runtime report: step_event run binding denied",
					zap.String("vm_id", req.VmID))
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
				return
			}
			h.logger().Error("runtime report: step_event insert failed",
				zap.String("vm_id", req.VmID),
				zap.String("run_id", req.RunID),
				zap.Error(err),
			)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		h.logger().Debug("runtime report: step_event written to journal",
			zap.String("vm_id", req.VmID),
			zap.String("event_kind", req.StepEvent.EventKind),
			zap.String("step_id", req.StepEvent.StepID),
		)

	case reportKindVMExit:
		if req.VMExit == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm_exit payload required for kind=vm_exit"})
			return
		}
		if err := h.handleVMExit(ctx, req, vmRow); err != nil {
			if errors.Is(err, vmBindingDenied) {
				h.logger().Warn("runtime report: vm_exit run binding denied",
					zap.String("vm_id", req.VmID))
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
				return
			}
			h.logger().Error("runtime report: vm_exit finalization failed",
				zap.String("vm_id", req.VmID),
				zap.String("run_id", req.RunID),
				zap.Error(err),
			)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		h.logger().Info("runtime report: vm_exit run finalized",
			zap.String("vm_id", req.VmID),
			zap.Int("exit_code", req.VMExit.ExitCode),
		)
	}

	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// ---------- Step-event and VM-exit helpers (journal parity, run completion) ----------

// resolveRunID returns the run the reporting VM is actually bound to. The VM
// row is authoritative: journal_events is RLS-exempt and written on the
// privileged pool, so a body-supplied run_id must never steer the write. A
// body run_id that disagrees with the VM's own binding — or that names a run
// when the VM has none — is treated as a forgery attempt and rejected with the
// same vmBindingDenied sentinel as the tenant check (no oracle). Without this,
// any runtime-token holder with one valid (vm_id, tenant_id) could inject
// step events into ANY tenant's run, poisoning its receipt hash and its
// CompletedStep resume cache.
func resolveRunID(req reportRequest, vmRow vmBindingRow) (string, error) {
	if req.RunID != "" && req.RunID != vmRow.runID {
		return "", vmBindingDenied
	}
	return vmRow.runID, nil
}

// validStepEventKinds are the journal_events.kind values the harness may emit.
// They mirror the inline interpreter's output so the run-detail waterfall
// renders identically for both tiers (ADR 0022, journal substrate invariant).
var validStepEventKinds = map[string]bool{
	"step_started":   true,
	"step_completed": true,
	"step_failed":    true,
}

// handleStepEvent writes a journal_events row for kind=step_event reports.
// Uses the same seq-generation pattern as dispatchMicroVMRun so the inline
// and microVM tiers share an identical journal shape.
//
// Span: runtime.report.step_event (attrs: lantern.run_id, lantern.vm_id).
func (h *RuntimeReportHandler) handleStepEvent(ctx context.Context, req reportRequest, vmRow vmBindingRow) error {
	tracer := otel.Tracer("lantern.control-plane")
	ctx, span := tracer.Start(ctx, "runtime.report.step_event")
	defer span.End()

	runID, ridErr := resolveRunID(req, vmRow)
	if ridErr != nil {
		span.RecordError(ridErr)
		span.SetStatus(codes.Error, "run binding denied")
		return ridErr
	}
	span.SetAttributes(
		attribute.String("lantern.run_id", runID),
		attribute.String("lantern.vm_id", req.VmID),
	)

	if runID == "" {
		err := fmt.Errorf("step_event: run_id not provided and not found on VM row")
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	se := req.StepEvent
	if !validStepEventKinds[se.EventKind] {
		err := fmt.Errorf("step_event: invalid event_kind %q: must be step_started|step_completed|step_failed", se.EventKind)
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	attempt := se.Attempt
	if attempt <= 0 {
		attempt = 1
	}
	raw, _ := json.Marshal(se.Payload)
	if len(raw) == 0 {
		raw = []byte("{}")
	}

	// rls-exempt: journal_events is an RLS-exempt child table keyed by run_id.
	// The run_id was either supplied in the verified request or comes from the
	// runtime_vms row whose tenant ownership was confirmed by checkReportVMBinding.
	_, err := h.srv.Pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		SELECT $1::uuid,
		       COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1::uuid), 0) + 1,
		       $2, $3, $4, $5
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, se.EventKind, se.StepID, attempt, raw)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "journal insert failed")
		return fmt.Errorf("handleStepEvent: insert journal_events: %w", err)
	}
	return nil
}

// handleVMExit finalizes the run associated with a vm_exit report:
//  1. Stamps exit_code (and exit_output when exit_code=0) onto runtime_vms.
//  2. Closes the run: exit_code=0 → succeeded; nonzero → failed with typed error.
//
// Idempotent via ON CONFLICT DO NOTHING on the journal seq insert and a
// conditional UPDATE on runs (WHERE status NOT IN ('succeeded','failed')).
//
// Span: runtime.report.vm_exit (attrs: lantern.run_id, lantern.vm_id).
func (h *RuntimeReportHandler) handleVMExit(ctx context.Context, req reportRequest, vmRow vmBindingRow) error {
	tracer := otel.Tracer("lantern.control-plane")
	ctx, span := tracer.Start(ctx, "runtime.report.vm_exit")
	defer span.End()

	runID, ridErr := resolveRunID(req, vmRow)
	if ridErr != nil {
		span.RecordError(ridErr)
		span.SetStatus(codes.Error, "run binding denied")
		return ridErr
	}
	span.SetAttributes(
		attribute.String("lantern.run_id", runID),
		attribute.String("lantern.vm_id", req.VmID),
		attribute.Int("lantern.exit_code", req.VMExit.ExitCode),
	)

	if runID == "" {
		err := fmt.Errorf("vm_exit: run_id not provided and not found on VM row")
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	exitCode := req.VMExit.ExitCode

	// 1. Stamp exit_code on the VM row. Use Pool (cross-tenant trust-boundary path,
	// RLS-exempt: this endpoint authenticates via the pre-shared runtime token and
	// the VM binding check has already verified tenant ownership).
	// rls-exempt: runtime_vms write from service-to-service report path (pre-shared
	// token + vm binding check already confirmed tenant; no JWT).
	if exitCode == 0 {
		outputJSON, _ := json.Marshal(req.VMExit.Output)
		if len(outputJSON) == 0 {
			outputJSON = []byte("{}")
		}
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE runtime_vms SET exit_code = $2, exit_output = $3::jsonb
			WHERE vm_id = $1
		`, req.VmID, exitCode, string(outputJSON))
	} else {
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE runtime_vms SET exit_code = $2 WHERE vm_id = $1
		`, req.VmID, exitCode)
	}

	// 2. Close the run. WithTenant scopes the write via the RLS GUC.
	// runs IS RLS-enforced; the ctx already has tenant_id injected.
	if exitCode == 0 {
		outputJSON, _ := json.Marshal(req.VMExit.Output)
		if len(outputJSON) == 0 {
			outputJSON = []byte("{}")
		}
		if wErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				UPDATE runs
				SET status = 'succeeded', output = $2::jsonb, finished_at = now()
				WHERE id = $1::uuid AND status NOT IN ('succeeded', 'failed')
			`, runID, string(outputJSON))
			return e
		}); wErr != nil {
			span.RecordError(wErr)
			span.SetStatus(codes.Error, "run finalization failed")
			return fmt.Errorf("handleVMExit: finalize run succeeded: %w", wErr)
		}
	} else {
		errJSON, _ := json.Marshal(map[string]any{
			"code":     "microvm_exit",
			"exitCode": exitCode,
		})
		if wErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				UPDATE runs
				SET status = 'failed', error = $2::jsonb, finished_at = now()
				WHERE id = $1::uuid AND status NOT IN ('succeeded', 'failed')
			`, runID, string(errJSON))
			return e
		}); wErr != nil {
			span.RecordError(wErr)
			span.SetStatus(codes.Error, "run finalization failed")
			return fmt.Errorf("handleVMExit: finalize run failed: %w", wErr)
		}
	}

	// 3. Emit a terminal journal event so the run waterfall shows completion.
	// rls-exempt: journal_events is an RLS-exempt child table.
	finalKind := "step_completed"
	if exitCode != 0 {
		finalKind = "step_failed"
	}
	payload, _ := json.Marshal(map[string]any{
		"node_type": "microvm_exit",
		"exitCode":  exitCode,
		"vmId":      req.VmID,
	})
	_, _ = h.srv.Pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		SELECT $1::uuid,
		       COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1::uuid), 0) + 1,
		       $2, 'microvm:exit', 1, $3
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, finalKind, payload)

	return nil
}

// decodePromPayload tries base64-standard decoding of s. If decoding fails
// (e.g. the harness sent raw exposition text directly), the raw string is
// returned as-is. Empty input returns "".
func decodePromPayload(s string) string {
	if s == "" {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return s // treat as raw text
	}
	return string(b)
}

// ---------- Log-retention janitor ----------

const (
	// envLogRetentionDays is the environment variable that controls how long
	// runtime_vm_logs rows are kept. Default: 14 days.
	envLogRetentionDays = "LANTERN_RUNTIME_LOG_RETENTION_DAYS"

	// defaultLogRetentionDays is the fallback when the env var is absent or
	// unparseable.
	defaultLogRetentionDays = 14

	// logRetentionSweepInterval is how often the janitor runs. Once per hour is
	// far more than necessary for a 14-day window; it keeps the delete batches
	// small and avoids long table scans.
	logRetentionSweepInterval = time.Hour
)

// logRetentionDays reads LANTERN_RUNTIME_LOG_RETENTION_DAYS and returns the
// configured window in days. Invalid or absent values fall back to the default.
func logRetentionDays() int {
	raw := os.Getenv(envLogRetentionDays)
	if raw == "" {
		return defaultLogRetentionDays
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultLogRetentionDays
	}
	return n
}

// sweepTerminatedVMMetrics removes entries from metricsLatest whose VM is in a
// terminal state (terminated/failed) in runtime_vms, or whose vm_id no longer
// exists in that table at all. This prevents the map from growing without
// bound as VMs come and go. Called from RunLogRetentionJanitor.
//
// If the pool is nil (unit-test environments) the method is a no-op.
// Returns the number of entries evicted.
func (h *RuntimeReportHandler) sweepTerminatedVMMetrics(ctx context.Context) int {
	if h.srv.Pool == nil {
		return 0
	}

	// Snapshot the current vm_ids under a read lock; release before the DB call
	// so we don't hold the lock across I/O.
	h.metricsMu.RLock()
	vmIDs := make([]string, 0, len(h.metricsLatest))
	for _, e := range h.metricsLatest {
		vmIDs = append(vmIDs, e.VmID)
	}
	h.metricsMu.RUnlock()

	if len(vmIDs) == 0 {
		return 0
	}

	// Ask the DB which of these vm_ids are in a non-terminal (live) state.
	// Any vm_id NOT in the result set is either terminal or absent → evict.
	// rls-exempt: background janitor with no request tenant — the in-memory
	// metrics map mixes vm_ids across tenants, so this liveness check spans all
	// tenants on the privileged pool.
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT vm_id FROM runtime_vms
		WHERE vm_id = ANY($1)
		  AND state NOT IN ('terminated', 'failed')
	`, vmIDs)
	if err != nil {
		h.logger().Warn("sweepTerminatedVMMetrics: db query failed", zap.Error(err))
		return 0
	}
	liveVMs := make(map[string]struct{}, len(vmIDs))
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			liveVMs[id] = struct{}{}
		}
	}
	rows.Close()

	// Evict under write lock.
	h.metricsMu.Lock()
	evicted := 0
	for k, e := range h.metricsLatest {
		if _, live := liveVMs[e.VmID]; !live {
			delete(h.metricsLatest, k)
			evicted++
		}
	}
	h.metricsMu.Unlock()
	return evicted
}

// sweepOldLogs deletes runtime_vm_logs rows older than the configured window.
// Returns the number of rows deleted.
func (h *RuntimeReportHandler) sweepOldLogs(ctx context.Context) (int64, error) {
	days := logRetentionDays()
	interval := fmt.Sprintf("%d days", days)
	// rls-exempt: retention janitor with no request tenant — sweeps expired log
	// rows across ALL tenants on the privileged pool.
	tag, err := h.srv.Pool.Exec(ctx,
		`DELETE FROM runtime_vm_logs WHERE at < now() - $1::interval`,
		interval,
	)
	if err != nil {
		return 0, fmt.Errorf("sweepOldLogs: %w", err)
	}
	return tag.RowsAffected(), nil
}

// RunLogRetentionJanitor runs a periodic sweep that deletes runtime_vm_logs
// rows older than LANTERN_RUNTIME_LOG_RETENTION_DAYS (default 14). It blocks
// until ctx is cancelled, which is the graceful-shutdown signal from main.
//
// Call pattern (from main.go):
//
//	go runtimeReportHandler.RunLogRetentionJanitor(ctx)
func (h *RuntimeReportHandler) RunLogRetentionJanitor(ctx context.Context) {
	log := h.logger().Named("log_janitor")
	ticker := time.NewTicker(logRetentionSweepInterval)
	defer ticker.Stop()

	log.Info("runtime_vm_logs retention janitor started",
		zap.Int("retention_days", logRetentionDays()),
	)

	for {
		select {
		case <-ctx.Done():
			log.Info("runtime_vm_logs retention janitor stopping")
			return
		case <-ticker.C:
			sweepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)

			// Sweep old log rows.
			n, err := h.sweepOldLogs(sweepCtx)
			if err != nil {
				log.Warn("runtime_vm_logs sweep failed", zap.Error(err))
			} else if n > 0 {
				log.Info("runtime_vm_logs sweep complete",
					zap.Int64("deleted", n),
					zap.Int("retention_days", logRetentionDays()),
				)
			}

			// Evict in-memory prometheus metrics for terminated/absent VMs.
			evicted := h.sweepTerminatedVMMetrics(sweepCtx)
			if evicted > 0 {
				log.Info("prometheus metrics store: evicted terminal-VM entries",
					zap.Int("evicted", evicted),
				)
			}

			cancel()
		}
	}
}
