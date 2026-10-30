// Package agentpolicy is the pure, I/O-free evaluator for per-agent
// least-privilege policy (ADR 0052). The control-plane and the
// workflow-engine both import it so a tool decision is computed by exactly one
// implementation no matter which service dispatches the tool.
//
// Semantics, in one place:
//
//   - Default deny. An action not matched by an allow rule is denied.
//   - ModeLegacyPermissive allows everything (it exists only so agents that
//     predate per-agent policy keep working); it is still evaluated, and the
//     decision still carries a rule so the audit log shows the blast radius.
//   - Patterns: '*' matches any run of characters (including none) inside one
//     field; the single pattern "*" matches anything.
//   - Hosts: lowercased, port stripped, "*.example.org" matches strict
//     subdomains only (never the apex) — identical to the in-guest / broker
//     egress matcher (services/testdata/egress_match_cases.json).
package agentpolicy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Mode selects how a policy is applied.
type Mode string

const (
	// ModeEnforce is default-deny: only explicitly allowed actions pass.
	ModeEnforce Mode = "enforce"
	// ModeLegacyPermissive allows every action. Backfilled for agents that
	// existed before per-agent policy; surfaced in the dashboard as a warning.
	ModeLegacyPermissive Mode = "legacy_permissive"
)

// Kind is the class of action being authorized.
type Kind string

const (
	KindTool       Kind = "tool"        // built-in or runtime tool by name
	KindConnector  Kind = "connector"   // connector Target, action Sub
	KindMCP        Kind = "mcp"         // MCP server slug Target, tool Sub
	KindEgress     Kind = "egress"      // outbound host (or host pattern) Target
	KindA2A        Kind = "a2a"         // calling another agent: Target + Aliases
	KindA2AInbound Kind = "a2a_inbound" // being called: caller ids in Target + Aliases
	KindSecret     Kind = "secret"      // pal.secret/... ref Target
)

// Budget holds the count-based ceilings a policy imposes. Zero = unlimited.
// Spend ceilings stay in agent_budgets (ADR 0052 §4).
type Budget struct {
	MaxToolCallsPerRun     int `json:"maxToolCallsPerRun"`
	MaxA2AInboundPerMinute int `json:"maxA2AInboundPerMinute"`
}

// Policy is the per-agent allowlist document. It is also the REST body.
type Policy struct {
	Mode        Mode                `json:"mode"`
	Tools       []string            `json:"tools"`
	Connectors  map[string][]string `json:"connectors"`
	MCPServers  []string            `json:"mcpServers"`
	EgressHosts []string            `json:"egressHosts"`
	A2ATargets  []string            `json:"a2aTargets"`
	A2AInbound  []string            `json:"a2aInbound"`
	Secrets     []string            `json:"secrets"`
	Budget      Budget              `json:"budget"`
	Version     int                 `json:"version"`
}

// Action is one thing an agent wants to do.
type Action struct {
	Kind   Kind
	Target string
	// Sub is the connector action or MCP tool name.
	Sub string
	// Aliases are other names for Target that a rule may use: for KindA2A the
	// target's SPIFFE id and "marketplace:<slug>"; for KindA2AInbound the
	// caller's "tenant:<id>" form.
	Aliases []string
	// SameTenant is true when the A2A caller and target share a tenant; it is
	// what the "tenant:self" inbound rule matches.
	SameTenant bool
}

// String renders the action for audit rows and error messages. Never includes
// arguments (they can carry PII / secrets).
func (a Action) String() string {
	if a.Sub != "" {
		return string(a.Kind) + ":" + a.Target + "." + a.Sub
	}
	return string(a.Kind) + ":" + a.Target
}

// Decision is the outcome of Evaluate.
type Decision struct {
	Allowed bool
	// Rule is the policy entry that allowed the action ("" on deny).
	Rule string
	// Reason is a short, non-sensitive explanation.
	Reason string
}

// EmptyEnforce is the default policy of a newly created agent: deny all.
func EmptyEnforce() Policy {
	return Policy{Mode: ModeEnforce, Connectors: map[string][]string{}}.canonical()
}

// LegacyPermissive is the policy backfilled for pre-existing agents.
func LegacyPermissive() Policy {
	p := Policy{
		Mode:       ModeLegacyPermissive,
		Tools:      []string{"*"},
		Connectors: map[string][]string{"*": {"*"}},
		MCPServers: []string{"*"}, EgressHosts: []string{"*"},
		A2ATargets: []string{"*"}, A2AInbound: []string{"*"}, Secrets: []string{"*"},
	}
	return p.canonical()
}

// Evaluate decides one action. It is total: every input yields a decision.
func (p Policy) Evaluate(a Action) Decision {
	if p.Mode == ModeLegacyPermissive {
		return Decision{Allowed: true, Rule: "legacy_permissive", Reason: "legacy-permissive policy allows every action"}
	}
	if p.Mode != ModeEnforce {
		return Decision{Reason: fmt.Sprintf("unknown policy mode %q", p.Mode)}
	}
	switch a.Kind {
	case KindTool:
		return firstMatch(p.Tools, a.Target, MatchGlob, "tool not in policy.tools")
	case KindMCP:
		return firstMatch(p.MCPServers, a.Target, MatchGlob, "MCP server not in policy.mcpServers")
	case KindSecret:
		return firstMatch(p.Secrets, a.Target, MatchGlob, "secret ref not in policy.secrets")
	case KindEgress:
		return firstMatch(p.EgressHosts, a.Target, HostPatternCovers, "egress host not in policy.egressHosts")
	case KindConnector:
		for conn, actions := range p.Connectors {
			if !MatchGlob(conn, a.Target) {
				continue
			}
			for _, act := range actions {
				if MatchGlob(act, a.Sub) {
					return Decision{Allowed: true, Rule: "connectors." + conn + ":" + act}
				}
			}
		}
		return Decision{Reason: "connector action not in policy.connectors"}
	case KindA2A:
		for _, id := range append([]string{a.Target}, a.Aliases...) {
			if d := firstMatch(p.A2ATargets, id, MatchGlob, ""); d.Allowed {
				return d
			}
		}
		return Decision{Reason: "target agent not in policy.a2aTargets"}
	case KindA2AInbound:
		for _, rule := range p.A2AInbound {
			if rule == "tenant:self" && a.SameTenant {
				return Decision{Allowed: true, Rule: rule}
			}
			for _, id := range append([]string{a.Target}, a.Aliases...) {
				if id != "" && MatchGlob(rule, id) {
					return Decision{Allowed: true, Rule: rule}
				}
			}
		}
		return Decision{Reason: "caller not in policy.a2aInbound"}
	}
	return Decision{Reason: fmt.Sprintf("unknown action kind %q", a.Kind)}
}

func firstMatch(rules []string, target string, match func(pattern, s string) bool, denyReason string) Decision {
	for _, r := range rules {
		if match(r, target) {
			return Decision{Allowed: true, Rule: r}
		}
	}
	return Decision{Reason: denyReason}
}

// MatchGlob reports whether s matches pattern, where '*' matches any run of
// characters (possibly empty). Matching is case-sensitive; callers that need
// case-insensitivity normalize first (hosts do, in HostPatternCovers).
func MatchGlob(pattern, s string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == s
	}
	parts := strings.Split(pattern, "*")
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	last := parts[len(parts)-1]
	for _, mid := range parts[1 : len(parts)-1] {
		i := strings.Index(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return strings.HasSuffix(s, last)
}

// MatchHost is the egress host matcher, byte-compatible with the harness and
// broker matchers: exact (case-insensitive) or "*.suffix" for strict
// subdomains. A bare "*" is NOT accepted here (the guest matcher rejects it);
// policy-level "*" is handled by HostPatternCovers.
func MatchHost(pattern, host string) bool {
	pattern = strings.ToLower(pattern)
	host = strings.ToLower(host)
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.org"
		if len(suffix) < 2 {
			return false
		}
		return len(host) > len(suffix) && strings.HasSuffix(host, suffix)
	}
	return pattern == host
}

// HostPatternCovers reports whether policy host pattern p allows target t,
// where t is a concrete host OR itself an egress-rule pattern ("*.x.org").
// A rule pattern is allowed only if every host it could match is allowed.
func HostPatternCovers(p, t string) bool {
	p = normalizeHost(p)
	t = normalizeHost(t)
	if p == "" || t == "" {
		return false
	}
	if p == "*" {
		return true
	}
	if t == "*" {
		return false
	}
	if strings.HasPrefix(t, "*.") {
		if p == t {
			return true
		}
		// "*.a.x.org" is covered by "*.x.org".
		if strings.HasPrefix(p, "*.") {
			return strings.HasSuffix(t[1:], p[1:]) && len(t) > len(p)
		}
		return false
	}
	return MatchHost(p, t)
}

func normalizeHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if strings.HasPrefix(h, "[") { // [::1]:443
		if i := strings.Index(h, "]"); i > 0 {
			return h[1:i]
		}
	}
	if i := strings.LastIndex(h, ":"); i > 0 && strings.Count(h, ":") == 1 && isDigits(h[i+1:]) {
		h = h[:i]
	}
	return strings.TrimSuffix(h, ".")
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ---------- validation / canonical form ----------

// Limits keep a policy document bounded (it is evaluated on every dispatch
// and rendered in the dashboard).
const (
	MaxEntries      = 256
	MaxConnectors   = 64
	MaxEntryLength  = 256
	MaxBudgetValue  = 1_000_000
	secretRefPrefix = "pal.secret/"
)

// ValidationError names the offending field so the REST layer can return it.
type ValidationError struct {
	Field string
	Msg   string
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Msg }

var (
	nameRe   = regexp.MustCompile(`^[A-Za-z0-9_.:*/@-]{1,256}$`)
	hostRe   = regexp.MustCompile(`^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|[0-9a-f:.]+)$`)
	uuidRe   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	spiffeRe = regexp.MustCompile(`^spiffe://[a-z0-9.-]+(/[A-Za-z0-9._*-]+)+$`)
)

// Normalize validates p and returns its canonical form (sorted, de-duplicated,
// hosts lowercased, nil slices replaced by empty ones). The Version field is
// passed through untouched.
func Normalize(p Policy) (Policy, error) {
	switch p.Mode {
	case "":
		p.Mode = ModeEnforce
	case ModeEnforce, ModeLegacyPermissive:
	default:
		return Policy{}, &ValidationError{"mode", `must be "enforce" or "legacy_permissive"`}
	}
	check := func(field string, list []string, valid func(string) bool, what string) error {
		if len(list) > MaxEntries {
			return &ValidationError{field, fmt.Sprintf("at most %d entries", MaxEntries)}
		}
		for _, e := range list {
			if len(e) == 0 || len(e) > MaxEntryLength || !valid(e) {
				return &ValidationError{field, fmt.Sprintf("invalid %s %q", what, e)}
			}
		}
		return nil
	}
	for i, h := range p.EgressHosts {
		p.EgressHosts[i] = normalizeHost(h)
	}
	if err := check("tools", p.Tools, nameRe.MatchString, "tool name"); err != nil {
		return Policy{}, err
	}
	if err := check("mcpServers", p.MCPServers, nameRe.MatchString, "MCP server slug"); err != nil {
		return Policy{}, err
	}
	if err := check("egressHosts", p.EgressHosts, hostRe.MatchString, "host pattern"); err != nil {
		return Policy{}, err
	}
	if err := check("secrets", p.Secrets, func(s string) bool {
		return s == "*" || (strings.HasPrefix(s, secretRefPrefix) && nameRe.MatchString(s))
	}, "secret ref pattern (must be \"*\" or start with pal.secret/)"); err != nil {
		return Policy{}, err
	}
	if err := check("a2aTargets", p.A2ATargets, func(s string) bool {
		return spiffeRe.MatchString(s) || nameRe.MatchString(s)
	}, "A2A target"); err != nil {
		return Policy{}, err
	}
	if err := check("a2aInbound", p.A2AInbound, validInbound, "A2A inbound rule (\"*\", \"tenant:self\", \"tenant:<uuid>\" or a spiffe:// id)"); err != nil {
		return Policy{}, err
	}
	if len(p.Connectors) > MaxConnectors {
		return Policy{}, &ValidationError{"connectors", fmt.Sprintf("at most %d connectors", MaxConnectors)}
	}
	for conn, acts := range p.Connectors {
		if !nameRe.MatchString(conn) {
			return Policy{}, &ValidationError{"connectors", fmt.Sprintf("invalid connector id %q", conn)}
		}
		if len(acts) == 0 {
			return Policy{}, &ValidationError{"connectors." + conn, "list at least one action (use \"*\" for all)"}
		}
		if err := check("connectors."+conn, acts, nameRe.MatchString, "action"); err != nil {
			return Policy{}, err
		}
	}
	if p.Budget.MaxToolCallsPerRun < 0 || p.Budget.MaxToolCallsPerRun > MaxBudgetValue {
		return Policy{}, &ValidationError{"budget.maxToolCallsPerRun", fmt.Sprintf("must be between 0 and %d", MaxBudgetValue)}
	}
	if p.Budget.MaxA2AInboundPerMinute < 0 || p.Budget.MaxA2AInboundPerMinute > MaxBudgetValue {
		return Policy{}, &ValidationError{"budget.maxA2AInboundPerMinute", fmt.Sprintf("must be between 0 and %d", MaxBudgetValue)}
	}
	return p.canonical(), nil
}

func validInbound(s string) bool {
	switch {
	case s == "*", s == "tenant:self":
		return true
	case strings.HasPrefix(s, "tenant:"):
		return uuidRe.MatchString(strings.TrimPrefix(s, "tenant:"))
	default:
		return spiffeRe.MatchString(s)
	}
}

func (p Policy) canonical() Policy {
	p.Tools = sortedSet(p.Tools)
	p.MCPServers = sortedSet(p.MCPServers)
	p.EgressHosts = sortedSet(p.EgressHosts)
	p.A2ATargets = sortedSet(p.A2ATargets)
	p.A2AInbound = sortedSet(p.A2AInbound)
	p.Secrets = sortedSet(p.Secrets)
	conns := make(map[string][]string, len(p.Connectors))
	for k, v := range p.Connectors {
		conns[k] = sortedSet(v)
	}
	p.Connectors = conns
	return p
}

func sortedSet(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// Equal compares two policies' grants (mode, allowlists, budget), ignoring
// Version. Used to verify a read-back equals what the user confirmed.
func Equal(a, b Policy) bool {
	return a.Hash() == b.Hash()
}

// Hash is a stable digest of the policy's grants (Version excluded).
func (p Policy) Hash() string {
	c := p.canonical()
	c.Version = 0
	b, _ := json.Marshal(c) // map keys marshal sorted
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ErrInvalid is wrapped by ValidationError-free decode failures.
var ErrInvalid = errors.New("agentpolicy: invalid policy document")

// Decode parses and normalizes a JSON policy document, rejecting unknown
// fields so a typo ("egresHosts") can never silently grant nothing — or
// everything.
func Decode(raw []byte) (Policy, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var p Policy
	if err := dec.Decode(&p); err != nil {
		return Policy{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return Normalize(p)
}
