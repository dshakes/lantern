package cli

// hooks.go — `lantern hooks …`: inbound webhook triggers (ADR 0028). A trigger
// binds a public POST /v1/hooks/{id} to an agent; GitHub/Sentry/PagerDuty (or
// any HMAC-signing sender) deliver there and each verified delivery starts a run.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

type hookTrigger struct {
	ID             string          `json:"id"`
	AgentName      string          `json:"agentName"`
	Provider       string          `json:"provider"`
	Enabled        bool            `json:"enabled"`
	InputTemplate  json.RawMessage `json:"inputTemplate,omitempty"`
	HookPath       string          `json:"hookPath"`
	LastDeliveryAt string          `json:"lastDeliveryAt,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	Secret         string          `json:"secret,omitempty"`
}

func newHooksCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "hooks",
		Aliases: []string{"hook", "triggers"},
		Short:   "Manage inbound webhook triggers (GitHub, Sentry, PagerDuty, generic HMAC)",
	}
	cmd.AddCommand(newHooksCreateCommand(), newHooksListCommand(), newHooksGetCommand(),
		newHooksUpdateCommand(), newHooksDeleteCommand())
	return cmd
}

// readSecretStdin reads one line from stdin so a secret never lands in shell history.
func readSecretStdin(in io.Reader) (string, error) {
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("read secret from stdin: %w", err)
	}
	return strings.TrimSpace(line), nil
}

func printHook(cmd *cobra.Command, t hookTrigger) {
	out := cmd.OutOrStdout()
	state := "enabled"
	if !t.Enabled {
		state = "disabled"
	}
	fmt.Fprintf(out, "%s  %s  %s  %s\n", t.ID, t.Provider, state, t.AgentName)
	fmt.Fprintf(out, "  url: %s%s\n", apiBase(), t.HookPath)
	if len(t.InputTemplate) > 0 {
		fmt.Fprintf(out, "  template: %s\n", t.InputTemplate)
	}
	if t.LastDeliveryAt != "" {
		fmt.Fprintf(out, "  last delivery: %s\n", t.LastDeliveryAt)
	}
}

func newHooksCreateCommand() *cobra.Command {
	var provider, template string
	var secretStdin bool
	cmd := &cobra.Command{
		Use:   "create <agent>",
		Short: "Create a webhook trigger for an agent",
		Long: "Create a webhook trigger. Lantern generates the signing secret and prints it once,\n" +
			"unless --secret-stdin supplies one (Sentry and PagerDuty generate their own).\n" +
			"--template maps the payload into run input, e.g. '{\"pr\":\"{{payload.number}}\"}'.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"provider": provider}
			if template != "" {
				body["inputTemplate"] = json.RawMessage(template)
			}
			if secretStdin {
				s, err := readSecretStdin(cmd.InOrStdin())
				if err != nil {
					return err
				}
				body["secret"] = s
			}
			b, err := json.Marshal(body)
			if err != nil {
				return fmt.Errorf("--template is not valid JSON: %w", err)
			}
			resp, err := apiRaw("POST", "/v1/agents/"+url.PathEscape(args[0])+"/triggers", b)
			if err != nil {
				return err
			}
			var t hookTrigger
			if err := json.Unmarshal(resp, &t); err != nil {
				return fmt.Errorf("decode response: %w", err)
			}
			if isJSON() {
				return printJSON(t)
			}
			printHook(cmd, t)
			if t.Secret != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  secret: %s\n  (shown once — paste it into the sender's webhook settings now)\n", t.Secret)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&provider, "provider", "generic", "generic | github | sentry | pagerduty")
	cmd.Flags().StringVar(&template, "template", "", "JSON object mapping the payload to run input")
	cmd.Flags().BoolVar(&secretStdin, "secret-stdin", false, "read the signing secret from stdin instead of generating one")
	return cmd
}

func newHooksListCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list <agent>",
		Short: "List an agent's webhook triggers",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			resp, err := apiRaw("GET", "/v1/agents/"+url.PathEscape(args[0])+"/triggers", nil)
			if err != nil {
				return err
			}
			var list []hookTrigger
			if err := json.Unmarshal(resp, &list); err != nil {
				return fmt.Errorf("decode response: %w", err)
			}
			if isJSON() {
				return printJSON(list)
			}
			if len(list) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No webhook triggers.")
				return nil
			}
			for _, t := range list {
				printHook(cmd, t)
			}
			return nil
		},
	}
}

func newHooksGetCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "get <trigger-id>",
		Short: "Show one webhook trigger",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			resp, err := apiRaw("GET", "/v1/triggers/"+url.PathEscape(args[0]), nil)
			if err != nil {
				return err
			}
			var t hookTrigger
			if err := json.Unmarshal(resp, &t); err != nil {
				return fmt.Errorf("decode response: %w", err)
			}
			if isJSON() {
				return printJSON(t)
			}
			printHook(cmd, t)
			return nil
		},
	}
}

func newHooksUpdateCommand() *cobra.Command {
	var enable, disable, secretStdin, clearTemplate bool
	var template string
	cmd := &cobra.Command{
		Use:   "update <trigger-id>",
		Short: "Enable/disable a trigger, replace its secret, or change its template",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			switch {
			case enable && disable:
				return fmt.Errorf("--enable and --disable are mutually exclusive")
			case enable:
				body["enabled"] = true
			case disable:
				body["enabled"] = false
			}
			switch {
			case clearTemplate && template != "":
				return fmt.Errorf("--template and --clear-template are mutually exclusive")
			case clearTemplate:
				body["inputTemplate"] = nil
			case template != "":
				body["inputTemplate"] = json.RawMessage(template)
			}
			if secretStdin {
				s, err := readSecretStdin(cmd.InOrStdin())
				if err != nil {
					return err
				}
				body["secret"] = s
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --enable, --disable, --template, --clear-template or --secret-stdin")
			}
			b, err := json.Marshal(body)
			if err != nil {
				return fmt.Errorf("--template is not valid JSON: %w", err)
			}
			resp, err := apiRaw("PATCH", "/v1/triggers/"+url.PathEscape(args[0]), b)
			if err != nil {
				return err
			}
			var t hookTrigger
			if err := json.Unmarshal(resp, &t); err != nil {
				return fmt.Errorf("decode response: %w", err)
			}
			if isJSON() {
				return printJSON(t)
			}
			printHook(cmd, t)
			return nil
		},
	}
	cmd.Flags().BoolVar(&enable, "enable", false, "enable the trigger")
	cmd.Flags().BoolVar(&disable, "disable", false, "disable the trigger (deliveries get 404)")
	cmd.Flags().StringVar(&template, "template", "", "replace the input template (JSON object)")
	cmd.Flags().BoolVar(&clearTemplate, "clear-template", false, "remove the input template")
	cmd.Flags().BoolVar(&secretStdin, "secret-stdin", false, "replace the signing secret, read from stdin")
	return cmd
}

func newHooksDeleteCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <trigger-id>",
		Short: "Delete a webhook trigger",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := apiRaw("DELETE", "/v1/triggers/"+url.PathEscape(args[0]), nil); err != nil {
				return err
			}
			if isJSON() {
				return printJSON(map[string]any{"deleted": args[0]})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Trigger %s deleted.\n", args[0])
			return nil
		},
	}
}
