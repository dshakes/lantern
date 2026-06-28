package handlers

// isSideEffectingAction reports whether (connectorID, action) is known or
// suspected to have external side effects (sends, creates, updates, deletes).
//
// Conservative allowlist: KNOWN read-only actions return false; EVERYTHING
// ELSE returns true. Unknown connector or unrecognised action defaults to
// true (fail-safe — treat as side-effecting).
//
// This gates the cross-app workflow propose path (POST /v1/cross-app/propose):
// only non-side-effecting reads may be used as the "gather context" step.
// The proposed side-effecting action itself always requires an explicit owner
// confirm via POST /v1/commitments/{id}/execute-action.
func isSideEffectingAction(connectorID, action string) bool {
	known, ok := knownReadActions[connectorID]
	if !ok {
		return true // unknown connector = side-effecting (fail-safe)
	}
	return !known[action] // action not in allowlist = side-effecting
}

// knownReadActions maps each connector to its conservative set of read-only
// (non-side-effecting) actions. Only confirmed pure-read actions are listed;
// every write, create, update, delete, send, or post is absent (and therefore
// classified as side-effecting by default).
var knownReadActions = map[string]map[string]bool{
	"gmail": {
		"list_messages": true,
		"list_recent":   true,
		"search":        true,
	},
	"google-calendar": {
		"list_events": true,
	},
	"google-drive": {
		"list_files": true,
	},
	"google-sheets": {
		"get_spreadsheet": true,
		"get_values":      true,
	},
	"github": {
		"list_repos":  true,
		"list_prs":    true,
		"get_pr":      true,
		"list_issues": true,
		"get_issue":   true,
	},
	"notion": {
		"search":         true,
		"list_databases": true,
	},
	"linear": {
		"list_issues": true,
	},
	"jira": {
		"list_issues": true,
	},
	"hubspot": {
		"list_contacts": true,
		"list_deals":    true,
	},
	"stripe": {
		"list_charges":   true,
		"list_customers": true,
	},
	"sentry": {
		"list_issues": true,
	},
	"vercel": {
		"list_projects":    true,
		"list_deployments": true,
	},
	"salesforce": {
		"query": true,
	},
	"slack": {
		"list_channels": true,
		"list_users":    true,
	},
	"telegram": {
		"get_updates": true,
	},
	"twilio": {
		"list_messages": true,
	},
}
