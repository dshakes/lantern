package agentpolicy

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func enforce(mut func(*Policy)) Policy {
	p := EmptyEnforce()
	mut(&p)
	n, err := Normalize(p)
	if err != nil {
		panic(err)
	}
	return n
}

func TestEmptyEnforceDeniesEverything(t *testing.T) {
	p := EmptyEnforce()
	for _, a := range []Action{
		{Kind: KindTool, Target: "web_search"},
		{Kind: KindConnector, Target: "github", Sub: "list_prs"},
		{Kind: KindMCP, Target: "filesystem"},
		{Kind: KindEgress, Target: "api.github.com"},
		{Kind: KindA2A, Target: "other"},
		{Kind: KindA2AInbound, Target: "spiffe://pal.local/tenant/t/agent/a", SameTenant: true},
		{Kind: KindSecret, Target: "pal.secret/llm/openai"},
		{Kind: "bogus", Target: "x"},
	} {
		if d := p.Evaluate(a); d.Allowed || d.Reason == "" {
			t.Errorf("%s: want deny with reason, got %+v", a, d)
		}
	}
}

func TestLegacyPermissiveAllowsEverything(t *testing.T) {
	p := LegacyPermissive()
	for _, a := range []Action{
		{Kind: KindTool, Target: "shell_exec"},
		{Kind: KindConnector, Target: "slack", Sub: "post_message"},
		{Kind: KindA2AInbound, Target: "tenant:x"},
	} {
		if d := p.Evaluate(a); !d.Allowed || d.Rule != "legacy_permissive" {
			t.Errorf("%s: want legacy allow, got %+v", a, d)
		}
	}
}

func TestUnknownModeDenies(t *testing.T) {
	p := Policy{Mode: "yolo", Tools: []string{"*"}}
	if d := p.Evaluate(Action{Kind: KindTool, Target: "web_search"}); d.Allowed {
		t.Fatalf("unknown mode must deny, got %+v", d)
	}
}

func TestEvaluateTable(t *testing.T) {
	p := enforce(func(p *Policy) {
		p.Tools = []string{"web_search", "read_*"}
		p.Connectors = map[string][]string{"github": {"list_*", "get_issue"}, "slack": {"post_message"}}
		p.MCPServers = []string{"filesystem"}
		p.EgressHosts = []string{"api.github.com", "*.example.org"}
		p.A2ATargets = []string{"research-agent", "marketplace:summarizer", "spiffe://pal.local/tenant/t2/agent/*"}
		p.A2AInbound = []string{"tenant:self", "tenant:11111111-1111-1111-1111-111111111111"}
		p.Secrets = []string{"pal.secret/llm/*"}
	})
	cases := []struct {
		a    Action
		want bool
	}{
		{Action{Kind: KindTool, Target: "web_search"}, true},
		{Action{Kind: KindTool, Target: "read_file"}, true},
		{Action{Kind: KindTool, Target: "shell_exec"}, false},
		{Action{Kind: KindTool, Target: "web_search_x"}, false},
		{Action{Kind: KindConnector, Target: "github", Sub: "list_prs"}, true},
		{Action{Kind: KindConnector, Target: "github", Sub: "get_issue"}, true},
		{Action{Kind: KindConnector, Target: "github", Sub: "delete_repo"}, false},
		{Action{Kind: KindConnector, Target: "slack", Sub: "post_message"}, true},
		{Action{Kind: KindConnector, Target: "gmail", Sub: "list_messages"}, false},
		{Action{Kind: KindMCP, Target: "filesystem"}, true},
		{Action{Kind: KindMCP, Target: "browser"}, false},
		{Action{Kind: KindEgress, Target: "api.github.com"}, true},
		{Action{Kind: KindEgress, Target: "API.GitHub.com:443"}, true},
		{Action{Kind: KindEgress, Target: "evil.com"}, false},
		{Action{Kind: KindEgress, Target: "a.example.org"}, true},
		{Action{Kind: KindEgress, Target: "example.org"}, false}, // apex not covered by *.
		{Action{Kind: KindEgress, Target: "*.a.example.org"}, true},
		{Action{Kind: KindEgress, Target: "*.example.org"}, true},
		{Action{Kind: KindEgress, Target: "*.org"}, false},
		{Action{Kind: KindEgress, Target: "*"}, false},
		{Action{Kind: KindA2A, Target: "research-agent"}, true},
		{Action{Kind: KindA2A, Target: "x", Aliases: []string{"marketplace:summarizer"}}, true},
		{Action{Kind: KindA2A, Target: "y", Aliases: []string{"spiffe://pal.local/tenant/t2/agent/abc"}}, true},
		{Action{Kind: KindA2A, Target: "z", Aliases: []string{"spiffe://pal.local/tenant/t3/agent/abc"}}, false},
		{Action{Kind: KindA2AInbound, Target: "spiffe://pal.local/tenant/t/agent/a", SameTenant: true}, true},
		{Action{Kind: KindA2AInbound, Target: "spiffe://pal.local/tenant/t9/agent/a", Aliases: []string{"tenant:11111111-1111-1111-1111-111111111111"}}, true},
		{Action{Kind: KindA2AInbound, Target: "spiffe://pal.local/tenant/t9/agent/a", Aliases: []string{"tenant:22222222-2222-2222-2222-222222222222"}}, false},
		{Action{Kind: KindSecret, Target: "pal.secret/llm/openai"}, true},
		{Action{Kind: KindSecret, Target: "pal.secret/connector/abc/oauth"}, false},
	}
	for _, c := range cases {
		d := p.Evaluate(c.a)
		if d.Allowed != c.want {
			t.Errorf("%s: allowed=%v want %v (%+v)", c.a, d.Allowed, c.want, d)
		}
		if d.Allowed && d.Rule == "" {
			t.Errorf("%s: allow must name its rule", c.a)
		}
		if !d.Allowed && d.Reason == "" {
			t.Errorf("%s: deny must carry a reason", c.a)
		}
	}
}

func TestStarConnectorKey(t *testing.T) {
	p := enforce(func(p *Policy) { p.Connectors = map[string][]string{"*": {"list_*"}} })
	if !p.Evaluate(Action{Kind: KindConnector, Target: "gmail", Sub: "list_messages"}).Allowed {
		t.Fatal("'*' connector key should allow list_* on any connector")
	}
	if p.Evaluate(Action{Kind: KindConnector, Target: "gmail", Sub: "send_message"}).Allowed {
		t.Fatal("'*' connector key must still restrict actions")
	}
}

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		p, s string
		want bool
	}{
		{"*", "", true}, {"abc", "abc", true}, {"abc", "abcd", false},
		{"a*", "a", true}, {"a*c", "abbbc", true}, {"a*c", "abbbd", false},
		{"*c", "abc", true}, {"a*b*c", "a-b-c", true}, {"a*b*c", "a-c", false},
		{"list_*", "list_", true}, {"*_x_*", "a_x_b", true}, {"ab*ba", "aba", false},
	}
	for _, c := range cases {
		if got := MatchGlob(c.p, c.s); got != c.want {
			t.Errorf("MatchGlob(%q,%q)=%v want %v", c.p, c.s, got, c.want)
		}
	}
}

// TestMatchHostParity keeps the policy host matcher identical to the in-guest
// proxy and the host broker: same fixture, same answers (ADR 0026).
func TestMatchHostParity(t *testing.T) {
	raw, err := os.ReadFile("../../services/testdata/egress_match_cases.json")
	if err != nil {
		t.Fatalf("read parity fixture: %v", err)
	}
	var fx struct {
		PatternCases []struct {
			Pattern string `json:"pattern"`
			Host    string `json:"host"`
			Match   bool   `json:"match"`
		} `json:"pattern_cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.PatternCases) == 0 {
		t.Fatal("fixture has no pattern_cases")
	}
	for _, c := range fx.PatternCases {
		if got := MatchHost(c.Pattern, c.Host); got != c.Match {
			t.Errorf("MatchHost(%q,%q)=%v, fixture says %v", c.Pattern, c.Host, got, c.Match)
		}
	}
}

func TestNormalizeValidation(t *testing.T) {
	bad := []struct {
		field string
		p     Policy
	}{
		{"mode", Policy{Mode: "nope"}},
		{"tools", Policy{Tools: []string{"bad tool"}}},
		{"egressHosts", Policy{EgressHosts: []string{"https://evil.com/x"}}},
		{"secrets", Policy{Secrets: []string{"aws/creds"}}},
		{"a2aInbound", Policy{A2AInbound: []string{"tenant:not-a-uuid"}}},
		{"connectors.github", Policy{Connectors: map[string][]string{"github": {}}}},
		{"budget.maxToolCallsPerRun", Policy{Budget: Budget{MaxToolCallsPerRun: -1}}},
	}
	for _, b := range bad {
		_, err := Normalize(b.p)
		var ve *ValidationError
		if !errors.As(err, &ve) || ve.Field != b.field {
			t.Errorf("%s: want ValidationError on %q, got %v", b.field, b.field, err)
		}
	}
	tooMany := make([]string, MaxEntries+1)
	for i := range tooMany {
		tooMany[i] = "t"
	}
	if _, err := Normalize(Policy{Tools: tooMany}); err == nil {
		t.Error("over-long list must be rejected")
	}
}

func TestNormalizeCanonicalAndEqual(t *testing.T) {
	a, err := Normalize(Policy{Tools: []string{"b", "a", "b"}, EgressHosts: []string{"API.GITHUB.COM:443"}, Version: 3})
	if err != nil {
		t.Fatal(err)
	}
	if a.Mode != ModeEnforce || len(a.Tools) != 2 || a.Tools[0] != "a" || a.EgressHosts[0] != "api.github.com" {
		t.Fatalf("not canonical: %+v", a)
	}
	b, _ := Normalize(Policy{Tools: []string{"a", "b"}, EgressHosts: []string{"api.github.com"}, Version: 9})
	if !Equal(a, b) {
		t.Fatal("Equal must ignore order, duplicates and version")
	}
	c, _ := Normalize(Policy{Tools: []string{"a"}})
	if Equal(a, c) {
		t.Fatal("different grants must not be Equal")
	}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	if _, err := Decode([]byte(`{"mode":"enforce","egresHosts":["*"]}`)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("typo'd field must be rejected, got %v", err)
	}
	p, err := Decode([]byte(`{"mode":"enforce","tools":["web_search"],"version":2}`))
	if err != nil || p.Version != 2 || len(p.Tools) != 1 {
		t.Fatalf("decode: %+v %v", p, err)
	}
}
