package handlers_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/handlers"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// ctxWithTenant creates a context that simulates the tenant interceptor
// having extracted the tenant_id from gRPC metadata. We run the actual
// interceptor logic to ensure the unexported context key is set correctly.
func ctxWithTenant(tenantID string) context.Context {
	md := metadata.New(map[string]string{"tenant_id": tenantID})
	ctx := metadata.NewIncomingContext(context.Background(), md)

	// Run the real interceptor to inject the tenant into context.
	logger, _ := zap.NewDevelopment()
	interceptor := middleware.UnaryTenantInterceptor(logger)

	var resultCtx context.Context
	info := &grpc.UnaryServerInfo{FullMethod: "/test.Service/TestMethod"}
	_, _ = interceptor(ctx, nil, info, func(ctx context.Context, req any) (any, error) {
		resultCtx = ctx
		return nil, nil
	})
	return resultCtx
}

func ctxWithoutTenant() context.Context {
	return context.Background()
}

func newTestService(pool *pgxpool.Pool) *handlers.AgentService {
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{
		Pool:   pool,
		Logger: logger,
	}
	return handlers.NewAgentService(srv)
}

// ---------------------------------------------------------------------------
// CreateAgent tests
// ---------------------------------------------------------------------------

func TestCreateAgent_MissingTenant(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.CreateAgent(ctxWithoutTenant(), &lanternv1.CreateAgentRequest{
		Name: "test-agent",
	})
	if err == nil {
		t.Fatal("expected error for missing tenant")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %v", err)
	}
	if st.Code() != codes.Unauthenticated {
		t.Errorf("expected Unauthenticated, got %v", st.Code())
	}
}

func TestCreateAgent_EmptyName(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.CreateAgent(ctxWithTenant("tenant-1"), &lanternv1.CreateAgentRequest{
		Name: "",
	})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %v", err)
	}
	if st.Code() != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument, got %v", st.Code())
	}
}

// Note: Testing the full Create → Get → Delete flow requires a real Postgres
// connection (via testcontainers or a dev database). The tests here validate
// input validation and gRPC error codes without a database.

// ---------------------------------------------------------------------------
// GetAgent tests
// ---------------------------------------------------------------------------

func TestGetAgent_MissingTenant(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.GetAgent(ctxWithoutTenant(), &lanternv1.GetAgentRequest{
		Name: "test-agent",
	})
	if err == nil {
		t.Fatal("expected error for missing tenant")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.Unauthenticated {
		t.Errorf("expected Unauthenticated, got %v", st.Code())
	}
}

func TestGetAgent_EmptyName(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.GetAgent(ctxWithTenant("tenant-1"), &lanternv1.GetAgentRequest{
		Name: "",
	})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument, got %v", st.Code())
	}
}

// ---------------------------------------------------------------------------
// ListAgents tests
// ---------------------------------------------------------------------------

func TestListAgents_MissingTenant(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.ListAgents(ctxWithoutTenant(), &lanternv1.ListAgentsRequest{})
	if err == nil {
		t.Fatal("expected error for missing tenant")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.Unauthenticated {
		t.Errorf("expected Unauthenticated, got %v", st.Code())
	}
}

// Note: ListAgents page size clamping logic is tested as part of integration
// tests that require a real Postgres connection.

// ---------------------------------------------------------------------------
// DeleteAgent tests
// ---------------------------------------------------------------------------

func TestDeleteAgent_MissingTenant(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.DeleteAgent(ctxWithoutTenant(), &lanternv1.DeleteAgentRequest{
		Name: "test-agent",
	})
	if err == nil {
		t.Fatal("expected error for missing tenant")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.Unauthenticated {
		t.Errorf("expected Unauthenticated, got %v", st.Code())
	}
}

func TestDeleteAgent_EmptyName(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.DeleteAgent(ctxWithTenant("tenant-1"), &lanternv1.DeleteAgentRequest{
		Name: "",
	})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument, got %v", st.Code())
	}
}

// ---------------------------------------------------------------------------
// Unimplemented endpoints
// ---------------------------------------------------------------------------

func TestUpdateAgent_Unimplemented(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.UpdateAgent(context.Background(), &lanternv1.UpdateAgentRequest{})
	if err == nil {
		t.Fatal("expected error")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.Unimplemented {
		t.Errorf("expected Unimplemented, got %v", st.Code())
	}
}

func TestCreateAgentVersion_Unimplemented(t *testing.T) {
	svc := newTestService(nil)
	_, err := svc.CreateAgentVersion(context.Background(), &lanternv1.CreateAgentVersionRequest{})
	if err == nil {
		t.Fatal("expected error")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.Unimplemented {
		t.Errorf("expected Unimplemented, got %v", st.Code())
	}
}

// ---------------------------------------------------------------------------
// Utility tests
// ---------------------------------------------------------------------------

func TestLabelsJSON_RoundTrip(t *testing.T) {
	labels := map[string]string{"env": "prod", "team": "ml"}
	data, err := json.Marshal(labels)
	if err != nil {
		t.Fatalf("marshal labels: %v", err)
	}

	var parsed map[string]string
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal labels: %v", err)
	}

	if parsed["env"] != "prod" {
		t.Errorf("expected env=prod, got %v", parsed["env"])
	}
	if parsed["team"] != "ml" {
		t.Errorf("expected team=ml, got %v", parsed["team"])
	}
}
