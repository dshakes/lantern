package cli

// `lantern dev` brings up the entire Lantern stack with a single command.
//
//   - Infra (Postgres, Redis, MinIO) runs in docker-compose so the user
//     doesn't need a local Postgres install.
//   - Control-plane API runs as a host `go run` process so Go changes
//     reload on Ctrl-C / re-run (no Docker rebuild loop).
//   - Dashboard runs as `npm run dev` for Next.js HMR.
//   - WhatsApp bridge runs as `npm run dev` (tsx) for hot reload.
//
// All four streams are tagged and interleaved into the terminal. SIGINT
// tears them down cleanly + brings docker compose down.

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

// Per-process palette. Colors are ANSI ones every modern terminal renders
// and are picked to be distinguishable on both light and dark backgrounds.
type procTag struct {
	name  string
	color string
}

var (
	tagInfra    = procTag{"infra", "\033[36m"} // cyan
	tagAPI      = procTag{"api  ", "\033[35m"} // magenta
	tagWeb      = procTag{"web  ", "\033[32m"} // green
	tagWA       = procTag{"wa   ", "\033[33m"} // yellow
	tagIM       = procTag{"im   ", "\033[34m"} // blue (iMessage)
	resetColor  = "\033[0m"
	noColorMode = false
)

func init() {
	// Honor NO_COLOR convention for terminals/CI that mangle ANSI.
	if os.Getenv("NO_COLOR") != "" {
		noColorMode = true
	}
}

func tag(t procTag, line string) string {
	if noColorMode {
		return fmt.Sprintf("[%s] %s", strings.TrimSpace(t.name), line)
	}
	return fmt.Sprintf("%s[%s]%s %s", t.color, strings.TrimSpace(t.name), resetColor, line)
}

func newDevCommand() *cobra.Command {
	var (
		infraOnly   bool
		withWA      bool
		withIM      bool
		noOpen      bool
		dashPort    int
		apiPort     int
	)

	cmd := &cobra.Command{
		Use:   "dev",
		Short: "Run the entire Lantern stack locally with hot reload",
		Long: `Boot Postgres+Redis+MinIO via Docker, run the control-plane API
(host Go process), the dashboard (Next.js HMR), and the WhatsApp bridge
(tsx hot reload). All logs interleave into this terminal with per-process
tags. Ctrl-C tears everything down cleanly.

Defaults:
  - dashboard:  http://localhost:3001
  - api:        http://localhost:8080
  - whatsapp:   http://localhost:3100
  - postgres:   localhost:5432 (lantern/lantern/lantern)
  - redis:      localhost:6379
  - minio:      localhost:9000 (lantern/lanternsecret)`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDev(devOpts{
				infraOnly: infraOnly,
				withWA:    withWA,
				withIM:    withIM,
				openURL:   !noOpen,
				dashPort:  dashPort,
				apiPort:   apiPort,
			})
		},
	}

	cmd.Flags().BoolVar(&infraOnly, "infra-only", false, "Only start infra containers (Postgres/Redis/MinIO)")
	cmd.Flags().BoolVar(&withWA, "with-whatsapp", true, "Start the WhatsApp bridge alongside")
	cmd.Flags().BoolVar(&withIM, "with-imessage", true, "Start the iMessage bridge alongside (macOS only — auto-skipped elsewhere)")
	cmd.Flags().BoolVar(&noOpen, "no-open", false, "Don't auto-open the browser")
	cmd.Flags().IntVar(&dashPort, "dashboard-port", 3001, "Port for the dashboard dev server")
	cmd.Flags().IntVar(&apiPort, "api-port", 8080, "Port the control-plane HTTP API binds")

	cmd.AddCommand(newDevDownCommand())
	cmd.AddCommand(newDevLogsCommand())
	return cmd
}

type devOpts struct {
	infraOnly bool
	withWA    bool
	withIM    bool
	openURL   bool
	dashPort  int
	apiPort   int
}

func runDev(opts devOpts) error {
	repoRoot, err := findRepoRoot()
	if err != nil {
		return err
	}
	composeFile := filepath.Join(repoRoot, "infra", "docker", "docker-compose.yml")
	if _, err := os.Stat(composeFile); err != nil {
		return fmt.Errorf("docker-compose.yml not found at %s", composeFile)
	}

	// SIGINT/SIGTERM cancels everything. We pass this context to each
	// subprocess so they receive a graceful shutdown signal.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintln(os.Stderr, tag(tagInfra, "shutdown requested — stopping services…"))
		cancel()
	}()

	var wg sync.WaitGroup

	// ---- 1) Start infra (postgres, redis, minio) as detached containers.
	fmt.Fprintln(os.Stderr, tag(tagInfra, "starting Postgres / Redis / MinIO via docker compose…"))
	if err := startInfra(ctx, composeFile); err != nil {
		return fmt.Errorf("infra: %w", err)
	}
	defer func() {
		fmt.Fprintln(os.Stderr, tag(tagInfra, "stopping infra containers…"))
		stopInfra(composeFile)
	}()

	// Wait until Postgres is healthy. dev needs a real DB before the API
	// starts or the API will exit on migration failure.
	fmt.Fprintln(os.Stderr, tag(tagInfra, "waiting for Postgres to be ready…"))
	if err := waitForTCP(ctx, "localhost:5432", 90*time.Second); err != nil {
		return fmt.Errorf("postgres not ready: %w", err)
	}
	fmt.Fprintln(os.Stderr, tag(tagInfra, "✓ Postgres ready"))

	if opts.infraOnly {
		fmt.Fprintln(os.Stderr, tag(tagInfra, "infra running — Ctrl-C to stop. (--infra-only)"))
		<-ctx.Done()
		return nil
	}

	// ---- 2) Control-plane (host go run).
	apiCmd := makeProc(ctx, repoRoot, tagAPI, "go", "run", "./cmd/server")
	apiCmd.Dir = filepath.Join(repoRoot, "services", "control-plane")
	apiCmd.Env = append(os.Environ(),
		"DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable",
		"REDIS_URL=redis://localhost:6379",
		"S3_ENDPOINT=http://localhost:9000",
		"LOG_LEVEL=info",
	)
	if err := startProc(&wg, apiCmd, tagAPI); err != nil {
		return err
	}

	// ---- 3) Dashboard.
	webCmd := makeProc(ctx, repoRoot, tagWeb, "npm", "run", "dev")
	webCmd.Dir = filepath.Join(repoRoot, "apps", "web")
	webCmd.Env = append(os.Environ(),
		fmt.Sprintf("PORT=%d", opts.dashPort),
		fmt.Sprintf("NEXT_PUBLIC_API_URL=http://localhost:%d", opts.apiPort),
	)
	if err := startProc(&wg, webCmd, tagWeb); err != nil {
		return err
	}

	// ---- 4) WhatsApp bridge (optional).
	if opts.withWA {
		waCmd := makeProc(ctx, repoRoot, tagWA, "npm", "run", "dev")
		waCmd.Dir = filepath.Join(repoRoot, "services", "whatsapp-bridge")
		waCmd.Env = append(os.Environ(),
			fmt.Sprintf("LANTERN_API_URL=http://localhost:%d", opts.apiPort),
		)
		if err := startProc(&wg, waCmd, tagWA); err != nil {
			fmt.Fprintln(os.Stderr, tag(tagWA, fmt.Sprintf("could not start WhatsApp bridge: %v", err)))
			// Non-fatal — dev can continue without it.
		}
	}

	// ---- 5) iMessage bridge (macOS only).
	if opts.withIM && runtime.GOOS == "darwin" {
		imCmd := makeProc(ctx, repoRoot, tagIM, "npm", "run", "dev")
		imCmd.Dir = filepath.Join(repoRoot, "services", "imessage-bridge")
		imCmd.Env = append(os.Environ(),
			fmt.Sprintf("LANTERN_API_URL=http://localhost:%d", opts.apiPort),
		)
		if err := startProc(&wg, imCmd, tagIM); err != nil {
			fmt.Fprintln(os.Stderr, tag(tagIM, fmt.Sprintf("could not start iMessage bridge: %v", err)))
			// Non-fatal — dev can continue without it.
		}
	} else if opts.withIM && runtime.GOOS != "darwin" {
		fmt.Fprintln(os.Stderr, tag(tagIM, "iMessage bridge requires macOS — skipping"))
	}

	// ---- 5) Wait for the API + dashboard to be healthy, then open the browser.
	apiURL := fmt.Sprintf("http://localhost:%d", opts.apiPort)
	dashURL := fmt.Sprintf("http://localhost:%d", opts.dashPort)
	go func() {
		if err := waitForHTTP(ctx, apiURL+"/healthz", 120*time.Second); err != nil {
			fmt.Fprintln(os.Stderr, tag(tagAPI, "did not become healthy within 2min — check logs above"))
			return
		}
		fmt.Fprintln(os.Stderr, tag(tagAPI, "✓ control-plane ready at "+apiURL))
		if err := waitForHTTP(ctx, dashURL, 120*time.Second); err != nil {
			fmt.Fprintln(os.Stderr, tag(tagWeb, "did not become healthy within 2min — check logs above"))
			return
		}
		fmt.Fprintln(os.Stderr, tag(tagWeb, "✓ dashboard ready at "+dashURL))
		fmt.Fprintln(os.Stderr, tag(tagInfra, "──────────────────────────────────────────"))
		fmt.Fprintln(os.Stderr, tag(tagInfra, "  Dashboard: "+dashURL))
		fmt.Fprintln(os.Stderr, tag(tagInfra, "  API:       "+apiURL))
		if opts.withWA {
			fmt.Fprintln(os.Stderr, tag(tagInfra, "  WhatsApp:  http://localhost:3100"))
		}
		if opts.withIM && runtime.GOOS == "darwin" {
			fmt.Fprintln(os.Stderr, tag(tagInfra, "  iMessage:  http://localhost:3200"))
		}
		fmt.Fprintln(os.Stderr, tag(tagInfra, "  Login:     admin@lantern.dev / lantern"))
		fmt.Fprintln(os.Stderr, tag(tagInfra, "──────────────────────────────────────────"))
		if opts.openURL {
			_ = openBrowser(dashURL)
		}
	}()

	wg.Wait()
	return nil
}

// makeProc constructs an exec.Cmd whose lifetime is bound to ctx — when ctx
// is cancelled, the process gets SIGTERM, then SIGKILL after a grace period.
// We don't use exec.CommandContext directly because its default kill is too
// abrupt for Node/Go which need to drain ports cleanly.
func makeProc(ctx context.Context, _ string, _ procTag, name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	go func() {
		<-ctx.Done()
		if c.Process == nil {
			return
		}
		// Send SIGTERM and give it 5s to drain before SIGKILL.
		_ = c.Process.Signal(syscall.SIGTERM)
		t := time.AfterFunc(5*time.Second, func() {
			_ = c.Process.Kill()
		})
		_, _ = c.Process.Wait()
		t.Stop()
	}()
	return c
}

func startProc(wg *sync.WaitGroup, c *exec.Cmd, t procTag) error {
	stdout, err := c.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := c.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}
	if err := c.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	wg.Add(1)
	go pipeLines(stdout, t)
	go pipeLines(stderr, t)
	go func() {
		defer wg.Done()
		_ = c.Wait()
	}()
	return nil
}

func pipeLines(r io.Reader, t procTag) {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for s.Scan() {
		fmt.Println(tag(t, s.Text()))
	}
}

// ---------- infra lifecycle ----------

func startInfra(ctx context.Context, composeFile string) error {
	// Bring up the three infra services in detached mode — we'll pipe
	// their logs in via `docker compose logs -f` only on demand
	// (`lantern dev logs`). Detached so they don't block the foreground.
	args := []string{
		"compose", "-f", composeFile,
		"up", "-d",
		"postgres", "redis", "minio", "minio-init",
	}
	c := exec.CommandContext(ctx, "docker", args...)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker %v: %s", args, string(out))
	}
	return nil
}

func stopInfra(composeFile string) {
	// Use a fresh context so this still runs after the parent context
	// has been cancelled — otherwise Ctrl-C would orphan the containers.
	c := exec.Command("docker", "compose", "-f", composeFile, "stop",
		"postgres", "redis", "minio", "minio-init")
	c.Stdout = io.Discard
	c.Stderr = io.Discard
	_ = c.Run()
}

// ---------- readiness probes ----------

func waitForTCP(ctx context.Context, addr string, timeout time.Duration) error {
	// Plain net.Dial — no shell-out, no `nc` dependency. We attempt a
	// connect, and if it succeeds (peer accepted TCP), the port is ready.
	deadline := time.Now().Add(timeout)
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for %s", addr)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func waitForHTTP(ctx context.Context, url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 3 * time.Second}
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 500 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(800 * time.Millisecond):
		}
	}
}

// ---------- helpers ----------

func openBrowser(url string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", url)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		c = exec.Command("xdg-open", url)
	}
	return c.Start()
}

// findRepoRoot walks up from cwd until it finds the Lantern repo root
// (identified by go.work or the docker-compose file). Returns an error
// if neither exists within 8 parent levels.
func findRepoRoot() (string, error) {
	cwd, _ := os.Getwd()
	dir := cwd
	for i := 0; i < 8; i++ {
		for _, marker := range []string{"go.work", "Makefile", "README.md"} {
			p := filepath.Join(dir, marker)
			if _, err := os.Stat(p); err == nil {
				// Sanity check: a real Lantern repo has services/control-plane.
				if _, err := os.Stat(filepath.Join(dir, "services", "control-plane")); err == nil {
					return dir, nil
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("no Lantern repo root found (searched up from %s)", cwd)
}

// ---------- dev down / logs (preserved from earlier impl) ----------

func newDevDownCommand() *cobra.Command {
	var volumes bool
	cmd := &cobra.Command{
		Use:   "down",
		Short: "Stop infra containers (Postgres / Redis / MinIO)",
		RunE: func(cmd *cobra.Command, args []string) error {
			repoRoot, err := findRepoRoot()
			if err != nil {
				return err
			}
			composeFile := filepath.Join(repoRoot, "infra", "docker", "docker-compose.yml")
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
	cmd.Flags().BoolVar(&volumes, "volumes", false, "Also remove named volumes (DATA LOSS)")
	return cmd
}

func newDevLogsCommand() *cobra.Command {
	var follow bool
	cmd := &cobra.Command{
		Use:   "logs [service]",
		Short: "Tail logs from the infra containers",
		RunE: func(cmd *cobra.Command, args []string) error {
			repoRoot, err := findRepoRoot()
			if err != nil {
				return err
			}
			composeFile := filepath.Join(repoRoot, "infra", "docker", "docker-compose.yml")
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
