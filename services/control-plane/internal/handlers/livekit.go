package handlers

// LiveKit voice provider.
//
// LiveKit splits cleanly into two halves:
//
//   - Server side (this file): mints the access tokens participants use to
//     join a room, and verifies LiveKit's signed webhooks. These are pure,
//     self-contained crypto operations (HS256 JWT over the API secret) — no
//     SDK, no media. This is exactly what a LiveKit "token server" does and
//     is fully implemented + tested here.
//
//   - Agent worker (deployed separately by the operator): a LiveKit Agents
//     process that joins the room and runs the realtime STT→LLM→TTS loop.
//     It authenticates with a token minted here. That worker is the media
//     last-mile, analogous to Twilio Media Streams for the Twilio provider.
//
// Inbound PSTN reaches a room via a LiveKit SIP trunk + dispatch rule the
// operator configures; LiveKit then fires the webhooks this file verifies.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ---------- Access-token minting ----------

// livekitVideoGrant is the LiveKit "video" claim. Pointers let us emit
// canPublish/canSubscribe explicitly (LiveKit treats an omitted grant as
// false in some server versions, so we never rely on defaults).
type livekitVideoGrant struct {
	Room           string `json:"room,omitempty"`
	RoomJoin       bool   `json:"roomJoin,omitempty"`
	RoomCreate     bool   `json:"roomCreate,omitempty"`
	CanPublish     *bool  `json:"canPublish,omitempty"`
	CanSubscribe   *bool  `json:"canSubscribe,omitempty"`
	CanPublishData *bool  `json:"canPublishData,omitempty"`
}

type livekitClaims struct {
	Iss   string            `json:"iss"`
	Sub   string            `json:"sub"`
	Nbf   int64             `json:"nbf"`
	Exp   int64             `json:"exp"`
	Name  string            `json:"name,omitempty"`
	Video livekitVideoGrant `json:"video"`
}

func boolPtr(b bool) *bool { return &b }

// mintLiveKitToken builds a LiveKit-compatible HS256 JWT granting the given
// identity permission to join room. ttl bounds the token's validity.
func mintLiveKitToken(apiKey, apiSecret, room, identity, displayName string, ttl time.Duration) (string, error) {
	if apiKey == "" || apiSecret == "" {
		return "", fmt.Errorf("livekit apiKey and apiSecret are required")
	}
	if identity == "" {
		return "", fmt.Errorf("identity is required")
	}
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	now := time.Now()
	claims := livekitClaims{
		Iss:  apiKey,
		Sub:  identity,
		Nbf:  now.Add(-10 * time.Second).Unix(),
		Exp:  now.Add(ttl).Unix(),
		Name: displayName,
		Video: livekitVideoGrant{
			Room:           room,
			RoomJoin:       true,
			CanPublish:     boolPtr(true),
			CanSubscribe:   boolPtr(true),
			CanPublishData: boolPtr(true),
		},
	}
	return signHS256JWT(claims, apiSecret)
}

// signHS256JWT encodes a JWT with the standard {alg:HS256,typ:JWT} header.
func signHS256JWT(claims any, secret string) (string, error) {
	header := map[string]string{"alg": "HS256", "typ": "JWT"}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	cb, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(hb) + "." + enc.EncodeToString(cb)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	sig := enc.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig, nil
}

// ---------- Webhook verification ----------

// verifyLiveKitWebhook authenticates a LiveKit webhook. LiveKit signs each
// delivery with an Authorization-header JWT (HS256 over the API secret) whose
// `sha256` claim is the base64 SHA-256 of the raw body. We verify the JWT
// signature, its expiry, and that the body hash matches.
func verifyLiveKitWebhook(apiSecret, authHeader string, body []byte) error {
	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token == "" {
		return fmt.Errorf("missing Authorization token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Errorf("malformed JWT")
	}
	enc := base64.RawURLEncoding
	mac := hmac.New(sha256.New, []byte(apiSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expectedSig := enc.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expectedSig), []byte(parts[2])) {
		return fmt.Errorf("signature mismatch")
	}

	claimsRaw, err := enc.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("decode claims: %w", err)
	}
	var claims struct {
		Exp    int64  `json:"exp"`
		Sha256 string `json:"sha256"`
	}
	if err := json.Unmarshal(claimsRaw, &claims); err != nil {
		return fmt.Errorf("parse claims: %w", err)
	}
	if claims.Exp != 0 && time.Now().Unix() > claims.Exp {
		return fmt.Errorf("token expired")
	}
	sum := sha256.Sum256(body)
	if claims.Sha256 != "" {
		// LiveKit uses standard base64 for the body hash claim.
		if base64.StdEncoding.EncodeToString(sum[:]) != claims.Sha256 {
			return fmt.Errorf("body hash mismatch")
		}
	}
	return nil
}

// ---------- VoiceProvider implementation ----------

type livekitProvider struct{}

func (p *livekitProvider) Validate(config map[string]any) error {
	if _, ok := config["apiKey"].(string); !ok {
		return fmt.Errorf("livekit.apiKey is required")
	}
	if _, ok := config["apiSecret"].(string); !ok {
		return fmt.Errorf("livekit.apiSecret is required")
	}
	if _, ok := config["wsUrl"].(string); !ok {
		return fmt.Errorf("livekit.wsUrl is required (e.g. wss://your-project.livekit.cloud)")
	}
	return nil
}

func (p *livekitProvider) VerifyWebhook(config map[string]any, _ string, headers http.Header, body []byte) error {
	secret, _ := config["apiSecret"].(string)
	if secret == "" {
		return fmt.Errorf("livekit apiSecret not configured")
	}
	return verifyLiveKitWebhook(secret, headers.Get("Authorization"), body)
}

// HandleInboundWebhook parses a verified LiveKit webhook event and returns the
// normalized call descriptor. LiveKit only needs a 200 with no body, so the
// response is empty. Routing the call to an agent is handled by the operator's
// SIP dispatch rule + the LiveKit Agents worker (the media last-mile).
func (p *livekitProvider) HandleInboundWebhook(_ context.Context, _ map[string]any, body []byte, _ http.Header) ([]byte, string, InboundCall, error) {
	var event struct {
		Event string `json:"event"`
		Room  struct {
			Name string `json:"name"`
			Sid  string `json:"sid"`
		} `json:"room"`
		Participant struct {
			Identity string `json:"identity"`
			Sid      string `json:"sid"`
		} `json:"participant"`
	}
	_ = json.Unmarshal(body, &event)
	meta := InboundCall{
		ProviderCallID: firstNonEmpty(event.Participant.Sid, event.Room.Sid),
		FromNumber:     event.Participant.Identity,
		ToNumber:       event.Room.Name,
	}
	return []byte(""), "application/json", meta, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
