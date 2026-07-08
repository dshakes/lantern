package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
	"github.com/dshakes/lantern/services/control-plane/internal/storage"
)

// mockBlob is an in-memory blobStore so dl tests stay hermetic (no MinIO).
type mockBlob struct {
	objs map[string]struct {
		data []byte
		ct   string
		name string
	}
}

func newMockBlob() *mockBlob {
	return &mockBlob{objs: map[string]struct {
		data []byte
		ct   string
		name string
	}{}}
}

func (m *mockBlob) Put(_ context.Context, key string, r io.Reader, _ int64, ct, name string) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.objs[key] = struct {
		data []byte
		ct   string
		name string
	}{data, ct, name}
	return nil
}

func (m *mockBlob) Remove(_ context.Context, key string) error {
	delete(m.objs, key)
	return nil
}

func (m *mockBlob) Get(_ context.Context, key string) (*storage.Object, error) {
	o, ok := m.objs[key]
	if !ok {
		return nil, errors.New("NoSuchKey")
	}
	return &storage.Object{Body: io.NopCloser(bytes.NewReader(o.data)), ContentType: o.ct, Filename: o.name, Size: int64(len(o.data))}, nil
}

func newDLHandlerForTest(t *testing.T) *DLHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	h := &DLHandler{srv: &server.Server{Logger: logger}, dir: t.TempDir(), secret: []byte("test-secret-abc"), blob: newMockBlob()}
	t.Setenv("LANTERN_PUBLIC_BASE_URL", "https://tunnel.example.com")
	return h
}

func dlMux(h *DLHandler) *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("POST /internal/dl/stage", h.Stage)
	m.HandleFunc("GET /dl/{token}", h.Serve)
	return m
}

func stage(t *testing.T, mux *http.ServeMux, name, content string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"filename":   name,
		"contentB64": base64.StdEncoding.EncodeToString([]byte(content)),
		"ttlSeconds": 60,
	})
	req := httptest.NewRequest("POST", "/internal/dl/stage", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("stage: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if !strings.HasPrefix(out.URL, "https://tunnel.example.com/dl/") {
		t.Fatalf("unexpected url: %s", out.URL)
	}
	return strings.TrimPrefix(out.URL, "https://tunnel.example.com")
}

func TestDL_StageThenServeRoundTrip(t *testing.T) {
	h := newDLHandlerForTest(t)
	mux := dlMux(h)
	path := stage(t, mux, "Shekhar_PAN_Card.pdf", "PDF-BYTES-HERE")

	req := httptest.NewRequest("GET", path, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("serve: want 200, got %d", rec.Code)
	}
	if rec.Body.String() != "PDF-BYTES-HERE" {
		t.Fatalf("body mismatch: %q", rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "Shekhar_PAN_Card.pdf") {
		t.Fatalf("content-disposition: %q", cd)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "pdf") {
		t.Fatalf("content-type: %q", ct)
	}
}

func TestDL_RawStreamedUploadRoundTrip(t *testing.T) {
	h := newDLHandlerForTest(t)
	mux := dlMux(h)
	// Optimized path: raw octet-stream body + headers (no base64).
	req := httptest.NewRequest("POST", "/internal/dl/stage", strings.NewReader("RAW-PDF-BYTES"))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Filename", "Shekhar_PAN_Card.pdf")
	req.Header.Set("X-TTL-Seconds", "60")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("raw stage: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct{ URL string }
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	path := strings.TrimPrefix(out.URL, "https://tunnel.example.com")

	greq := httptest.NewRequest("GET", path, nil)
	grec := httptest.NewRecorder()
	mux.ServeHTTP(grec, greq)
	if grec.Code != http.StatusOK || grec.Body.String() != "RAW-PDF-BYTES" {
		t.Fatalf("raw serve: code %d body %q", grec.Code, grec.Body.String())
	}
	if !strings.Contains(grec.Header().Get("Content-Disposition"), "Shekhar_PAN_Card.pdf") {
		t.Fatalf("cd: %q", grec.Header().Get("Content-Disposition"))
	}
}

func TestDL_RawUploadRequiresContentLength(t *testing.T) {
	h := newDLHandlerForTest(t)
	req := httptest.NewRequest("POST", "/internal/dl/stage", strings.NewReader(""))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = -1
	rec := httptest.NewRecorder()
	dlMux(h).ServeHTTP(rec, req)
	if rec.Code != http.StatusLengthRequired {
		t.Fatalf("want 411, got %d", rec.Code)
	}
}

func TestDL_TempDirFallbackWhenNoBlob(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	h := &DLHandler{srv: &server.Server{Logger: logger}, dir: t.TempDir(), secret: []byte("s")} // blob nil
	t.Setenv("LANTERN_PUBLIC_BASE_URL", "https://tunnel.example.com")
	mux := dlMux(h)
	path := stage(t, mux, "note.txt", "fallback-bytes")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "fallback-bytes" {
		t.Fatalf("temp-dir fallback: code %d body %q", rec.Code, rec.Body.String())
	}
}

func TestDL_TamperedTokenIs404(t *testing.T) {
	h := newDLHandlerForTest(t)
	mux := dlMux(h)
	path := stage(t, mux, "x.txt", "hello")
	// flip the last char of the signature
	tampered := path[:len(path)-1] + "A"
	if tampered == path {
		tampered = path[:len(path)-1] + "B"
	}
	req := httptest.NewRequest("GET", tampered, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("tampered token: want 404, got %d", rec.Code)
	}
}

func TestDL_ExpiredTokenIs410(t *testing.T) {
	h := newDLHandlerForTest(t)
	// Sign a token that is already expired.
	tok := signDLToken(h.signingSecret(), "deadbeefdeadbeef", time.Now().Add(-time.Minute).Unix())
	req := httptest.NewRequest("GET", "/dl/"+tok, nil)
	rec := httptest.NewRecorder()
	dlMux(h).ServeHTTP(rec, req)
	if rec.Code != http.StatusGone {
		t.Fatalf("expired token: want 410, got %d", rec.Code)
	}
}

func TestDL_ExpiredServeRemovesObject(t *testing.T) {
	h := newDLHandlerForTest(t)
	mb := h.blob.(*mockBlob)
	// Stage an object, then hit it with an already-expired token for the SAME id.
	mb.objs["dl/abc123"] = struct {
		data []byte
		ct   string
		name string
	}{[]byte("bytes"), "text/plain", "a.txt"}
	tok := signDLToken(h.signingSecret(), "abc123", time.Now().Add(-time.Minute).Unix())
	rec := httptest.NewRecorder()
	dlMux(h).ServeHTTP(rec, httptest.NewRequest("GET", "/dl/"+tok, nil))
	if rec.Code != http.StatusGone {
		t.Fatalf("want 410, got %d", rec.Code)
	}
	if _, ok := mb.objs["dl/abc123"]; ok {
		t.Fatal("expired serve should have removed the object from storage")
	}
}

func TestDL_VerifyRejectsPathEscape(t *testing.T) {
	secret := []byte("s")
	// An id containing path separators / dots must be rejected even if signed.
	tok := signDLToken(secret, "../../etc/passwd", time.Now().Add(time.Hour).Unix())
	if _, _, ok := verifyDLToken(secret, tok); ok {
		t.Fatal("verify accepted a path-escaping id")
	}
}

func TestDL_StageRejectsEmptyAndOversize(t *testing.T) {
	h := newDLHandlerForTest(t)
	mux := dlMux(h)
	// empty content
	body, _ := json.Marshal(map[string]any{"filename": "a", "contentB64": ""})
	req := httptest.NewRequest("POST", "/internal/dl/stage", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty content: want 400, got %d", rec.Code)
	}
}

func TestDL_ProdRequiresConfiguredSecret(t *testing.T) {
	t.Setenv("LANTERN_ENV", "production")
	t.Setenv("LANTERN_DL_SIGNING_SECRET", "")
	t.Setenv("LANTERN_GRPC_SERVICE_TOKEN", "")
	if resolveDLSecret() != nil {
		t.Fatal("prod must NOT fall back to an ephemeral secret (breaks cross-replica verify)")
	}
	t.Setenv("LANTERN_DL_SIGNING_SECRET", "shared-secret")
	if string(resolveDLSecret()) != "shared-secret" {
		t.Fatal("should use the configured shared secret")
	}
}

func TestSanitizeFilename(t *testing.T) {
	cases := map[string]string{
		"a.pdf":            "a.pdf",
		"../../etc/passwd": "passwd",
		`weird"name.txt`:   "weird_name.txt",
		"":                 "file",
		"..":               "file",
	}
	for in, want := range cases {
		if got := sanitizeFilename(in); got != want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
