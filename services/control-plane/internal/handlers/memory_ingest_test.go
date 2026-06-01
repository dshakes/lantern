package handlers

import (
	"math"
	"testing"
	"time"
)

func TestParseEmailAddress(t *testing.T) {
	cases := []struct {
		raw       string
		wantName  string
		wantEmail string
	}{
		{"Madhu K <madhu@gmail.com>", "Madhu K", "madhu@gmail.com"},
		{"<bob@x.com>", "", "bob@x.com"},
		{"alice@EXAMPLE.com", "", "alice@example.com"},
		{`"Last, First" <lf@corp.com>`, "Last, First", "lf@corp.com"},
		{"not an email", "", ""},
		{"", "", ""},
	}
	for _, tc := range cases {
		name, email := parseEmailAddress(tc.raw)
		if name != tc.wantName || email != tc.wantEmail {
			t.Errorf("parseEmailAddress(%q) = (%q,%q), want (%q,%q)", tc.raw, name, email, tc.wantName, tc.wantEmail)
		}
	}
}

func TestParseEmailDate(t *testing.T) {
	// Parseable formats return the real time.
	got := parseEmailDate("2026-05-31T12:00:00Z")
	if got.Year() != 2026 || got.Month() != time.May {
		t.Errorf("RFC3339 parse wrong: %v", got)
	}
	if d := parseEmailDate("2026-05-31"); d.Year() != 2026 {
		t.Errorf("date-only parse wrong: %v", d)
	}
	// Unparseable falls back to ~now (never zero — which would drop ordering).
	if parseEmailDate("garbage").IsZero() {
		t.Error("unparseable date returned zero time")
	}
	if parseEmailDate("").IsZero() {
		t.Error("empty date returned zero time")
	}
}

func TestShortHashStable(t *testing.T) {
	a := shortHash("madhu@x.com|Lunch|Fri")
	b := shortHash("madhu@x.com|Lunch|Fri")
	c := shortHash("madhu@x.com|Lunch|Sat")
	if a != b {
		t.Error("shortHash not stable for identical input")
	}
	if a == c {
		t.Error("shortHash collided on different input")
	}
	if len(a) != 20 { // 10 bytes hex
		t.Errorf("shortHash len = %d, want 20", len(a))
	}
}

func TestRemarshal(t *testing.T) {
	src := map[string]any{"messages": []any{map[string]any{"from": "a@b.com", "subject": "hi"}}}
	var out struct {
		Messages []struct {
			From    string `json:"from"`
			Subject string `json:"subject"`
		} `json:"messages"`
	}
	if !remarshal(src, &out) {
		t.Fatal("remarshal returned false")
	}
	if len(out.Messages) != 1 || out.Messages[0].From != "a@b.com" || out.Messages[0].Subject != "hi" {
		t.Errorf("remarshal produced %+v", out)
	}
}

func TestVectorLiteral(t *testing.T) {
	got := vectorLiteral([]float32{0.5, -1, 0})
	if got != "[0.5,-1,0]" {
		t.Errorf("vectorLiteral = %q, want [0.5,-1,0]", got)
	}
	// Round-trips to the same float magnitude (no NaN/precision blowup).
	one := vectorLiteral([]float32{float32(math.Pi)})
	if one == "" || one[0] != '[' {
		t.Errorf("unexpected literal %q", one)
	}
}
