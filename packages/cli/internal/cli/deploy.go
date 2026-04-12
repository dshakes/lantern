package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
)

func newDeployCommand() *cobra.Command {
	var watch bool

	cmd := &cobra.Command{
		Use:   "deploy",
		Short: "Deploy the agent in the current directory",
		Long: `Reads agent.yaml from the current directory, builds the agent bundle,
uploads it, and deploys it to the Lantern platform.

Note: this is a spike — the actual build/upload/deploy pipeline is wired later.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Verify agent.yaml exists in the current directory.
			if _, err := os.Stat("agent.yaml"); os.IsNotExist(err) {
				return fmt.Errorf("agent.yaml not found in current directory — run 'lantern init <name>' first")
			}

			agentYAML, err := os.ReadFile("agent.yaml")
			if err != nil {
				return fmt.Errorf("read agent.yaml: %w", err)
			}

			if isJSON() {
				return printJSON(map[string]any{
					"status":  "deployed",
					"message": "spike — deploy pipeline not yet wired",
					"config":  string(agentYAML),
				})
			}

			// Simulate the deploy pipeline with a spinner-like output.
			steps := []struct {
				msg      string
				duration time.Duration
			}{
				{"Reading agent.yaml...", 200 * time.Millisecond},
				{"Building bundle...", 500 * time.Millisecond},
				{"Uploading bundle (1.2 KB)...", 400 * time.Millisecond},
				{"Creating agent version...", 300 * time.Millisecond},
				{"Promoting to live...", 200 * time.Millisecond},
			}

			_ = agentYAML // Used in production to extract agent name and config.

			for _, s := range steps {
				fmt.Fprintf(os.Stderr, "%s%s %s%s", colorDim, spinner(), s.msg, colorReset)
				time.Sleep(s.duration)
				fmt.Fprintf(os.Stderr, "\r%s%s %s%s\n", colorGreen, checkmark(), s.msg, colorReset)
			}

			fmt.Fprintln(os.Stderr)
			printSuccess("Deployed successfully!")
			printWarning("This is a spike — the deploy pipeline is not yet wired to the backend.")

			if watch {
				printInfo("--watch mode: would watch for file changes and re-deploy (not yet implemented)")
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&watch, "watch", false, "Watch for changes and re-deploy")

	return cmd
}

func spinner() string {
	return "..."
}

func checkmark() string {
	return "ok "
}
