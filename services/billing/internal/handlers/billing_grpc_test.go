package handlers

import (
	"context"
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
	"github.com/dshakes/lantern/services/billing/internal/middleware"
	"github.com/dshakes/lantern/services/billing/internal/server"
)

// newBillingTestServer registers the real BillingService (behind the tenant
// interceptor) plus reflection on a bufconn listener and returns a connected
// client. The server has a nil Pool: the RPCs exercised here all fail at the
// request-validation boundary before any DB access, which is exactly what a
// registration smoke test wants to prove — the service is wired and answering.
func newBillingTestServer(t *testing.T) lanternv1.BillingServiceClient {
	t.Helper()

	logger := zaptest.NewLogger(t)
	lis := bufconn.Listen(1024 * 1024)
	grpcSrv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(middleware.UnaryTenantInterceptor(logger)),
	)

	svc := NewBillingService(&server.Server{Logger: logger})
	lanternv1.RegisterBillingServiceServer(grpcSrv, svc)
	reflection.Register(grpcSrv)

	go func() { _ = grpcSrv.Serve(lis) }()
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

	return lanternv1.NewBillingServiceClient(conn)
}

func tenantCtx(tenantID string) context.Context {
	return metadata.NewOutgoingContext(
		context.Background(),
		metadata.Pairs("tenant_id", tenantID),
	)
}

// TestBillingService_Registered proves RegisterBillingServiceServer actually
// wired the handler: a representative RPC reaches the method and returns the
// handler's own InvalidArgument (not Unimplemented), and tenant enforcement
// from the interceptor still applies.
func TestBillingService_Registered(t *testing.T) {
	client := newBillingTestServer(t)

	tests := []struct {
		name    string
		ctx     context.Context
		call    func(ctx context.Context) error
		wantErr codes.Code
	}{
		{
			name: "EmitUsage rejects empty events (handler reached)",
			ctx:  tenantCtx("tenant-1"),
			call: func(ctx context.Context) error {
				_, err := client.EmitUsage(ctx, &lanternv1.EmitUsageRequest{})
				return err
			},
			wantErr: codes.InvalidArgument,
		},
		{
			name: "SetBudget rejects non-positive limit (handler reached)",
			ctx:  tenantCtx("tenant-1"),
			call: func(ctx context.Context) error {
				_, err := client.SetBudget(ctx, &lanternv1.SetBudgetRequest{})
				return err
			},
			wantErr: codes.InvalidArgument,
		},
		{
			name: "GetUsage requires from/to (handler reached)",
			ctx:  tenantCtx("tenant-1"),
			call: func(ctx context.Context) error {
				_, err := client.GetUsage(ctx, &lanternv1.GetUsageRequest{})
				return err
			},
			wantErr: codes.InvalidArgument,
		},
		{
			name: "tenant interceptor rejects missing metadata",
			ctx:  context.Background(),
			call: func(ctx context.Context) error {
				_, err := client.EmitUsage(ctx, &lanternv1.EmitUsageRequest{})
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

// TestBillingService_ReflectionLists asserts the registered service is
// discoverable over server reflection (grpcurl / grpcui rely on this).
func TestBillingService_ReflectionLists(t *testing.T) {
	client := newBillingTestServer(t)
	_ = client // same process; build a reflection client over a fresh conn

	if !reflectionLists(t, billingDialer(t), "lantern.v1.BillingService") {
		t.Fatal("lantern.v1.BillingService not listed by server reflection")
	}
}

// billingDialer returns a bufconn-backed reflection client for a freshly
// registered billing server.
func billingDialer(t *testing.T) reflectionpb.ServerReflectionClient {
	t.Helper()

	logger := zaptest.NewLogger(t)
	lis := bufconn.Listen(1024 * 1024)
	grpcSrv := grpc.NewServer()
	lanternv1.RegisterBillingServiceServer(grpcSrv, NewBillingService(&server.Server{Logger: logger}))
	reflection.Register(grpcSrv)

	go func() { _ = grpcSrv.Serve(lis) }()
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

	return reflectionpb.NewServerReflectionClient(conn)
}

// reflectionLists returns true if want appears in the server's ListServices
// reflection response.
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
