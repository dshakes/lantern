package scheduler

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// NextCronTime calculates the next fire time after `after` for a standard
// 5-field cron expression: minute hour day-of-month month day-of-week.
//
// This is a simple forward-search implementation suitable for the spike. It
// walks forward minute by minute up to 2 years to find the next match. For
// production use, replace with a proper cron library.
func NextCronTime(expr string, after time.Time) (time.Time, error) {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return time.Time{}, fmt.Errorf("cron expression must have 5 fields, got %d", len(fields))
	}

	minutes, err := parseField(fields[0], 0, 59)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad minute field: %w", err)
	}
	hours, err := parseField(fields[1], 0, 23)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad hour field: %w", err)
	}
	doms, err := parseField(fields[2], 1, 31)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad day-of-month field: %w", err)
	}
	months, err := parseField(fields[3], 1, 12)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad month field: %w", err)
	}
	dows, err := parseField(fields[4], 0, 7) // 0 and 7 both = Sunday
	if err != nil {
		return time.Time{}, fmt.Errorf("bad day-of-week field: %w", err)
	}

	// Normalize: treat 7 as 0 (Sunday).
	dowSet := make(map[int]bool, len(dows))
	for _, d := range dows {
		if d == 7 {
			d = 0
		}
		dowSet[d] = true
	}
	minuteSet := toSet(minutes)
	hourSet := toSet(hours)
	domSet := toSet(doms)
	monthSet := toSet(months)

	// Start from the next minute after `after`.
	t := after.Truncate(time.Minute).Add(time.Minute)
	limit := after.Add(2 * 365 * 24 * time.Hour)

	for t.Before(limit) {
		if monthSet[int(t.Month())] &&
			domSet[t.Day()] &&
			dowSet[int(t.Weekday())] &&
			hourSet[t.Hour()] &&
			minuteSet[t.Minute()] {
			return t, nil
		}

		// Skip ahead intelligently.
		if !monthSet[int(t.Month())] {
			// Jump to first day of next month.
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, t.Location())
			continue
		}
		if !domSet[t.Day()] || !dowSet[int(t.Weekday())] {
			// Jump to next day.
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, t.Location())
			continue
		}
		if !hourSet[t.Hour()] {
			// Jump to next hour.
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, t.Location())
			continue
		}
		// Try next minute.
		t = t.Add(time.Minute)
	}

	return time.Time{}, fmt.Errorf("no next fire time within 2 years for cron %q", expr)
}

// parseField parses a single cron field (e.g. "*/5", "1,15", "1-5", "*").
func parseField(field string, min, max int) ([]int, error) {
	if field == "*" {
		return makeRange(min, max), nil
	}

	// Handle */N (step).
	if strings.HasPrefix(field, "*/") {
		step, err := strconv.Atoi(field[2:])
		if err != nil || step <= 0 {
			return nil, fmt.Errorf("invalid step %q", field)
		}
		var vals []int
		for i := min; i <= max; i += step {
			vals = append(vals, i)
		}
		return vals, nil
	}

	// Handle comma-separated values and ranges.
	var vals []int
	for _, part := range strings.Split(field, ",") {
		part = strings.TrimSpace(part)
		if strings.Contains(part, "-") {
			bounds := strings.SplitN(part, "-", 2)
			lo, err := strconv.Atoi(bounds[0])
			if err != nil {
				return nil, fmt.Errorf("invalid range start %q", bounds[0])
			}
			hi, err := strconv.Atoi(bounds[1])
			if err != nil {
				return nil, fmt.Errorf("invalid range end %q", bounds[1])
			}
			if lo < min || hi > max || lo > hi {
				return nil, fmt.Errorf("range %d-%d out of bounds [%d,%d]", lo, hi, min, max)
			}
			vals = append(vals, makeRange(lo, hi)...)
		} else {
			v, err := strconv.Atoi(part)
			if err != nil {
				return nil, fmt.Errorf("invalid value %q", part)
			}
			if v < min || v > max {
				return nil, fmt.Errorf("value %d out of bounds [%d,%d]", v, min, max)
			}
			vals = append(vals, v)
		}
	}

	if len(vals) == 0 {
		return nil, fmt.Errorf("empty field")
	}
	return vals, nil
}

func makeRange(lo, hi int) []int {
	r := make([]int, 0, hi-lo+1)
	for i := lo; i <= hi; i++ {
		r = append(r, i)
	}
	return r
}

func toSet(vals []int) map[int]bool {
	s := make(map[int]bool, len(vals))
	for _, v := range vals {
		s[v] = true
	}
	return s
}
