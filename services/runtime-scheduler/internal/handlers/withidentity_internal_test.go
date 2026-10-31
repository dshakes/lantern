package handlers

import (
	"testing"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
)

// A fork never inherits the source VM's identity.
func TestWithIdentity_ReplacesSourceIdentity(t *testing.T) {
	spec := &palv1.AgentSpec{Env: map[string]string{
		"PAL_AGENT_INSTANCE_ID":    "src-id",
		"PAL_AGENT_INSTANCE_TOKEN": "src-tok",
		"KEEP":                     "1",
	}}
	out := withIdentity(spec, &palv1.ForkIdentity{AgentInstanceId: "fork-id", AgentInstanceToken: "fork-tok"})
	want := map[string]string{
		"PAL_AGENT_INSTANCE_ID":    "fork-id",
		"PAL_AGENT_INSTANCE_TOKEN": "fork-tok",
		"KEEP":                     "1",
	}
	if len(out.Env) != len(want) {
		t.Fatalf("env = %v, want %v", out.Env, want)
	}
	for k, v := range want {
		if out.Env[k] != v {
			t.Fatalf("%s = %q, want %q", k, out.Env[k], v)
		}
	}
	if spec.Env["PAL_AGENT_INSTANCE_TOKEN"] != "src-tok" {
		t.Fatal("source spec was mutated")
	}
}
