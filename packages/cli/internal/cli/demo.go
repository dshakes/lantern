package cli

// `lantern demo` — boots the kiosk/demo stack (ADR 0029): the normal compose
// stack plus infra/docker/docker-compose.kiosk.yml, which turns on LANTERN_KIOSK,
// RLS + authz enforcement, closed sign-up, and points LLM calls at the replay
// fixture server. Each visitor gets an ephemeral, auto-deleted workspace.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
)

const (
	demoAPIHealth = "http://localhost:8080/healthz"
	demoURL       = "http://localhost:3001/kiosk"
)

// demoComposeArgs builds the `docker compose` argv for the demo stack.
func demoComposeArgs(root string, action ...string) []string {
	args := []string{"compose",
		"-f", filepath.Join(root, "infra", "docker", "docker-compose.yml"),
		"-f", filepath.Join(root, "infra", "docker", "docker-compose.kiosk.yml"),
		"-p", "lantern-demo"}
	return append(args, action...)
}

func newDemoCommand() *cobra.Command {
	var noOpen, down bool
	cmd := &cobra.Command{
		Use:   "demo",
		Short: "Run the self-contained demo (kiosk mode): ephemeral workspaces, recorded answers, no API keys",
		Long: `Start the full stack in kiosk mode and open the demo page. Needs Docker only.

Every visitor gets a private workspace with sample agents that is deleted after
30 minutes. LLM answers are recorded replays served by a local fixture server;
no provider key is read, stored, or required.

  lantern demo           # start (first run builds images)
  lantern demo --down    # stop and delete all demo data`,
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := findRepoRoot()
			if err != nil {
				return fmt.Errorf("run `lantern demo` from inside a Lantern checkout: %w", err)
			}
			if _, err := exec.LookPath("docker"); err != nil {
				return fmt.Errorf("docker is required: %w", err)
			}
			action := []string{"up", "-d", "--build"}
			if down {
				action = []string{"down", "-v"}
			}
			c := exec.CommandContext(cmd.Context(), "docker", demoComposeArgs(root, action...)...)
			c.Stdout, c.Stderr, c.Dir = os.Stdout, os.Stderr, root
			start := time.Now()
			if err := c.Run(); err != nil {
				return fmt.Errorf("docker compose: %w", err)
			}
			if down {
				fmt.Println("demo stopped, data deleted")
				return nil
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
			defer cancel()
			for _, u := range []string{demoAPIHealth, demoURL} {
				if err := waitForHTTP(ctx, u, 5*time.Minute); err != nil {
					return fmt.Errorf("waiting for %s: %w (see `docker compose -p lantern-demo logs`)", u, err)
				}
			}
			fmt.Printf("demo ready in %s: %s\n", time.Since(start).Round(time.Second), demoURL)
			if !noOpen {
				_ = openBrowser(demoURL)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&noOpen, "no-open", false, "Don't open the browser")
	cmd.Flags().BoolVar(&down, "down", false, "Stop the demo and delete its data")
	return cmd
}
