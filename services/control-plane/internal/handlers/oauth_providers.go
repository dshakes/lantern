package handlers

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// OAuthProvider describes the OAuth endpoints and default scopes for a
// third-party service that Lantern can connect to as a connector.
type OAuthProvider struct {
	AuthURL      string
	TokenURL     string
	Scopes       []string
	RedirectPath string
}

// oauthProviders is the registry of supported OAuth providers, keyed by the
// connector_id stored in connector_installs.
var oauthProviders = map[string]OAuthProvider{
	"google": {
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scopes:       []string{"https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"gmail": {
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scopes:       []string{"https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.labels"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"google-calendar": {
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scopes:       []string{"https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"google-drive": {
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scopes:       []string{"https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"google-sheets": {
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scopes:       []string{"https://www.googleapis.com/auth/spreadsheets"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"slack": {
		AuthURL:      "https://slack.com/oauth/v2/authorize",
		TokenURL:     "https://slack.com/api/oauth.v2.access",
		Scopes:       []string{"channels:read", "chat:write", "users:read"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"github": {
		AuthURL:      "https://github.com/login/oauth/authorize",
		TokenURL:     "https://github.com/login/oauth/access_token",
		Scopes:       []string{"repo", "read:user"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"gitlab": {
		AuthURL:      "https://gitlab.com/oauth/authorize",
		TokenURL:     "https://gitlab.com/oauth/token",
		Scopes:       []string{"read_api", "read_user", "read_repository"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"discord": {
		AuthURL:      "https://discord.com/api/oauth2/authorize",
		TokenURL:     "https://discord.com/api/oauth2/token",
		Scopes:       []string{"bot", "identify", "guilds"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"hubspot": {
		AuthURL:      "https://app.hubspot.com/oauth/authorize",
		TokenURL:     "https://api.hubapi.com/oauth/v1/token",
		Scopes:       []string{"crm.objects.contacts.read", "crm.objects.deals.read"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"stripe": {
		AuthURL:      "https://connect.stripe.com/oauth/authorize",
		TokenURL:     "https://connect.stripe.com/oauth/token",
		Scopes:       []string{"read_write"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"notion": {
		AuthURL:      "https://api.notion.com/v1/oauth/authorize",
		TokenURL:     "https://api.notion.com/v1/oauth/token",
		Scopes:       []string{}, // Notion uses owner-level permissions set in the integration
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"linear": {
		AuthURL:      "https://linear.app/oauth/authorize",
		TokenURL:     "https://api.linear.app/oauth/token",
		Scopes:       []string{"read", "write", "issues:create"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"jira": {
		AuthURL:      "https://auth.atlassian.com/authorize",
		TokenURL:     "https://auth.atlassian.com/oauth/token",
		Scopes:       []string{"read:jira-work", "write:jira-work", "read:jira-user"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"salesforce": {
		AuthURL:      "https://login.salesforce.com/services/oauth2/authorize",
		TokenURL:     "https://login.salesforce.com/services/oauth2/token",
		Scopes:       []string{"api", "refresh_token"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"outlook": {
		AuthURL:      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		TokenURL:     "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		Scopes:       []string{"Mail.Read", "Mail.Send", "Calendars.ReadWrite"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"ms-teams": {
		AuthURL:      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		TokenURL:     "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		Scopes:       []string{"ChannelMessage.Send", "Chat.ReadWrite", "Team.ReadBasic.All"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"dropbox": {
		AuthURL:      "https://www.dropbox.com/oauth2/authorize",
		TokenURL:     "https://api.dropboxapi.com/oauth2/token",
		Scopes:       []string{"files.content.read", "files.content.write"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
	"shopify": {
		AuthURL:      "https://{shop}.myshopify.com/admin/oauth/authorize",
		TokenURL:     "https://{shop}.myshopify.com/admin/oauth/access_token",
		Scopes:       []string{"read_products", "read_orders", "read_customers"},
		RedirectPath: "/v1/connectors/oauth/callback",
	},
}

// oauthClientID returns the OAuth client ID for a given connector.
// In production these come from a secret store; here we read from env vars.
func oauthClientID(connectorID string) string {
	envKey := "OAUTH_CLIENT_ID_" + strings.ToUpper(strings.ReplaceAll(connectorID, "-", "_"))
	return os.Getenv(envKey)
}

// oauthClientSecret returns the OAuth client secret for a given connector.
func oauthClientSecret(connectorID string) string {
	envKey := "OAUTH_CLIENT_SECRET_" + strings.ToUpper(strings.ReplaceAll(connectorID, "-", "_"))
	return os.Getenv(envKey)
}

// oauthBaseURL returns the public base URL for redirect URIs.
func oauthBaseURL() string {
	if v := os.Getenv("OAUTH_BASE_URL"); v != "" {
		return v
	}
	return "http://localhost:8080"
}

// buildAuthorizationURL constructs the full OAuth authorization URL for a
// given provider and state token.
func buildAuthorizationURL(connectorID, stateToken string) (string, error) {
	provider, ok := oauthProviders[connectorID]
	if !ok {
		return "", fmt.Errorf("unsupported connector: %s", connectorID)
	}

	clientID := oauthClientID(connectorID)
	if clientID == "" {
		return "", fmt.Errorf("OAuth client ID not configured for %s (set %s)", connectorID, "OAUTH_CLIENT_ID_"+strings.ToUpper(strings.ReplaceAll(connectorID, "-", "_")))
	}

	redirectURI := oauthBaseURL() + provider.RedirectPath

	params := url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirectURI},
		"response_type": {"code"},
		"state":         {stateToken},
	}

	if len(provider.Scopes) > 0 {
		params.Set("scope", strings.Join(provider.Scopes, " "))
	}

	// Some providers want additional params.
	switch connectorID {
	case "google", "gmail", "google-calendar", "google-drive", "google-sheets":
		params.Set("access_type", "offline")
		params.Set("prompt", "consent")
	case "slack":
		// Slack uses user_scope for user tokens.
		params.Set("user_scope", strings.Join(provider.Scopes, ","))
	case "jira":
		params.Set("audience", "api.atlassian.com")
		params.Set("prompt", "consent")
	}

	return provider.AuthURL + "?" + params.Encode(), nil
}
