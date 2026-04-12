package cli

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"

	"github.com/dshakes/lantern/packages/cli/internal/cli/templates"
	"github.com/spf13/cobra"
)

// templateData holds values substituted into scaffolded files.
type templateData struct {
	Name string
}

func newInitCommand() *cobra.Command {
	var tmplName string

	cmd := &cobra.Command{
		Use:   "init <agent-name>",
		Short: "Scaffold a new agent project",
		Long: `Creates a new directory with the agent scaffolding:
  - agent.yaml     (agent configuration)
  - src/index.ts   (entry point)
  - package.json   (npm manifest)
  - tsconfig.json  (TypeScript configuration)

Available templates:
  basic       Minimal agent — single LLM call, good starting point
  research    Research agent — web search, parallel queries, synthesis
  tool-use    Tool-using agent — web search, Python exec, file I/O
  connector   Connector agent — Slack, Gmail, Google Sheets integration
  personal    Personal workflow — WhatsApp/chat triggered, intent routing
  scheduled   Scheduled pipeline — cron-triggered data fetch and reporting
  approval    Human-in-the-loop — approval gates, questions, durable pause

If --template is not specified, an interactive picker is shown.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			agentName := args[0]

			// If no template flag was explicitly set, show the interactive picker.
			if !cmd.Flags().Changed("template") {
				picked, err := pickTemplate()
				if err != nil {
					return err
				}
				tmplName = picked
			}

			info := templates.Lookup(tmplName)
			if info == nil {
				return fmt.Errorf("unknown template %q (available: %s)", tmplName, strings.Join(templates.Names(), ", "))
			}

			return scaffoldProject(agentName, info)
		},
	}

	cmd.Flags().StringVar(&tmplName, "template", "basic", "Project template (see --help for list)")

	return cmd
}

// pickTemplate displays an interactive numbered list and reads the user's choice from stdin.
func pickTemplate() (string, error) {
	fmt.Fprintf(os.Stderr, "\n%sSelect a template:%s\n\n", colorCyan, colorReset)

	for i, t := range templates.Registry {
		fmt.Fprintf(os.Stderr, "  %s%d)%s %-12s %s%s%s\n",
			colorGreen, i+1, colorReset,
			t.Name,
			colorDim, t.Description, colorReset,
		)
	}

	fmt.Fprintf(os.Stderr, "\nEnter number [1-%d]: ", len(templates.Registry))

	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read input: %w", err)
	}

	line = strings.TrimSpace(line)
	choice, err := strconv.Atoi(line)
	if err != nil || choice < 1 || choice > len(templates.Registry) {
		return "", fmt.Errorf("invalid selection %q — enter a number between 1 and %d", line, len(templates.Registry))
	}

	selected := templates.Registry[choice-1]
	fmt.Fprintf(os.Stderr, "\n%sUsing template: %s%s\n\n", colorDim, selected.Name, colorReset)

	return selected.Name, nil
}

// scaffoldProject creates the agent directory and renders all template files.
func scaffoldProject(name string, info *templates.Info) error {
	dir := name

	// Check if directory already exists.
	if _, err := os.Stat(dir); err == nil {
		return fmt.Errorf("directory %q already exists", dir)
	}

	data := templateData{Name: name}

	// Walk the template directory in the embedded FS and render each file.
	var writtenFiles []string

	err := fs.WalkDir(templates.FS, info.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// Compute the relative path within the template directory.
		relPath, err := filepath.Rel(info.Dir, path)
		if err != nil {
			return fmt.Errorf("rel path %s: %w", path, err)
		}

		if d.IsDir() {
			// Create the corresponding output directory.
			if relPath != "." {
				outDir := filepath.Join(dir, relPath)
				if err := os.MkdirAll(outDir, 0o755); err != nil {
					return fmt.Errorf("mkdir %s: %w", outDir, err)
				}
			}
			return nil
		}

		// Read the template file from the embedded FS.
		raw, err := templates.FS.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read template %s: %w", path, err)
		}

		// Parse and execute the Go template.
		tmpl, err := template.New(path).Parse(string(raw))
		if err != nil {
			return fmt.Errorf("parse template %s: %w", path, err)
		}

		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, data); err != nil {
			return fmt.Errorf("execute template %s: %w", path, err)
		}

		// Write the rendered file.
		outPath := filepath.Join(dir, relPath)
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(outPath), err)
		}

		if err := os.WriteFile(outPath, buf.Bytes(), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", outPath, err)
		}

		writtenFiles = append(writtenFiles, relPath)
		return nil
	})

	if err != nil {
		return fmt.Errorf("scaffold %s: %w", info.Name, err)
	}

	if isJSON() {
		return printJSON(map[string]any{
			"agent_name": name,
			"template":   info.Name,
			"directory":  dir,
			"files":      writtenFiles,
		})
	}

	printSuccess(fmt.Sprintf("Scaffolded agent %q (template: %s) in ./%s/", name, info.Name, dir))
	fmt.Fprintf(os.Stderr, "\n  cd %s\n  npm install\n  lantern deploy\n\n", dir)

	return nil
}
