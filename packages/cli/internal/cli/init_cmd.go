package cli

import (
	"bytes"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"text/template"

	"github.com/spf13/cobra"
)

//go:embed templates/basic/agent.yaml templates/basic/package.json templates/basic/tsconfig.json templates/basic/src/index.ts
var templateFS embed.FS

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
  - tsconfig.json  (TypeScript configuration)`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			agentName := args[0]

			if tmplName != "basic" && tmplName != "research" && tmplName != "tool-use" {
				return fmt.Errorf("unknown template %q (available: basic, research, tool-use)", tmplName)
			}

			// For the spike, all templates use the basic scaffold.
			// research and tool-use will get their own templates later.
			return scaffoldProject(agentName)
		},
	}

	cmd.Flags().StringVar(&tmplName, "template", "basic", "Project template (basic, research, tool-use)")

	return cmd
}

// scaffoldProject creates the agent directory and renders all template files.
func scaffoldProject(name string) error {
	dir := name

	// Check if directory already exists.
	if _, err := os.Stat(dir); err == nil {
		return fmt.Errorf("directory %q already exists", dir)
	}

	data := templateData{Name: name}

	files := []struct {
		embedPath  string
		outputPath string
	}{
		{"templates/basic/agent.yaml", "agent.yaml"},
		{"templates/basic/src/index.ts", "src/index.ts"},
		{"templates/basic/package.json", "package.json"},
		{"templates/basic/tsconfig.json", "tsconfig.json"},
	}

	for _, f := range files {
		outPath := filepath.Join(dir, f.outputPath)

		// Read the template from the embedded FS.
		raw, err := templateFS.ReadFile(f.embedPath)
		if err != nil {
			return fmt.Errorf("read template %s: %w", f.embedPath, err)
		}

		// Parse and execute the template.
		tmpl, err := template.New(f.embedPath).Parse(string(raw))
		if err != nil {
			return fmt.Errorf("parse template %s: %w", f.embedPath, err)
		}

		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, data); err != nil {
			return fmt.Errorf("execute template %s: %w", f.embedPath, err)
		}

		// Create directory and write file.
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(outPath), err)
		}

		if err := os.WriteFile(outPath, buf.Bytes(), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", outPath, err)
		}
	}

	if isJSON() {
		return printJSON(map[string]any{
			"agent_name": name,
			"directory":  dir,
			"files":      []string{"agent.yaml", "src/index.ts", "package.json", "tsconfig.json"},
		})
	}

	printSuccess(fmt.Sprintf("Scaffolded agent %q in ./%s/", name, dir))
	fmt.Fprintf(os.Stderr, "\n  cd %s\n  npm install\n  lantern deploy\n\n", dir)

	return nil
}
