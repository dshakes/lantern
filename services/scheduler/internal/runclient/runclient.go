// Package runclient is the scheduler's gRPC client to the control-plane's
// RunService. When a cron schedule fires, the scheduler calls CreateRun here
// rather than writing the runs table directly (invariant #2: the workflow
// engine / RunService is the only thing that mutates run state).
//
// Every outgoing CreateRun carries the schedule's tenant_id in gRPC metadata
// (invariant #7: every gRPC call carries tenant_id). When a shared service
// token is configured it is attached too, so the control-plane's optional
// service-token interceptor accepts the call.
package runclient

import (
	"context"
	"encoding/json"
	"fmt"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// tenantMetadataKey is the gRPC metadata key the control-plane's tenant
// interceptor reads (see services/control-plane/internal/middleware/tenant.go).
const tenantMetadataKey = "tenant_id"

// serviceTokenMetadataKey mirrors the control-plane's
// middleware.ServiceTokenMetadataKey constant. Kept as a local const so the
// scheduler doesn't take a build dependency on the control-plane module.
const serviceTokenMetadataKey = "x-lantern-service-token"

// Client holds a long-lived gRPC connection to the control-plane and creates
// runs on its RunService. One Client is shared by the cron ticker and the
// delayed-run processor for the whole process lifetime.
type Client struct {
	conn         *grpc.ClientConn
	rpc          lanternv1.RunServiceClient
	logger       *zap.Logger
	serviceToken string
}

// New dials the control-plane at addr and returns a Client. The connection is
// established lazily by gRPC; New itself does not block on connectivity.
//
// serviceToken, when non-empty, is attached as x-lantern-service-token metadata
// on every CreateRun so the control-plane's optional service-token interceptor
// accepts the call. When empty, nothing extra is attached (additive).
//
// Transport is insecure (cleartext): the scheduler<->control-plane link is an
// in-cluster/private-network hop, matching how the runtime-scheduler dials the
// runtime-manager.
func New(addr, serviceToken string, logger *zap.Logger) (*Client, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("runclient: dial control-plane %q: %w", addr, err)
	}
	return &Client{
		conn:         conn,
		rpc:          lanternv1.NewRunServiceClient(conn),
		logger:       logger.Named("run_client"),
		serviceToken: serviceToken,
	}, nil
}

// Close tears down the underlying gRPC connection. Safe to call once at
// shutdown; the underlying ClientConn.Close is idempotent.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	if err := c.conn.Close(); err != nil {
		return fmt.Errorf("runclient: close control-plane conn: %w", err)
	}
	return nil
}

// CreateRun mirrors the cron.RunCreator signature so it can be passed directly
// as the run-creator callback. It builds a schedule-triggered CreateRunRequest,
// injects tenant_id (and the service token when set) into outgoing metadata,
// and returns the new run's id.
func (c *Client) CreateRun(ctx context.Context, tenantID, agentName string, input json.RawMessage) (string, error) {
	if tenantID == "" {
		return "", fmt.Errorf("runclient: create run for agent %q: empty tenant_id", agentName)
	}

	req, err := buildCreateRunRequest(agentName, input)
	if err != nil {
		return "", fmt.Errorf("runclient: build request for agent %q (tenant %s): %w", agentName, tenantID, err)
	}

	run, err := c.rpc.CreateRun(outgoingContext(ctx, tenantID, c.serviceToken), req)
	if err != nil {
		return "", fmt.Errorf("runclient: CreateRun agent %q (tenant %s): %w", agentName, tenantID, err)
	}

	c.logger.Info("created run from schedule",
		zap.String("tenant_id", tenantID),
		zap.String("agent_name", agentName),
		zap.String("run_id", run.GetId()),
	)
	return run.GetId(), nil
}

// outgoingContext attaches the tenant_id (always) and the service token (only
// when non-empty) to the outgoing gRPC metadata.
func outgoingContext(ctx context.Context, tenantID, serviceToken string) context.Context {
	pairs := []string{tenantMetadataKey, tenantID}
	if serviceToken != "" {
		pairs = append(pairs, serviceTokenMetadataKey, serviceToken)
	}
	return metadata.AppendToOutgoingContext(ctx, pairs...)
}

// buildCreateRunRequest constructs a schedule-triggered CreateRunRequest. The
// schedule's input_template is a JSON object; it is decoded into a structpb
// Struct for the run input. An empty/null template yields a nil input.
func buildCreateRunRequest(agentName string, input json.RawMessage) (*lanternv1.CreateRunRequest, error) {
	req := &lanternv1.CreateRunRequest{
		AgentName:   agentName,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_SCHEDULE,
	}

	inputStruct, err := inputToStruct(input)
	if err != nil {
		return nil, err
	}
	req.Input = inputStruct
	return req, nil
}

// inputToStruct converts a JSON-object input template into a structpb.Struct.
// Empty input or the JSON literal null returns (nil, nil) — a run with no input.
func inputToStruct(input json.RawMessage) (*structpb.Struct, error) {
	if len(input) == 0 {
		return nil, nil
	}

	var m map[string]any
	if err := json.Unmarshal(input, &m); err != nil {
		return nil, fmt.Errorf("decode input template: %w", err)
	}
	if m == nil {
		return nil, nil
	}

	s, err := structpb.NewStruct(m)
	if err != nil {
		return nil, fmt.Errorf("build input struct: %w", err)
	}
	return s, nil
}
