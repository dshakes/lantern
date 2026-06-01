package handlers

import (
	"context"
	"strings"
	"testing"
)

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
