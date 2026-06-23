package runclient

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"

	"go.uber.org/zap/zaptest"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// capturingRunService is an in-process RunServiceServer that records the
// CreateRun request plus the tenant_id / service-token it observed in the
// incoming gRPC metadata. CreateRun returns runErr when set, else a Run whose
// id is runID.
type capturingRunService struct {
	lanternv1.UnimplementedRunServiceServer

	runID  string
	runErr error

	gotReq          *lanternv1.CreateRunRequest
	gotTenantID     string
	gotServiceToken string
	gotMetadata     bool
}

func (s *capturingRunService) CreateRun(ctx context.Context, req *lanternv1.CreateRunRequest) (*lanternv1.Run, error) {
	s.gotReq = req
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		s.gotMetadata = true
		if v := md.Get(tenantMetadataKey); len(v) > 0 {
			s.gotTenantID = v[0]
		}
		if v := md.Get(serviceTokenMetadataKey); len(v) > 0 {
			s.gotServiceToken = v[0]
		}
	}
	if s.runErr != nil {
		return nil, s.runErr
	}
	return &lanternv1.Run{Id: s.runID}, nil
}

// newTestClient spins up a bufconn-backed RunService and returns a Client wired
// to it through an insecure in-memory dialer.
func newTestClient(t *testing.T, svc lanternv1.RunServiceServer, serviceToken string) *Client {
	t.Helper()

	lis := bufconn.Listen(1024 * 1024)
	grpcSrv := grpc.NewServer()
	lanternv1.RegisterRunServiceServer(grpcSrv, svc)

	go func() {
		_ = grpcSrv.Serve(lis)
	}()
	t.Cleanup(grpcSrv.Stop)

	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial bufconn: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	return &Client{
		conn:         conn,
		rpc:          lanternv1.NewRunServiceClient(conn),
		logger:       zaptest.NewLogger(t),
		serviceToken: serviceToken,
	}
}

func TestCreateRun(t *testing.T) {
	tests := []struct {
		name          string
		tenantID      string
		agentName     string
		input         json.RawMessage
		serviceToken  string
		svcRunID      string
		svcErr        error
		wantErr       bool
		wantRunID     string
		wantTenantID  string
		wantToken     string
		wantInputKeys []string
	}{
		{
			name:         "happy path injects tenant_id and builds schedule trigger",
			tenantID:     "tenant-abc",
			agentName:    "nightly-report",
			input:        json.RawMessage(`{"foo":"bar","n":3}`),
			svcRunID:     "run-123",
			wantRunID:    "run-123",
			wantTenantID: "tenant-abc",
			// no token configured -> nothing attached
			wantToken:     "",
			wantInputKeys: []string{"foo", "n"},
		},
		{
			name:         "service token attached when configured",
			tenantID:     "tenant-xyz",
			agentName:    "hourly-sync",
			serviceToken: "s3cr3t-token",
			svcRunID:     "run-456",
			wantRunID:    "run-456",
			wantTenantID: "tenant-xyz",
			wantToken:    "s3cr3t-token",
		},
		{
			name:         "nil input yields no struct",
			tenantID:     "tenant-1",
			agentName:    "agent-noinput",
			input:        nil,
			svcRunID:     "run-789",
			wantRunID:    "run-789",
			wantTenantID: "tenant-1",
		},
		{
			name:      "empty tenant rejected before RPC",
			tenantID:  "",
			agentName: "agent-x",
			wantErr:   true,
		},
		{
			name:      "control-plane error is wrapped",
			tenantID:  "tenant-err",
			agentName: "agent-fail",
			svcErr:    errors.New("boom"),
			wantErr:   true,
		},
		{
			name:      "invalid input template is a build error",
			tenantID:  "tenant-2",
			agentName: "agent-badinput",
			input:     json.RawMessage(`{not json}`),
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &capturingRunService{runID: tt.svcRunID, runErr: tt.svcErr}
			c := newTestClient(t, svc, tt.serviceToken)

			runID, err := c.CreateRun(context.Background(), tt.tenantID, tt.agentName, tt.input)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil (runID=%q)", runID)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if runID != tt.wantRunID {
				t.Errorf("runID = %q, want %q", runID, tt.wantRunID)
			}

			// Invariant #7: tenant_id rides in metadata.
			if !svc.gotMetadata {
				t.Fatal("server saw no incoming metadata")
			}
			if svc.gotTenantID != tt.wantTenantID {
				t.Errorf("metadata tenant_id = %q, want %q", svc.gotTenantID, tt.wantTenantID)
			}
			if svc.gotServiceToken != tt.wantToken {
				t.Errorf("metadata service token = %q, want %q", svc.gotServiceToken, tt.wantToken)
			}

			// Request construction: schedule-triggered, correct agent.
			if svc.gotReq.GetAgentName() != tt.agentName {
				t.Errorf("agent_name = %q, want %q", svc.gotReq.GetAgentName(), tt.agentName)
			}
			if svc.gotReq.GetTriggerKind() != lanternv1.TriggerKind_TRIGGER_KIND_SCHEDULE {
				t.Errorf("trigger_kind = %v, want SCHEDULE", svc.gotReq.GetTriggerKind())
			}

			if len(tt.wantInputKeys) > 0 {
				in := svc.gotReq.GetInput()
				if in == nil {
					t.Fatalf("expected input struct, got nil")
				}
				for _, k := range tt.wantInputKeys {
					if _, ok := in.GetFields()[k]; !ok {
						t.Errorf("input missing key %q", k)
					}
				}
			} else if tt.input == nil {
				if svc.gotReq.GetInput() != nil {
					t.Errorf("expected nil input, got %v", svc.gotReq.GetInput())
				}
			}
		})
	}
}

func TestInputToStruct(t *testing.T) {
	tests := []struct {
		name      string
		input     json.RawMessage
		wantNil   bool
		wantErr   bool
		wantKey   string
		wantValue string
	}{
		{name: "empty", input: nil, wantNil: true},
		{name: "json null", input: json.RawMessage(`null`), wantNil: true},
		{name: "object", input: json.RawMessage(`{"k":"v"}`), wantKey: "k", wantValue: "v"},
		{name: "malformed", input: json.RawMessage(`{`), wantErr: true},
		{name: "array not object", input: json.RawMessage(`[1,2]`), wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, err := inputToStruct(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantNil {
				if s != nil {
					t.Errorf("expected nil struct, got %v", s)
				}
				return
			}
			if got := s.GetFields()[tt.wantKey].GetStringValue(); got != tt.wantValue {
				t.Errorf("field %q = %q, want %q", tt.wantKey, got, tt.wantValue)
			}
		})
	}
}
