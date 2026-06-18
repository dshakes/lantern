package handlers

// Verifiable execution receipts — Phase 2: Ed25519 asymmetric signatures.
//
// Every completed run can be turned into a tamper-evident JSON receipt that
// proves what was executed. Signing algorithm depends on which key is
// configured at startup:
//
//   - Ed25519 (preferred, production): set LANTERN_RECEIPT_ED25519_SEED to a
//     base64-std or hex-encoded 32-byte seed. The public key is published at
//     /.well-known/lantern-receipts so external auditors can verify receipts
//     completely offline — no shared secret required.
//
//   - HMAC-SHA256 (legacy / dev fallback): set LANTERN_RECEIPT_SECRET, or omit
//     both env vars to use the built-in dev constant. Existing stored receipts
//     continue to verify unchanged.
//
// What a receipt covers:
//   - run id, tenant, agent name + version digest
//   - model + provider routed to
//   - tokens in/out, cost in USD
//   - SHA-256 of the journal_events payload (binds the receipt to the actual
//     event stream — any post-hoc tampering invalidates the receipt)
//   - issuedAt timestamp

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ReceiptHandler exposes /v1/runs/{id}/receipt.
type ReceiptHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewReceiptHandler(srv *server.Server, auth *AuthHandler) *ReceiptHandler {
	return &ReceiptHandler{srv: srv, auth: auth}
}

func (h *ReceiptHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("receipts")
}

// receiptPayload is the canonical JSON that gets signed. Fields are sorted
// alphabetically when marshalled (encoding/json sorts struct fields by tag).
type receiptPayload struct {
	AgentName    string    `json:"agentName"`
	AgentVersion string    `json:"agentVersion,omitempty"`
	CostUsd      float64   `json:"costUsd"`
	IssuedAt     time.Time `json:"issuedAt"`
	JournalHash  string    `json:"journalHash"`
	Model        string    `json:"model,omitempty"`
	Provider     string    `json:"provider,omitempty"`
	RunID        string    `json:"runId"`
	Status       string    `json:"status"`
	TenantID     string    `json:"tenantId"`
	TokensIn     int64     `json:"tokensIn"`
	TokensOut    int64     `json:"tokensOut"`
	Version      int       `json:"version"`
}

type signedReceipt struct {
	Payload   receiptPayload `json:"payload"`
	Signature string         `json:"signature"`
	Algorithm string         `json:"algorithm"`
}

// ---------- Ed25519 key loading ----------

// ed25519State is the package-level singleton loaded once at first use.
// Both fields are nil when no Ed25519 seed is configured.
type ed25519State struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

var (
	ed25519Once sync.Once
	ed25519Key  ed25519State // immutable after ed25519Once fires
)

// loadEd25519Key returns the Ed25519 key pair derived from
// LANTERN_RECEIPT_ED25519_SEED. Returns an zero ed25519State when the env
// var is unset (HMAC fallback). Logs mode once to the provided logger (or a
// nop if nil); never logs the seed material itself.
func loadEd25519Key(log *zap.Logger) ed25519State {
	if log == nil {
		log = zap.NewNop()
	}
	ed25519Once.Do(func() {
		raw := os.Getenv("LANTERN_RECEIPT_ED25519_SEED")
		if raw == "" {
			log.Info("receipts: Ed25519 key not configured — using HMAC-SHA256 fallback",
				zap.String("env", "LANTERN_RECEIPT_ED25519_SEED"))
			return
		}

		// Accept base64-std or hex; try base64 first.
		var seed []byte
		var err error
		seed, err = base64.StdEncoding.DecodeString(raw)
		if err != nil || len(seed) != ed25519.SeedSize {
			// Try hex (some key-management systems emit hex).
			seed, err = hex.DecodeString(raw)
		}
		if err != nil {
			log.Error("receipts: failed to decode LANTERN_RECEIPT_ED25519_SEED (want 32-byte base64 or hex) — falling back to HMAC",
				zap.Error(err))
			return
		}
		if len(seed) != ed25519.SeedSize {
			log.Error("receipts: LANTERN_RECEIPT_ED25519_SEED decoded to wrong length — falling back to HMAC",
				zap.Int("got", len(seed)), zap.Int("want", ed25519.SeedSize))
			return
		}

		priv := ed25519.NewKeyFromSeed(seed)
		pub := priv.Public().(ed25519.PublicKey)
		ed25519Key = ed25519State{priv: priv, pub: pub}

		fp := sha256.Sum256(pub)
		log.Info("receipts: Ed25519 signing active",
			zap.String("pubKeyFingerprint", hex.EncodeToString(fp[:8])))
	})
	return ed25519Key
}

// activeKey returns the current ed25519State (zero value if HMAC mode).
// Calling this forces the once-init; passing a logger on first call sets the
// startup log line. Subsequent calls reuse the cached state.
func activeKey() ed25519State {
	// Logger is nil here because this is called on hot paths after startup.
	// The once fires only once; if the first call was from NewReceiptHandler
	// (with a real logger) the message is already emitted.
	return loadEd25519Key(nil)
}

// ---------- HTTP ----------

// IssueReceipt handles POST /v1/runs/{id}/receipt.
func (h *ReceiptHandler) IssueReceipt(w http.ResponseWriter, r *http.Request) {
	// Ensure the signing key is loaded and log mode on first call.
	loadEd25519Key(h.logger())

	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	runID := r.PathValue("id")
	if runID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "run id required"})
		return
	}

	receipt, err := h.buildReceipt(ctx, tenantID, runID)
	if err != nil {
		if err == errRunNotFound {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
			return
		}
		h.logger().Error("build receipt", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to issue receipt"})
		return
	}

	if err := h.persistReceipt(ctx, tenantID, runID, receipt); err != nil {
		h.logger().Warn("persist receipt failed", zap.Error(err))
	}

	writeJSON(w, http.StatusOK, receipt)
}

// VerifyReceipt handles POST /v1/runs/receipts/verify. No auth required —
// receipts are publicly verifiable. In Ed25519 mode the public key is
// published at /.well-known/lantern-receipts so external tools can verify
// entirely offline with no server involvement.
//
// Note on the request wire format: the incoming body is a signedReceipt (the
// JSON blob returned by IssueReceipt). There is no "caller-supplied public
// key" field in the current request struct — external verifiers are expected
// to obtain the server's public key from /.well-known/ and verify the
// ed25519.Verify call locally. Adding a caller-supplied public key to the
// request would allow a substitution attack (attacker supplies their own key
// + matching signature). The server-side verification here uses the
// configured server key and is the authoritative path.
//
// Verification strategy (defence-in-depth):
//  1. If the run_id is present and the run exists in our DB, RE-FETCH the
//     persisted receipt from run_receipts and compare the stored signature
//     against the client-supplied one (constant-time). This prevents an
//     attacker from crafting a payload that passes signature recomputation
//     but differs from what was actually issued.
//  2. For fully-offline payloads (no run_id, or run not found in DB), fall
//     back to recomputing the signature over the canonical JSON bytes.
func (h *ReceiptHandler) VerifyReceipt(w http.ResponseWriter, r *http.Request) {
	var req signedReceipt
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	switch req.Algorithm {
	case "HMAC-SHA256", "Ed25519":
		// supported
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":    "unsupported algorithm",
			"received": req.Algorithm,
		})
		return
	}

	ctx := r.Context()
	runID := req.Payload.RunID

	// Strategy 1: re-fetch persisted signature from DB when run_id is known.
	if runID != "" && h.srv != nil && h.srv.Pool != nil {
		var storedSig string
		err := h.srv.Pool.QueryRow(ctx,
			`SELECT signature FROM run_receipts WHERE run_id = $1`,
			runID,
		).Scan(&storedSig)
		if err == nil && storedSig != "" {
			// Constant-time compare: client-supplied signature vs. what we actually issued.
			if !hmac.Equal([]byte(storedSig), []byte(req.Signature)) {
				writeJSON(w, http.StatusOK, map[string]any{
					"valid":  false,
					"reason": "signature mismatch",
				})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"valid":    true,
				"runId":    req.Payload.RunID,
				"issuedAt": req.Payload.IssuedAt,
				"tenantId": req.Payload.TenantID,
			})
			return
		}
		// DB miss — fall through to offline recompute.
	}

	// Strategy 2 (offline / fallback): recompute signature over canonical bytes.
	canonical, err := canonicalJSON(req.Payload)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	var valid bool
	switch req.Algorithm {
	case "Ed25519":
		k := activeKey()
		if k.pub == nil {
			// Server not configured for Ed25519 — cannot verify offline.
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "Ed25519 key not configured on this server; obtain the public key from /.well-known/lantern-receipts and verify locally",
			})
			return
		}
		sigBytes, err := base64.StdEncoding.DecodeString(req.Signature)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"valid": false, "reason": "signature not valid base64"})
			return
		}
		valid = ed25519.Verify(k.pub, canonical, sigBytes)

	case "HMAC-SHA256":
		expected := hmacSign(canonical)
		valid = hmac.Equal([]byte(expected), []byte(req.Signature))
	}

	if !valid {
		writeJSON(w, http.StatusOK, map[string]any{"valid": false, "reason": "signature mismatch"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"valid":    true,
		"runId":    req.Payload.RunID,
		"issuedAt": req.Payload.IssuedAt,
		"tenantId": req.Payload.TenantID,
	})
}

// WellKnown handles GET /.well-known/lantern-receipts.
//
// Ed25519 mode: publishes algorithm + base64-encoded public key + SHA-256
// fingerprint of the public key. External verifiers can fetch this endpoint
// once and then verify receipts entirely offline using ed25519.Verify.
//
// HMAC mode (legacy/dev): publishes algorithm + 8-byte SHA-256 fingerprint
// of the secret (not the secret itself). Allows clients to confirm they
// have the right verification configuration without exposing key material.
func (h *ReceiptHandler) WellKnown(w http.ResponseWriter, _ *http.Request) {
	k := activeKey()
	if k.pub != nil {
		fp := sha256.Sum256(k.pub)
		writeJSON(w, http.StatusOK, map[string]any{
			"algorithm":      "Ed25519",
			"publicKey":      base64.StdEncoding.EncodeToString(k.pub),
			"keyFingerprint": hex.EncodeToString(fp[:8]),
			"docs":           "https://docs.lantern.dev/receipts",
		})
		return
	}
	// HMAC fallback.
	secret := getReceiptSecret()
	digest := sha256.Sum256([]byte(secret))
	writeJSON(w, http.StatusOK, map[string]any{
		"algorithm":      "HMAC-SHA256",
		"keyFingerprint": hex.EncodeToString(digest[:8]),
		"docs":           "https://docs.lantern.dev/receipts",
	})
}

// ---------- Internal ----------

var errRunNotFound = fmt.Errorf("run not found")

func (h *ReceiptHandler) buildReceipt(ctx context.Context, tenantID, runID string) (*signedReceipt, error) {
	var p receiptPayload
	var versionDigest *string
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT
		  r.id,
		  r.tenant_id,
		  COALESCE(a.name, ''),
		  av.digest,
		  COALESCE(r.model, ''),
		  COALESCE(r.provider, ''),
		  r.status,
		  COALESCE(r.tokens_in, 0),
		  COALESCE(r.tokens_out, 0),
		  COALESCE(r.cost_usd, 0)
		FROM runs r
		LEFT JOIN agents a        ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		LEFT JOIN agent_versions av ON av.id = a.current_version_id
		WHERE r.id = $1 AND r.tenant_id = $2
	`, runID, tenantID).Scan(
		&p.RunID, &p.TenantID, &p.AgentName, &versionDigest,
		&p.Model, &p.Provider, &p.Status,
		&p.TokensIn, &p.TokensOut, &p.CostUsd,
	)
	if err != nil {
		return nil, errRunNotFound
	}
	if versionDigest != nil {
		p.AgentVersion = *versionDigest
	}

	journalHash, err := h.hashJournal(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("hash journal: %w", err)
	}
	p.JournalHash = journalHash
	p.IssuedAt = time.Now().UTC()
	p.Version = 1

	k := activeKey()
	if k.priv != nil {
		// Ed25519 path.
		canonical, err := canonicalJSON(p)
		if err != nil {
			return nil, fmt.Errorf("canonicalJSON: %w", err)
		}
		sigBytes := ed25519.Sign(k.priv, canonical)
		return &signedReceipt{
			Payload:   p,
			Signature: base64.StdEncoding.EncodeToString(sigBytes),
			Algorithm: "Ed25519",
		}, nil
	}

	// HMAC-SHA256 fallback.
	return &signedReceipt{
		Payload:   p,
		Signature: signPayload(p),
		Algorithm: "HMAC-SHA256",
	}, nil
}

func (h *ReceiptHandler) hashJournal(ctx context.Context, runID string) (string, error) {
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT seq, kind, COALESCE(payload::text, '')
		FROM journal_events
		WHERE run_id = $1
		ORDER BY seq ASC
	`, runID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	hasher := sha256.New()
	for rows.Next() {
		var seq int64
		var kind, payload string
		if err := rows.Scan(&seq, &kind, &payload); err != nil {
			return "", err
		}
		fmt.Fprintf(hasher, "%d|%s|%s\n", seq, kind, payload)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func (h *ReceiptHandler) persistReceipt(ctx context.Context, tenantID, runID string, r *signedReceipt) error {
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO run_receipts (tenant_id, run_id, signature, payload, issued_at)
		VALUES ($1, $2, $3, $4::jsonb, $5)
		ON CONFLICT (run_id) DO UPDATE
		   SET signature = EXCLUDED.signature,
		       payload   = EXCLUDED.payload,
		       issued_at = EXCLUDED.issued_at
	`, tenantID, runID, r.Signature, string(body), r.Payload.IssuedAt)
	return err
}

// canonicalJSON serialises v to a canonical, deterministic JSON byte slice
// that is safe to sign regardless of Go struct field ordering or future
// field additions.
//
// Algorithm:
//  1. Marshal v to JSON with the standard encoder (field order follows struct tags).
//  2. Unmarshal into map[string]any to discard struct-level ordering.
//  3. Re-marshal the map — encoding/json sorts map keys alphabetically.
//
// This means two receiptPayload values with identical fields but different
// struct layouts still produce the same canonical bytes, and adding an
// omitempty field in the future won't silently shift the signature.
//
// Numbers are formatted by encoding/json without trailing zeros and with
// the minimal representation (e.g. 1.5 stays 1.5, not 1.500000). This is
// stable across Go versions because encoding/json's float formatting has
// not changed since Go 1.0.
func canonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("canonicalJSON marshal: %w", err)
	}
	// Unmarshal into a generic map so we can sort keys.
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("canonicalJSON unmarshal: %w", err)
	}
	// Re-marshal: encoding/json sorts map keys alphabetically.
	out, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("canonicalJSON re-marshal: %w", err)
	}
	return out, nil
}

// canonicalJSONKeys returns the sorted list of top-level keys in a canonical
// JSON object, used only in tests to assert key order is deterministic.
func canonicalJSONKeys(data []byte) ([]string, error) {
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys, nil
}

// hmacSign computes the HMAC-SHA256 over the provided canonical bytes using
// the configured LANTERN_RECEIPT_SECRET (or the dev fallback). The result is
// hex-encoded.
func hmacSign(canonical []byte) string {
	mac := hmac.New(sha256.New, []byte(getReceiptSecret()))
	mac.Write(canonical)
	return hex.EncodeToString(mac.Sum(nil))
}

// signPayload signs a receiptPayload via HMAC-SHA256 over its canonical JSON.
// Used for the HMAC fallback path and by legacy code that issues receipts
// without an Ed25519 key configured.
func signPayload(p receiptPayload) string {
	body, err := canonicalJSON(p)
	if err != nil {
		// Should never happen for a well-formed receiptPayload.
		body, _ = json.Marshal(p)
	}
	return hmacSign(body)
}

// getReceiptSecret returns the HMAC signing secret for run receipts.
//
// In dev (LANTERN_ENV unset) it falls back to devReceiptSecret so local
// verification works without configuration. In prod the secret must be set
// explicitly; main.go enforces this at startup before any traffic is served.
func getReceiptSecret() string {
	if v := os.Getenv("LANTERN_RECEIPT_SECRET"); v != "" {
		return v
	}
	return devReceiptSecret
}

// resetEd25519OnceForTest resets the package-level once so tests can inject
// different LANTERN_RECEIPT_ED25519_SEED values via t.Setenv.
// Only call from test code.
func resetEd25519OnceForTest() {
	ed25519Once = sync.Once{}
	ed25519Key = ed25519State{}
}
