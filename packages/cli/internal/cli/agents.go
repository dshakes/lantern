package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
)

func newAgentsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "agents",
		Aliases: []string{"agent"},
		Short:   "Manage agents",
	}

	cmd.AddCommand(newAgentsCreateCommand())
	cmd.AddCommand(newAgentsGetCommand())
	cmd.AddCommand(newAgentsListCommand())
	cmd.AddCommand(newAgentsDeleteCommand())

	return cmd
}

// --- agents create ---

func newAgentsCreateCommand() *cobra.Command {
	var (
		name        string
		description string
		labels      []string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new agent",
		RunE: func(cmd *cobra.Command, args []string) error {
			if name == "" {
				return fmt.Errorf("--name is required")
			}

			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			labelMap, err := parseLabels(labels)
			if err != nil {
				return err
			}

			agent, err := clients.Agents.CreateAgent(cmd.Context(), &lanternv1.CreateAgentRequest{
				Name:        name,
				Description: description,
				Labels:      labelMap,
			})
			if err != nil {
				return fmt.Errorf("create agent: %w", err)
			}

			if isJSON() {
				return printJSON(agentToMap(agent))
			}

			printSuccess(fmt.Sprintf("Agent %q created (id: %s)", agent.GetName(), agent.GetId()))
			return nil
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "Agent name (required)")
	cmd.Flags().StringVar(&description, "description", "", "Agent description")
	cmd.Flags().StringSliceVar(&labels, "label", nil, "Labels in key=value format (can be repeated)")

	return cmd
}

// --- agents get ---

func newAgentsGetCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "get <name>",
		Short: "Get an agent by name",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			agent, err := clients.Agents.GetAgent(cmd.Context(), &lanternv1.GetAgentRequest{
				Name: args[0],
			})
			if err != nil {
				return fmt.Errorf("get agent: %w", err)
			}

			if isJSON() {
				return printJSON(agentToMap(agent))
			}

			printTable(
				[]string{"ID", "NAME", "DESCRIPTION", "VERSION", "CREATED"},
				[][]string{{
					agent.GetId(),
					agent.GetName(),
					agent.GetDescription(),
					agent.GetCurrentVersionId(),
					formatTimestamp(agent.GetCreatedAt()),
				}},
			)
			return nil
		},
	}

	return cmd
}

// --- agents list ---

func newAgentsListCommand() *cobra.Command {
	var pageSize int32

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List agents",
		RunE: func(cmd *cobra.Command, args []string) error {
			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			resp, err := clients.Agents.ListAgents(cmd.Context(), &lanternv1.ListAgentsRequest{
				PageSize: pageSize,
			})
			if err != nil {
				return fmt.Errorf("list agents: %w", err)
			}

			if isJSON() {
				items := make([]map[string]any, 0, len(resp.GetAgents()))
				for _, a := range resp.GetAgents() {
					items = append(items, agentToMap(a))
				}
				return printJSON(map[string]any{
					"agents":      items,
					"total_count": resp.GetTotalCount(),
				})
			}

			if len(resp.GetAgents()) == 0 {
				printInfo("No agents found.")
				return nil
			}

			rows := make([][]string, 0, len(resp.GetAgents()))
			for _, a := range resp.GetAgents() {
				rows = append(rows, []string{
					a.GetId(),
					a.GetName(),
					a.GetDescription(),
					a.GetCurrentVersionId(),
					formatTimestamp(a.GetCreatedAt()),
				})
			}

			printTable([]string{"ID", "NAME", "DESCRIPTION", "VERSION", "CREATED"}, rows)

			if resp.GetNextPageToken() != "" {
				fmt.Fprintf(os.Stderr, "\n%s(more results available)%s\n", colorDim, colorReset)
			}

			return nil
		},
	}

	cmd.Flags().Int32Var(&pageSize, "page-size", 50, "Number of agents per page")

	return cmd
}

// --- agents delete ---

func newAgentsDeleteCommand() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete <name>",
		Short: "Delete an agent",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]

			if !force {
				fmt.Fprintf(os.Stderr, "Delete agent %q? This cannot be undone. [y/N]: ", name)
				reader := bufio.NewReader(os.Stdin)
				answer, err := reader.ReadString('\n')
				if err != nil {
					return fmt.Errorf("read confirmation: %w", err)
				}
				answer = strings.TrimSpace(strings.ToLower(answer))
				if answer != "y" && answer != "yes" {
					printInfo("Aborted.")
					return nil
				}
			}

			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			_, err = clients.Agents.DeleteAgent(cmd.Context(), &lanternv1.DeleteAgentRequest{
				Name: name,
			})
			if err != nil {
				return fmt.Errorf("delete agent: %w", err)
			}

			if isJSON() {
				return printJSON(map[string]any{
					"deleted": name,
				})
			}

			printSuccess(fmt.Sprintf("Agent %q deleted.", name))
			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

// --- helpers ---

// parseLabels converts ["key=value", ...] to a map.
func parseLabels(pairs []string) (map[string]string, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	m := make(map[string]string, len(pairs))
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if !ok {
			return nil, fmt.Errorf("invalid label %q: expected key=value", p)
		}
		m[k] = v
	}
	return m, nil
}

// agentToMap converts an Agent proto to a generic map for JSON output.
func agentToMap(a *lanternv1.Agent) map[string]any {
	m := map[string]any{
		"id":          a.GetId(),
		"tenant_id":   a.GetTenantId(),
		"name":        a.GetName(),
		"description": a.GetDescription(),
		"created_at":  formatTimestamp(a.GetCreatedAt()),
	}
	if a.GetCurrentVersionId() != "" {
		m["current_version_id"] = a.GetCurrentVersionId()
	}
	if a.GetCreatedBy() != "" {
		m["created_by"] = a.GetCreatedBy()
	}
	if len(a.GetLabels()) > 0 {
		m["labels"] = a.GetLabels()
	}
	return m
}
