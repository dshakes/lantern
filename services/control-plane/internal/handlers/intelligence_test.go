package handlers

// Unit tests for intelligence.go — G1, G3, G4.
//
// All three features are pure functions (no I/O, no DB). Tests cover:
//   - G1: classifyTurnComplexity tier mapping; resolveModelForComplexity
//         picks the right tier model; explicit hint wins.
//   - G3: rewriteUnbackedClaims softens "I emailed her" (no backing tool)
//         but leaves "I sent the message" alone when send_message ran.
//   - G4: isMultiStep detects multi-step patterns; injectPlannerIfNeeded
//         modifies the system message and is a no-op when flag is off.

import (
	"strings"
	"testing"

	"go.uber.org/zap"
)

// ---------------------------------------------------------------------------
// G1 — classifyTurnComplexity
// ---------------------------------------------------------------------------

func msgs(system, user string) []map[string]any {
	return []map[string]any{
		{"role": "system", "content": system},
		{"role": "user", "content": user},
	}
}

func TestClassifyTurnComplexity_ExplicitHintTrivial(t *testing.T) {
	tier := classifyTurnComplexity(msgs("", "schedule a meeting with the team and then send them the agenda"), false, "trivial")
	if tier != tierTrivial {
		t.Errorf("explicit hint=trivial must win, got tier=%d", tier)
	}
}

func TestClassifyTurnComplexity_ExplicitHintHard(t *testing.T) {
	tier := classifyTurnComplexity(msgs("", "hi"), false, "hard")
	if tier != tierHard {
		t.Errorf("explicit hint=hard must win, got tier=%d", tier)
	}
}

func TestClassifyTurnComplexity_ShortGreeting_Trivial(t *testing.T) {
	for _, msg := range []string{"hi", "ok", "thanks", "sure"} {
		tier := classifyTurnComplexity(msgs("", msg), false, "")
		if tier != tierTrivial {
			t.Errorf("short greeting %q should be trivial, got tier=%d", msg, tier)
		}
	}
}

func TestClassifyTurnComplexity_VeryShortNoKeywords_Trivial(t *testing.T) {
	tier := classifyTurnComplexity(msgs("", "got it"), false, "")
	if tier != tierTrivial {
		t.Errorf("'got it' (short, no hard keywords, no tools) should be trivial, got %d", tier)
	}
}

func TestClassifyTurnComplexity_MultiKeyword_Hard(t *testing.T) {
	// 3+ hard keywords → tier hard
	user := "Please analyze the difference between the two options and recommend a strategy for the team"
	tier := classifyTurnComplexity(msgs("", user), false, "")
	if tier != tierHard {
		t.Errorf("multi-keyword long turn should be hard, got tier=%d", tier)
	}
}

func TestClassifyTurnComplexity_SchedulingWithTools_Hard(t *testing.T) {
	// scheduling keyword + tools in play + 2 keywords → hard
	user := "Schedule a meeting and compare the calendar availability"
	tier := classifyTurnComplexity(msgs("", user), true /* hasTools */, "")
	if tier != tierHard {
		t.Errorf("scheduling + tools should be hard, got tier=%d", tier)
	}
}

func TestClassifyTurnComplexity_MultipleQuestions_Hard(t *testing.T) {
	user := "What time is the meeting? And can you also check if I have any conflicts? I need to know asap."
	tier := classifyTurnComplexity(msgs("", user), false, "")
	if tier != tierHard {
		t.Errorf("multiple questions in a long turn should be hard, got tier=%d", tier)
	}
}

func TestClassifyTurnComplexity_NormalTurn_Balanced(t *testing.T) {
	// A regular conversational turn — no hard signals, not trivially short.
	user := "Can you tell me what's on my schedule today?"
	tier := classifyTurnComplexity(msgs("", user), false, "")
	// Could be balanced or hard (one keyword "schedule") — not trivial.
	if tier == tierTrivial {
		t.Errorf("schedule question should not be trivial, got tier=%d", tier)
	}
}

// ---------------------------------------------------------------------------
// G1 — resolveModelForComplexity
// ---------------------------------------------------------------------------

func TestResolveModelForComplexity_TrivialPrefersHaiku(t *testing.T) {
	provider, model := resolveModelForComplexity(tierTrivial, true, true)
	if provider != "anthropic" || !strings.Contains(model, "haiku") {
		t.Errorf("trivial tier with Anthropic should pick haiku, got %s/%s", provider, model)
	}
}

func TestResolveModelForComplexity_TrivialFallsToMini(t *testing.T) {
	provider, model := resolveModelForComplexity(tierTrivial, false, true)
	if provider != "openai" || model != "gpt-4o-mini" {
		t.Errorf("trivial tier without Anthropic should pick gpt-4o-mini, got %s/%s", provider, model)
	}
}

func TestResolveModelForComplexity_HardPrefersOpus(t *testing.T) {
	provider, model := resolveModelForComplexity(tierHard, true, true)
	if provider != "anthropic" || !strings.Contains(model, "opus") {
		t.Errorf("hard tier with Anthropic should pick opus, got %s/%s", provider, model)
	}
}

func TestResolveModelForComplexity_HardFallsToGPT4o(t *testing.T) {
	provider, model := resolveModelForComplexity(tierHard, false, true)
	if provider != "openai" || model != "gpt-4o" {
		t.Errorf("hard tier without Anthropic should fall to gpt-4o, got %s/%s", provider, model)
	}
}

func TestResolveModelForComplexity_BalancedDelegatesToScorer(t *testing.T) {
	// balanced tier should return a valid provider (delegates to resolveAutoModel).
	provider, model := resolveModelForComplexity(tierBalanced, true, false)
	if provider == "" || model == "" {
		t.Errorf("balanced tier should always return a model, got %s/%s", provider, model)
	}
}

// ---------------------------------------------------------------------------
// G3 — rewriteUnbackedClaims
// ---------------------------------------------------------------------------

var testLogger = zap.NewNop()

func TestRewriteUnbackedClaims_Disabled(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "0")
	text := "I sent the email to your colleague."
	got := rewriteUnbackedClaims(text, nil, testLogger)
	if got != text {
		t.Errorf("when disabled, text must pass through unchanged; got %q", got)
	}
}

func TestRewriteUnbackedClaims_UnbackedEmailSoftened(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	// No tool invocations — "I emailed her" has no backing.
	text := "I emailed her about the meeting."
	got := rewriteUnbackedClaims(text, nil, testLogger)
	if strings.Contains(got, "I emailed") {
		t.Errorf("unbacked 'I emailed' should be softened; got %q", got)
	}
	if !strings.Contains(got, "I'll email") {
		t.Errorf("unbacked claim should become 'I'll email'; got %q", got)
	}
}

func TestRewriteUnbackedClaims_BackedSendKept(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	// A successful send_message tool ran — "I sent" is backed.
	invocations := []ToolInvocation{
		{Name: "send_message", Result: map[string]any{"ok": true}},
	}
	text := "I sent the message to your contact."
	got := rewriteUnbackedClaims(text, invocations, testLogger)
	if got != text {
		t.Errorf("backed 'I sent' should not be rewritten; got %q", got)
	}
}

func TestRewriteUnbackedClaims_FailedToolDoesNotBack(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	// Tool ran but errored — does NOT count as backing.
	invocations := []ToolInvocation{
		{Name: "send_email", Error: "network timeout"},
	}
	text := "I emailed the file over."
	got := rewriteUnbackedClaims(text, invocations, testLogger)
	if strings.Contains(got, "I emailed") {
		t.Errorf("failed tool should not back the claim; got %q", got)
	}
}

func TestRewriteUnbackedClaims_BackedBookingKept(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	invocations := []ToolInvocation{
		{Name: "create_event", Result: map[string]any{"id": "evt_1"}},
	}
	text := "I booked the meeting for 3pm."
	got := rewriteUnbackedClaims(text, invocations, testLogger)
	if got != text {
		t.Errorf("backed 'I booked' should not be rewritten; got %q", got)
	}
}

func TestRewriteUnbackedClaims_UnbackedBookingSoftened(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	text := "I booked the table for you."
	got := rewriteUnbackedClaims(text, nil, testLogger)
	if strings.Contains(got, "I booked") {
		t.Errorf("unbacked 'I booked' should be softened; got %q", got)
	}
}

func TestRewriteUnbackedClaims_TextWithNoClaimsUnchanged(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	text := "Here is a summary of your inbox: you have 3 unread emails."
	got := rewriteUnbackedClaims(text, nil, testLogger)
	if got != text {
		t.Errorf("text without action claims should be unchanged; got %q", got)
	}
}

// ---------------------------------------------------------------------------
// G4 — isMultiStep / injectPlannerIfNeeded
// ---------------------------------------------------------------------------

func TestIsMultiStep_Connective(t *testing.T) {
	m := msgs("", "Send an email to Alice and then book a meeting with her for Friday.")
	if !isMultiStep(m) {
		t.Error("'and then' connective should be detected as multi-step")
	}
}

func TestIsMultiStep_MultipleQuestions(t *testing.T) {
	m := msgs("", "What time is my next meeting? Also, can you check my emails?")
	if !isMultiStep(m) {
		t.Error("two questions should be detected as multi-step")
	}
}

func TestIsMultiStep_Ordinal(t *testing.T) {
	m := msgs("", "1. Check my calendar 2. Email Bob about Tuesday")
	if !isMultiStep(m) {
		t.Error("ordinal markers should be detected as multi-step")
	}
}

func TestIsMultiStep_SingleSimpleRequest(t *testing.T) {
	m := msgs("", "What time is it in Tokyo?")
	if isMultiStep(m) {
		t.Error("single simple question should NOT be detected as multi-step")
	}
}

func TestIsMultiStep_PleaseLongAnd(t *testing.T) {
	m := msgs("", "Could you please draft a reply to John's email and also update the meeting notes with the action items we discussed?")
	if !isMultiStep(m) {
		t.Error("'please … and …' long turn should be detected as multi-step")
	}
}

func TestInjectPlannerIfNeeded_DisabledNoOp(t *testing.T) {
	t.Setenv("LANTERN_MULTI_STEP_PLANNER", "0")
	in := msgs("You are a helpful assistant.", "Send an email and then book a meeting.")
	out := injectPlannerIfNeeded(in)
	sys, _ := out[0]["content"].(string)
	if strings.Contains(sys, "Planning mode") {
		t.Error("planner should be no-op when disabled")
	}
}

func TestInjectPlannerIfNeeded_EnabledMultiStep(t *testing.T) {
	t.Setenv("LANTERN_MULTI_STEP_PLANNER", "1")
	in := msgs("You are a helpful assistant.", "Send an email and then book a meeting.")
	out := injectPlannerIfNeeded(in)
	sys, _ := out[0]["content"].(string)
	if !strings.Contains(sys, "Planning mode") {
		t.Errorf("planner should inject instruction for multi-step turn; system=%q", sys)
	}
}

func TestInjectPlannerIfNeeded_EnabledSingleStep_NoOp(t *testing.T) {
	t.Setenv("LANTERN_MULTI_STEP_PLANNER", "1")
	in := msgs("You are a helpful assistant.", "What time is it in London?")
	out := injectPlannerIfNeeded(in)
	sys, _ := out[0]["content"].(string)
	if strings.Contains(sys, "Planning mode") {
		t.Error("planner should not inject for a single-step turn")
	}
}

func TestInjectPlannerIfNeeded_DoesNotMutateOriginal(t *testing.T) {
	t.Setenv("LANTERN_MULTI_STEP_PLANNER", "1")
	in := msgs("Original system prompt.", "Send an email and then update the calendar entry.")
	orig := in[0]["content"].(string)
	_ = injectPlannerIfNeeded(in)
	if in[0]["content"].(string) != orig {
		t.Error("injectPlannerIfNeeded must not mutate the original messages slice")
	}
}

func TestInjectPlannerIfNeeded_NoSystemMessage(t *testing.T) {
	t.Setenv("LANTERN_MULTI_STEP_PLANNER", "1")
	// No system message — planner should prepend one.
	in := []map[string]any{
		{"role": "user", "content": "Please send the report and then book a follow-up meeting."},
	}
	out := injectPlannerIfNeeded(in)
	if len(out) < 2 {
		t.Fatal("expected a system message to be prepended")
	}
	if out[0]["role"] != "system" {
		t.Errorf("prepended message should have role=system, got %v", out[0]["role"])
	}
	sys, _ := out[0]["content"].(string)
	if !strings.Contains(sys, "Planning mode") {
		t.Errorf("prepended system should contain planning instruction, got %q", sys)
	}
}
