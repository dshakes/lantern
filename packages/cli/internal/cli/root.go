package cli

import (
	"fmt"
	"os"

	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
)

// globalFlags stores persistent flag values shared across all commands.
type globalFlags struct {
	apiURL   string
	apiKey   string
	tenantID string
	output   string
}

var flags globalFlags

// NewRootCommand builds and returns the top-level `lantern` command tree.
func NewRootCommand(version, commit, date string) *cobra.Command {
	root := &cobra.Command{
		Use:   "lantern",
		Short: "Lantern CLI — manage agents, runs, and deployments",
		Long: `Lantern is a serverless platform for production AI agents.

The lantern CLI lets you create and manage agents, trigger runs,
stream logs, and deploy agent code from your terminal.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       fmt.Sprintf("%s (commit: %s, built: %s)", version, commit, date),
	}

	// Persistent flags available on every subcommand.
	pf := root.PersistentFlags()
	pf.StringVar(&flags.apiURL, "api-url", envOrDefault("LANTERN_API_URL", "localhost:50051"), "Lantern API address (env: LANTERN_API_URL)")
	pf.StringVar(&flags.apiKey, "api-key", envOrDefault("LANTERN_API_KEY", ""), "API key for authentication (env: LANTERN_API_KEY)")
	pf.StringVar(&flags.tenantID, "tenant-id", envOrDefault("LANTERN_TENANT_ID", ""), "Tenant ID (env: LANTERN_TENANT_ID)")
	pf.StringVarP(&flags.output, "output", "o", "text", "Output format: text or json")

	// Register subcommand groups.
	root.AddCommand(newAgentsCommand())
	root.AddCommand(newRunsCommand())
	root.AddCommand(newLogsCommand())
	root.AddCommand(newInitCommand())
	root.AddCommand(newDeployCommand())

	return root
}

// clientConfig builds a ClientConfig from the resolved global flags.
func clientConfig() internal.ClientConfig {
	return internal.ClientConfig{
		APIUrl:   flags.apiURL,
		APIKey:   flags.apiKey,
		TenantID: flags.tenantID,
	}
}

// isJSON returns true when the user requested JSON output.
func isJSON() bool {
	return flags.output == "json"
}

// envOrDefault reads an environment variable, returning fallback if unset.
func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
