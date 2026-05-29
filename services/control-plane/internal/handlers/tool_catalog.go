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
		Action:      "list_issues",
		Description: "List recent GitHub issues assigned to the authenticated user across all repos. Use for daily/weekly briefings.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"state":  map[string]any{"type": "string", "enum": []string{"open", "closed", "all"}, "description": "Issue state (default: open)"},
				"filter": map[string]any{"type": "string", "enum": []string{"assigned", "created", "mentioned", "subscribed"}, "description": "Which issues to surface (default: assigned)"},
				"limit":  map[string]any{"type": "integer", "description": "Max results (default 30)"},
			},
		},
	},
	{
		Connector:   "github",
		Action:      "get_issue",
		Description: "Get a single GitHub issue including body and comments.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner":  map[string]any{"type": "string"},
				"repo":   map[string]any{"type": "string"},
				"number": map[string]any{"type": "integer", "description": "Issue number"},
			},
			"required": []string{"owner", "repo", "number"},
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
		Action:      "send_message",
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
		Action:      "post_message",
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
				"limit":   map[string]any{"type": "integer", "description": "Max results (default 10)"},
				"timeMin": map[string]any{"type": "string", "description": "RFC 3339 timestamp; default: now"},
			},
		},
	},

	// ---- Google Drive ----
	{
		Connector:   "google-drive",
		Action:      "list_files",
		Description: "List the authenticated user's recent Google Drive files.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
				"query": map[string]any{"type": "string", "description": "Optional Drive search query (e.g. mimeType='application/pdf')"},
			},
		},
	},

	// ---- Google Sheets ----
	{
		Connector:   "google-sheets",
		Action:      "get_values",
		Description: "Read cell values from a Google Sheet range.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"spreadsheetId": map[string]any{"type": "string", "description": "Sheet ID from the URL"},
				"range":         map[string]any{"type": "string", "description": "A1 notation, e.g. 'Sheet1!A1:D20'"},
			},
			"required": []string{"spreadsheetId", "range"},
		},
	},

	// ---- Jira ----
	{
		Connector:   "jira",
		Action:      "list_issues",
		Description: "List recent Jira issues assigned to or watched by the authenticated user.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"jql":   map[string]any{"type": "string", "description": "Optional JQL query (default: assignee=currentUser())"},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
			},
		},
	},
	{
		Connector:   "jira",
		Action:      "create_issue",
		Description: "Create a new Jira issue.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"projectKey":  map[string]any{"type": "string", "description": "Project key, e.g. 'ENG'"},
				"summary":     map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
				"issueType":   map[string]any{"type": "string", "enum": []string{"Task", "Bug", "Story", "Epic"}, "description": "Default: Task"},
			},
			"required": []string{"projectKey", "summary"},
		},
	},

	// ---- HubSpot ----
	{
		Connector:   "hubspot",
		Action:      "list_contacts",
		Description: "List recent HubSpot contacts.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
			},
		},
	},
	{
		Connector:   "hubspot",
		Action:      "list_deals",
		Description: "List recent HubSpot deals.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
			},
		},
	},

	// ---- Stripe ----
	{
		Connector:   "stripe",
		Action:      "list_charges",
		Description: "List recent Stripe charges. Use for revenue summaries.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25, max 100)"},
			},
		},
	},
	{
		Connector:   "stripe",
		Action:      "list_customers",
		Description: "List recent Stripe customers.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
			},
		},
	},

	// ---- Sentry ----
	{
		Connector:   "sentry",
		Action:      "list_issues",
		Description: "List recent Sentry issues (errors / exceptions) for the configured project.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 25)"},
				"query": map[string]any{"type": "string", "description": "Optional Sentry search query (e.g. 'is:unresolved')"},
			},
		},
	},

	// ---- Vercel ----
	{
		Connector:   "vercel",
		Action:      "list_projects",
		Description: "List the authenticated user's Vercel projects.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 20)"},
			},
		},
	},
	{
		Connector:   "vercel",
		Action:      "list_deployments",
		Description: "List recent Vercel deployments for a project.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"projectId": map[string]any{"type": "string", "description": "Vercel project ID"},
				"limit":     map[string]any{"type": "integer", "description": "Max results (default 20)"},
			},
		},
	},

	// ---- Discord ----
	{
		Connector:   "discord",
		Action:      "send_message",
		Description: "Post a message to a Discord channel.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"channelId": map[string]any{"type": "string", "description": "Discord channel ID"},
				"content":   map[string]any{"type": "string"},
			},
			"required": []string{"channelId", "content"},
		},
	},

	// ---- Telegram ----
	{
		Connector:   "telegram",
		Action:      "send_message",
		Description: "Send a Telegram message via the configured bot.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"chatId": map[string]any{"type": "string", "description": "Telegram chat ID (numeric)"},
				"text":   map[string]any{"type": "string"},
			},
			"required": []string{"chatId", "text"},
		},
	},

	// ---- Twilio ----
	{
		Connector:   "twilio",
		Action:      "send_sms",
		Description: "Send an SMS via Twilio.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"to":   map[string]any{"type": "string", "description": "E.164 phone number, e.g. +15551234567"},
				"from": map[string]any{"type": "string", "description": "Twilio-owned sender number; defaults to connector config"},
				"body": map[string]any{"type": "string"},
			},
			"required": []string{"to", "body"},
		},
	},

	// ---- Notion ----
	{
		Connector:   "notion",
		Action:      "list_databases",
		Description: "List Notion databases the authenticated user has access to.",
		Params: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	},

	// ---- Salesforce ----
	{
		Connector:   "salesforce",
		Action:      "query",
		Description: "Run a SOQL query against the authenticated Salesforce org.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"soql": map[string]any{"type": "string", "description": "SOQL query, e.g. 'SELECT Id, Name FROM Account LIMIT 10'"},
			},
			"required": []string{"soql"},
		},
	},

	// ---- Slack (extra) ----
	{
		Connector:   "slack",
		Action:      "list_channels",
		Description: "List Slack channels the bot user is in.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 50)"},
			},
		},
	},

	// ---- Gmail (extra) ----
	{
		Connector:   "gmail",
		Action:      "list_messages",
		Description: "List recent Gmail messages (no query — just inbox order). For filtered results use gmail__search.",
		Params: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "Max results (default 20)"},
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

	out := make([]map[string]any, 0, len(connectorTools)+2)
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

	// Always-on built-in tools — not gated by connector_installs. The
	// personal-docs pair proxies to the bridge over loopback; when no
	// bridge is running the tool just returns ok=false to the LLM,
	// which then asks the user instead of failing the run.
	out = append(out, personalDocsTools()...)
	return out, nil
}

// dispatchTool maps an OpenAI tool name back to the right executor.
// Personal-docs tools (search_personal_files / read_personal_file) are
// built-in and proxy to the bridge over loopback — they don't go through
// the connector_installs gate. Everything else is `<connector>__<action>`.
func dispatchTool(ctx context.Context, pool *pgxpool.Pool, tenantID, name string, params map[string]any) (any, error) {
	if isPersonalDocsTool(name) {
		return executePersonalDocsTool(ctx, tenantID, name, params)
	}
	parts := strings.SplitN(name, "__", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid tool name %q (expected <connector>__<action>)", name)
	}
	return executeConnectorAction(ctx, pool, tenantID, parts[0], parts[1], params)
}
