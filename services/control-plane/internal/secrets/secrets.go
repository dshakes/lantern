// Package secrets provides envelope encryption for connector credentials and
// OAuth tokens that are stored in Postgres JSONB columns
// (connector_installs.config, connector_installs.oauth_token_encrypted, ...).
//
// # Storage model
//
// Those columns must remain valid JSONB, so an encrypted value is wrapped in a
// small JSON envelope rather than written as a raw base64 blob:
//
//	{"__lantern_enc__":1,"alg":"AES-256-GCM","ct":"<base64(nonce|ciphertext)>"}
//
// Plaintext (legacy) rows are ordinary JSON objects without the
// "__lantern_enc__" marker. Decrypt detects this and returns them unchanged, so
// the rollout is backward compatible and needs no data migration: existing
// installs keep working, and the next write re-stores them encrypted.
//
// # Key management
//
// The master key comes from LANTERN_CREDENTIAL_KEY, a base64- or hex-encoded
// 32-byte (AES-256) key. When the variable is unset, Encrypt is a pass-through
// that stores plaintext JSON and EncryptionEnabled reports false — this keeps
// local dev frictionless while making production encryption a single env var
// away. In production the key should be delivered by a KMS / secrets manager;
// rotation is done by setting the new key and re-encrypting rows (the legacy
// detection in Decrypt makes a lazy, write-through rotation safe).
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
)

// EnvKey is the environment variable holding the base64/hex-encoded 32-byte
// master key. Exported so callers and tests can reference it by name.
const EnvKey = "LANTERN_CREDENTIAL_KEY"

const (
	envelopeMarker = "__lantern_enc__"
	algGCM         = "AES-256-GCM"
)

// envelope is the on-disk JSON shape for an encrypted value.
type envelope struct {
	Marker int    `json:"__lantern_enc__"`
	Alg    string `json:"alg"`
	CT     string `json:"ct"`
}

var (
	keyOnce sync.Once
	key     []byte // nil when encryption is disabled
	keyErr  error
)

// loadKey resolves the master key from the environment exactly once. A missing
// key is not an error (encryption is simply disabled); a present-but-malformed
// key is, so a misconfigured production deployment fails loudly the first time
// it touches a credential rather than silently storing plaintext.
func loadKey() ([]byte, error) {
	keyOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv(EnvKey))
		if raw == "" {
			return // disabled
		}
		k, err := decodeKey(raw)
		if err != nil {
			keyErr = err
			return
		}
		key = k
	})
	return key, keyErr
}

// decodeKey accepts standard base64, URL-safe base64, or hex and requires the
// decoded result to be exactly 32 bytes.
func decodeKey(raw string) ([]byte, error) {
	var decoders = []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
		base64.URLEncoding.DecodeString,
		base64.RawURLEncoding.DecodeString,
		hex.DecodeString,
	}
	for _, dec := range decoders {
		if b, err := dec(raw); err == nil && len(b) == 32 {
			return b, nil
		}
	}
	return nil, fmt.Errorf("%s must decode (base64 or hex) to exactly 32 bytes for AES-256", EnvKey)
}

// EncryptionEnabled reports whether a usable master key is configured. It
// returns an error only when a key is set but malformed.
func EncryptionEnabled() (bool, error) {
	k, err := loadKey()
	if err != nil {
		return false, err
	}
	return k != nil, nil
}

// Encrypt wraps plaintext JSON in an encrypted envelope. When no key is
// configured it returns the input unchanged (pass-through) so callers can store
// the result in a JSONB column either way. Empty input is returned as-is.
func Encrypt(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return plaintext, nil
	}
	k, err := loadKey()
	if err != nil {
		return nil, err
	}
	if k == nil {
		return plaintext, nil // disabled: store plaintext
	}

	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nonce, nonce, plaintext, nil)

	out, err := json.Marshal(envelope{
		Marker: 1,
		Alg:    algGCM,
		CT:     base64.StdEncoding.EncodeToString(sealed),
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Decrypt is the inverse of Encrypt. A value that is not an encrypted envelope
// (legacy plaintext, or written while encryption was disabled) is returned
// unchanged, which is what makes the rollout migration-free.
func Decrypt(stored []byte) ([]byte, error) {
	if len(stored) == 0 {
		return stored, nil
	}
	// Cheap pre-check before a full unmarshal: an envelope always contains
	// the marker key. Avoids parsing large/legacy blobs unnecessarily.
	if !strings.Contains(string(stored), envelopeMarker) {
		return stored, nil
	}
	var env envelope
	if err := json.Unmarshal(stored, &env); err != nil || env.Marker != 1 || env.CT == "" {
		// Not (or not a well-formed) envelope — treat as plaintext.
		return stored, nil
	}
	if env.Alg != algGCM {
		return nil, fmt.Errorf("unsupported credential encryption alg %q", env.Alg)
	}

	k, err := loadKey()
	if err != nil {
		return nil, err
	}
	if k == nil {
		return nil, errors.New("credential is encrypted but " + EnvKey + " is not set")
	}

	sealed, err := base64.StdEncoding.DecodeString(env.CT)
	if err != nil {
		return nil, fmt.Errorf("decode ciphertext: %w", err)
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt credential: %w", err)
	}
	return plaintext, nil
}

// EncryptString is a convenience wrapper for callers that thread credentials as
// strings (e.g. building SQL parameters). It returns a string suitable for a
// ::jsonb column parameter.
func EncryptString(plaintext string) (string, error) {
	b, err := Encrypt([]byte(plaintext))
	if err != nil {
		return "", err
	}
	return string(b), nil
}
