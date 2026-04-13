package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ConnectorExecutor routes execute requests to the right connector implementation.
type ConnectorExecutor struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewConnectorExecutor creates a new ConnectorExecutor.
func NewConnectorExecutor(srv *server.Server, auth *AuthHandler) *ConnectorExecutor {
	return &ConnectorExecutor{srv: srv, auth: auth}
}

func (h *ConnectorExecutor) logger() *zap.Logger {
	return h.srv.Logger.Named("connector-executor")
}

// httpClient is a shared client with a reasonable timeout for outbound API calls.
var httpClient = &http.Client{Timeout: 30 * time.Second}

// Execute handles GET/POST /v1/connectors/{connectorId}/execute?action={action}.
// It loads credentials from connector_installs, then dispatches to the
// appropriate connector implementation which makes real API calls.
func (h *ConnectorExecutor) Execute(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	tenantID := claims.TenantID
	ctx := r.Context()

	connectorID := r.PathValue("connectorId")
	if connectorID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "connectorId is required"})
		return
	}

	action := r.URL.Query().Get("action")
	if action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action query parameter is required"})
		return
	}

	// Parse request body params (for POST requests or optional params).
	var params map[string]any
	if r.Method == http.MethodPost && r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&params); err != nil {
			// Not all actions require a body; treat parse failure as empty params.
			params = make(map[string]any)
		}
	}
	if params == nil {
		params = make(map[string]any)
	}

	// Also merge query parameters into params (lower priority than body).
	for k, v := range r.URL.Query() {
		if k == "action" {
			continue
		}
		if _, exists := params[k]; !exists {
			if len(v) == 1 {
				params[k] = v[0]
			} else {
				params[k] = v
			}
		}
	}

	// Load credentials from connector_installs.
	var configJSON []byte
	var oauthTokenJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT config, oauth_token_encrypted
		FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = $2 AND status = 'connected'
	`, tenantID, connectorID).Scan(&configJSON, &oauthTokenJSON)
	if err != nil {
		h.logger().Warn("connector not installed or not connected",
			zap.String("connector", connectorID),
			zap.String("tenant", tenantID),
			zap.Error(err),
		)
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("Connector '%s' is not installed or not connected. Install it first on the Connectors page.", connectorID),
		})
		return
	}

	// Build a unified config map merging stored config and OAuth token data.
	config := make(map[string]any)
	if len(configJSON) > 0 {
		json.Unmarshal(configJSON, &config) //nolint:errcheck
	}
	if len(oauthTokenJSON) > 0 {
		var oauthData map[string]any
		if err := json.Unmarshal(oauthTokenJSON, &oauthData); err == nil {
			// Merge OAuth fields into config (e.g., access_token, refresh_token).
			for k, v := range oauthData {
				config["oauth_"+k] = v
			}
			// Also set a convenience accessToken key.
			if at, ok := oauthData["access_token"].(string); ok {
				config["accessToken"] = at
			}
		}
	}

	// Dispatch to the right executor.
	var result any
	var execErr error

	switch connectorID {
	case "gmail":
		result, execErr = executeGmail(config, action, params)
	case "slack":
		result, execErr = executeSlack(config, action, params)
	case "github":
		result, execErr = executeGitHub(config, action, params)
	case "discord":
		result, execErr = executeDiscord(config, action, params)
	case "telegram":
		result, execErr = executeTelegram(config, action, params)
	case "twilio":
		result, execErr = executeTwilio(config, action, params)
	case "notion":
		result, execErr = executeNotion(config, action, params)
	case "linear":
		result, execErr = executeLinear(config, action, params)
	case "jira":
		result, execErr = executeJira(config, action, params)
	case "hubspot":
		result, execErr = executeHubSpot(config, action, params)
	case "stripe":
		result, execErr = executeStripe(config, action, params)
	case "sentry":
		result, execErr = executeSentry(config, action, params)
	case "vercel":
		result, execErr = executeVercel(config, action, params)
	case "salesforce":
		result, execErr = executeSalesforce(config, action, params)
	case "google-calendar":
		result, execErr = executeGoogleCalendar(config, action, params)
	case "google-drive":
		result, execErr = executeGoogleDrive(config, action, params)
	case "google-sheets":
		result, execErr = executeGoogleSheets(config, action, params)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("Unsupported connector: %s", connectorID),
		})
		return
	}

	if execErr != nil {
		h.logger().Warn("connector execution failed",
			zap.String("connector", connectorID),
			zap.String("action", action),
			zap.Error(execErr),
		)
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":     execErr.Error(),
			"connector": connectorID,
			"action":    action,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"connector": connectorID,
		"action":    action,
		"data":      result,
	})
}

// ---------------------------------------------------------------------------
// Helper: perform an HTTP request and parse JSON response
// ---------------------------------------------------------------------------

func doJSONRequest(method, urlStr string, headers map[string]string, body io.Reader) (map[string]any, error) {
	req, err := http.NewRequest(method, urlStr, body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]any
	if err := json.Unmarshal(respBody, &result); err != nil {
		// Some APIs return arrays at the top level.
		var arr []any
		if jsonErr := json.Unmarshal(respBody, &arr); jsonErr == nil {
			return map[string]any{"items": arr}, nil
		}
		return nil, fmt.Errorf("parse response: %w (body: %s)", err, string(respBody))
	}
	return result, nil
}

func doJSONRequestRaw(method, urlStr string, headers map[string]string, body io.Reader) ([]byte, int, error) {
	req, err := http.NewRequest(method, urlStr, body)
	if err != nil {
		return nil, 0, fmt.Errorf("build request: %w", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response: %w", err)
	}

	return respBody, resp.StatusCode, nil
}

// stringParam extracts a string from the params map.
func stringParam(params map[string]any, key string) string {
	if v, ok := params[key].(string); ok {
		return v
	}
	return ""
}

// intParam extracts an int from the params map (handles both float64 from JSON and string).
func intParam(params map[string]any, key string, defaultVal int) int {
	switch v := params[key].(type) {
	case float64:
		return int(v)
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultVal
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

func executeGmail(config map[string]any, action string, params map[string]any) (any, error) {
	accessToken, _ := config["accessToken"].(string)
	email, _ := config["email"].(string)
	appPassword, _ := config["appPassword"].(string)

	switch action {
	case "list_messages":
		limit := intParam(params, "limit", 20)
		// Prefer IMAP (email+appPassword) since it works without OAuth setup
		if email != "" && appPassword != "" {
			messages, err := FetchGmailViaIMAP(email, appPassword, limit)
			if err != nil {
				return nil, fmt.Errorf("IMAP fetch failed: %w", err)
			}
			return map[string]any{"messages": messages, "count": len(messages), "source": "imap"}, nil
		}
		if accessToken != "" {
			messages, err := FetchGmailViaAPI(accessToken, limit)
			if err != nil {
				return nil, fmt.Errorf("Gmail API fetch failed: %w", err)
			}
			return map[string]any{"messages": messages, "count": len(messages), "source": "api"}, nil
		}
		return nil, fmt.Errorf("no Gmail credentials configured. Provide email+appPassword or an OAuth token")

	case "send_message":
		to := stringParam(params, "to")
		subject := stringParam(params, "subject")
		body := stringParam(params, "body")
		if to == "" || subject == "" {
			return nil, fmt.Errorf("'to' and 'subject' parameters are required")
		}
		if accessToken != "" {
			return sendGmailViaAPI(accessToken, to, subject, body)
		}
		return nil, fmt.Errorf("send_message requires an OAuth access token")

	case "search":
		query := stringParam(params, "query")
		if query == "" {
			return nil, fmt.Errorf("'query' parameter is required")
		}
		if accessToken == "" {
			return nil, fmt.Errorf("search requires an OAuth access token")
		}
		limit := intParam(params, "limit", 10)
		return searchGmailViaAPI(accessToken, query, limit)

	default:
		return nil, fmt.Errorf("unknown Gmail action: %s (supported: list_messages, send_message, search)", action)
	}
}

func sendGmailViaAPI(accessToken, to, subject, body string) (any, error) {
	// Build RFC 2822 message.
	msg := fmt.Sprintf("To: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s", to, subject, body)
	raw := base64.URLEncoding.EncodeToString([]byte(msg))

	payload, _ := json.Marshal(map[string]string{"raw": raw})
	headers := map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Content-Type":  "application/json",
	}

	result, err := doJSONRequest("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", headers, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("Gmail send failed: %w", err)
	}
	return result, nil
}

func searchGmailViaAPI(accessToken, query string, limit int) (any, error) {
	searchURL := fmt.Sprintf(
		"https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=%d&q=%s",
		limit, url.QueryEscape(query),
	)
	headers := map[string]string{
		"Authorization": "Bearer " + accessToken,
	}

	result, err := doJSONRequest("GET", searchURL, headers, nil)
	if err != nil {
		return nil, fmt.Errorf("Gmail search failed: %w", err)
	}

	// Fetch metadata for each message.
	messages, ok := result["messages"].([]any)
	if !ok || len(messages) == 0 {
		return map[string]any{"messages": []any{}, "count": 0}, nil
	}

	var detailed []map[string]any
	for _, m := range messages {
		msgMap, ok := m.(map[string]any)
		if !ok {
			continue
		}
		msgID, _ := msgMap["id"].(string)
		if msgID == "" {
			continue
		}

		msgURL := fmt.Sprintf(
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/%s?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
			msgID,
		)
		msgResult, err := doJSONRequest("GET", msgURL, headers, nil)
		if err != nil {
			continue
		}
		detailed = append(detailed, msgResult)
	}

	return map[string]any{"messages": detailed, "count": len(detailed)}, nil
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

func executeSlack(config map[string]any, action string, params map[string]any) (any, error) {
	botToken, _ := config["botToken"].(string)
	if botToken == "" {
		// Try OAuth access token.
		botToken, _ = config["accessToken"].(string)
	}
	if botToken == "" {
		botToken, _ = config["oauth_access_token"].(string)
	}
	if botToken == "" {
		return nil, fmt.Errorf("missing Slack bot token. Provide 'botToken' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + botToken,
		"Content-Type":  "application/json",
	}

	switch action {
	case "list_channels":
		limit := intParam(params, "limit", 100)
		apiURL := fmt.Sprintf("https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=%d", limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Slack list_channels failed: %w", err)
		}
		return result, nil

	case "post_message":
		channel := stringParam(params, "channel")
		text := stringParam(params, "text")
		if channel == "" || text == "" {
			return nil, fmt.Errorf("'channel' and 'text' parameters are required")
		}
		payload, _ := json.Marshal(map[string]string{"channel": channel, "text": text})
		result, err := doJSONRequest("POST", "https://slack.com/api/chat.postMessage", headers, bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("Slack post_message failed: %w", err)
		}
		return result, nil

	case "list_users":
		limit := intParam(params, "limit", 100)
		apiURL := fmt.Sprintf("https://slack.com/api/users.list?limit=%d", limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Slack list_users failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Slack action: %s (supported: list_channels, post_message, list_users)", action)
	}
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

func executeGitHub(config map[string]any, action string, params map[string]any) (any, error) {
	token, _ := config["token"].(string)
	if token == "" {
		token, _ = config["accessToken"].(string)
	}
	if token == "" {
		token, _ = config["oauth_access_token"].(string)
	}
	if token == "" {
		return nil, fmt.Errorf("missing GitHub token. Provide 'token' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	}

	switch action {
	case "list_repos":
		limit := intParam(params, "limit", 30)
		sort := stringParam(params, "sort")
		if sort == "" {
			sort = "updated"
		}
		apiURL := fmt.Sprintf("https://api.github.com/user/repos?per_page=%d&sort=%s", limit, sort)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("GitHub list_repos failed: %w", err)
		}
		return result, nil

	case "list_prs":
		owner := stringParam(params, "owner")
		repo := stringParam(params, "repo")
		if owner == "" || repo == "" {
			return nil, fmt.Errorf("'owner' and 'repo' parameters are required")
		}
		state := stringParam(params, "state")
		if state == "" {
			state = "open"
		}
		limit := intParam(params, "limit", 30)
		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls?state=%s&per_page=%d",
			url.PathEscape(owner), url.PathEscape(repo), state, limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("GitHub list_prs failed: %w", err)
		}
		return result, nil

	case "get_pr":
		owner := stringParam(params, "owner")
		repo := stringParam(params, "repo")
		number := stringParam(params, "number")
		if owner == "" || repo == "" || number == "" {
			return nil, fmt.Errorf("'owner', 'repo', and 'number' parameters are required")
		}
		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%s",
			url.PathEscape(owner), url.PathEscape(repo), number)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("GitHub get_pr failed: %w", err)
		}
		return result, nil

	case "create_issue":
		owner := stringParam(params, "owner")
		repo := stringParam(params, "repo")
		title := stringParam(params, "title")
		if owner == "" || repo == "" || title == "" {
			return nil, fmt.Errorf("'owner', 'repo', and 'title' parameters are required")
		}
		payload := map[string]any{"title": title}
		if body := stringParam(params, "body"); body != "" {
			payload["body"] = body
		}
		if labels, ok := params["labels"].([]any); ok {
			payload["labels"] = labels
		}
		if assignees, ok := params["assignees"].([]any); ok {
			payload["assignees"] = assignees
		}
		payloadJSON, _ := json.Marshal(payload)
		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues",
			url.PathEscape(owner), url.PathEscape(repo))
		result, err := doJSONRequest("POST", apiURL, headers, bytes.NewReader(payloadJSON))
		if err != nil {
			return nil, fmt.Errorf("GitHub create_issue failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown GitHub action: %s (supported: list_repos, list_prs, get_pr, create_issue)", action)
	}
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

func executeDiscord(config map[string]any, action string, params map[string]any) (any, error) {
	botToken, _ := config["botToken"].(string)
	if botToken == "" {
		botToken, _ = config["token"].(string)
	}
	if botToken == "" {
		botToken, _ = config["accessToken"].(string)
	}
	if botToken == "" {
		botToken, _ = config["oauth_access_token"].(string)
	}
	if botToken == "" {
		return nil, fmt.Errorf("missing Discord bot token. Provide 'botToken' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bot " + botToken,
		"Content-Type":  "application/json",
	}

	switch action {
	case "list_guilds":
		// For user tokens, use Bearer auth instead.
		if _, ok := config["oauth_access_token"]; ok {
			headers["Authorization"] = "Bearer " + botToken
		}
		result, err := doJSONRequest("GET", "https://discord.com/api/v10/users/@me/guilds", headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Discord list_guilds failed: %w", err)
		}
		return result, nil

	case "send_message":
		channelID := stringParam(params, "channel_id")
		content := stringParam(params, "content")
		if channelID == "" || content == "" {
			return nil, fmt.Errorf("'channel_id' and 'content' parameters are required")
		}
		payload, _ := json.Marshal(map[string]string{"content": content})
		apiURL := fmt.Sprintf("https://discord.com/api/v10/channels/%s/messages", url.PathEscape(channelID))
		result, err := doJSONRequest("POST", apiURL, headers, bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("Discord send_message failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Discord action: %s (supported: list_guilds, send_message)", action)
	}
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

func executeTelegram(config map[string]any, action string, params map[string]any) (any, error) {
	botToken, _ := config["botToken"].(string)
	if botToken == "" {
		botToken, _ = config["token"].(string)
	}
	if botToken == "" {
		return nil, fmt.Errorf("missing Telegram bot token. Provide 'botToken' in connector config")
	}

	baseURL := fmt.Sprintf("https://api.telegram.org/bot%s", botToken)

	switch action {
	case "send_message":
		chatID := stringParam(params, "chat_id")
		text := stringParam(params, "text")
		if chatID == "" || text == "" {
			return nil, fmt.Errorf("'chat_id' and 'text' parameters are required")
		}
		payload, _ := json.Marshal(map[string]string{"chat_id": chatID, "text": text})
		headers := map[string]string{"Content-Type": "application/json"}
		result, err := doJSONRequest("POST", baseURL+"/sendMessage", headers, bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("Telegram send_message failed: %w", err)
		}
		return result, nil

	case "get_updates":
		offset := intParam(params, "offset", 0)
		limit := intParam(params, "limit", 100)
		apiURL := fmt.Sprintf("%s/getUpdates?limit=%d", baseURL, limit)
		if offset > 0 {
			apiURL += fmt.Sprintf("&offset=%d", offset)
		}
		result, err := doJSONRequest("GET", apiURL, nil, nil)
		if err != nil {
			return nil, fmt.Errorf("Telegram get_updates failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Telegram action: %s (supported: send_message, get_updates)", action)
	}
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

func executeTwilio(config map[string]any, action string, params map[string]any) (any, error) {
	accountSID, _ := config["accountSid"].(string)
	if accountSID == "" {
		accountSID, _ = config["accountSID"].(string)
	}
	authToken, _ := config["authToken"].(string)
	if accountSID == "" || authToken == "" {
		return nil, fmt.Errorf("missing Twilio credentials. Provide 'accountSid' and 'authToken' in connector config")
	}

	baseURL := fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s", accountSID)
	basicAuth := base64.StdEncoding.EncodeToString([]byte(accountSID + ":" + authToken))
	headers := map[string]string{
		"Authorization": "Basic " + basicAuth,
	}

	switch action {
	case "send_sms":
		to := stringParam(params, "to")
		from := stringParam(params, "from")
		body := stringParam(params, "body")
		if to == "" || from == "" || body == "" {
			return nil, fmt.Errorf("'to', 'from', and 'body' parameters are required")
		}
		data := url.Values{
			"To":   {to},
			"From": {from},
			"Body": {body},
		}
		headers["Content-Type"] = "application/x-www-form-urlencoded"
		result, err := doJSONRequest("POST", baseURL+"/Messages.json", headers, strings.NewReader(data.Encode()))
		if err != nil {
			return nil, fmt.Errorf("Twilio send_sms failed: %w", err)
		}
		return result, nil

	case "list_messages":
		limit := intParam(params, "limit", 20)
		apiURL := fmt.Sprintf("%s/Messages.json?PageSize=%d", baseURL, limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Twilio list_messages failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Twilio action: %s (supported: send_sms, list_messages)", action)
	}
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

func executeNotion(config map[string]any, action string, params map[string]any) (any, error) {
	token, _ := config["integrationToken"].(string)
	if token == "" {
		token, _ = config["token"].(string)
	}
	if token == "" {
		token, _ = config["accessToken"].(string)
	}
	if token == "" {
		token, _ = config["oauth_access_token"].(string)
	}
	if token == "" {
		return nil, fmt.Errorf("missing Notion integration token. Provide 'integrationToken' in connector config")
	}

	headers := map[string]string{
		"Authorization":  "Bearer " + token,
		"Content-Type":   "application/json",
		"Notion-Version": "2022-06-28",
	}

	switch action {
	case "search":
		query := stringParam(params, "query")
		payload := map[string]any{}
		if query != "" {
			payload["query"] = query
		}
		pageSize := intParam(params, "page_size", 10)
		payload["page_size"] = pageSize

		payloadJSON, _ := json.Marshal(payload)
		result, err := doJSONRequest("POST", "https://api.notion.com/v1/search", headers, bytes.NewReader(payloadJSON))
		if err != nil {
			return nil, fmt.Errorf("Notion search failed: %w", err)
		}
		return result, nil

	case "list_databases":
		// Use search filtered to databases.
		payload, _ := json.Marshal(map[string]any{
			"filter":    map[string]string{"value": "database", "property": "object"},
			"page_size": intParam(params, "page_size", 10),
		})
		result, err := doJSONRequest("POST", "https://api.notion.com/v1/search", headers, bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("Notion list_databases failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Notion action: %s (supported: search, list_databases)", action)
	}
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

func executeLinear(config map[string]any, action string, params map[string]any) (any, error) {
	token, _ := config["apiKey"].(string)
	if token == "" {
		token, _ = config["token"].(string)
	}
	if token == "" {
		token, _ = config["accessToken"].(string)
	}
	if token == "" {
		token, _ = config["oauth_access_token"].(string)
	}
	if token == "" {
		return nil, fmt.Errorf("missing Linear API key. Provide 'apiKey' in connector config")
	}

	headers := map[string]string{
		"Authorization": token,
		"Content-Type":  "application/json",
	}

	switch action {
	case "list_issues":
		limit := intParam(params, "limit", 25)
		query := fmt.Sprintf(`{
			"query": "query { issues(first: %d, orderBy: updatedAt) { nodes { id identifier title state { name } priority assignee { name } createdAt updatedAt } } }"
		}`, limit)
		result, err := doJSONRequest("POST", "https://api.linear.app/graphql", headers, strings.NewReader(query))
		if err != nil {
			return nil, fmt.Errorf("Linear list_issues failed: %w", err)
		}
		return result, nil

	case "create_issue":
		title := stringParam(params, "title")
		if title == "" {
			return nil, fmt.Errorf("'title' parameter is required")
		}
		teamID := stringParam(params, "teamId")
		if teamID == "" {
			return nil, fmt.Errorf("'teamId' parameter is required")
		}
		description := stringParam(params, "description")

		mutation := fmt.Sprintf(`{
			"query": "mutation { issueCreate(input: { title: %q, teamId: %q, description: %q }) { success issue { id identifier title url } } }"
		}`, title, teamID, description)
		result, err := doJSONRequest("POST", "https://api.linear.app/graphql", headers, strings.NewReader(mutation))
		if err != nil {
			return nil, fmt.Errorf("Linear create_issue failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Linear action: %s (supported: list_issues, create_issue)", action)
	}
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

func executeJira(config map[string]any, action string, params map[string]any) (any, error) {
	domain, _ := config["domain"].(string)
	email, _ := config["email"].(string)
	apiToken, _ := config["apiToken"].(string)
	if apiToken == "" {
		apiToken, _ = config["token"].(string)
	}

	// Also support OAuth access token.
	oauthToken, _ := config["oauth_access_token"].(string)

	if domain == "" {
		return nil, fmt.Errorf("missing Jira domain. Provide 'domain' (e.g., 'mycompany.atlassian.net') in connector config")
	}

	var headers map[string]string
	if oauthToken != "" {
		headers = map[string]string{
			"Authorization": "Bearer " + oauthToken,
			"Accept":        "application/json",
			"Content-Type":  "application/json",
		}
	} else if email != "" && apiToken != "" {
		basicAuth := base64.StdEncoding.EncodeToString([]byte(email + ":" + apiToken))
		headers = map[string]string{
			"Authorization": "Basic " + basicAuth,
			"Accept":        "application/json",
			"Content-Type":  "application/json",
		}
	} else {
		return nil, fmt.Errorf("missing Jira credentials. Provide email+apiToken or connect via OAuth")
	}

	baseURL := fmt.Sprintf("https://%s/rest/api/3", domain)

	switch action {
	case "list_issues":
		jql := stringParam(params, "jql")
		if jql == "" {
			jql = "order by updated DESC"
		}
		limit := intParam(params, "limit", 20)
		apiURL := fmt.Sprintf("%s/search?jql=%s&maxResults=%d", baseURL, url.QueryEscape(jql), limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Jira list_issues failed: %w", err)
		}
		return result, nil

	case "create_issue":
		project := stringParam(params, "project")
		summary := stringParam(params, "summary")
		issueType := stringParam(params, "issueType")
		if project == "" || summary == "" {
			return nil, fmt.Errorf("'project' and 'summary' parameters are required")
		}
		if issueType == "" {
			issueType = "Task"
		}
		payload := map[string]any{
			"fields": map[string]any{
				"project":   map[string]string{"key": project},
				"summary":   summary,
				"issuetype": map[string]string{"name": issueType},
			},
		}
		if desc := stringParam(params, "description"); desc != "" {
			payload["fields"].(map[string]any)["description"] = map[string]any{
				"type":    "doc",
				"version": 1,
				"content": []map[string]any{
					{
						"type": "paragraph",
						"content": []map[string]any{
							{"type": "text", "text": desc},
						},
					},
				},
			}
		}
		payloadJSON, _ := json.Marshal(payload)
		result, err := doJSONRequest("POST", baseURL+"/issue", headers, bytes.NewReader(payloadJSON))
		if err != nil {
			return nil, fmt.Errorf("Jira create_issue failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Jira action: %s (supported: list_issues, create_issue)", action)
	}
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

func executeHubSpot(config map[string]any, action string, params map[string]any) (any, error) {
	token, _ := config["accessToken"].(string)
	if token == "" {
		token, _ = config["token"].(string)
	}
	if token == "" {
		token, _ = config["apiKey"].(string)
	}
	if token == "" {
		token, _ = config["oauth_access_token"].(string)
	}
	if token == "" {
		return nil, fmt.Errorf("missing HubSpot access token. Provide 'accessToken' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"Content-Type":  "application/json",
	}

	switch action {
	case "list_contacts":
		limit := intParam(params, "limit", 10)
		apiURL := fmt.Sprintf("https://api.hubapi.com/crm/v3/objects/contacts?limit=%d", limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("HubSpot list_contacts failed: %w", err)
		}
		return result, nil

	case "list_deals":
		limit := intParam(params, "limit", 10)
		apiURL := fmt.Sprintf("https://api.hubapi.com/crm/v3/objects/deals?limit=%d", limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("HubSpot list_deals failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown HubSpot action: %s (supported: list_contacts, list_deals)", action)
	}
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

func executeStripe(config map[string]any, action string, params map[string]any) (any, error) {
	secretKey, _ := config["secretKey"].(string)
	if secretKey == "" {
		secretKey, _ = config["apiKey"].(string)
	}
	if secretKey == "" {
		secretKey, _ = config["token"].(string)
	}
	if secretKey == "" {
		return nil, fmt.Errorf("missing Stripe secret key. Provide 'secretKey' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + secretKey,
	}

	switch action {
	case "list_charges":
		limit := intParam(params, "limit", 10)
		apiURL := fmt.Sprintf("https://api.stripe.com/v1/charges?limit=%d", limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Stripe list_charges failed: %w", err)
		}
		return result, nil

	case "list_customers":
		limit := intParam(params, "limit", 10)
		apiURL := fmt.Sprintf("https://api.stripe.com/v1/customers?limit=%d", limit)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Stripe list_customers failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Stripe action: %s (supported: list_charges, list_customers)", action)
	}
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

func executeSentry(config map[string]any, action string, params map[string]any) (any, error) {
	token, _ := config["authToken"].(string)
	if token == "" {
		token, _ = config["token"].(string)
	}
	if token == "" {
		token, _ = config["accessToken"].(string)
	}
	if token == "" {
		return nil, fmt.Errorf("missing Sentry auth token. Provide 'authToken' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	switch action {
	case "list_issues":
		org := stringParam(params, "organization")
		project := stringParam(params, "project")
		if org == "" {
			return nil, fmt.Errorf("'organization' parameter is required")
		}
		apiURL := fmt.Sprintf("https://sentry.io/api/0/projects/%s/%s/issues/", url.PathEscape(org), url.PathEscape(project))
		if project == "" {
			// List issues across all projects in the org.
			apiURL = fmt.Sprintf("https://sentry.io/api/0/organizations/%s/issues/", url.PathEscape(org))
		}
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Sentry list_issues failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Sentry action: %s (supported: list_issues)", action)
	}
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

func executeVercel(config map[string]any, action string, params map[string]any) (any, error) {
	token, _ := config["token"].(string)
	if token == "" {
		token, _ = config["accessToken"].(string)
	}
	if token == "" {
		token, _ = config["apiToken"].(string)
	}
	if token == "" {
		return nil, fmt.Errorf("missing Vercel token. Provide 'token' in connector config")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + token,
	}

	switch action {
	case "list_projects":
		limit := intParam(params, "limit", 20)
		apiURL := fmt.Sprintf("https://api.vercel.com/v9/projects?limit=%d", limit)
		if teamID := stringParam(params, "teamId"); teamID != "" {
			apiURL += "&teamId=" + url.QueryEscape(teamID)
		}
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Vercel list_projects failed: %w", err)
		}
		return result, nil

	case "list_deployments":
		limit := intParam(params, "limit", 20)
		apiURL := fmt.Sprintf("https://api.vercel.com/v6/deployments?limit=%d", limit)
		if projectID := stringParam(params, "projectId"); projectID != "" {
			apiURL += "&projectId=" + url.QueryEscape(projectID)
		}
		if teamID := stringParam(params, "teamId"); teamID != "" {
			apiURL += "&teamId=" + url.QueryEscape(teamID)
		}
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Vercel list_deployments failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Vercel action: %s (supported: list_projects, list_deployments)", action)
	}
}

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

func executeSalesforce(config map[string]any, action string, params map[string]any) (any, error) {
	accessToken, _ := config["accessToken"].(string)
	if accessToken == "" {
		accessToken, _ = config["oauth_access_token"].(string)
	}
	instanceURL, _ := config["instanceUrl"].(string)
	if instanceURL == "" {
		instanceURL, _ = config["instance_url"].(string)
	}
	if instanceURL == "" {
		instanceURL, _ = config["oauth_instance_url"].(string)
	}

	if accessToken == "" || instanceURL == "" {
		return nil, fmt.Errorf("missing Salesforce credentials. Provide 'accessToken' and 'instanceUrl' in connector config (or connect via OAuth)")
	}

	// Strip trailing slash from instance URL.
	instanceURL = strings.TrimRight(instanceURL, "/")

	headers := map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Accept":        "application/json",
	}

	switch action {
	case "query":
		soql := stringParam(params, "q")
		if soql == "" {
			soql = stringParam(params, "query")
		}
		if soql == "" {
			return nil, fmt.Errorf("'q' (SOQL query) parameter is required")
		}
		apiURL := fmt.Sprintf("%s/services/data/v59.0/query?q=%s", instanceURL, url.QueryEscape(soql))
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Salesforce query failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Salesforce action: %s (supported: query)", action)
	}
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

func executeGoogleCalendar(config map[string]any, action string, params map[string]any) (any, error) {
	accessToken, _ := config["accessToken"].(string)
	if accessToken == "" {
		accessToken, _ = config["oauth_access_token"].(string)
	}
	if accessToken == "" {
		return nil, fmt.Errorf("Google Calendar requires OAuth. Connect via the OAuth flow on the Connectors page")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Accept":        "application/json",
	}

	switch action {
	case "list_events":
		calendarID := stringParam(params, "calendarId")
		if calendarID == "" {
			calendarID = "primary"
		}
		limit := intParam(params, "limit", 10)
		timeMin := stringParam(params, "timeMin")
		if timeMin == "" {
			timeMin = time.Now().Format(time.RFC3339)
		}
		apiURL := fmt.Sprintf(
			"https://www.googleapis.com/calendar/v3/calendars/%s/events?maxResults=%d&timeMin=%s&singleEvents=true&orderBy=startTime",
			url.PathEscape(calendarID), limit, url.QueryEscape(timeMin),
		)
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Google Calendar list_events failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Google Calendar action: %s (supported: list_events)", action)
	}
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

func executeGoogleDrive(config map[string]any, action string, params map[string]any) (any, error) {
	accessToken, _ := config["accessToken"].(string)
	if accessToken == "" {
		accessToken, _ = config["oauth_access_token"].(string)
	}
	if accessToken == "" {
		return nil, fmt.Errorf("Google Drive requires OAuth. Connect via the OAuth flow on the Connectors page")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Accept":        "application/json",
	}

	switch action {
	case "list_files":
		limit := intParam(params, "limit", 10)
		query := stringParam(params, "query")
		apiURL := fmt.Sprintf("https://www.googleapis.com/drive/v3/files?pageSize=%d&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)", limit)
		if query != "" {
			apiURL += "&q=" + url.QueryEscape(query)
		}
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Google Drive list_files failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Google Drive action: %s (supported: list_files)", action)
	}
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

func executeGoogleSheets(config map[string]any, action string, params map[string]any) (any, error) {
	accessToken, _ := config["accessToken"].(string)
	if accessToken == "" {
		accessToken, _ = config["oauth_access_token"].(string)
	}
	if accessToken == "" {
		return nil, fmt.Errorf("Google Sheets requires OAuth. Connect via the OAuth flow on the Connectors page")
	}

	headers := map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Accept":        "application/json",
	}

	switch action {
	case "get_spreadsheet":
		spreadsheetID := stringParam(params, "spreadsheetId")
		if spreadsheetID == "" {
			return nil, fmt.Errorf("'spreadsheetId' parameter is required")
		}
		apiURL := fmt.Sprintf("https://sheets.googleapis.com/v4/spreadsheets/%s", url.PathEscape(spreadsheetID))
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Google Sheets get_spreadsheet failed: %w", err)
		}
		return result, nil

	case "get_values":
		spreadsheetID := stringParam(params, "spreadsheetId")
		rangeStr := stringParam(params, "range")
		if spreadsheetID == "" || rangeStr == "" {
			return nil, fmt.Errorf("'spreadsheetId' and 'range' parameters are required")
		}
		apiURL := fmt.Sprintf("https://sheets.googleapis.com/v4/spreadsheets/%s/values/%s",
			url.PathEscape(spreadsheetID), url.PathEscape(rangeStr))
		result, err := doJSONRequest("GET", apiURL, headers, nil)
		if err != nil {
			return nil, fmt.Errorf("Google Sheets get_values failed: %w", err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown Google Sheets action: %s (supported: get_spreadsheet, get_values)", action)
	}
}
