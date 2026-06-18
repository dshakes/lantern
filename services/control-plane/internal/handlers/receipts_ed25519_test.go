package handlers

// receipts_ed25519_test.go — Phase 2 receipt tests.
//
// Test matrix:
//   (a) Ed25519 issue→verify round trip (server-side offline verify)
//   (b) Offline external verify — only the public key from WellKnown is in scope;
//       no private key used; mimics what an external auditor does
//   (c) Tamper detection — mutate one payload byte → verify fails
//   (d) HMAC regression — HMAC path still works when only LANTERN_RECEIPT_SECRET
//       is set (Ed25519 seed absent)
//   (e) Unknown algorithm rejected (extends existing TestVerifyReceipt_UnsupportedAlgorithm)
//
// Each test that changes LANTERN_RECEIPT_ED25519_SEED calls resetEd25519OnceForTest()
// first so the package-level sync.Once re-runs for that test's environment.
// t.Setenv restores the original env after the test, and resetEd25519OnceForTest
// is called again in t.Cleanup to clear the cached key so later tests start fresh.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// generateTestSeed returns a fresh random 32-byte Ed25519 seed, base64-encoded.
func generateTestSeed(t *testing.T) string {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatalf("generate Ed25519 seed: %v", err)
	}
	return base64.StdEncoding.EncodeToString(seed)
}

// setEd25519Seed sets LANTERN_RECEIPT_ED25519_SEED, resets the once so the new
// value is picked up, and registers cleanup to reset again after the test so
// subsequent tests don't inherit a stale cached key.
func setEd25519Seed(t *testing.T, seedB64 string) {
	t.Helper()
	resetEd25519OnceForTest()
	t.Setenv("LANTERN_RECEIPT_ED25519_SEED", seedB64)
	t.Cleanup(resetEd25519OnceForTest)
}

// clearEd25519Seed ensures no Ed25519 seed is active (HMAC mode), resetting
// the once so the cleared env is picked up.
func clearEd25519Seed(t *testing.T) {
	t.Helper()
	resetEd25519OnceForTest()
	t.Setenv("LANTERN_RECEIPT_ED25519_SEED", "")
	t.Cleanup(resetEd25519OnceForTest)
}

// ---------- (a) Ed25519 issue→verify round trip ----------

func TestReceipt_Ed25519_IssueVerifyRoundTrip(t *testing.T) {
	setEd25519Seed(t, generateTestSeed(t))

	// Build a receipt using the Ed25519 path (no DB needed).
	p := receiptPayload{
		RunID:     "run-ed-001",
		TenantID:  "tenant-ed-001",
		AgentName: "my-agent",
		Status:    "succeeded",
		TokensIn:  200,
		TokensOut: 80,
		CostUsd:   0.0045,
		IssuedAt:  time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC),
		Version:   1,
	}

	// Sign via the current active key (Ed25519).
	k := loadEd25519Key(nil)
	if k.priv == nil {
		t.Fatal("expected Ed25519 private key to be loaded")
	}
	canonical, err := canonicalJSON(p)
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	sigBytes := ed25519.Sign(k.priv, canonical)
	receipt := signedReceipt{
		Payload:   p,
		Signature: base64.StdEncoding.EncodeToString(sigBytes),
		Algorithm: "Ed25519",
	}

	// Verify via the HTTP handler (offline path — nil srv means no DB).
	body, _ := json.Marshal(receipt)
	h := &ReceiptHandler{srv: nil}
	r := httptest.NewRequest(http.MethodPost, "/v1/runs/receipts/verify", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.VerifyReceipt(rr, r)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if valid, _ := resp["valid"].(bool); !valid {
		t.Errorf("expected valid=true, got: %v", resp)
	}
	if resp["runId"] != "run-ed-001" {
		t.Errorf("runId mismatch: %v", resp["runId"])
	}
}

// ---------- (b) Offline external verify — public key only ----------

// TestReceipt_Ed25519_ExternalVerify simulates what an external auditor does:
//  1. Fetch the public key from WellKnown (no private key in scope).
//  2. Receive a signed receipt.
//  3. Verify the signature using ONLY the public key + canonical JSON bytes.
//
// No private key is referenced after derivation; the test verifies that the
// public key alone (as published at /.well-known/lantern-receipts) is
// sufficient for offline verification.
func TestReceipt_Ed25519_ExternalVerify(t *testing.T) {
	seedB64 := generateTestSeed(t)
	setEd25519Seed(t, seedB64)

	// Step 1: derive key pair (simulates what the server holds).
	k := loadEd25519Key(nil)
	if k.priv == nil {
		t.Fatal("Ed25519 key not loaded")
	}

	// Step 2: server issues a receipt.
	p := receiptPayload{
		RunID:     "run-ext-verify-001",
		TenantID:  "tenant-ext",
		AgentName: "auditable-agent",
		Status:    "succeeded",
		TokensIn:  500,
		TokensOut: 120,
		CostUsd:   0.012,
		IssuedAt:  time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		Version:   1,
	}
	canonical, err := canonicalJSON(p)
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	sigBytes := ed25519.Sign(k.priv, canonical)
	sigB64 := base64.StdEncoding.EncodeToString(sigBytes)

	// Step 3: external verifier obtains public key from WellKnown.
	hwk := &ReceiptHandler{srv: nil}
	wkReq := httptest.NewRequest(http.MethodGet, "/.well-known/lantern-receipts", nil)
	wkRec := httptest.NewRecorder()
	hwk.WellKnown(wkRec, wkReq)

	if wkRec.Code != http.StatusOK {
		t.Fatalf("WellKnown: expected 200, got %d", wkRec.Code)
	}
	var wkResp map[string]any
	if err := json.NewDecoder(wkRec.Body).Decode(&wkResp); err != nil {
		t.Fatalf("decode WellKnown: %v", err)
	}
	if wkResp["algorithm"] != "Ed25519" {
		t.Errorf("WellKnown algorithm: want Ed25519, got %v", wkResp["algorithm"])
	}
	pubKeyB64, _ := wkResp["publicKey"].(string)
	if pubKeyB64 == "" {
		t.Fatal("WellKnown: publicKey field missing or empty")
	}
	// Fingerprint must be the first 8 bytes of SHA-256(pub).
	wantFP := sha256.Sum256(k.pub)
	if wkResp["keyFingerprint"] != hex.EncodeToString(wantFP[:8]) {
		t.Errorf("WellKnown fingerprint mismatch: got %v, want %s",
			wkResp["keyFingerprint"], hex.EncodeToString(wantFP[:8]))
	}

	// Step 4: external verifier decodes public key and verifies — NO private key.
	pubKeyBytes, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil {
		t.Fatalf("decode publicKey from WellKnown: %v", err)
	}
	externalPub := ed25519.PublicKey(pubKeyBytes)

	// Re-derive canonical bytes from the receipt payload (external verifier has
	// the full receipt JSON; they parse the payload and re-canonicalize).
	gotCanonical, err := canonicalJSON(p)
	if err != nil {
		t.Fatalf("canonicalJSON (external): %v", err)
	}
	gotSigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		t.Fatalf("decode sig: %v", err)
	}

	if !ed25519.Verify(externalPub, gotCanonical, gotSigBytes) {
		t.Error("external offline verify failed: ed25519.Verify returned false")
	}
}

// ---------- (c) Tamper detection ----------

func TestReceipt_Ed25519_TamperDetection(t *testing.T) {
	setEd25519Seed(t, generateTestSeed(t))

	k := loadEd25519Key(nil)
	if k.priv == nil {
		t.Fatal("Ed25519 key not loaded")
	}

	p := receiptPayload{
		RunID:    "run-tamper-001",
		TenantID: "tenant-tamper",
		CostUsd:  1.23,
		IssuedAt: time.Date(2026, 6, 18, 0, 0, 0, 0, time.UTC),
		Version:  1,
	}
	canonical, err := canonicalJSON(p)
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	sigBytes := ed25519.Sign(k.priv, canonical)

	// Tamper: change CostUsd after signing.
	tamperedP := p
	tamperedP.CostUsd = 0.01 // attacker tries to reduce reported cost

	receipt := signedReceipt{
		Payload:   tamperedP,                                   // tampered payload
		Signature: base64.StdEncoding.EncodeToString(sigBytes), // original sig
		Algorithm: "Ed25519",
	}
	body, _ := json.Marshal(receipt)

	h := &ReceiptHandler{srv: nil}
	r := httptest.NewRequest(http.MethodPost, "/v1/runs/receipts/verify", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.VerifyReceipt(rr, r)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if valid, _ := resp["valid"].(bool); valid {
		t.Error("tampered payload should not verify (expected valid=false)")
	}
}

// ---------- (d) HMAC regression ----------

// TestReceipt_HMAC_RegressionWhenNoEd25519Seed verifies that when only
// LANTERN_RECEIPT_SECRET is set (no Ed25519 seed), the handler issues and
// verifies HMAC-SHA256 receipts exactly as before the Ed25519 migration.
func TestReceipt_HMAC_RegressionWhenNoEd25519Seed(t *testing.T) {
	clearEd25519Seed(t)
	t.Setenv("LANTERN_RECEIPT_SECRET", "regression-hmac-secret-42")

	p := receiptPayload{
		RunID:    "run-hmac-regression",
		TenantID: "tenant-hmac",
		CostUsd:  0.001,
		IssuedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		Version:  1,
	}

	// Issue via HMAC signPayload (the pre-Ed25519 path).
	sig := signPayload(p)
	if sig == "" {
		t.Fatal("signPayload returned empty string")
	}
	receipt := signedReceipt{
		Payload:   p,
		Signature: sig,
		Algorithm: "HMAC-SHA256",
	}

	// Verify via the HTTP handler (offline fallback; nil srv).
	body, _ := json.Marshal(receipt)
	h := &ReceiptHandler{srv: nil}
	r := httptest.NewRequest(http.MethodPost, "/v1/runs/receipts/verify", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.VerifyReceipt(rr, r)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if valid, _ := resp["valid"].(bool); !valid {
		t.Errorf("expected valid=true for correct HMAC receipt, got: %v", resp)
	}
}

// TestReceipt_HMAC_WellKnownWhenNoEd25519 verifies WellKnown publishes
// algorithm=HMAC-SHA256 and a key fingerprint (not the secret) when no
// Ed25519 seed is configured.
func TestReceipt_HMAC_WellKnownWhenNoEd25519(t *testing.T) {
	clearEd25519Seed(t)
	t.Setenv("LANTERN_RECEIPT_SECRET", "wk-hmac-secret")

	h := &ReceiptHandler{srv: nil}
	r := httptest.NewRequest(http.MethodGet, "/.well-known/lantern-receipts", nil)
	rr := httptest.NewRecorder()
	h.WellKnown(rr, r)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["algorithm"] != "HMAC-SHA256" {
		t.Errorf("expected algorithm=HMAC-SHA256, got %v", resp["algorithm"])
	}
	fp, _ := resp["keyFingerprint"].(string)
	if fp == "" {
		t.Error("keyFingerprint must not be empty")
	}
	// Public key field must NOT be present in HMAC mode.
	if _, has := resp["publicKey"]; has {
		t.Error("publicKey must not appear in HMAC-mode WellKnown response")
	}
	// Fingerprint must never equal the actual secret.
	if fp == "wk-hmac-secret" {
		t.Error("keyFingerprint must not leak the secret itself")
	}
}

// ---------- (e) Unknown algorithm rejected ----------

// TestReceipt_UnknownAlgorithm_Rejected extends the existing
// TestVerifyReceipt_UnsupportedAlgorithm to cover the new dispatch path and
// verifies the response shape.
func TestReceipt_UnknownAlgorithm_Rejected(t *testing.T) {
	for _, algo := range []string{"RS256", "HS512", "none", ""} {
		t.Run("algo="+algo, func(t *testing.T) {
			body, _ := json.Marshal(signedReceipt{
				Payload:   receiptPayload{RunID: "x"},
				Signature: "abc",
				Algorithm: algo,
			})
			h := &ReceiptHandler{srv: nil}
			r := httptest.NewRequest(http.MethodPost, "/v1/runs/receipts/verify", bytes.NewReader(body))
			rr := httptest.NewRecorder()
			h.VerifyReceipt(rr, r)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("algo=%q: expected 400, got %d: %s", algo, rr.Code, rr.Body.String())
			}
			var resp map[string]any
			json.NewDecoder(rr.Body).Decode(&resp) //nolint:errcheck
			if resp["error"] == "" {
				t.Errorf("algo=%q: expected non-empty error field", algo)
			}
		})
	}
}

// ---------- WellKnown shape in Ed25519 mode ----------

func TestReceipt_Ed25519_WellKnownShape(t *testing.T) {
	setEd25519Seed(t, generateTestSeed(t))

	k := loadEd25519Key(nil)
	if k.pub == nil {
		t.Fatal("Ed25519 key not loaded")
	}

	h := &ReceiptHandler{srv: nil}
	r := httptest.NewRequest(http.MethodGet, "/.well-known/lantern-receipts", nil)
	rr := httptest.NewRecorder()
	h.WellKnown(rr, r)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// algorithm
	if resp["algorithm"] != "Ed25519" {
		t.Errorf("algorithm: want Ed25519, got %v", resp["algorithm"])
	}

	// publicKey: must decode to a valid 32-byte Ed25519 public key.
	pubB64, _ := resp["publicKey"].(string)
	if pubB64 == "" {
		t.Fatal("publicKey missing from response")
	}
	pubBytes, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil {
		t.Fatalf("publicKey is not valid base64: %v", err)
	}
	if len(pubBytes) != ed25519.PublicKeySize {
		t.Errorf("publicKey length: want %d bytes, got %d", ed25519.PublicKeySize, len(pubBytes))
	}

	// keyFingerprint: first 8 bytes of SHA-256(pub), hex-encoded.
	fp, _ := resp["keyFingerprint"].(string)
	want := sha256.Sum256(k.pub)
	wantFP := hex.EncodeToString(want[:8])
	if fp != wantFP {
		t.Errorf("keyFingerprint: want %s, got %s", wantFP, fp)
	}

	// docs field present.
	if resp["docs"] == "" || resp["docs"] == nil {
		t.Error("docs field should be present")
	}
}

// ---------- Seed formats ----------

// TestReceipt_Ed25519_HexSeedAccepted verifies the hex-encoded seed path.
func TestReceipt_Ed25519_HexSeedAccepted(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatalf("rand: %v", err)
	}
	hexSeed := hex.EncodeToString(seed)

	resetEd25519OnceForTest()
	t.Setenv("LANTERN_RECEIPT_ED25519_SEED", hexSeed)
	t.Cleanup(resetEd25519OnceForTest)

	k := loadEd25519Key(nil)
	if k.priv == nil {
		t.Fatal("Ed25519 key should load from hex seed")
	}

	// Verify the loaded key matches the seed we provided.
	expected := ed25519.NewKeyFromSeed(seed)
	if !bytes.Equal([]byte(k.priv), []byte(expected)) {
		t.Error("hex-loaded private key does not match expected key from seed")
	}
}
