// Package middleware provides gRPC interceptors and HTTP helpers for
// extracting the tenant identity from incoming requests. Pattern matches
// services/control-plane and services/scheduler so call sites read the
// same regardless of which service you're in.
package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type tenantIDKey struct{}

// TenantIDFromContext extracts the tenant ID previously injected by
// either the gRPC interceptor or the HTTP auth helper.
func TenantIDFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(tenantIDKey{}).(string)
	return v, ok
}

// MustTenantID returns the tenant ID or a gRPC Unauthenticated error.
func MustTenantID(ctx context.Context) (string, error) {
	tid, ok := TenantIDFromContext(ctx)
	if !ok || tid == "" {
		return "", status.Error(codes.Unauthenticated, "missing tenant_id in metadata")
	}
	return tid, nil
}

// InjectTenantID is used by HTTP handlers that resolved the tenant via
// JWT and want downstream service code to use the same context key.
func InjectTenantID(ctx context.Context, tenantID string) context.Context {
	return context.WithValue(ctx, tenantIDKey{}, tenantID)
}

// UnaryTenantInterceptor extracts "tenant_id" from gRPC metadata.
func UnaryTenantInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		ctx, err := extractTenant(ctx, logger, info.FullMethod)
		if err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

// StreamTenantInterceptor extracts tenant_id for streaming RPCs.
func StreamTenantInterceptor(logger *zap.Logger) grpc.StreamServerInterceptor {
	return func(
		srv any,
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		ctx, err := extractTenant(ss.Context(), logger, info.FullMethod)
		if err != nil {
			return err
		}
		wrapped := &tenantStream{ServerStream: ss, ctx: ctx}
		return handler(srv, wrapped)
	}
}

func extractTenant(ctx context.Context, logger *zap.Logger, method string) (context.Context, error) {
	if isHealthCheck(method) {
		return ctx, nil
	}
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		logger.Warn("request missing metadata", zap.String("method", method))
		return ctx, status.Error(codes.Unauthenticated, "missing metadata")
	}
	vals := md.Get("tenant_id")
	if len(vals) == 0 || vals[0] == "" {
		logger.Warn("request missing tenant_id", zap.String("method", method))
		return ctx, status.Error(codes.Unauthenticated, "missing tenant_id in metadata")
	}
	return context.WithValue(ctx, tenantIDKey{}, vals[0]), nil
}

func isHealthCheck(method string) bool {
	return method == "/grpc.health.v1.Health/Check" ||
		method == "/grpc.health.v1.Health/Watch" ||
		method == "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo" ||
		method == "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo"
}

type tenantStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *tenantStream) Context() context.Context { return s.ctx }

// ---------------------------------------------------------------------
// HTTP auth helper
// ---------------------------------------------------------------------

// ResolveTenantHTTP validates the bearer JWT against the shared secret
// and returns the tenant_id claim. Used by the REST gateway. The signing
// algorithm and claim shape match services/control-plane/internal/handlers/auth.go.
func ResolveTenantHTTP(r *http.Request, secret []byte) (string, error) {
	authz := r.Header.Get("Authorization")
	if authz == "" {
		return "", status.Error(codes.Unauthenticated, "missing authorization header")
	}
	parts := strings.SplitN(authz, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return "", status.Error(codes.Unauthenticated, "invalid authorization header")
	}
	tok, err := jwt.Parse(parts[1], func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, status.Errorf(codes.Unauthenticated, "unexpected signing method: %v", t.Header["alg"])
		}
		return secret, nil
	})
	if err != nil || !tok.Valid {
		return "", status.Error(codes.Unauthenticated, "invalid token")
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return "", status.Error(codes.Unauthenticated, "invalid claims")
	}
	tid, _ := claims["tenant_id"].(string)
	if tid == "" {
		return "", status.Error(codes.Unauthenticated, "missing tenant_id claim")
	}
	return tid, nil
}
