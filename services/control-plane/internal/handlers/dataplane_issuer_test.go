package handlers

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ADR 0032: data-plane session tokens are minted with the PAL issuer; a token
// minted before the rename (legacy issuer) still verifies until it expires;
// any other issuer is refused.
func TestDataPlaneSessionToken_Issuers(t *testing.T) {
	s := &DataPlaneService{jwtSecret: []byte("dp-test-secret")}
	tok, err := s.issueSessionToken("t1", "p1")
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.verifySessionToken(tok)
	if err != nil || c.Issuer != "pal-cp" {
		t.Fatalf("fresh token: claims=%+v err=%v", c, err)
	}
	mint := func(issuer string) string {
		now := time.Now()
		cl := dpClaims{
			RegisteredClaims: jwt.RegisteredClaims{
				Subject: "p1", Issuer: issuer,
				IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			},
			Typ: dpSessionTyp, PlaneID: "p1", TenantID: "t1",
		}
		out, err := jwt.NewWithClaims(jwt.SigningMethodHS256, cl).SignedString(s.jwtSecret)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if _, err := s.verifySessionToken(mint("lantern-cp")); err != nil {
		t.Errorf("legacy issuer rejected: %v", err)
	}
	for _, bad := range []string{"", "lantern", "evil-cp"} {
		if _, err := s.verifySessionToken(mint(bad)); err == nil {
			t.Errorf("issuer %q accepted", bad)
		}
	}
}
