package handlers

import (
	"testing"
	"time"
)

func TestUsageDate(t *testing.T) {
	t.Run("UTC default — midnight UTC returns UTC date", func(t *testing.T) {
		t.Setenv("LANTERN_DEFAULT_TIMEZONE", "")
		// 2024-06-10 23:00 UTC
		ts := time.Date(2024, time.June, 10, 23, 0, 0, 0, time.UTC)
		got := usageDate(ts)
		if got != "2024-06-10" {
			t.Errorf("got %q, want 2024-06-10", got)
		}
	})

	t.Run("deployment timezone shifts bucket boundary", func(t *testing.T) {
		// Set deployment tz to America/Los_Angeles (UTC−7 in PDT).
		t.Setenv("LANTERN_DEFAULT_TIMEZONE", "America/Los_Angeles")
		// 2024-06-10 23:00 UTC = 2024-06-10 16:00 PDT → still June 10.
		ts := time.Date(2024, time.June, 10, 23, 0, 0, 0, time.UTC)
		got := usageDate(ts)
		if got != "2024-06-10" {
			t.Errorf("got %q, want 2024-06-10", got)
		}

		// 2024-06-11 04:00 UTC = 2024-06-10 21:00 PDT → still June 10 locally.
		ts2 := time.Date(2024, time.June, 11, 4, 0, 0, 0, time.UTC)
		got2 := usageDate(ts2)
		if got2 != "2024-06-10" {
			t.Errorf("UTC date is 2024-06-11 but PDT date is 2024-06-10; got %q", got2)
		}

		// 2024-06-11 08:00 UTC = 2024-06-11 01:00 PDT → June 11.
		ts3 := time.Date(2024, time.June, 11, 8, 0, 0, 0, time.UTC)
		got3 := usageDate(ts3)
		if got3 != "2024-06-11" {
			t.Errorf("got %q, want 2024-06-11", got3)
		}
	})
}
