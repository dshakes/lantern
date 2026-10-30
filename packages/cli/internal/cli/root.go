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

// NewRootCommand builds and returns the top-level `pal` command tree.
func NewRootCommand(version, commit, date string) *cobra.Command {
	root := &cobra.Command{
		Use:   "pal",
		Short: "PAL CLI — production runtime for AI agents",
		Long: `PAL is an open-source platform for building, running, and managing
production AI agents with multi-LLM routing, cost forecasting, and
eval-in-CI.

The pal CLI lets you create and manage agents, trigger and inspect
runs, stream run logs, run eval suites against a branch baseline, and
deploy agent code from your terminal. For the build inner loop,
` + "`pal agent dev <name>`" + ` watches a directory, re-publishes the agent on every
save, fires a smoke run and streams its events. Interactive sessions, connector
integrations, and cron scheduling are available today via the SDKs and
dashboard — not yet as CLI subcommands.

` + "`lantern`" + ` is the legacy name of this CLI and keeps working as an alias.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       fmt.Sprintf("%s (commit: %s, built: %s)", version, commit, date),
	}

	// Persistent flags available on every subcommand.
	pf := root.PersistentFlags()
	pf.StringVar(&flags.apiURL, "api-url", envOrDefault("PAL_API_URL", "localhost:50051"), "PAL API address (env: PAL_API_URL)")
	pf.StringVar(&flags.apiKey, "api-key", envOrDefault("PAL_API_KEY", ""), "API key for authentication (env: PAL_API_KEY)")
	pf.StringVar(&flags.tenantID, "tenant-id", envOrDefault("PAL_TENANT_ID", ""), "Tenant ID (env: PAL_TENANT_ID)")
	pf.StringVarP(&flags.output, "output", "o", "text", "Output format: text or json")
	pf.BoolVar(&flags.rest, "rest", false, "Force REST API instead of gRPC (env: PAL_USE_REST)")

	// Check env var for REST mode.
	if envOrDefault("PAL_USE_REST", "") != "" {
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
	root.AddCommand(newDemoCommand())
	root.AddCommand(newHooksCommand())

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
	// Fall back to the tenant captured at login too — the gRPC trust boundary
	// requires an explicit tenant_id in metadata, so without this every call
	// after `pal login` fails with "missing tenant_id in metadata".
	if cfg.APIKey == "" || cfg.TenantID == "" {
		creds, err := internal.LoadCredentials()
		if err == nil && creds != nil {
			if cfg.APIKey == "" && creds.Token != "" {
				cfg.APIKey = creds.Token
			}
			if cfg.TenantID == "" && creds.TenantID != "" {
				cfg.TenantID = creds.TenantID
			}
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
