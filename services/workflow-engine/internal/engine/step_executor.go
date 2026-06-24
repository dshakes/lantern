package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/workflow-engine/internal/journal"
)

// ErrModelRouterUnavailable is returned by an llm_call step when the engine was
// started without a configured model-router address (no ModelServiceClient).
// The step fails honestly rather than returning a fabricated completion.
var ErrModelRouterUnavailable = errors.New("model router not configured (set LANTERN_MODEL_ROUTER_ADDR)")

// ErrRuntimeManagerUnavailable is returned by a tool_call step when the engine
// was started without a configured runtime-manager address (no
// RuntimeManagerClient). The step fails honestly rather than fabricating a
// tool result.
var ErrRuntimeManagerUnavailable = errors.New("runtime manager not configured (set LANTERN_RUNTIME_MANAGER_ADDR)")

// StepPayload is the decoded payload from a step request. The Kind field
// determines what the step does (llm_call, tool_call, sleep, signal, etc.)
// and the Data field carries kind-specific parameters.
type StepPayload struct {
	Kind       string          `json:"kind"`
	Data       json.RawMessage `json:"data,omitempty"`
	MaxRetries int             `json:"max_retries,omitempty"`
	TimeoutSec int             `json:"timeout_sec,omitempty"`
}

// StepExecutor handles the execution of individual steps within a run.
// It implements the replay-or-execute logic that makes the workflow engine
// durable: completed steps return cached results, new steps execute for real.
//
// The workflow engine is the canonical "go through the model router" consumer
// (architectural invariant #6): LLM steps dispatch to ModelService.Complete on
// the model router, never to a provider directly. modelClient is the gRPC
// client for that service. It may be nil when the engine is started without a
// configured model-router address — in that case LLM steps return a typed
// error rather than a fabricated result.
type StepExecutor struct {
	pool          *pgxpool.Pool
	streamer      *EventStreamer
	logger        *zap.Logger
	modelClient   lanternv1.ModelServiceClient
	runtimeClient lanternv1.RuntimeManagerClient
}

// NewStepExecutor creates a new StepExecutor. modelClient may be nil; LLM steps
// then return a typed ErrModelRouterUnavailable instead of executing.
// runtimeClient may be nil; tool_call steps then return a typed
// ErrRuntimeManagerUnavailable instead of executing.
func NewStepExecutor(pool *pgxpool.Pool, streamer *EventStreamer, logger *zap.Logger, modelClient lanternv1.ModelServiceClient, runtimeClient lanternv1.RuntimeManagerClient) *StepExecutor {
	return &StepExecutor{
		pool:          pool,
		streamer:      streamer,
		logger:        logger.Named("step_executor"),
		modelClient:   modelClient,
		runtimeClient: runtimeClient,
	}
}

// ExecuteStep runs a single step within the context of a run. The core logic:
//  1. Check if the journal already has a step_completed for this (stepID, attempt) — REPLAY path.
//  2. If not, journal step_started, execute the step, then journal step_completed or step_failed.
//  3. On failure: check retry policy, increment attempt, retry or propagate failure.
//
// The idempotency key for external side-effects is derived from (run_id, step_id, attempt).
func (se *StepExecutor) ExecuteStep(ctx context.Context, state *RunState, stepID string, payload *StepPayload) (*StepResult, error) {
	maxAttempts := 1
	if payload.MaxRetries > 0 {
		maxAttempts = payload.MaxRetries + 1
	}

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		result, err := se.executeAttempt(ctx, state, stepID, attempt, payload)
		if err != nil {
			return nil, err
		}

		// If the step succeeded, return the result.
		if result.Error == "" {
			return result, nil
		}

		// If this was the last attempt, return the failure.
		if attempt >= maxAttempts {
			return result, nil
		}

		se.logger.Info("step failed, retrying",
			zap.String("run_id", state.RunID),
			zap.String("step_id", stepID),
			zap.Int("attempt", attempt),
			zap.Int("max_attempts", maxAttempts),
			zap.String("error", result.Error),
		)
	}

	// Unreachable, but the compiler needs it.
	return nil, fmt.Errorf("step execution exhausted all attempts")
}

// executeAttempt runs a single attempt of a step. If the journal already
// contains a result for this (stepID, attempt), it returns the cached result.
func (se *StepExecutor) executeAttempt(ctx context.Context, state *RunState, stepID string, attempt int, payload *StepPayload) (*StepResult, error) {
	// --- REPLAY CHECK ---
	// Look for an existing completed/failed result in the in-memory state.
	cacheKey := stepCacheKey(stepID, attempt)
	if cached, ok := state.HasStepResult(cacheKey); ok {
		se.logger.Debug("step replayed from journal",
			zap.String("run_id", state.RunID),
			zap.String("step_id", stepID),
			zap.Int("attempt", attempt),
		)
		return cached, nil
	}

	// --- EXECUTE ---
	// Journal step_started.
	if err := se.journalStepStarted(ctx, state, stepID, attempt, payload); err != nil {
		return nil, fmt.Errorf("journal step_started: %w", err)
	}

	// Publish stream event for step_started.
	se.streamer.Publish(ctx, &StreamEvent{
		RunID:  state.RunID,
		StepID: stepID,
		Seq:    lastSeq(state),
		Kind:   journal.KindStepStarted,
		Payload: mustMarshal(map[string]any{
			"kind":    payload.Kind,
			"attempt": attempt,
		}),
		TS: time.Now().UTC(),
	})

	// Apply timeout if configured.
	execCtx := ctx
	if payload.TimeoutSec > 0 {
		var cancel context.CancelFunc
		execCtx, cancel = context.WithTimeout(ctx, time.Duration(payload.TimeoutSec)*time.Second)
		defer cancel()
	}

	// Execute the actual step logic.
	start := time.Now()
	output, execErr := se.dispatch(execCtx, state, stepID, attempt, payload)
	durationMs := float64(time.Since(start).Milliseconds())

	if execErr != nil {
		// Journal step_failed.
		result := &StepResult{
			StepID:  stepID,
			Attempt: attempt,
			Error:   execErr.Error(),
		}

		if err := se.journalStepFailed(ctx, state, stepID, attempt, result, attempt < maxRetries(payload)+1); err != nil {
			return nil, fmt.Errorf("journal step_failed: %w", err)
		}

		// Publish stream event for step_failed.
		se.streamer.Publish(ctx, &StreamEvent{
			RunID:  state.RunID,
			StepID: stepID,
			Seq:    lastSeq(state),
			Kind:   journal.KindStepFailed,
			Payload: mustMarshal(map[string]any{
				"attempt":       attempt,
				"error_message": execErr.Error(),
				"will_retry":    attempt < maxRetries(payload)+1,
				"duration_ms":   durationMs,
			}),
			TS: time.Now().UTC(),
		})

		state.SetStepResult(cacheKey, result)
		return result, nil
	}

	// Journal step_completed.
	result := &StepResult{
		StepID:  stepID,
		Attempt: attempt,
		Output:  output,
	}

	if err := se.journalStepCompleted(ctx, state, stepID, attempt, result, durationMs); err != nil {
		return nil, fmt.Errorf("journal step_completed: %w", err)
	}

	// Publish stream event for step_completed.
	se.streamer.Publish(ctx, &StreamEvent{
		RunID:  state.RunID,
		StepID: stepID,
		Seq:    lastSeq(state),
		Kind:   journal.KindStepCompleted,
		Payload: mustMarshal(map[string]any{
			"attempt":     attempt,
			"duration_ms": durationMs,
		}),
		TS: time.Now().UTC(),
	})

	state.SetStepResult(cacheKey, result)
	return result, nil
}

// dispatch routes a step to the appropriate executor based on its kind.
// All external side-effects use the idempotency key (run_id, step_id, attempt).
func (se *StepExecutor) dispatch(ctx context.Context, state *RunState, stepID string, attempt int, payload *StepPayload) (json.RawMessage, error) {
	idempotencyKey := fmt.Sprintf("%s:%s:%d", state.RunID, stepID, attempt)

	switch payload.Kind {
	case "llm_call":
		return se.executeLLMCall(ctx, state, stepID, idempotencyKey, payload.Data)
	case "tool_call":
		return se.executeToolCall(ctx, state, stepID, idempotencyKey, payload.Data)
	case "sleep":
		return se.executeSleep(ctx, state, stepID, payload.Data)
	case "wait_signal":
		return se.executeWaitSignal(ctx, state, stepID, payload.Data)
	case "child_run":
		return se.executeChildRun(ctx, state, stepID, idempotencyKey, payload.Data)
	case "approval":
		return se.executeApproval(ctx, state, stepID, payload.Data)
	default:
		return nil, fmt.Errorf("unknown step kind: %s", payload.Kind)
	}
}

// llmCallPayload is the decoded payload for an llm_call step. Either a single
// prompt (wrapped into a one-message user turn) or an explicit messages array
// may be supplied. capability is the capability-addressed model selector
// (invariant #6); optimize is the routing target (cheap/fast/best/balanced).
type llmCallPayload struct {
	Capability  string       `json:"capability"`
	Optimize    string       `json:"optimize,omitempty"`
	Prompt      string       `json:"prompt,omitempty"`
	Messages    []llmMessage `json:"messages,omitempty"`
	MaxTokens   int32        `json:"max_tokens,omitempty"`
	Temperature float64      `json:"temperature,omitempty"`
}

type llmMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// executeLLMCall sends a request to the model router via ModelService.Complete.
// The model router resolves capability -> concrete vendor model, applies
// caching, and meters usage. We never call LLM providers directly
// (architectural invariant #6). The idempotency key (run_id:step_id:attempt)
// is forwarded so retries de-duplicate the external side-effect (invariant #8).
func (se *StepExecutor) executeLLMCall(ctx context.Context, state *RunState, stepID, idempotencyKey string, data json.RawMessage) (json.RawMessage, error) {
	se.logger.Info("executing llm_call step",
		zap.String("run_id", state.RunID),
		zap.String("step_id", stepID),
		zap.String("idempotency_key", idempotencyKey),
	)

	if se.modelClient == nil {
		return nil, ErrModelRouterUnavailable
	}

	var req llmCallPayload
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("invalid llm_call payload: %w", err)
	}

	messages := make([]*lanternv1.Message, 0, len(req.Messages)+1)
	for _, m := range req.Messages {
		messages = append(messages, &lanternv1.Message{Role: m.Role, Content: m.Content})
	}
	if req.Prompt != "" {
		messages = append(messages, &lanternv1.Message{Role: "user", Content: req.Prompt})
	}
	if len(messages) == 0 {
		return nil, fmt.Errorf("invalid llm_call payload: no prompt or messages provided")
	}

	completeReq := &lanternv1.CompleteRequest{
		RunId:          state.RunID,
		StepId:         stepID,
		TenantId:       state.TenantID,
		Capability:     capabilityFromString(req.Capability),
		Optimize:       optimizeFromString(req.Optimize),
		Messages:       messages,
		MaxTokens:      req.MaxTokens,
		Temperature:    req.Temperature,
		IdempotencyKey: idempotencyKey,
	}

	resp, err := se.modelClient.Complete(ctx, completeReq)
	if err != nil {
		return nil, fmt.Errorf("model-router Complete: %w", err)
	}

	var text string
	if resp.GetMessage() != nil {
		text = resp.GetMessage().GetContent()
	}

	result := map[string]any{
		"text":       text,
		"model_used": resp.GetModelUsed(),
		"tokens_in":  resp.GetTokensIn(),
		"tokens_out": resp.GetTokensOut(),
		"cost_usd":   resp.GetCostUsd(),
	}
	return json.Marshal(result)
}

// toolCallPayload is the decoded payload for a tool_call step. tool_name is the
// tool to invoke against the run's workload; arguments is the structured
// argument object (forwarded verbatim as a protobuf Struct); vm_id optionally
// pins the target VM when the caller already knows it (the runtime manager
// otherwise resolves the workload from run_id).
type toolCallPayload struct {
	ToolName  string          `json:"tool_name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	VMID      string          `json:"vm_id,omitempty"`
}

// executeToolCall invokes a single named tool within the runtime sandbox. All
// tool execution happens inside a microVM (architectural invariant #5), so the
// engine dispatches to RuntimeManager.ExecTool rather than running anything
// in-process. The idempotency key (run_id:step_id:attempt) is forwarded so a
// retried tool side-effect de-duplicates (invariant #8).
//
// The runtime manager returns a typed ToolStatus: OK maps to the step output,
// ERROR and UNAVAILABLE both fail the step with the manager's detail so the gap
// (or the tool's own failure) is visible rather than fabricated.
func (se *StepExecutor) executeToolCall(ctx context.Context, state *RunState, stepID, idempotencyKey string, data json.RawMessage) (json.RawMessage, error) {
	se.logger.Info("executing tool_call step",
		zap.String("run_id", state.RunID),
		zap.String("step_id", stepID),
		zap.String("idempotency_key", idempotencyKey),
	)

	if se.runtimeClient == nil {
		return nil, ErrRuntimeManagerUnavailable
	}

	var req toolCallPayload
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("invalid tool_call payload: %w", err)
	}
	if req.ToolName == "" {
		return nil, fmt.Errorf("invalid tool_call payload: tool_name is required")
	}

	// Decode the structured arguments into a protobuf Struct. An absent or null
	// arguments object is fine (some tools take no args).
	var args *structpb.Struct
	if len(req.Arguments) > 0 {
		var argMap map[string]any
		if err := json.Unmarshal(req.Arguments, &argMap); err != nil {
			return nil, fmt.Errorf("invalid tool_call arguments: %w", err)
		}
		if argMap != nil {
			s, err := structpb.NewStruct(argMap)
			if err != nil {
				return nil, fmt.Errorf("encode tool_call arguments: %w", err)
			}
			args = s
		}
	}

	execReq := &lanternv1.ExecToolRequest{
		VmId:           req.VMID,
		RunId:          state.RunID,
		StepId:         stepID,
		ToolName:       req.ToolName,
		Args:           args,
		IdempotencyKey: idempotencyKey,
	}

	// Forward the step's remaining deadline (set from StepPayload.TimeoutSec) so
	// the manager can cap the in-VM tool invocation to the same budget.
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 {
			execReq.Timeout = durationpb.New(remaining)
		}
	}

	resp, err := se.runtimeClient.ExecTool(ctx, execReq)
	if err != nil {
		return nil, fmt.Errorf("runtime-manager ExecTool (tool %q): %w", req.ToolName, err)
	}

	switch resp.GetStatus() {
	case lanternv1.ToolStatus_TOOL_STATUS_OK:
		result := map[string]any{
			"tool_name": req.ToolName,
			"result":    resp.GetResult().AsMap(),
		}
		return json.Marshal(result)
	case lanternv1.ToolStatus_TOOL_STATUS_ERROR:
		return nil, fmt.Errorf("tool %q failed: %s", req.ToolName, resp.GetError())
	case lanternv1.ToolStatus_TOOL_STATUS_UNAVAILABLE:
		return nil, fmt.Errorf("tool %q unavailable: %s: %w", req.ToolName, resp.GetError(), ErrRuntimeManagerUnavailable)
	default:
		return nil, fmt.Errorf("tool %q: unexpected runtime status %v", req.ToolName, resp.GetStatus())
	}
}

// capabilityFromString maps a capability selector string (as used by the SDK,
// e.g. "auto", "reasoning-large", "chat-small") to the proto enum. Unknown or
// empty values fall back to CAPABILITY_AUTO so the model router still routes.
func capabilityFromString(s string) lanternv1.Capability {
	switch normalizeSelector(s) {
	case "reasoning-frontier":
		return lanternv1.Capability_CAPABILITY_REASONING_FRONTIER
	case "reasoning-large":
		return lanternv1.Capability_CAPABILITY_REASONING_LARGE
	case "reasoning-small":
		return lanternv1.Capability_CAPABILITY_REASONING_SMALL
	case "chat-large":
		return lanternv1.Capability_CAPABILITY_CHAT_LARGE
	case "chat-small":
		return lanternv1.Capability_CAPABILITY_CHAT_SMALL
	case "chat-edge":
		return lanternv1.Capability_CAPABILITY_CHAT_EDGE
	case "vision-large":
		return lanternv1.Capability_CAPABILITY_VISION_LARGE
	case "vision-small":
		return lanternv1.Capability_CAPABILITY_VISION_SMALL
	case "code-large":
		return lanternv1.Capability_CAPABILITY_CODE_LARGE
	case "code-small":
		return lanternv1.Capability_CAPABILITY_CODE_SMALL
	case "", "auto":
		return lanternv1.Capability_CAPABILITY_AUTO
	default:
		return lanternv1.Capability_CAPABILITY_AUTO
	}
}

// optimizeFromString maps an optimize-target selector to the proto enum.
func optimizeFromString(s string) lanternv1.OptimizeTarget {
	switch normalizeSelector(s) {
	case "cheap":
		return lanternv1.OptimizeTarget_OPTIMIZE_CHEAP
	case "fast":
		return lanternv1.OptimizeTarget_OPTIMIZE_FAST
	case "best":
		return lanternv1.OptimizeTarget_OPTIMIZE_BEST
	case "balanced":
		return lanternv1.OptimizeTarget_OPTIMIZE_BALANCED
	default:
		return lanternv1.OptimizeTarget_OPTIMIZE_UNSPECIFIED
	}
}

// normalizeSelector lowercases and converts underscores to hyphens so both
// "reasoning_large" and "reasoning-large" resolve identically.
func normalizeSelector(s string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), "_", "-")
}

// executeSleep pauses the run for a specified duration. The sleep is journaled
// so that on replay, the engine skips to the completion time rather than
// sleeping again.
func (se *StepExecutor) executeSleep(ctx context.Context, state *RunState, stepID string, data json.RawMessage) (json.RawMessage, error) {
	var req struct {
		DurationSec int `json:"duration_sec"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("invalid sleep payload: %w", err)
	}

	se.logger.Info("executing sleep step",
		zap.String("run_id", state.RunID),
		zap.String("step_id", stepID),
		zap.Int("duration_sec", req.DurationSec),
	)

	// Journal that we're sleeping.
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	sleepEntry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindSleepStarted,
		StepID:  stepID,
		Attempt: 1,
		Payload: data,
	}
	if err := journal.Append(ctx, tx, sleepEntry); err != nil {
		return nil, fmt.Errorf("journal sleep_started: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit sleep_started: %w", err)
	}
	state.AppendJournal(*sleepEntry)

	// Actually sleep (in production, this would suspend the run and a scheduler
	// timer would resume it — but for the spike, we block the goroutine).
	timer := time.NewTimer(time.Duration(req.DurationSec) * time.Second)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
	}

	// Journal sleep completed.
	tx2, err := se.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx2.Rollback(ctx) //nolint:errcheck

	completeEntry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindSleepCompleted,
		StepID:  stepID,
		Attempt: 1,
		Payload: mustMarshal(map[string]any{"duration_sec": req.DurationSec}),
	}
	if err := journal.Append(ctx, tx2, completeEntry); err != nil {
		return nil, fmt.Errorf("journal sleep_completed: %w", err)
	}
	if err := tx2.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit sleep_completed: %w", err)
	}
	state.AppendJournal(*completeEntry)

	return json.Marshal(map[string]any{"slept_sec": req.DurationSec})
}

// executeWaitSignal pauses the run until an external signal is delivered.
// The signal channel is stored in RunState so that SignalRun can deliver it.
func (se *StepExecutor) executeWaitSignal(ctx context.Context, state *RunState, stepID string, data json.RawMessage) (json.RawMessage, error) {
	var req struct {
		SignalName string `json:"signal_name"`
		TimeoutSec int    `json:"timeout_sec,omitempty"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("invalid wait_signal payload: %w", err)
	}

	se.logger.Info("waiting for signal",
		zap.String("run_id", state.RunID),
		zap.String("step_id", stepID),
		zap.String("signal_name", req.SignalName),
	)

	// Journal that we're waiting.
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	waitEntry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindSignalWaiting,
		StepID:  req.SignalName,
		Attempt: 1,
		Payload: data,
	}
	if err := journal.Append(ctx, tx, waitEntry); err != nil {
		return nil, fmt.Errorf("journal signal_waiting: %w", err)
	}

	// Update run status to paused.
	if _, err := tx.Exec(ctx, `UPDATE runs SET status = 'paused' WHERE id = $1`, state.RunID); err != nil {
		return nil, fmt.Errorf("update run status: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit signal_waiting: %w", err)
	}
	state.AppendJournal(*waitEntry)
	state.SetStatus("paused")

	// Publish stream event.
	se.streamer.Publish(ctx, &StreamEvent{
		RunID:  state.RunID,
		StepID: stepID,
		Seq:    lastSeq(state),
		Kind:   journal.KindSignalWaiting,
		Payload: mustMarshal(map[string]any{
			"signal_name": req.SignalName,
		}),
		TS: time.Now().UTC(),
	})

	// Wait for the signal.
	ch := state.WaitForSignal(req.SignalName)

	var waitCtx context.Context
	var cancel context.CancelFunc
	if req.TimeoutSec > 0 {
		waitCtx, cancel = context.WithTimeout(ctx, time.Duration(req.TimeoutSec)*time.Second)
	} else {
		waitCtx, cancel = context.WithCancel(ctx)
	}
	defer cancel()

	select {
	case <-waitCtx.Done():
		return nil, fmt.Errorf("signal %q timed out or cancelled", req.SignalName)
	case value := <-ch:
		// Journal signal received.
		tx2, err := se.pool.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("begin tx: %w", err)
		}
		defer tx2.Rollback(ctx) //nolint:errcheck

		valueBytes, _ := json.Marshal(value)
		recvEntry := &journal.JournalEntry{
			RunID:   state.RunID,
			Kind:    journal.KindSignalReceived,
			StepID:  req.SignalName,
			Attempt: 1,
			Payload: valueBytes,
		}
		if err := journal.Append(ctx, tx2, recvEntry); err != nil {
			return nil, fmt.Errorf("journal signal_received: %w", err)
		}

		// Resume run.
		if _, err := tx2.Exec(ctx, `UPDATE runs SET status = 'running' WHERE id = $1`, state.RunID); err != nil {
			return nil, fmt.Errorf("update run status: %w", err)
		}
		if err := tx2.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit signal_received: %w", err)
		}
		state.AppendJournal(*recvEntry)
		state.SetStatus("running")

		return valueBytes, nil
	}
}

// executeChildRun starts a child run. The parent run waits for the child
// to complete. Child runs are tracked via child_started/child_completed
// journal events.
func (se *StepExecutor) executeChildRun(ctx context.Context, state *RunState, stepID, idempotencyKey string, data json.RawMessage) (json.RawMessage, error) {
	se.logger.Info("executing child_run step",
		zap.String("run_id", state.RunID),
		zap.String("step_id", stepID),
		zap.String("idempotency_key", idempotencyKey),
	)

	// In the full implementation, this creates a child run via the control plane
	// and waits for it to complete. The child run's output becomes this step's output.
	var req struct {
		AgentName string          `json:"agent_name"`
		Input     json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("invalid child_run payload: %w", err)
	}

	// Journal child_started.
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	childEntry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindChildStarted,
		StepID:  stepID,
		Attempt: 1,
		Payload: data,
	}
	if err := journal.Append(ctx, tx, childEntry); err != nil {
		return nil, fmt.Errorf("journal child_started: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit child_started: %w", err)
	}
	state.AppendJournal(*childEntry)

	// Placeholder: in production, this dispatches to the control plane.
	result := map[string]any{
		"child_run_id": fmt.Sprintf("child-%s-%s", state.RunID[:8], stepID),
		"status":       "completed",
		"output":       fmt.Sprintf("[child run placeholder for agent=%s]", req.AgentName),
	}
	resultBytes, _ := json.Marshal(result)

	// Journal child_completed.
	tx2, err := se.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx2.Rollback(ctx) //nolint:errcheck

	completeEntry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindChildCompleted,
		StepID:  stepID,
		Attempt: 1,
		Payload: resultBytes,
	}
	if err := journal.Append(ctx, tx2, completeEntry); err != nil {
		return nil, fmt.Errorf("journal child_completed: %w", err)
	}
	if err := tx2.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit child_completed: %w", err)
	}
	state.AppendJournal(*completeEntry)

	return resultBytes, nil
}

// executeApproval pauses the run until a human approves or denies the request.
func (se *StepExecutor) executeApproval(ctx context.Context, state *RunState, stepID string, data json.RawMessage) (json.RawMessage, error) {
	var req struct {
		Reason     string   `json:"reason"`
		Approvers  []string `json:"approvers"`
		TimeoutSec int      `json:"timeout_sec,omitempty"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("invalid approval payload: %w", err)
	}

	se.logger.Info("requesting approval",
		zap.String("run_id", state.RunID),
		zap.String("step_id", stepID),
		zap.String("reason", req.Reason),
	)

	// Journal approval_requested.
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	reqEntry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindApprovalRequested,
		StepID:  stepID,
		Attempt: 1,
		Payload: data,
	}
	if err := journal.Append(ctx, tx, reqEntry); err != nil {
		return nil, fmt.Errorf("journal approval_requested: %w", err)
	}

	// Pause the run.
	if _, err := tx.Exec(ctx, `UPDATE runs SET status = 'paused' WHERE id = $1`, state.RunID); err != nil {
		return nil, fmt.Errorf("update run status: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit approval_requested: %w", err)
	}
	state.AppendJournal(*reqEntry)
	state.SetStatus("paused")

	// Publish stream event.
	se.streamer.Publish(ctx, &StreamEvent{
		RunID:  state.RunID,
		StepID: stepID,
		Seq:    lastSeq(state),
		Kind:   journal.KindApprovalRequested,
		Payload: mustMarshal(map[string]any{
			"reason":    req.Reason,
			"approvers": req.Approvers,
		}),
		TS: time.Now().UTC(),
	})

	// Wait for approval signal. Approval is delivered as a signal with
	// name "approval:<step_id>".
	signalName := "approval:" + stepID
	ch := state.WaitForSignal(signalName)

	var waitCtx context.Context
	var cancel context.CancelFunc
	if req.TimeoutSec > 0 {
		waitCtx, cancel = context.WithTimeout(ctx, time.Duration(req.TimeoutSec)*time.Second)
	} else {
		waitCtx, cancel = context.WithCancel(ctx)
	}
	defer cancel()

	select {
	case <-waitCtx.Done():
		// Timeout — treat as denial.
		tx3, err := se.pool.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("begin tx: %w", err)
		}
		defer tx3.Rollback(ctx) //nolint:errcheck

		deniedEntry := &journal.JournalEntry{
			RunID:   state.RunID,
			Kind:    journal.KindApprovalDenied,
			StepID:  stepID,
			Attempt: 1,
			Payload: mustMarshal(map[string]string{"reason": "timeout"}),
		}
		if err := journal.Append(ctx, tx3, deniedEntry); err != nil {
			return nil, fmt.Errorf("journal approval_denied: %w", err)
		}
		if err := tx3.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit approval_denied: %w", err)
		}
		state.AppendJournal(*deniedEntry)

		return nil, fmt.Errorf("approval timed out for step %s", stepID)

	case value := <-ch:
		// Parse the approval response.
		valueBytes, _ := json.Marshal(value)
		var response struct {
			Approved bool   `json:"approved"`
			By       string `json:"by"`
		}
		json.Unmarshal(valueBytes, &response) //nolint:errcheck

		tx4, err := se.pool.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("begin tx: %w", err)
		}
		defer tx4.Rollback(ctx) //nolint:errcheck

		var kind string
		if response.Approved {
			kind = journal.KindApprovalGranted
		} else {
			kind = journal.KindApprovalDenied
		}

		approvalEntry := &journal.JournalEntry{
			RunID:   state.RunID,
			Kind:    kind,
			StepID:  stepID,
			Attempt: 1,
			Payload: valueBytes,
		}
		if err := journal.Append(ctx, tx4, approvalEntry); err != nil {
			return nil, fmt.Errorf("journal %s: %w", kind, err)
		}

		// Resume run.
		if _, err := tx4.Exec(ctx, `UPDATE runs SET status = 'running' WHERE id = $1`, state.RunID); err != nil {
			return nil, fmt.Errorf("update run status: %w", err)
		}
		if err := tx4.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit %s: %w", kind, err)
		}
		state.AppendJournal(*approvalEntry)
		state.SetStatus("running")

		if !response.Approved {
			return nil, fmt.Errorf("approval denied for step %s by %s", stepID, response.By)
		}

		return valueBytes, nil
	}
}

// journalStepStarted writes a step_started event to the journal.
func (se *StepExecutor) journalStepStarted(ctx context.Context, state *RunState, stepID string, attempt int, payload *StepPayload) error {
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindStepStarted,
		StepID:  stepID,
		Attempt: attempt,
		Payload: mustMarshal(map[string]any{
			"kind":    payload.Kind,
			"attempt": attempt,
		}),
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	// Update step_state table.
	if _, err := tx.Exec(ctx, `
		INSERT INTO step_state (step_id, run_id, status, attempt)
		VALUES ($1, $2, 'running', $3)
		ON CONFLICT (run_id, step_id) DO UPDATE SET status = 'running', attempt = $3, updated_at = now()
	`, stepID, state.RunID, attempt); err != nil {
		return fmt.Errorf("upsert step_state: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)
	return nil
}

// journalStepCompleted writes a step_completed event to the journal.
func (se *StepExecutor) journalStepCompleted(ctx context.Context, state *RunState, stepID string, attempt int, result *StepResult, durationMs float64) error {
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	resultBytes, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal result: %w", err)
	}

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindStepCompleted,
		StepID:  stepID,
		Attempt: attempt,
		Payload: resultBytes,
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	// Update step_state table.
	if _, err := tx.Exec(ctx, `
		UPDATE step_state SET status = 'completed', result = $1, updated_at = now()
		WHERE run_id = $2 AND step_id = $3
	`, resultBytes, state.RunID, stepID); err != nil {
		return fmt.Errorf("update step_state: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)
	return nil
}

// journalStepFailed writes a step_failed event to the journal.
func (se *StepExecutor) journalStepFailed(ctx context.Context, state *RunState, stepID string, attempt int, result *StepResult, willRetry bool) error {
	tx, err := se.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	payloadBytes := mustMarshal(map[string]any{
		"step_id":    stepID,
		"attempt":    attempt,
		"error":      result.Error,
		"will_retry": willRetry,
	})

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindStepFailed,
		StepID:  stepID,
		Attempt: attempt,
		Payload: payloadBytes,
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	// Update step_state table.
	status := "failed"
	if willRetry {
		status = "retrying"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE step_state SET status = $1, result = $2, updated_at = now()
		WHERE run_id = $3 AND step_id = $4
	`, status, payloadBytes, state.RunID, stepID); err != nil {
		return fmt.Errorf("update step_state: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)
	return nil
}

// --- helpers ---

func stepCacheKey(stepID string, attempt int) string {
	return fmt.Sprintf("%s:%d", stepID, attempt)
}

func maxRetries(payload *StepPayload) int {
	if payload.MaxRetries > 0 {
		return payload.MaxRetries
	}
	return 0
}

func lastSeq(state *RunState) int64 {
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.Journal) == 0 {
		return 0
	}
	return state.Journal[len(state.Journal)-1].Seq
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("mustMarshal: %v", err))
	}
	return b
}

// setRLSTenantID sets the session variable used by Postgres RLS policies.
func setRLSTenantID(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL app.tenant_id = '%s'", tenantID))
	return err
}
