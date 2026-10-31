package agentidentity

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func testAuthority(t *testing.T) *Authority {
	t.Helper()
	t.Setenv(envRootKey, "")
	t.Setenv(envIdentityEd25519Seed, "")
	t.Setenv(envTokenTTL, "")
	t.Setenv(envTrustDomain, "")
	a, src := NewAuthority([]byte("unit-test-fallback-secret-0123456789abcdef"))
	if !strings.Contains(src, "fallback") {
		t.Fatalf("expected fallback source, got %q", src)
	}
	return a
}

func testIdentity(t *testing.T, a *Authority, gen int) IdentityRecord {
	t.Helper()
	tenant, agent := uuid.NewString(), uuid.NewString()
	pub, err := a.PublicKey(tenant, agent, gen)
	if err != nil {
		t.Fatal(err)
	}
	return IdentityRecord{AgentID: agent, TenantID: tenant, SpiffeID: a.SpiffeID(tenant, agent), KeyGeneration: gen, PublicKey: pub}
}

func lookupOf(rec *IdentityRecord) LookupFunc {
	return func(_ context.Context, id string) (IdentityRecord, error) {
		if id != rec.AgentID {
			return IdentityRecord{}, ErrAgentTokenUnknownKey
		}
		return *rec, nil
	}
}

func TestMintVerifyRoundTrip(t *testing.T) {
	a := testAuthority(t)
	rec := testIdentity(t, a, 1)
	tok, claims, err := a.Mint(MintRequest{Identity: rec, AgentName: "a1", RunID: "r1", Audience: "pal:dispatch"})
	if err != nil {
		t.Fatal(err)
	}
	if claims.ID == "" || claims.Subject != rec.SpiffeID || !strings.HasPrefix(rec.SpiffeID, "spiffe://pal.local/tenant/") {
		t.Fatalf("bad claims %+v", claims)
	}
	got, err := a.Verify(context.Background(), tok, "pal:dispatch", lookupOf(&rec))
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentID != rec.AgentID || got.RunID != "r1" || got.AgentName != "a1" {
		t.Fatalf("claims mismatch %+v", got)
	}
	// TTL default is 5 minutes.
	if d := got.ExpiresAt.Sub(got.IssuedAt.Time); d != 5*time.Minute {
		t.Fatalf("ttl %v", d)
	}
}

func TestVerifyRejections(t *testing.T) {
	a := testAuthority(t)
	rec := testIdentity(t, a, 1)
	tok, _, err := a.Mint(MintRequest{Identity: rec, AgentName: "a1", Audience: "pal:dispatch"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	t.Run("wrong audience", func(t *testing.T) {
		if _, err := a.Verify(ctx, tok, "pal:connectors", lookupOf(&rec)); !errors.Is(err, ErrAgentTokenAudience) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("expired", func(t *testing.T) {
		later := a.WithClock(func() time.Time { return time.Now().Add(6 * time.Minute) })
		if _, err := later.Verify(ctx, tok, "pal:dispatch", lookupOf(&rec)); !errors.Is(err, ErrAgentTokenExpired) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("revoked", func(t *testing.T) {
		r := rec
		r.Revoked = true
		if _, err := a.Verify(ctx, tok, "pal:dispatch", lookupOf(&r)); !errors.Is(err, ErrAgentTokenRevoked) {
			t.Fatalf("got %v", err)
		}
		if _, _, err := a.Mint(MintRequest{Identity: r, Audience: "x"}); !errors.Is(err, ErrAgentTokenRevoked) {
			t.Fatalf("mint on revoked: %v", err)
		}
	})
	t.Run("rotated", func(t *testing.T) {
		r := rec
		r.KeyGeneration = 2
		r.PublicKey, _ = a.PublicKey(r.TenantID, r.AgentID, 2)
		if _, err := a.Verify(ctx, tok, "pal:dispatch", lookupOf(&r)); !errors.Is(err, ErrAgentTokenStaleKey) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("unknown agent", func(t *testing.T) {
		other := testIdentity(t, a, 1)
		if _, err := a.Verify(ctx, tok, "pal:dispatch", lookupOf(&other)); !errors.Is(err, ErrAgentTokenUnknownKey) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("tampered payload", func(t *testing.T) {
		parts := strings.Split(tok, ".")
		forged, _, _ := a.Mint(MintRequest{Identity: rec, AgentName: "evil", Audience: "pal:dispatch"})
		fp := strings.Split(forged, ".")
		spliced := parts[0] + "." + fp[1] + "." + parts[2]
		if _, err := a.Verify(ctx, spliced, "pal:dispatch", lookupOf(&rec)); !errors.Is(err, ErrAgentTokenSignature) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("different root secret", func(t *testing.T) {
		t.Setenv(envRootKey, strings.Repeat("ab", 32))
		other, _ := NewAuthority(nil)
		if _, err := other.Verify(ctx, tok, "pal:dispatch", func(context.Context, string) (IdentityRecord, error) {
			r := rec
			r.PublicKey, _ = other.PublicKey(rec.TenantID, rec.AgentID, 1)
			return r, nil
		}); !errors.Is(err, ErrAgentTokenSignature) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("HS256 never accepted", func(t *testing.T) {
		c := AgentClaims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "pal", Subject: rec.SpiffeID, Audience: jwt.ClaimStrings{"pal:dispatch"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}, Typ: AgentTokenTyp, TenantID: rec.TenantID, AgentID: rec.AgentID, Generation: 1}
		h := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
		h.Header["kid"] = rec.AgentID + ".1"
		s, _ := h.SignedString([]byte("unit-test-fallback-secret-0123456789abcdef"))
		if _, err := a.Verify(ctx, s, "pal:dispatch", lookupOf(&rec)); !errors.Is(err, ErrAgentTokenAlg) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("garbage", func(t *testing.T) {
		if _, err := a.Verify(ctx, "not.a.jwt", "pal:dispatch", lookupOf(&rec)); !errors.Is(err, ErrAgentToken) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestMintRefusesMismatchedStoredKey(t *testing.T) {
	a := testAuthority(t)
	rec := testIdentity(t, a, 1)
	rec.PublicKey, _ = a.PublicKey(rec.TenantID, rec.AgentID, 7)
	if _, _, err := a.Mint(MintRequest{Identity: rec, Audience: "x"}); !errors.Is(err, ErrAgentTokenUnknownKey) {
		t.Fatalf("got %v", err)
	}
}

func TestTTLClamp(t *testing.T) {
	t.Setenv(envTokenTTL, "10h")
	a, _ := NewAuthority([]byte("x"))
	if a.TTL() != maxTokenTTL {
		t.Fatalf("ttl %v", a.TTL())
	}
	t.Setenv(envTokenTTL, "1s")
	a, _ = NewAuthority([]byte("x"))
	if a.TTL() != minTokenTTL {
		t.Fatalf("ttl %v", a.TTL())
	}
}

func TestKeysDifferPerAgentAndGeneration(t *testing.T) {
	a := testAuthority(t)
	t1, a1 := uuid.NewString(), uuid.NewString()
	k1, _ := a.PublicKey(t1, a1, 1)
	k2, _ := a.PublicKey(t1, a1, 2)
	k3, _ := a.PublicKey(t1, uuid.NewString(), 1)
	if k1.Equal(k2) || k1.Equal(k3) {
		t.Fatal("derived keys must be distinct per agent and generation")
	}
	again, _ := a.PublicKey(t1, a1, 1)
	if !k1.Equal(again) {
		t.Fatal("derivation must be deterministic")
	}
}
