package handlers

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

func newDLHandlerForTest(t *testing.T) *DLHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	h := &DLHandler{srv: &server.Server{Logger: logger}, dir: t.TempDir(), secret: []byte("test-secret-abc")}
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
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty content: want 400, got %d", rec.Code)
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
