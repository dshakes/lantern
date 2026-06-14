package handlers

// intelligence.go — server-side turn intelligence upgrades.
//
// G1: Complexity-aware model routing. "auto" turns are classified into
//     trivial/balanced/hard tiers and routed to a cheaper or frontier model
//     accordingly. Gate: LANTERN_COMPLEXITY_ROUTING=1.
//
// G3: Claim verifier. After the tool loop, any "I sent/emailed/booked/…"
//     assertion not backed by an actual tool invocation is softened to honest
//     intent. Gate: LANTERN_CLAIM_VERIFY=1.
//
// G4: Lightweight multi-step planner. When a turn looks multi-step, a short
//     planning instruction is prepended to the system context so the model
//     outlines steps before gambling through tool calls. Gate:
//     LANTERN_MULTI_STEP_PLANNER=1.
//
// Every gate defaults OFF so existing behaviour is the safe fallback. Flags
// are read on each call (no startup cache) so ops can toggle without a restart.

import (
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"go.uber.org/zap"
)

// ---------------------------------------------------------------------------
// G1 — Complexity classifier
// ---------------------------------------------------------------------------

// turnTier is the three-way routing tier produced by classifyTurnComplexity.
type turnTier int

const (
	tierBalanced turnTier = iota // default balanced model (current behaviour)
	tierTrivial                  // cheap/fast model
	tierHard                     // frontier reasoning model
)

// classifyTurnComplexity scores the turn and returns a routing tier.
//
// Signals (in roughly descending importance):
//  1. Explicit hint from the caller via X-Lantern-Turn-Hint header / hint arg.
//  2. Hard content: scheduling + reasoning keyword density.
//  3. Total token estimate (byte length / 4 as a proxy).
//  4. Whether tools are in play (multi-step turns).
//  5. Multiple clauses / "and … and …" structures indicating multi-constraint.
//
// The classifier is cheap (pure string work, <10µs) so it can run on every
// bridge turn without measurable latency.
func classifyTurnComplexity(messages []map[string]any, hasTools bool, hint string) turnTier {
	// Explicit hint wins immediately.
	switch strings.ToLower(strings.TrimSpace(hint)) {
	case "trivial":
		return tierTrivial
	case "hard", "reasoning", "frontier":
		return tierHard
	case "balanced", "quality":
		// Hard floor at the balanced model — never downgrade to the trivial
		// (cheap/weak) tier. Used by the personal-chat bridges so the owner's
		// outgoing texts are never drafted by the weakest model, even when the
		// inbound is short. Does not force the frontier tier (cost), just keeps
		// it off the floor.
		return tierBalanced
	}

	// Collect text from the most-recent user message (and system) only.
	// Avoid re-scoring the whole history — the new user turn is what matters.
	var lastUser, system string
	for _, m := range messages {
		role, _ := m["role"].(string)
		content, _ := m["content"].(string)
		switch role {
		case "user":
			lastUser = content // last one wins
		case "system":
			system = content
		}
	}
	combined := strings.ToLower(lastUser + " " + system)
	chars := utf8.RuneCountInString(lastUser)

	// ---- Hard signals -------------------------------------------------------
	hardKeywords := []string{
		// scheduling / calendar
		"schedule", "appointment", "meeting", "calendar", "reminder",
		"when is", "what time",
		// sensitive / document
		"passport", "license", "ssn", "social security", "medical",
		"confidential", "private",
		// multi-entity reasoning
		"compare", "difference between", "pros and cons",
		"analyze", "analyse", "summarize", "summarise",
		"strategy", "plan", "recommend",
		// coding / debugging
		"debug", "refactor", "implement", "algorithm",
		// multi-constraint patterns
		"and then", "after that", "followed by", "first.*then",
		"multiple", "several", "list of", "all of",
	}
	hardCount := 0
	for _, kw := range hardKeywords {
		if strings.Contains(combined, kw) {
			hardCount++
		}
	}

	// Multiple question marks or complex sentence structure.
	questions := strings.Count(combined, "?")
	commas := strings.Count(combined, ",") + strings.Count(combined, ";")

	// ---- Trivial signals ----------------------------------------------------
	trivialKeywords := []string{
		"hi", "hello", "hey", "thanks", "thank you", "ok", "okay",
		"yes", "no", "sure", "got it", "great", "cool",
		"what's up", "whats up",
	}
	trivialCount := 0
	for _, kw := range trivialKeywords {
		if combined == kw || strings.HasPrefix(combined, kw+" ") ||
			strings.HasSuffix(combined, " "+kw) || combined == strings.TrimSpace(kw) {
			trivialCount++
		}
	}

	// ---- Scoring ------------------------------------------------------------
	// Hard tier:
	//   • Any hard keyword + long turn (>300 chars), OR
	//   • 3+ hard keywords, OR
	//   • tools in play + 2+ hard keywords, OR
	//   • multiple questions + long turn.
	if hardCount >= 3 {
		return tierHard
	}
	if hasTools && hardCount >= 2 {
		return tierHard
	}
	if hardCount >= 1 && chars > 300 {
		return tierHard
	}
	if questions >= 2 && chars > 60 {
		return tierHard
	}
	if commas >= 4 && chars > 100 {
		return tierHard
	}

	// Trivial tier:
	//   • Very short turn (≤40 chars) with no hard signals and no tools, OR
	//   • Explicit trivial keyword match.
	if trivialCount > 0 && !hasTools && hardCount == 0 {
		return tierTrivial
	}
	if chars <= 40 && !hasTools && hardCount == 0 {
		return tierTrivial
	}

	return tierBalanced
}

// isFlagDisabled returns true when the env value is one of the recognised
// "off" strings: "0", "off", "false". Default (empty) is NOT disabled, so
// these flags remain default-on.
func isFlagDisabled(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "off", "false":
		return true
	}
	return false
}

// complexityRoutingEnabled reports whether G1 is active.
func complexityRoutingEnabled() bool {
	return !isFlagDisabled(os.Getenv("LANTERN_COMPLEXITY_ROUTING"))
}

// resolveModelForComplexity returns the (provider, model) pair appropriate
// for the given tier, constrained to what the tenant has configured.
// Falls back to the balanced model when the frontier/small model's provider
// is not available.
func resolveModelForComplexity(tier turnTier, hasAnthropic, hasOpenAI bool) (string, string) {
	switch tier {
	case tierTrivial:
		// Cheap/fast: haiku > gpt-4o-mini. Pick whichever is available.
		if hasAnthropic {
			return "anthropic", haikuModel()
		}
		if hasOpenAI {
			return "openai", "gpt-4o-mini"
		}
	case tierHard:
		// Frontier: opus > gpt-4o (no o3 by default — expensive). Fall
		// back gracefully when not available.
		if hasAnthropic {
			return "anthropic", opusModel()
		}
		if hasOpenAI {
			return "openai", "gpt-4o"
		}
	}
	// tierBalanced or no provider match — use the normal scorer.
	return resolveAutoModel(hasAnthropic, hasOpenAI)
}

// ---------------------------------------------------------------------------
// G3 — Claim verifier
// ---------------------------------------------------------------------------

// claimVerifyEnabled reports whether G3 is active.
func claimVerifyEnabled() bool {
	return !isFlagDisabled(os.Getenv("LANTERN_CLAIM_VERIFY"))
}

// completionVerbs maps a completed-action verb (lower-case) to the category
// of tool that would legitimately back it. A claim is "backed" when at least
// one successful (non-error) invocation of a tool in that category ran this
// turn.
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

// claimPattern matches phrases like "I sent", "I've emailed", "I already booked",
// "I just scheduled", etc.
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

// isBacked returns true when at least one successful tool invocation matches
// (by name substring) one of the backing categories for the given verb.
func isBacked(verb string, invocations []ToolInvocation) bool {
	cats, ok := completionVerbCategories[strings.ToLower(verb)]
	if !ok {
		return true // unknown verb — don't touch it
	}
	for _, inv := range invocations {
		if inv.Error != "" {
			continue // failed invocations don't count as backing
		}
		toolLower := strings.ToLower(inv.Name)
		for _, cat := range cats {
			if strings.Contains(toolLower, cat) {
				return true
			}
		}
	}
	return false
}

// rewriteUnbackedClaims scans the assistant reply for completed-action
// assertions and softens any that have no backing tool invocation. The
// original text is returned unchanged when G3 is disabled or when every
// claim is backed. Rewrites are logged at Warn level.
func rewriteUnbackedClaims(text string, invocations []ToolInvocation, log *zap.Logger) string {
	if !claimVerifyEnabled() {
		return text
	}

	result := claimPattern.ReplaceAllStringFunc(text, func(match string) string {
		// Extract the verb from the match (the second capture group).
		sub := claimPattern.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		verb := strings.ToLower(sub[2])
		if isBacked(verb, invocations) {
			return match // legitimately backed — keep it
		}
		soft, ok := softReplacements[verb]
		if !ok {
			return match
		}
		// Replace the full matched phrase preserving surrounding text.
		rewritten := strings.Replace(match, sub[1], soft, 1)
		log.Warn("claim-verifier: softened unbacked claim",
			zap.String("original", match),
			zap.String("rewritten", rewritten),
		)
		return rewritten
	})
	return result
}

// ---------------------------------------------------------------------------
// G4 — Multi-step planner
// ---------------------------------------------------------------------------

// plannerEnabled reports whether G4 is active.
func plannerEnabled() bool {
	return !isFlagDisabled(os.Getenv("LANTERN_MULTI_STEP_PLANNER"))
}

// plannerInstruction is the minimal system-level hint injected when a turn
// looks multi-step. Kept short to minimise prompt bloat.
const plannerInstruction = "\n\n[Planning mode] This request has multiple steps. Before calling any tools, briefly outline the steps you will take, then execute them in order, then synthesize the final answer."

// isMultiStep reports whether a turn looks like it contains multiple
// distinct asks that warrant a planning step.
//
// Heuristics (OR logic — any one is sufficient):
//  1. "and then" / "after that" / "followed by" connectives.
//  2. Multiple question marks in the last user message.
//  3. Explicit ordinals: "first … then …" / "1. … 2. …".
//  4. Comma-separated distinct entities with a verb (e.g. "book X, email Y").
func isMultiStep(messages []map[string]any) bool {
	var lastUser string
	for _, m := range messages {
		if role, _ := m["role"].(string); role == "user" {
			if s, _ := m["content"].(string); s != "" {
				lastUser = s
			}
		}
	}
	if lastUser == "" {
		return false
	}
	lower := strings.ToLower(lastUser)

	// Connective phrases.
	connectives := []string{
		"and then", "after that", "followed by", "once you've",
		"once that's done", "then also", "also please", "as well as",
	}
	for _, c := range connectives {
		if strings.Contains(lower, c) {
			return true
		}
	}

	// Multiple question marks.
	if strings.Count(lastUser, "?") >= 2 {
		return true
	}

	// Ordinal markers.
	ordinals := []string{"first, ", "first,\n", "1.", "1) ", "step 1", "(1)"}
	for _, o := range ordinals {
		if strings.Contains(lower, o) {
			return true
		}
	}

	// "please … and …" pattern with a second verb.
	if strings.Contains(lower, " and ") &&
		(strings.Contains(lower, "please") || strings.Contains(lower, "could you") || strings.Contains(lower, "can you")) &&
		utf8.RuneCountInString(lastUser) > 80 {
		return true
	}

	return false
}

// injectPlannerIfNeeded prepends the planning instruction to the system
// message in the provided slice when G4 is enabled and the turn looks
// multi-step. Returns a (possibly new) slice; the original is not mutated.
func injectPlannerIfNeeded(messages []map[string]any) []map[string]any {
	if !plannerEnabled() {
		return messages
	}
	if !isMultiStep(messages) {
		return messages
	}
	// Copy the slice so we don't mutate the caller's slice.
	out := make([]map[string]any, len(messages))
	copy(out, messages)
	injected := false
	for i, m := range out {
		if role, _ := m["role"].(string); role == "system" {
			content, _ := m["content"].(string)
			// Shallow-copy the map so we don't stomp the caller's map.
			nm := make(map[string]any, len(m))
			for k, v := range m {
				nm[k] = v
			}
			nm["content"] = content + plannerInstruction
			out[i] = nm
			injected = true
			break
		}
	}
	if !injected {
		// No system message — prepend one.
		newSlice := make([]map[string]any, 0, len(out)+1)
		newSlice = append(newSlice, map[string]any{
			"role":    "system",
			"content": strings.TrimLeft(plannerInstruction, "\n"),
		})
		newSlice = append(newSlice, out...)
		return newSlice
	}
	return out
}
