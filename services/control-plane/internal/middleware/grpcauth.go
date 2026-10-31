package middleware

import (
	"context"
	"crypto/subtle"
	"net/http"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// ServiceTokenMetadataKey is the gRPC metadata key carrying the shared service
// token that authenticates trusted internal callers (e.g. the gateway) to the
// control-plane gRPC server.
const ServiceTokenMetadataKey = "x-pal-service-token"

// ServiceTokenFromHeader reads the service token from an HTTP request header.
func ServiceTokenFromHeader(h http.Header) string { return h.Get(ServiceTokenMetadataKey) }

// ServiceTokenFromMetadata reads the service token from gRPC metadata.
func ServiceTokenFromMetadata(md metadata.MD) string {
	if v := md.Get(ServiceTokenMetadataKey); len(v) > 0 {
		return v[0]
	}
	return ""
}

// OutgoingServiceTokenMetadata is the metadata a caller attaches.
func OutgoingServiceTokenMetadata(token string) map[string]string {
	return map[string]string{ServiceTokenMetadataKey: token}
}

// serviceTokenValid reports whether presented matches expected using a
// constant-time comparison (avoids leaking token length/prefix via timing).
func serviceTokenValid(expected, presented string) bool {
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}

// authenticateServiceToken validates the service token in incoming metadata.
//
// When expected is empty the check is disabled (dev/local pass-through); the
// caller is responsible for the prod fail-closed startup guard that refuses to
// boot with an empty token in production.
//
// Health checks and the DataPlaneService are exempt: the former carries no
// auth, the latter authenticates via its own bootstrap token + session JWT
// (and is the customer-VPC agent tunnel, not a trusted internal caller).
func authenticateServiceToken(ctx context.Context, logger *zap.Logger, expected, method string) error {
	if expected == "" {
		return nil
	}
	if isHealthCheck(method) || isDataPlaneService(method) {
		return nil
	}

	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		logger.Warn("service-token check: request missing metadata", zap.String("method", method))
		return status.Error(codes.Unauthenticated, "missing service token")
	}

	presented := ServiceTokenFromMetadata(md)
	if presented == "" || !serviceTokenValid(expected, presented) {
		logger.Warn("service-token check: invalid or missing token", zap.String("method", method))
		return status.Error(codes.Unauthenticated, "invalid service token")
	}

	return nil
}

// UnaryServiceAuthInterceptor returns a gRPC unary server interceptor that
// validates the shared service token in incoming metadata before any handler
// (or the tenant-extraction interceptor) runs. Chain it BEFORE the tenant
// interceptor so an unauthenticated caller can never set tenant_id.
func UnaryServiceAuthInterceptor(logger *zap.Logger, expectedToken string) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		if err := authenticateServiceToken(ctx, logger, expectedToken, info.FullMethod); err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

// StreamServiceAuthInterceptor returns a gRPC stream server interceptor that
// validates the shared service token in incoming metadata before any handler
// (or the tenant-extraction interceptor) runs.
func StreamServiceAuthInterceptor(logger *zap.Logger, expectedToken string) grpc.StreamServerInterceptor {
	return func(
		srv any,
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		if err := authenticateServiceToken(ss.Context(), logger, expectedToken, info.FullMethod); err != nil {
			return err
		}
		return handler(srv, ss)
	}
}
