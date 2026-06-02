package handlers

import (
	"regexp"
	"strings"
)

// Outbound guard for the contact-facing messaging lane (RCS/SMS via Twilio).
//
// The rich persona/escalation/allow-list layer lives in the TS bridges; this is
// a Go port of the highest-stakes safety check — the reasoning-leak / bot-tell
// suppression from packages/bridge-core/src/natural.ts (detectBotTells). It
// keeps the model's internal deliberation, no-reply placeholders, and AI
// self-identification from ever reaching a contact. Deliberately a subset; the
// full pipeline is the bridges'. Kept in sync by mirroring those patterns.

// bareNoReplyDrafts: when the WHOLE draft is one of these placeholders, the
// model meant "stay silent" but typed the token instead of returning empty.
var bareNoReplyDrafts = map[string]bool{
	"empty": true, "empty string": true, "empty reply": true, "empty response": true,
	"none": true, "n/a": true, "na": true, "null": true, "undefined": true, "nil": true,
	"skip": true, "skipped": true, "silent": true, "stay silent": true,
	"no reply": true, "no response": true, "no reply needed": true,
	"nothing": true, "nothing to add": true, "nothing new to add": true,
	"pass": true, "ignore": true,
}

var reasoningLeakPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bempty\s+string\b`),
	regexp.MustCompile(`(?i)\bthe\s+(contact|sender|recipient)\b`),
	regexp.MustCompile(`(?i)\bno(thing)?\b[^.!?\n]{0,30}\b(needs?|need|requires?|warrants?|merits?)\b[^.!?\n]{0,15}\b(a\s+)?(reply|response|answer)\b`),
	regexp.MustCompile(`(?i)\bno\s+(reply|response|answer)\s+(is\s+)?(needed|required|necessary|warranted)\b`),
	regexp.MustCompile(`(?i)\b(a\s+(real|normal)\s+(person|human)|real\s+people|most\s+people|a\s+human)\b[^.!?\n]{0,40}\b(wouldn'?t|would\s+not|won'?t|will\s+not|doesn'?t|don'?t|do\s+not)\b[^.!?\n]{0,25}\b(respond|reply|answer|say|text)\b`),
	regexp.MustCompile(`(?i)\bi('?ve|\s+have)?\s+already\s+(answered|replied|responded|said|told)\b`),
	regexp.MustCompile(`(?i)\bnothing\s+(new\s+|else\s+|more\s+)?to\s+(add|say)\b`),
	regexp.MustCompile(`(?i)\b(as\s+an\s+(ai|assistant|language\s+model)|i\s+am\s+an?\s+(ai|assistant|language\s+model))\b`),
}

// shouldSendOutbound reports whether a drafted reply is safe to send to a
// contact. Returns (false, reason) when it's empty, a bare no-reply token, or a
// reasoning/AI-identity leak — in which case the lane stays silent.
func shouldSendOutbound(draft string) (bool, string) {
	text := strings.TrimSpace(draft)
	if text == "" {
		return false, "empty draft"
	}
	bare := strings.ToLower(strings.Trim(text, " \"'`([{<*_~.!?:;,)]}>"))
	if bareNoReplyDrafts[bare] {
		return false, "bare no-reply token"
	}
	for _, re := range reasoningLeakPatterns {
		if re.MatchString(text) {
			return false, "reasoning/AI-identity leak"
		}
	}
	return true, ""
}
