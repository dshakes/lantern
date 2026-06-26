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
	rest     bool
}

var flags globalFlags

// NewRootCommand builds and returns the top-level `lantern` command tree.
func NewRootCommand(version, commit, date string) *cobra.Command {
	root := &cobra.Command{
		Use:   "lantern",
		Short: "Lantern CLI — production runtime for AI agents",
		Long: `Lantern is an open-source platform for building, running, and managing
production AI agents with multi-LLM routing, managed sessions, real API
connectors, visual workflows, and cron scheduling.

The lantern CLI lets you create and manage agents, start interactive
sessions, trigger runs, stream logs, connect APIs, schedule jobs,
and deploy agent code from your terminal.`,
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
	pf.BoolVar(&flags.rest, "rest", false, "Force REST API instead of gRPC (env: LANTERN_USE_REST)")

	// Check env var for REST mode.
	if envOrDefault("LANTERN_USE_REST", "") != "" {
		flags.rest = true
	}

	// Register subcommand groups.
	root.AddCommand(newAgentsCommand())
	root.AddCommand(newRunCommand())
	root.AddCommand(newVmCommand())
	root.AddCommand(newRunsCommand())
	root.AddCommand(newLogsCommand())
	root.AddCommand(newInitCommand())
	root.AddCommand(newDeployCommand())
	root.AddCommand(newInfraCommand())
	root.AddCommand(newTestCommand())
	root.AddCommand(newDevCommand())

	// Auth commands.
	root.AddCommand(newLoginCommand())
	root.AddCommand(newWhoamiCommand())
	root.AddCommand(newLogoutCommand())

	// Readiness check + first-run wizard.
	root.AddCommand(newDoctorCommand())
	root.AddCommand(newOnboardCommand())

	return root
}

// clientConfig builds a ClientConfig from the resolved global flags.
func clientConfig() internal.ClientConfig {
	cfg := internal.ClientConfig{
		APIUrl:   flags.apiURL,
		APIKey:   flags.apiKey,
		TenantID: flags.tenantID,
	}

	// If a stored token exists and no API key was provided, use the token.
	if cfg.APIKey == "" {
		creds, err := internal.LoadCredentials()
		if err == nil && creds != nil && creds.Token != "" {
			cfg.APIKey = creds.Token
		}
	}

	return cfg
}

// restClient creates a REST client configured from global flags and stored
// credentials. Commands can use this as a fallback when gRPC is unavailable.
func restClient() *internal.RESTClient {
	restURL := deriveRESTURL(flags.apiURL)
	token := flags.apiKey

	// Try stored credentials if no API key was provided.
	if token == "" {
		creds, err := internal.LoadCredentials()
		if err == nil && creds != nil && creds.Token != "" {
			token = creds.Token
		}
	}

	return internal.NewRESTClient(restURL, "", token)
}

// shouldUseREST returns true when the CLI should use REST instead of gRPC.
// This is true when --rest is set, or when we auto-detect that gRPC is
// unavailable (by checking if the REST API responds).
func shouldUseREST() bool {
	if flags.rest {
		return true
	}
	return false
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
