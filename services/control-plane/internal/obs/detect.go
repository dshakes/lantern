package obs

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// RunStat is one finished run reduced to the numbers detection needs.
type RunStat struct {
	ID        string
	Version   string
	At        time.Time
	CostUSD   float64
	LatencyMs float64
	ToolCalls float64
	Failed    bool
	Score     *float64 // production-eval score, nil when unscored
}

// Thresholds are the whole detection policy. No model is involved: a metric is
// anomalous iff BOTH the robust z-score and the relative change clear their bars
// on enough samples (so a noisy-but-flat metric and a tiny-but-certain shift
// both stay quiet).
type Thresholds struct {
	MinBaseline  int     // baseline runs required
	MinRecent    int     // recent runs of one version required
	Z            float64 // robust z (median/MAD) or proportion z
	MinRelChange float64 // cost/latency/tool-calls must rise by this fraction
	MinErrDelta  float64 // absolute error-rate rise
	MinScoreDrop float64 // absolute score drop (0..1 scale)
}

func DefaultThresholds() Thresholds {
	return Thresholds{MinBaseline: 20, MinRecent: 5, Z: 4, MinRelChange: 0.5, MinErrDelta: 0.15, MinScoreDrop: 0.15}
}

// Finding is one anomalous (version, metric).
type Finding struct {
	Metric   string   `json:"metric"` // cost | latency | tool_calls | error_rate | score
	Version  string   `json:"version"`
	Baseline float64  `json:"baseline"`
	Observed float64  `json:"observed"`
	Z        float64  `json:"z"`
	N        int      `json:"n"`
	RunIDs   []string `json:"runIds"`
	Detail   string   `json:"detail"`
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	c := append([]float64(nil), xs...)
	sort.Float64s(c)
	m := len(c) / 2
	if len(c)%2 == 1 {
		return c[m]
	}
	return (c[m-1] + c[m]) / 2
}

// robustScale is 1.4826*MAD, floored at 5% of |median| so an all-identical
// baseline (MAD 0) cannot turn any wobble into an infinite z.
func robustScale(xs []float64, med float64) float64 {
	dev := make([]float64, len(xs))
	for i, x := range xs {
		dev[i] = math.Abs(x - med)
	}
	s := 1.4826 * median(dev)
	if f := 0.05 * math.Abs(med); s < f {
		s = f
	}
	if s < 1e-9 {
		s = 1e-9
	}
	return s
}

func pick(rs []RunStat, f func(RunStat) (float64, bool)) []float64 {
	var out []float64
	for _, r := range rs {
		if v, ok := f(r); ok {
			out = append(out, v)
		}
	}
	return out
}

// Detect compares each version's recent runs with the baseline. Output is
// ordered (version, metric) so incidents are stable.
func Detect(baseline, recent []RunStat, th Thresholds) []Finding {
	var out []Finding
	if len(baseline) < th.MinBaseline {
		return nil
	}
	byVer := map[string][]RunStat{}
	for _, r := range recent {
		byVer[r.Version] = append(byVer[r.Version], r)
	}
	vers := make([]string, 0, len(byVer))
	for v := range byVer {
		vers = append(vers, v)
	}
	sort.Strings(vers)

	type cont struct {
		name string
		get  func(RunStat) (float64, bool)
		down bool
	}
	conts := []cont{
		{"cost", func(r RunStat) (float64, bool) { return r.CostUSD, true }, false},
		{"latency", func(r RunStat) (float64, bool) { return r.LatencyMs, true }, false},
		{"tool_calls", func(r RunStat) (float64, bool) { return r.ToolCalls, true }, false},
		{"score", func(r RunStat) (float64, bool) {
			if r.Score == nil {
				return 0, false
			}
			return *r.Score, true
		}, true},
	}
	for _, v := range vers {
		rs := byVer[v]
		if len(rs) < th.MinRecent {
			continue
		}
		ids := make([]string, len(rs))
		for i, r := range rs {
			ids[i] = r.ID
		}
		for _, c := range conts {
			b, o := pick(baseline, c.get), pick(rs, c.get)
			if len(b) < th.MinBaseline || len(o) < th.MinRecent {
				continue
			}
			bm, om := median(b), median(o)
			z := (om - bm) / robustScale(b, bm)
			if c.down {
				if drop := bm - om; -z >= th.Z && drop >= th.MinScoreDrop {
					out = append(out, Finding{c.name, v, bm, om, z, len(o), ids,
						fmt.Sprintf("median score fell %.2f -> %.2f", bm, om)})
				}
				continue
			}
			if bm <= 0 {
				continue // relative change is undefined (e.g. tool calls were not journaled before)
			}
			rel := (om - bm) / bm
			if z >= th.Z && rel >= th.MinRelChange {
				out = append(out, Finding{c.name, v, bm, om, z, len(o), ids,
					fmt.Sprintf("median %s rose %.4g -> %.4g (%.1fx)", c.name, bm, om, om/math.Max(bm, 1e-9))})
			}
		}
		// error rate: one-sided proportion z against the baseline rate.
		bf := 0
		for _, r := range baseline {
			if r.Failed {
				bf++
			}
		}
		p0 := float64(bf) / float64(len(baseline))
		rf, failed := 0, []string{}
		for _, r := range rs {
			if r.Failed {
				rf++
				failed = append(failed, r.ID)
			}
		}
		pr := float64(rf) / float64(len(rs))
		q := math.Max(p0, 0.02)
		z := (pr - p0) / math.Sqrt(q*(1-q)/float64(len(rs)))
		if z >= th.Z && pr-p0 >= th.MinErrDelta {
			out = append(out, Finding{"error_rate", v, p0, pr, z, len(rs), failed,
				fmt.Sprintf("error rate rose %.1f%% -> %.1f%%", p0*100, pr*100)})
		}
	}
	return out
}
