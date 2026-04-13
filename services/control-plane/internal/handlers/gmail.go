package handlers

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// GmailMessage represents a simplified email message.
type GmailMessage struct {
	From    string `json:"from"`
	Subject string `json:"subject"`
	Snippet string `json:"snippet"`
	Date    string `json:"date"`
	Body    string `json:"body"`
}

// FetchGmailMessages fetches recent emails using the Gmail API with an OAuth
// access token. If credentials are empty it returns an error.
func FetchGmailMessages(email, appPassword string, maxResults int) ([]GmailMessage, error) {
	if appPassword == "" && email == "" {
		return nil, fmt.Errorf("no Gmail credentials configured")
	}

	// Placeholder: in production this would use the stored OAuth token from
	// connector_installs.
	messages := []GmailMessage{
		{
			From:    "No emails fetched",
			Subject: "Gmail connector needs OAuth token",
			Snippet: "Connect Gmail via OAuth to fetch real emails",
			Date:    time.Now().Format(time.RFC3339),
		},
	}

	return messages, nil
}

// FetchGmailViaAPI uses the Gmail API with an OAuth access token to fetch
// recent unread emails.
func FetchGmailViaAPI(accessToken string, maxResults int) ([]GmailMessage, error) {
	if accessToken == "" {
		return nil, fmt.Errorf("no access token")
	}

	// List messages.
	query := url.QueryEscape("newer_than:1d")
	listURL := fmt.Sprintf(
		"https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=%d&q=%s",
		maxResults, query,
	)
	req, err := http.NewRequest("GET", listURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build list request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Gmail API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("Gmail API error %d: %s", resp.StatusCode, string(body))
	}

	var listResp struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("decode list response: %w", err)
	}

	var messages []GmailMessage
	for _, m := range listResp.Messages {
		if len(messages) >= maxResults {
			break
		}

		// Fetch each message's metadata.
		msgURL := fmt.Sprintf(
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/%s?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
			m.ID,
		)
		msgReq, err := http.NewRequest("GET", msgURL, nil)
		if err != nil {
			continue
		}
		msgReq.Header.Set("Authorization", "Bearer "+accessToken)

		msgResp, err := http.DefaultClient.Do(msgReq)
		if err != nil {
			continue
		}

		var msgData struct {
			Snippet string `json:"snippet"`
			Payload struct {
				Headers []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"headers"`
			} `json:"payload"`
		}
		if err := json.NewDecoder(msgResp.Body).Decode(&msgData); err != nil {
			msgResp.Body.Close()
			continue
		}
		msgResp.Body.Close()

		msg := GmailMessage{Snippet: msgData.Snippet}
		for _, h := range msgData.Payload.Headers {
			switch h.Name {
			case "From":
				msg.From = h.Value
			case "Subject":
				msg.Subject = h.Value
			case "Date":
				msg.Date = h.Value
			}
		}
		messages = append(messages, msg)
	}

	return messages, nil
}

// FetchGmailViaIMAP connects to Gmail's IMAP server using email + app password
// and fetches recent messages. This is the fallback when OAuth is not available.
func FetchGmailViaIMAP(email, appPassword string, maxResults int) ([]GmailMessage, error) {
	// Connect to Gmail IMAP
	addr := "imap.gmail.com:993"
	conn, err := tls.Dial("tcp", addr, &tls.Config{})
	if err != nil {
		return nil, fmt.Errorf("connect to IMAP: %w", err)
	}
	defer conn.Close()

	reader := bufio.NewReader(conn)

	// Read greeting
	readLine(reader)

	// Login
	sendCommand(conn, fmt.Sprintf("A001 LOGIN %s %s", email, appPassword))
	loginResp := readLine(reader)
	if !strings.Contains(loginResp, "OK") {
		return nil, fmt.Errorf("IMAP login failed: %s", loginResp)
	}
	// Consume any extra lines from LOGIN
	for strings.HasPrefix(peekLine(reader), "*") {
		readLine(reader)
	}

	// Select INBOX
	sendCommand(conn, "A002 SELECT INBOX")
	var totalMessages int
	for {
		line := readLine(reader)
		if strings.Contains(line, "EXISTS") {
			fmt.Sscanf(line, "* %d EXISTS", &totalMessages)
		}
		if strings.HasPrefix(line, "A002") {
			break
		}
	}

	if totalMessages == 0 {
		sendCommand(conn, "A099 LOGOUT")
		return []GmailMessage{}, nil
	}

	// Fetch the last N messages (headers only)
	start := totalMessages - maxResults + 1
	if start < 1 {
		start = 1
	}
	fetchCmd := fmt.Sprintf("A003 FETCH %d:%d (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])", start, totalMessages)
	sendCommand(conn, fetchCmd)

	var messages []GmailMessage
	var currentMsg *GmailMessage

	for {
		line := readLine(reader)
		if strings.HasPrefix(line, "A003") {
			break
		}
		if line == "" {
			continue
		}

		lowerLine := strings.ToLower(line)
		if strings.HasPrefix(lowerLine, "from: ") {
			if currentMsg != nil {
				messages = append(messages, *currentMsg)
			}
			currentMsg = &GmailMessage{From: strings.TrimPrefix(line, "From: ")}
		} else if strings.HasPrefix(lowerLine, "subject: ") && currentMsg != nil {
			currentMsg.Subject = strings.TrimPrefix(line, "Subject: ")
		} else if strings.HasPrefix(lowerLine, "date: ") && currentMsg != nil {
			currentMsg.Date = strings.TrimPrefix(line, "Date: ")
		} else if currentMsg != nil && currentMsg.Snippet == "" && len(line) > 5 && !strings.HasPrefix(line, "*") && !strings.HasPrefix(line, ")") {
			// First non-header, non-empty line is the snippet
			snippet := line
			if len(snippet) > 200 {
				snippet = snippet[:200]
			}
			currentMsg.Snippet = snippet
		}
	}
	if currentMsg != nil {
		messages = append(messages, *currentMsg)
	}

	// Logout
	sendCommand(conn, "A099 LOGOUT")

	// Reverse so newest is first
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	if len(messages) > maxResults {
		messages = messages[:maxResults]
	}

	return messages, nil
}

func sendCommand(conn net.Conn, cmd string) {
	conn.Write([]byte(cmd + "\r\n"))
}

func readLine(reader *bufio.Reader) string {
	line, _ := reader.ReadString('\n')
	return strings.TrimRight(line, "\r\n")
}

func peekLine(reader *bufio.Reader) string {
	bytes, _ := reader.Peek(1)
	if len(bytes) == 0 {
		return ""
	}
	return string(bytes)
}

// ---------- Gmail REST handler ----------

// GmailHandler provides a REST endpoint to fetch Gmail messages for the
// authenticated tenant using stored OAuth credentials.
type GmailHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewGmailHandler creates a new GmailHandler.
func NewGmailHandler(srv *server.Server, auth *AuthHandler) *GmailHandler {
	return &GmailHandler{srv: srv, auth: auth}
}

func (h *GmailHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("gmail")
}

// GetMessages handles GET /v1/connectors/gmail/messages?limit=20.
// It looks up the Gmail OAuth token from connector_installs and fetches
// messages via the Gmail API.
func (h *GmailHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	tenantID := claims.TenantID
	ctx := r.Context()

	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	// Try to get the OAuth access token from connector_installs.
	var accessToken string

	// First check oauth_token_encrypted (set by OAuth flow).
	var oauthTokenJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT oauth_token_encrypted
		FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
	`, tenantID).Scan(&oauthTokenJSON)
	if err == nil && len(oauthTokenJSON) > 0 {
		var tokenData map[string]any
		if jsonErr := json.Unmarshal(oauthTokenJSON, &tokenData); jsonErr == nil {
			if at, ok := tokenData["access_token"].(string); ok {
				accessToken = at
			}
		}
	}

	// Fall back to config->>'accessToken' (set by manual install).
	if accessToken == "" {
		_ = h.srv.Pool.QueryRow(ctx, `
			SELECT config->>'accessToken'
			FROM connector_installs
			WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
		`, tenantID).Scan(&accessToken)
	}

	// Fall back to config->>'email' + config->>'appPassword' for IMAP mode.
	if accessToken == "" {
		var email, appPassword string
		_ = h.srv.Pool.QueryRow(ctx, `
			SELECT config->>'email', config->>'appPassword'
			FROM connector_installs
			WHERE tenant_id = $1 AND connector_id = 'gmail' AND status = 'connected'
		`, tenantID).Scan(&email, &appPassword)

		if email != "" && appPassword != "" {
			messages, fetchErr := FetchGmailViaIMAP(email, appPassword, limit)
			if fetchErr != nil {
				h.logger().Warn("IMAP fetch failed", zap.Error(fetchErr))
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("IMAP fetch failed: %v", fetchErr)})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "count": len(messages), "source": "imap"})
			return
		}
	}

	if accessToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Gmail connector is not installed or has no valid access token. Connect Gmail first.",
		})
		return
	}

	messages, fetchErr := FetchGmailViaAPI(accessToken, limit)
	if fetchErr != nil {
		h.logger().Warn("Gmail fetch failed", zap.Error(fetchErr), zap.String("tenant", tenantID))
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("Failed to fetch Gmail messages: %s", fetchErr.Error()),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"messages": messages,
		"count":    len(messages),
	})
}
