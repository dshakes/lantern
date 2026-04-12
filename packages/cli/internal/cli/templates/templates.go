// Package templates provides embedded template files for the `lantern init` command.
package templates

import "embed"

// FS embeds all template directories used by `lantern init`.
//
//go:embed basic research tool-use connector personal scheduled approval
var FS embed.FS

// Info describes a single project template.
type Info struct {
	Name        string
	Dir         string // directory name inside the embedded FS
	Description string
}

// Registry lists every available template in display order.
var Registry = []Info{
	{Name: "basic", Dir: "basic", Description: "Minimal agent — single LLM call, good starting point"},
	{Name: "research", Dir: "research", Description: "Research agent — web search, parallel queries, synthesis"},
	{Name: "tool-use", Dir: "tool-use", Description: "Tool-using agent — web search, Python exec, file I/O"},
	{Name: "connector", Dir: "connector", Description: "Connector agent — Slack, Gmail, Google Sheets integration"},
	{Name: "personal", Dir: "personal", Description: "Personal workflow — WhatsApp/chat triggered, intent routing"},
	{Name: "scheduled", Dir: "scheduled", Description: "Scheduled pipeline — cron-triggered data fetch and reporting"},
	{Name: "approval", Dir: "approval", Description: "Human-in-the-loop — approval gates, questions, durable pause"},
}

// Lookup returns the Info for the given template name, or nil if not found.
func Lookup(name string) *Info {
	for i := range Registry {
		if Registry[i].Name == name {
			return &Registry[i]
		}
	}
	return nil
}

// Names returns a slice of all template names.
func Names() []string {
	names := make([]string, len(Registry))
	for i, t := range Registry {
		names[i] = t.Name
	}
	return names
}
