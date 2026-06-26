// Package dispatcher receives run assignments from the control plane (via the
// tunnel) and dispatches them to the local workflow engine for execution. It
// tracks active runs and reports their status back through the reporter.
package dispatcher

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

// tenantMetadataKey is the gRPC metadata key read by tenant interceptors.
const tenantMetadataKey = "tenant_id"

// serviceTokenMetadataKey mirrors control-plane middleware.ServiceTokenMetadataKey.
// Kept local so the dispatcher does not take a build dep on the control-plane module.
const serviceTokenMetadataKey = "x-lantern-service-token"

var tracer = otel.Tracer("lantern.data-plane-agent.dispatcher")

// Dispatcher receives run assignments and dispatches them to the workflow engine.
type Dispatcher struct {
	workflowEngineAddr string
	runtimeManagerAddr string
	serviceToken       string // LANTERN_GRPC_SERVICE_TOKEN; empty means no token
	logger             *zap.Logger

	mu         sync.Mutex
	activeRuns map[string]*runState
	weConn     *grpc.ClientConn
}

// runState tracks the state of a dispatched run.
type runState struct {
	RunID          string
	AgentVersionID string
	TenantID       string
	Status         string
}

// New creates a new Dispatcher. serviceToken is the value of
// LANTERN_GRPC_SERVICE_TOKEN; pass an empty string in environments where the
// workflow engine does not require the token (e.g. local dev).
func New(workflowEngineAddr, runtimeManagerAddr, serviceToken string, logger *zap.Logger) *Dispatcher {
	return &Dispatcher{
		workflowEngineAddr: workflowEngineAddr,
		runtimeManagerAddr: runtimeManagerAddr,
		serviceToken:       serviceToken,
		logger:             logger.Named("dispatcher"),
		activeRuns:         make(map[string]*runState),
	}
}

// NewFromEnv is a convenience constructor that reads LANTERN_GRPC_SERVICE_TOKEN
// from the environment. Callers that read the token themselves should use New directly.
func NewFromEnv(workflowEngineAddr, runtimeManagerAddr string, logger *zap.Logger) *Dispatcher {
	return New(workflowEngineAddr, runtimeManagerAddr, os.Getenv("LANTERN_GRPC_SERVICE_TOKEN"), logger)
}

// NewWithConn creates a Dispatcher using a pre-established gRPC connection to
// the workflow engine. This is intended for testing; production callers use New.
func NewWithConn(conn *grpc.ClientConn, serviceToken string, logger *zap.Logger) *Dispatcher {
	d := &Dispatcher{
		serviceToken: serviceToken,
		logger:       logger.Named("dispatcher"),
		activeRuns:   make(map[string]*runState),
		weConn:       conn,
	}
	return d
}

// DispatchRun receives a run assignment from the control plane and dispatches
// it to the local workflow engine.
func (d *Dispatcher) DispatchRun(ctx context.Context, assignment *tunnel.RunAssignment) error {
	ctx, span := tracer.Start(ctx, "dispatcher.DispatchRun")
	defer span.End()

	span.SetAttributes(
		attribute.String("run_id", assignment.RunID),
		attribute.String("agent_version_id", assignment.AgentVersionID),
		attribute.String("tenant_id", assignment.TenantID),
	)

	d.logger.Info("dispatching run",
		zap.String("run_id", assignment.RunID),
		zap.String("agent_version_id", assignment.AgentVersionID),
		zap.String("tenant_id", assignment.TenantID),
	)

	// Track the run.
	d.mu.Lock()
	d.activeRuns[assignment.RunID] = &runState{
		RunID:          assignment.RunID,
		AgentVersionID: assignment.AgentVersionID,
		TenantID:       assignment.TenantID,
		Status:         "dispatching",
	}
	d.mu.Unlock()

	// Connect to the workflow engine (lazy, reuse connection).
	conn, err := d.getWorkflowEngineConn(ctx)
	if err != nil {
		d.updateRunStatus(assignment.RunID, "failed")
		return fmt.Errorf("connect to workflow engine: %w", err)
	}

	// Dispatch and consume the run stream in a goroutine so DispatchRun
	// returns quickly and the tunnel loop is not blocked.
	go d.driveRun(ctx, conn, assignment)

	return nil
}

// driveRun calls WorkflowEngineService.ExecuteRun, streams events until the
// stream closes, and drives updateRunStatus based on the final outcome. It
// marks the run failed if the engine returns an error, and completed/failed
// according to the terminal StreamEnd event when the stream closes cleanly.
func (d *Dispatcher) driveRun(ctx context.Context, conn *grpc.ClientConn, assignment *tunnel.RunAssignment) {
	ctx, span := tracer.Start(ctx, "dispatcher.driveRun")
	defer span.End()

	span.SetAttributes(
		attribute.String("run_id", assignment.RunID),
		attribute.String("tenant_id", assignment.TenantID),
	)

	runID := assignment.RunID

	weClient := lanternv1.NewWorkflowEngineServiceClient(conn)

	req := &lanternv1.ExecuteRunRequest{
		RunId:          runID,
		AgentVersionId: assignment.AgentVersionID,
	}

	// Inject tenant_id into outgoing metadata (invariant #7). Attach service
	// token when configured (additive — no-op when empty).
	outCtx := d.outgoingContext(ctx, assignment.TenantID)

	stream, err := weClient.ExecuteRun(outCtx, req)
	if err != nil {
		d.logger.Error("ExecuteRun RPC failed",
			zap.String("run_id", runID),
			zap.Error(err),
		)
		d.updateRunStatus(runID, "failed")
		d.CompleteRun(runID, "failed")
		return
	}

	d.updateRunStatus(runID, "running")
	d.logger.Info("run dispatched to workflow engine",
		zap.String("run_id", runID),
	)

	finalStatus := "completed"

	for {
		event, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Stream ended cleanly; finalStatus was set from StreamEnd event or
				// defaults to "completed".
				break
			}
			d.logger.Error("stream receive error",
				zap.String("run_id", runID),
				zap.Error(err),
			)
			finalStatus = "failed"
			break
		}

		switch v := event.GetPayload().(type) {
		case *lanternv1.StreamEvent_StepStarted:
			d.logger.Debug("step started",
				zap.String("run_id", runID),
				zap.String("step_id", v.StepStarted.GetStepId()),
				zap.String("kind", v.StepStarted.GetKind()),
			)

		case *lanternv1.StreamEvent_StepCompleted:
			d.logger.Debug("step completed",
				zap.String("run_id", runID),
				zap.String("step_id", v.StepCompleted.GetStepId()),
			)

		case *lanternv1.StreamEvent_StepFailed:
			d.logger.Warn("step failed",
				zap.String("run_id", runID),
				zap.String("step_id", v.StepFailed.GetStepId()),
			)
			// A step failure doesn't necessarily fail the whole run;
			// wait for the StreamEnd event for the authoritative terminal status.

		case *lanternv1.StreamEvent_End:
			reason := v.End.GetReason()
			d.logger.Debug("stream end",
				zap.String("run_id", runID),
				zap.String("reason", reason),
			)
			if reason == "failed" {
				finalStatus = "failed"
			}
			// StreamEnd is followed by io.EOF on the next Recv; continue to drain.

		default:
			// Other event kinds (LlmDelta, ToolCall, Heartbeat, …) are informational.
			// Log at debug level so they're visible without noise in prod.
			d.logger.Debug("stream event",
				zap.String("run_id", runID),
				zap.String("event_type", fmt.Sprintf("%T", event.GetPayload())),
			)
		}
	}

	d.logger.Info("run finished",
		zap.String("run_id", runID),
		zap.String("status", finalStatus),
	)
	d.updateRunStatus(runID, finalStatus)
	d.CompleteRun(runID, finalStatus)
}

// outgoingContext appends tenant_id (always) and x-lantern-service-token
// (when non-empty) to the outgoing gRPC metadata on ctx.
func (d *Dispatcher) outgoingContext(ctx context.Context, tenantID string) context.Context {
	pairs := []string{tenantMetadataKey, tenantID}
	if d.serviceToken != "" {
		pairs = append(pairs, serviceTokenMetadataKey, d.serviceToken)
	}
	return metadata.AppendToOutgoingContext(ctx, pairs...)
}

// ActiveRunCount returns the number of currently active runs.
func (d *Dispatcher) ActiveRunCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.activeRuns)
}

// CompleteRun marks a run as completed and removes it from active tracking.
func (d *Dispatcher) CompleteRun(runID, status string) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if rs, ok := d.activeRuns[runID]; ok {
		rs.Status = status
		d.logger.Info("run completed",
			zap.String("run_id", runID),
			zap.String("status", status),
		)
		delete(d.activeRuns, runID)
	}
}

// ActiveRuns returns a snapshot of all currently active run IDs.
func (d *Dispatcher) ActiveRuns() []string {
	d.mu.Lock()
	defer d.mu.Unlock()

	ids := make([]string, 0, len(d.activeRuns))
	for id := range d.activeRuns {
		ids = append(ids, id)
	}
	return ids
}

// getWorkflowEngineConn returns a gRPC connection to the workflow engine,
// creating one if needed.
func (d *Dispatcher) getWorkflowEngineConn(ctx context.Context) (*grpc.ClientConn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.weConn != nil {
		return d.weConn, nil
	}

	d.logger.Info("connecting to workflow engine",
		zap.String("addr", d.workflowEngineAddr),
	)

	// Within the data plane cluster, services communicate over plaintext gRPC.
	// mTLS between data plane components is handled by the service mesh or
	// network policies, not by the application.
	conn, err := grpc.NewClient(
		d.workflowEngineAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial workflow engine at %s: %w", d.workflowEngineAddr, err)
	}

	d.weConn = conn
	return conn, nil
}

// updateRunStatus updates the status of a tracked run.
func (d *Dispatcher) updateRunStatus(runID, status string) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if rs, ok := d.activeRuns[runID]; ok {
		rs.Status = status
	}
}

// Close cleans up dispatcher resources.
func (d *Dispatcher) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.weConn != nil {
		d.weConn.Close()
		d.weConn = nil
	}
}
