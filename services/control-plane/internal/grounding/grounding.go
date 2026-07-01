// Package grounding implements the G3 claim-verifier guard: any
// completed-action assertion in an LLM reply ("I sent", "I booked", …)
// that has no backing successful tool invocation is softened to honest
// intent ("I'll send", "I'll book", …).
//
// Gate: LANTERN_CLAIM_VERIFY (default ON — empty string is NOT disabled).
// See internal/handlers/intelligence.go for the thin handler-layer wrapper
// that converts []ToolInvocation → map[string]bool and logs each rewrite.
package grounding

import (
	"os"
	"regexp"
	"strings"
)

// Enabled reports whether the G3 claim-verify guard is active.
// Reads LANTERN_CLAIM_VERIFY on every call so ops can toggle without restart.
// Default is ON (empty / absent env var → enabled).
func Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_CLAIM_VERIFY"))) {
	case "0", "off", "false":
		return false
	}
	return true
}

// completionVerbCategories maps a completed-action verb (lower-case) to the
// category strings that would legitimately back it via a tool name substring
// match. A claim is "backed" when at least one successful tool invocation
// (no error) has a name containing one of the category strings.
var completionVerbCategories = map[string][]string{
	// Communication
	"sent":      {"send_message", "send_email", "send_sms", "gmail_send", "slack_send", "message", "send"},
	"emailed":   {"send_email", "gmail_send", "email", "send"},
	"texted":    {"send_sms", "send_message", "sms", "send"},
	"messaged":  {"send_message", "slack_send", "message", "send"},
	"replied":   {"send_message", "send_email", "reply", "send"},
	"forwarded": {"send_email", "forward", "send"},
	// Calendar / scheduling
	"booked":     {"create_event", "book", "calendar", "schedule"},
	"scheduled":  {"create_event", "schedule", "calendar"},
	"added":      {"create_event", "add", "calendar", "create"},
	"created":    {"create_event", "create", "calendar", "add"},
	"set":        {"create_event", "set", "calendar", "create"},
	"registered": {"register", "create"},
	// Notes / Tasks
	"saved":   {"save", "create_note", "notes", "create"},
	"updated": {"update", "edit"},
	"deleted": {"delete", "remove"},
	// Calls
	"called":  {"make_call", "call", "phone"},
	"dialed":  {"make_call", "dial", "phone"},
	"ordered": {"order", "create", "purchase"},
	"paid":    {"pay", "charge", "payment"},
}

// claimPattern matches phrases like "I sent", "I've emailed", "I already
// booked", "I just scheduled", "I went ahead and called", etc.
var claimPattern = regexp.MustCompile(
	`(?i)\b(i(?:'ve|'m| have| just| already| went ahead and|'ll|'d)?\s+` +
		`(sent|emailed|texted|messaged|replied|forwarded|booked|scheduled|added|` +
		`created|set|registered|saved|updated|deleted|called|dialed|ordered|paid))\b`,
)

// softReplacements maps an asserted-past verb to an honest-intent phrase.
var softReplacements = map[string]string{
	"sent":       "I'll send",
	"emailed":    "I'll email",
	"texted":     "I'll text",
	"messaged":   "I'll message",
	"replied":    "I'll reply",
	"forwarded":  "I'll forward",
	"booked":     "I'll book",
	"scheduled":  "I'll schedule",
	"added":      "I'll add",
	"created":    "I'll create",
	"set":        "I'll set",
	"registered": "I'll register",
	"saved":      "I'll save",
	"updated":    "I'll update",
	"deleted":    "I'll delete",
	"called":     "I'll call",
	"dialed":     "I'll dial",
	"ordered":    "I'll order",
	"paid":       "I'll pay",
}

// isBackedVerb returns true when at least one entry in performed matches
// (by name-contains category) one of the backing categories for verb.
// performed: lower-cased successful tool name → true (only successful tools
// should be present; callers omit failed invocations).
func isBackedVerb(verb string, performed map[string]bool) bool {
	cats, ok := completionVerbCategories[verb]
	if !ok {
		return true // unknown verb — leave it alone
	}
	for toolName := range performed {
		for _, cat := range cats {
			if strings.Contains(toolName, cat) {
				return true
			}
		}
	}
	return false
}

// RewriteActions scans reply for completed-action assertions and softens any
// whose verb has no backing entry in performed. performed maps lower-cased
// successful tool name → true; nil/empty means no tools ran this turn.
//
// Returns (possibly rewritten text, human-readable list of "original → rewritten"
// pairs for logging). Returns (reply, nil) unchanged when Enabled() is false.
func RewriteActions(reply string, performed map[string]bool) (string, []string) {
	if !Enabled() {
		return reply, nil
	}
	var rewrites []string
	out := claimPattern.ReplaceAllStringFunc(reply, func(match string) string {
		sub := claimPattern.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		verb := strings.ToLower(sub[2])
		if isBackedVerb(verb, performed) {
			return match // legitimately backed — keep it
		}
		soft, ok := softReplacements[verb]
		if !ok {
			return match
		}
		rewritten := strings.Replace(match, sub[1], soft, 1)
		rewrites = append(rewrites, match+" → "+rewritten)
		return rewritten
	})
	return out, rewrites
}

// HasUnbackedClaims reports whether text contains any completed-action
// assertion not backed by the performed set. Unlike RewriteActions, this
// function always runs regardless of Enabled(), because callers (the eval
// grounded assert) have explicitly opted in at the test-case level.
//
// performed: lower-cased successful tool name → true; nil means no tools ran.
//
// TODO: add an LLM-judge dimension for semantic groundedness (e.g. assert a
// required source substring appears in the output). Keep deterministic for now.
func HasUnbackedClaims(text string, performed map[string]bool) bool {
	found := false
	claimPattern.ReplaceAllStringFunc(text, func(match string) string {
		if found {
			return match // already found — skip remaining work
		}
		sub := claimPattern.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		verb := strings.ToLower(sub[2])
		if isBackedVerb(verb, performed) {
			return match
		}
		if _, ok := softReplacements[verb]; ok {
			found = true
		}
		return match
	})
	return found
}
