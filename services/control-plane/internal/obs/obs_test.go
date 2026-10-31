package obs

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Secret-shaped fixtures are assembled at runtime so no literal looks like a
// real credential to secret scanners.
var (
	fakeAnthropic = "sk" + "-ant-api03-" + "ABCDEFGHIJKLMNOP"
	fakeAWS       = "AK" + "IA" + "ABCDEFGHIJKLMNOP"
	fakeJWT       = "ey" + "JhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4"
)

func TestRedactKeysAndValues(t *testing.T) {
	in := map[string]any{
		"url":           "https://api.example.com/v1",
		"api_key":       "plain-looking-value",
		"Authorization": "Bearer abcdef123456",
		"auth_token":    "t0k3n",
		"tokens_in":     float64(120), // NOT a secret
		"max_tokens":    float64(10),
		"nested": map[string]any{
			"note": "use " + fakeAnthropic + " and pal.secret/prod/stripe now",
			"list": []any{"password=hunter2xx", fakeAWS, fakeJWT},
		},
	}
	out, _ := json.Marshal(Redact(in))
	s := string(out)
	for _, leak := range []string{"plain-looking-value", "abcdef123456", "t0k3n", fakeAnthropic, "pal.secret/prod", "hunter2xx", fakeAWS, "SflKxwRJSMeKKF2QT4"} {
		if strings.Contains(s, leak) {
			t.Fatalf("secret %q leaked: %s", leak, s)
		}
	}
	if !strings.Contains(s, `"tokens_in":120`) || !strings.Contains(s, "api.example.com") {
		t.Fatalf("over-redacted: %s", s)
	}
}

func TestRedactTruncates(t *testing.T) {
	if got := RedactString(strings.Repeat("a", 5000)); len(got) > maxStr+30 {
		t.Fatalf("not truncated: %d", len(got))
	}
}

func TestBuildTrace(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fin := t0.Add(3 * time.Second)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	ev := []Event{
		{Seq: 1, Kind: "workflow.started", At: at(0)},
		{Seq: 2, Kind: "step_started", StepID: "a", Payload: map[string]any{"name": "Plan", "type": "ai-step"}, At: at(10)},
		{Seq: 3, Kind: "step_completed", StepID: "a", Payload: map[string]any{"output": "ok", "tokens_in": 100.0, "tokens_out": 50.0, "cost_usd": 0.01, "model": "m1", "provider": "p"}, At: at(710)},
		{Seq: 4, Kind: "step_started", StepID: "b", Payload: map[string]any{"name": "Fetch", "type": "tool"}, At: at(720)},
		{Seq: 6, Kind: "step_retrying", StepID: "b", Payload: map[string]any{"attempt": 2.0, "error": "timeout"}, At: at(900)},
		{Seq: 7, Kind: "step_failed", StepID: "b", Payload: map[string]any{"error": "boom Bearer abcdefgh12345", "tool": "http", "args": map[string]any{"url": "x", "api_key": fakeAnthropic}}, At: at(1200)},
		{Seq: 8, Kind: "step_started", StepID: "c", Payload: map[string]any{"name": "Sub", "type": "subagent"}, At: at(1300)},
	}
	child := &Trace{RunID: "child"}
	tr := BuildTrace(RunInfo{ID: "r", Status: "failed", CreatedAt: t0, FinishedAt: &fin}, ev, []*Trace{child})
	if len(tr.Steps) != 3 || tr.DurationMs != 3000 {
		t.Fatalf("steps=%d dur=%d", len(tr.Steps), tr.DurationMs)
	}
	a, b, c := tr.Steps[0], tr.Steps[1], tr.Steps[2]
	if a.LLM == nil || a.LLM.LatencyMs != 700 || a.LLM.Model != "m1" || a.StartMs != 10 {
		t.Fatalf("llm node: %+v %+v", a, a.LLM)
	}
	if b.Status != "failed" || len(b.Retries) != 1 || b.Tool == nil || b.DurationMs != 480 {
		t.Fatalf("tool node: %+v", b)
	}
	if c.Status != "running" || c.ChildRun != child {
		t.Fatalf("child not attached: %+v", c)
	}
	raw, _ := json.Marshal(tr)
	for _, leak := range []string{fakeAnthropic, "abcdefgh12345"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("trace leaked %q: %s", leak, raw)
		}
	}
	if tr.Totals.LLMCalls != 1 || tr.Totals.ToolCalls != 1 || tr.Totals.Retries != 1 {
		t.Fatalf("totals %+v", tr.Totals)
	}
}

func steady(n int, ver string, cost, lat float64) []RunStat {
	out := make([]RunStat, n)
	for i := range out {
		j := float64(i%5) / 100 // small deterministic jitter
		out[i] = RunStat{ID: fmt.Sprintf("%s-%d", ver, i), Version: ver, CostUSD: cost * (1 + j), LatencyMs: lat * (1 + j), ToolCalls: 3}
	}
	return out
}

func TestDetectQuietOnNormalTraffic(t *testing.T) {
	if f := Detect(steady(40, "v1", 0.01, 1000), steady(8, "v1", 0.011, 1050), DefaultThresholds()); len(f) != 0 {
		t.Fatalf("false positive: %+v", f)
	}
}

func TestDetectCostRegression(t *testing.T) {
	f := Detect(steady(40, "v1", 0.01, 1000), steady(6, "v2", 0.05, 1000), DefaultThresholds())
	if len(f) != 1 || f[0].Metric != "cost" || f[0].Version != "v2" || len(f[0].RunIDs) != 6 {
		t.Fatalf("want one cost finding for v2, got %+v", f)
	}
}

// Threshold boundary: a 1.4x rise (below MinRelChange 0.5) must stay quiet,
// a 1.6x rise must fire. Mutation: lowering MinRelChange/Z flips the first.
func TestDetectThresholdBoundary(t *testing.T) {
	th := DefaultThresholds()
	if f := Detect(steady(40, "v1", 0.01, 1000), steady(6, "v2", 0.014, 1000), th); len(f) != 0 {
		t.Fatalf("1.4x fired: %+v", f)
	}
	if f := Detect(steady(40, "v1", 0.01, 1000), steady(6, "v2", 0.016, 1000), th); len(f) != 1 {
		t.Fatalf("1.6x did not fire: %+v", f)
	}
}

func TestDetectNeedsEnoughSamples(t *testing.T) {
	th := DefaultThresholds()
	if f := Detect(steady(10, "v1", 0.01, 1000), steady(6, "v2", 0.5, 1000), th); f != nil {
		t.Fatalf("thin baseline fired: %+v", f)
	}
	if f := Detect(steady(40, "v1", 0.01, 1000), steady(3, "v2", 0.5, 1000), th); len(f) != 0 {
		t.Fatalf("thin recent fired: %+v", f)
	}
}

func TestDetectErrorRateAndScore(t *testing.T) {
	base := steady(40, "v1", 0.01, 1000)
	rec := steady(8, "v2", 0.01, 1000)
	for i := 0; i < 4; i++ {
		rec[i].Failed = true
	}
	f := Detect(base, rec, DefaultThresholds())
	if len(f) != 1 || f[0].Metric != "error_rate" || len(f[0].RunIDs) != 4 {
		t.Fatalf("error rate: %+v", f)
	}
	hi, lo := 0.9, 0.5
	for i := range base {
		base[i].Score = &hi
	}
	rec = steady(8, "v2", 0.01, 1000)
	for i := range rec {
		rec[i].Score = &lo
	}
	f = Detect(base, rec, DefaultThresholds())
	if len(f) != 1 || f[0].Metric != "score" {
		t.Fatalf("score: %+v", f)
	}
}

func TestBurnRateAndFire(t *testing.T) {
	if got := BurnRate(Counts{Bad: 5, Total: 100}, 0.95); got < 0.99 || got > 1.01 {
		t.Fatalf("burn=%v", got)
	}
	long := map[time.Duration]Counts{time.Hour: {Bad: 80, Total: 100}}
	short := map[time.Duration]Counts{5 * time.Minute: {Bad: 8, Total: 10}}
	al := Fire(long, short, 0.95, 20)
	if len(al) != 1 || al[0].Severity != "page" {
		t.Fatalf("alerts: %+v", al)
	}
	// a burst that already ended (short window healthy) must not page
	short[5*time.Minute] = Counts{Bad: 0, Total: 10}
	if al := Fire(long, short, 0.95, 20); len(al) != 0 {
		t.Fatalf("ended burst paged: %+v", al)
	}
	// quiet hour: one failure in three events is not a page
	if al := Fire(map[time.Duration]Counts{time.Hour: {Bad: 1, Total: 3}}, map[time.Duration]Counts{5 * time.Minute: {Bad: 1, Total: 1}}, 0.95, 20); len(al) != 0 {
		t.Fatalf("quiet hour paged: %+v", al)
	}
}

func TestBuildTracePolicyDenied(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	ev := []Event{
		{Seq: 1, Kind: "step_started", StepID: "ok", Payload: map[string]any{"name": "Allowed", "type": "tool"}, At: at(1)},
		{Seq: 2, Kind: "step_completed", StepID: "ok", Payload: map[string]any{"output": "fine"}, At: at(5)},
		{Seq: 3, Kind: "step_started", StepID: "bad", Payload: map[string]any{"name": "Refund", "type": "connector"}, At: at(6)},
		{Seq: 5, Kind: "policy_denied", StepID: "bad", Payload: map[string]any{"kind": "connector", "target": "stripe", "reason": "not in allowlist " + fakeAnthropic}, At: at(8)},
		{Seq: 6, Kind: "step_failed", StepID: "bad", Payload: map[string]any{"error": "agent policy denied connector stripe", "tool": "stripe.refund", "args": map[string]any{"api_key": fakeAnthropic}}, At: at(9)},
		{Seq: 7, Kind: "policy_denied", StepID: "policy", Payload: map[string]any{"kind": "tool", "target": "shell", "reason": "denied"}, At: at(10)},
	}
	tr := BuildTrace(RunInfo{ID: "r", Status: "failed", CreatedAt: t0}, ev, nil)
	if len(tr.Steps) != 3 || tr.Steps[0].PolicyDenied != nil {
		t.Fatalf("steps: %+v", tr.Steps)
	}
	bad, orphan := tr.Steps[1], tr.Steps[2]
	if bad.PolicyDenied == nil || bad.PolicyDenied.Target != "stripe" || bad.Status != "failed" || bad.Tool == nil {
		t.Fatalf("denied step: %+v", bad)
	}
	if orphan.Type != "policy" || orphan.Status != "failed" || orphan.PolicyDenied.Target != "shell" {
		t.Fatalf("step-less denial must still render: %+v", orphan)
	}
	raw, _ := json.Marshal(tr)
	if strings.Contains(string(raw), fakeAnthropic) {
		t.Fatalf("secret leaked through policy denial: %s", raw)
	}
}
