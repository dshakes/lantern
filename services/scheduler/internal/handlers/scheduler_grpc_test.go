package handlers

import (
	"context"
	"encoding/json"
	"net"
	"testing"

	"go.uber.org/zap/zaptest"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"
	reflectionpb "google.golang.org/grpc/reflection/grpc_reflection_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/scheduler/internal/server"
)

// newSchedulerTestServer registers the real SchedulerService (behind the
// tenant interceptor) plus reflection on a bufconn listener. The server has a
// nil Pool and a no-op run creator: the RPCs exercised here all fail at the
// request-validation boundary before any DB access, proving the service is
// wired and answering.
func newSchedulerTestServer(t *testing.T) lanternv1.SchedulerServiceClient {
	t.Helper()

	logger := zaptest.NewLogger(t)
	lis := bufconn.Listen(1024 * 1024)
	grpcSrv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(middleware.UnaryTenantInterceptor(logger)),
	)

	noopCreate := func(context.Context, string, string, json.RawMessage) (string, error) { return "run-noop", nil }
	svc := NewSchedulerService(&server.Server{Logger: logger}, noopCreate)
	lanternv1.RegisterSchedulerServiceServer(grpcSrv, svc)
	reflection.Register(grpcSrv)

	go func() { _ = grpcSrv.Serve(lis) }()
	t.Cleanup(grpcSrv.Stop)

	conn := dialBufconn(t, lis)
	return lanternv1.NewSchedulerServiceClient(conn)
}

func dialBufconn(t *testing.T, lis *bufconn.Listener) *grpc.ClientConn {
	t.Helper()
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
	return conn
}

func tenantCtx(tenantID string) context.Context {
	return metadata.NewOutgoingContext(
		context.Background(),
		metadata.Pairs("tenant_id", tenantID),
	)
}

// TestSchedulerService_Registered proves RegisterSchedulerServiceServer wired
// the handler: representative RPCs reach the method and return the handler's
// own InvalidArgument (not Unimplemented), and tenant enforcement applies.
func TestSchedulerService_Registered(t *testing.T) {
	client := newSchedulerTestServer(t)

	tests := []struct {
		name    string
		ctx     context.Context
		call    func(ctx context.Context) error
		wantErr codes.Code
	}{
		{
			name: "Trigger requires agent_name (handler reached)",
			ctx:  tenantCtx("tenant-1"),
			call: func(ctx context.Context) error {
				_, err := client.Trigger(ctx, &lanternv1.TriggerRequest{})
				return err
			},
			wantErr: codes.InvalidArgument,
		},
		{
			name: "RegisterSchedule requires agent_name (handler reached)",
			ctx:  tenantCtx("tenant-1"),
			call: func(ctx context.Context) error {
				_, err := client.RegisterSchedule(ctx, &lanternv1.RegisterScheduleRequest{})
				return err
			},
			wantErr: codes.InvalidArgument,
		},
		{
			name: "DeleteSchedule requires schedule_id (handler reached)",
			ctx:  tenantCtx("tenant-1"),
			call: func(ctx context.Context) error {
				_, err := client.DeleteSchedule(ctx, &lanternv1.DeleteScheduleRequest{})
				return err
			},
			wantErr: codes.InvalidArgument,
		},
		{
			name: "tenant interceptor rejects missing metadata",
			ctx:  context.Background(),
			call: func(ctx context.Context) error {
				_, err := client.Trigger(ctx, &lanternv1.TriggerRequest{})
				return err
			},
			wantErr: codes.Unauthenticated,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call(tt.ctx)
			if got := status.Code(err); got != tt.wantErr {
				t.Fatalf("code = %v, want %v (err=%v)", got, tt.wantErr, err)
			}
		})
	}
}

// TestSchedulerService_ReflectionLists asserts the registered service is
// discoverable over server reflection.
func TestSchedulerService_ReflectionLists(t *testing.T) {
	logger := zaptest.NewLogger(t)
	lis := bufconn.Listen(1024 * 1024)
	grpcSrv := grpc.NewServer()
	noopCreate := func(context.Context, string, string, json.RawMessage) (string, error) { return "", nil }
	lanternv1.RegisterSchedulerServiceServer(grpcSrv, NewSchedulerService(&server.Server{Logger: logger}, noopCreate))
	reflection.Register(grpcSrv)

	go func() { _ = grpcSrv.Serve(lis) }()
	t.Cleanup(grpcSrv.Stop)

	rc := reflectionpb.NewServerReflectionClient(dialBufconn(t, lis))
	if !reflectionLists(t, rc, "lantern.v1.SchedulerService") {
		t.Fatal("lantern.v1.SchedulerService not listed by server reflection")
	}
}

func reflectionLists(t *testing.T, rc reflectionpb.ServerReflectionClient, want string) bool {
	t.Helper()

	stream, err := rc.ServerReflectionInfo(context.Background())
	if err != nil {
		t.Fatalf("ServerReflectionInfo: %v", err)
	}
	if err := stream.Send(&reflectionpb.ServerReflectionRequest{
		MessageRequest: &reflectionpb.ServerReflectionRequest_ListServices{ListServices: ""},
	}); err != nil {
		t.Fatalf("send list services: %v", err)
	}
	resp, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv list services: %v", err)
	}
	for _, svc := range resp.GetListServicesResponse().GetService() {
		if svc.GetName() == want {
			return true
		}
	}
	return false
}
