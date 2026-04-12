package middleware

import (
	"context"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type tenantIDKey struct{}

func TenantIDFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(tenantIDKey{}).(string)
	return v, ok
}

func MustTenantID(ctx context.Context) (string, error) {
	tid, ok := TenantIDFromContext(ctx)
	if !ok || tid == "" {
		return "", status.Error(codes.Unauthenticated, "missing tenant_id in metadata")
	}
	return tid, nil
}

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

type tenantStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *tenantStream) Context() context.Context {
	return s.ctx
}
