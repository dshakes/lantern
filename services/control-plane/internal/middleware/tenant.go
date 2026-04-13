package middleware

import (
	"context"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// tenantIDKey is an unexported context key to avoid collisions.
type tenantIDKey struct{}

// TenantIDFromContext extracts the tenant ID previously injected by the
// tenant interceptor. Returns ("", false) if not present.
func TenantIDFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(tenantIDKey{}).(string)
	return v, ok
}

// InjectTenantID sets the tenant ID in the context. Used by REST handlers
// that bypass the gRPC interceptor chain.
func InjectTenantID(ctx context.Context, tenantID string) context.Context {
	return context.WithValue(ctx, tenantIDKey{}, tenantID)
}

// MustTenantID is a convenience wrapper that returns a gRPC error if the
// tenant ID is missing. Handlers should call this at the top.
func MustTenantID(ctx context.Context) (string, error) {
	tid, ok := TenantIDFromContext(ctx)
	if !ok || tid == "" {
		return "", status.Error(codes.Unauthenticated, "missing tenant_id in metadata")
	}
	return tid, nil
}

// UnaryTenantInterceptor returns a gRPC unary server interceptor that extracts
// "tenant_id" from incoming metadata and injects it into the context.
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

// StreamTenantInterceptor returns a gRPC stream server interceptor that
// extracts "tenant_id" from incoming metadata and injects it into the context.
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

// extractTenant pulls "tenant_id" from gRPC metadata. Health-check endpoints
// are exempt from the requirement.
func extractTenant(ctx context.Context, logger *zap.Logger, method string) (context.Context, error) {
	// Allow health checks through without a tenant.
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

	tenantID := vals[0]
	ctx = context.WithValue(ctx, tenantIDKey{}, tenantID)

	logger.Debug("tenant extracted",
		zap.String("tenant_id", tenantID),
		zap.String("method", method),
	)

	return ctx, nil
}

func isHealthCheck(method string) bool {
	return method == "/grpc.health.v1.Health/Check" ||
		method == "/grpc.health.v1.Health/Watch" ||
		method == "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo" ||
		method == "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo"
}

// tenantStream wraps a grpc.ServerStream to override Context().
type tenantStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *tenantStream) Context() context.Context {
	return s.ctx
}
