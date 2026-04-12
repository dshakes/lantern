package cron_test

import (
	"testing"
	"time"

	"github.com/dshakes/lantern/services/scheduler/internal/cron"
)

// ---------------------------------------------------------------------------
// Parse tests
// ---------------------------------------------------------------------------

func TestParseCron_Valid(t *testing.T) {
	tests := []struct {
		name string
		expr string
	}{
		{"every minute", "* * * * *"},
		{"every hour at :00", "0 * * * *"},
		{"9am weekdays", "0 9 * * 1-5"},
		{"midnight first of month", "0 0 1 * *"},
		{"every 15 minutes", "*/15 * * * *"},
		{"specific minutes", "0,15,30,45 * * * *"},
		{"step range", "0-30/5 * * * *"},
		{"specific day and month", "0 0 25 12 *"},
		{"named day", "0 9 * * MON"},
		{"named month", "0 0 1 JAN *"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sched, err := cron.Parse(tt.expr)
			if err != nil {
				t.Fatalf("Parse(%q) failed: %v", tt.expr, err)
			}
			if sched == nil {
				t.Fatal("expected non-nil schedule")
			}
		})
	}
}

func TestParseCron_Invalid(t *testing.T) {
	tests := []struct {
		name string
		expr string
	}{
		{"empty", ""},
		{"too few fields", "* * *"},
		{"too many fields", "* * * * * *"},
		{"invalid minute", "60 * * * *"},
		{"invalid hour", "* 25 * * *"},
		{"invalid day", "* * 32 * *"},
		{"invalid month", "* * * 13 *"},
		{"invalid dow", "* * * * 7"},
		{"bad range", "* * 5-3 * *"},
		{"bad step", "*/0 * * * *"},
		{"negative value", "-1 * * * *"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := cron.Parse(tt.expr)
			if err == nil {
				t.Errorf("Parse(%q) should have failed", tt.expr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// NextFireTime tests
// ---------------------------------------------------------------------------

func TestNextFireTime(t *testing.T) {
	// Base time: Wednesday 2026-01-14 10:30:00 UTC
	base := time.Date(2026, 1, 14, 10, 30, 0, 0, time.UTC)

	tests := []struct {
		name     string
		expr     string
		after    time.Time
		expected time.Time
	}{
		{
			name:     "every minute",
			expr:     "* * * * *",
			after:    base,
			expected: time.Date(2026, 1, 14, 10, 31, 0, 0, time.UTC),
		},
		{
			name:     "top of next hour",
			expr:     "0 * * * *",
			after:    base,
			expected: time.Date(2026, 1, 14, 11, 0, 0, 0, time.UTC),
		},
		{
			name:     "9am today (past, so next day)",
			expr:     "0 9 * * *",
			after:    base,
			expected: time.Date(2026, 1, 15, 9, 0, 0, 0, time.UTC),
		},
		{
			name:     "midnight first of next month",
			expr:     "0 0 1 * *",
			after:    base,
			expected: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			name:     "every 15 minutes",
			expr:     "*/15 * * * *",
			after:    base,
			expected: time.Date(2026, 1, 14, 10, 45, 0, 0, time.UTC),
		},
		{
			name:     "specific time 0 9 * * MON (next Monday)",
			expr:     "0 9 * * 1",
			after:    base, // Wednesday
			expected: time.Date(2026, 1, 19, 9, 0, 0, 0, time.UTC),
		},
		{
			name:     "already at exact match minute — advances to next",
			expr:     "30 10 * * *",
			after:    base, // exactly 10:30
			expected: time.Date(2026, 1, 15, 10, 30, 0, 0, time.UTC),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sched, err := cron.Parse(tt.expr)
			if err != nil {
				t.Fatalf("Parse(%q) failed: %v", tt.expr, err)
			}

			got := cron.NextFireTime(sched, tt.after)
			if !got.Equal(tt.expected) {
				t.Errorf("NextFireTime(%q, %v):\n  got  %v\n  want %v",
					tt.expr, tt.after, got, tt.expected)
			}
		})
	}
}

// TestNextFireTime_Idempotent verifies that calling NextFireTime on the result
// always produces a strictly later time.
func TestNextFireTime_Idempotent(t *testing.T) {
	sched, err := cron.Parse("*/5 * * * *")
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	base := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	first := cron.NextFireTime(sched, base)
	second := cron.NextFireTime(sched, first)

	if !second.After(first) {
		t.Errorf("second fire time (%v) should be after first (%v)", second, first)
	}

	// Verify the gap is 5 minutes
	diff := second.Sub(first)
	if diff != 5*time.Minute {
		t.Errorf("expected 5m gap, got %v", diff)
	}
}

// TestParseCron_Wildcard verifies that * produces the full range.
func TestParseCron_Wildcard(t *testing.T) {
	sched, err := cron.Parse("* * * * *")
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	if len(sched.Minutes) != 60 {
		t.Errorf("expected 60 minutes, got %d", len(sched.Minutes))
	}
	if len(sched.Hours) != 24 {
		t.Errorf("expected 24 hours, got %d", len(sched.Hours))
	}
	if len(sched.DaysOfMonth) != 31 {
		t.Errorf("expected 31 days, got %d", len(sched.DaysOfMonth))
	}
	if len(sched.Months) != 12 {
		t.Errorf("expected 12 months, got %d", len(sched.Months))
	}
	if len(sched.DaysOfWeek) != 7 {
		t.Errorf("expected 7 days of week, got %d", len(sched.DaysOfWeek))
	}
}

// TestParseCron_Lists verifies comma-separated values.
func TestParseCron_Lists(t *testing.T) {
	sched, err := cron.Parse("0,15,30,45 * * * *")
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	expected := []int{0, 15, 30, 45}
	if len(sched.Minutes) != len(expected) {
		t.Fatalf("expected %d minutes, got %d", len(expected), len(sched.Minutes))
	}
	for i, v := range expected {
		if sched.Minutes[i] != v {
			t.Errorf("Minutes[%d] = %d, want %d", i, sched.Minutes[i], v)
		}
	}
}

// TestParseCron_NamedDays verifies that named days (MON, TUE, etc.) are parsed.
func TestParseCron_NamedDays(t *testing.T) {
	sched, err := cron.Parse("0 9 * * MON-FRI")
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	expected := []int{1, 2, 3, 4, 5}
	if len(sched.DaysOfWeek) != len(expected) {
		t.Fatalf("expected %d days, got %d", len(expected), len(sched.DaysOfWeek))
	}
	for i, v := range expected {
		if sched.DaysOfWeek[i] != v {
			t.Errorf("DaysOfWeek[%d] = %d, want %d", i, sched.DaysOfWeek[i], v)
		}
	}
}
