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
	got := h.phraseBrief(context.Background(), "t", nil, nil, nil)
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
