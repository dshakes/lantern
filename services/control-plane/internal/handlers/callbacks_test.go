package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// ---------- checkSSRF unit tests ----------

func TestCheckSSRF_RejectsBadScheme(t *testing.T) {
	cases := []struct {
		url     string
		wantErr bool
	}{
		{"https://example.com/cb", false},
		{"http://example.com/cb", false}, // ok in dev
		{"ftp://example.com/cb", true},   // not http/https
		{"", true},                       // empty
		{"javascript:alert(1)", true},    // not http/https
	}
	for _, tc := range cases {
		err := checkSSRF(tc.url)
		if tc.wantErr && err == nil {
			t.Errorf("checkSSRF(%q): expected error, got nil", tc.url)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("checkSSRF(%q): unexpected error: %v", tc.url, err)
		}
	}
}

func TestCheckSSRF_RejectsPrivateIPs(t *testing.T) {
	cases := []string{
		"http://127.0.0.1/cb",
		"http://127.0.0.2/cb",
		"http://10.0.0.1/cb",
		"http://172.16.0.1/cb",
		"http://192.168.1.1/cb",
		"http://169.254.169.254/cb", // metadata
		"http://[::1]/cb",           // IPv6 loopback
	}
	for _, rawURL := range cases {
		// checkSSRF only checks scheme/host structure; IP check is in newCallbackHTTPClient.
		// For raw IPs, newCallbackHTTPClient catches them. Verify that here.
		_, err := newCallbackHTTPClient(rawURL)
		if err == nil {
			t.Errorf("newCallbackHTTPClient(%q): expected SSRF error, got nil", rawURL)
		}
	}
}

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255",
		"192.168.0.1", "169.254.169.254", "::1", "fe80::1",
	}
	for _, ipStr := range blocked {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			t.Fatalf("ParseIP(%q) returned nil", ipStr)
		}
		if !isBlockedIP(ip) {
			t.Errorf("isBlockedIP(%q) = false, want true", ipStr)
		}
	}

	public := []string{"8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"}
	for _, ipStr := range public {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			t.Fatalf("ParseIP(%q) returned nil", ipStr)
		}
		if isBlockedIP(ip) {
			t.Errorf("isBlockedIP(%q) = true, want false", ipStr)
		}
	}
}

// ---------- deliverCallbackVia unit tests ----------
//
// These tests call deliverCallbackVia with a plain http.Client that has no SSRF
// guard, so they can use httptest.Server (127.0.0.1). SSRF enforcement is tested
// separately via newCallbackHTTPClient and deliverCallback below.

func TestDeliverCallback_SignatureAndBody(t *testing.T) {
	var gotBody []byte
	var gotSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotSig = r.Header.Get("X-Pal-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	payload := callbackPayload{
		RunID:  "run-123",
		Status: "succeeded",
		Output: "hello",
	}
	// Use deliverCallbackVia with a plain client — tests the signing + body logic
	// without going through the SSRF guard (which blocks 127.0.0.1).
	plain := &http.Client{Timeout: callbackHTTPTimeout}
	if err := deliverCallbackVia(context.Background(), plain, payload, "tenant-1", srv.URL+"/cb"); err != nil {
		t.Fatalf("deliverCallbackVia: %v", err)
	}

	// Verify body is valid JSON with the right fields.
	var got callbackPayload
	if err := json.Unmarshal(gotBody, &got); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if got.RunID != "run-123" {
		t.Errorf("runId = %q, want 'run-123'", got.RunID)
	}
	if got.Status != "succeeded" {
		t.Errorf("status = %q, want 'succeeded'", got.Status)
	}

	// Verify signature header is present and in the right format.
	if gotSig == "" {
		t.Fatal("X-Pal-Signature header missing")
	}
	if len(gotSig) < 4 || gotSig[:3] != "v1=" {
		t.Errorf("signature header format wrong: %q", gotSig)
	}
}

func TestDeliverCallback_5xxRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	plain := &http.Client{Timeout: callbackHTTPTimeout}
	err := deliverCallbackVia(context.Background(), plain, callbackPayload{RunID: "r"}, "t", srv.URL)
	if err == nil {
		t.Fatal("expected error for 5xx, got nil")
	}
	if !strings.Contains(err.Error(), "retryable") {
		t.Errorf("error %q does not contain 'retryable'", err.Error())
	}
}

func TestDeliverCallback_4xxNotRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	// 4xx is treated as a final delivery (receiver rejected it).
	plain := &http.Client{Timeout: callbackHTTPTimeout}
	err := deliverCallbackVia(context.Background(), plain, callbackPayload{RunID: "r"}, "t", srv.URL)
	if err != nil {
		t.Errorf("expected nil for 4xx (final delivery), got %v", err)
	}
}

// TestDeliverCallback_SSRFBlock tests that deliverCallback (the production path)
// blocks a loopback address at dial time via newCallbackHTTPClient — not merely
// as a side-effect of a closed port.
func TestDeliverCallback_SSRFBlock(t *testing.T) {
	// This must return an error wrapping errSSRF (blocked IP), regardless of
	// whether any port is open on 127.0.0.1.
	err := deliverCallback(context.Background(), callbackPayload{RunID: "r"}, "t", "http://127.0.0.1/cb")
	if err == nil {
		t.Fatal("expected SSRF error for loopback, got nil")
	}
	if !strings.Contains(err.Error(), "ssrf") && !strings.Contains(err.Error(), "SSRF") && !strings.Contains(err.Error(), "blocked") {
		t.Errorf("error %q should mention SSRF or blocked, but does not", err.Error())
	}
}

// TestNewCallbackHTTPClient_RedirectsBlocked drives a real delivery through
// the production client (pinnedCallbackClient, as built by
// newCallbackHTTPClient) at a receiver that 302s elsewhere, and asserts the
// redirect target is never contacted and the delivery reports an error.
func TestNewCallbackHTTPClient_RedirectsBlocked(t *testing.T) {
	t.Setenv("PAL_CALLBACK_SIGNING_SECRET", "test-secret")
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/cb", http.StatusFound)
	}))
	defer redirector.Close()

	client := pinnedCallbackClient(redirector.Listener.Addr().String())
	err := deliverCallbackVia(context.Background(), client,
		callbackPayload{RunID: "run-redirect", Status: "succeeded"}, "tenant-x", redirector.URL+"/cb")
	if err == nil || !strings.Contains(err.Error(), "redirects are not allowed") {
		t.Fatalf("delivery through a redirect must fail with the SSRF redirect error, got %v", err)
	}
	if n := targetHits.Load(); n != 0 {
		t.Fatalf("redirect target was contacted %d time(s); redirects must never be followed", n)
	}
}
