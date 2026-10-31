package agentidentity

// Agent-principal tokens (ADR 0052). Distinct from the per-VM agent-instance
// token above: an agent token names an AGENT (a SPIFFE-style principal), is
// bound to exactly one audience, lives minutes, and is EdDSA-only so it can
// never be confused with an HS256 user session.
//
// No private key is ever stored. Each agent's Ed25519 key is derived on demand
// from a root secret and (tenant, agent, generation); rotation bumps the
// generation, which kills every outstanding token of the old one at once.

import (
	"context"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	// AgentTokenTyp is the "typ" claim of an agent-principal token.
	AgentTokenTyp = "agent"
	// agentTokenIssuer is the "iss" of agent-principal tokens.
	agentTokenIssuer = "pal"

	envRootKey     = "PAL_AGENT_IDENTITY_ROOT_KEY"
	envTrustDomain = "PAL_TRUST_DOMAIN"
	envTokenTTL    = "PAL_AGENT_TOKEN_TTL"

	defaultTrustDomain = "pal.local"
	defaultTokenTTL    = 5 * time.Minute
	minTokenTTL        = 30 * time.Second
	maxTokenTTL        = 15 * time.Minute
	verifyLeeway       = 30 * time.Second

	hkdfSalt = "pal-agent-identity-v1"
)

// Typed verification errors. Every rejection wraps ErrAgentToken so callers
// can treat them uniformly; the specific error is what lands in the audit row.
var (
	ErrAgentToken           = errors.New("agent token rejected")
	ErrAgentTokenMalformed  = fmt.Errorf("%w: malformed", ErrAgentToken)
	ErrAgentTokenAlg        = fmt.Errorf("%w: algorithm must be EdDSA", ErrAgentToken)
	ErrAgentTokenUnknownKey = fmt.Errorf("%w: unknown key", ErrAgentToken)
	ErrAgentTokenRevoked    = fmt.Errorf("%w: identity revoked", ErrAgentToken)
	ErrAgentTokenStaleKey   = fmt.Errorf("%w: key generation rotated", ErrAgentToken)
	ErrAgentTokenSignature  = fmt.Errorf("%w: bad signature", ErrAgentToken)
	ErrAgentTokenExpired    = fmt.Errorf("%w: expired or not yet valid", ErrAgentToken)
	ErrAgentTokenAudience   = fmt.Errorf("%w: wrong audience", ErrAgentToken)
	ErrAgentTokenClaims     = fmt.Errorf("%w: claims do not match identity", ErrAgentToken)
)

// IdentityRecord is the stored (public) half of an agent identity.
type IdentityRecord struct {
	AgentID       string
	TenantID      string
	SpiffeID      string
	KeyGeneration int
	PublicKey     ed25519.PublicKey
	Revoked       bool
}

// AgentClaims is the JWT payload of an agent-principal token.
type AgentClaims struct {
	jwt.RegisteredClaims
	Typ            string `json:"typ"`
	TenantID       string `json:"tenant_id"`
	AgentID        string `json:"agent_id"`
	AgentName      string `json:"agent_name"`
	AgentVersionID string `json:"agent_version_id,omitempty"`
	RunID          string `json:"run_id,omitempty"`
	Generation     int    `json:"gen"`
}

// MintRequest describes one token.
type MintRequest struct {
	Identity       IdentityRecord
	AgentName      string
	AgentVersionID string
	RunID          string
	Audience       string
}

// LookupFunc resolves an identity row by agent id. Implementations return
// ErrAgentTokenUnknownKey (wrapped or not) when no row exists.
type LookupFunc func(ctx context.Context, agentID string) (IdentityRecord, error)

// Authority mints and verifies agent-principal tokens.
type Authority struct {
	root        []byte
	trustDomain string
	ttl         time.Duration
	now         func() time.Time
}

// NewAuthority builds an Authority. The root secret is PAL_AGENT_IDENTITY_ROOT_KEY,
// else PAL_AGENT_IDENTITY_ED25519_SEED, else fallback (the JWT secret, dev).
// The returned source names which one was used so startup can log it (never
// the value).
func NewAuthority(fallback []byte) (*Authority, string) {
	root, source := decodeSecret(os.Getenv(envRootKey)), envRootKey
	if root == nil {
		root, source = decodeSecret(os.Getenv(envIdentityEd25519Seed)), envIdentityEd25519Seed
	}
	if root == nil {
		root, source = append([]byte(nil), fallback...), "JWT_SECRET (dev fallback)"
	}
	td := strings.ToLower(strings.TrimSpace(os.Getenv(envTrustDomain)))
	if td == "" {
		td = defaultTrustDomain
	}
	ttl := defaultTokenTTL
	if d, err := time.ParseDuration(os.Getenv(envTokenTTL)); err == nil {
		ttl = min(max(d, minTokenTTL), maxTokenTTL)
	}
	return &Authority{root: root, trustDomain: td, ttl: ttl, now: time.Now}, source
}

func decodeSecret(raw string) []byte {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) >= 32 {
		return b
	}
	if b, err := hex.DecodeString(raw); err == nil && len(b) >= 32 {
		return b
	}
	return nil
}

// TTL is the lifetime of minted tokens.
func (a *Authority) TTL() time.Duration { return a.ttl }

// WithClock returns a copy with a fixed clock (tests).
func (a *Authority) WithClock(now func() time.Time) *Authority {
	cp := *a
	cp.now = now
	return &cp
}

// SpiffeID is the agent's principal id.
func (a *Authority) SpiffeID(tenantID, agentID string) string {
	return "spiffe://" + a.trustDomain + "/tenant/" + tenantID + "/agent/" + agentID
}

// derive returns the agent's key for one generation. Deterministic, so the
// private half never has to be stored.
func (a *Authority) derive(tenantID, agentID string, gen int) (ed25519.PrivateKey, error) {
	info := tenantID + "|" + agentID + "|" + strconv.Itoa(gen)
	seed, err := hkdf.Key(sha256.New, a.root, []byte(hkdfSalt), info, ed25519.SeedSize)
	if err != nil {
		return nil, fmt.Errorf("agentidentity: derive key: %w", err)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// PublicKey is the public key of (tenant, agent, generation).
func (a *Authority) PublicKey(tenantID, agentID string, gen int) (ed25519.PublicKey, error) {
	k, err := a.derive(tenantID, agentID, gen)
	if err != nil {
		return nil, err
	}
	return k.Public().(ed25519.PublicKey), nil
}

func kid(agentID string, gen int) string { return agentID + "." + strconv.Itoa(gen) }

// Mint signs a token. The identity must be active; the derived key must match
// the stored public key (a root-secret change would otherwise mint tokens
// nobody can verify).
func (a *Authority) Mint(req MintRequest) (token string, claims AgentClaims, err error) {
	id := req.Identity
	if id.Revoked {
		return "", AgentClaims{}, ErrAgentTokenRevoked
	}
	if req.Audience == "" {
		return "", AgentClaims{}, fmt.Errorf("%w: audience required", ErrAgentTokenAudience)
	}
	priv, err := a.derive(id.TenantID, id.AgentID, id.KeyGeneration)
	if err != nil {
		return "", AgentClaims{}, err
	}
	if !priv.Public().(ed25519.PublicKey).Equal(id.PublicKey) {
		return "", AgentClaims{}, fmt.Errorf("%w: derived key does not match stored key (root secret changed? rotate the identity)", ErrAgentTokenUnknownKey)
	}
	now := a.now()
	claims = AgentClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    agentTokenIssuer,
			Subject:   id.SpiffeID,
			Audience:  jwt.ClaimStrings{req.Audience},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(a.ttl)),
			ID:        uuid.NewString(),
		},
		Typ:            AgentTokenTyp,
		TenantID:       id.TenantID,
		AgentID:        id.AgentID,
		AgentName:      req.AgentName,
		AgentVersionID: req.AgentVersionID,
		RunID:          req.RunID,
		Generation:     id.KeyGeneration,
	}
	t := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	t.Header["kid"] = kid(id.AgentID, id.KeyGeneration)
	signed, err := t.SignedString(priv)
	if err != nil {
		return "", AgentClaims{}, fmt.Errorf("agentidentity: sign agent token: %w", err)
	}
	return signed, claims, nil
}

// Verify checks a token for one exact audience. Order matters: the key is
// resolved from kid BEFORE the signature is trusted, and the generation /
// revocation check uses the stored row, so a rotated or revoked identity's
// tokens fail even though their signature was valid when minted.
func (a *Authority) Verify(ctx context.Context, tokenStr, audience string, lookup LookupFunc) (*AgentClaims, error) {
	var rec IdentityRecord
	var lookupErr error
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(agentTokenIssuer),
		jwt.WithLeeway(verifyLeeway),
		jwt.WithTimeFunc(a.now),
		jwt.WithExpirationRequired(),
	)
	var c AgentClaims
	_, err := parser.ParseWithClaims(tokenStr, &c, func(t *jwt.Token) (any, error) {
		k, _ := t.Header["kid"].(string)
		agentID, genStr, ok := strings.Cut(k, ".")
		gen, convErr := strconv.Atoi(genStr)
		if !ok || convErr != nil || uuid.Validate(agentID) != nil {
			return nil, ErrAgentTokenMalformed
		}
		rec, lookupErr = lookup(ctx, agentID)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if rec.Revoked {
			lookupErr = ErrAgentTokenRevoked
			return nil, lookupErr
		}
		if rec.KeyGeneration != gen {
			lookupErr = ErrAgentTokenStaleKey
			return nil, lookupErr
		}
		return rec.PublicKey, nil
	})
	switch {
	case lookupErr != nil:
		if errors.Is(lookupErr, ErrAgentToken) {
			return nil, lookupErr
		}
		return nil, fmt.Errorf("%w: %w", ErrAgentTokenUnknownKey, lookupErr)
	case err != nil && strings.Contains(err.Error(), "signing method"):
		return nil, ErrAgentTokenAlg
	case errors.Is(err, jwt.ErrTokenSignatureInvalid):
		return nil, ErrAgentTokenSignature
	case errors.Is(err, jwt.ErrTokenExpired), errors.Is(err, jwt.ErrTokenNotValidYet), errors.Is(err, jwt.ErrTokenRequiredClaimMissing):
		return nil, ErrAgentTokenExpired
	case err != nil:
		return nil, fmt.Errorf("%w: %v", ErrAgentTokenMalformed, err)
	}
	if c.Typ != AgentTokenTyp || c.AgentID != rec.AgentID || c.TenantID != rec.TenantID ||
		c.Subject != rec.SpiffeID || c.Generation != rec.KeyGeneration {
		return nil, ErrAgentTokenClaims
	}
	if len(c.Audience) != 1 || c.Audience[0] != audience {
		return nil, ErrAgentTokenAudience
	}
	return &c, nil
}

// PublicJWK renders an Ed25519 public key as an RFC 8037 OKP JWK.
func PublicJWK(agentID string, gen int, pub ed25519.PublicKey) map[string]any {
	return map[string]any{
		"kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA",
		"kid": kid(agentID, gen),
		"x":   base64.RawURLEncoding.EncodeToString(pub),
	}
}

// ---------- process-wide default authority ----------

var (
	defaultAuthorityOnce sync.Once
	defaultAuthority     *Authority
	defaultAuthoritySrc  string
)

// Default returns the process-wide Authority, built once from env + fallback.
func Default(fallback []byte) (*Authority, string) {
	defaultAuthorityOnce.Do(func() {
		defaultAuthority, defaultAuthoritySrc = NewAuthority(fallback)
	})
	return defaultAuthority, defaultAuthoritySrc
}
