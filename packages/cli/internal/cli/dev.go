package cli

// `lantern dev` boots the local-first development stack (Postgres + Redis +
// MinIO + control-plane) via docker-compose. It's a thin wrapper around
// `docker compose -f docker-compose.dev.yml up` that picks sensible defaults.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

func newDevCommand() *cobra.Command {
	var (
		detach  bool
		rebuild bool
		seed    bool
	)

	cmd := &cobra.Command{
		Use:   "dev",
		Short: "Start a local Lantern stack (docker-compose)",
		Long: `Boot a full local Lantern stack with Postgres, Redis, MinIO, and
the control plane. Requires docker-compose. The stack is scoped to the
current repo so you can iterate offline and without cloud dependencies.

By default runs in foreground with logs attached. Use --detach to background.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			composeFile, err := findComposeFile()
			if err != nil {
				return err
			}

			args1 := []string{"compose", "-f", composeFile, "up"}
			if detach {
				args1 = append(args1, "-d")
			}
			if rebuild {
				args1 = append(args1, "--build")
			}

			fmt.Printf("→ docker %s\n", joinArgs(args1))
			c := exec.Command("docker", args1...)
			c.Stdin = os.Stdin
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			if err := c.Run(); err != nil {
				return fmt.Errorf("docker compose: %w", err)
			}

			if seed {
				fmt.Println("→ seeding sample data...")
				seedCmd := exec.Command("make", "seed")
				seedCmd.Stdout = os.Stdout
				seedCmd.Stderr = os.Stderr
				if err := seedCmd.Run(); err != nil {
					return fmt.Errorf("seed: %w", err)
				}
			}
			return nil
		},
	}

	cmd.Flags().BoolVarP(&detach, "detach", "d", false, "Run containers in the background")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild images before starting")
	cmd.Flags().BoolVar(&seed, "seed", false, "Seed sample data after start")

	cmd.AddCommand(newDevDownCommand())
	cmd.AddCommand(newDevLogsCommand())
	return cmd
}

func newDevDownCommand() *cobra.Command {
	var volumes bool
	cmd := &cobra.Command{
		Use:   "down",
		Short: "Stop the local dev stack",
		RunE: func(cmd *cobra.Command, args []string) error {
			composeFile, err := findComposeFile()
			if err != nil {
				return err
			}
			args1 := []string{"compose", "-f", composeFile, "down"}
			if volumes {
				args1 = append(args1, "-v")
			}
			c := exec.Command("docker", args1...)
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			return c.Run()
		},
	}
	cmd.Flags().BoolVar(&volumes, "volumes", false, "Also remove named volumes (data loss)")
	return cmd
}

func newDevLogsCommand() *cobra.Command {
	var follow bool
	cmd := &cobra.Command{
		Use:   "logs [service]",
		Short: "Tail logs from the local dev stack",
		RunE: func(cmd *cobra.Command, args []string) error {
			composeFile, err := findComposeFile()
			if err != nil {
				return err
			}
			a := []string{"compose", "-f", composeFile, "logs"}
			if follow {
				a = append(a, "-f")
			}
			a = append(a, args...)
			c := exec.Command("docker", a...)
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			return c.Run()
		},
	}
	cmd.Flags().BoolVarP(&follow, "follow", "f", true, "Follow log output")
	return cmd
}

func findComposeFile() (string, error) {
	candidates := []string{
		"docker-compose.dev.yml",
		"docker-compose.yml",
		"compose.yml",
	}
	cwd, _ := os.Getwd()
	dir := cwd
	for i := 0; i < 6; i++ {
		for _, name := range candidates {
			p := filepath.Join(dir, name)
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("no docker-compose.{dev.,}yml found (searched from %s up)", cwd)
}

func joinArgs(a []string) string {
	out := ""
	for i, s := range a {
		if i > 0 {
			out += " "
		}
		out += s
	}
	return out
}
