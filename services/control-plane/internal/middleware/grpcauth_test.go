package middleware

import (
	"context"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const testMethod = "/lantern.v1.AgentService/ListAgents"

func ctxWithToken(tok string) context.Context {
	md := metadata.New(map[string]string{ServiceTokenMetadataKey: tok})
	return metadata.NewIncomingContext(context.Background(), md)
}

func TestAuthenticateServiceToken_ValidToken(t *testing.T) {
	logger := zap.NewNop()
	err := authenticateServiceToken(ctxWithToken("s3cret"), logger, "s3cret", testMethod)
	if err != nil {
		t.Fatalf("expected valid token to pass, got %v", err)
	}
}

func TestAuthenticateServiceToken_WrongToken(t *testing.T) {
	logger := zap.NewNop()
	err := authenticateServiceToken(ctxWithToken("wrong"), logger, "s3cret", testMethod)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated for wrong token, got %v", err)
	}
}

func TestAuthenticateServiceToken_MissingToken(t *testing.T) {
	logger := zap.NewNop()
	// Metadata present but no service-token header.
	ctx := metadata.NewIncomingContext(context.Background(), metadata.New(map[string]string{}))
	err := authenticateServiceToken(ctx, logger, "s3cret", testMethod)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated for missing token, got %v", err)
	}
}

func TestAuthenticateServiceToken_NoMetadata(t *testing.T) {
	logger := zap.NewNop()
	err := authenticateServiceToken(context.Background(), logger, "s3cret", testMethod)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated when metadata absent, got %v", err)
	}
}

func TestAuthenticateServiceToken_DisabledWhenExpectedEmpty(t *testing.T) {
	// Dev/local: no token configured → pass-through even with no metadata.
	logger := zap.NewNop()
	if err := authenticateServiceToken(context.Background(), logger, "", testMethod); err != nil {
		t.Fatalf("expected pass-through when expected token empty, got %v", err)
	}
	// Also passes when the caller supplies a (now irrelevant) token.
	if err := authenticateServiceToken(ctxWithToken("anything"), logger, "", testMethod); err != nil {
		t.Fatalf("expected pass-through when expected token empty, got %v", err)
	}
}

func TestAuthenticateServiceToken_HealthAndDataPlaneExempt(t *testing.T) {
	logger := zap.NewNop()
	exempt := []string{
		"/grpc.health.v1.Health/Check",
		"/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
		"/lantern.v1.DataPlaneService/Register",
		"/lantern.v1.DataPlaneService/RunStream",
	}
	for _, m := range exempt {
		t.Run(m, func(t *testing.T) {
			// Even with a configured token and no metadata, exempt methods pass.
			if err := authenticateServiceToken(context.Background(), logger, "s3cret", m); err != nil {
				t.Errorf("method %q should be exempt from service-token check, got %v", m, err)
			}
		})
	}
}

func TestUnaryServiceAuthInterceptor_RejectsThenAllows(t *testing.T) {
	logger := zap.NewNop()
	interceptor := UnaryServiceAuthInterceptor(logger, "s3cret")
	called := false
	handler := func(ctx context.Context, req any) (any, error) {
		called = true
		return "ok", nil
	}
	info := &grpc.UnaryServerInfo{FullMethod: testMethod}

	// Wrong token → rejected, handler not called.
	_, err := interceptor(ctxWithToken("nope"), nil, info, handler)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated, got %v", err)
	}
	if called {
		t.Fatal("handler must not run on auth failure")
	}

	// Valid token → handler runs.
	out, err := interceptor(ctxWithToken("s3cret"), nil, info, handler)
	if err != nil {
		t.Fatalf("expected success with valid token, got %v", err)
	}
	if out != "ok" || !called {
		t.Fatalf("expected handler to run and return ok, got %v called=%v", out, called)
	}
}
