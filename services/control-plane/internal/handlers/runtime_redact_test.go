package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

// A live agent-instance JWT was persisted into runtime_vms.spec and served
// verbatim by GET /v1/runtime/vms — a bearer credential readable by anyone
// with runtime:read, for the whole of its TTL. Invariant #10 says secrets
// never appear in run state.
const fakeToken = "eyJhbGciOiJIUzI1NiJ9.payload.signature"

func specWithToken() map[string]any {
	return map[string]any{
		"image_digest": "demo:latest",
		"env": map[string]any{
			"LANTERN_AGENT_INSTANCE_ID":    "ai-123",
			"LANTERN_AGENT_INSTANCE_TOKEN": fakeToken,
			"MY_APP_SETTING":               "keep-me",
		},
	}
}

func TestRedactSpecSecrets_RemovesInstanceToken(t *testing.T) {
	got := redactSpecSecrets(specWithToken())

	env, ok := got["env"].(map[string]any)
	if !ok {
		t.Fatal("env missing from redacted spec")
	}
	if env["LANTERN_AGENT_INSTANCE_TOKEN"] != redactedValue {
		t.Fatalf("token must be redacted, got %v", env["LANTERN_AGENT_INSTANCE_TOKEN"])
	}
	// The instance ID is an identifier, not a credential — it stays, and so
	// does unrelated caller config.
	if env["LANTERN_AGENT_INSTANCE_ID"] != "ai-123" {
		t.Fatalf("instance id must survive, got %v", env["LANTERN_AGENT_INSTANCE_ID"])
	}
	if env["MY_APP_SETTING"] != "keep-me" {
		t.Fatalf("caller env must survive, got %v", env["MY_APP_SETTING"])
	}
	if got["image_digest"] != "demo:latest" {
		t.Fatalf("non-env fields must survive, got %v", got["image_digest"])
	}
}

// The scheduler legitimately needs the real token, so the caller's map must
// not be mutated out from under the dispatch.
func TestRedactSpecSecrets_DoesNotMutateInput(t *testing.T) {
	in := specWithToken()
	_ = redactSpecSecrets(in)

	env := in["env"].(map[string]any)
	if env["LANTERN_AGENT_INSTANCE_TOKEN"] != fakeToken {
		t.Fatal("input map was mutated; the spawn would ship a redacted token")
	}
}

func TestRedactSpecJSON_RedactsRowsWrittenBeforeTheFix(t *testing.T) {
	raw, err := json.Marshal(specWithToken())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	out := redactSpecJSON(raw)

	if strings.Contains(string(out), fakeToken) {
		t.Fatalf("token leaked through the read path: %s", out)
	}
	if !strings.Contains(string(out), redactedValue) {
		t.Fatalf("expected a redaction marker, got: %s", out)
	}
}

// A malformed spec is a display problem, not a reason to fail the request.
func TestRedactSpecJSON_PassesThroughUnparseable(t *testing.T) {
	raw := []byte("not json")
	if got := string(redactSpecJSON(raw)); got != "not json" {
		t.Fatalf("unparseable spec should pass through, got %q", got)
	}
	if got := redactSpecJSON(nil); got != nil {
		t.Fatalf("nil spec should pass through, got %v", got)
	}
}

func TestRedactSpecSecrets_NoEnvIsUntouched(t *testing.T) {
	in := map[string]any{"image_digest": "demo:latest"}
	got := redactSpecSecrets(in)
	if got["image_digest"] != "demo:latest" {
		t.Fatalf("spec without env should be unchanged, got %v", got)
	}
}
