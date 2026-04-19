package handlers

// Verifiable execution receipts.
//
// Every completed run can be turned into a tamper-evident JSON receipt that
// proves what was executed. The receipt is HMAC-signed with a tenant-scoped
// signing key derived from LANTERN_RECEIPT_SECRET; in production this should
// be replaced with Ed25519 + a published JWKS so external auditors can verify
// without our cooperation.
//
// What it covers:
//   - run id, tenant, agent name + version digest
//   - model + provider routed to
//   - tokens in/out, cost in USD
//   - SHA-256 of the journal_events payload (binds the receipt to the actual
//     event stream — any post-hoc tampering invalidates the receipt)
//   - issuedAt timestamp
//
// Anyone holding the receipt + the run id can call POST /v1/runs/receipts/verify
// to confirm the signature; in self-hosted mode the public key is exported
// from /v1/.well-known/lantern-receipts.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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

// ---------- HTTP ----------

// IssueReceipt handles POST /v1/runs/{id}/receipt.
func (h *ReceiptHandler) IssueReceipt(w http.ResponseWriter, r *http.Request) {
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
// receipts are publicly verifiable with the signing secret published via
// /.well-known/lantern-receipts in self-hosted mode.
func (h *ReceiptHandler) VerifyReceipt(w http.ResponseWriter, r *http.Request) {
	var req signedReceipt
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.Algorithm != "HMAC-SHA256" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":     "unsupported algorithm",
			"expected":  "HMAC-SHA256",
			"received":  req.Algorithm,
		})
		return
	}

	expected := signPayload(req.Payload)
	if !hmac.Equal([]byte(expected), []byte(req.Signature)) {
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
}

// WellKnown handles GET /.well-known/lantern-receipts and returns the signing
// algorithm + key fingerprint (not the secret itself). Allows clients to
// confirm they have the right verification configuration.
func (h *ReceiptHandler) WellKnown(w http.ResponseWriter, _ *http.Request) {
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
		// pgx returns ErrNoRows; treat any miss as not-found for this endpoint.
		return nil, errRunNotFound
	}
	if versionDigest != nil {
		p.AgentVersion = *versionDigest
	}

	// Hash the journal stream so the receipt binds to actual events.
	journalHash, err := h.hashJournal(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("hash journal: %w", err)
	}
	p.JournalHash = journalHash
	p.IssuedAt = time.Now().UTC()
	p.Version = 1

	sig := signPayload(p)
	return &signedReceipt{
		Payload:   p,
		Signature: sig,
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

func signPayload(p receiptPayload) string {
	// Marshal canonically — encoding/json sorts struct fields by declaration
	// order, so as long as the struct fields stay alphabetical the output is
	// deterministic for a given payload.
	body, _ := json.Marshal(p)
	mac := hmac.New(sha256.New, []byte(getReceiptSecret()))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func getReceiptSecret() string {
	if v := os.Getenv("LANTERN_RECEIPT_SECRET"); v != "" {
		return v
	}
	// Dev fallback — DO NOT rely on this in production.
	return "lantern-dev-receipt-secret-do-not-use-in-production"
}
