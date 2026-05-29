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
	personalDocsSearchTool = "search_personal_files"
	personalDocsReadTool   = "read_personal_file"

	// Tenant ID is included in the URL path because the bridge keys its
	// PersonalDocs instance + audit log per tenant.
	personalDocsBridgeDefaultURL = "http://127.0.0.1:3200"

	// Caps that protect both bridge resources and LLM context. The
	// bridge enforces the same limits server-side; these are belt-and-
	// suspenders.
	personalDocsMaxQueryChars         = 500
	personalDocsMaxPathChars          = 2048
	personalDocsRequestTimeoutSeconds = 90 // OCR-backed reads can take 30s+
)

// personalDocsTools returns the two built-in tool definitions in
// OpenAI tool-call format. Called from toolsForTenant().
func personalDocsTools() []map[string]any {
	return []map[string]any{
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
	}
}

// isPersonalDocsTool returns true when `name` is one of the built-in
// personal-docs tools. Used by dispatchTool to branch before the
// connector-install gate.
func isPersonalDocsTool(name string) bool {
	return name == personalDocsSearchTool || name == personalDocsReadTool
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
	default:
		return nil, fmt.Errorf("personal-docs tool: unknown name %q", name)
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("personal-docs tool: marshal: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(personalDocsRequestTimeoutSeconds)*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("personal-docs tool: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
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
