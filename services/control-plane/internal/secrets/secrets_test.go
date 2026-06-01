package secrets

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

// resetKeyState clears the sync.Once-cached key so a test can configure a fresh
// key. Only valid in tests (relies on no concurrent use within the test). A
// zero-value sync.Once is reusable, so reassigning it re-arms loadKey.
func resetKeyState() {
	keyOnce = sync.Once{}
	key = nil
	keyErr = nil
}

// roundTrip exercises Encrypt then Decrypt and asserts the plaintext survives.
func roundTrip(t *testing.T, plaintext string) {
	t.Helper()
	enc, err := Encrypt([]byte(plaintext))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	dec, err := Decrypt(enc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(dec) != plaintext {
		t.Fatalf("round trip mismatch: got %q want %q", dec, plaintext)
	}
}

func TestPassthroughWhenDisabled(t *testing.T) {
	resetKeyState()
	t.Setenv(EnvKey, "")

	pt := `{"accountSid":"AC123","authToken":"secret"}`
	enc, err := Encrypt([]byte(pt))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if string(enc) != pt {
		t.Fatalf("expected pass-through when disabled, got %q", enc)
	}
	// Decrypt of plaintext is a no-op.
	dec, err := Decrypt(enc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(dec) != pt {
		t.Fatalf("decrypt plaintext changed value: %q", dec)
	}
}

func TestEncryptRoundTrip(t *testing.T) {
	resetKeyState()
	t.Setenv(EnvKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))

	roundTrip(t, `{"accountSid":"AC123","authToken":"secret"}`)
	roundTrip(t, `{"access_token":"ya29.abc","refresh_token":"1//xyz"}`)
}

func TestEncryptProducesValidJSONEnvelope(t *testing.T) {
	resetKeyState()
	t.Setenv(EnvKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))

	enc, err := Encrypt([]byte(`{"k":"v"}`))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	// Must remain valid JSON so it can live in a JSONB column.
	var obj map[string]any
	if err := json.Unmarshal(enc, &obj); err != nil {
		t.Fatalf("envelope is not valid JSON: %v (%s)", err, enc)
	}
	if obj[envelopeMarker] == nil {
		t.Fatalf("envelope missing marker: %s", enc)
	}
	// Ciphertext must not contain the plaintext.
	if strings.Contains(string(enc), "\"v\"") {
		t.Fatalf("plaintext leaked into envelope: %s", enc)
	}
}

func TestLegacyPlaintextDecryptsUnchanged(t *testing.T) {
	resetKeyState()
	t.Setenv(EnvKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))

	// A row written before encryption was enabled: plain JSON, no marker.
	legacy := `{"accountSid":"AC123","authToken":"secret"}`
	dec, err := Decrypt([]byte(legacy))
	if err != nil {
		t.Fatalf("decrypt legacy: %v", err)
	}
	if string(dec) != legacy {
		t.Fatalf("legacy plaintext changed: %q", dec)
	}
}

func TestEncryptedRowRequiresKey(t *testing.T) {
	// Encrypt with a key...
	resetKeyState()
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 1)
	}
	t.Setenv(EnvKey, base64.StdEncoding.EncodeToString(k))
	enc, err := Encrypt([]byte(`{"k":"v"}`))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	// ...then lose the key: decrypt must fail closed, not return ciphertext.
	resetKeyState()
	t.Setenv(EnvKey, "")
	if _, err := Decrypt(enc); err == nil {
		t.Fatalf("expected error decrypting without key, got nil")
	}
}

func TestMalformedKeyIsError(t *testing.T) {
	resetKeyState()
	t.Setenv(EnvKey, "not-a-valid-32-byte-key")
	if _, err := EncryptionEnabled(); err == nil {
		t.Fatalf("expected error for malformed key")
	}
}

func TestEmptyInputUnchanged(t *testing.T) {
	resetKeyState()
	t.Setenv(EnvKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	enc, err := Encrypt(nil)
	if err != nil {
		t.Fatalf("encrypt nil: %v", err)
	}
	if len(enc) != 0 {
		t.Fatalf("expected empty output for empty input, got %q", enc)
	}
}
