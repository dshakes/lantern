package cli

// agent_policy.go — `pal agent policy|identity|audit` (ADR 0055): per-agent
// least-privilege policy, cryptographic identity, and the audit log.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

func agentAPIPath(name, suffix string) string {
	return "/v1/agents/" + url.PathEscape(name) + suffix
}

// agentCall issues a control-plane request and returns the status and body.
// Unlike apiRaw it does not turn 4xx into an opaque error, so callers can
// give 409 (policy version conflict) a precise message.
func agentCall(method, path string, body []byte) (int, []byte, error) {
	req, err := http.NewRequest(method, apiBase()+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	if auth := apiAuthHeader(); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

// agentCallOK is agentCall that maps any non-2xx to an error.
func agentCallOK(method, path string, body []byte) ([]byte, error) {
	status, b, err := agentCall(method, path, body)
	if err != nil {
		return nil, err
	}
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return nil, fmt.Errorf("api %s %s → %d: %s%s", method, path, status, strings.TrimSpace(string(b)), authHint())
	case status >= 400:
		return nil, fmt.Errorf("api %s %s → %d: %s", method, path, status, strings.TrimSpace(string(b)))
	}
	return b, nil
}

func newAgentPolicyCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "policy",
		Short: "Show, set, or propose an agent's least-privilege policy",
	}
	cmd.AddCommand(newAgentPolicyGetCommand(), newAgentPolicySetCommand(), newAgentPolicyProposeCommand())
	return cmd
}

type policyEnvelope struct {
	AgentName string         `json:"agentName"`
	AgentID   string         `json:"agentId"`
	Policy    map[string]any `json:"policy"`
	UpdatedAt string         `json:"updatedAt"`
	UpdatedBy string         `json:"updatedBy"`
	Warnings  []string       `json:"warnings"`
}

func fetchPolicy(name string) (*policyEnvelope, []byte, error) {
	b, err := agentCallOK("GET", agentAPIPath(name, "/policy"), nil)
	if err != nil {
		return nil, nil, err
	}
	var env policyEnvelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, nil, fmt.Errorf("parse policy response: %w", err)
	}
	return &env, b, nil
}

// putPolicy PUTs the policy and maps 409 to an actionable message.
func putPolicy(name string, policy map[string]any) (*policyEnvelope, error) {
	body, err := json.Marshal(policy)
	if err != nil {
		return nil, err
	}
	status, b, err := agentCall("PUT", agentAPIPath(name, "/policy"), body)
	if err != nil {
		return nil, err
	}
	switch {
	case status == http.StatusConflict:
		return nil, fmt.Errorf("policy version conflict (409): %q changed since version %v was read; "+
			"run `pal agent policy get %s` to see the current policy, then retry", name, policy["version"], name)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return nil, fmt.Errorf("api PUT policy → %d: %s%s", status, strings.TrimSpace(string(b)), authHint())
	case status >= 400:
		return nil, fmt.Errorf("policy rejected (%d): %s", status, strings.TrimSpace(string(b)))
	}
	var env policyEnvelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, fmt.Errorf("parse policy response: %w", err)
	}
	return &env, nil
}

func listStr(v any) string {
	arr, _ := v.([]any)
	if len(arr) == 0 {
		return "-"
	}
	s := make([]string, 0, len(arr))
	for _, e := range arr {
		s = append(s, fmt.Sprint(e))
	}
	return strings.Join(s, ", ")
}

func printPolicy(w io.Writer, p map[string]any) {
	fmt.Fprintf(w, "mode:         %v\n", p["mode"])
	fmt.Fprintf(w, "version:      %v\n", p["version"])
	fmt.Fprintf(w, "tools:        %s\n", listStr(p["tools"]))
	conns, _ := p["connectors"].(map[string]any)
	if len(conns) == 0 {
		fmt.Fprintf(w, "connectors:   -\n")
	} else {
		keys := make([]string, 0, len(conns))
		for k := range conns {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		fmt.Fprintf(w, "connectors:\n")
		for _, k := range keys {
			fmt.Fprintf(w, "  %s: %s\n", k, listStr(conns[k]))
		}
	}
	fmt.Fprintf(w, "mcpServers:   %s\n", listStr(p["mcpServers"]))
	fmt.Fprintf(w, "egressHosts:  %s\n", listStr(p["egressHosts"]))
	fmt.Fprintf(w, "a2aTargets:   %s\n", listStr(p["a2aTargets"]))
	fmt.Fprintf(w, "a2aInbound:   %s\n", listStr(p["a2aInbound"]))
	fmt.Fprintf(w, "secrets:      %s\n", listStr(p["secrets"]))
	if b, ok := p["budget"].(map[string]any); ok {
		fmt.Fprintf(w, "budget:       maxToolCallsPerRun=%v maxA2AInboundPerMinute=%v\n",
			b["maxToolCallsPerRun"], b["maxA2AInboundPerMinute"])
	}
}

func newAgentPolicyGetCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "get <name>",
		Short: "Show an agent's policy (use -o json for the raw document)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			env, raw, err := fetchPolicy(args[0])
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if isJSON() {
				var pretty bytes.Buffer
				if json.Indent(&pretty, raw, "", "  ") != nil {
					pretty.Write(raw)
				}
				fmt.Fprintln(out, pretty.String())
				return nil
			}
			fmt.Fprintf(out, "agent:        %s (%s)\n", env.AgentName, env.AgentID)
			printPolicy(out, env.Policy)
			if env.UpdatedAt != "" {
				fmt.Fprintf(out, "updated:      %s by %s\n", env.UpdatedAt, env.UpdatedBy)
			}
			for _, w := range env.Warnings {
				fmt.Fprintf(out, "warning:      %s\n", w)
			}
			return nil
		},
	}
}

func newAgentPolicySetCommand() *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "set <name> -f policy.json",
		Short: "Replace an agent's policy from a JSON file",
		Long: "Replace an agent's policy from a JSON file. If the file omits `version`, the current " +
			"version is read first. If it includes one and the policy changed since, the server " +
			"answers 409 and nothing is written.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if file == "" {
				return fmt.Errorf("-f/--file is required")
			}
			raw, err := os.ReadFile(file)
			if err != nil {
				return fmt.Errorf("read %s: %w", file, err)
			}
			var policy map[string]any
			if err := json.Unmarshal(raw, &policy); err != nil {
				return fmt.Errorf("parse %s: %w", file, err)
			}
			// Accept either a bare Policy or a GET envelope ({"policy": {...}}).
			if inner, ok := policy["policy"].(map[string]any); ok {
				policy = inner
			}
			if _, ok := policy["version"]; !ok {
				cur, _, err := fetchPolicy(args[0])
				if err != nil {
					return fmt.Errorf("read current version: %w", err)
				}
				policy["version"] = cur.Policy["version"]
			}
			env, err := putPolicy(args[0], policy)
			if err != nil {
				return err
			}
			if isJSON() {
				return printJSON(env)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "policy for %q saved (version %v)\n", args[0], env.Policy["version"])
			for _, w := range env.Warnings {
				fmt.Fprintf(cmd.OutOrStdout(), "warning: %s\n", w)
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "Policy JSON file (required)")
	return cmd
}

// normalizePolicy strips `version` and treats null / empty collections as
// equal so a server that canonicalizes [] vs null is not a false mismatch.
func normalizePolicy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			if k == "version" {
				continue
			}
			if n := normalizePolicy(val); n != nil {
				out[k] = n
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	case []any:
		if len(t) == 0 {
			return nil
		}
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = normalizePolicy(e)
		}
		return out
	}
	return v
}

func policiesEqualIgnoringVersion(a, b map[string]any) bool {
	return reflect.DeepEqual(normalizePolicy(a), normalizePolicy(b))
}

func newAgentPolicyProposeCommand() *cobra.Command {
	var apply bool
	cmd := &cobra.Command{
		Use:   "propose <name>",
		Short: "Propose a least-privilege policy from the agent's observed behaviour",
		Long: "Print a least-privilege proposal with per-field rationale. Nothing is saved unless " +
			"--apply is given; with --apply the proposal is PUT, re-read, and reported \"verified\" " +
			"only if the read-back equals the proposal (ignoring version). Otherwise exits non-zero.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			b, err := agentCallOK("POST", agentAPIPath(name, "/policy/propose"), nil)
			if err != nil {
				return err
			}
			var prop struct {
				Proposal   map[string]any `json:"proposal"`
				Rationale  []struct{ Field, Reason string }
				Sources    []string `json:"sources"`
				Unresolved []string `json:"unresolved"`
			}
			if err := json.Unmarshal(b, &prop); err != nil {
				return fmt.Errorf("parse proposal: %w", err)
			}
			out := cmd.OutOrStdout()
			if isJSON() && !apply {
				var pretty bytes.Buffer
				if json.Indent(&pretty, b, "", "  ") != nil {
					pretty.Write(b)
				}
				fmt.Fprintln(out, pretty.String())
			} else if !isJSON() {
				fmt.Fprintln(out, "Proposed policy:")
				printPolicy(out, prop.Proposal)
				if len(prop.Rationale) > 0 {
					fmt.Fprintln(out, "\nRationale:")
					for _, r := range prop.Rationale {
						fmt.Fprintf(out, "  %-14s %s\n", r.Field, r.Reason)
					}
				}
				if len(prop.Sources) > 0 {
					fmt.Fprintf(out, "\nSources:      %s\n", strings.Join(prop.Sources, ", "))
				}
				if len(prop.Unresolved) > 0 {
					fmt.Fprintf(out, "Unresolved:   %s\n", strings.Join(prop.Unresolved, ", "))
				}
			}
			if !apply {
				if !isJSON() {
					fmt.Fprintf(out, "\nNot applied. Re-run with --apply to save it.\n")
				}
				return nil
			}

			cur, _, err := fetchPolicy(name)
			if err != nil {
				return fmt.Errorf("read current version: %w", err)
			}
			toPut := map[string]any{}
			for k, v := range prop.Proposal {
				toPut[k] = v
			}
			toPut["version"] = cur.Policy["version"]
			if _, err := putPolicy(name, toPut); err != nil {
				return err
			}
			back, _, err := fetchPolicy(name)
			if err != nil {
				return fmt.Errorf("applied but read-back failed: %w", err)
			}
			if !policiesEqualIgnoringVersion(prop.Proposal, back.Policy) {
				return fmt.Errorf("NOT verified: the stored policy for %q differs from the proposal "+
					"(version now %v); inspect with `pal agent policy get %s`", name, back.Policy["version"], name)
			}
			if isJSON() {
				return printJSON(map[string]any{"verified": true, "policy": back.Policy})
			}
			fmt.Fprintf(out, "\nverified: policy for %q applied and read back identical (version %v)\n",
				name, back.Policy["version"])
			return nil
		},
	}
	cmd.Flags().BoolVar(&apply, "apply", false, "Save the proposal, then verify it by reading it back")
	return cmd
}

// --- identity ---

func newAgentIdentityCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "identity",
		Short: "Show, rotate, or revoke an agent's cryptographic identity",
	}
	var reason string
	show := &cobra.Command{
		Use:   "show <name>",
		Short: "Show an agent's identity",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			b, err := agentCallOK("GET", agentAPIPath(args[0], "/identity"), nil)
			return printIdentity(cmd, b, err)
		},
	}
	rotate := &cobra.Command{
		Use:   "rotate <name>",
		Short: "Rotate an agent's signing key (new key generation)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			b, err := agentCallOK("POST", agentAPIPath(args[0], "/identity/rotate"), []byte("{}"))
			return printIdentity(cmd, b, err)
		},
	}
	revoke := &cobra.Command{
		Use:   "revoke <name>",
		Short: "Revoke an agent's identity (its runs will fail admission)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body, _ := json.Marshal(map[string]string{"reason": reason})
			b, err := agentCallOK("POST", agentAPIPath(args[0], "/identity/revoke"), body)
			return printIdentity(cmd, b, err)
		},
	}
	revoke.Flags().StringVar(&reason, "reason", "", "Why the identity is being revoked (recorded in the audit log)")
	cmd.AddCommand(show, rotate, revoke)
	return cmd
}

func deref(v any) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprint(v)
}

func printIdentity(cmd *cobra.Command, b []byte, err error) error {
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	if isJSON() {
		var pretty bytes.Buffer
		if json.Indent(&pretty, b, "", "  ") != nil {
			pretty.Write(b)
		}
		fmt.Fprintln(out, pretty.String())
		return nil
	}
	var id map[string]any
	if err := json.Unmarshal(b, &id); err != nil {
		return fmt.Errorf("parse identity: %w", err)
	}
	fmt.Fprintf(out, "agent id:     %s\n", deref(id["agentId"]))
	fmt.Fprintf(out, "spiffe id:    %s\n", deref(id["spiffeId"]))
	fmt.Fprintf(out, "status:       %s\n", deref(id["status"]))
	fmt.Fprintf(out, "key gen:      %s\n", deref(id["keyGeneration"]))
	fmt.Fprintf(out, "jwks:         %s\n", deref(id["jwksUri"]))
	fmt.Fprintf(out, "token ttl:    %ss\n", deref(id["tokenTtlSeconds"]))
	fmt.Fprintf(out, "created:      %s\n", deref(id["createdAt"]))
	fmt.Fprintf(out, "rotated:      %s\n", deref(id["rotatedAt"]))
	if id["revokedAt"] != nil {
		fmt.Fprintf(out, "revoked:      %s (%s)\n", deref(id["revokedAt"]), deref(id["revokedReason"]))
	}
	return nil
}

// --- audit ---

func newAgentAuditCommand() *cobra.Command {
	var (
		limit int
		event string
	)
	cmd := &cobra.Command{
		Use:   "audit <name>",
		Short: "Show an agent's audit log and verify its hash chain",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			q := url.Values{}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			if event != "" {
				q.Set("event", event)
			}
			path := agentAPIPath(args[0], "/audit")
			if len(q) > 0 {
				path += "?" + q.Encode()
			}
			b, err := agentCallOK("GET", path, nil)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if isJSON() {
				var pretty bytes.Buffer
				if json.Indent(&pretty, b, "", "  ") != nil {
					pretty.Write(b)
				}
				fmt.Fprintln(out, pretty.String())
				return nil
			}
			var res struct {
				Events []struct {
					ID         int64  `json:"id"`
					Event      string `json:"event"`
					ActionKind string `json:"actionKind"`
					Target     string `json:"target"`
					Decision   string `json:"decision"`
					Reason     string `json:"reason"`
					RunID      string `json:"runId"`
					Principal  string `json:"principal"`
					CreatedAt  string `json:"createdAt"`
				} `json:"events"`
				ChainValid bool `json:"chainValid"`
			}
			if err := json.Unmarshal(b, &res); err != nil {
				return fmt.Errorf("parse audit: %w", err)
			}
			if len(res.Events) == 0 {
				fmt.Fprintln(out, "No audit events.")
			} else {
				w := tabwriterTo(out)
				fmt.Fprintln(w, "ID\tTIME\tEVENT\tKIND\tTARGET\tDECISION\tREASON\tPRINCIPAL")
				for _, e := range res.Events {
					fmt.Fprintf(w, "%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
						e.ID, e.CreatedAt, e.Event, e.ActionKind, e.Target, e.Decision, e.Reason, e.Principal)
				}
				w.Flush()
			}
			if res.ChainValid {
				fmt.Fprintln(out, "\nchain integrity: valid")
				return nil
			}
			return fmt.Errorf("chain integrity: BROKEN — the audit log for %q has been altered or is incomplete", args[0])
		},
	}
	cmd.Flags().IntVar(&limit, "limit", 50, "Maximum events to return")
	cmd.Flags().StringVar(&event, "event", "", "Filter by event name (e.g. policy_denied)")
	return cmd
}

func tabwriterTo(w io.Writer) *tabwriter.Writer { return tabwriter.NewWriter(w, 0, 0, 2, ' ', 0) }
