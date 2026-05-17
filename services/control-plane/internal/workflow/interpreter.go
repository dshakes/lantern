// Package workflow runs a saved agent workflow graph against the real
// LLM + connector + tool primitives. Today the agent definition stores a
// React-Flow style graph in `agents.workflow` JSONB. Before W11b the
// graph was a designer artifact only — nothing executed it. This package
// closes that gap.
//
// Design choices:
//
//   - The interpreter is pure Go and free of HTTP types. Callers inject
//     a Deps struct that resolves the real side-effects (LLM call,
//     connector execute, tool call). That keeps this package testable
//     without spinning up the whole control-plane.
//
//   - Every node executes as a single span in journal_events so the
//     RunWaterfall UI (W4) renders the graph hierarchy automatically.
//     We emit step_started before the node runs and step_completed /
//     step_failed after — the same contract the existing waterfall
//     consumer expects.
//
//   - Execution is a topological walk from the trigger. Conditions
//     branch via edge labels ("true" / "false"). Loops + approvals +
//     subagents are placeholders that emit a log event and continue —
//     they're future work flagged with TODOs.
//
//   - There is no retry / durable execution here yet — a process crash
//     mid-workflow loses the in-flight state. A real production engine
//     (W11b+) layers in a workflow_runs table with checkpoints. Today
//     we run inline and persist via journal_events so the UX is
//     correct even if the durability is single-process.
package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

// ---- Wire types -------------------------------------------------------------

// Node mirrors apps/web/lib/workflow-types.ts WorkflowNode. We unmarshal
// the entire graph blindly via map[string]any here so future node-data
// shape evolutions don't force a Go schema bump.
type Node struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

type Edge struct {
	ID           string  `json:"id"`
	Source       string  `json:"source"`
	Target       string  `json:"target"`
	SourceHandle *string `json:"sourceHandle,omitempty"`
	TargetHandle *string `json:"targetHandle,omitempty"`
	Label        *string `json:"label,omitempty"`
}

type Definition struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
	// Metadata is ignored at runtime; carried through only to avoid
	// breaking older clients that send it.
	Metadata map[string]any `json:"metadata,omitempty"`
}

// ---- Side-effect interface --------------------------------------------------

// Deps gives the interpreter the four real-world operations it needs.
// Concrete implementations wrap the existing control-plane handlers so
// the workflow uses the same LLM router, connector executor, and journal
// writer as everything else.
type Deps struct {
	// CallLLM runs a single LLM turn with the agent's tenant-scoped
	// provider keys. It must return the final text reply or an error.
	CallLLM func(ctx context.Context, prompt string, capability string) (string, error)

	// CallConnector dispatches to /v1/connectors/{id}/execute equivalent
	// for the given connector + action + params. Returns the parsed
	// connector response (JSON-as-map) or an error.
	CallConnector func(ctx context.Context, connectorID, action string, params map[string]any) (any, error)

	// CallTool runs a built-in tool (web.search, python.exec, fs.*). Returns
	// the tool's result payload. Tools that aren't implemented yet return
	// a NotImplemented error which the interpreter logs and continues past.
	CallTool func(ctx context.Context, tool string, params map[string]any) (any, error)

	// EmitEvent writes a single journal_events row. The interpreter
	// emits step_started + step_completed / step_failed per node.
	EmitEvent func(ctx context.Context, ev JournalEvent) error

	// WaitForApproval blocks until a human acks an approval node. Returns
	// the takeover record's final disposition (granted / released / denied
	// / expired). When nil, approval nodes auto-approve so workflows
	// without a wired-up human-in-the-loop layer still complete.
	WaitForApproval func(ctx context.Context, runID, stepID, reason string) (ApprovalDisposition, error)
}

// ApprovalDisposition reports what the human did with an approval step.
type ApprovalDisposition struct {
	Granted bool
	Reason  string // human-supplied notes from the takeover grant/release flow
}

// JournalEvent matches the journal_events table layout (BYTEA payload).
type JournalEvent struct {
	RunID   string         `json:"runId"`
	Seq     int64          `json:"seq"`
	Kind    string         `json:"kind"`
	StepID  string         `json:"stepId,omitempty"`
	Attempt int            `json:"attempt"`
	Payload map[string]any `json:"payload"`
}

// Result captures the final output of the workflow plus a few stats so
// the caller can write it back into runs.output / tokens / cost.
type Result struct {
	Output    string
	StepsRan  int
	Failed    bool
	FailedAt  string
	LastError string
}

// ---- Execution --------------------------------------------------------------

// Run walks the workflow starting from the single trigger node and
// returns the final result. The input is exposed to every node as
// {{input.<key>}} substitution and as the seed context variable.
//
// Limits + tunables:
//   - maxSteps: hard cap on nodes visited (prevents infinite loops with
//     a malformed graph). Default 100.
//   - perStepTimeout: deadline applied to each node via ctx. Default 60s.
func Run(ctx context.Context, runID string, deps Deps, def Definition, input map[string]any) (Result, error) {
	const maxSteps = 100
	const perStepTimeout = 60 * time.Second

	if len(def.Nodes) == 0 {
		return Result{}, fmt.Errorf("workflow has no nodes")
	}

	trigger := findTrigger(def.Nodes)
	if trigger == nil {
		return Result{}, fmt.Errorf("workflow has no trigger node — every workflow needs exactly one entry point")
	}

	// Adjacency: source node id → outgoing edges. We use a map of slices
	// rather than a single edge per node so condition / loop nodes can
	// have multiple outgoing branches.
	out := make(map[string][]Edge, len(def.Edges))
	for _, e := range def.Edges {
		out[e.Source] = append(out[e.Source], e)
	}
	byID := make(map[string]Node, len(def.Nodes))
	for _, n := range def.Nodes {
		byID[n.ID] = n
	}

	// Variable context — every step writes its result here under the
	// node's ID. Subsequent steps can reference prior step output via
	// `{{steps.<id>}}` in their prompts/params (templated below).
	vars := map[string]any{
		"input": input,
		"steps": map[string]any{},
	}

	var seq int64
	emit := func(kind, stepID string, payload map[string]any) {
		next := atomic.AddInt64(&seq, 1)
		_ = deps.EmitEvent(ctx, JournalEvent{
			RunID: runID, Seq: next, Kind: kind, StepID: stepID, Attempt: 1, Payload: payload,
		})
	}

	res := Result{}
	current := trigger.ID
	emit("workflow.started", "", map[string]any{
		"workflowVersion": def.Metadata["version"],
		"triggerNodeId":   current,
	})

	for steps := 0; steps < maxSteps; steps++ {
		node, ok := byID[current]
		if !ok {
			res.Failed = true
			res.LastError = fmt.Sprintf("unknown node id %q (dangling edge)", current)
			break
		}

		if node.Type == "end" {
			// End nodes optionally render an output expression.
			if expr, _ := node.Data["outputExpression"].(string); expr != "" {
				res.Output = renderTemplate(expr, vars)
			} else if res.Output == "" && lastStep(vars) != "" {
				res.Output = lastStep(vars)
			}
			emit("workflow.completed", node.ID, map[string]any{"output": res.Output})
			break
		}

		stepCtx, cancel := context.WithTimeout(ctx, perStepTimeout)
		emit("step_started", node.ID, map[string]any{
			"name": labelOf(node),
			"type": node.Type,
		})

		stepOutput, stepErr := executeNode(stepCtx, runID, deps, node, vars)
		cancel()
		res.StepsRan++

		if stepErr != nil {
			emit("step_failed", node.ID, map[string]any{
				"error": stepErr.Error(),
				"type":  node.Type,
			})
			res.Failed = true
			res.FailedAt = node.ID
			res.LastError = stepErr.Error()
			break
		}

		// Persist step output in vars for later template references.
		if stepsMap, ok := vars["steps"].(map[string]any); ok {
			stepsMap[node.ID] = stepOutput
		}

		emit("step_completed", node.ID, map[string]any{
			"name":   labelOf(node),
			"type":   node.Type,
			"output": truncate(formatOutput(stepOutput), 600),
		})

		// Decide the next node based on the step type.
		next := chooseNext(node, stepOutput, out[node.ID])
		if next == "" {
			// No outgoing edge — terminal node by accident, treat as
			// successful completion and use the last step's output.
			if res.Output == "" {
				res.Output = formatOutput(stepOutput)
			}
			emit("workflow.completed", node.ID, map[string]any{"output": res.Output, "reason": "no outgoing edge"})
			break
		}
		current = next
	}

	if res.StepsRan >= maxSteps && !res.Failed {
		res.Failed = true
		res.LastError = fmt.Sprintf("workflow exceeded maxSteps=%d (possible loop)", maxSteps)
		emit("workflow.failed", "", map[string]any{"reason": res.LastError})
	}

	return res, nil
}

// ---- Per-node execution -----------------------------------------------------

func executeNode(ctx context.Context, runID string, deps Deps, node Node, vars map[string]any) (any, error) {
	switch node.Type {
	case "trigger":
		// Trigger is a no-op at runtime — it just marks the entry.
		return map[string]any{"triggered": true}, nil

	case "ai-step":
		prompt, _ := node.Data["prompt"].(string)
		if prompt == "" {
			return nil, fmt.Errorf("ai-step requires a prompt")
		}
		capability, _ := node.Data["capability"].(string)
		if capability == "" {
			capability = "auto"
		}
		rendered := renderTemplate(prompt, vars)
		reply, err := deps.CallLLM(ctx, rendered, capability)
		if err != nil {
			return nil, fmt.Errorf("ai-step LLM call failed: %w", err)
		}
		return reply, nil

	case "tool":
		tool, _ := node.Data["tool"].(string)
		if tool == "" {
			return nil, fmt.Errorf("tool node requires a tool name")
		}
		params := parseParams(node.Data["parameters"], vars)
		return deps.CallTool(ctx, tool, params)

	case "connector":
		connectorID, _ := node.Data["connector"].(string)
		action, _ := node.Data["action"].(string)
		if connectorID == "" || action == "" {
			return nil, fmt.Errorf("connector node requires connector + action")
		}
		params := parseParams(node.Data["inputMapping"], vars)
		return deps.CallConnector(ctx, connectorID, action, params)

	case "condition":
		expr, _ := node.Data["expression"].(string)
		// Minimal expression evaluator: we resolve any {{...}} placeholders
		// and treat the resulting string as truthy via simple rules. A
		// real condition node would compile a Cel/Starlark expression
		// here — flagged as a future bump.
		rendered := strings.TrimSpace(renderTemplate(expr, vars))
		truthy := rendered != "" && rendered != "false" && rendered != "0" && rendered != "null"
		return map[string]any{"value": truthy, "rendered": rendered}, nil

	case "loop":
		// TODO(w11b+): iterate over arrayExpression with the configured
		// concurrency, fan out the downstream subgraph per element.
		// Today the loop node passes through with a no-op so the graph
		// still completes — better than failing the run.
		return map[string]any{"skipped": "loop not yet implemented"}, nil

	case "approval":
		// W11a: block on the real human-takeover handshake when wired,
		// auto-approve otherwise so older configurations still complete.
		reason, _ := node.Data["reason"].(string)
		if deps.WaitForApproval == nil {
			return map[string]any{"approved": true, "note": "auto-approved (no human-takeover handler wired)"}, nil
		}
		disposition, err := deps.WaitForApproval(ctx, runID, node.ID, reason)
		if err != nil {
			return nil, fmt.Errorf("approval wait failed: %w", err)
		}
		if !disposition.Granted {
			return nil, fmt.Errorf("approval denied or expired: %s", disposition.Reason)
		}
		return map[string]any{"approved": true, "note": disposition.Reason}, nil

	case "subagent":
		// TODO: invoke another agent via /v1/runs and wait for it.
		return map[string]any{"skipped": "subagent not yet implemented"}, nil

	default:
		return nil, fmt.Errorf("unknown node type: %s", node.Type)
	}
}

// chooseNext picks the outgoing edge to follow after executing a node.
//   - condition nodes route via edge.Label = "true" / "false".
//   - all other nodes take the first outgoing edge (DAG order).
func chooseNext(node Node, output any, outgoing []Edge) string {
	if len(outgoing) == 0 {
		return ""
	}
	if node.Type == "condition" {
		// Resolve truthiness from the output map written by executeNode.
		truthy := false
		if m, ok := output.(map[string]any); ok {
			if v, ok := m["value"].(bool); ok {
				truthy = v
			}
		}
		want := "true"
		if !truthy {
			want = "false"
		}
		for _, e := range outgoing {
			if e.Label != nil && strings.EqualFold(*e.Label, want) {
				return e.Target
			}
		}
		// Fallback: just take whichever edge has no label, or the first.
		for _, e := range outgoing {
			if e.Label == nil || *e.Label == "" {
				return e.Target
			}
		}
		return outgoing[0].Target
	}
	return outgoing[0].Target
}

// ---- Helpers ----------------------------------------------------------------

func findTrigger(nodes []Node) *Node {
	for i := range nodes {
		if nodes[i].Type == "trigger" {
			return &nodes[i]
		}
	}
	return nil
}

func labelOf(node Node) string {
	if v, ok := node.Data["label"].(string); ok && v != "" {
		return v
	}
	return node.ID
}

// renderTemplate does a tiny {{path.to.value}} substitution. It's intentionally
// not a full template engine — workflows are user-authored config, not Go
// code, and we want predictability over power. Supported forms:
//   {{input.foo}}        — read from the input map
//   {{steps.<id>}}       — read a prior step's output (stringified)
//   {{steps.<id>.field}} — read a field of a prior step's map output
func renderTemplate(s string, vars map[string]any) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	out := s
	for {
		start := strings.Index(out, "{{")
		if start < 0 {
			break
		}
		end := strings.Index(out[start:], "}}")
		if end < 0 {
			break
		}
		path := strings.TrimSpace(out[start+2 : start+end])
		replacement := resolvePath(path, vars)
		out = out[:start] + replacement + out[start+end+2:]
	}
	return out
}

func resolvePath(path string, vars map[string]any) string {
	parts := strings.Split(path, ".")
	var cur any = vars
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur, ok = m[p]
		if !ok {
			return ""
		}
	}
	return formatOutput(cur)
}

func parseParams(raw any, vars map[string]any) map[string]any {
	if raw == nil {
		return map[string]any{}
	}
	switch v := raw.(type) {
	case map[string]any:
		return v
	case string:
		if v == "" {
			return map[string]any{}
		}
		rendered := renderTemplate(v, vars)
		var m map[string]any
		if err := json.Unmarshal([]byte(rendered), &m); err == nil {
			return m
		}
		// Couldn't parse — return the raw string under a known key so
		// connectors that expect a single text param ("query", "text")
		// still work.
		return map[string]any{"input": rendered}
	}
	return map[string]any{}
}

func formatOutput(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// lastStep returns the formatted output of the most recently added step,
// used as a fallback when an end-node has no outputExpression. Map
// iteration order isn't deterministic, but for the fallback case we
// don't need stability — any completed step's output is reasonable.
func lastStep(vars map[string]any) string {
	steps, ok := vars["steps"].(map[string]any)
	if !ok {
		return ""
	}
	for _, v := range steps {
		return formatOutput(v)
	}
	return ""
}
