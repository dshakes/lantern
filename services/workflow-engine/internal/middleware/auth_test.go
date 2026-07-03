package middleware_test

import (
	"context"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/dshakes/lantern/services/workflow-engine/internal/middleware"
)

func callUnaryAuth(t *testing.T, token, presentedToken, method string) error {
	t.Helper()
	interceptor := middleware.UnaryServiceAuthInterceptor(zap.NewNop(), token)
	md := metadata.New(nil)
	if presentedToken != "" {
		md.Set(middleware.ServiceTokenMetadataKey, presentedToken)
	}
	ctx := metadata.NewIncomingContext(context.Background(), md)
	_, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{FullMethod: method},
		func(ctx context.Context, req any) (any, error) { return nil, nil })
	return err
}

// TestServiceAuth_EmptyTokenAllowsAll verifies that an empty expected token
// (dev mode) admits any caller without a token.
func TestServiceAuth_EmptyTokenAllowsAll(t *testing.T) {
	if err := callUnaryAuth(t, "", "", "/lantern.v1.WorkflowEngineService/ExecuteRun"); err != nil {
		t.Fatalf("expected no error with empty expected token, got %v", err)
	}
}

// TestServiceAuth_ValidToken admits a caller with the correct token.
func TestServiceAuth_ValidToken(t *testing.T) {
	if err := callUnaryAuth(t, "secret", "secret", "/lantern.v1.WorkflowEngineService/ExecuteRun"); err != nil {
		t.Fatalf("expected no error with correct token, got %v", err)
	}
}

// TestServiceAuth_WrongToken rejects an incorrect token with Unauthenticated.
func TestServiceAuth_WrongToken(t *testing.T) {
	err := callUnaryAuth(t, "secret", "wrong", "/lantern.v1.WorkflowEngineService/ExecuteRun")
	if err == nil {
		t.Fatal("expected error for wrong token")
	}
	if status.Code(err) != codes.Unauthenticated {
		t.Errorf("expected Unauthenticated, got %v", status.Code(err))
	}
}

// TestServiceAuth_MissingToken rejects a caller that sends no token.
func TestServiceAuth_MissingToken(t *testing.T) {
	err := callUnaryAuth(t, "secret", "", "/lantern.v1.WorkflowEngineService/CancelRun")
	if err == nil {
		t.Fatal("expected error for missing token")
	}
	if status.Code(err) != codes.Unauthenticated {
		t.Errorf("expected Unauthenticated, got %v", status.Code(err))
	}
}

// TestServiceAuth_HealthCheckExempt verifies that health check methods pass
// through without a token even when a token is configured.
func TestServiceAuth_HealthCheckExempt(t *testing.T) {
	healthMethods := []string{
		"/grpc.health.v1.Health/Check",
		"/grpc.health.v1.Health/Watch",
		"/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
	}
	for _, method := range healthMethods {
		if err := callUnaryAuth(t, "secret", "", method); err != nil {
			t.Errorf("health method %s should be exempt, got %v", method, err)
		}
	}
}
