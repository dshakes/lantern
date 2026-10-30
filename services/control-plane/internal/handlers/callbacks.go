package handlers

// callbacks.go — async completion callbacks for runs (ADR 0033).
//
// When POST /v1/runs includes a callbackUrl, the inline executor delivers one
// signed POST to that URL after the run reaches a terminal status
// (succeeded / failed / cancelled). The delivery is idempotent via
// claimSideEffect, SSRF-protected (private/loopback/link-local/metadata IPs
// blocked at dial time — DNS rebinding safe, HTTPS-only in prod), and retried
// with capped exponential backoff.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// callbackMaxAttempts is the number of delivery tries before giving up.
const callbackMaxAttempts = 4

// callbackBaseDelay is the initial backoff interval (doubled each attempt).
const callbackBaseDelay = 2 * time.Second

// callbackHTTPTimeout is the per-request timeout.
const callbackHTTPTimeout = 10 * time.Second

// callbackMaxBody is the max response body we read (discarded; just bounds memory).
const callbackMaxBody = 4096

// errSSRF is returned when the resolved URL is blocked for SSRF reasons.
var errSSRF = errors.New("callback URL blocked: target is a private/loopback/metadata address")

// callbackSigningSecret returns the per-tenant HMAC signing key.
// It is HMAC-SHA256(PAL_CALLBACK_SIGNING_SECRET, tenantID) so each tenant
// gets a distinct key without storing per-tenant secrets.
// Returns an error when PAL_CALLBACK_SIGNING_SECRET is unset; callers skip
// delivery in that case (startup guard ensures prod always has the secret set).
func callbackSigningSecret(tenantID string) ([]byte, error) {
	root := os.Getenv("PAL_CALLBACK_SIGNING_SECRET")
	if root == "" {
		if isProd() {
			// runStartupGuards() should have caught this; be defensive.
			return nil, fmt.Errorf("PAL_CALLBACK_SIGNING_SECRET is not configured — callback signing disabled")
		}
		// Dev: use a well-known insecure default so local testing works.
		root = "dev-callback-secret-do-not-use-in-production"
	}
	mac := hmac.New(sha256.New, []byte(root))
	mac.Write([]byte(tenantID))
	return mac.Sum(nil), nil
}

// checkSSRF validates that the URL is structurally valid and the scheme is
// acceptable. It does NOT perform DNS resolution — the actual IP check happens
// in the dial-time hook inside newCallbackHTTPClient, which pins the resolved
// address to prevent DNS rebinding (TOCTOU).
func checkSSRF(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid callback URL: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("callback URL must use http or https scheme")
	}
	if isProd() && scheme == "http" {
		return fmt.Errorf("callback URL must use https in production")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("callback URL has no host")
	}
	// Fast-path: if the host is already a literal IP address, block it now
	// without DNS resolution so creation-time validation is synchronous.
	if parsed := net.ParseIP(host); parsed != nil {
		if isBlockedIP(parsed) {
			return fmt.Errorf("callbacks: ssrf check: callback URL blocked: target is a private/loopback/metadata address (resolved %s → %s)", host, host)
		}
	}
	return nil
}

// isBlockedIP returns true for IPs that must never receive callbacks.
func isBlockedIP(ip net.IP) bool {
	blocked := []string{
		"0.0.0.0/8",      // unspecified / broadcast source
		"127.0.0.0/8",    // IPv4 loopback
		"::1/128",        // IPv6 loopback
		"10.0.0.0/8",     // RFC 1918
		"172.16.0.0/12",  // RFC 1918
		"192.168.0.0/16", // RFC 1918
		"169.254.0.0/16", // link-local / cloud metadata (169.254.169.254 lives here)
		"fc00::/7",       // IPv6 unique-local
		"fe80::/10",      // IPv6 link-local
	}
	for _, cidr := range blocked {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue // unreachable: all are valid CIDRs
		}
		if network.Contains(ip) {
			return true
		}
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

// newCallbackHTTPClient builds a per-delivery http.Client that:
//  1. Resolves the host at dial time and rejects private/loopback IPs (DNS-rebinding safe).
//  2. Pins the first safe resolved IP so subsequent dials re-use it without re-checking.
//  3. Blocks HTTP redirects (a redirect could point to an internal host).
func newCallbackHTTPClient(rawURL string) (*http.Client, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid callback URL: %w", err)
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "https":
			port = "443"
		default:
			port = "80"
		}
	}

	// Resolve once, check, pin the first safe address.
	addrs, lookupErr := net.DefaultResolver.LookupHost(context.Background(), host)
	if lookupErr != nil {
		if isProd() {
			return nil, fmt.Errorf("callback URL host %q does not resolve: %w", host, lookupErr)
		}
		// In dev/test allow unresolvable hosts (mock servers, docker aliases);
		// treat the raw hostname as the address so the dial attempt still fails
		// fast and the test stays hermetic.
		addrs = []string{host}
	}

	// Check every resolved IP against the blocklist.
	for _, a := range addrs {
		ip := net.ParseIP(a)
		if ip == nil {
			// Hostname passed through; skip IP check (dev-only fallback above).
			continue
		}
		if isBlockedIP(ip) {
			return nil, fmt.Errorf("%w (resolved %s → %s)", errSSRF, host, ip)
		}
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("callback URL host %q resolved to no addresses", host)
	}

	// Pin the first safe address so the actual dial does NOT re-invoke DNS.
	return pinnedCallbackClient(net.JoinHostPort(addrs[0], port)), nil
}

// pinnedCallbackClient dials only pinnedAddr (never re-resolving DNS) and
// refuses every redirect: a 3xx could point at an internal host that never
// passed the IP check (e.g. http://169.254.169.254/).
func pinnedCallbackClient(pinnedAddr string) *http.Client {
	transport := &http.Transport{
		DialContext: func(dialCtx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(dialCtx, network, pinnedAddr)
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: callbackHTTPTimeout,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   callbackHTTPTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return fmt.Errorf("callback: HTTP redirects are not allowed (SSRF)")
		},
	}
}

// callbackPayload is the JSON body delivered to the callbackUrl.
type callbackPayload struct {
	RunID     string  `json:"runId"`
	Status    string  `json:"status"`
	Output    string  `json:"output,omitempty"`
	Error     string  `json:"error,omitempty"`
	CostUSD   float64 `json:"costUsd"`
	TokensIn  int64   `json:"tokensIn"`
	TokensOut int64   `json:"tokensOut"`
	BatchID   string  `json:"batchId,omitempty"`
}

// deliverCallbackVia sends one signed POST using the provided http.Client.
// It is the inner function that handles signing, serialisation, and response
// classification. Callers are responsible for supplying an SSRF-safe client.
//
// Returns a wrapped "retryable" error for transient failures (5xx, network),
// nil for final results (2xx, 4xx), and a non-retryable error for signing or
// marshal failures.
//
// This is the function unit tests call directly (with a plain client pointed at
// httptest.Server). deliverCallback wraps it with SSRF validation.
func deliverCallbackVia(ctx context.Context, client *http.Client, payload callbackPayload, tenantID, callbackURL string) error {
	secret, err := callbackSigningSecret(tenantID)
	if err != nil {
		// Secret not configured — skip rather than delivering unsigned.
		return fmt.Errorf("callbacks: signing secret unavailable: %w", err)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("callbacks: marshal payload: %w", err)
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("callbacks: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pal-Signature", "v1="+sig)
	req.Header.Set("X-Pal-Run-ID", payload.RunID)

	resp, err := client.Do(req)
	if err != nil {
		// Network errors (dial, TLS, read timeout) are transient.
		var netErr net.Error
		if errors.As(err, &netErr) || isNetworkError(err) {
			return fmt.Errorf("callbacks: http do (retryable): %w", err)
		}
		return fmt.Errorf("callbacks: http do: %w", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, callbackMaxBody)
	_, _ = resp.Body.Read(buf)

	if resp.StatusCode >= 500 {
		return fmt.Errorf("callbacks: receiver returned %d (retryable)", resp.StatusCode)
	}
	// 2xx and 4xx are treated as final (caller's problem; don't retry 4xx).
	return nil
}

// deliverCallback is the production entry point: builds an SSRF-safe client
// (DNS resolved + pinned at creation, redirects blocked) then delegates to
// deliverCallbackVia. The two-function split lets unit tests exercise the
// signing/body/status-code logic via deliverCallbackVia directly (with a
// plain httptest.Server client) without defeating the SSRF guarantee.
func deliverCallback(ctx context.Context, payload callbackPayload, tenantID, callbackURL string) error {
	client, err := newCallbackHTTPClient(callbackURL)
	if err != nil {
		return fmt.Errorf("callbacks: ssrf check: %w", err)
	}
	return deliverCallbackVia(ctx, client, payload, tenantID, callbackURL)
}

// isNetworkError returns true for url.Error wrapping a net.OpError or ECONNREFUSED,
// i.e., transient dial/read errors that benefit from a retry.
func isNetworkError(err error) bool {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		var opErr *net.OpError
		if errors.As(urlErr.Err, &opErr) {
			return true
		}
	}
	return false
}

// fireCallbackForRun reads the terminal run state from the DB and dispatches
// the callback in a background goroutine (non-blocking for the caller).
// No-ops when callback_url is NULL or the run is not yet terminal.
// rls-exempt: keyed by the authorized run id; no tenant GUC needed since
// this runs inside the inline executor's detached goroutine context.
func (h *RESTHandler) fireCallbackForRun(ctx context.Context, pool *pgxpool.Pool, runID string, log *zap.Logger) {
	var (
		callbackURL *string
		status      string
		outputRaw   []byte
		errorRaw    []byte
		costUSD     float64
		tokensIn    int64
		tokensOut   int64
		batchID     *string
		tenantID    string
	)
	err := pool.QueryRow(ctx, `
		SELECT tenant_id, callback_url, status,
		       output::text,
		       error::text,
		       COALESCE(cost_usd, 0),
		       COALESCE(tokens_in, 0),
		       COALESCE(tokens_out, 0),
		       batch_id::text
		FROM runs WHERE id = $1
	`, runID).Scan(&tenantID, &callbackURL, &status, &outputRaw, &errorRaw, &costUSD, &tokensIn, &tokensOut, &batchID)
	if err != nil || callbackURL == nil || *callbackURL == "" {
		return
	}

	// Extract the result string from {"result": "..."} — omit field if NULL.
	var outputStr string
	if len(outputRaw) > 0 {
		var outputMap map[string]any
		if json.Unmarshal(outputRaw, &outputMap) == nil {
			if r, ok := outputMap["result"].(string); ok {
				outputStr = r
			}
		}
	}
	var errStr string
	if len(errorRaw) > 0 {
		var errMap map[string]any
		if json.Unmarshal(errorRaw, &errMap) == nil {
			if m, ok := errMap["message"].(string); ok {
				errStr = m
			}
		}
	}
	batchIDStr := ""
	if batchID != nil {
		batchIDStr = *batchID
	}

	payload := callbackPayload{
		RunID:     runID,
		Status:    status,
		Output:    outputStr,
		Error:     errStr,
		CostUSD:   costUSD,
		TokensIn:  tokensIn,
		TokensOut: tokensOut,
		BatchID:   batchIDStr,
	}
	cbURL := *callbackURL

	h.inFlightRuns.Add(1)
	go func() {
		defer h.inFlightRuns.Done()
		h.deliverCallbackWithRetry(ctx, pool, runID, tenantID, cbURL, payload, log)
	}()
}

// deliverCallbackWithRetry claims the side effect (idempotency) and retries
// delivery with capped exponential backoff.
//
// The SSRF-safe HTTP client is built ONCE before the retry loop. This means:
//   - DNS resolution happens once (a transient DNS failure is non-retryable —
//     the URL is undeliverable until the next invocation via re-drive).
//   - Subsequent retry attempts re-use the pinned IP, so they only fail on
//     actual network/HTTP errors; those ARE tagged "retryable" by
//     deliverCallbackVia and will be retried.
func (h *RESTHandler) deliverCallbackWithRetry(
	ctx context.Context,
	pool *pgxpool.Pool,
	runID, tenantID, callbackURL string,
	payload callbackPayload,
	log *zap.Logger,
) {
	if callbackURL == "" {
		return
	}
	// Structural + scheme check (fast, no DNS).
	if err := checkSSRF(callbackURL); err != nil {
		log.Warn("callback URL blocked (SSRF pre-check)", zap.String("run_id", runID), zap.Error(err))
		return
	}

	idemKey := idempotencyKey(runID, "callback", 1)
	claimed, claimErr := claimSideEffect(ctx, pool, idemKey, runID, tenantID, "callback")
	if claimErr != nil {
		log.Warn("callback: side-effect claim error — delivering anyway",
			zap.String("run_id", runID), zap.Error(claimErr))
	} else if !claimed {
		log.Info("callback: already delivered (idempotent skip)", zap.String("run_id", runID))
		return
	}

	// Build the SSRF-safe pinned client once — resolves DNS, checks every IP,
	// pins the first safe address, and blocks redirects. A failure here means
	// the URL is permanently undeliverable; don't waste retries on it.
	client, clientErr := newCallbackHTTPClient(callbackURL)
	if clientErr != nil {
		log.Warn("callback: SSRF-safe client build failed (giving up)",
			zap.String("run_id", runID), zap.Error(clientErr))
		return
	}

	var lastErr error
	for attempt := 0; attempt < callbackMaxAttempts; attempt++ {
		if attempt > 0 {
			delay := callbackBaseDelay * (1 << uint(attempt-1))
			// Add ±25% jitter.
			jitter := time.Duration(rand.Int63n(int64(delay) / 2)) //nolint:gosec // low-stakes jitter
			delay = delay + jitter - delay/4
			select {
			case <-ctx.Done():
				log.Info("callback: context done, aborting retries", zap.String("run_id", runID))
				return
			case <-time.After(delay):
			}
		}
		// Use deliverCallbackVia with the pinned client. Network errors and 5xx
		// are returned as "retryable"-tagged errors; 2xx/4xx/signing errors are
		// final. This avoids the bug where deliverCallback re-resolves DNS on
		// every retry attempt, causing transient DNS failures to look like
		// permanent SSRF blocks rather than retryable transient errors.
		if err := deliverCallbackVia(ctx, client, payload, tenantID, callbackURL); err != nil {
			lastErr = err
			log.Warn("callback delivery attempt failed",
				zap.String("run_id", runID),
				zap.Int("attempt", attempt+1),
				zap.Error(err),
			)
			// Only retry transient failures tagged "retryable" (network errors, 5xx).
			// Signing/marshal errors are permanent.
			if strings.Contains(err.Error(), "retryable") {
				continue
			}
			return
		}
		log.Info("callback delivered", zap.String("run_id", runID), zap.String("url", callbackURL))
		return
	}
	log.Error("callback delivery exhausted retries",
		zap.String("run_id", runID),
		zap.String("url", callbackURL),
		zap.NamedError("last_error", lastErr),
	)
}
