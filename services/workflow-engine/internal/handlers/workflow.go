package handlers

import (
	"context"
	"encoding/json"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/workflow-engine/internal/engine"
	"github.com/dshakes/lantern/services/workflow-engine/internal/middleware"
	"github.com/dshakes/lantern/services/workflow-engine/internal/server"
)

// Ensure time is used (stream event timestamps).
var _ = time.Now

// WorkflowService implements lanternv1.WorkflowEngineServiceServer.
type WorkflowService struct {
	lanternv1.UnimplementedWorkflowEngineServiceServer
	srv *server.Server
}

// NewWorkflowService creates a new WorkflowService handler.
func NewWorkflowService(srv *server.Server) *WorkflowService {
	return &WorkflowService{srv: srv}
}

func (s *WorkflowService) logger() *zap.Logger {
	return s.srv.Logger.Named("workflow_service")
}

// ExecuteRun accepts a run for execution. It validates the request, delegates
// to the engine, and streams back events as they occur.
func (s *WorkflowService) ExecuteRun(req *lanternv1.ExecuteRunRequest, stream lanternv1.WorkflowEngineService_ExecuteRunServer) error {
	tenantID, err := middleware.MustTenantID(stream.Context())
	if err != nil {
		return err
	}

	if req.GetRunId() == "" {
		return status.Error(codes.InvalidArgument, "run_id is required")
	}
	if req.GetAgentVersionId() == "" {
		return status.Error(codes.InvalidArgument, "agent_version_id is required")
	}

	s.logger().Info("execute run request",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", req.GetRunId()),
		zap.String("agent_version_id", req.GetAgentVersionId()),
	)

	// Start streaming events for this run.
	ctx := stream.Context()
	eventCh, err := s.srv.Engine.Streamer().Subscribe(ctx, req.GetRunId(), 0)
	if err != nil {
		return status.Errorf(codes.Internal, "failed to subscribe to events: %v", err)
	}

	// Kick off execution in the engine (non-blocking from the handler's perspective).
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.srv.Engine.ExecuteRun(ctx, req.GetRunId(), tenantID, req.GetAgentVersionId())
	}()

	// Forward events to the gRPC stream.
	var seq uint64
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-eventCh:
			if !ok {
				// Channel closed — stream ended.
				return nil
			}
			seq++
			protoEvent := streamEventToProto(event, seq)
			if err := stream.Send(protoEvent); err != nil {
				return err
			}
			// Check for terminal event.
			if event.Kind == "stream_end" {
				return nil
			}
		case err := <-errCh:
			if err != nil {
				s.logger().Error("run execution failed",
					zap.String("run_id", req.GetRunId()),
					zap.Error(err),
				)
			}
			// Drain any remaining events before closing.
			for event := range eventCh {
				seq++
				protoEvent := streamEventToProto(event, seq)
				if sendErr := stream.Send(protoEvent); sendErr != nil {
					return sendErr
				}
			}
			return nil
		}
	}
}

// ResumeRun resumes a paused run and streams back events.
func (s *WorkflowService) ResumeRun(req *lanternv1.ResumeRunRequest, stream lanternv1.WorkflowEngineService_ResumeRunServer) error {
	tenantID, err := middleware.MustTenantID(stream.Context())
	if err != nil {
		return err
	}

	if req.GetRunId() == "" {
		return status.Error(codes.InvalidArgument, "run_id is required")
	}

	s.logger().Info("resume run request",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", req.GetRunId()),
	)

	ctx := stream.Context()

	// Subscribe to events before resuming so we don't miss anything.
	eventCh, err := s.srv.Engine.Streamer().Subscribe(ctx, req.GetRunId(), 0)
	if err != nil {
		return status.Errorf(codes.Internal, "failed to subscribe to events: %v", err)
	}

	// Resume the run.
	if err := s.srv.Engine.ResumeRun(ctx, req.GetRunId()); err != nil {
		return status.Errorf(codes.Internal, "failed to resume run: %v", err)
	}

	// Forward events.
	var seq uint64
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-eventCh:
			if !ok {
				return nil
			}
			seq++
			protoEvent := streamEventToProto(event, seq)
			if err := stream.Send(protoEvent); err != nil {
				return err
			}
			if event.Kind == "stream_end" {
				return nil
			}
		}
	}
}

// SignalRun delivers an external signal to a running or paused run.
func (s *WorkflowService) SignalRun(ctx context.Context, req *lanternv1.SignalRunRequest) (*lanternv1.SignalRunResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetRunId() == "" {
		return nil, status.Error(codes.InvalidArgument, "run_id is required")
	}
	if req.GetSignalName() == "" {
		return nil, status.Error(codes.InvalidArgument, "signal_name is required")
	}

	s.logger().Info("signal run request",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", req.GetRunId()),
		zap.String("signal_name", req.GetSignalName()),
	)

	var valueBytes json.RawMessage
	if req.GetValue() != nil {
		b, err := json.Marshal(req.GetValue().AsMap())
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid signal value: %v", err)
		}
		valueBytes = b
	} else {
		valueBytes = json.RawMessage("{}")
	}

	if err := s.srv.Engine.SignalRun(ctx, req.GetRunId(), req.GetSignalName(), valueBytes); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to signal run: %v", err)
	}

	return &lanternv1.SignalRunResponse{}, nil
}

// CancelRun cancels a running or paused run.
func (s *WorkflowService) CancelRun(ctx context.Context, req *lanternv1.CancelRunRequest) (*lanternv1.CancelRunResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	s.logger().Info("cancel run request",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", req.GetId()),
	)

	if err := s.srv.Engine.CancelRun(ctx, req.GetId()); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to cancel run: %v", err)
	}

	return &lanternv1.CancelRunResponse{}, nil
}

// QueryRun executes a synchronous query against a running workflow.
func (s *WorkflowService) QueryRun(ctx context.Context, req *lanternv1.QueryRunRequest) (*lanternv1.QueryRunResponse, error) {
	_, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetRunId() == "" {
		return nil, status.Error(codes.InvalidArgument, "run_id is required")
	}
	if req.GetQueryName() == "" {
		return nil, status.Error(codes.InvalidArgument, "query_name is required")
	}

	handler, err := s.srv.Engine.GetQueryHandler(req.GetRunId(), req.GetQueryName())
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "%v", err)
	}

	var argsBytes json.RawMessage
	if req.GetArgs() != nil {
		b, err := json.Marshal(req.GetArgs().AsMap())
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid args: %v", err)
		}
		argsBytes = b
	}

	resultBytes, err := handler(argsBytes)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}

	var resultMap map[string]any
	if err := json.Unmarshal(resultBytes, &resultMap); err != nil {
		return nil, status.Errorf(codes.Internal, "invalid query result: %v", err)
	}

	resultStruct, err := structpb.NewStruct(resultMap)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to build result struct: %v", err)
	}

	return &lanternv1.QueryRunResponse{
		Result: resultStruct,
	}, nil
}

// --- helpers ---

// streamEventToProto converts an internal StreamEvent to a proto StreamEvent.
func streamEventToProto(event *engine.StreamEvent, seq uint64) *lanternv1.StreamEvent {
	pe := &lanternv1.StreamEvent{
		RunId:  event.RunID,
		StepId: event.StepID,
		Seq:    seq,
		Ts:     timestamppb.New(event.TS),
	}

	switch event.Kind {
	case "step_started":
		var p struct {
			Kind    string `json:"kind"`
			Attempt int32  `json:"attempt"`
		}
		json.Unmarshal(event.Payload, &p) //nolint:errcheck
		pe.Payload = &lanternv1.StreamEvent_StepStarted{
			StepStarted: &lanternv1.StepStarted{
				StepId:  event.StepID,
				Attempt: p.Attempt,
				Kind:    p.Kind,
			},
		}

	case "step_completed":
		var p struct {
			Attempt    int32   `json:"attempt"`
			DurationMs float64 `json:"duration_ms"`
		}
		json.Unmarshal(event.Payload, &p) //nolint:errcheck
		pe.Payload = &lanternv1.StreamEvent_StepCompleted{
			StepCompleted: &lanternv1.StepCompleted{
				StepId:     event.StepID,
				Attempt:    p.Attempt,
				DurationMs: p.DurationMs,
			},
		}

	case "step_failed":
		var p struct {
			Attempt      int32  `json:"attempt"`
			ErrorMessage string `json:"error_message"`
			WillRetry    bool   `json:"will_retry"`
		}
		json.Unmarshal(event.Payload, &p) //nolint:errcheck
		pe.Payload = &lanternv1.StreamEvent_StepFailed{
			StepFailed: &lanternv1.StepFailed{
				StepId:       event.StepID,
				Attempt:      p.Attempt,
				ErrorMessage: p.ErrorMessage,
				WillRetry:    p.WillRetry,
			},
		}

	case "run_started", "run_succeeded", "run_failed", "run_cancelled":
		pe.Payload = &lanternv1.StreamEvent_Log{
			Log: &lanternv1.LogLine{
				Level:   "info",
				Message: event.Kind,
			},
		}

	case "stream_end":
		var p struct {
			Reason string `json:"reason"`
		}
		json.Unmarshal(event.Payload, &p) //nolint:errcheck
		pe.Payload = &lanternv1.StreamEvent_End{
			End: &lanternv1.StreamEnd{
				Reason: p.Reason,
			},
		}

	default:
		pe.Payload = &lanternv1.StreamEvent_Log{
			Log: &lanternv1.LogLine{
				Level:   "debug",
				Message: event.Kind,
			},
		}
	}

	return pe
}
