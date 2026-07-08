package handlers

import (
	"bytes"
	"context"
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
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"github.com/dshakes/lantern/services/control-plane/internal/storage"
	"go.uber.org/zap"
)

func dlObjectKey(id string) string { return "dl/" + id }

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

// blobStore is the subset of the object-storage client dl needs (interface for
// hermetic tests). *storage.Blob satisfies it.
type blobStore interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType, filename string) error
	Get(ctx context.Context, key string) (*storage.Object, error)
	Remove(ctx context.Context, key string) error
}

type DLHandler struct {
	srv    *server.Server
	dir    string // temp-dir fallback (used only when blob == nil)
	secret []byte
	blob   blobStore
}

func NewDLHandler(srv *server.Server) *DLHandler {
	dir := filepath.Join(os.TempDir(), "lantern-dl")
	_ = os.MkdirAll(dir, 0o700)
	h := &DLHandler{srv: srv, dir: dir, secret: resolveDLSecret()}
	if srv.Blob != nil { // avoid a typed-nil interface
		h.blob = srv.Blob
	}
	return h
}

// resolveDLSecret prefers a dedicated secret, then the shared service token.
// In PROD there is no fallback: a per-process random key can't verify tokens
// minted by a sibling replica, so an empty secret here makes Stage fail-closed
// (503) until a shared secret is configured. In dev (single instance) a random
// per-process key is fine — links just don't survive a restart.
func resolveDLSecret() []byte {
	if s := strings.TrimSpace(os.Getenv(dlSecretEnv)); s != "" {
		return []byte(s)
	}
	if s := strings.TrimSpace(os.Getenv(dlServiceTokenEnv)); s != "" {
		return []byte(s)
	}
	if IsProd() {
		return nil // fail-closed: force a configured shared secret in prod
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return []byte("lantern-dl-fallback-secret") // unreachable in practice
	}
	return b
}

func (h *DLHandler) logger() *zap.Logger { return h.srv.Logger.Named("dl") }

func (h *DLHandler) signingSecret() []byte { return h.secret }

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
// Accepts EITHER a raw streamed body (Content-Type not application/json; the
// optimized path — no base64, no full buffering, X-Filename + X-TTL-Seconds
// headers) OR a JSON {filename, contentB64, ttlSeconds} fallback for small
// dynamic content. Bytes go to shared object storage when configured; a local
// temp dir only as a single-instance-dev fallback.
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

	var (
		name   string
		ttl    int
		reader io.Reader
		size   int64
	)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
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
		name, ttl, reader, size = body.Filename, body.TTLSeconds, bytes.NewReader(data), int64(len(data))
	} else {
		// Raw streamed upload — the caller must set Content-Length so we can cap
		// size without buffering the whole file just to measure it.
		if r.ContentLength <= 0 {
			writeJSON(w, http.StatusLengthRequired, map[string]string{"error": "Content-Length required for raw upload"})
			return
		}
		if r.ContentLength > dlMaxBytes {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large"})
			return
		}
		name = r.Header.Get("X-Filename")
		ttl, _ = strconv.Atoi(r.Header.Get("X-TTL-Seconds"))
		reader, size = io.LimitReader(r.Body, r.ContentLength), r.ContentLength
	}

	name = sanitizeFilename(name)
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
	contentType := mime.TypeByExtension(filepath.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if h.blob != nil {
		if err := h.blob.Put(r.Context(), dlObjectKey(id), reader, size, contentType, name); err != nil {
			h.logger().Error("dl stage: object put failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stage failed"})
			return
		}
	} else {
		// Single-instance dev fallback: buffer + write to the temp dir.
		data, err := io.ReadAll(io.LimitReader(reader, dlMaxBytes+1))
		if err != nil || len(data) == 0 || len(data) > dlMaxBytes {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty or oversize upload"})
			return
		}
		if err := os.WriteFile(filepath.Join(h.dir, id+".bin"), data, 0o600); err != nil {
			h.logger().Error("dl stage write failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stage failed"})
			return
		}
		_ = os.WriteFile(filepath.Join(h.dir, id+".name"), []byte(name), 0o600)
		go h.gcExpired()
	}

	url := strings.TrimRight(derivePublicURL(r), "/") + "/dl/" + signDLToken(secret, id, exp)
	h.logger().Info("dl staged", zap.Int64("bytes", size), zap.Int("ttlSeconds", ttl), zap.Bool("objectStore", h.blob != nil))
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
		// Free the bytes immediately on an expired hit (the active sweep also
		// catches never-fetched-again links).
		if h.blob != nil {
			_ = h.blob.Remove(r.Context(), dlObjectKey(id))
		} else {
			h.removeID(id)
		}
		http.Error(w, "link expired", http.StatusGone)
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	if h.blob != nil {
		obj, err := h.blob.Get(r.Context(), dlObjectKey(id))
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer obj.Body.Close()
		name := obj.Filename
		if name == "" {
			name = "file"
		}
		ct := obj.ContentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Disposition", contentDisposition(name))
		h.logger().Info("dl served", zap.String("filename", name))
		_, _ = io.Copy(w, obj.Body)
		return
	}

	// Temp-dir fallback.
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
	w.Header().Set("Content-Disposition", contentDisposition(name))
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

// contentDisposition builds an attachment header that survives non-ASCII
// filenames (e.g. Telugu/Tamil doc names) per RFC 5987/6266: an ASCII fallback
// plus a percent-encoded UTF-8 filename*.
func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", ascii, url.PathEscape(name))
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
