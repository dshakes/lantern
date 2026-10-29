package handlers

import (
	"testing"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// ADR 0032: a fork never inherits the source VM's identity under either name.
func TestWithIdentity_ReplacesBothNames(t *testing.T) {
	spec := &lanternv1.AgentSpec{Env: map[string]string{
		"LANTERN_AGENT_INSTANCE_ID":    "src-id",
		"LANTERN_AGENT_INSTANCE_TOKEN": "src-tok",
		"PAL_AGENT_INSTANCE_ID":        "src-id",
		"PAL_AGENT_INSTANCE_TOKEN":     "src-tok",
		"KEEP":                         "1",
	}}
	out := withIdentity(spec, &lanternv1.ForkIdentity{AgentInstanceId: "fork-id", AgentInstanceToken: "fork-tok"})
	want := map[string]string{
		"LANTERN_AGENT_INSTANCE_ID":    "fork-id",
		"LANTERN_AGENT_INSTANCE_TOKEN": "fork-tok",
		"KEEP":                         "1",
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
