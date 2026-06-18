// Package agentidentity mints and verifies short-lived, signed identities
// for headless agent instances. Each identity is a HS256 JWT with
// agent-specific claims; the token is injected into the VM's environment at
// schedule time so the workload can authenticate itself to the secret relay.
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
// # Secret source
//
// Signing key: LANTERN_AGENT_IDENTITY_SECRET (bytes of the env value).
// When unset, the caller-supplied fallback (the existing JWT secret) is used
// so a solo dev setup works without extra config.
//
// TTL: LANTERN_AGENT_IDENTITY_TTL, parsed as a Go duration string (e.g. "2h").
// Default: 1h. Agents running longer than the TTL must refresh their token
// (follow-up concern; today the relay does not require a valid token, only
// attributes when one is present).
package agentidentity

import (
	"context"
	"fmt"
	"os"
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

	// envIdentitySecret is the environment variable for the signing key.
	envIdentitySecret = "LANTERN_AGENT_IDENTITY_SECRET"

	// envIdentityTTL is the environment variable for the token TTL.
	envIdentityTTL = "LANTERN_AGENT_IDENTITY_TTL"

	// defaultTTL is used when LANTERN_AGENT_IDENTITY_TTL is unset.
	defaultTTL = time.Hour
)

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

	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := t.SignedString(iss.secret)
	if err != nil {
		return "", "", fmt.Errorf("agentidentity: sign token: %w", err)
	}
	return instanceID, signed, nil
}

// Verify parses and validates an agent-instance token. It checks:
//   - HS256 signature with the issuer's secret
//   - standard time claims (exp, nbf)
//   - Typ == "agent-instance" (rejects normal user JWTs)
//
// Returns the validated Claims on success.
func (iss *Issuer) Verify(tokenStr string) (*Claims, error) {
	var c Claims
	t, err := jwt.ParseWithClaims(tokenStr, &c, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("agentidentity: unexpected signing method: %v", tok.Header["alg"])
		}
		return iss.secret, nil
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
