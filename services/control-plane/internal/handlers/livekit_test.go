package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// decodeJWTSegment is a tiny helper to read a JWT segment in tests.
func decodeJWTSegment(t *testing.T, seg string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		t.Fatalf("decode segment: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal segment: %v", err)
	}
	return m
}

func TestMintLiveKitToken(t *testing.T) {
	tok, err := mintLiveKitToken("APIabc", "secret-value", "room-1", "agent-7", "Agent", time.Minute)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 JWT parts, got %d", len(parts))
	}

	// Header is HS256/JWT.
	hdr := decodeJWTSegment(t, parts[0])
	if hdr["alg"] != "HS256" || hdr["typ"] != "JWT" {
		t.Fatalf("unexpected header: %v", hdr)
	}

	// Claims carry iss=apiKey, sub=identity, and the video grant room.
	claims := decodeJWTSegment(t, parts[1])
	if claims["iss"] != "APIabc" {
		t.Errorf("iss = %v, want APIabc", claims["iss"])
	}
	if claims["sub"] != "agent-7" {
		t.Errorf("sub = %v, want agent-7", claims["sub"])
	}
	video, ok := claims["video"].(map[string]any)
	if !ok || video["room"] != "room-1" || video["roomJoin"] != true {
		t.Errorf("unexpected video grant: %v", claims["video"])
	}

	// Signature verifies against the secret.
	mac := hmac.New(sha256.New, []byte("secret-value"))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		t.Error("signature does not verify against secret")
	}
}

func TestMintLiveKitTokenRequiresCreds(t *testing.T) {
	if _, err := mintLiveKitToken("", "secret", "r", "i", "", time.Minute); err == nil {
		t.Error("expected error with empty apiKey")
	}
	if _, err := mintLiveKitToken("k", "secret", "r", "", "", time.Minute); err == nil {
		t.Error("expected error with empty identity")
	}
}

// signLiveKitWebhook builds an Authorization JWT the way LiveKit does, for the
// verification test.
func signLiveKitWebhook(secret string, body []byte, exp int64) string {
	sum := sha256.Sum256(body)
	claims := map[string]any{
		"exp":    exp,
		"sha256": base64.StdEncoding.EncodeToString(sum[:]),
	}
	tok, _ := signHS256JWT(claims, secret)
	return tok
}

func TestVerifyLiveKitWebhook(t *testing.T) {
	const secret = "lk-secret"
	body := []byte(`{"event":"room_started","room":{"name":"+15125550000","sid":"RM_1"}}`)
	auth := signLiveKitWebhook(secret, body, time.Now().Add(time.Minute).Unix())

	if err := verifyLiveKitWebhook(secret, auth, body); err != nil {
		t.Fatalf("valid webhook rejected: %v", err)
	}
	// Tampered body must fail the hash check.
	if err := verifyLiveKitWebhook(secret, auth, []byte(`{"event":"x"}`)); err == nil {
		t.Error("tampered body accepted")
	}
	// Wrong secret must fail the signature check.
	if err := verifyLiveKitWebhook("other-secret", auth, body); err == nil {
		t.Error("wrong secret accepted")
	}
	// Expired token must fail.
	expired := signLiveKitWebhook(secret, body, time.Now().Add(-time.Minute).Unix())
	if err := verifyLiveKitWebhook(secret, expired, body); err == nil {
		t.Error("expired token accepted")
	}
	// Missing header must fail.
	if err := verifyLiveKitWebhook(secret, "", body); err == nil {
		t.Error("empty auth accepted")
	}
}

func TestLiveKitProviderValidate(t *testing.T) {
	p := &livekitProvider{}
	if err := p.Validate(map[string]any{"apiKey": "k", "apiSecret": "s", "wsUrl": "wss://x"}); err != nil {
		t.Errorf("valid config rejected: %v", err)
	}
	if err := p.Validate(map[string]any{"apiKey": "k", "apiSecret": "s"}); err == nil {
		t.Error("missing wsUrl accepted")
	}
}

func TestLiveKitHandleInboundWebhookParsesEvent(t *testing.T) {
	p := &livekitProvider{}
	body := []byte(`{"event":"participant_joined","room":{"name":"+15125550000","sid":"RM_1"},"participant":{"identity":"+15125551234","sid":"PA_9"}}`)
	_, ct, meta, err := p.HandleInboundWebhook(t.Context(), map[string]any{}, body, http.Header{})
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if ct != "application/json" {
		t.Errorf("content type = %q", ct)
	}
	// ProviderCallID keys on room.sid so call-end (room_finished) reconciles.
	if meta.ToNumber != "+15125550000" || meta.FromNumber != "+15125551234" || meta.ProviderCallID != "RM_1" {
		t.Errorf("unexpected meta: %+v", meta)
	}
}
