package handlers

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

// signTwilio reproduces Twilio's signing scheme so the positive case in
// TestValidTwilioSignature exercises the real verification path.
func signTwilio(token, fullURL string, form url.Values) string {
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(fullURL)
	for _, k := range keys {
		b.WriteString(k)
		b.WriteString(form.Get(k))
	}
	mac := hmac.New(sha1.New, []byte(token))
	mac.Write([]byte(b.String()))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestValidTwilioSignature(t *testing.T) {
	const token = "test-auth-token"
	const fullURL = "https://example.com/v1/voice/webhook/twilio"
	form := url.Values{"From": {"+15125551234"}, "To": {"+15125550000"}, "CallSid": {"CA123"}}
	good := signTwilio(token, fullURL, form)

	if !validTwilioSignature(token, fullURL, form, good) {
		t.Fatal("valid signature rejected")
	}
	if validTwilioSignature(token, fullURL, form, good+"x") {
		t.Error("tampered signature accepted")
	}
	if validTwilioSignature("wrong-token", fullURL, form, good) {
		t.Error("wrong auth token accepted")
	}
	if validTwilioSignature(token, fullURL+"/extra", form, good) {
		t.Error("URL mismatch accepted")
	}
	if validTwilioSignature(token, fullURL, form, "") {
		t.Error("empty signature accepted")
	}
	if validTwilioSignature("", fullURL, form, good) {
		t.Error("empty token accepted")
	}
	// A mutated param must invalidate the signature.
	tampered := url.Values{"From": {"+19998887777"}, "To": {"+15125550000"}, "CallSid": {"CA123"}}
	if validTwilioSignature(token, fullURL, tampered, good) {
		t.Error("param tamper accepted")
	}
}

// signTwilioCanonical is a reference signer that handles repeated parameters
// the way Twilio's official libraries do: every (name, value) pair sorted by
// name then value, concatenated. Used to verify the multi-value path.
func signTwilioCanonical(token, fullURL string, form url.Values) string {
	type kv struct{ k, v string }
	pairs := make([]kv, 0, len(form))
	for k, vals := range form {
		for _, v := range vals {
			pairs = append(pairs, kv{k, v})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	var b strings.Builder
	b.WriteString(fullURL)
	for _, p := range pairs {
		b.WriteString(p.k)
		b.WriteString(p.v)
	}
	mac := hmac.New(sha1.New, []byte(token))
	mac.Write([]byte(b.String()))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// TestValidTwilioSignatureMultiValue is a regression test for a webhook with a
// repeated parameter (Twilio sends MediaUrl0..N as repeated keys on MMS). The
// old implementation hashed only the first value and rejected these requests.
func TestValidTwilioSignatureMultiValue(t *testing.T) {
	const token = "test-auth-token"
	const fullURL = "https://example.com/v1/sms/twilio/webhook"
	form := url.Values{
		"From":     {"+15125551234"},
		"To":       {"+15125550000"},
		"Body":     {"see attached"},
		"MediaUrl": {"https://m.twilio.com/a", "https://m.twilio.com/b"},
	}
	good := signTwilioCanonical(token, fullURL, form)
	if !validTwilioSignature(token, fullURL, form, good) {
		t.Fatal("valid multi-value signature rejected (regression: only first value hashed)")
	}
	// Dropping one of the repeated values must change the digest.
	fewer := url.Values{
		"From":     {"+15125551234"},
		"To":       {"+15125550000"},
		"Body":     {"see attached"},
		"MediaUrl": {"https://m.twilio.com/a"},
	}
	if validTwilioSignature(token, fullURL, fewer, good) {
		t.Error("signature accepted after a repeated value was dropped")
	}
}

func TestPinMatches(t *testing.T) {
	// No PIN configured: never matches (channel falls back to caller-ID gate).
	noPin := &SMSHandler{}
	if noPin.pinMatches("1234") {
		t.Error("pinMatches true when no PIN configured")
	}

	h := &SMSHandler{ownerPIN: "8421"}
	cases := map[string]bool{
		"8421":        true,
		" 8421 ":      true,
		"pin 8421":    true,
		"PIN 8421":    true,
		"unlock 8421": true,
		"Unlock 8421": true,
		"0000":        false,
		"8421 unlock": false,
		"":            false,
		"what's up":   false,
	}
	for in, want := range cases {
		if got := h.pinMatches(in); got != want {
			t.Errorf("pinMatches(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestIsVerified(t *testing.T) {
	// No PIN: always verified (legacy behavior preserved).
	if !(&SMSHandler{}).isVerified() {
		t.Error("isVerified false when no PIN configured")
	}

	h := &SMSHandler{ownerPIN: "8421", verifyTTL: time.Hour}
	if h.isVerified() {
		t.Error("isVerified true before unlock")
	}
	h.markVerified()
	if !h.isVerified() {
		t.Error("isVerified false right after unlock")
	}

	expired := &SMSHandler{ownerPIN: "8421", verifyTTL: time.Hour, verifiedUntil: time.Now().Add(-time.Minute)}
	if expired.isVerified() {
		t.Error("isVerified true after window expired")
	}
}

func TestAllowInbound(t *testing.T) {
	h := &SMSHandler{}
	for i := 0; i < smsInboundPerMinute; i++ {
		if !h.allowInbound() {
			t.Fatalf("inbound %d rejected within limit", i)
		}
	}
	if h.allowInbound() {
		t.Error("inbound past limit allowed")
	}
}
