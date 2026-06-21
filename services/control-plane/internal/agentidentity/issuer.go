// Package agentidentity mints and verifies short-lived, signed identities
// for headless agent instances. Tokens are EdDSA (Ed25519) when
// LANTERN_AGENT_IDENTITY_ED25519_SEED is set, otherwise HS256 as a fallback.
// The token is injected into the VM's environment at schedule time so the
// workload can authenticate itself to the secret relay.
//
// # Token shape
//
//	{
//	  "sub": "ai-<uuid>",          // agent_instance_id
//	  "iss": "lantern-agent",
//	  "iat": <unix>,
//	  "exp": <unix>,
//	  "jti": "<uuid>",
//	  "typ": "agent-instance",     // discriminator; rejects normal user JWTs
//	  "tenant_id": "<uuid>",
//	  "run_id": "<string>",        // may be empty for anonymous runs
//	  "agent_version_id": "<string>"
//	}
//
// # Signing key selection (in priority order)
//
//  1. LANTERN_AGENT_IDENTITY_ED25519_SEED — base64-std or hex-encoded 32-byte
//     seed. When set, Issue() signs with EdDSA and the public key is published
//     at /.well-known/lantern-agent-identity for external verifiers.
//  2. LANTERN_AGENT_IDENTITY_SECRET — HMAC-SHA256 key bytes.
//  3. Caller-supplied fallback (the existing JWT secret) — used when neither
//     env var above is set so a bare dev setup works without extra config.
//
// # Backward compatibility
//
// When LANTERN_AGENT_IDENTITY_ED25519_SEED is unset, Issue() and Verify()
// behave identically to today (HS256 only). No behaviour change on any code
// path unless the new env var is explicitly set.
//
// TTL: LANTERN_AGENT_IDENTITY_TTL, parsed as a Go duration string (e.g. "2h").
// Default: 1h.
package agentidentity

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	// TokenTyp is the value of the "typ" claim that distinguishes an
	// agent-instance token from a normal Lantern user JWT.
	TokenTyp = "agent-instance"

	// tokenIssuer is the "iss" claim value burned into every agent token.
	tokenIssuer = "lantern-agent"

	// envIdentitySecret is the environment variable for the HS256 signing key.
	envIdentitySecret = "LANTERN_AGENT_IDENTITY_SECRET"

	// envIdentityTTL is the environment variable for the token TTL.
	envIdentityTTL = "LANTERN_AGENT_IDENTITY_TTL"

	// envIdentityEd25519Seed is the environment variable for the Ed25519 seed.
	// When set, Issue() uses EdDSA instead of HS256.
	envIdentityEd25519Seed = "LANTERN_AGENT_IDENTITY_ED25519_SEED"

	// defaultTTL is used when LANTERN_AGENT_IDENTITY_TTL is unset.
	defaultTTL = time.Hour
)

// ---------- Ed25519 key loading (package-level singleton) ----------

// agentEd25519State holds the Ed25519 key pair for agent identity signing.
// Both fields are nil when no Ed25519 seed is configured (HS256 fallback).
type agentEd25519State struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

var (
	agentEd25519Once sync.Once
	agentEd25519Key  agentEd25519State // immutable after agentEd25519Once fires
)

// loadAgentEd25519Key initialises the Ed25519 key pair from
// LANTERN_AGENT_IDENTITY_ED25519_SEED on first call (sync.Once).
// Returns a zero agentEd25519State when the env var is unset (HS256 fallback).
// Never logs the seed material itself.
func loadAgentEd25519Key() agentEd25519State {
	agentEd25519Once.Do(func() {
		raw := os.Getenv(envIdentityEd25519Seed)
		if raw == "" {
			return // HS256 fallback; zero state
		}

		// Accept base64-std or hex; try base64 first.
		seed, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(seed) != ed25519.SeedSize {
			seed, err = hex.DecodeString(raw)
		}
		if err != nil || len(seed) != ed25519.SeedSize {
			// Misconfigured — fall back to HS256. Caller will log this at startup.
			return
		}

		priv := ed25519.NewKeyFromSeed(seed)
		pub := priv.Public().(ed25519.PublicKey)
		agentEd25519Key = agentEd25519State{priv: priv, pub: pub}
	})
	return agentEd25519Key
}

// resetAgentEd25519OnceForTest resets the package-level once so tests can
// inject different LANTERN_AGENT_IDENTITY_ED25519_SEED values via t.Setenv.
// Only call from test code.
func resetAgentEd25519OnceForTest() {
	agentEd25519Once = sync.Once{}
	agentEd25519Key = agentEd25519State{}
}

// StartupInfo returns a short human-readable description of the active signing
// mode and (for Ed25519) the public key fingerprint. Call once at server
// startup and log the result. Never returns key material.
//
//	alg, detail := agentidentity.StartupInfo()
//	// alg: "Ed25519" or "HS256"
//	// detail: fingerprint hex (Ed25519) or "" (HS256)
func StartupInfo() (alg, fingerprint string) {
	k := loadAgentEd25519Key()
	if k.pub != nil {
		fp := sha256.Sum256(k.pub)
		return "Ed25519", hex.EncodeToString(fp[:8])
	}
	return "HS256", ""
}

// AgentIdentityPublicKey returns the Ed25519 public key when
// LANTERN_AGENT_IDENTITY_ED25519_SEED is configured, and nil otherwise.
// Used by the /.well-known/lantern-agent-identity handler.
func AgentIdentityPublicKey() ed25519.PublicKey {
	return loadAgentEd25519Key().pub
}

// AgentIdentityKeyFingerprint returns the first 8 bytes of the SHA-256 of
// the Ed25519 public key, hex-encoded. Returns "" when not configured.
func AgentIdentityKeyFingerprint() string {
	k := loadAgentEd25519Key()
	if k.pub == nil {
		return ""
	}
	fp := sha256.Sum256(k.pub)
	return hex.EncodeToString(fp[:8])
}

// Claims is the JWT payload for an agent-instance token.
// It embeds jwt.RegisteredClaims so the standard lib handles iat/exp/sub.
type Claims struct {
	jwt.RegisteredClaims

	// Typ is the token-type discriminator. Must equal TokenTyp ("agent-instance")
	// for Verify to accept the token. This prevents a normal user JWT (which
	// has no Typ field) from being accepted by the relay.
	Typ string `json:"typ"`

	// AgentInstanceID is the "sub" value (also surfaced here for convenience).
	AgentInstanceID string `json:"agent_instance_id"`

	// TenantID scopes the token to a single tenant.
	TenantID string `json:"tenant_id"`

	// RunID is the run this instance is executing (may be empty).
	RunID string `json:"run_id"`

	// AgentVersionID identifies the deployed version bundle.
	AgentVersionID string `json:"agent_version_id"`
}

// Issuer mints and verifies agent-instance JWTs. Construct via New.
type Issuer struct {
	secret []byte
	ttl    time.Duration
	// nowFn allows tests to inject a deterministic clock.
	nowFn func() time.Time
}

// New builds an Issuer.
//
// fallbackSecret is used when LANTERN_AGENT_IDENTITY_SECRET is unset. Pass
// the caller's JWT secret so a bare dev setup works without extra config.
// The caller owns that value; New copies the bytes.
//
// Ed25519 signing is enabled by setting LANTERN_AGENT_IDENTITY_ED25519_SEED;
// the key is loaded lazily on first Issue/Verify call via the package-level
// once. When unset, HS256 behaviour is identical to the previous release.
func New(fallbackSecret []byte) *Issuer {
	secret := []byte(os.Getenv(envIdentitySecret))
	if len(secret) == 0 {
		secret = fallbackSecret
	}

	ttl := defaultTTL
	if raw := os.Getenv(envIdentityTTL); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			ttl = d
		}
	}

	return &Issuer{
		secret: secret,
		ttl:    ttl,
		nowFn:  time.Now,
	}
}

// withClock returns a copy of the issuer with a fixed clock. Used by tests.
func (iss *Issuer) withClock(fn func() time.Time) *Issuer {
	cp := *iss
	cp.nowFn = fn
	return &cp
}

// withTTL returns a copy of the issuer with the given TTL. Used by tests.
func (iss *Issuer) withTTL(ttl time.Duration) *Issuer {
	cp := *iss
	cp.ttl = ttl
	return &cp
}

// Issue mints a fresh agent-instance token. It generates a new UUID for the
// instance and returns it together with the signed JWT string.
//
// Signing algorithm:
//   - Ed25519 (EdDSA) when LANTERN_AGENT_IDENTITY_ED25519_SEED is set.
//   - HS256 otherwise (backward-compatible default).
//
// On error the caller should fail the schedule request (fail-closed): an
// agent that cannot be identified must not be scheduled.
func (iss *Issuer) Issue(_ context.Context, tenantID, runID, agentVersionID string) (instanceID, token string, err error) {
	instanceID = "ai-" + uuid.NewString()
	now := iss.nowFn()

	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   instanceID,
			Issuer:    tokenIssuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(iss.ttl)),
			ID:        uuid.NewString(), // jti
		},
		Typ:             TokenTyp,
		AgentInstanceID: instanceID,
		TenantID:        tenantID,
		RunID:           runID,
		AgentVersionID:  agentVersionID,
	}

	k := loadAgentEd25519Key()
	if k.priv != nil {
		// Ed25519 path: externally verifiable via /.well-known/lantern-agent-identity.
		t := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
		signed, err := t.SignedString(k.priv)
		if err != nil {
			return "", "", fmt.Errorf("agentidentity: sign token (Ed25519): %w", err)
		}
		return instanceID, signed, nil
	}

	// HS256 fallback — identical to previous behaviour.
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := t.SignedString(iss.secret)
	if err != nil {
		return "", "", fmt.Errorf("agentidentity: sign token: %w", err)
	}
	return instanceID, signed, nil
}

// Verify parses and validates an agent-instance token. It checks:
//   - Signature: Ed25519 (when LANTERN_AGENT_IDENTITY_ED25519_SEED is set) OR
//     HS256 (when only the HMAC secret is configured). No other algorithm is
//     accepted — any other alg header is rejected immediately to prevent
//     algorithm-substitution attacks.
//   - Standard time claims (exp, nbf).
//   - Typ == "agent-instance" (rejects normal user JWTs).
//
// Cross-algorithm tokens are always rejected:
//   - An Ed25519 token presented to an issuer that only has an HS256 secret
//     is rejected (no Ed25519 public key to verify against).
//   - An HS256 token presented to an issuer that only has an Ed25519 key
//     is rejected (algorithm header is "HS256", not "EdDSA").
//
// Returns the validated Claims on success.
func (iss *Issuer) Verify(tokenStr string) (*Claims, error) {
	k := loadAgentEd25519Key()

	var c Claims
	t, err := jwt.ParseWithClaims(tokenStr, &c, func(tok *jwt.Token) (any, error) {
		switch tok.Method.(type) {
		case *jwt.SigningMethodEd25519:
			// Ed25519 path: we must have a public key configured.
			if k.pub == nil {
				return nil, fmt.Errorf("agentidentity: received Ed25519 token but Ed25519 key is not configured")
			}
			return k.pub, nil

		case *jwt.SigningMethodHMAC:
			// HS256 path: reject when the issuer is in Ed25519-only mode.
			if k.pub != nil {
				return nil, fmt.Errorf("agentidentity: received HS256 token but issuer is configured for Ed25519")
			}
			return iss.secret, nil

		default:
			return nil, fmt.Errorf("agentidentity: unexpected signing method: %v", tok.Header["alg"])
		}
	})
	if err != nil {
		return nil, fmt.Errorf("agentidentity: parse token: %w", err)
	}
	if !t.Valid {
		return nil, fmt.Errorf("agentidentity: token invalid")
	}
	if c.Typ != TokenTyp {
		return nil, fmt.Errorf("agentidentity: wrong token type %q", c.Typ)
	}
	if c.AgentInstanceID == "" {
		return nil, fmt.Errorf("agentidentity: missing agent_instance_id claim")
	}
	return &c, nil
}
