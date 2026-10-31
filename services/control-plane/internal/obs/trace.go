package obs

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Event is one journal_events row, payload already JSON-decoded.
type Event struct {
	Seq     int64
	Kind    string
	StepID  string
	Attempt int
	Payload map[string]any
	At      time.Time
}

// RunInfo is the runs-row facts the trace header needs.
type RunInfo struct {
	ID, Status, AgentName, AgentVersion string
	CreatedAt                           time.Time
	FinishedAt                          *time.Time
	CostUSD                             float64
	TokensIn, TokensOut                 int64
	Error                               any
}

type Retry struct {
	Attempt int    `json:"attempt"`
	Error   string `json:"error,omitempty"`
}

type LLMInfo struct {
	Provider  string  `json:"provider,omitempty"`
	Model     string  `json:"model,omitempty"`
	TokensIn  int64   `json:"tokensIn"`
	TokensOut int64   `json:"tokensOut"`
	CostUSD   float64 `json:"costUsd"`
	LatencyMs int64   `json:"latencyMs"`
}

type ToolInfo struct {
	Name   string `json:"name"`
	Args   any    `json:"args,omitempty"`
	Result string `json:"result,omitempty"`
}

// Node is one step in the waterfall/tree.
type Node struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	Status     string    `json:"status"` // ok | failed | running | waiting
	StartMs    int64     `json:"startMs"`
	DurationMs int64     `json:"durationMs"`
	Retries    []Retry   `json:"retries,omitempty"`
	LLM        *LLMInfo  `json:"llm,omitempty"`
	Tool       *ToolInfo `json:"tool,omitempty"`
	Output     string    `json:"output,omitempty"`
	Error      string    `json:"error,omitempty"`
	ChildRun   *Trace    `json:"childRun,omitempty"`

	startAt time.Time
}

type Totals struct {
	Steps     int `json:"steps"`
	LLMCalls  int `json:"llmCalls"`
	ToolCalls int `json:"toolCalls"`
	Retries   int `json:"retries"`
}

// Trace is the GET /v1/runs/{id}/trace response.
type Trace struct {
	RunID        string    `json:"runId"`
	Status       string    `json:"status"`
	AgentName    string    `json:"agentName"`
	AgentVersion string    `json:"agentVersion,omitempty"`
	StartedAt    time.Time `json:"startedAt"`
	DurationMs   int64     `json:"durationMs"`
	CostUSD      float64   `json:"costUsd"`
	TokensIn     int64     `json:"tokensIn"`
	TokensOut    int64     `json:"tokensOut"`
	Error        any       `json:"error,omitempty"`
	Totals       Totals    `json:"totals"`
	Steps        []*Node   `json:"steps"`
	// ChildRuns are sub-runs whose trace could not be tied to one step.
	ChildRuns []*Trace `json:"childRuns,omitempty"`
}

func numF(m map[string]any, k string) float64 {
	switch n := m[k].(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}

// BuildTrace folds a run's journal into a tree. children are already-built
// traces of runs with parent_run_id = this run; they are attached to the
// subagent step in order, else listed under ChildRuns. Every free-text field
// passes through Redact.
func BuildTrace(run RunInfo, events []Event, children []*Trace) *Trace {
	sort.SliceStable(events, func(i, j int) bool { return events[i].Seq < events[j].Seq })
	t := &Trace{
		RunID: run.ID, Status: run.Status, AgentName: run.AgentName, AgentVersion: run.AgentVersion,
		StartedAt: run.CreatedAt, CostUSD: run.CostUSD, TokensIn: run.TokensIn, TokensOut: run.TokensOut,
		Error: Redact(run.Error), Steps: []*Node{},
	}
	if run.FinishedAt != nil {
		t.DurationMs = run.FinishedAt.Sub(run.CreatedAt).Milliseconds()
	}
	byID := map[string]*Node{}
	node := func(e Event) *Node {
		n := byID[e.StepID]
		if n == nil {
			n = &Node{ID: e.StepID, Name: e.StepID, Type: "step", Status: "running", startAt: e.At}
			n.StartMs = e.At.Sub(run.CreatedAt).Milliseconds()
			if strings.HasPrefix(e.StepID, "llm:") {
				n.Type = "llm"
			}
			byID[e.StepID] = n
			t.Steps = append(t.Steps, n)
		}
		return n
	}
	var last time.Time
	for _, e := range events {
		if e.At.After(last) {
			last = e.At
		}
		if e.StepID == "" {
			continue // workflow.* bookkeeping
		}
		p := e.Payload
		if p == nil {
			p = map[string]any{}
		}
		n := node(e)
		switch e.Kind {
		case "step_started":
			if s := str(p, "name"); s != "" {
				n.Name = RedactString(s)
			}
			if s := str(p, "type"); s != "" {
				n.Type = s
			}
			n.startAt = e.At
			n.StartMs = e.At.Sub(run.CreatedAt).Milliseconds()
		case "tool_call":
			n.Tool = &ToolInfo{Name: RedactString(str(p, "tool")), Args: Redact(p["args"])}
		case "step_retrying":
			n.Retries = append(n.Retries, Retry{Attempt: int(numF(p, "attempt")), Error: RedactString(str(p, "error"))})
		case "step_waiting":
			n.Status = "waiting"
		case "step_completed":
			n.Status = "ok"
			n.DurationMs = e.At.Sub(n.startAt).Milliseconds()
			out := str(p, "output")
			if out == "" {
				out = str(p, "result")
			}
			n.Output = RedactString(out)
			if n.Tool != nil {
				n.Tool.Result = n.Output
			}
			if numF(p, "tokens_in")+numF(p, "tokens_out")+numF(p, "cost_usd") > 0 || str(p, "model") != "" {
				n.LLM = &LLMInfo{Provider: str(p, "provider"), Model: str(p, "model"),
					TokensIn: int64(numF(p, "tokens_in")), TokensOut: int64(numF(p, "tokens_out")),
					CostUSD: numF(p, "cost_usd"), LatencyMs: n.DurationMs}
			}
		case "step_failed":
			n.Status = "failed"
			n.DurationMs = e.At.Sub(n.startAt).Milliseconds()
			n.Error = RedactString(str(p, "error"))
		}
	}
	if t.DurationMs == 0 && !last.IsZero() {
		t.DurationMs = last.Sub(run.CreatedAt).Milliseconds()
	}
	ci := 0
	for _, n := range t.Steps {
		t.Totals.Steps++
		t.Totals.Retries += len(n.Retries)
		if n.LLM != nil {
			t.Totals.LLMCalls++
		}
		if n.Tool != nil || n.Type == "tool" || n.Type == "connector" {
			t.Totals.ToolCalls++
		}
		if n.Type == "subagent" && ci < len(children) {
			n.ChildRun = children[ci]
			ci++
		}
	}
	t.ChildRuns = children[ci:]
	return t
}

// Describe is a one-line, human-readable digest used in incident timelines.
func (t *Trace) Describe() string {
	return fmt.Sprintf("run %s %s: %d steps, %d llm, %d tool, %d retries, $%.4f", t.RunID, t.Status,
		t.Totals.Steps, t.Totals.LLMCalls, t.Totals.ToolCalls, t.Totals.Retries, t.CostUSD)
}
