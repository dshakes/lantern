package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"go.uber.org/zap"
)

// Short-lived secure file links. A bridge stages a file (bytes over the
// service-token-gated /internal/dl/stage) and gets back an HMAC-signed
// capability URL; the file is then served, no auth, from GET /dl/{token} until
// it expires. The reliable way to deliver a document to a phone that isn't on
// iMessage/WhatsApp: text the contact this link (text delivers everywhere), not
// a flaky MMS binary. The token is unguessable + self-verifying (no DB); bytes
// live in a temp dir and are GC'd at expiry.
const (
	dlServiceTokenEnv = "LANTERN_GRPC_SERVICE_TOKEN"
	dlSecretEnv       = "LANTERN_DL_SIGNING_SECRET"
	dlMaxBytes        = 16 << 20 // 16 MiB — plenty for a doc/photo
	dlMaxTTLSeconds   = 3600     // hard cap: 1 hour
)

type DLHandler struct {
	srv *server.Server
	dir string
}

func NewDLHandler(srv *server.Server) *DLHandler {
	dir := filepath.Join(os.TempDir(), "lantern-dl")
	_ = os.MkdirAll(dir, 0o700)
	return &DLHandler{srv: srv, dir: dir}
}

func (h *DLHandler) logger() *zap.Logger { return h.srv.Logger.Named("dl") }

// signingSecret prefers a dedicated secret, else the shared service token.
func (h *DLHandler) signingSecret() []byte {
	if s := strings.TrimSpace(os.Getenv(dlSecretEnv)); s != "" {
		return []byte(s)
	}
	return []byte(strings.TrimSpace(os.Getenv(dlServiceTokenEnv)))
}

// sign/verify a self-contained capability token: base64url(id|exp).base64url(hmac).
func signDLToken(secret []byte, id string, exp int64) string {
	msg := id + "|" + strconv.FormatInt(exp, 10)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(msg))
	return b64u(msg) + "." + b64u(string(mac.Sum(nil)))
}

func verifyDLToken(secret []byte, token string) (id string, exp int64, ok bool) {
	if len(secret) == 0 {
		return "", 0, false
	}
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", 0, false
	}
	msg, err := unb64u(parts[0])
	if err != nil {
		return "", 0, false
	}
	sig, err := unb64u(parts[1])
	if err != nil {
		return "", 0, false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(msg))
	if subtle.ConstantTimeCompare([]byte(sig), mac.Sum(nil)) != 1 {
		return "", 0, false
	}
	i := strings.LastIndexByte(msg, '|')
	if i < 0 {
		return "", 0, false
	}
	exp, err = strconv.ParseInt(msg[i+1:], 10, 64)
	if err != nil {
		return "", 0, false
	}
	id = msg[:i]
	// id is our own hex — reject anything that could escape the dir.
	if id == "" || strings.ContainsAny(id, "/\\.") {
		return "", 0, false
	}
	return id, exp, true
}

func b64u(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
func unb64u(s string) (string, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return string(b), err
}

// Stage — POST /internal/dl/stage (service-token gated, fail-closed in prod).
func (h *DLHandler) Stage(w http.ResponseWriter, r *http.Request) {
	if !h.authService(w, r) {
		return
	}
	secret := h.signingSecret()
	if len(secret) == 0 {
		h.logger().Warn("dl stage: no signing secret — refusing")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dl signing not configured"})
		return
	}
	var body struct {
		Filename   string `json:"filename"`
		ContentB64 string `json:"contentB64"`
		TTLSeconds int    `json:"ttlSeconds"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, dlMaxBytes*2)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.ContentB64))
	if err != nil || len(data) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contentB64 required"})
		return
	}
	if len(data) > dlMaxBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large"})
		return
	}
	ttl := body.TTLSeconds
	if ttl <= 0 || ttl > dlMaxTTLSeconds {
		ttl = dlMaxTTLSeconds
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "id gen failed"})
		return
	}
	id := hex.EncodeToString(idBytes)
	exp := time.Now().Add(time.Duration(ttl) * time.Second).Unix()

	if err := os.WriteFile(filepath.Join(h.dir, id+".bin"), data, 0o600); err != nil {
		h.logger().Error("dl stage write failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stage failed"})
		return
	}
	name := sanitizeFilename(body.Filename)
	_ = os.WriteFile(filepath.Join(h.dir, id+".name"), []byte(name), 0o600)

	go h.gcExpired()

	url := strings.TrimRight(derivePublicURL(r), "/") + "/dl/" + signDLToken(secret, id, exp)
	h.logger().Info("dl staged", zap.Int("bytes", len(data)), zap.Int("ttlSeconds", ttl))
	writeJSON(w, http.StatusOK, map[string]any{"url": url, "expiresAt": exp})
}

// Serve — GET /dl/{token}. No auth: the token IS the capability.
func (h *DLHandler) Serve(w http.ResponseWriter, r *http.Request) {
	id, exp, ok := verifyDLToken(h.signingSecret(), r.PathValue("token"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if time.Now().Unix() > exp {
		h.removeID(id)
		http.Error(w, "link expired", http.StatusGone)
		return
	}
	f, err := os.Open(filepath.Join(h.dir, id+".bin"))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	name := "file"
	if b, err := os.ReadFile(filepath.Join(h.dir, id+".name")); err == nil && len(b) > 0 {
		name = string(b)
	}
	ct := mime.TypeByExtension(filepath.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Cache-Control", "no-store")
	h.logger().Info("dl served", zap.String("filename", name))
	_, _ = io.Copy(w, f)
}

var dlDevWarnOnce sync.Once

// authService gates /internal/dl/stage with the shared service token, matching
// the introspect fail-closed-in-prod posture.
func (h *DLHandler) authService(w http.ResponseWriter, r *http.Request) bool {
	expected := os.Getenv(dlServiceTokenEnv)
	if expected == "" {
		if IsProd() {
			h.logger().Warn("dl stage: LANTERN_GRPC_SERVICE_TOKEN unset — refusing (fail-closed in prod)")
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "dl staging disabled"})
			return false
		}
		dlDevWarnOnce.Do(func() {
			h.logger().Warn("dl stage: LANTERN_GRPC_SERVICE_TOKEN unset — allowing unauthenticated calls (dev only)")
		})
		return true
	}
	presented := r.Header.Get(middleware.ServiceTokenMetadataKey)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) != 1 {
		h.logger().Warn("dl stage: invalid service token")
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid service token"})
		return false
	}
	return true
}

// removeID deletes both sidecars for an id (best-effort).
func (h *DLHandler) removeID(id string) {
	_ = os.Remove(filepath.Join(h.dir, id+".bin"))
	_ = os.Remove(filepath.Join(h.dir, id+".name"))
}

// gcExpired walks the dir and drops files past the max TTL window. Cheap; the
// dir only holds in-flight links.
func (h *DLHandler) gcExpired() {
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-time.Duration(dlMaxTTLSeconds) * time.Second)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(h.dir, e.Name()))
		}
	}
}

func sanitizeFilename(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == '"' || r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	if len(name) > 128 {
		name = name[:128]
	}
	return name
}
