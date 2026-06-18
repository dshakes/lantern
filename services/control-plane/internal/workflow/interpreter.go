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

	// RunSubAgent invokes a named agent with the given input and waits for
	// its output. When nil, subagent nodes emit a skipped result rather
	// than failing the run — consistent with the WaitForApproval nil
	// contract. Production wiring (rest.go) is a follow-up; the interpreter
	// stays decoupled from HTTP here.
	RunSubAgent func(ctx context.Context, agentName string, input map[string]any) (map[string]any, error)

	// CompletedStep checks whether a node has already been successfully
	// executed in a prior attempt of this run. If done is true, the
	// interpreter reuses output rather than re-invoking side-effecting deps
	// (LLM, connector, subagent), making re-runs idempotent on replay.
	// When nil (e.g. in tests that don't opt in), each node always executes.
	CompletedStep func(ctx context.Context, runID, stepID string) (output map[string]any, done bool, err error)
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

		stepOutput, stepErr := executeNode(stepCtx, runID, deps, emit, node, vars, out, byID)
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

// emitFn is a convenience alias for the emit closure passed through execution.
type emitFn func(kind, stepID string, payload map[string]any)

func executeNode(ctx context.Context, runID string, deps Deps, emit emitFn, node Node, vars map[string]any, out map[string][]Edge, byID map[string]Node) (any, error) {
	// Replay idempotency: before touching any side-effecting dep, check
	// whether this node was already completed in a prior attempt. Pure
	// structural nodes (trigger, condition, end) are always re-evaluated —
	// they are cheap and their "output" is just derived state, not a
	// billable or side-effecting operation.
	switch node.Type {
	case "ai-step", "tool", "connector", "subagent", "approval":
		if deps.CompletedStep != nil {
			if cached, done, csErr := deps.CompletedStep(ctx, runID, node.ID); csErr == nil && done {
				return cached, nil
			}
			// On error we fall through and re-execute — safe to retry.
		}
	}

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
		return executeLoop(ctx, runID, deps, emit, node, vars, out, byID)

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
		if deps.RunSubAgent == nil {
			return map[string]any{"skipped": "no subagent runner wired"}, nil
		}
		agentName, _ := node.Data["agentName"].(string)
		if agentName == "" {
			return nil, fmt.Errorf("subagent node requires agentName")
		}
		inputMapping := parseParams(node.Data["inputMapping"], vars)
		result, err := deps.RunSubAgent(ctx, agentName, inputMapping)
		if err != nil {
			return nil, fmt.Errorf("subagent %q failed: %w", agentName, err)
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unknown node type: %s", node.Type)
	}
}

// chooseNext picks the outgoing edge to follow after executing a node.
//   - condition nodes route via edge.Label = "true" / "false".
//   - loop nodes have a reserved "body" edge that drives the inner subgraph;
//     after executeLoop returns, the top-level walk follows the first
//     non-body edge (i.e. the "next" / continuation edge).
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
	if node.Type == "loop" {
		// The "body" edge is consumed by executeLoop internally. The top-level
		// walk must continue on the first non-body edge (the continuation /
		// "next" path). If all edges are body edges (malformed graph), fall
		// through to the first edge so the run still terminates.
		for _, e := range outgoing {
			if e.Label == nil || !strings.EqualFold(*e.Label, "body") {
				return e.Target
			}
		}
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
//
//	{{input.foo}}        — read from the input map
//	{{steps.<id>}}       — read a prior step's output (stringified)
//	{{steps.<id>.field}} — read a field of a prior step's map output
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

// executeLoop handles the "loop" node type. It resolves an array from
// node.Data["arrayExpression"] (a {{...}} template that must resolve to a JSON
// array, or a bare JSON array literal), iterates over each element, and
// executes the body subgraph — the subgraph reachable via the edge labelled
// "body" — for each element.
//
// Loop variables available inside the body:
//
//	{{loop.item}}   — the current element (stringified)
//	{{loop.index}}  — the 0-based iteration index
//
// A safety cap (node.Data["maxIterations"], default 1000) prevents runaway
// loops. Exceeding it returns an error so the run records step_failed.
//
// Returns {"iterations": N, "results": [...]}.
func executeLoop(ctx context.Context, runID string, deps Deps, emit emitFn, node Node, vars map[string]any, out map[string][]Edge, byID map[string]Node) (any, error) {
	const defaultMaxIterations = 1000

	// Resolve the array to iterate over.
	exprRaw, _ := node.Data["arrayExpression"].(string)
	rendered := renderTemplate(exprRaw, vars)

	var items []any
	if rendered != "" {
		if err := json.Unmarshal([]byte(rendered), &items); err != nil {
			// Not a JSON array — treat the single resolved value as a one-element list.
			items = []any{rendered}
		}
	}
	// Empty or missing expression → zero iterations, clean completion.

	// Safety cap.
	maxIter := defaultMaxIterations
	if v, ok := node.Data["maxIterations"].(float64); ok && v > 0 {
		maxIter = int(v)
	}
	if len(items) > maxIter {
		return nil, fmt.Errorf("loop node %q: array length %d exceeds maxIterations=%d", node.ID, len(items), maxIter)
	}

	// Find the body-edge target node (edge with label "body").
	bodyStart := ""
	for _, e := range out[node.ID] {
		if e.Label != nil && strings.EqualFold(*e.Label, "body") {
			bodyStart = e.Target
			break
		}
	}

	results := make([]any, 0, len(items))

	// Soft anomaly threshold: 80% of the hard cap. When exceeded we emit an
	// anomaly_detected journal event but continue — the hard cap in the
	// array-length check above is what actually stops execution.
	softThreshold := int(float64(maxIter) * 0.80)
	anomalyEmitted := false

	for i, item := range items {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("loop cancelled at iteration %d: %w", i, err)
		}

		// Emit a single runaway_loop anomaly when we cross the soft threshold.
		if !anomalyEmitted && i >= softThreshold {
			anomalyEmitted = true
			emit("anomaly_detected", node.ID, map[string]any{
				"kind":     string(KindRunawayLoop),
				"observed": i + 1,
				"limit":    maxIter,
				"message":  fmt.Sprintf("loop node %q: iteration %d approaching maxIterations=%d", node.ID, i+1, maxIter),
			})
		}

		// Shallow-copy vars so loop.item/loop.index are per-iteration while
		// "steps" and "input" remain shared (later body nodes can reference
		// prior step outputs from earlier in the workflow).
		iterVars := shallowCopyVars(vars)
		iterVars["loop"] = map[string]any{
			"item":  item,
			"index": i,
		}

		emit("loop.iteration_started", node.ID, map[string]any{
			"loopNodeId": node.ID,
			"index":      i,
			"item":       item,
		})

		var iterResult any
		var iterErr error

		if bodyStart == "" {
			// No body edge — pass-through with the item as the result.
			iterResult = map[string]any{"index": i, "item": item}
		} else {
			iterResult, iterErr = runSubgraph(ctx, runID, deps, emit, bodyStart, iterVars, out, byID, node.ID)
		}

		if iterErr != nil {
			return nil, fmt.Errorf("loop iteration %d failed: %w", i, iterErr)
		}

		emit("loop.iteration_completed", node.ID, map[string]any{
			"loopNodeId": node.ID,
			"index":      i,
			"result":     truncate(formatOutput(iterResult), 300),
		})

		results = append(results, iterResult)
	}

	return map[string]any{
		"iterations": len(items),
		"results":    results,
	}, nil
}

// runSubgraph walks the body subgraph of a loop node starting from startID.
// Stops when it reaches a node with no outgoing edge, an "end" node, or when
// the next node is loopNodeID (the loop boundary — prevents re-entering the
// loop). Returns the last body node's result.
func runSubgraph(ctx context.Context, runID string, deps Deps, emit emitFn, startID string, vars map[string]any, out map[string][]Edge, byID map[string]Node, loopNodeID string) (any, error) {
	const maxBodySteps = 50

	current := startID
	var lastResult any
	for step := 0; step < maxBodySteps; step++ {
		if current == loopNodeID {
			break
		}
		node, ok := byID[current]
		if !ok {
			return nil, fmt.Errorf("loop body: unknown node %q", current)
		}
		if node.Type == "end" {
			break
		}

		result, err := executeNode(ctx, runID, deps, emit, node, vars, out, byID)
		if err != nil {
			return nil, err
		}
		lastResult = result

		// Store in vars so later body nodes can reference earlier body steps.
		if stepsMap, ok := vars["steps"].(map[string]any); ok {
			stepsMap[node.ID] = result
		}

		next := chooseNext(node, result, out[node.ID])
		if next == "" {
			break
		}
		current = next
	}
	return lastResult, nil
}

// shallowCopyVars makes a one-level copy of the vars map so per-iteration
// keys ("loop") are isolated while shared references ("steps", "input")
// remain visible across iterations.
func shallowCopyVars(vars map[string]any) map[string]any {
	cp := make(map[string]any, len(vars))
	for k, v := range vars {
		cp[k] = v
	}
	return cp
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
