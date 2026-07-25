package cli

// runtime_spec_test.go — `lantern init` output fed to `lantern run` used to
// fail with a bare "400: invalid body" from the server, giving no hint that
// the file was simply the wrong KIND of agent.yaml. The two shapes are
// genuinely different things (control-plane agent vs microVM AgentSpec), so
// the fix is a clear diagnosis, not a schema merge.

import (
	"strings"
	"testing"
)

func TestValidateRuntimeSpec_AcceptsRuntimeSpec(t *testing.T) {
	spec := map[string]any{"image_digest": "demo:latest", "isolation": "trusted"}
	if err := validateRuntimeSpec(spec, map[string]any{"spec": spec}, "a.yaml"); err != nil {
		t.Fatalf("valid runtime spec rejected: %v", err)
	}
}

func TestValidateRuntimeSpec_AcceptsCamelCase(t *testing.T) {
	spec := map[string]any{"imageDigest": "demo:latest"}
	if err := validateRuntimeSpec(spec, map[string]any{}, "a.yaml"); err != nil {
		t.Fatalf("camelCase imageDigest rejected: %v", err)
	}
}

// `lantern init` writes `isolation: {class: trusted}`; the API wants a flat
// string. Both spellings should work.
func TestValidateRuntimeSpec_FlattensNestedIsolation(t *testing.T) {
	spec := map[string]any{
		"image_digest": "demo:latest",
		"isolation":    map[string]any{"class": "untrusted"},
	}
	if err := validateRuntimeSpec(spec, map[string]any{}, "a.yaml"); err != nil {
		t.Fatalf("nested isolation rejected: %v", err)
	}
	if spec["isolation"] != "untrusted" {
		t.Fatalf("isolation should be flattened to a string, got %#v", spec["isolation"])
	}
}

// The headline UX bug: scaffold, then run, and get an unexplained 400.
func TestValidateRuntimeSpec_DiagnosesControlPlaneManifest(t *testing.T) {
	raw := map[string]any{
		"name":        "demo",
		"version":     "0.1.0",
		"model":       "auto",
		"isolation":   map[string]any{"class": "trusted"},
		"description": "A Lantern agent",
	}

	err := validateRuntimeSpec(raw, raw, "demo/agent.yaml")
	if err == nil {
		t.Fatal("a control-plane manifest must not be accepted by `lantern run`")
	}
	msg := err.Error()
	for _, want := range []string{"control-plane agent manifest", "image_digest", "lantern deploy", "demo"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error should mention %q; got:\n%s", want, msg)
		}
	}
}

func TestValidateRuntimeSpec_MissingImageIsNamed(t *testing.T) {
	spec := map[string]any{"isolation": "trusted"}

	err := validateRuntimeSpec(spec, map[string]any{}, "a.yaml")
	if err == nil {
		t.Fatal("a spec with no image must be rejected")
	}
	if !strings.Contains(err.Error(), "image_digest") {
		t.Fatalf("error should name the missing field; got: %v", err)
	}
}
