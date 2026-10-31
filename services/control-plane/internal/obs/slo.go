package obs

import (
	"strconv"
	"time"
)

// Window is one multi-window burn-rate rule, the ADR 0041 table verbatim.
type Window struct {
	Long, Short time.Duration
	Burn        float64
	Severity    string // page | ticket
}

var Windows = []Window{
	{time.Hour, 5 * time.Minute, 14.4, "page"},
	{6 * time.Hour, 30 * time.Minute, 6, "page"},
	{24 * time.Hour, 2 * time.Hour, 3, "ticket"},
	{72 * time.Hour, 6 * time.Hour, 1, "ticket"},
}

// Counts is bad/total event counts over one window.
type Counts struct{ Bad, Total int }

// BurnRate is (bad ratio) / (error budget ratio). 1.0 burns exactly the budget
// over the SLO period; 0 when there is no data.
func BurnRate(c Counts, objective float64) float64 {
	if c.Total == 0 || objective >= 1 {
		return 0
	}
	return (float64(c.Bad) / float64(c.Total)) / (1 - objective)
}

// BudgetRemaining is the fraction of the period's error budget left (negative
// once exhausted).
func BudgetRemaining(c Counts, objective float64) float64 {
	if c.Total == 0 {
		return 1
	}
	return 1 - BurnRate(c, objective)
}

// Alert is a firing window.
type Alert struct {
	Window    Window  `json:"-"`
	Severity  string  `json:"severity"`
	LongBurn  float64 `json:"longBurn"`
	ShortBurn float64 `json:"shortBurn"`
	Rule      string  `json:"rule"` // e.g. "14.4x over 1h/5m"
}

// Fire returns the windows whose long AND short burn both reach the rule (a
// burst that already ended does not page) and whose long window holds at least
// minEvents events (one failure in a quiet hour is not a 100% burn).
func Fire(long, short map[time.Duration]Counts, objective float64, minEvents int) []Alert {
	var out []Alert
	for _, w := range Windows {
		l, s := long[w.Long], short[w.Short]
		if l.Total < minEvents {
			continue
		}
		lb, sb := BurnRate(l, objective), BurnRate(s, objective)
		if lb >= w.Burn && sb >= w.Burn {
			out = append(out, Alert{w, w.Severity, lb, sb,
				w.Long.String() + "/" + w.Short.String() + " >= " + trimF(w.Burn) + "x"})
		}
	}
	return out
}

func trimF(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
