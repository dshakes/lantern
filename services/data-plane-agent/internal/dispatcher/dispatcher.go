// Package dispatcher receives run assignments from the control plane (via the
// tunnel) and dispatches them to the local workflow engine for execution. It
// tracks active runs and reports their status back through the reporter.
package dispatcher

import (
	"context"
	"fmt"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

var tracer = otel.Tracer("lantern.data-plane-agent.dispatcher")

// Dispatcher receives run assignments and dispatches them to the workflow engine.
type Dispatcher struct {
	workflowEngineAddr string
	runtimeManagerAddr string
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

// New creates a new Dispatcher.
func New(workflowEngineAddr, runtimeManagerAddr string, logger *zap.Logger) *Dispatcher {
	return &Dispatcher{
		workflowEngineAddr: workflowEngineAddr,
		runtimeManagerAddr: runtimeManagerAddr,
		logger:             logger.Named("dispatcher"),
		activeRuns:         make(map[string]*runState),
	}
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

	// In production, this calls the WorkflowEngine.ScheduleRun RPC:
	//   resp, err := weClient.ScheduleRun(ctx, &pb.ScheduleRunRequest{
	//       RunId:          assignment.RunID,
	//       AgentVersionId: assignment.AgentVersionID,
	//       TenantId:       assignment.TenantID,
	//       Config:         assignment.Config,
	//   })
	//
	// For the spike, we simulate acceptance.
	_ = conn

	d.updateRunStatus(assignment.RunID, "running")

	d.logger.Info("run dispatched successfully",
		zap.String("run_id", assignment.RunID),
	)

	return nil
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
