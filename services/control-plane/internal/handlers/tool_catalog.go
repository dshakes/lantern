package handlers

// Tool catalog. Maps each (connector, action) the executor supports to an
// OpenAI/Anthropic-compatible JSON-schema description so the LLM can call
// connectors as tools. Without this catalog the model gets messages but no
// `tools[]`, so it can only respond with plain text — which is why
// templated agents like Morning Brief used to babble "no connectors
// provided" even when GitHub + Linear were connected.
//
// Tool name convention: `<connector>__<action>` (double underscore). The
// dispatcher splits on `__` to route the call back into the existing
// executeConnectorAction. We use double underscore because OpenAI tool
// names must match `^[a-zA-Z0-9_-]+$` and we want to keep the connector
// prefix readable.

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// toolDef describes one callable connector action.
type toolDef struct {
	Connector   string         // e.g. "github"
	Action      string         // e.g. "list_prs"
	Description string         // human-readable
	Params      map[string]any // JSON schema for parameters
}

// Name returns the OpenAI tool name for this def.
func (t toolDef) Name() string {
	return t.Connector + "__" + t.Action
}

// connectorTools is the curated registry. We deliberately keep this small
// and high-leverage rather than auto-generating one tool per connector
// action. Reasons:
//   - LLMs perform worse with 50+ tools in context; surfacing only the
//     daily-driver actions improves call quality.
//   - Each tool requires an accurate description and schema, which is
//     hand-crafted work.
//   - Adding a tool here is a deliberate decision, not a side-effect of
//     adding a connector action.
var connectorTools = []toolDef{
	// ---- GitHub ----
	{
		Connector:   "github",
		Action:      "list_prs",
		Description: "List open pull requests in a GitHub repository. Returns title, author, created_at, and URL.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string", "description": "Repository owner (org or user)"},
				"repo":  map[string]any{"type": "string", "description": "Repository name"},
				"state": map[string]any{"type": "string", "enum": []string{"open", "closed", "all"}, "description": "PR state (default: open)"},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 30, max 100)"},
			},
			"required": []string{"owner", "repo"},
		},
	},
	{
		Connector:   "github",
		Action:      "list_repos",
		Description: "List GitHub repositories the authenticated user has access to.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 30)"},
				"sort":  map[string]any{"type": "string", "enum": []string{"updated", "created", "pushed", "full_name"}, "description": "Sort order (default: updated)"},
			},
		},
	},
	{
		Connector:   "github",
		Action:      "create_issue",
		Description: "Create a new GitHub issue.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"title": map[string]any{"type": "string"},
				"body":  map[string]any{"type": "string", "description": "Issue body in Markdown"},
			},
			"required": []string{"owner", "repo", "title"},
		},
	},

	// ---- Linear ----
	{
		Connector:   "linear",
		Action:      "list_issues",
		Description: "List recent Linear issues assigned to or watched by the authenticated user, ordered by updated time. Use for daily/weekly briefings.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
			},
		},
	},
	{
		Connector:   "linear",
		Action:      "create_issue",
		Description: "Create a new Linear issue in a team.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":       map[string]any{"type": "string"},
				"teamId":      map[string]any{"type": "string", "description": "Linear team identifier"},
				"description": map[string]any{"type": "string", "description": "Issue description in Markdown"},
			},
			"required": []string{"title", "teamId"},
		},
	},

	// ---- Gmail ----
	{
		Connector:   "gmail",
		Action:      "search",
		Description: "Search the authenticated user's Gmail inbox. Use Gmail search syntax (e.g. `is:unread newer_than:1d`). Returns matching message metadata.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Gmail search query"},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 20)"},
			},
			"required": []string{"query"},
		},
	},
	{
		Connector:   "gmail",
		Action:      "send",
		Description: "Send an email from the authenticated user's Gmail account.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"to":      map[string]any{"type": "string", "description": "Recipient email address"},
				"subject": map[string]any{"type": "string"},
				"body":    map[string]any{"type": "string", "description": "Plain-text email body"},
			},
			"required": []string{"to", "subject", "body"},
		},
	},

	// ---- Slack ----
	{
		Connector:   "slack",
		Action:      "send_message",
		Description: "Post a message to a Slack channel.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"channel": map[string]any{"type": "string", "description": "Channel ID or name (e.g. #general)"},
				"text":    map[string]any{"type": "string"},
			},
			"required": []string{"channel", "text"},
		},
	},

	// ---- Notion ----
	{
		Connector:   "notion",
		Action:      "search",
		Description: "Search the authenticated user's Notion workspace.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string"},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 20)"},
			},
		},
	},

	// ---- Google Calendar ----
	{
		Connector:   "google-calendar",
		Action:      "list_events",
		Description: "List upcoming calendar events for the authenticated user.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit":  map[string]any{"type": "integer", "description": "Max results (default 10)"},
				"timeMin": map[string]any{"type": "string", "description": "RFC 3339 timestamp; default: now"},
			},
		},
	},
}

// toolsForTenant returns the OpenAI-format tool list for every connector
// the tenant currently has installed. Tools whose connector isn't installed
// are filtered out so the model doesn't waste tokens reasoning about
// unavailable capabilities (and doesn't get a "not installed" error when
// it tries to call one).
func toolsForTenant(ctx context.Context, pool *pgxpool.Pool, tenantID string) ([]map[string]any, error) {
	rows, err := pool.Query(ctx, `
		SELECT connector_id FROM connector_installs
		WHERE tenant_id = $1 AND status = 'connected'
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	installed := map[string]bool{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			continue
		}
		installed[c] = true
	}

	out := make([]map[string]any, 0, len(connectorTools))
	for _, t := range connectorTools {
		if !installed[t.Connector] {
			continue
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name(),
				"description": t.Description,
				"parameters":  t.Params,
			},
		})
	}
	return out, nil
}

// dispatchTool maps an OpenAI tool name (`<connector>__<action>`) back to
// the connector executor.
func dispatchTool(ctx context.Context, pool *pgxpool.Pool, tenantID, name string, params map[string]any) (any, error) {
	parts := strings.SplitN(name, "__", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid tool name %q (expected <connector>__<action>)", name)
	}
	return executeConnectorAction(ctx, pool, tenantID, parts[0], parts[1], params)
}
