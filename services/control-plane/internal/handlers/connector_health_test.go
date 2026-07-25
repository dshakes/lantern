package handlers

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// The live failure: 124 runs across 7 days, all identical, all unfixable by
// retrying — "credential is encrypted but LANTERN_CREDENTIAL_KEY is not set".
func TestPermanentCredentialFailure_MissingKey(t *testing.T) {
	err := fmt.Errorf("decrypt connector oauth token: %w",
		errors.New("credential is encrypted but LANTERN_CREDENTIAL_KEY is not set"))

	reason, permanent := permanentCredentialFailure(err)
	if !permanent {
		t.Fatal("a missing decryption key can never be fixed by retrying — must be permanent")
	}
	if reason == "" {
		t.Fatal("a permanent failure must carry an operator-facing reason")
	}
	// The reason has to say what to DO, not just what broke.
	for _, want := range []string{"LANTERN_CREDENTIAL_KEY", "re-authorize"} {
		if !strings.Contains(reason, want) {
			t.Errorf("reason should mention %q; got: %s", want, reason)
		}
	}
}

func TestPermanentCredentialFailure_Recognised(t *testing.T) {
	for _, msg := range []string{
		"cipher: message authentication failed",
		"malformed ciphertext",
		"oauth2: invalid_grant",
		"Token has been expired or revoked",
		"refresh token is invalid",
	} {
		if _, permanent := permanentCredentialFailure(errors.New(msg)); !permanent {
			t.Errorf("%q should be classified permanent", msg)
		}
	}
}

// The safety property. Misclassifying a TRANSIENT failure as permanent takes a
// working integration offline until a human notices; misclassifying the other
// way costs one more failed run. So anything unrecognised must be transient.
func TestPermanentCredentialFailure_UnknownIsTransient(t *testing.T) {
	for _, msg := range []string{
		"connection reset by peer",
		"context deadline exceeded",
		"429 Too Many Requests",
		"503 Service Unavailable",
		"dial tcp: i/o timeout",
		"unexpected EOF",
		"some brand new error nobody has seen",
	} {
		if reason, permanent := permanentCredentialFailure(errors.New(msg)); permanent {
			t.Errorf("%q must NOT be permanent (would quarantine a healthy connector); reason=%s", msg, reason)
		}
	}
}

func TestPermanentCredentialFailure_NilIsTransient(t *testing.T) {
	if _, permanent := permanentCredentialFailure(nil); permanent {
		t.Fatal("nil error must not be permanent")
	}
}

// Classification must survive wrapping, since the error crosses package
// boundaries as wrapped text.
func TestPermanentCredentialFailure_SurvivesWrapping(t *testing.T) {
	inner := errors.New("credential is encrypted but LANTERN_CREDENTIAL_KEY is not set")
	wrapped := fmt.Errorf("inbox-triage: gmail fetch: %w",
		fmt.Errorf("decrypt connector oauth token: %w", inner))

	if _, permanent := permanentCredentialFailure(wrapped); !permanent {
		t.Fatal("classification must survive multiple layers of wrapping")
	}
}

// "Go install it" and "your credential broke" are different instructions.
func TestErrConnectorNeedsReauth_IsDistinguishable(t *testing.T) {
	err := &errConnectorNeedsReauth{ConnectorID: "gmail", Reason: "token revoked"}

	if !IsConnectorNeedsReauth(err) {
		t.Fatal("quarantine error must be detectable")
	}
	if isConnectorNotInstalled(err) {
		t.Fatal("must not be confused with not-installed")
	}
	if !strings.Contains(err.Error(), "gmail") || !strings.Contains(err.Error(), "token revoked") {
		t.Fatalf("error should name the connector and the reason; got: %s", err)
	}

	if IsConnectorNeedsReauth(&errConnectorNotInstalled{ConnectorID: "gmail"}) {
		t.Fatal("not-installed must not be reported as needing re-auth")
	}
	if IsConnectorNeedsReauth(errors.New("boom")) {
		t.Fatal("unrelated errors must not be reported as needing re-auth")
	}
}

func TestIsConnectorNeedsReauth_UnwrapsWrapped(t *testing.T) {
	wrapped := fmt.Errorf("tool dispatch: %w", &errConnectorNeedsReauth{ConnectorID: "gmail"})
	if !IsConnectorNeedsReauth(wrapped) {
		t.Fatal("detection must work through fmt.Errorf wrapping")
	}
}
