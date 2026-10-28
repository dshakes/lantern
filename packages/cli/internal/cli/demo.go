package cli

// `lantern demo` — boots the kiosk/demo stack (ADR 0029): the normal compose
// stack plus infra/docker/docker-compose.kiosk.yml, which turns on LANTERN_KIOSK,
// RLS + authz enforcement, closed sign-up, and points LLM calls at the replay
// fixture server. Each visitor gets an ephemeral, auto-deleted workspace.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
)

// demoPort reads the host-port override the compose overlay also honours.
func demoPort(env, def string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	return def
}

func demoURLs() (apiHealth, page string) {
	return "http://localhost:" + demoPort("KIOSK_API_PORT", "8080") + "/healthz",
		"http://localhost:" + demoPort("KIOSK_WEB_PORT", "3001") + "/kiosk"
}

// kioskServices is everything the demo needs; the rest of the dev stack (Rust
// gateway/model-router builds, workflow-engine, landing) is skipped.
var kioskServices = []string{"postgres", "redis", "control-plane", "dashboard", "llm-replay"}

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
			action := append([]string{"up", "-d", "--build"}, kioskServices...)
			if down {
				action = []string{"down", "-v"}
			}
			c := exec.CommandContext(cmd.Context(), "docker", demoComposeArgs(root, action...)...)
			c.Stdout, c.Stderr, c.Dir = os.Stdout, os.Stderr, root
			c.Env = os.Environ()
			if os.Getenv("KIOSK_JWT_SECRET") == "" {
				// Sessions are ephemeral, so a fresh random secret per start loses nothing.
				b := make([]byte, 32)
				if _, err := rand.Read(b); err != nil {
					return fmt.Errorf("generate kiosk secret: %w", err)
				}
				c.Env = append(c.Env, "KIOSK_JWT_SECRET="+hex.EncodeToString(b))
			}
			start := time.Now()
			if err := c.Run(); err != nil {
				return fmt.Errorf("docker compose: %w", err)
			}
			if down {
				fmt.Println("demo stopped, data deleted")
				return nil
			}
			apiHealth, demoURL := demoURLs()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
			defer cancel()
			for _, u := range []string{apiHealth, demoURL} {
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
