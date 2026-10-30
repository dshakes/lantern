package handlers

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// SignalHandler exposes a token-gated personal device-signals endpoint.
//
// The owner's iPhone Shortcuts POST app-context signals here THROUGH the
// existing cloudflared tunnel (which fronts the API on :8080, not the
// dashboard on :3001). The bridge reads ~/.lantern/device-signals.jsonl and
// summarizes the signals into owner context. A parallel dashboard route at
// apps/web/app/api/signals/route.ts writes the SAME contract on :3001 — this
// handler exists so the write path is reachable over the tunnel.
//
// Two auth modes (ADR 0047):
//
//   - TENANT (the GA path): `Authorization: Bearer <bridge token>` from a paired
//     device (scope bridge:signals:write / :read), or a user JWT / scoped API
//     key. Signals are stored per tenant in device_signals under RLS.
//   - LEGACY single-owner (the pre-tenancy install): the shared secret
//     PAL_SIGNAL_TOKEN in x-pal-signal-token (or legacy x-lantern-signal-token), with
//     NO Authorization header. Behaviour is byte-identical to before — the line
//     is appended to the device-signals file the live bridge reads — and the
//     signal is additionally mirrored, best-effort, into device_signals for the
//     legacy owner tenant (PAL_SIGNALS_LEGACY_OWNER_TENANT, default the dev
//     tenant; "off" disables the legacy path entirely). Fails closed when
//     PAL_SIGNAL_TOKEN is unset.
//
// Supported signal kinds (bridge reads all of these):
//
//	{kind:"app_open",  app:"YouTube",             ts}
//	{kind:"location",  detail:"Home",              ts}
//	{kind:"focus",     detail:"Work",              ts}
//	{kind:"device",    detail:"CarPlay",           ts}   // also "charging", "AirPods", "Office WiFi"
//	{kind:"health",    metric:"steps", value:6200, ts}   // metric in steps|sleep|workout
//	{kind:"health",    detail:"ran 3mi",            ts}
//	{kind:"now_playing", detail:"Song - Artist",   ts}
//	{kind:"wake",                                   ts}
//	{kind:"sleep",                                  ts}
//	{kind:"screenshot",                             ts}
type SignalHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewSignalHandler creates a new SignalHandler. auth may be nil, in which case
// only the legacy shared-token path is served (tenant credentials get 401).
func NewSignalHandler(srv *server.Server, auth *AuthHandler) *SignalHandler {
	return &SignalHandler{srv: srv, auth: auth}
}

// legacyOwnerDefaultTenant is the pre-tenancy single-owner install's tenant.
const legacyOwnerDefaultTenant = "00000000-0000-0000-0000-000000000001"

// legacyOwnerTenant returns the tenant the legacy shared-token path writes for,
// or "" when the operator disabled the legacy path (multi-tenant deployments
// set PAL_SIGNALS_LEGACY_OWNER_TENANT=off so a shared secret can never write
// into some tenant's data).
func legacyOwnerTenant() string {
	v := strings.TrimSpace(os.Getenv("PAL_SIGNALS_LEGACY_OWNER_TENANT"))
	switch strings.ToLower(v) {
	case "":
		return legacyOwnerDefaultTenant
	case "off", "none", "disabled", "0", "false":
		return ""
	}
	if _, err := uuid.Parse(v); err != nil {
		return "" // a malformed tenant id fails closed
	}
	return v
}

// signalCaller is the resolved principal for one signals request.
type signalCaller struct {
	tenantID string
	bridgeID *string
	source   string // bridge | user | legacy
}

// signalRetention bounds how long tenant signals are kept (app-context PII).
func signalRetention() time.Duration {
	if n, err := strconv.Atoi(os.Getenv("PAL_SIGNALS_RETENTION_DAYS")); err == nil && n > 0 {
		return time.Duration(n) * 24 * time.Hour
	}
	return 30 * 24 * time.Hour
}

// resolveCaller authenticates the request. A request carrying an Authorization
// header is ALWAYS judged on that credential (it never falls back to the
// shared secret). Without one, the legacy shared-token path applies. On
// failure it has already written the response and returns ok=false.
func (h *SignalHandler) resolveCaller(w http.ResponseWriter, r *http.Request, write bool) (signalCaller, bool) {
	if r.Header.Get("Authorization") == "" {
		if !h.authorize(w, r) {
			return signalCaller{}, false
		}
		tid := legacyOwnerTenant()
		if tid == "" {
			h.logger().Warn("signal rejected (401)", zap.String("reason", "legacy shared-token path disabled (PAL_SIGNALS_LEGACY_OWNER_TENANT)"))
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return signalCaller{}, false
		}
		return signalCaller{tenantID: tid, source: "legacy"}, true
	}

	raw := bearerToken(r)
	if strings.HasPrefix(raw, bridgeTokenPrefix) {
		id, err := authenticateBridge(r.Context(), h.srv, raw)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return signalCaller{}, false
		}
		need := ScopeBridgeSignalsRead
		if write {
			need = ScopeBridgeSignalsWrite
		}
		if !id.has(need) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "missing required scope: " + need})
			return signalCaller{}, false
		}
		middleware.EnrichSpan(r.Context(), id.TenantID, "", "", "")
		return signalCaller{tenantID: id.TenantID, bridgeID: &id.BridgeID, source: "bridge"}, true
	}

	if h.auth == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return signalCaller{}, false
	}
	claims, err := h.auth.validateRequest(r)
	if err != nil || claims.TenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return signalCaller{}, false
	}
	need := ScopeRead
	if write {
		need = ScopeWrite
	}
	// Enforced unconditionally (new surface; not behind the staging flag).
	if claims.Role == kioskRole || !HasScope(claims, need) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "missing required scope: " + need})
		return signalCaller{}, false
	}
	middleware.EnrichSpan(r.Context(), claims.TenantID, claims.Subject, "", "")
	return signalCaller{tenantID: claims.TenantID, source: "user"}, true
}

// insertTenantSignal stores one signal for the caller's tenant under RLS and
// prunes that tenant's rows past the retention window in the same tx.
func (h *SignalHandler) insertTenantSignal(ctx context.Context, c signalCaller, e signalEntry) error {
	cutoff := time.Now().Add(-signalRetention())
	return db.WithTenantConn(ctx, h.srv.TenantPool(), c.tenantID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO device_signals (tenant_id, bridge_id, source, kind, app, detail, metric, value, ts)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		`, c.tenantID, c.bridgeID, c.source, e.Kind, e.App, e.Detail, e.Metric, e.Value, e.TS); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM device_signals WHERE tenant_id = $1 AND created_at < $2`, c.tenantID, cutoff)
		return err
	})
}

// listTenantSignals returns the tenant's newest `limit` signals, oldest first
// (the same order the legacy file tail returns).
func (h *SignalHandler) listTenantSignals(ctx context.Context, tenantID string, limit int) ([]signalEntry, error) {
	out := make([]signalEntry, 0, limit)
	err := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT app, kind, detail, metric, value, ts FROM device_signals
			WHERE tenant_id = $1
			ORDER BY ts DESC, id DESC
			LIMIT $2
		`, tenantID, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e signalEntry
			if err := rows.Scan(&e.App, &e.Kind, &e.Detail, &e.Metric, &e.Value, &e.TS); err != nil {
				return err
			}
			out = append(out, e)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (h *SignalHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("signals")
}

// signalEntry is one line in ~/.lantern/device-signals.jsonl. The on-disk
// field names (app/kind/detail/metric/value/ts) are the contract the bridge's
// device-signals reader expects — do not rename without updating the bridge.
// omitempty keeps lines compact: app_open lines omit metric/value; health
// lines omit app; bare wake/sleep lines omit app/detail/metric/value.
type signalEntry struct {
	App    string   `json:"app,omitempty"`
	Kind   string   `json:"kind"`
	Detail string   `json:"detail,omitempty"`
	Metric string   `json:"metric,omitempty"`
	Value  *float64 `json:"value,omitempty"`
	TS     int64    `json:"ts"`
}

const (
	signalMaxKindLen   = 40
	signalMaxAppLen    = 100
	signalMaxDetailLen = 500
	signalMaxMetricLen = 40
	signalFileMaxLines = 5000
	signalFileKeepLine = 4000
)

// authorize enforces the shared-token gate. Returns true when the request is
// allowed to proceed; otherwise it has already written a 401 and the caller
// must return. Fails closed: an unset env or a missing/mismatched header is a
// 401. The token is never logged.
func (h *SignalHandler) authorize(w http.ResponseWriter, r *http.Request) bool {
	expected := os.Getenv("PAL_SIGNAL_TOKEN")
	// x-pal-signal-token, or the legacy x-lantern-signal-token that the
	// owner's iPhone Shortcuts send (accepted forever, ADR 0032). One value is
	// compared: the PAL header when present, else the legacy one.
	provided := r.Header.Get("x-pal-signal-token")
	if provided == "" {
		provided = r.Header.Get("x-lantern-signal-token")
	}
	if expected == "" || provided == "" ||
		subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		// Log the rejection (never the token) — a silent 401 is undebuggable.
		// The "server token unset" case is the giveaway that the wrong API
		// (one without PAL_SIGNAL_TOKEN) is serving this port.
		reason := "token mismatch"
		switch {
		case expected == "":
			reason = "PAL_SIGNAL_TOKEN unset on the server — this API instance cannot accept signals"
		case provided == "":
			reason = "request missing x-pal-signal-token (or x-lantern-signal-token) header"
		}
		h.logger().Warn("signal rejected (401)", zap.String("reason", reason), zap.String("from", r.RemoteAddr))
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

// signalsFilePath returns <state dir>/device-signals.jsonl (see palStateDir;
// ~/.lantern on existing installs), honoring HOME so tests can isolate writes
// to a temp dir.
func signalsFilePath() (dir, path string, err error) {
	dir, err = palStateDir()
	if err != nil {
		return "", "", err
	}
	return dir, filepath.Join(dir, "device-signals.jsonl"), nil
}

// IngestSignal handles POST /v1/signals.
//
// Validation rules:
//   - kind is always required (non-empty, clamped to signalMaxKindLen).
//   - For kind=="app_open": app is required (non-empty).
//   - For all other kinds: at least one of app/detail/value must be present,
//     so a fully-empty payload is rejected.
//   - detail clamped to signalMaxDetailLen; app to signalMaxAppLen; metric to signalMaxMetricLen.
//   - ts defaults to now (milliseconds) when zero or absent.
func (h *SignalHandler) IngestSignal(w http.ResponseWriter, r *http.Request) {
	caller, ok := h.resolveCaller(w, r, true)
	if !ok {
		return
	}

	var body struct {
		App    string   `json:"app"`
		Kind   string   `json:"kind"`
		Detail string   `json:"detail"`
		Metric string   `json:"metric"`
		Value  *float64 `json:"value"`
		TS     int64    `json:"ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// kind: required, clamped.
	kind := strings.TrimSpace(body.Kind)
	if kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind is required"})
		return
	}
	if len(kind) > signalMaxKindLen {
		kind = kind[:signalMaxKindLen]
	}

	// app: clamp.
	app := strings.TrimSpace(body.App)
	if len(app) > signalMaxAppLen {
		app = app[:signalMaxAppLen]
	}

	// For app_open, app is required.
	if kind == "app_open" && app == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "app is required for kind=app_open"})
		return
	}

	// detail: clamp.
	detail := body.Detail
	if len(detail) > signalMaxDetailLen {
		detail = detail[:signalMaxDetailLen]
	}

	// metric: clamp.
	metric := strings.TrimSpace(body.Metric)
	if len(metric) > signalMaxMetricLen {
		metric = metric[:signalMaxMetricLen]
	}

	value := body.Value

	// For non-app_open kinds: at least one of app/detail/value must be present.
	if kind != "app_open" && app == "" && strings.TrimSpace(detail) == "" && value == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one of app, detail, or value is required"})
		return
	}

	ts := body.TS
	if ts == 0 {
		ts = time.Now().UnixMilli()
	}

	entry := signalEntry{
		App:    app,
		Kind:   kind,
		Detail: detail,
		Metric: metric,
		Value:  value,
		TS:     ts,
	}
	if caller.source == "legacy" {
		// Legacy single-owner path: the file write is the contract the live
		// bridge reads, so it is authoritative and its outcome is the response.
		if err := appendSignal(entry); err != nil {
			h.logger().Error("append signal failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to record signal"})
			return
		}
		// Upgrade path: mirror into the tenant store, best-effort — a DB
		// problem must never fail (or slow) the owner's Shortcut.
		if h.srv.Pool != nil {
			mctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			if err := h.insertTenantSignal(mctx, caller, entry); err != nil {
				h.logger().Warn("legacy signal mirror to tenant store failed", zap.Error(err))
			}
			cancel()
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	if err := h.insertTenantSignal(r.Context(), caller, entry); err != nil {
		h.logger().Error("insert tenant signal failed", zap.Error(err), zap.String("tenant_id", caller.tenantID))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to record signal"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ListSignals handles GET /v1/signals?limit=N.
func (h *SignalHandler) ListSignals(w http.ResponseWriter, r *http.Request) {
	caller, ok := h.resolveCaller(w, r, false)
	if !ok {
		return
	}

	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 500 {
		limit = 500
	}

	if caller.source != "legacy" {
		entries, err := h.listTenantSignals(r.Context(), caller.tenantID, limit)
		if err != nil {
			h.logger().Error("list tenant signals failed", zap.Error(err), zap.String("tenant_id", caller.tenantID))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read signals"})
			return
		}
		writeJSON(w, http.StatusOK, entries)
		return
	}

	entries, err := readSignals()
	if err != nil {
		h.logger().Error("read signals failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read signals"})
		return
	}
	if len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}

	writeJSON(w, http.StatusOK, entries)
}

// appendSignal appends one compact JSON line to the device-signals file,
// creating ~/.lantern (0700) and the file (0600) as needed, then bounds the
// file: if it grows past signalFileMaxLines it is rewritten keeping the last
// signalFileKeepLine lines.
func appendSignal(entry signalEntry) error {
	dir, path, err := signalsFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close() //nolint:errcheck
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	// chmod defensively in case the file pre-existed with looser perms (it
	// holds app-context PII like which apps the owner opens and when).
	_ = os.Chmod(path, 0o600) //nolint:errcheck

	return trimSignalFile(path)
}

// trimSignalFile rewrites the file with only its last signalFileKeepLine lines
// when it exceeds signalFileMaxLines. Simple and cheap: read all, slice, write.
func trimSignalFile(path string) error {
	lines, err := readRawLines(path)
	if err != nil {
		return err
	}
	if len(lines) <= signalFileMaxLines {
		return nil
	}
	keep := lines[len(lines)-signalFileKeepLine:]
	out := strings.Join(keep, "\n") + "\n"
	return os.WriteFile(path, []byte(out), 0o600)
}

// readRawLines returns the non-empty lines of the file, or nil if absent.
func readRawLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close() //nolint:errcheck

	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			lines = append(lines, line)
		}
	}
	return lines, sc.Err()
}

// readSignals parses every line of the device-signals file into entries,
// skipping malformed lines. Returns an empty slice (never nil) so the JSON
// response is always [] rather than null.
func readSignals() ([]signalEntry, error) {
	_, path, err := signalsFilePath()
	if err != nil {
		return nil, err
	}
	lines, err := readRawLines(path)
	if err != nil {
		return nil, err
	}
	entries := make([]signalEntry, 0, len(lines))
	for _, line := range lines {
		var e signalEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, nil
}
