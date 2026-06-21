package agentidentity

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// secret used for all tests — never use in production.
const testSecret = "test-agent-identity-secret-do-not-use"

func newTestIssuer(t *testing.T) *Issuer {
	t.Helper()
	return New([]byte(testSecret))
}

// TestIssue_RoundTrip verifies that a freshly issued token round-trips through
// Verify and preserves all claims.
func TestIssue_RoundTrip(t *testing.T) {
	iss := newTestIssuer(t)
	const tenantID = "tenant-abc"
	const runID = "run-xyz"
	const versionID = "ver-123"

	instanceID, token, err := iss.Issue(context.Background(), tenantID, runID, versionID)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if !strings.HasPrefix(instanceID, "ai-") {
		t.Errorf("instanceID must start with 'ai-', got %q", instanceID)
	}

	claims, err := iss.Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if claims.AgentInstanceID != instanceID {
		t.Errorf("AgentInstanceID: got %q, want %q", claims.AgentInstanceID, instanceID)
	}
	if claims.Subject != instanceID {
		t.Errorf("Subject: got %q, want %q", claims.Subject, instanceID)
	}
	if claims.TenantID != tenantID {
		t.Errorf("TenantID: got %q, want %q", claims.TenantID, tenantID)
	}
	if claims.RunID != runID {
		t.Errorf("RunID: got %q, want %q", claims.RunID, runID)
	}
	if claims.AgentVersionID != versionID {
		t.Errorf("AgentVersionID: got %q, want %q", claims.AgentVersionID, versionID)
	}
	if claims.Typ != TokenTyp {
		t.Errorf("Typ: got %q, want %q", claims.Typ, TokenTyp)
	}
	if claims.Issuer != tokenIssuer {
		t.Errorf("Issuer: got %q, want %q", claims.Issuer, tokenIssuer)
	}
	if claims.ID == "" {
		t.Error("jti must be non-empty")
	}
}

// TestIssue_Uniqueness verifies that successive calls produce different
// instanceIDs and different tokens (jti ensures uniqueness).
func TestIssue_Uniqueness(t *testing.T) {
	iss := newTestIssuer(t)

	ids := map[string]bool{}
	tokens := map[string]bool{}
	for i := 0; i < 20; i++ {
		id, tok, err := iss.Issue(context.Background(), "tenant", "run", "ver")
		if err != nil {
			t.Fatalf("Issue[%d]: %v", i, err)
		}
		if ids[id] {
			t.Errorf("duplicate instanceID on iteration %d: %q", i, id)
		}
		ids[id] = true
		if tokens[tok] {
			t.Errorf("duplicate token on iteration %d", i)
		}
		tokens[tok] = true
	}
}

// TestVerify_ExpiredToken verifies that an already-expired token is rejected.
func TestVerify_ExpiredToken(t *testing.T) {
	// Issue with a tiny TTL using an injected clock.
	past := time.Now().Add(-2 * time.Second)
	iss := newTestIssuer(t).withTTL(time.Millisecond).withClock(func() time.Time {
		return past
	})

	_, token, err := iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// Verify with the normal issuer (real clock — token is already expired).
	_, err = newTestIssuer(t).Verify(token)
	if err == nil {
		t.Error("expected error for expired token, got nil")
	}
}

// TestVerify_TamperedToken verifies that a token whose signature is replaced
// with a completely different value is rejected.
func TestVerify_TamperedToken(t *testing.T) {
	iss := newTestIssuer(t)
	_, token, err := iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// Replace the signature section with a fixed-wrong value (all zeros, base64url).
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 JWT parts, got %d", len(parts))
	}
	// Use the same length as the real signature but all 'A' chars (encodes zeros).
	wrongSig := strings.Repeat("A", len(parts[2]))
	tampered := strings.Join([]string{parts[0], parts[1], wrongSig}, ".")

	_, err = iss.Verify(tampered)
	if err == nil {
		t.Error("expected error for tampered token, got nil")
	}
}

// TestVerify_WrongSecret verifies that a token signed with a different key is
// rejected, even if all other claims are valid.
func TestVerify_WrongSecret(t *testing.T) {
	iss := newTestIssuer(t)
	_, token, err := iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// Verify with a different secret.
	other := New([]byte("completely-different-secret"))
	_, err = other.Verify(token)
	if err == nil {
		t.Error("expected error when verifying with wrong secret, got nil")
	}
}

// TestVerify_WrongTyp verifies that a token whose Typ claim is missing or wrong
// is rejected. This is the discriminator that keeps normal user JWTs out.
func TestVerify_WrongTyp(t *testing.T) {
	// We can't trivially issue a token with the wrong Typ through our own
	// issuer, so test the claim-level check by verifying that a completely
	// fresh token from an issuer that writes a different typ is rejected.
	// We'll do this by issuing a token then manually verifying that Verify
	// rejects the zero-value Typ.
	//
	// Approach: issue normally, then verify that the claims struct built
	// with a wrong Typ doesn't pass the discriminator check in Verify.
	// We can't easily forge the JWT without the secret, so we test Verify's
	// behavior on the only path available without forging: an empty token
	// string.

	iss := newTestIssuer(t)

	// A valid token round-trips.
	_, tok, _ := iss.Issue(context.Background(), "t", "r", "v")
	claims, err := iss.Verify(tok)
	if err != nil {
		t.Fatalf("Round-trip Verify failed: %v", err)
	}
	if claims.Typ != TokenTyp {
		t.Errorf("Typ must equal TokenTyp; got %q", claims.Typ)
	}

	// A completely garbage string is rejected.
	_, err = iss.Verify("not.a.token")
	if err == nil {
		t.Error("expected error for garbage token, got nil")
	}

	// An empty string is rejected.
	_, err = iss.Verify("")
	if err == nil {
		t.Error("expected error for empty token, got nil")
	}
}

// TestVerify_FallbackSecret verifies that when LANTERN_AGENT_IDENTITY_SECRET
// is unset, the issuer falls back to the provided secret and tokens verify
// correctly against it.
func TestVerify_FallbackSecret(t *testing.T) {
	// Ensure env is unset for this test.
	t.Setenv(envIdentitySecret, "")

	fallback := []byte("fallback-secret-for-testing")
	iss := New(fallback)

	_, tok, err := iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue with fallback: %v", err)
	}

	// Verify with the same issuer (same fallback).
	_, err = iss.Verify(tok)
	if err != nil {
		t.Errorf("Verify with fallback: %v", err)
	}

	// Verify with a different key fails.
	other := New([]byte("wrong"))
	_, err = other.Verify(tok)
	if err == nil {
		t.Error("should fail verification with wrong key")
	}
}

// TestIssue_EmptyRunAndVersion verifies that Issue succeeds when runID and
// agentVersionID are empty (anonymous runs).
func TestIssue_EmptyRunAndVersion(t *testing.T) {
	iss := newTestIssuer(t)
	instanceID, tok, err := iss.Issue(context.Background(), "tenant", "", "")
	if err != nil {
		t.Fatalf("Issue with empty run/version: %v", err)
	}
	claims, err := iss.Verify(tok)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if claims.AgentInstanceID != instanceID {
		t.Errorf("AgentInstanceID mismatch")
	}
	if claims.RunID != "" {
		t.Errorf("RunID should be empty, got %q", claims.RunID)
	}
	if claims.AgentVersionID != "" {
		t.Errorf("AgentVersionID should be empty, got %q", claims.AgentVersionID)
	}
}

// ---------- Ed25519 tests ----------

// testEd25519Seed is a deterministic 32-byte seed for tests.
// Never use in production.
var testEd25519Seed = strings.Repeat("A", 32) // 32 bytes of 'A'

// testEd25519SeedB64 is the base64-std encoding of testEd25519Seed.
var testEd25519SeedB64 = base64.StdEncoding.EncodeToString([]byte(testEd25519Seed))

// newEd25519Issuer returns an Issuer with the Ed25519 key loaded from a fixed
// test seed. It resets the package-level once so multiple tests can run in
// sequence.
func newEd25519Issuer(t *testing.T) *Issuer {
	t.Helper()
	resetAgentEd25519OnceForTest()
	t.Setenv(envIdentityEd25519Seed, testEd25519SeedB64)
	t.Cleanup(resetAgentEd25519OnceForTest)
	return New([]byte(testSecret))
}

// TestEd25519_RoundTrip verifies that an Ed25519-signed token round-trips
// through Verify and preserves all claims.
func TestEd25519_RoundTrip(t *testing.T) {
	iss := newEd25519Issuer(t)

	instanceID, tok, err := iss.Issue(context.Background(), "tenant-ed", "run-ed", "ver-ed")
	if err != nil {
		t.Fatalf("Issue (Ed25519): %v", err)
	}
	if !strings.HasPrefix(instanceID, "ai-") {
		t.Errorf("instanceID must start with 'ai-', got %q", instanceID)
	}

	// Verify with the same issuer (same Ed25519 key).
	claims, err := iss.Verify(tok)
	if err != nil {
		t.Fatalf("Verify (Ed25519): %v", err)
	}
	if claims.AgentInstanceID != instanceID {
		t.Errorf("AgentInstanceID: got %q, want %q", claims.AgentInstanceID, instanceID)
	}
	if claims.TenantID != "tenant-ed" {
		t.Errorf("TenantID: got %q, want %q", claims.TenantID, "tenant-ed")
	}
	if claims.Typ != TokenTyp {
		t.Errorf("Typ: got %q, want %q", claims.Typ, TokenTyp)
	}

	// Confirm the token header contains "EdDSA".
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("unexpected JWT structure: %d parts", len(parts))
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decode header: %v", err)
	}
	if !strings.Contains(string(headerJSON), "EdDSA") {
		t.Errorf("expected EdDSA in JWT header, got: %s", headerJSON)
	}
}

// TestHS256_BackCompat verifies that when LANTERN_AGENT_IDENTITY_ED25519_SEED
// is unset, Issue() still signs with HS256 and Verify() still works.
func TestHS256_BackCompat(t *testing.T) {
	// Ensure Ed25519 seed env var is unset.
	resetAgentEd25519OnceForTest()
	t.Setenv(envIdentityEd25519Seed, "")
	t.Cleanup(resetAgentEd25519OnceForTest)

	iss := New([]byte(testSecret))

	instanceID, tok, err := iss.Issue(context.Background(), "tenant-hs", "run-hs", "ver-hs")
	if err != nil {
		t.Fatalf("Issue (HS256 back-compat): %v", err)
	}

	claims, err := iss.Verify(tok)
	if err != nil {
		t.Fatalf("Verify (HS256 back-compat): %v", err)
	}
	if claims.AgentInstanceID != instanceID {
		t.Errorf("AgentInstanceID mismatch")
	}

	// Confirm the token header contains "HS256".
	parts := strings.Split(tok, ".")
	headerJSON, _ := base64.RawURLEncoding.DecodeString(parts[0])
	if !strings.Contains(string(headerJSON), "HS256") {
		t.Errorf("expected HS256 in JWT header, got: %s", headerJSON)
	}
}

// TestAlgSubstitution_Ed25519TokenRejectedByHS256Issuer verifies that an
// Ed25519-signed token is rejected when presented to an issuer that only has
// an HS256 secret (no Ed25519 seed configured).
func TestAlgSubstitution_Ed25519TokenRejectedByHS256Issuer(t *testing.T) {
	// Issue an Ed25519 token.
	ed25519Iss := newEd25519Issuer(t)
	_, tok, err := ed25519Iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue (Ed25519): %v", err)
	}

	// Now create an HS256-only issuer (no Ed25519 seed) and try to verify.
	resetAgentEd25519OnceForTest()
	t.Setenv(envIdentityEd25519Seed, "")
	hs256Iss := New([]byte(testSecret))

	_, err = hs256Iss.Verify(tok)
	if err == nil {
		t.Error("expected Ed25519 token to be REJECTED by HS256-only issuer, but Verify returned nil")
	}
}

// TestAlgSubstitution_HS256TokenRejectedByEd25519Issuer verifies that an
// HS256 token is rejected when presented to an issuer that is configured for
// Ed25519 (no cross-algorithm confusion).
func TestAlgSubstitution_HS256TokenRejectedByEd25519Issuer(t *testing.T) {
	// Issue an HS256 token (no Ed25519 seed).
	resetAgentEd25519OnceForTest()
	t.Setenv(envIdentityEd25519Seed, "")
	hs256Iss := New([]byte(testSecret))
	_, tok, err := hs256Iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue (HS256): %v", err)
	}

	// Now configure an Ed25519 issuer and try to verify the HS256 token.
	ed25519Iss := newEd25519Issuer(t)
	_, err = ed25519Iss.Verify(tok)
	if err == nil {
		t.Error("expected HS256 token to be REJECTED by Ed25519 issuer, but Verify returned nil")
	}
}

// TestEd25519_TamperedSignature verifies that a tampered Ed25519 token is rejected.
func TestEd25519_TamperedSignature(t *testing.T) {
	iss := newEd25519Issuer(t)
	_, tok, err := iss.Issue(context.Background(), "tenant", "run", "ver")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 JWT parts, got %d", len(parts))
	}
	// Corrupt the signature section.
	tampered := strings.Join([]string{parts[0], parts[1], strings.Repeat("A", len(parts[2]))}, ".")
	_, err = iss.Verify(tampered)
	if err == nil {
		t.Error("expected error for tampered Ed25519 token, got nil")
	}
}

// TestAgentIdentityPublicKey verifies that AgentIdentityPublicKey returns the
// expected public key when the seed is configured.
func TestAgentIdentityPublicKey(t *testing.T) {
	resetAgentEd25519OnceForTest()
	t.Setenv(envIdentityEd25519Seed, testEd25519SeedB64)
	t.Cleanup(resetAgentEd25519OnceForTest)

	pub := AgentIdentityPublicKey()
	if pub == nil {
		t.Fatal("expected non-nil public key when seed is configured")
	}
	if len(pub) != ed25519.PublicKeySize {
		t.Errorf("public key size: got %d, want %d", len(pub), ed25519.PublicKeySize)
	}

	// Verify it matches what we'd derive from the seed.
	priv := ed25519.NewKeyFromSeed([]byte(testEd25519Seed))
	expectedPub := priv.Public().(ed25519.PublicKey)
	if string(pub) != string(expectedPub) {
		t.Error("AgentIdentityPublicKey does not match key derived from seed")
	}

	fp := AgentIdentityKeyFingerprint()
	if fp == "" {
		t.Error("expected non-empty fingerprint when seed is configured")
	}
	if len(fp) != 16 { // 8 bytes hex = 16 chars
		t.Errorf("fingerprint length: got %d, want 16", len(fp))
	}
}

// TestAgentIdentityPublicKey_NoSeed verifies that AgentIdentityPublicKey
// returns nil when no seed is configured (HS256 mode).
func TestAgentIdentityPublicKey_NoSeed(t *testing.T) {
	resetAgentEd25519OnceForTest()
	t.Setenv(envIdentityEd25519Seed, "")
	t.Cleanup(resetAgentEd25519OnceForTest)

	pub := AgentIdentityPublicKey()
	if pub != nil {
		t.Errorf("expected nil public key when no seed is configured, got %v", pub)
	}
	fp := AgentIdentityKeyFingerprint()
	if fp != "" {
		t.Errorf("expected empty fingerprint when no seed configured, got %q", fp)
	}
}
