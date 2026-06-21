package handlers

// AgentIdentityWellKnown handles GET /.well-known/lantern-agent-identity.
//
// Ed25519 mode: publishes {algorithm, publicKey, keyFingerprint} so external
// verifiers can confirm agent-instance JWT signatures without a shared secret.
//
// HS256 mode (dev / fallback): publishes {algorithm:"HS256"} only — no secret
// material is ever emitted.
//
// No auth required (mirrors /.well-known/lantern-receipts).

import (
	"encoding/base64"
	"net/http"

	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
)

// AgentIdentityWellKnown is a standalone handler function (no state needed
// beyond the package-level key singleton in agentidentity).
func AgentIdentityWellKnown(w http.ResponseWriter, _ *http.Request) {
	pub := agentidentity.AgentIdentityPublicKey()
	if pub != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"algorithm":      "Ed25519",
			"publicKey":      base64.StdEncoding.EncodeToString(pub),
			"keyFingerprint": agentidentity.AgentIdentityKeyFingerprint(),
			"docs":           "https://docs.lantern.dev/agent-identity",
		})
		return
	}
	// HS256 fallback — never emit the secret.
	writeJSON(w, http.StatusOK, map[string]any{
		"algorithm": "HS256",
		"docs":      "https://docs.lantern.dev/agent-identity",
	})
}
