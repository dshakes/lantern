package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newRunsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "runs",
		Aliases: []string{"run"},
		Short:   "Manage runs",
	}

	cmd.AddCommand(newRunsCreateCommand())
	cmd.AddCommand(newRunsGetCommand())
	cmd.AddCommand(newRunsListCommand())
	cmd.AddCommand(newRunsCancelCommand())

	return cmd
}

// --- runs create ---

func newRunsCreateCommand() *cobra.Command {
	var (
		agentName string
		inputRaw  string
		stream    bool
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new run",
		RunE: func(cmd *cobra.Command, args []string) error {
			if agentName == "" {
				return fmt.Errorf("--agent is required")
			}

			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			var inputStruct *structpb.Struct
			if inputRaw != "" {
				var m map[string]any
				if err := json.Unmarshal([]byte(inputRaw), &m); err != nil {
					return fmt.Errorf("invalid --input JSON: %w", err)
				}
				inputStruct, err = structpb.NewStruct(m)
				if err != nil {
					return fmt.Errorf("build input struct: %w", err)
				}
			}

			run, err := clients.Runs.CreateRun(cmd.Context(), &lanternv1.CreateRunRequest{
				AgentName:   agentName,
				Input:       inputStruct,
				TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_MANUAL,
				Stream:      stream,
			})
			if err != nil {
				return fmt.Errorf("create run: %w", err)
			}

			if isJSON() {
				return printJSON(runToMap(run))
			}

			printSuccess(fmt.Sprintf("Run created: %s (status: %s)", run.GetId(), formatRunStatus(run.GetStatus())))

			// If --stream is set, immediately start following events.
			if stream {
				fmt.Fprintln(os.Stderr)
				return streamRunEvents(cmd, clients, run.GetId(), 0)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&agentName, "agent", "", "Agent name (required)")
	cmd.Flags().StringVar(&inputRaw, "input", "", `Input JSON (e.g. '{"key":"value"}')`)
	cmd.Flags().BoolVar(&stream, "stream", false, "Stream run events after creation")

	return cmd
}

// --- runs get ---

func newRunsGetCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "get <id>",
		Short: "Get a run by ID",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			run, err := clients.Runs.GetRun(cmd.Context(), &lanternv1.GetRunRequest{
				Id: args[0],
			})
			if err != nil {
				return fmt.Errorf("get run: %w", err)
			}

			if isJSON() {
				return printJSON(runToMap(run))
			}

			printTable(
				[]string{"ID", "AGENT", "STATUS", "TOKENS IN", "TOKENS OUT", "COST", "CREATED"},
				[][]string{{
					run.GetId(),
					run.GetAgentId(),
					formatRunStatus(run.GetStatus()),
					fmt.Sprintf("%d", run.GetTokensIn()),
					fmt.Sprintf("%d", run.GetTokensOut()),
					fmt.Sprintf("$%.4f", run.GetCostUsd()),
					formatTimestamp(run.GetCreatedAt()),
				}},
			)

			if run.GetError() != nil {
				fmt.Fprintf(os.Stderr, "\n%sError: [%s] %s%s\n",
					colorRed,
					run.GetError().GetCode(),
					run.GetError().GetMessage(),
					colorReset,
				)
			}

			return nil
		},
	}

	return cmd
}

// --- runs list ---

func newRunsListCommand() *cobra.Command {
	var (
		agentName    string
		statusFilter string
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List runs",
		RunE: func(cmd *cobra.Command, args []string) error {
			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			req := &lanternv1.ListRunsRequest{
				AgentName: agentName,
			}

			if statusFilter != "" {
				rs := parseRunStatusFlag(statusFilter)
				if rs == lanternv1.RunStatus_RUN_STATUS_UNSPECIFIED {
					return fmt.Errorf("unknown status %q (valid: queued, running, paused, succeeded, failed, cancelled)", statusFilter)
				}
				req.StatusFilter = rs
			}

			resp, err := clients.Runs.ListRuns(cmd.Context(), req)
			if err != nil {
				return fmt.Errorf("list runs: %w", err)
			}

			if isJSON() {
				items := make([]map[string]any, 0, len(resp.GetRuns()))
				for _, r := range resp.GetRuns() {
					items = append(items, runToMap(r))
				}
				return printJSON(map[string]any{
					"runs":        items,
					"total_count": resp.GetTotalCount(),
				})
			}

			if len(resp.GetRuns()) == 0 {
				printInfo("No runs found.")
				return nil
			}

			rows := make([][]string, 0, len(resp.GetRuns()))
			for _, r := range resp.GetRuns() {
				rows = append(rows, []string{
					r.GetId(),
					r.GetAgentId(),
					formatRunStatus(r.GetStatus()),
					fmt.Sprintf("%d", r.GetTokensIn()),
					fmt.Sprintf("%d", r.GetTokensOut()),
					fmt.Sprintf("$%.4f", r.GetCostUsd()),
					formatTimestamp(r.GetCreatedAt()),
				})
			}

			printTable([]string{"ID", "AGENT", "STATUS", "TOKENS IN", "TOKENS OUT", "COST", "CREATED"}, rows)

			if resp.GetNextPageToken() != "" {
				fmt.Fprintf(os.Stderr, "\n%s(more results available)%s\n", colorDim, colorReset)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&agentName, "agent", "", "Filter by agent name")
	cmd.Flags().StringVar(&statusFilter, "status", "", "Filter by status (queued, running, paused, succeeded, failed, cancelled)")

	return cmd
}

// --- runs cancel ---

func newRunsCancelCommand() *cobra.Command {
	var reason string

	cmd := &cobra.Command{
		Use:   "cancel <id>",
		Short: "Cancel a run",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			run, err := clients.Runs.CancelRun(cmd.Context(), &lanternv1.CancelRunRequest{
				Id:     args[0],
				Reason: reason,
			})
			if err != nil {
				return fmt.Errorf("cancel run: %w", err)
			}

			if isJSON() {
				return printJSON(runToMap(run))
			}

			printSuccess(fmt.Sprintf("Run %s cancelled.", run.GetId()))
			return nil
		},
	}

	cmd.Flags().StringVar(&reason, "reason", "", "Cancellation reason")

	return cmd
}

// --- helpers ---

// streamRunEvents connects to StreamRunEvents and pretty-prints each event.
func streamRunEvents(cmd *cobra.Command, clients *internal.Clients, runID string, fromSeq uint64) error {
	stream, err := clients.Runs.StreamRunEvents(cmd.Context(), &lanternv1.StreamRunEventsRequest{
		RunId:   runID,
		FromSeq: fromSeq,
		Live:    true,
	})
	if err != nil {
		return fmt.Errorf("stream events: %w", err)
	}

	for {
		event, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("stream recv: %w", err)
		}

		if isJSON() {
			printJSON(streamEventToMap(event)) //nolint:errcheck
			continue
		}

		printStreamEvent(event)
	}
}

// printStreamEvent renders a single StreamEvent to stderr with appropriate colors.
func printStreamEvent(e *lanternv1.StreamEvent) {
	ts := formatTimestamp(e.GetTs())
	prefix := fmt.Sprintf("%s[%s seq=%d]%s ", colorDim, ts, e.GetSeq(), colorReset)

	switch p := e.GetPayload().(type) {
	case *lanternv1.StreamEvent_StepStarted:
		fmt.Fprintf(os.Stderr, "%s%s=> step started: %s (kind: %s, attempt: %d)%s\n",
			prefix, colorBlue, p.StepStarted.GetStepId(), p.StepStarted.GetKind(), p.StepStarted.GetAttempt(), colorReset)

	case *lanternv1.StreamEvent_StepCompleted:
		fmt.Fprintf(os.Stderr, "%s%s=> step completed: %s (%.1fms)%s\n",
			prefix, colorGreen, p.StepCompleted.GetStepId(), p.StepCompleted.GetDurationMs(), colorReset)

	case *lanternv1.StreamEvent_StepFailed:
		retry := ""
		if p.StepFailed.GetWillRetry() {
			retry = " (will retry)"
		}
		fmt.Fprintf(os.Stderr, "%s%s=> step failed: %s [%s] %s%s%s\n",
			prefix, colorRed, p.StepFailed.GetStepId(), p.StepFailed.GetErrorCode(), p.StepFailed.GetErrorMessage(), retry, colorReset)

	case *lanternv1.StreamEvent_LlmDelta:
		fmt.Fprintf(os.Stderr, "%s%s%s%s", prefix, colorDim, p.LlmDelta.GetText(), colorReset)

	case *lanternv1.StreamEvent_LlmComplete:
		fmt.Fprintf(os.Stderr, "\n%s%s=> llm complete: model=%s tokens_in=%d tokens_out=%d cost=$%.4f%s\n",
			prefix, colorCyan, p.LlmComplete.GetModelUsed(), p.LlmComplete.GetTokensIn(), p.LlmComplete.GetTokensOut(), p.LlmComplete.GetCostUsd(), colorReset)

	case *lanternv1.StreamEvent_ToolCall:
		fmt.Fprintf(os.Stderr, "%s%s=> tool call: %s (call_id: %s)%s\n",
			prefix, colorYellow, p.ToolCall.GetToolName(), p.ToolCall.GetCallId(), colorReset)

	case *lanternv1.StreamEvent_ToolResult:
		errStr := ""
		if p.ToolResult.GetIsError() {
			errStr = " [ERROR]"
		}
		fmt.Fprintf(os.Stderr, "%s%s=> tool result: call_id=%s%s%s\n",
			prefix, colorYellow, p.ToolResult.GetCallId(), errStr, colorReset)

	case *lanternv1.StreamEvent_Log:
		fmt.Fprintf(os.Stderr, "%s[%s] %s\n", prefix, p.Log.GetLevel(), p.Log.GetMessage())

	case *lanternv1.StreamEvent_Question:
		fmt.Fprintf(os.Stderr, "%s%s=> question: %s (options: %s)%s\n",
			prefix, colorCyan, p.Question.GetQuestion(), strings.Join(p.Question.GetOptions(), ", "), colorReset)

	case *lanternv1.StreamEvent_Approval:
		fmt.Fprintf(os.Stderr, "%s%s=> approval required: %s%s\n",
			prefix, colorYellow, p.Approval.GetReason(), colorReset)

	case *lanternv1.StreamEvent_Heartbeat:
		fmt.Fprintf(os.Stderr, "%s%s...heartbeat%s\n", prefix, colorDim, colorReset)

	case *lanternv1.StreamEvent_End:
		fmt.Fprintf(os.Stderr, "%s%s=> stream ended: %s%s\n",
			prefix, colorGreen, p.End.GetReason(), colorReset)
	}
}

// runToMap converts a Run proto to a generic map for JSON output.
func runToMap(r *lanternv1.Run) map[string]any {
	m := map[string]any{
		"id":               r.GetId(),
		"tenant_id":        r.GetTenantId(),
		"agent_id":         r.GetAgentId(),
		"agent_version_id": r.GetAgentVersionId(),
		"status":           formatRunStatus(r.GetStatus()),
		"tokens_in":        r.GetTokensIn(),
		"tokens_out":       r.GetTokensOut(),
		"cost_usd":         r.GetCostUsd(),
		"created_at":       formatTimestamp(r.GetCreatedAt()),
	}
	if r.GetStartedAt() != nil {
		m["started_at"] = formatTimestamp(r.GetStartedAt())
	}
	if r.GetFinishedAt() != nil {
		m["finished_at"] = formatTimestamp(r.GetFinishedAt())
	}
	if r.GetParentRunId() != "" {
		m["parent_run_id"] = r.GetParentRunId()
	}
	if r.GetInput() != nil {
		m["input"] = r.GetInput().AsMap()
	}
	if r.GetOutput() != nil {
		m["output"] = r.GetOutput().AsMap()
	}
	if r.GetError() != nil {
		m["error"] = map[string]any{
			"code":    r.GetError().GetCode(),
			"message": r.GetError().GetMessage(),
			"step_id": r.GetError().GetStepId(),
		}
	}
	if len(r.GetLabels()) > 0 {
		m["labels"] = r.GetLabels()
	}
	return m
}

// streamEventToMap converts a StreamEvent to a generic map for JSON output.
func streamEventToMap(e *lanternv1.StreamEvent) map[string]any {
	m := map[string]any{
		"run_id": e.GetRunId(),
		"seq":    e.GetSeq(),
		"ts":     formatTimestamp(e.GetTs()),
	}
	if e.GetStepId() != "" {
		m["step_id"] = e.GetStepId()
	}

	switch p := e.GetPayload().(type) {
	case *lanternv1.StreamEvent_StepStarted:
		m["type"] = "step_started"
		m["step_id"] = p.StepStarted.GetStepId()
		m["kind"] = p.StepStarted.GetKind()
		m["attempt"] = p.StepStarted.GetAttempt()
	case *lanternv1.StreamEvent_StepCompleted:
		m["type"] = "step_completed"
		m["step_id"] = p.StepCompleted.GetStepId()
		m["duration_ms"] = p.StepCompleted.GetDurationMs()
	case *lanternv1.StreamEvent_StepFailed:
		m["type"] = "step_failed"
		m["step_id"] = p.StepFailed.GetStepId()
		m["error_code"] = p.StepFailed.GetErrorCode()
		m["error_message"] = p.StepFailed.GetErrorMessage()
		m["will_retry"] = p.StepFailed.GetWillRetry()
	case *lanternv1.StreamEvent_LlmDelta:
		m["type"] = "llm_delta"
		m["text"] = p.LlmDelta.GetText()
		m["model_used"] = p.LlmDelta.GetModelUsed()
	case *lanternv1.StreamEvent_LlmComplete:
		m["type"] = "llm_complete"
		m["model_used"] = p.LlmComplete.GetModelUsed()
		m["tokens_in"] = p.LlmComplete.GetTokensIn()
		m["tokens_out"] = p.LlmComplete.GetTokensOut()
		m["cost_usd"] = p.LlmComplete.GetCostUsd()
	case *lanternv1.StreamEvent_ToolCall:
		m["type"] = "tool_call"
		m["tool_name"] = p.ToolCall.GetToolName()
		m["call_id"] = p.ToolCall.GetCallId()
	case *lanternv1.StreamEvent_ToolResult:
		m["type"] = "tool_result"
		m["call_id"] = p.ToolResult.GetCallId()
		m["is_error"] = p.ToolResult.GetIsError()
	case *lanternv1.StreamEvent_Log:
		m["type"] = "log"
		m["level"] = p.Log.GetLevel()
		m["message"] = p.Log.GetMessage()
	case *lanternv1.StreamEvent_Question:
		m["type"] = "question"
		m["question"] = p.Question.GetQuestion()
		m["options"] = p.Question.GetOptions()
	case *lanternv1.StreamEvent_Approval:
		m["type"] = "approval"
		m["reason"] = p.Approval.GetReason()
	case *lanternv1.StreamEvent_Heartbeat:
		m["type"] = "heartbeat"
	case *lanternv1.StreamEvent_End:
		m["type"] = "end"
		m["reason"] = p.End.GetReason()
	}

	return m
}

// formatRunStatus converts a RunStatus enum to a human-readable string.
func formatRunStatus(s lanternv1.RunStatus) string {
	switch s {
	case lanternv1.RunStatus_RUN_STATUS_QUEUED:
		return "queued"
	case lanternv1.RunStatus_RUN_STATUS_RUNNING:
		return "running"
	case lanternv1.RunStatus_RUN_STATUS_PAUSED:
		return "paused"
	case lanternv1.RunStatus_RUN_STATUS_SUCCEEDED:
		return "succeeded"
	case lanternv1.RunStatus_RUN_STATUS_FAILED:
		return "failed"
	case lanternv1.RunStatus_RUN_STATUS_CANCELLED:
		return "cancelled"
	default:
		return "unknown"
	}
}

// parseRunStatusFlag converts a CLI flag value to a RunStatus enum.
func parseRunStatusFlag(s string) lanternv1.RunStatus {
	switch strings.ToLower(s) {
	case "queued":
		return lanternv1.RunStatus_RUN_STATUS_QUEUED
	case "running":
		return lanternv1.RunStatus_RUN_STATUS_RUNNING
	case "paused":
		return lanternv1.RunStatus_RUN_STATUS_PAUSED
	case "succeeded":
		return lanternv1.RunStatus_RUN_STATUS_SUCCEEDED
	case "failed":
		return lanternv1.RunStatus_RUN_STATUS_FAILED
	case "cancelled":
		return lanternv1.RunStatus_RUN_STATUS_CANCELLED
	default:
		return lanternv1.RunStatus_RUN_STATUS_UNSPECIFIED
	}
}

// formatTimestamp formats a protobuf Timestamp for display.
func formatTimestamp(ts *timestamppb.Timestamp) string {
	if ts == nil || (ts.GetSeconds() == 0 && ts.GetNanos() == 0) {
		return "-"
	}
	return ts.AsTime().Format("2006-01-02 15:04:05")
}
