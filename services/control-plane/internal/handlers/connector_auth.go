package handlers

// Connector auth helpers.
//
// Before this file existed, every executeX function in connector_executor.go
// open-coded its own token resolution: checking 'token', 'accessToken',
// 'oauth_access_token', 'botToken', 'apiKey', 'personalAccessToken' in some
// inconsistent order. Two real bugs landed because of it:
//   1. GitHub stored its PAT under `personalAccessToken` but the executor
//      only checked `token` / `accessToken` / `oauth_access_token` →
//      "missing GitHub token" while the dashboard happily said "Connected".
//   2. Slack/Discord stored OAuth tokens under `oauth_access_token` but the
//      executor checked `botToken` FIRST → "Connect via OAuth" succeeded,
//      then Run Now said "missing bot token".
//
// This module is the single source of truth. resolveConnectorToken() walks
// a priority list — OAuth-first (the most reliable + most recent install
// path), then the connector-specific manual field, then a generic
// fallback chain. Every executor uses it.

import (
	"fmt"
	"strings"
)

// resolveConnectorToken returns the credential string for a connector, or
// "" when none is configured.
//
// Priority order (highest first):
//  1. OAuth: refreshed accessToken (set by executeConnectorAction after
//     refreshGoogleToken). Always wins because it's the freshest token in
//     the row when OAuth is in play.
//  2. OAuth: oauth_access_token (the original from the OAuth handler).
//  3. Connector-specific manual field (e.g. personalAccessToken for
//     GitHub, botToken for Slack/Discord/Telegram, apiKey for Linear).
//  4. Generic 'token' field (back-compat for SDK-driven installs).
//
// preferredFields lists the connector-specific manual fields in the order
// they should be checked. Pass the fields the connector's dashboard form
// actually presents — see apps/web/app/(dashboard)/connectors/page.tsx.
func resolveConnectorToken(config map[string]any, preferredFields ...string) string {
	// OAuth always wins when present.
	if v, _ := config["accessToken"].(string); v != "" {
		return v
	}
	if v, _ := config["oauth_access_token"].(string); v != "" {
		return v
	}
	// Then the connector-specific manual fields, in caller-supplied order.
	for _, f := range preferredFields {
		if v, _ := config[f].(string); v != "" {
			return v
		}
	}
	// Generic 'token' as last resort for back-compat installs.
	if v, _ := config["token"].(string); v != "" {
		return v
	}
	return ""
}

// missingTokenError returns a consistent, actionable error message when
// a connector has no usable credential. Beats the old generic
// "missing X token" messages — points at the exact dashboard field
// name AND the OAuth alternative when one exists.
type connectorAuthHint struct {
	// ConnectorName is the human label ("GitHub", "Linear", "Slack").
	ConnectorName string
	// ManualField is what the dashboard's install form labels the
	// credential ("Personal Access Token", "Bot Token", "API Key").
	ManualField string
	// SupportsOAuth indicates whether the connector has an OAuth flow on
	// the Connectors page. When true, we tell the user they can also
	// click 'Sign in with X' instead of pasting a token.
	SupportsOAuth bool
	// CredentialDocsURL is where the user goes to MINT a fresh token if
	// they don't have one. Optional — omit for connectors where it's
	// obvious (e.g. Salesforce admin panels vary).
	CredentialDocsURL string
}

func missingTokenError(hint connectorAuthHint) error {
	var b strings.Builder
	fmt.Fprintf(&b, "%s is not authenticated.", hint.ConnectorName)
	if hint.SupportsOAuth {
		fmt.Fprintf(&b, " Click 'Sign in with %s' on the Connectors page,", hint.ConnectorName)
		fmt.Fprintf(&b, " or paste a %s manually.", hint.ManualField)
	} else {
		fmt.Fprintf(&b, " Paste a %s on the Connectors page.", hint.ManualField)
	}
	if hint.CredentialDocsURL != "" {
		fmt.Fprintf(&b, " Get one at %s", hint.CredentialDocsURL)
	}
	return fmt.Errorf("%s", b.String())
}
