package handlers

// Workflow `tool` node dispatch (control-plane interpreter).
//
// A tool node runs either a built-in tool executed in-process (web_search) or a
// sandbox tool in the run's microVM via RuntimeManager.ExecTool (invariant #5:
// untrusted execution never happens in the control-plane). There is no fake
// success: an unwired runtime, a manager error, or a tool-reported error fails
// the step. Per-tool daily limits (agent_budgets.tool_limits) are checked
// before dispatch and counted after it.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/workflow"
)

// errToolRuntimeUnavailable: the tool needs the microVM runtime but no
// runtime-manager is reachable (stub scheduler / unset addr) or the manager
// reports the tool unavailable for the run's VM.
var errToolRuntimeUnavailable = errors.New("tool runtime unavailable")

// errToolFailed: the tool ran and reported an error.
var errToolFailed = errors.New("tool failed")

// workflowBuiltinTools run in-process. They make their own LLM calls, so they
// are metered like ai-steps. A package var so tests can stub the network.
var workflowBuiltinTools = map[string]func(ctx context.Context, pool *pgxpool.Pool, tenantID string, params map[string]any) (any, error){
	"web_search": executeWebSearchTool,
}

// ExecTool lets RuntimeHandler serve workflow tool nodes through the same
// manager client the sandbox file API uses. Without a manager-capable
// scheduler it returns errToolRuntimeUnavailable.
func (h *RuntimeHandler) ExecTool(ctx context.Context, node string, req *lanternv1.ExecToolRequest) (*lanternv1.ExecToolResponse, error) {
	te, ok := h.scheduler.(toolExecer)
	if !ok {
		return nil, errToolRuntimeUnavailable
	}
	return te.ExecTool(ctx, node, req)
}

// gateWorkflowTool enforces a per-tool daily limit keyed by `key` (a tool name,
// or `connector.action` for connector nodes). Hard-fail budgets block; soft
// ones log and proceed.
func gateWorkflowTool(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger, tenantID, agentName, key string) error {
	bc := CheckToolBudget(ctx, pool, tenantID, agentName, key)
	if bc.Allowed {
		return nil
	}
	if bc.HardFail {
		return fmt.Errorf("%w: %s", errWorkflowBudgetExceeded, bc.Reason)
	}
	logger.Warn("workflow: soft tool limit exceeded, proceeding",
		zap.String("agent", agentName), zap.String("tool", key), zap.String("reason", bc.Reason))
	return nil
}

// RecordToolUse counts one dispatched tool call toward the daily per-tool
// limit without touching runs/tokens/cost.
func RecordToolUse(ctx context.Context, pool *pgxpool.Pool, tenantID, agentName, key string) error {
	return recordUsage(ctx, pool, tenantID, agentName, 0, 0, 0, 0, map[string]int{key: 1})
}

// callWorkflowTool dispatches one tool node. exec is nil when no runtime is
// wired. The idempotency key is derived from the interpreter's StepRef
// (run, step path, attempt), so a crash-replay or retry of the same attempt
// dedups at the manager (invariant #8).
func callWorkflowTool(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger, exec toolExecer,
	runID, tenantID, agentName, tool string, params map[string]any) (any, error) {
	builtin, isBuiltin := workflowBuiltinTools[tool]
	if !isBuiltin && exec == nil {
		return nil, fmt.Errorf("%w: %q needs the microVM runtime and none is wired", errToolRuntimeUnavailable, tool)
	}
	if err := gateWorkflowTool(ctx, pool, logger, tenantID, agentName, tool); err != nil {
		return nil, err
	}
	if isBuiltin {
		return callBuiltinTool(ctx, pool, logger, builtin, tenantID, agentName, tool, params)
	}

	args, err := structpb.NewStruct(params)
	if err != nil {
		return nil, fmt.Errorf("tool %q: encode params: %w", tool, err)
	}
	ref, _ := workflow.StepFromContext(ctx)
	req := &lanternv1.ExecToolRequest{
		// ponytail: run_id lets the default manager find the run's VM; a VM on
		// another node needs a runtime_vms lookup for its node first.
		RunId:          runID,
		StepId:         ref.StepID,
		ToolName:       tool,
		Args:           args,
		IdempotencyKey: idempotencyKey(runID, ref.StepID, ref.Attempt),
		TenantId:       tenantID,
	}
	if dl, ok := ctx.Deadline(); ok {
		req.Timeout = durationpb.New(time.Until(dl))
	}
	resp, err := exec.ExecTool(ctx, "", req)
	if errors.Is(err, errToolRuntimeUnavailable) {
		return nil, fmt.Errorf("tool %q: %w", tool, err) // never dispatched: not counted
	}
	recordToolUse(ctx, pool, logger, tenantID, agentName, tool)
	if err != nil {
		return nil, fmt.Errorf("tool %q: ExecTool: %w", tool, err)
	}
	switch resp.GetStatus() {
	case lanternv1.ToolStatus_TOOL_STATUS_OK:
		return map[string]any{"tool_name": tool, "result": resp.GetResult().AsMap()}, nil
	case lanternv1.ToolStatus_TOOL_STATUS_UNAVAILABLE:
		return nil, fmt.Errorf("%w: %q: %s", errToolRuntimeUnavailable, tool, resp.GetError())
	default:
		return nil, fmt.Errorf("%w: %q: %s", errToolFailed, tool, resp.GetError())
	}
}

// callBuiltinTool runs an in-process tool, metering its own LLM spend.
func callBuiltinTool(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger,
	builtin func(context.Context, *pgxpool.Pool, string, map[string]any) (any, error),
	tenantID, agentName, tool string, params map[string]any) (any, error) {
	if bc := CheckBudget(ctx, pool, tenantID, agentName, 0); !bc.Allowed && bc.HardFail {
		return nil, fmt.Errorf("%w: %s", errWorkflowBudgetExceeded, bc.Reason)
	}
	uctx, usage := withToolUsage(ctx)
	out, err := builtin(uctx, pool, tenantID, params)
	recordToolUse(ctx, pool, logger, tenantID, agentName, tool)
	if in, o, cost := usage.totals(); in > 0 || o > 0 || cost > 0 {
		if recErr := RecordUsageSpend(ctx, pool, tenantID, agentName, in, o, cost); recErr != nil {
			logger.Warn("workflow: tool RecordUsage failed", zap.String("tool", tool), zap.Error(recErr))
		}
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", errToolFailed, tool, err)
	}
	return out, nil
}

func recordToolUse(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger, tenantID, agentName, key string) {
	if err := RecordToolUse(ctx, pool, tenantID, agentName, key); err != nil {
		logger.Warn("workflow: RecordToolUse failed", zap.String("tool", key), zap.Error(err))
	}
}
