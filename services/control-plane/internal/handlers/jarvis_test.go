package handlers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBriefChannel(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	h := &JarvisHandler{}

	t.Setenv("LANTERN_JARVIS_BRIEF_CHANNEL", "")
	if got := h.briefChannel(); got != "" {
		t.Errorf("no env/file → want empty, got %q", got)
	}
	t.Setenv("LANTERN_JARVIS_BRIEF_CHANNEL", "email")
	if got := h.briefChannel(); got != "email" {
		t.Errorf("env only → want email, got %q", got)
	}
	// Runtime override file wins over env (and is trimmed + lowercased).
	if err := os.MkdirAll(filepath.Join(tmp, ".lantern"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".lantern", "brief-channel"), []byte(" SMS\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := h.briefChannel(); got != "sms" {
		t.Errorf("file override → want sms, got %q", got)
	}
}

// With no LLM configured, phraseBrief must still return useful output:
// a status line when empty, and the raw assembled sections otherwise.

func TestPhraseBriefEmpty(t *testing.T) {
	h := &JarvisHandler{} // llm nil
	got := h.phraseBrief(context.Background(), "t", nil, nil, nil, nil)
	if !strings.Contains(strings.ToLower(got), "nothing on the radar") {
		t.Errorf("empty brief should be a clear status line, got %q", got)
	}
}

func TestPhraseBriefFallback(t *testing.T) {
	h := &JarvisHandler{} // llm nil → structured fallback, no network
	got := h.phraseBrief(context.Background(), "t",
		[]string{"Standup 9am"},
		[]briefEmail{{From: "Bob", Content: "invoice attached"}},
		[]briefReply{{Person: "Madhu", Content: "lunch friday?"}},
		nil,
	)
	for _, want := range []string{"UPCOMING", "Standup 9am", "AWAITING YOUR REPLY", "Madhu", "RECENT EMAIL", "Bob"} {
		if !strings.Contains(got, want) {
			t.Errorf("fallback brief missing %q\n---\n%s", want, got)
		}
	}
}

func TestEmbedConcurrency(t *testing.T) {
	cases := map[string]int{
		"":    4, // default
		"8":   8,
		"1":   1,
		"32":  32,
		"0":   4, // below range → default
		"999": 4, // above range → default
		"abc": 4, // non-numeric → default
	}
	for env, want := range cases {
		t.Setenv("LANTERN_EMBED_CONCURRENCY", env)
		if got := embedConcurrency(); got != want {
			t.Errorf("embedConcurrency() with env %q = %d, want %d", env, got, want)
		}
	}
}

func TestStripAssistantPreamble(t *testing.T) {
	cases := map[string]string{
		"This is a writing task, not a coding task. Let me write it.\n\n---\n\nYou're mostly clear.": "You're mostly clear.",
		"Let me help.\nReal line one.\nReal line two.":                                               "Real line one.\nReal line two.",
		"Clean output already.":                  "Clean output already.",
		"Here's the brief:\n\nupcoming: standup": "upcoming: standup",
		"":                                       "",
	}
	for in, want := range cases {
		if got := stripAssistantPreamble(in); got != want {
			t.Errorf("stripAssistantPreamble(%q) = %q, want %q", in, got, want)
		}
	}
}

// Commitments are where every agent's findings land, and the brief did not
// read them. Live consequence: a morning brief could say "nothing on the
// radar" while 18 items were marked 'now', including unreviewed
// card-not-present fraud alerts.
func TestPhraseBriefLeadsWithCommitments(t *testing.T) {
	h := &JarvisHandler{} // llm nil → deterministic fallback, no network
	got := h.phraseBrief(context.Background(), "t", nil, nil, nil,
		[]string{"Review the flagged Amex charge", "Call Krishna back (overdue)"})

	if !strings.Contains(got, "NEEDS YOU") {
		t.Errorf("commitments should be their own section, got:\n%s", got)
	}
	for _, want := range []string{"flagged Amex charge", "Call Krishna back"} {
		if !strings.Contains(got, want) {
			t.Errorf("brief missing %q\n---\n%s", want, got)
		}
	}
}

// A day with an empty calendar and no mail is NOT an empty day when there is
// urgent work outstanding.
func TestPhraseBriefNotEmptyWhenOnlyCommitments(t *testing.T) {
	h := &JarvisHandler{}
	got := h.phraseBrief(context.Background(), "t", nil, nil, nil, []string{"Pay the water bill"})
	if strings.Contains(strings.ToLower(got), "nothing on the radar") {
		t.Errorf("must not claim an empty day while work is outstanding, got %q", got)
	}
}

// A real brief came back with the model's PLAN in front of it — numbered
// steps, then "Here's the brief:", then the content. The prefix matcher could
// not strip it (the first line starts with "1."), so it would have been sent
// verbatim. It matters twice: it is noise, and it is NUMBERED, so it collides
// with the "done 1" reply grammar.
func TestStripAssistantPreamble_DropsNarratedPlan(t *testing.T) {
	raw := `1. Review the source data provided (no tools needed — all data is in the prompt).
2. Identify time-sensitive items (people waiting, decisions needed).
3. Group and synthesize into a terse brief, quoting verbatim.

Here's the brief:

Summary: 3 flagged Amex charges await review.

NEEDS YOU:
1. Review the flagged Amex charge`

	got := stripAssistantPreamble(raw)

	if strings.Contains(got, "Review the source data") {
		t.Errorf("narrated plan should be stripped, got:\n%s", got)
	}
	if strings.Contains(strings.ToLower(got), "here's the brief") {
		t.Errorf("announcement line should be stripped, got:\n%s", got)
	}
	if !strings.HasPrefix(got, "Summary:") {
		t.Errorf("brief should start at the summary, got:\n%s", got)
	}
	// The real numbered items must survive — they are the reply interface.
	if !strings.Contains(got, "1. Review the flagged Amex charge") {
		t.Errorf("real numbered items must be preserved, got:\n%s", got)
	}
}

// A brief with no preamble must pass through untouched.
func TestStripAssistantPreamble_LeavesCleanBriefAlone(t *testing.T) {
	raw := "Summary: two things need you.\n\nNEEDS YOU:\n1. Pay the water bill"
	if got := stripAssistantPreamble(raw); got != raw {
		t.Errorf("clean brief should be unchanged:\nwant %q\ngot  %q", raw, got)
	}
}

// The numbered list is an INTERFACE — "done 2" closes something. A first
// version fed it to the model, which reformatted the numbers into bullets and
// deleted the very thing the owner replies with. It must be code-generated and
// match the mapping persisted at send time, exactly.
func TestActionBlockNumbersAreDeterministic(t *testing.T) {
	urgent := []string{"Review the Amex charge", "Fix the CI", "Call Krishna"}
	block := numberedActionBlock(urgent)

	for i, want := range []string{"1. Review the Amex charge", "2. Fix the CI", "3. Call Krishna"} {
		if !strings.Contains(block, want) {
			t.Errorf("position %d missing %q\n---\n%s", i+1, want, block)
		}
	}
	if !strings.Contains(block, "done 1") {
		t.Errorf("block should teach the reply grammar, got:\n%s", block)
	}
}

func TestActionBlockEmptyWhenNothingUrgent(t *testing.T) {
	if got := numberedActionBlock(nil); got != "" {
		t.Errorf("no urgent items should render nothing, got %q", got)
	}
	if got := withActionBlock("Summary: quiet day.", nil); got != "Summary: quiet day." {
		t.Errorf("prose should pass through untouched, got %q", got)
	}
}

// Even when the LLM is unavailable the numbers must still be there — the
// fallback path is exactly when the owner most needs the list to work.
func TestActionBlockSurvivesEmptyProse(t *testing.T) {
	got := withActionBlock("", []string{"Pay the bill"})
	if !strings.Contains(got, "1. Pay the bill") {
		t.Errorf("numbering must survive with no prose, got %q", got)
	}
}
