package handlers

import (
	"testing"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
)

// ADR 0026: fork/restore re-spawns carry the spec's credential-injection
// rules through to the manager (the manager's broker needs them per
// incarnation).
func TestWithIdentity_PreservesEgressInject(t *testing.T) {
	spec := &palv1.AgentSpec{EgressRules: []*palv1.EgressRule{{
		Pattern: "api.openai.com",
		Inject: []*palv1.CredentialInjection{{
			Header: "Authorization", SecretUri: "pal.secret/llm/openai", ValuePrefix: "Bearer ",
		}},
	}}}
	out := withIdentity(spec, &palv1.ForkIdentity{AgentInstanceId: "ai-1"})
	inj := out.GetEgressRules()[0].GetInject()
	if len(inj) != 1 || inj[0].GetSecretUri() != "pal.secret/llm/openai" || inj[0].GetValuePrefix() != "Bearer " {
		t.Fatalf("inject lost through withIdentity: %+v", inj)
	}
}
