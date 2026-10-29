package handlers

// callbacks.go — async completion callbacks for runs (ADR 0033).
//
// When POST /v1/runs includes a callbackUrl, the inline executor delivers one
// signed POST to that URL after the run reaches a terminal status
// (succeeded / failed / cancelled). The delivery is idempotent via
// claimSideEffect, SSRF-protected (private/loopback/link-local/metadata IPs
// blocked, HTTPS-only in prod), and retried with capped exponential backoff.

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
// ponytail: 4 tries with exponential backoff tops out at ~1 min of retry,
// enough for transient receiver hiccups; a full retry framework is overkill
// for fire-and-forget callback delivery.
const callbackMaxAttempts = 4

// callbackBaseDelay is the initial backoff interval (doubled each attempt).
const callbackBaseDelay = 2 * time.Second

// callbackHTTPTimeout is the per-request timeout.
const callbackHTTPTimeout = 10 * time.Second

// callbackMaxBody is the max response body we read (discarded; just bounds memory).
const callbackMaxBody = 4096

// errSSRF is returned when the resolved URL is blocked for SSRF reasons.
var errSSRF = errors.New("callback URL blocked: target is a private/loopback/metadata address")

// cbHTTPClient is the shared transport used for callback delivery. The default
// transport does NOT skip TLS verification. Replaced in tests.
var cbHTTPClient = &http.Client{
	Timeout: callbackHTTPTimeout,
}

// callbackSigningSecret returns the per-tenant signing secret.
// It is HMAC-SHA256(PAL_CALLBACK_SIGNING_SECRET, tenantID) so each tenant
// has a distinct secret without storing one per tenant.
// Falls back to a dev constant when the env var is unset (never in prod —
// IsProd() checks that the env var is present at startup).
func callbackSigningSecret(tenantID string) []byte {
	root := os.Getenv("PAL_CALLBACK_SIGNING_SECRET")
	if root == "" {
		root = os.Getenv("LANTERN_CALLBACK_SIGNING_SECRET")
	}
	if root == "" {
		root = "dev-callback-secret-do-not-use-in-production"
	}
	mac := hmac.New(sha256.New, []byte(root))
	mac.Write([]byte(tenantID))
	return mac.Sum(nil)
}

// checkSSRF validates that the parsed URL is safe to deliver to.
// Blocks:
//   - non-http/https schemes
//   - http in production (HTTPS only)
//   - loopback, link-local, private ranges (RFC 1918 / RFC 4193 / 169.254.0.0/16)
//   - the AWS/GCP metadata endpoint (169.254.169.254)
//
// DNS resolution is performed so a DNS rebinding attack cannot sneak a private
// IP past the scheme check.
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

	// Resolve the host to its IP addresses and check each one.
	addrs, err := net.LookupHost(host)
	if err != nil {
		// In dev/test, accept unresolvable hosts (mock servers, docker aliases).
		// In prod, reject: an unresolvable host is not a safe delivery target.
		if isProd() {
			return fmt.Errorf("callback URL host %q does not resolve: %w", host, err)
		}
		// dev: also check the literal if it looks like an IP.
		addrs = []string{host}
	}

	for _, addr := range addrs {
		ip := net.ParseIP(addr)
		if ip == nil {
			continue
		}
		if isBlockedIP(ip) {
			return errSSRF
		}
	}
	return nil
}

// isBlockedIP returns true for IPs that must never receive callbacks.
func isBlockedIP(ip net.IP) bool {
	blocked := []string{
		"127.0.0.0/8",    // loopback
		"::1/128",        // IPv6 loopback
		"10.0.0.0/8",     // RFC 1918
		"172.16.0.0/12",  // RFC 1918
		"192.168.0.0/16", // RFC 1918
		"169.254.0.0/16", // link-local / metadata
		"fc00::/7",       // IPv6 unique-local
		"fe80::/10",      // IPv6 link-local
	}
	for _, cidr := range blocked {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue // unreachable: these are all valid CIDRs
		}
		if network.Contains(ip) {
			return true
		}
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
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

// deliverCallback fires one HTTP POST to callbackURL with the run result,
// signed with HMAC-SHA256 under the per-tenant secret.
// Header: X-Lantern-Signature: v1=<hex>  (same scheme as the generic trigger format)
// Callers are responsible for SSRF validation before calling this function.
func deliverCallback(ctx context.Context, payload callbackPayload, tenantID, callbackURL string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("callbacks: marshal payload: %w", err)
	}

	secret := callbackSigningSecret(tenantID)
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("callbacks: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lantern-Signature", "v1="+sig)
	req.Header.Set("X-Lantern-Run-ID", payload.RunID)

	resp, err := cbHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("callbacks: http do: %w", err)
	}
	defer resp.Body.Close()
	// Drain up to callbackMaxBody so the connection can be reused.
	buf := make([]byte, callbackMaxBody)
	_, _ = resp.Body.Read(buf)

	if resp.StatusCode >= 500 {
		return fmt.Errorf("callbacks: receiver returned %d (retryable)", resp.StatusCode)
	}
	// 2xx and 4xx are treated as final (caller's problem; don't retry 4xx).
	return nil
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
		       COALESCE(output, 'null')::text,
		       COALESCE(error, 'null')::text,
		       COALESCE(cost_usd, 0),
		       COALESCE(tokens_in, 0),
		       COALESCE(tokens_out, 0),
		       batch_id::text
		FROM runs WHERE id = $1
	`, runID).Scan(&tenantID, &callbackURL, &status, &outputRaw, &errorRaw, &costUSD, &tokensIn, &tokensOut, &batchID)
	if err != nil || callbackURL == nil || *callbackURL == "" {
		return
	}

	// Extract the result string from {"result": "..."} for a clean payload.
	var outputStr string
	var outputMap map[string]any
	if json.Unmarshal(outputRaw, &outputMap) == nil {
		if r, ok := outputMap["result"].(string); ok {
			outputStr = r
		} else {
			outputStr = string(outputRaw)
		}
	}
	var errStr string
	var errMap map[string]any
	if json.Unmarshal(errorRaw, &errMap) == nil {
		if m, ok := errMap["message"].(string); ok {
			errStr = m
		} else if len(errorRaw) > 0 && string(errorRaw) != "null" {
			errStr = string(errorRaw)
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

// deliverCallbackWithRetry is called from executeRunInline after a run reaches
// terminal state. It claims the side effect (idempotency) and then retries
// delivery with capped exponential backoff before giving up.
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
	if err := checkSSRF(callbackURL); err != nil {
		log.Warn("callback URL blocked (SSRF)", zap.String("run_id", runID), zap.Error(err))
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
		if err := deliverCallback(ctx, payload, tenantID, callbackURL); err != nil {
			lastErr = err
			log.Warn("callback delivery attempt failed",
				zap.String("run_id", runID),
				zap.Int("attempt", attempt+1),
				zap.Error(err),
			)
			// Non-retryable errors (SSRF, 4xx, marshal) — give up immediately.
			if !strings.Contains(err.Error(), "retryable") {
				return
			}
			continue
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
