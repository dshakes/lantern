package handlers

// runtime_secrets.go — POST /v1/runtime/secrets/resolve
//
// This endpoint allows the runtime-manager to resolve lantern.secret/... refs
// into plaintext credential values on behalf of a specific VM and its tenant.
// See docs/adr/0008-runtime-secret-relay.md for the full design rationale.
//
// # Ref grammar
//
// Three sub-types are supported:
//
//	lantern.secret/llm/<provider>
//	    Resolves api_key_encrypted from llm_provider_configs for the tenant +
//	    provider. Provider examples: "anthropic", "openai", "gemini".
//
//	lantern.secret/connector/<install_id>/<config_key>
//	    Resolves the string value at config_key inside the decrypted config JSONB
//	    blob from connector_installs for the tenant + install UUID.
//	    install_id must be a valid UUID; only top-level string values are
//	    supported.
//
//	lantern.secret/connector/<install_id>/oauth
//	    Resolves oauth_token_encrypted (JSONB) for the named connector install.
//	    Returns the raw decrypted JSON string (the entire token blob).
//	    The reserved key name "oauth" is distinguished from ordinary config keys
//	    because it reads a separate column.
//
// Unknown or malformed refs return per-ref {"error": "not found"} — the endpoint
// intentionally does not distinguish "does not exist" from "belongs to another
// tenant" (no tenant-existence oracle).
//
// # Authentication
//
// Service-to-service auth uses a pre-shared token in the
// X-Lantern-Runtime-Token request header. The token bytes are SHA-256-hashed
// before comparison so that crypto/subtle.ConstantTimeCompare operates on
// fixed-size inputs (eliminates length-based timing side-channel).
//
// FAIL-CLOSED: if LANTERN_RUNTIME_SECRET_TOKEN is unset, the endpoint returns
// 403 {"error":"relay disabled"} for every call regardless of the token
// supplied. The feature is off by default; a deployment with no token
// configured cannot be used as a credential oracle.
//
// # Brute-force protection
//
// Authentication FAILURES are rate-limited per remote IP: max
// secretAuthFailMax failures per secretAuthFailWindow. Excess attempts return
// 429 Too Many Requests. Uses a goroutine-safe in-process sliding-window map
// (no Redis dependency — the endpoint must remain fully operational even if
// Redis is unavailable, and the expected call volume from a small number of
// manager IPs makes a local map adequate).
//
// # Body limits
//
// Request body is capped at 64 KiB. refs array is capped at 64 entries.
//
// # Audit
//
// Every request (post-auth) writes one runtime_audit_events row with:
//   - action = "secret_resolve"
//   - vm_id from the request body
//   - attrs = {ref_names: [...], resolved_count: N}
//
// Secret VALUES are never logged, traced, or written to the audit attrs.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const (
	// envRuntimeSecretToken is the environment variable that holds the
	// pre-shared service token for the runtime-manager → control-plane relay.
	envRuntimeSecretToken = "LANTERN_RUNTIME_SECRET_TOKEN"

	// runtimeTokenHeader is the HTTP header name carrying the service token.
	runtimeTokenHeader = "X-Lantern-Runtime-Token"

	// secretRefPrefix is the required prefix for every ref.
	secretRefPrefix = "lantern.secret/"

	// secretBodyLimit caps the request body at 64 KiB to prevent DoS via
	// unbounded body reads.
	secretBodyLimit = 64 << 10 // 64 KiB

	// secretMaxRefs is the maximum number of refs per request.
	secretMaxRefs = 64

	// secretAuthFailMax is the maximum number of auth failures per IP per
	// secretAuthFailWindow before the IP is rate-limited.
	secretAuthFailMax = 10

	// secretAuthFailWindow is the sliding window for auth-failure counting.
	secretAuthFailWindow = time.Minute
)

// RuntimeSecretsHandler exposes POST /v1/runtime/secrets/resolve.
// It is intentionally separate from RuntimeHandler so the surface area of
// credential-touching code is minimal and easy to audit.
type RuntimeSecretsHandler struct {
	srv      *server.Server
	auth     *AuthHandler // kept for access to srv; route auth is token-based
	identity *agentidentity.Issuer

	// authFailMu guards authFailures.
	authFailMu sync.Mutex
	// authFailures tracks per-IP auth failure timestamps for brute-force
	// protection. Entries older than secretAuthFailWindow are pruned on write.
	authFailures map[string][]time.Time
}

// NewRuntimeSecretsHandler constructs a RuntimeSecretsHandler.
func NewRuntimeSecretsHandler(srv *server.Server, auth *AuthHandler) *RuntimeSecretsHandler {
	return &RuntimeSecretsHandler{
		srv:          srv,
		auth:         auth,
		identity:     agentidentity.New(auth.JWTSecret()),
		authFailures: make(map[string][]time.Time),
	}
}

func (h *RuntimeSecretsHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("runtime_secrets")
}

// ---------- Request / response DTOs ----------

type resolveSecretsRequest struct {
	TenantID string   `json:"tenant_id"`
	VmID     string   `json:"vm_id"`
	Refs     []string `json:"refs"`
}

// resolvedRef is one entry in the response slice.
// Exactly one of Value/Error is set.
type resolvedRef struct {
	Ref   string `json:"ref"`
	Value string `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

type resolveSecretsResponse struct {
	Resolved []resolvedRef `json:"resolved"`
}

// ---------- Token authentication ----------

// tokenHash returns the SHA-256 hash of s as a 32-byte array.
// Comparing hashes instead of raw strings eliminates the length-based
// timing side-channel that would exist if the two strings differ in length.
func tokenHash(s string) [32]byte {
	return sha256.Sum256([]byte(s))
}

// authenticateRuntimeToken validates the X-Lantern-Runtime-Token header
// against LANTERN_RUNTIME_SECRET_TOKEN. Both values are SHA-256-hashed before
// crypto/subtle.ConstantTimeCompare so the comparison is constant-time over
// fixed-size inputs regardless of token length.
//
// Returns (true, nil) on success.
// Returns (false, errRelayDisabled) when the env var is unset (fail-closed).
// Returns (false, errBadToken) on a token mismatch.
func authenticateRuntimeToken(r *http.Request) (bool, error) {
	want := os.Getenv(envRuntimeSecretToken)
	if want == "" {
		return false, errRelayDisabled
	}
	got := r.Header.Get(runtimeTokenHeader)
	wantH := tokenHash(want)
	gotH := tokenHash(got)
	if subtle.ConstantTimeCompare(wantH[:], gotH[:]) != 1 {
		return false, errBadToken
	}
	return true, nil
}

// sentinel errors used only for internal routing; never returned verbatim.
var (
	errRelayDisabled = &authError{msg: "relay disabled"}
	errBadToken      = &authError{msg: "invalid token"}
)

type authError struct{ msg string }

func (e *authError) Error() string { return e.msg }

// ---------- Auth-failure rate limiter ----------

// remoteIP extracts the best-effort client IP from the request, respecting
// X-Forwarded-For (first element). Mirrors the pattern used in auth.go.
func remoteIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[0]); ip != "" {
			return ip
		}
	}
	return r.RemoteAddr
}

// recordAuthFailure records an auth failure for the given IP and returns true
// if the IP has exceeded secretAuthFailMax failures within secretAuthFailWindow.
func (h *RuntimeSecretsHandler) recordAuthFailure(ip string) bool {
	now := time.Now()
	cutoff := now.Add(-secretAuthFailWindow)

	h.authFailMu.Lock()
	defer h.authFailMu.Unlock()

	// Prune old entries.
	times := h.authFailures[ip]
	valid := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	valid = append(valid, now)
	h.authFailures[ip] = valid

	return len(valid) > secretAuthFailMax
}

// ---------- Ref parser ----------

// parsedRef holds the decomposed form of a lantern.secret/... string.
type parsedRef struct {
	raw   string
	scope string // "llm" | "connector" | ""
	// llm scope
	provider string
	// connector scope
	installID string
	// configKey is the config JSONB key, or the reserved value "oauth" to
	// resolve oauth_token_encrypted instead.
	configKey string
}

// parseRef splits a ref string into its components.
// Returns a parsedRef with scope="" when the ref is malformed or unknown.
func parseRef(ref string) parsedRef {
	p := parsedRef{raw: ref}
	if !strings.HasPrefix(ref, secretRefPrefix) {
		return p
	}
	tail := strings.TrimPrefix(ref, secretRefPrefix) // e.g. "llm/anthropic"
	parts := strings.SplitN(tail, "/", 3)
	if len(parts) < 2 {
		return p
	}
	p.scope = parts[0]
	switch p.scope {
	case "llm":
		if len(parts) == 2 && parts[1] != "" {
			p.provider = parts[1]
		} else {
			p.scope = ""
		}
	case "connector":
		if len(parts) == 3 && parts[1] != "" && parts[2] != "" {
			p.installID = parts[1]
			p.configKey = parts[2]
		} else {
			p.scope = ""
		}
	default:
		p.scope = ""
	}
	return p
}

// ---------- Resolver helpers ----------

// resolveLLMRef resolves a lantern.secret/llm/<provider> ref for the given
// tenant. Returns the decrypted API key or ("", false) when not found.
// Errors are logged; the caller gets a "not found" response (no error oracle).
func (h *RuntimeSecretsHandler) resolveLLMRef(ctx context.Context, tenantID, provider string) (string, bool) {
	var apiKeyEncrypted string
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT api_key_encrypted
		FROM llm_provider_configs
		WHERE tenant_id = $1 AND provider = $2 AND status = 'active'
	`, tenantID, provider).Scan(&apiKeyEncrypted)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			h.logger().Warn("resolveLLMRef: db error",
				zap.String("tenant_id", tenantID),
				zap.String("provider", provider),
				zap.Error(err),
			)
		}
		return "", false
	}
	if apiKeyEncrypted == "" {
		return "", false
	}
	dec, decErr := secrets.Decrypt([]byte(apiKeyEncrypted))
	if decErr != nil {
		h.logger().Error("resolveLLMRef: decrypt failed",
			zap.String("tenant_id", tenantID),
			zap.String("provider", provider),
			zap.Error(decErr),
			// NOTE: do NOT log the encrypted or plaintext key value.
		)
		return "", false
	}
	return string(dec), true
}

// resolveConnectorConfigRef resolves a lantern.secret/connector/<id>/<key>
// ref where key != "oauth". It decrypts the config JSONB and returns the
// top-level string at config_key.
func (h *RuntimeSecretsHandler) resolveConnectorConfigRef(ctx context.Context, tenantID, installID, configKey string) (string, bool) {
	var configEncrypted []byte
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT config
		FROM connector_installs
		WHERE id = $1 AND tenant_id = $2
	`, installID, tenantID).Scan(&configEncrypted)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			h.logger().Warn("resolveConnectorConfigRef: db error",
				zap.String("tenant_id", tenantID),
				zap.String("install_id", installID),
				zap.String("config_key", configKey),
				zap.Error(err),
			)
		}
		return "", false
	}
	if len(configEncrypted) == 0 {
		return "", false
	}
	dec, decErr := secrets.Decrypt(configEncrypted)
	if decErr != nil {
		h.logger().Error("resolveConnectorConfigRef: decrypt failed",
			zap.String("tenant_id", tenantID),
			zap.String("install_id", installID),
			zap.String("config_key", configKey),
			zap.Error(decErr),
			// NOTE: do NOT log the encrypted or plaintext value.
		)
		return "", false
	}
	// The decrypted bytes are a JSON object; extract the top-level string key.
	var configMap map[string]any
	if jsonErr := json.Unmarshal(dec, &configMap); jsonErr != nil {
		h.logger().Warn("resolveConnectorConfigRef: config is not a JSON object",
			zap.String("install_id", installID),
			zap.Error(jsonErr),
		)
		return "", false
	}
	v, ok := configMap[configKey]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		// Value exists but is not a string (object, array, number, etc.).
		return "", false
	}
	return s, true
}

// resolveConnectorOAuthRef resolves the "oauth" sub-type:
// lantern.secret/connector/<install_id>/oauth reads oauth_token_encrypted
// (a JSONB column) and returns its raw decrypted JSON string.
func (h *RuntimeSecretsHandler) resolveConnectorOAuthRef(ctx context.Context, tenantID, installID string) (string, bool) {
	// oauth_token_encrypted is JSONB in production (see internal/db/migrate.go).
	// Scan into []byte — pgx returns JSONB as raw JSON bytes.
	var oauthEncrypted []byte
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT oauth_token_encrypted
		FROM connector_installs
		WHERE id = $1 AND tenant_id = $2
	`, installID, tenantID).Scan(&oauthEncrypted)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			h.logger().Warn("resolveConnectorOAuthRef: db error",
				zap.String("tenant_id", tenantID),
				zap.String("install_id", installID),
				zap.Error(err),
			)
		}
		return "", false
	}
	if len(oauthEncrypted) == 0 {
		return "", false
	}
	dec, decErr := secrets.Decrypt(oauthEncrypted)
	if decErr != nil {
		h.logger().Error("resolveConnectorOAuthRef: decrypt failed",
			zap.String("tenant_id", tenantID),
			zap.String("install_id", installID),
			zap.Error(decErr),
			// NOTE: do NOT log the encrypted or plaintext value.
		)
		return "", false
	}
	return string(dec), true
}

// resolveConnectorRef dispatches between the "oauth" sub-type and the
// ordinary config-key sub-type.
func (h *RuntimeSecretsHandler) resolveConnectorRef(ctx context.Context, tenantID, installID, configKey string) (string, bool) {
	if configKey == "oauth" {
		return h.resolveConnectorOAuthRef(ctx, tenantID, installID)
	}
	return h.resolveConnectorConfigRef(ctx, tenantID, installID, configKey)
}

// ---------- VM binding check ----------

// vmBindingDenied is a sentinel used only for internal routing; never returned
// verbatim to callers.
var vmBindingDenied = &authError{msg: "vm binding denied"}

// errVMBindingBody is the single response body returned for any vm-binding
// failure (unknown vm_id, wrong tenant, or terminal state).  The body is
// intentionally identical for all three cases — no oracle.
var errVMBindingBody = []byte(`{"error":"not found"}`)

// terminalVMStates lists the runtime_vms state values that indicate a VM has
// finished. A caller presenting a vm_id in one of these states is either racing
// against termination (allowed: VM completed before the harness retried) or
// probing for valid vm_ids — either way deny.
var terminalVMStates = []string{"terminated", "failed"}

// checkVMBinding verifies that vm_id exists in runtime_vms, belongs to
// tenant_id, and is in a non-terminal state. It returns nil when the binding is
// valid. On any mismatch it returns vmBindingDenied (the caller writes the
// identical 404 body regardless of the specific failure reason — no oracle).
//
// Ordering note: the Schedule handler inserts the runtime_vms row with
// state='pending' AFTER the scheduler.Schedule() call returns. Because the
// runtime-manager only calls ResolveSecrets after it receives a successful
// spawn response from the scheduler — which in turn happens after the
// control-plane's Schedule response is committed — the row is always present
// by the time a legitimate resolve request arrives. Allowing the 'pending'
// state is therefore correct and safe.
func (h *RuntimeSecretsHandler) checkVMBinding(ctx context.Context, vmID, tenantID string) error {
	var rowTenantID string
	var state string
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT tenant_id, state
		FROM runtime_vms
		WHERE vm_id = $1
	`, vmID).Scan(&rowTenantID, &state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vmBindingDenied
		}
		// Unexpected DB error — log it but deny (fail-closed).
		h.logger().Warn("checkVMBinding: db error",
			zap.String("vm_id", vmID),
			zap.Error(err),
		)
		return vmBindingDenied
	}
	if rowTenantID != tenantID {
		return vmBindingDenied
	}
	for _, terminal := range terminalVMStates {
		if state == terminal {
			return vmBindingDenied
		}
	}
	return nil
}

// ---------- Instance-token verification ----------

// verifyInstanceToken parses and validates a Bearer agent-instance JWT from
// the Authorization header. Returns (instanceID, nil) on success.
//
// Caller behaviour contract (STRICTLY ADDITIVE — backward compatible):
//   - No Authorization header → returns ("", nil); caller falls through to the
//     shared-token path unchanged.
//   - Present but invalid/expired/wrong-typ token → returns ("", non-nil error);
//     caller must reject the request with 403 (never silently ignore a bad token).
//   - Valid token whose agent_instance_id does not match the vm_id in the body
//     or belongs to the wrong tenant → returns ("", non-nil error).
func (h *RuntimeSecretsHandler) verifyInstanceToken(ctx context.Context, r *http.Request, vmID, tenantID string) (string, error) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return "", nil // no token present — not an error
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return "", errors.New("invalid Authorization header format")
	}
	tokenStr := strings.TrimPrefix(auth, prefix)
	if tokenStr == "" {
		return "", errors.New("empty Bearer token")
	}

	claims, err := h.identity.Verify(tokenStr)
	if err != nil {
		return "", fmt.Errorf("invalid agent-instance token: %w", err)
	}

	// The token's embedded instance id must map to the exact vm_id in the
	// request body for this tenant, and the VM must be non-terminal.
	var rowTenantID, rowState string
	dbErr := h.srv.Pool.QueryRow(ctx, `
		SELECT tenant_id, state
		FROM runtime_vms
		WHERE agent_instance_id = $1
	`, claims.AgentInstanceID).Scan(&rowTenantID, &rowState)
	if dbErr != nil {
		if errors.Is(dbErr, pgx.ErrNoRows) {
			return "", errors.New("agent_instance_id not found in runtime_vms")
		}
		h.logger().Warn("verifyInstanceToken: db error",
			zap.String("agent_instance_id", claims.AgentInstanceID),
			zap.Error(dbErr),
		)
		return "", errors.New("instance token verification failed")
	}
	if rowTenantID != tenantID {
		return "", errors.New("agent_instance_id belongs to a different tenant")
	}
	// The vm_id in the body must match what the DB associates with this instance.
	var rowVmID string
	lookupErr := h.srv.Pool.QueryRow(ctx, `
		SELECT vm_id FROM runtime_vms WHERE agent_instance_id = $1
	`, claims.AgentInstanceID).Scan(&rowVmID)
	if lookupErr != nil || rowVmID != vmID {
		return "", errors.New("agent_instance_id does not match vm_id")
	}
	for _, terminal := range terminalVMStates {
		if rowState == terminal {
			return "", errors.New("VM is in a terminal state")
		}
	}

	return claims.AgentInstanceID, nil
}

// ---------- Audit helpers ----------

// auditVMBindingDenied writes a runtime_audit_events row for a vm-binding
// denial. vm_id and tenant_id are recorded; no ref names (untrusted request).
func (h *RuntimeSecretsHandler) auditVMBindingDenied(ctx context.Context, tenantID, vmID string) {
	attrs := map[string]any{
		"denied": true,
	}
	attrsJSON, err := json.Marshal(attrs)
	if err != nil || len(attrsJSON) == 0 {
		attrsJSON = []byte("{}")
	}
	var vmIDArg any
	if vmID != "" {
		vmIDArg = vmID
	}
	if _, execErr := h.srv.Pool.Exec(ctx, `
		INSERT INTO runtime_audit_events (tenant_id, vm_id, action, attrs)
		VALUES ($1, $2, 'secret_resolve_denied', $3::jsonb)
	`, tenantID, vmIDArg, attrsJSON); execErr != nil {
		// Best-effort: log the failure but never abort the response.
		h.logger().Warn("audit insert failed for secret_resolve_denied",
			zap.String("tenant_id", tenantID),
			zap.String("vm_id", vmID),
			zap.Error(execErr),
		)
	}
}

// auditSecretResolve writes a runtime_audit_events row for a resolve call.
// ref names are recorded; values are never logged.
// agentInstanceID is set when the caller presented a valid instance Bearer token.
func (h *RuntimeSecretsHandler) auditSecretResolve(ctx context.Context, tenantID, vmID, agentInstanceID string, refNames []string, resolvedCount int) {
	attrs := map[string]any{
		"ref_names":      refNames,
		"resolved_count": resolvedCount,
	}
	attrsJSON, err := json.Marshal(attrs)
	if err != nil || len(attrsJSON) == 0 {
		attrsJSON = []byte("{}")
	}
	var vmIDArg any
	if vmID != "" {
		vmIDArg = vmID
	}
	var instanceArg any
	if agentInstanceID != "" {
		instanceArg = agentInstanceID
	}
	if _, execErr := h.srv.Pool.Exec(ctx, `
		INSERT INTO runtime_audit_events (tenant_id, vm_id, action, attrs, agent_instance_id)
		VALUES ($1, $2, 'secret_resolve', $3::jsonb, $4)
	`, tenantID, vmIDArg, attrsJSON, instanceArg); execErr != nil {
		// Best-effort: log the failure but never abort the response.
		h.logger().Warn("audit insert failed for secret_resolve",
			zap.String("tenant_id", tenantID),
			zap.String("vm_id", vmID),
			zap.Error(execErr),
		)
	}
}

// ---------- HTTP handler ----------

// ResolveSecrets handles POST /v1/runtime/secrets/resolve.
//
// Authentication: X-Lantern-Runtime-Token pre-shared token (service-to-service).
// LANTERN_RUNTIME_SECRET_TOKEN must be set; if unset this endpoint returns 403
// ("relay disabled") for every call — fail-closed by design.
//
// Body is limited to 64 KiB; refs array is capped at 64 entries.
// Auth failures are rate-limited per remote IP (max 10/min → 429).
func (h *RuntimeSecretsHandler) ResolveSecrets(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Enforce body size limit before any reads.
	r.Body = http.MaxBytesReader(w, r.Body, secretBodyLimit)

	// --- Authentication ---
	ok, authErr := authenticateRuntimeToken(r)
	if !ok {
		if authErr == errRelayDisabled {
			h.logger().Warn("secret relay: disabled (LANTERN_RUNTIME_SECRET_TOKEN not set)")
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "relay disabled"})
			return
		}
		// Bad token — rate-limit this IP.
		ip := remoteIP(r)
		if h.recordAuthFailure(ip) {
			h.logger().Warn("secret relay: auth failure rate limit exceeded",
				zap.String("remote_addr", ip),
			)
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
			return
		}
		h.logger().Warn("secret relay: invalid token",
			zap.String("remote_addr", ip),
		)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	// --- Parse request ---
	var req resolveSecretsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.TenantID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tenant_id is required"})
		return
	}
	if req.VmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm_id is required"})
		return
	}
	if len(req.Refs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "refs must be non-empty"})
		return
	}
	if len(req.Refs) > secretMaxRefs {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "too many refs: maximum is 64",
		})
		return
	}

	ctx := r.Context()

	// --- Optional agent-instance Bearer token verification (ADDITIVE) ---
	// If the request presents an Authorization: Bearer <token>, verify it as
	// an agent-instance JWT and confirm the embedded agent_instance_id maps to
	// the vm_id + tenant_id in the body. On success, the resolved instance id
	// is attributed in the audit row. The shared-token path below is unchanged
	// when no Bearer token is present. A present-but-invalid token is rejected
	// immediately (fail-closed) — we never silently downgrade to shared-token.
	var resolvedInstanceID string
	if authHdr := r.Header.Get("Authorization"); authHdr != "" {
		iid, ierr := h.verifyInstanceToken(ctx, r, req.VmID, req.TenantID)
		if ierr != nil {
			ip := remoteIP(r)
			if h.recordAuthFailure(ip) {
				h.logger().Warn("secret relay: instance token rate limit exceeded",
					zap.String("remote_addr", ip),
				)
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
				return
			}
			h.logger().Warn("secret relay: invalid agent-instance token",
				zap.String("vm_id", req.VmID),
				zap.Error(ierr),
			)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		resolvedInstanceID = iid
	}

	// --- VM binding check ---
	// Verify that the requested vm_id exists, belongs to tenant_id, and is in a
	// non-terminal state. This closes the shared-token weakness: a token holder
	// can only resolve secrets for tenants that actually have a live VM whose
	// UUID they know — i.e., the tenants running on that manager.
	//
	// A binding failure is treated as an auth-adjacent event: it increments the
	// per-IP rate limiter so binding-probing (enumerating vm_ids or tenant_ids)
	// gets throttled at the same rate as brute-force auth attempts. The 404 body
	// is identical for "no such vm", "wrong tenant", and "terminal state" — no
	// oracle that reveals which condition triggered the denial.
	if err := h.checkVMBinding(ctx, req.VmID, req.TenantID); err != nil {
		ip := remoteIP(r)
		// Count this as an auth-adjacent failure so binding-probers get
		// throttled at the same rate as token brute-forcers.
		if h.recordAuthFailure(ip) {
			h.logger().Warn("secret relay: vm binding rate limit exceeded",
				zap.String("remote_addr", ip),
			)
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
			return
		}
		h.logger().Warn("secret relay: vm binding denied",
			zap.String("vm_id", req.VmID),
			zap.String("tenant_id", req.TenantID),
			// NOTE: do NOT log secret values or ref contents here.
		)
		// Audit the denial. Use a distinct action so security tooling can
		// differentiate binding failures from normal resolutions. No ref
		// names are recorded because the request is untrusted at this point.
		h.auditVMBindingDenied(ctx, req.TenantID, req.VmID)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write(errVMBindingBody)
		return
	}

	// Collect ref names for audit before resolution.
	refNames := make([]string, len(req.Refs))
	copy(refNames, req.Refs)

	h.logger().Debug("secret relay: resolving refs",
		zap.String("tenant_id", req.TenantID),
		zap.String("vm_id", req.VmID),
		zap.Int("ref_count", len(req.Refs)),
		zap.Strings("ref_names", refNames),
		// NOTE: never log resolved values.
	)

	// --- Resolve each ref ---
	resolved := make([]resolvedRef, 0, len(req.Refs))
	resolvedCount := 0

	for _, ref := range req.Refs {
		p := parseRef(ref)
		if p.scope == "" {
			resolved = append(resolved, resolvedRef{Ref: ref, Error: "not found"})
			continue
		}

		var value string
		var found bool

		switch p.scope {
		case "llm":
			value, found = h.resolveLLMRef(ctx, req.TenantID, p.provider)
		case "connector":
			value, found = h.resolveConnectorRef(ctx, req.TenantID, p.installID, p.configKey)
		}

		if found {
			resolved = append(resolved, resolvedRef{Ref: ref, Value: value})
			resolvedCount++
		} else {
			resolved = append(resolved, resolvedRef{Ref: ref, Error: "not found"})
		}
	}

	// --- Audit (best-effort, after resolution) ---
	// resolvedInstanceID is non-empty only when a valid agent-instance Bearer
	// token was presented; otherwise it's "" (column is nullable).
	h.auditSecretResolve(ctx, req.TenantID, req.VmID, resolvedInstanceID, refNames, resolvedCount)

	h.logger().Debug("secret relay: resolved",
		zap.String("tenant_id", req.TenantID),
		zap.String("vm_id", req.VmID),
		zap.Int("resolved_count", resolvedCount),
		zap.Int("total_refs", len(req.Refs)),
		// NOTE: do NOT log resolved values here.
	)

	writeJSON(w, http.StatusOK, resolveSecretsResponse{Resolved: resolved})
}
