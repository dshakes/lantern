package cli

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// Exit codes for `lantern deploy` (0 ok, 1 generic).
const (
	exitAuth    = 3 // 401 / 403
	exitBudget  = 4 // 402 quota or budget exceeded
	exitMissing = 5 // 404
	exitServer  = 6 // 5xx
)

// ExitError carries a process exit code; main honors it.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string { return e.Err.Error() }
func (e *ExitError) Unwrap() error { return e.Err }

// agentManifest is the subset of agent.yaml that deploy sends to the control
// plane. Same file `lantern init` scaffolds; unknown keys (tools, limits, ...)
// are ignored. system_prompt and workflow are optional additions.
type agentManifest struct {
	Name         string            `yaml:"name"`
	Description  string            `yaml:"description"`
	Model        string            `yaml:"model"`
	SystemPrompt string            `yaml:"system_prompt"`
	Labels       map[string]string `yaml:"labels"`
	Workflow     map[string]any    `yaml:"workflow"`
}

func newDeployCommand() *cobra.Command {
	var watch, dryRun, jsonOut bool

	cmd := &cobra.Command{
		Use:   "deploy",
		Short: "Deploy the agent in the current directory",
		Long: `Reads agent.yaml from the current directory, creates the agent on the
control plane (or updates its system prompt, model and workflow if it already
exists) and deploys it via POST /v1/agents/{name}/deploy.

Exit codes: 0 ok, 3 unauthorized, 4 quota/budget (402), 5 not found,
6 server error, 1 anything else.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			raw, err := os.ReadFile("agent.yaml")
			if os.IsNotExist(err) {
				return fmt.Errorf("agent.yaml not found in current directory — run 'lantern init <name>' first")
			}
			if err != nil {
				return fmt.Errorf("read agent.yaml: %w", err)
			}
			var m agentManifest
			if err := yaml.Unmarshal(raw, &m); err != nil {
				return fmt.Errorf("parse agent.yaml: %w", err)
			}
			if strings.TrimSpace(m.Name) == "" {
				return fmt.Errorf("agent.yaml: name is required")
			}
			if watch {
				printInfo("--watch is not implemented; deploying once")
			}

			res, err := runDeploy(restClient(), &m, dryRun)
			if err != nil {
				return mapDeployError(err)
			}
			if jsonOut || isJSON() {
				return printJSON(res)
			}
			if dryRun {
				printInfo(fmt.Sprintf("dry run: would %s agent %q and deploy it", res["agent"], m.Name))
				return nil
			}
			printSuccess(fmt.Sprintf("Deployed %q (%s) status=%v id=%v", m.Name, res["agent"], res["status"], res["id"]))
			if u, ok := res["url"].(string); ok && u != "" {
				printInfo("URL: " + u)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&watch, "watch", false, "Watch for changes and re-deploy (not implemented)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would change without calling mutating endpoints")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "Print the result as JSON (same as -o json)")
	return cmd
}

// runDeploy upserts the agent then deploys it. It returns the deploy response
// plus "agent": "created"|"updated" (on dry-run: "create"|"update", no deploy).
func runDeploy(c *internal.RESTClient, m *agentManifest, dryRun bool) (map[string]any, error) {
	base := "/v1/agents/" + url.PathEscape(m.Name)

	action := "update"
	var apiErr *internal.APIError
	if _, err := c.GetAgent(m.Name); errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		action = "create"
	} else if err != nil {
		return nil, err
	}

	if dryRun {
		return map[string]any{"dryRun": true, "agent": action, "name": m.Name, "workflow": m.Workflow != nil}, nil
	}

	if action == "create" {
		body := map[string]any{"name": m.Name, "description": m.Description}
		if len(m.Labels) > 0 {
			body["labels"] = m.Labels
		}
		if m.SystemPrompt != "" {
			body["systemPrompt"] = m.SystemPrompt
		}
		if m.Model != "" {
			body["model"] = m.Model
		}
		if err := c.Call("POST", "/v1/agents", body, nil); err != nil {
			return nil, fmt.Errorf("create agent: %w", err)
		}
	} else {
		// ponytail: PATCH cannot change description/labels; only prompt+model are updated.
		patch := map[string]any{}
		if m.SystemPrompt != "" {
			patch["systemPrompt"] = m.SystemPrompt
		}
		if m.Model != "" {
			patch["model"] = m.Model
		}
		if len(patch) > 0 {
			if err := c.Call("PATCH", base, patch, nil); err != nil {
				return nil, fmt.Errorf("update agent: %w", err)
			}
		}
	}

	if m.Workflow != nil {
		if err := c.Call("PUT", base+"/workflow", m.Workflow, nil); err != nil {
			return nil, fmt.Errorf("save workflow: %w", err)
		}
	}

	out := map[string]any{}
	if err := c.Call("POST", base+"/deploy", nil, &out); err != nil {
		return nil, fmt.Errorf("deploy agent: %w", err)
	}
	out["agent"] = action + "d"
	return out, nil
}

// mapDeployError turns an API status into a readable message and exit code.
func mapDeployError(err error) error {
	var ae *internal.APIError
	if !errors.As(err, &ae) {
		return err
	}
	code, hint := 1, ""
	switch {
	case ae.Status == 401 || ae.Status == 403:
		code, hint = exitAuth, "not authorized — run 'lantern login' or check --api-key"
	case ae.Status == 402:
		code, hint = exitBudget, "quota or budget exceeded"
	case ae.Status == 404:
		code, hint = exitMissing, "not found"
	case ae.Status >= 500:
		code, hint = exitServer, "control plane error"
	}
	if hint != "" {
		err = fmt.Errorf("%s (HTTP %d): %w", hint, ae.Status, err)
	}
	return &ExitError{Code: code, Err: err}
}

func spinner() string {
	return "..."
}

func checkmark() string {
	return "ok "
}
