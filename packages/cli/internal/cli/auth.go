package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"syscall"

	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func newLoginCommand() *cobra.Command {
	var (
		email    string
		password string
	)

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with the Lantern platform",
		Long: `Log in to Lantern using your email and password.

If --email and --password are provided, login is non-interactive.
Otherwise, you will be prompted for credentials.

The session token is stored in ~/.lantern/credentials.json.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Interactive mode: prompt for email and password.
			if email == "" {
				fmt.Fprint(os.Stderr, "Email: ")
				reader := bufio.NewReader(os.Stdin)
				line, err := reader.ReadString('\n')
				if err != nil {
					return fmt.Errorf("read email: %w", err)
				}
				email = strings.TrimSpace(line)
			}

			if password == "" {
				fmt.Fprint(os.Stderr, "Password: ")
				pw, err := term.ReadPassword(int(syscall.Stdin))
				if err != nil {
					return fmt.Errorf("read password: %w", err)
				}
				fmt.Fprintln(os.Stderr) // newline after hidden input
				password = string(pw)
			}

			if email == "" || password == "" {
				return fmt.Errorf("email and password are required")
			}

			// Determine REST URL from flags.
			restURL := deriveRESTURL(flags.apiURL)
			client := internal.NewRESTClient(restURL, flags.apiKey, "")

			resp, err := client.Login(email, password)
			if err != nil {
				return fmt.Errorf("login failed: %w", err)
			}

			// Save credentials to disk.
			creds := &internal.Credentials{
				Token:    resp.Token,
				Email:    resp.User.Email,
				Name:     resp.User.Name,
				TenantID: resp.User.TenantID,
				UserID:   resp.User.ID,
			}
			if err := internal.SaveCredentials(creds); err != nil {
				return fmt.Errorf("save credentials: %w", err)
			}

			if isJSON() {
				return printJSON(map[string]any{
					"email":     resp.User.Email,
					"name":      resp.User.Name,
					"tenant_id": resp.User.TenantID,
				})
			}

			printSuccess(fmt.Sprintf("Logged in as %s (%s)", resp.User.Name, resp.User.Email))
			return nil
		},
	}

	cmd.Flags().StringVar(&email, "email", "", "Email address (non-interactive)")
	cmd.Flags().StringVar(&password, "password", "", "Password (non-interactive)")

	return cmd
}

func newWhoamiCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the currently authenticated user",
		RunE: func(cmd *cobra.Command, args []string) error {
			creds, err := internal.LoadCredentials()
			if err != nil {
				return fmt.Errorf("load credentials: %w", err)
			}
			if creds == nil || creds.Token == "" {
				printInfo("Not logged in. Run 'lantern login' first.")
				return nil
			}

			// Try to validate against the API.
			restURL := deriveRESTURL(flags.apiURL)
			client := internal.NewRESTClient(restURL, "", creds.Token)

			user, err := client.GetMe()
			if err != nil {
				// Fallback to cached credentials.
				if isJSON() {
					return printJSON(map[string]any{
						"email":     creds.Email,
						"name":      creds.Name,
						"tenant_id": creds.TenantID,
						"source":    "cached",
					})
				}
				printTable(
					[]string{"EMAIL", "NAME", "TENANT", "STATUS"},
					[][]string{{creds.Email, creds.Name, creds.TenantID, "cached (API unreachable)"}},
				)
				return nil
			}

			if isJSON() {
				return printJSON(map[string]any{
					"email":     user.Email,
					"name":      user.Name,
					"tenant_id": user.TenantID,
					"user_id":   user.ID,
					"role":      user.Role,
				})
			}

			printTable(
				[]string{"EMAIL", "NAME", "TENANT", "ROLE"},
				[][]string{{user.Email, user.Name, user.TenantID, user.Role}},
			)
			return nil
		},
	}
}

func newLogoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Clear stored credentials",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := internal.ClearCredentials(); err != nil {
				return fmt.Errorf("logout: %w", err)
			}

			if isJSON() {
				return printJSON(map[string]any{
					"status": "logged out",
				})
			}

			printSuccess("Logged out. Credentials cleared.")
			return nil
		},
	}
}

// deriveRESTURL converts a gRPC-style address (host:50051) to a REST URL
// (http://host:8080). If it already looks like an HTTP URL, returns as-is.
func deriveRESTURL(apiURL string) string {
	if strings.HasPrefix(apiURL, "http://") || strings.HasPrefix(apiURL, "https://") {
		return apiURL
	}
	// Strip port if it's the gRPC port.
	host := apiURL
	if idx := strings.LastIndex(host, ":"); idx > 0 {
		port := host[idx+1:]
		if port == "50051" {
			host = host[:idx]
		}
	}
	// If no port remains, add the REST port.
	if !strings.Contains(host, ":") {
		host = host + ":8080"
	}
	return "http://" + host
}
