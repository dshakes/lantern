package tunnel

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"
)

// RegistrationRequest contains the data sent to the control plane during
// initial registration. The control plane uses this to verify the tenant,
// validate the token, and assign a plane ID.
type RegistrationRequest struct {
	TenantID   string
	AgentToken string
	Version    string
	Hostname   string
	OS         string
	Arch       string
	StartTime  time.Time
}

// RegistrationResponse contains the data returned by the control plane after
// successful registration.
type RegistrationResponse struct {
	PlaneID           string
	TenantID          string
	SessionToken      string
	CertPEM           []byte
	KeyPEM            []byte
	HeartbeatInterval time.Duration
	Config            map[string]string
}

// buildRegistrationRequest constructs a RegistrationRequest from the current
// tunnel configuration and system information.
func (t *Tunnel) buildRegistrationRequest() RegistrationRequest {
	hostname := "unknown"
	// In production, read the actual hostname.
	// For the spike, use a placeholder.

	return RegistrationRequest{
		TenantID:   t.cfg.TenantID,
		AgentToken: t.cfg.AgentToken,
		Version:    "0.1.0",
		Hostname:   hostname,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		StartTime:  t.startTime,
	}
}

// performRegistration sends the registration request to the control plane and
// processes the response. In production, this uses the DataPlaneService.Register
// RPC. For the spike, it returns a simulated response.
func (t *Tunnel) performRegistration(ctx context.Context) (*RegistrationResponse, error) {
	ctx, span := tracer.Start(ctx, "tunnel.performRegistration")
	defer span.End()

	req := t.buildRegistrationRequest()

	span.SetAttributes(
		attribute.String("tenant_id", req.TenantID),
		attribute.String("version", req.Version),
		attribute.String("hostname", req.Hostname),
	)

	// Attach auth metadata.
	ctx = metadata.AppendToOutgoingContext(ctx,
		"x-lantern-tenant-id", req.TenantID,
		"x-lantern-agent-token", req.AgentToken,
	)

	t.logger.Info("performing registration",
		zap.String("tenant_id", req.TenantID),
		zap.String("version", req.Version),
		zap.String("os", req.OS),
		zap.String("arch", req.Arch),
	)

	// Validate required fields.
	if req.TenantID == "" {
		return nil, fmt.Errorf("tenant_id is required for registration")
	}
	if req.AgentToken == "" {
		return nil, fmt.Errorf("agent_token is required for registration")
	}

	// In production, call the gRPC Register RPC here:
	//   resp, err := client.Register(ctx, &pb.RegisterRequest{...})
	//
	// For the spike, simulate a successful registration.
	resp := &RegistrationResponse{
		PlaneID:           fmt.Sprintf("dp-%s-001", req.TenantID),
		TenantID:          req.TenantID,
		SessionToken:      "session-token-placeholder",
		HeartbeatInterval: t.cfg.HeartbeatInterval,
		Config:            map[string]string{},
	}

	t.logger.Info("registration successful",
		zap.String("plane_id", resp.PlaneID),
		zap.Duration("heartbeat_interval", resp.HeartbeatInterval),
	)

	return resp, nil
}

// refreshToken proactively refreshes the session token before it expires.
// Called periodically from the message loop.
func (t *Tunnel) refreshToken(ctx context.Context) error {
	_, span := tracer.Start(ctx, "tunnel.refreshToken")
	defer span.End()

	t.logger.Debug("refreshing session token",
		zap.String("plane_id", t.planeID),
	)

	// In production, call the gRPC RefreshToken RPC here.
	// The new token would be stored and used for subsequent requests.

	return nil
}
