package cron

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule represents a parsed cron expression.
type Schedule struct {
	Minutes    []int // 0-59
	Hours      []int // 0-23
	DaysOfMonth []int // 1-31
	Months     []int // 1-12
	DaysOfWeek []int // 0-6 (Sunday=0)
}

// Parse parses a standard 5-field cron expression.
// Fields: minute hour day-of-month month day-of-week
// Supports: *, ranges (1-5), steps (*/15), lists (1,3,5), and named months/days.
func Parse(expr string) (*Schedule, error) {
	fields := strings.Fields(strings.TrimSpace(expr))
	if len(fields) != 5 {
		return nil, fmt.Errorf("cron expression must have 5 fields, got %d: %q", len(fields), expr)
	}

	minutes, err := parseField(fields[0], 0, 59)
	if err != nil {
		return nil, fmt.Errorf("invalid minute field %q: %w", fields[0], err)
	}

	hours, err := parseField(fields[1], 0, 23)
	if err != nil {
		return nil, fmt.Errorf("invalid hour field %q: %w", fields[1], err)
	}

	days, err := parseField(fields[2], 1, 31)
	if err != nil {
		return nil, fmt.Errorf("invalid day-of-month field %q: %w", fields[2], err)
	}

	months, err := parseField(replaceMonthNames(fields[3]), 1, 12)
	if err != nil {
		return nil, fmt.Errorf("invalid month field %q: %w", fields[3], err)
	}

	dow, err := parseField(replaceDayNames(fields[4]), 0, 6)
	if err != nil {
		return nil, fmt.Errorf("invalid day-of-week field %q: %w", fields[4], err)
	}

	return &Schedule{
		Minutes:     minutes,
		Hours:       hours,
		DaysOfMonth: days,
		Months:      months,
		DaysOfWeek:  dow,
	}, nil
}

// NextFireTime calculates the next fire time after the given time.
func NextFireTime(sched *Schedule, after time.Time) time.Time {
	// Start from the next minute.
	t := after.Truncate(time.Minute).Add(time.Minute)

	// Search up to 4 years ahead to handle leap years and edge cases.
	maxIterations := 366 * 24 * 60 * 4 // ~4 years of minutes

	for i := 0; i < maxIterations; i++ {
		if matches(sched, t) {
			return t
		}

		// Optimize: if the month doesn't match, skip to the next matching month.
		if !contains(sched.Months, int(t.Month())) {
			t = advanceToNextMonth(t, sched.Months)
			continue
		}

		// If the day doesn't match, skip to the next day.
		if !matchesDay(sched, t) {
			t = t.AddDate(0, 0, 1)
			t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
			continue
		}

		// If the hour doesn't match, skip to the next hour.
		if !contains(sched.Hours, t.Hour()) {
			t = t.Add(time.Hour)
			t = t.Truncate(time.Hour)
			continue
		}

		// Otherwise, advance by 1 minute.
		t = t.Add(time.Minute)
	}

	// Should never reach here for valid cron expressions.
	return after.Add(24 * time.Hour)
}

func matches(sched *Schedule, t time.Time) bool {
	return contains(sched.Minutes, t.Minute()) &&
		contains(sched.Hours, t.Hour()) &&
		matchesDay(sched, t) &&
		contains(sched.Months, int(t.Month()))
}

func matchesDay(sched *Schedule, t time.Time) bool {
	domMatch := contains(sched.DaysOfMonth, t.Day())
	dowMatch := contains(sched.DaysOfWeek, int(t.Weekday()))

	// Standard cron behavior: if both day-of-month and day-of-week are restricted
	// (neither is *), then either match satisfies the condition.
	domRestricted := len(sched.DaysOfMonth) < 31
	dowRestricted := len(sched.DaysOfWeek) < 7

	if domRestricted && dowRestricted {
		return domMatch || dowMatch
	}
	return domMatch && dowMatch
}

func contains(set []int, val int) bool {
	for _, v := range set {
		if v == val {
			return true
		}
	}
	return false
}

func advanceToNextMonth(t time.Time, months []int) time.Time {
	currentMonth := int(t.Month())
	for _, m := range months {
		if m > currentMonth {
			return time.Date(t.Year(), time.Month(m), 1, 0, 0, 0, 0, t.Location())
		}
	}
	// Wrap to next year, first matching month.
	if len(months) > 0 {
		return time.Date(t.Year()+1, time.Month(months[0]), 1, 0, 0, 0, 0, t.Location())
	}
	return t.AddDate(0, 1, 0)
}

// parseField parses a single cron field into a sorted list of matching values.
func parseField(field string, min, max int) ([]int, error) {
	if field == "*" {
		return makeRange(min, max), nil
	}

	var result []int
	parts := strings.Split(field, ",")

	for _, part := range parts {
		vals, err := parsePart(part, min, max)
		if err != nil {
			return nil, err
		}
		result = append(result, vals...)
	}

	// Deduplicate and sort.
	seen := make(map[int]bool)
	var unique []int
	for _, v := range result {
		if !seen[v] {
			seen[v] = true
			unique = append(unique, v)
		}
	}

	// Sort.
	for i := 0; i < len(unique); i++ {
		for j := i + 1; j < len(unique); j++ {
			if unique[j] < unique[i] {
				unique[i], unique[j] = unique[j], unique[i]
			}
		}
	}

	return unique, nil
}

func parsePart(part string, min, max int) ([]int, error) {
	// Handle step values: */5, 1-10/2.
	if strings.Contains(part, "/") {
		parts := strings.SplitN(part, "/", 2)
		step, err := strconv.Atoi(parts[1])
		if err != nil || step <= 0 {
			return nil, fmt.Errorf("invalid step: %s", parts[1])
		}

		var rangeVals []int
		if parts[0] == "*" {
			rangeVals = makeRange(min, max)
		} else {
			rangeVals, err = parseRange(parts[0], min, max)
			if err != nil {
				return nil, err
			}
		}

		var result []int
		start := rangeVals[0]
		for _, v := range rangeVals {
			if (v-start)%step == 0 {
				result = append(result, v)
			}
		}
		return result, nil
	}

	// Handle ranges: 1-5.
	if strings.Contains(part, "-") {
		return parseRange(part, min, max)
	}

	// Single value.
	v, err := strconv.Atoi(part)
	if err != nil {
		return nil, fmt.Errorf("invalid value: %s", part)
	}
	if v < min || v > max {
		return nil, fmt.Errorf("value %d out of range [%d, %d]", v, min, max)
	}
	return []int{v}, nil
}

func parseRange(s string, min, max int) ([]int, error) {
	parts := strings.SplitN(s, "-", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid range: %s", s)
	}

	low, err := strconv.Atoi(parts[0])
	if err != nil {
		return nil, fmt.Errorf("invalid range start: %s", parts[0])
	}

	high, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid range end: %s", parts[1])
	}

	if low < min || high > max || low > high {
		return nil, fmt.Errorf("range %d-%d out of bounds [%d, %d]", low, high, min, max)
	}

	return makeRange(low, high), nil
}

func makeRange(min, max int) []int {
	result := make([]int, max-min+1)
	for i := range result {
		result[i] = min + i
	}
	return result
}

// replaceMonthNames replaces JAN-DEC with 1-12.
func replaceMonthNames(s string) string {
	monthNames := map[string]string{
		"JAN": "1", "FEB": "2", "MAR": "3", "APR": "4",
		"MAY": "5", "JUN": "6", "JUL": "7", "AUG": "8",
		"SEP": "9", "OCT": "10", "NOV": "11", "DEC": "12",
	}
	upper := strings.ToUpper(s)
	for name, num := range monthNames {
		upper = strings.ReplaceAll(upper, name, num)
	}
	return upper
}

// replaceDayNames replaces SUN-SAT with 0-6.
func replaceDayNames(s string) string {
	dayNames := map[string]string{
		"SUN": "0", "MON": "1", "TUE": "2", "WED": "3",
		"THU": "4", "FRI": "5", "SAT": "6",
	}
	upper := strings.ToUpper(s)
	for name, num := range dayNames {
		upper = strings.ReplaceAll(upper, name, num)
	}
	return upper
}
