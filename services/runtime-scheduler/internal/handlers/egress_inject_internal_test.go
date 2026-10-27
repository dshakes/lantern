package handlers

import (
	"testing"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// ADR 0026: fork/restore re-spawns carry the spec's credential-injection
// rules through to the manager (the manager's broker needs them per
// incarnation).
func TestWithIdentity_PreservesEgressInject(t *testing.T) {
	spec := &lanternv1.AgentSpec{EgressRules: []*lanternv1.EgressRule{{
		Pattern: "api.openai.com",
		Inject: []*lanternv1.CredentialInjection{{
			Header: "Authorization", SecretUri: "lantern.secret/llm/openai", ValuePrefix: "Bearer ",
		}},
	}}}
	out := withIdentity(spec, &lanternv1.ForkIdentity{AgentInstanceId: "ai-1"})
	inj := out.GetEgressRules()[0].GetInject()
	if len(inj) != 1 || inj[0].GetSecretUri() != "lantern.secret/llm/openai" || inj[0].GetValuePrefix() != "Bearer " {
		t.Fatalf("inject lost through withIdentity: %+v", inj)
	}
}
