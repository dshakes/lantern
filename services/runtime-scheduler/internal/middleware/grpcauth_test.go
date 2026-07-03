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

const testAuthMethod = "/lantern.v1.RuntimeScheduler/Schedule"

func ctxWithToken(tok string) context.Context {
	md := metadata.New(map[string]string{ServiceTokenMetadataKey: tok})
	return metadata.NewIncomingContext(context.Background(), md)
}

func TestAuthenticateServiceToken_ValidToken(t *testing.T) {
	err := authenticateServiceToken(ctxWithToken("s3cret"), zap.NewNop(), "s3cret", testAuthMethod)
	if err != nil {
		t.Fatalf("expected valid token to pass, got %v", err)
	}
}

func TestAuthenticateServiceToken_WrongToken(t *testing.T) {
	err := authenticateServiceToken(ctxWithToken("wrong"), zap.NewNop(), "s3cret", testAuthMethod)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated for wrong token, got %v", err)
	}
}

func TestAuthenticateServiceToken_MissingToken(t *testing.T) {
	ctx := metadata.NewIncomingContext(context.Background(), metadata.New(nil))
	err := authenticateServiceToken(ctx, zap.NewNop(), "s3cret", testAuthMethod)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated for missing token, got %v", err)
	}
}

func TestAuthenticateServiceToken_NoMetadata(t *testing.T) {
	err := authenticateServiceToken(context.Background(), zap.NewNop(), "s3cret", testAuthMethod)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated when metadata absent, got %v", err)
	}
}

func TestAuthenticateServiceToken_DisabledWhenExpectedEmpty(t *testing.T) {
	// Dev/local: no token configured → pass-through even with no metadata.
	if err := authenticateServiceToken(context.Background(), zap.NewNop(), "", testAuthMethod); err != nil {
		t.Fatalf("expected pass-through when expected token empty, got %v", err)
	}
	if err := authenticateServiceToken(ctxWithToken("anything"), zap.NewNop(), "", testAuthMethod); err != nil {
		t.Fatalf("expected pass-through when expected token empty, got %v", err)
	}
}

func TestAuthenticateServiceToken_HealthExempt(t *testing.T) {
	exempt := []string{
		"/grpc.health.v1.Health/Check",
		"/grpc.health.v1.Health/Watch",
		"/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
		"/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
	}
	for _, m := range exempt {
		t.Run(m, func(t *testing.T) {
			// Even with a configured token and no metadata, exempt methods pass.
			if err := authenticateServiceToken(context.Background(), zap.NewNop(), "s3cret", m); err != nil {
				t.Errorf("method %q should be exempt, got %v", m, err)
			}
		})
	}
}

func TestUnaryServiceAuthInterceptor_RejectsThenAllows(t *testing.T) {
	interceptor := UnaryServiceAuthInterceptor(zap.NewNop(), "s3cret")
	called := false
	handler := func(ctx context.Context, req any) (any, error) {
		called = true
		return "ok", nil
	}
	info := &grpc.UnaryServerInfo{FullMethod: testAuthMethod}

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
