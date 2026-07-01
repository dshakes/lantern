package handlers

// Personal-docs LLM tools. Built-in (always available — not gated by
// connector_installs), proxied over loopback to the bridge process
// running on the user's Mac. The bridge owns the actual file access:
// path-restricted to LANTERN_PERSONAL_DOCS_ROOTS, audit-logged, and
// reachable only via 127.0.0.1 + bridge token.
//
// Replaces the old regex pre-deciders in the bridge
// (`looksLikeDocQuery`, `looksLikeOwnerQuestion`, etc.). The LLM now
// decides WHEN to search local files — same indirection model already
// used for Gmail/Calendar tools — instead of the bridge guessing from
// query shape.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	// Tool names. Underscore (not __) because these aren't dispatched
	// through executeConnectorAction — they have their own dispatch
	// branch in dispatchTool that bypasses the connector_installs gate.
	personalDocsSearchTool      = "search_personal_files"
	personalDocsReadTool        = "read_personal_file"
	imessageHistorySearchTool   = "search_imessage_history"
	whatsappHistorySearchTool   = "search_whatsapp_history"
	imessageGroupsListTool      = "list_imessage_groups"
	imessageGroupMembersTool    = "get_imessage_group"
	whatsappGroupsListTool      = "list_whatsapp_groups"
	whatsappGroupMembersTool    = "get_whatsapp_group"
	whatsappHistoryBackfillTool = "backfill_whatsapp_history"
	readCalendarTool            = "read_calendar"
	searchContactsTool          = "search_contacts"

	// Default bridge URLs (loopback). Override via env.
	personalDocsBridgeDefaultURL = "http://127.0.0.1:3200" // iMessage bridge
	whatsappBridgeDefaultURL     = "http://127.0.0.1:3100" // WhatsApp bridge

	// Caps that protect both bridge resources and LLM context. The
	// bridge enforces the same limits server-side; these are belt-and-
	// suspenders.
	personalDocsMaxQueryChars         = 500
	personalDocsMaxPathChars          = 2048
	personalDocsRequestTimeoutSeconds = 90 // OCR-backed reads can take 30s+
)

// personalDocsTools returns the built-in tool definitions in OpenAI
// tool-call format. Called from toolsForTenant().
func personalDocsTools() []map[string]any {
	return []map[string]any{
		{
			"type": "function",
			"function": map[string]any{
				"name": searchContactsTool,
				"description": "Look up a person in the user's macOS Contacts (address book) by name, nickname, or organization. " +
					"Returns each match's full name plus ALL their phone numbers and email addresses. " +
					"Use this whenever you need someone's phone number or email — to call them, text them, draft an email, or answer 'what's X's number/email'. " +
					"Don't guess a contact's details; call this.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{
							"type":        "string",
							"description": "Name / nickname / company to search, e.g. 'Mae', 'Sam', 'Hammer and Nails'.",
						},
						"limit": map[string]any{
							"type":        "integer",
							"description": "Max contacts to return (default 8, max 25).",
						},
					},
					"required": []string{"query"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name": readCalendarTool,
				"description": "Query the user's DEVICE calendar (macOS Calendar.app — aggregates iCloud + Google + subscribed). SOURCE OF TRUTH for appointments and the only place that sees iCloud-only events. " +
					"ALWAYS call this for ANY appointment/event/schedule question (haircut, salon, doctor, dentist, dinner, flight, 'what do I have', 'when is my next/last ...') — even without the word 'appointment'. " +
					"Supports PAST and future: pass `query` to filter by title keyword and `from`/`to` (ISO dates) for a window. " +
					"For 'HOW MANY TIMES did I go to X' or 'when did I LAST go to X', pass query=X (it auto-searches ~2 years back) and COUNT the returned events. " +
					"Returns events with title, start, end, calendar. Never say the user has no such event without calling this first. " +
					"For appointment CONFIRMATIONS that may have arrived by text (e.g. a salon SMS) rather than the calendar, ALSO call search_imessage_history / search_whatsapp_history with the same keyword and combine.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{
							"type":        "string",
							"description": "Optional title keyword to filter by, e.g. 'Hammer and Nails', 'dentist'. With no from/to, a query auto-searches ~2 years back through 1 year ahead.",
						},
						"from": map[string]any{
							"type":        "string",
							"description": "Optional window start, ISO date e.g. '2025-01-01'. Use for explicit historical ranges.",
						},
						"to": map[string]any{
							"type":        "string",
							"description": "Optional window end, ISO date.",
						},
						"days": map[string]any{
							"type":        "integer",
							"description": "Forward-only window in days (default 60, max 180). Ignored if query or from/to is set.",
						},
					},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name": personalDocsSearchTool,
				"description": "Search the user's local files (Documents, Desktop, iCloud Drive on their Mac) by keyword/phrase. " +
					"Returns up to 8 best-matching files with path, name, size, modified time, and a snippet. " +
					"Use this BEFORE answering any question about the user's personal documents, IDs, passport, license, " +
					"green card, I-485, receipts, taxes, invoices, contracts, prescriptions, etc. " +
					"Then call read_personal_file on the best match to read its content.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{
							"type":        "string",
							"description": "Keywords to search for, e.g. 'I-485 approval', 'passport', 'driver license'. Be specific.",
						},
						"limit": map[string]any{
							"type":        "integer",
							"description": "Max results to return (default 8, max 25).",
						},
					},
					"required": []string{"query"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name": personalDocsReadTool,
				"description": "Read the full text content of a single local file by its absolute path. " +
					"PDFs and images are OCR'd. Returns the extracted text (truncated for very long files). " +
					"You MUST first call search_personal_files to discover the path — do not invent paths.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"path": map[string]any{
							"type":        "string",
							"description": "Absolute path to the file (from search_personal_files results).",
						},
					},
					"required": []string{"path"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name": imessageHistorySearchTool,
				"description": "Search the user's iMessage history (chat.db on their Mac — has YEARS of messages, both DMs and group chats). " +
					"Filter by keyword, date range (Unix milliseconds), specific contact handle, or group-only. " +
					"Returns up to 25 messages with timestamp, sender, group/DM context, and text. " +
					"USE THIS when a question references a past period ('during my Turkey trip', 'last summer', 'when I was in NYC'), " +
					"a person's recent chats, or anything that lived in messaging. " +
					"For date ranges, ALWAYS pair with other sources (gmail_search, search_personal_files) for the FULL picture.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"keyword":   map[string]any{"type": "string", "description": "Substring match on message text. Optional."},
						"sinceMs":   map[string]any{"type": "integer", "description": "Unix milliseconds (inclusive). Optional."},
						"untilMs":   map[string]any{"type": "integer", "description": "Unix milliseconds (inclusive). Optional."},
						"handle":    map[string]any{"type": "string", "description": "Exact contact handle (phone or email). Optional."},
						"groupOnly": map[string]any{"type": "boolean", "description": "Only return group-chat messages. Optional."},
						"limit":     map[string]any{"type": "integer", "description": "Max results (default 25, max 50)."},
					},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        imessageGroupsListTool,
				"description": "List ALL iMessage group chats the user is in (multi-participant chats) with their display name, chat row id, and participant count. Use this FIRST when the user asks about a 'trip', 'family group', 'friends', or anyone-multi-person context — find the group, then call get_imessage_group for the members.",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        imessageGroupMembersTool,
				"description": "Get the full member list (handles) of an iMessage group chat. Look it up by chatRowid OR by group-name (case-insensitive substring match). Use after list_imessage_groups to confirm WHO is in the group.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"chatRowid": map[string]any{"type": "integer", "description": "Group chat row id from list_imessage_groups. Either this OR `name` is required."},
						"name":      map[string]any{"type": "string", "description": "Case-insensitive substring of the group name. Either this OR `chatRowid` is required."},
					},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        whatsappGroupsListTool,
				"description": "List ALL WhatsApp groups the user is in with their name, JID, and participant count. Use this FIRST when the user asks about a 'trip group', 'family chat', any multi-person WhatsApp context. Then call get_whatsapp_group for the members.",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        whatsappGroupMembersTool,
				"description": "Get the full member list (with names where known + admin status) of a WhatsApp group. Look up by JID OR by group-name (case-insensitive substring match). This is how you answer 'who's in the X group' or 'who came to the trip' questions.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"jid":  map[string]any{"type": "string", "description": "WhatsApp group JID (from list_whatsapp_groups). Either this OR `name` is required."},
						"name": map[string]any{"type": "string", "description": "Case-insensitive substring of the group name. Either this OR `jid` is required."},
					},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        whatsappHistoryBackfillTool,
				"description": "Ask WhatsApp to deliver OLDER history for a specific group/chat. Use this when search_whatsapp_history returns nothing for the date range the user asked about — the bridge only auto-captures messages going forward, so older ones need an explicit fetch. Requires at least ONE existing message in the chat as an anchor. Returns a requestId; results stream into the history log within seconds and become searchable via search_whatsapp_history.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"jid":   map[string]any{"type": "string", "description": "WhatsApp group/chat JID (from list_whatsapp_groups). Required."},
						"count": map[string]any{"type": "integer", "description": "How many older messages to request (default 50, max 500)."},
					},
					"required": []string{"jid"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name": whatsappHistorySearchTool,
				"description": "Search the user's WhatsApp message history (the bridge logs all messages going forward). " +
					"Filter by keyword, date range (Unix milliseconds), specific JID, sender-name substring, or group-only. " +
					"Returns up to 25 messages with timestamp, sender, group/DM context, and text. " +
					"USE THIS when the user references something said in a WhatsApp group/DM, especially for date-range " +
					"questions ('during my Turkey trip', 'last weekend'). " +
					"For the FULL picture combine with search_imessage_history and gmail_search.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"keyword":     map[string]any{"type": "string", "description": "Substring match on message text. Optional."},
						"sinceMs":     map[string]any{"type": "integer", "description": "Unix milliseconds (inclusive). Optional."},
						"untilMs":     map[string]any{"type": "integer", "description": "Unix milliseconds (inclusive). Optional."},
						"jid":         map[string]any{"type": "string", "description": "Exact WhatsApp JID. Optional."},
						"groupOnly":   map[string]any{"type": "boolean", "description": "Only return group messages. Optional."},
						"fromContact": map[string]any{"type": "string", "description": "Case-insensitive substring on sender name (e.g. 'harika'). Optional."},
						"limit":       map[string]any{"type": "integer", "description": "Max results (default 25, max 50)."},
					},
				},
			},
		},
	}
}

// docTextCap bounds the raw doc text threaded to the bridge (a few KB is
// plenty for id/date re-extraction; caps prompt/PII exposure over the wire).
const docTextCap = 8000

// docTextFromToolResult returns the raw extracted document text from a
// read_personal_file tool result — the id ground truth the bridge uses to
// re-extract document numbers VERBATIM (the LLM's reply routinely corrupts
// O/0, 1/l). Returns "" for any other tool, an errored/started invocation, or
// a result without string content. Bounded to docTextCap. Never logged (PII —
// invariant #10).
func docTextFromToolResult(inv ToolInvocation) string {
	if inv.Name != personalDocsReadTool || inv.Result == nil {
		return ""
	}
	m, ok := inv.Result.(map[string]any)
	if !ok {
		return ""
	}
	// Bridge returned ok=false (extraction failed / path blocked) → no content.
	if okv, present := m["ok"].(bool); present && !okv {
		return ""
	}
	c, _ := m["content"].(string)
	if len(c) > docTextCap {
		c = c[:docTextCap]
	}
	return c
}

// isPersonalDocsTool returns true when `name` is one of the built-in
// bridge-proxied tools (personal-docs, iMessage history, WhatsApp
// history). Used by dispatchTool to branch before the
// connector-install gate.
func isPersonalDocsTool(name string) bool {
	switch name {
	case personalDocsSearchTool, personalDocsReadTool,
		imessageHistorySearchTool, whatsappHistorySearchTool,
		imessageGroupsListTool, imessageGroupMembersTool,
		whatsappGroupsListTool, whatsappGroupMembersTool,
		whatsappHistoryBackfillTool, readCalendarTool, searchContactsTool:
		return true
	}
	return false
}

// executePersonalDocsTool proxies the call to the bridge running on the
// user's Mac. Bridge URL configurable via LANTERN_PERSONAL_DOCS_BRIDGE_URL
// (default http://127.0.0.1:3200, the iMessage bridge port). Auth via
// LANTERN_IMESSAGE_BRIDGE_TOKEN / LANTERN_BRIDGE_TOKEN.
func executePersonalDocsTool(ctx context.Context, tenantID, name string, params map[string]any) (any, error) {
	base := strings.TrimRight(os.Getenv("LANTERN_PERSONAL_DOCS_BRIDGE_URL"), "/")
	if base == "" {
		base = personalDocsBridgeDefaultURL
	}
	// Either bridge token works — both are 127.0.0.1-bound and run on the
	// same Mac under the same trust boundary. Prefer the iMessage token
	// (default bridge for personal-docs) and fall back to the WhatsApp
	// bridge token.
	token := os.Getenv("LANTERN_IMESSAGE_BRIDGE_TOKEN")
	if token == "" {
		token = os.Getenv("LANTERN_BRIDGE_TOKEN")
	}

	if tenantID == "" {
		return nil, errors.New("personal-docs tool: tenant_id required")
	}

	// WhatsApp history searches go to the WhatsApp bridge (default
	// :3100), everything else to the iMessage bridge (default :3200).
	waBase := strings.TrimRight(os.Getenv("LANTERN_WHATSAPP_BRIDGE_URL"), "/")
	if waBase == "" {
		waBase = whatsappBridgeDefaultURL
	}

	var endpoint string
	body := map[string]any{}
	switch name {
	case personalDocsSearchTool:
		query, _ := params["query"].(string)
		query = strings.TrimSpace(query)
		if query == "" {
			return nil, errors.New("search_personal_files: 'query' is required")
		}
		if len(query) > personalDocsMaxQueryChars {
			return nil, fmt.Errorf("search_personal_files: 'query' too long (max %d chars)", personalDocsMaxQueryChars)
		}
		body["query"] = query
		if l, ok := params["limit"].(float64); ok && l > 0 {
			body["limit"] = int(l)
		}
		endpoint = fmt.Sprintf("%s/session/%s/personal-docs/search", base, tenantID)
	case personalDocsReadTool:
		path, _ := params["path"].(string)
		path = strings.TrimSpace(path)
		if path == "" {
			return nil, errors.New("read_personal_file: 'path' is required")
		}
		if len(path) > personalDocsMaxPathChars {
			return nil, fmt.Errorf("read_personal_file: 'path' too long (max %d chars)", personalDocsMaxPathChars)
		}
		body["path"] = path
		endpoint = fmt.Sprintf("%s/session/%s/personal-docs/read", base, tenantID)
	case imessageHistorySearchTool:
		// All filters optional — bridge handles the empty case.
		if v, ok := params["keyword"].(string); ok && strings.TrimSpace(v) != "" {
			body["keyword"] = strings.TrimSpace(v)
		}
		if v, ok := params["sinceMs"].(float64); ok {
			body["sinceMs"] = int64(v)
		}
		if v, ok := params["untilMs"].(float64); ok {
			body["untilMs"] = int64(v)
		}
		if v, ok := params["handle"].(string); ok && strings.TrimSpace(v) != "" {
			body["handle"] = strings.TrimSpace(v)
		}
		if v, ok := params["groupOnly"].(bool); ok {
			body["groupOnly"] = v
		}
		if v, ok := params["limit"].(float64); ok && v > 0 {
			body["limit"] = int(v)
		}
		endpoint = fmt.Sprintf("%s/session/%s/imessage/search", base, tenantID)
	case whatsappHistorySearchTool:
		if v, ok := params["keyword"].(string); ok && strings.TrimSpace(v) != "" {
			body["keyword"] = strings.TrimSpace(v)
		}
		if v, ok := params["sinceMs"].(float64); ok {
			body["sinceMs"] = int64(v)
		}
		if v, ok := params["untilMs"].(float64); ok {
			body["untilMs"] = int64(v)
		}
		if v, ok := params["jid"].(string); ok && strings.TrimSpace(v) != "" {
			body["jid"] = strings.TrimSpace(v)
		}
		if v, ok := params["groupOnly"].(bool); ok {
			body["groupOnly"] = v
		}
		if v, ok := params["fromContact"].(string); ok && strings.TrimSpace(v) != "" {
			body["fromContact"] = strings.TrimSpace(v)
		}
		if v, ok := params["limit"].(float64); ok && v > 0 {
			body["limit"] = int(v)
		}
		endpoint = fmt.Sprintf("%s/session/%s/whatsapp/search", waBase, tenantID)
	case imessageGroupsListTool:
		endpoint = fmt.Sprintf("%s/session/%s/imessage/groups", base, tenantID)
	case imessageGroupMembersTool:
		if v, ok := params["chatRowid"].(float64); ok {
			body["chatRowid"] = int(v)
		}
		if v, ok := params["name"].(string); ok && strings.TrimSpace(v) != "" {
			body["name"] = strings.TrimSpace(v)
		}
		endpoint = fmt.Sprintf("%s/session/%s/imessage/group", base, tenantID)
	case whatsappGroupsListTool:
		endpoint = fmt.Sprintf("%s/session/%s/whatsapp/groups", waBase, tenantID)
	case whatsappGroupMembersTool:
		if v, ok := params["jid"].(string); ok && strings.TrimSpace(v) != "" {
			body["jid"] = strings.TrimSpace(v)
		}
		if v, ok := params["name"].(string); ok && strings.TrimSpace(v) != "" {
			body["name"] = strings.TrimSpace(v)
		}
		endpoint = fmt.Sprintf("%s/session/%s/whatsapp/group", waBase, tenantID)
	case whatsappHistoryBackfillTool:
		jid, _ := params["jid"].(string)
		jid = strings.TrimSpace(jid)
		if jid == "" {
			return nil, errors.New("backfill_whatsapp_history: 'jid' is required")
		}
		body["jid"] = jid
		if v, ok := params["count"].(float64); ok && v > 0 {
			body["count"] = int(v)
		}
		endpoint = fmt.Sprintf("%s/session/%s/whatsapp/history/backfill", waBase, tenantID)
	case readCalendarTool:
		if v, ok := params["days"].(float64); ok && v > 0 {
			body["days"] = int(v)
		}
		if q, ok := params["query"].(string); ok && q != "" {
			body["query"] = q
		}
		if f, ok := params["from"].(string); ok && f != "" {
			body["fromIso"] = f
		}
		if t, ok := params["to"].(string); ok && t != "" {
			body["toIso"] = t
		}
		endpoint = fmt.Sprintf("%s/session/%s/calendar/upcoming", base, tenantID)
	case searchContactsTool:
		q, _ := params["query"].(string)
		if q == "" {
			return nil, errors.New("search_contacts: 'query' is required")
		}
		body["query"] = q
		if v, ok := params["limit"].(float64); ok && v > 0 {
			body["limit"] = int(v)
		}
		endpoint = fmt.Sprintf("%s/session/%s/contacts/search", base, tenantID)
	default:
		return nil, fmt.Errorf("personal-docs tool: unknown name %q", name)
	}

	// List-tools are GET (no body). Member-fetch and search are POST.
	isGet := name == imessageGroupsListTool || name == whatsappGroupsListTool
	httpMethod := http.MethodPost
	var payload []byte
	if isGet {
		httpMethod = http.MethodGet
	} else {
		var merr error
		payload, merr = json.Marshal(body)
		if merr != nil {
			return nil, fmt.Errorf("personal-docs tool: marshal: %w", merr)
		}
	}

	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(personalDocsRequestTimeoutSeconds)*time.Second)
	defer cancel()

	var bodyReader *bytes.Reader
	if payload != nil {
		bodyReader = bytes.NewReader(payload)
	} else {
		bodyReader = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(reqCtx, httpMethod, endpoint, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("personal-docs tool: build request: %w", err)
	}
	if !isGet {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	client := &http.Client{Timeout: time.Duration(personalDocsRequestTimeoutSeconds) * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		// Bridge unreachable — surface a clear message to the LLM so it
		// can either retry or tell the user. Don't crash the run.
		return map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("personal-docs bridge unreachable at %s: %v", base, err),
		}, nil
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		// Bridge returned a structured error (e.g. 403 path-not-allowed,
		// 404 not-found, 422 extraction-failed). Pass it back to the LLM
		// verbatim — the model can adapt (try a different path, ask the
		// user, etc.) instead of the run failing.
		var errBody map[string]any
		if jerr := json.Unmarshal(raw, &errBody); jerr == nil {
			errBody["ok"] = false
			errBody["status"] = resp.StatusCode
			return errBody, nil
		}
		return map[string]any{
			"ok":     false,
			"status": resp.StatusCode,
			"error":  strings.TrimSpace(string(raw)),
		}, nil
	}

	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("personal-docs tool: decode response: %w", err)
	}
	out["ok"] = true
	return out, nil
}
