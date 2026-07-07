package scheduler

import (
	"os"
	"testing"
	"time"
)

func TestResolveLocation(t *testing.T) {
	t.Run("valid IANA tz", func(t *testing.T) {
		loc := ResolveLocation("America/New_York")
		if loc == nil {
			t.Fatal("want non-nil")
		}
		if loc.String() != "America/New_York" {
			t.Errorf("got %q, want America/New_York", loc)
		}
	})

	t.Run("invalid tz falls back to UTC", func(t *testing.T) {
		os.Unsetenv("LANTERN_DEFAULT_TIMEZONE")
		loc := ResolveLocation("Not/A/Zone")
		if loc != time.UTC {
			t.Errorf("got %q, want UTC", loc)
		}
	})

	t.Run("empty tz returns UTC when env unset", func(t *testing.T) {
		os.Unsetenv("LANTERN_DEFAULT_TIMEZONE")
		loc := ResolveLocation("")
		if loc != time.UTC {
			t.Errorf("got %q, want UTC", loc)
		}
	})

	t.Run("empty tz uses LANTERN_DEFAULT_TIMEZONE", func(t *testing.T) {
		t.Setenv("LANTERN_DEFAULT_TIMEZONE", "America/Chicago")
		loc := ResolveLocation("")
		if loc.String() != "America/Chicago" {
			t.Errorf("got %q, want America/Chicago", loc)
		}
	})

	t.Run("explicit tz wins over env", func(t *testing.T) {
		t.Setenv("LANTERN_DEFAULT_TIMEZONE", "America/Chicago")
		loc := ResolveLocation("America/New_York")
		if loc.String() != "America/New_York" {
			t.Errorf("got %q, want America/New_York", loc)
		}
	})

	t.Run("invalid LANTERN_DEFAULT_TIMEZONE falls back to UTC", func(t *testing.T) {
		t.Setenv("LANTERN_DEFAULT_TIMEZONE", "Bad/Zone")
		loc := ResolveLocation("")
		if loc != time.UTC {
			t.Errorf("got %q, want UTC", loc)
		}
	})
}

// TestNextCronTime_Timezone proves that "0 9 * * *" with tz=America/New_York
// yields a next_fire at 09:00 in that zone — not 09:00 UTC.
func TestNextCronTime_Timezone(t *testing.T) {
	nyLoc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}

	// Pick a fixed Monday 10:00 UTC = 06:00 Eastern (−4 in EDT).
	// Next "0 9 * * *" in Eastern should be 09:00 Eastern same day.
	after := time.Date(2024, time.June, 10, 10, 0, 0, 0, time.UTC)

	next, err := NextCronTime("0 9 * * *", after.In(nyLoc))
	if err != nil {
		t.Fatalf("NextCronTime: %v", err)
	}

	// Convert result to Eastern to check the wall-clock hour.
	nextInNY := next.In(nyLoc)
	if nextInNY.Hour() != 9 || nextInNY.Minute() != 0 {
		t.Errorf("want 09:00 Eastern, got %02d:%02d Eastern", nextInNY.Hour(), nextInNY.Minute())
	}
	if next.In(time.UTC).Hour() == 9 {
		t.Error("next fire should NOT be 09:00 UTC when tz=America/New_York")
	}
}
