package handlers

// Unit tests for the read-only Gmail `list_recent` action added for the
// life-event email poller. These exercise the validation branches that do NOT
// require a live Gmail API call (no OAuth token, unknown-action message) — the
// happy path requires a real access token and is covered by the bridge-side
// poller tests with a mocked connector.

import (
	"strings"
	"testing"
)

// list_recent without an OAuth access token must fail closed with a clear
// re-auth hint — the poller relies on this string to detect the expired/missing
// token case and surface a single "re-auth Google" warning.
func TestExecuteGmail_ListRecent_RequiresOAuth(t *testing.T) {
	cfg := map[string]any{} // no accessToken, no email/appPassword
	_, err := executeGmail(cfg, "list_recent", map[string]any{"query": "newer_than:1d"})
	if err == nil {
		t.Fatal("expected an error when no OAuth token is configured")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "oauth access token") {
		t.Fatalf("error should mention the missing OAuth token, got: %v", err)
	}
}

// The unknown-action error message must advertise list_recent so the action is
// discoverable.
func TestExecuteGmail_UnknownAction_ListsListRecent(t *testing.T) {
	cfg := map[string]any{"accessToken": "x"}
	_, err := executeGmail(cfg, "definitely_not_an_action", nil)
	if err == nil {
		t.Fatal("expected an error for an unknown action")
	}
	if !strings.Contains(err.Error(), "list_recent") {
		t.Fatalf("unknown-action error should advertise list_recent, got: %v", err)
	}
}

// ListRecentGmailViaAPI must reject an empty token before making any network
// call (fail-closed, no panic).
func TestListRecentGmailViaAPI_EmptyToken(t *testing.T) {
	_, err := ListRecentGmailViaAPI("", "newer_than:1d", 10)
	if err == nil {
		t.Fatal("expected an error for an empty access token")
	}
}
