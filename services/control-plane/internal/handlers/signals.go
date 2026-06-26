package handlers

import (
	"bufio"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

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
// This is a single-owner PERSONAL endpoint: it is NOT JWT/tenant-scoped. It is
// gated by a shared secret (LANTERN_SIGNAL_TOKEN), exactly like the bridge
// heartbeat shared-token pattern in surfaces.go, and fails closed when the env
// var is unset.
type SignalHandler struct {
	srv *server.Server
}

// NewSignalHandler creates a new SignalHandler.
func NewSignalHandler(srv *server.Server) *SignalHandler {
	return &SignalHandler{srv: srv}
}

func (h *SignalHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("signals")
}

// signalEntry is one line in ~/.lantern/device-signals.jsonl. The on-disk
// field names (app/kind/detail/ts) are the contract the bridge's
// device-signals reader expects — do not rename without updating the bridge.
type signalEntry struct {
	App    string `json:"app"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	TS     int64  `json:"ts"`
}

const (
	signalMaxAppLen    = 100
	signalMaxDetailLen = 500
	signalFileMaxLines = 5000
	signalFileKeepLine = 4000
)

// authorize enforces the shared-token gate. Returns true when the request is
// allowed to proceed; otherwise it has already written a 401 and the caller
// must return. Fails closed: an unset env or a missing/mismatched header is a
// 401. The token is never logged.
func (h *SignalHandler) authorize(w http.ResponseWriter, r *http.Request) bool {
	expected := os.Getenv("LANTERN_SIGNAL_TOKEN")
	provided := r.Header.Get("x-lantern-signal-token")
	if expected == "" || provided == "" ||
		subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

// signalsFilePath returns ~/.lantern/device-signals.jsonl, honoring HOME so
// tests can isolate writes to a temp dir.
func signalsFilePath() (dir, path string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	dir = filepath.Join(home, ".lantern")
	return dir, filepath.Join(dir, "device-signals.jsonl"), nil
}

// IngestSignal handles POST /v1/signals.
func (h *SignalHandler) IngestSignal(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}

	var body struct {
		App    string `json:"app"`
		Kind   string `json:"kind"`
		Detail string `json:"detail"`
		TS     int64  `json:"ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	app := strings.TrimSpace(body.App)
	if app == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "app is required"})
		return
	}
	if len(app) > signalMaxAppLen {
		app = app[:signalMaxAppLen]
	}

	kind := strings.TrimSpace(body.Kind)
	if kind == "" {
		kind = "app_open"
	}
	detail := body.Detail
	if len(detail) > signalMaxDetailLen {
		detail = detail[:signalMaxDetailLen]
	}
	ts := body.TS
	if ts == 0 {
		ts = time.Now().UnixMilli()
	}

	entry := signalEntry{App: app, Kind: kind, Detail: detail, TS: ts}
	if err := appendSignal(entry); err != nil {
		h.logger().Error("append signal failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to record signal"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ListSignals handles GET /v1/signals?limit=N.
func (h *SignalHandler) ListSignals(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
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
