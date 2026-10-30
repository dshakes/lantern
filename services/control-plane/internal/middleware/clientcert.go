package middleware

import (
	"context"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// requireServiceCert demands a CA-verified client certificate (ADR 0043).
//
// The :50051 listener verifies a presented cert at the handshake (CA + the
// PAL_GRPC_TLS_ALLOWED_PEERS SPIFFE allowlist) but cannot demand one there:
// the customer-VPC DataPlaneService tunnel shares the port and authenticates
// with its own bootstrap token + JWT. So the demand is made here, per method,
// exempting only health and DataPlaneService.
func requireServiceCert(ctx context.Context, logger *zap.Logger, method string) error {
	// Health and the customer-VPC tunnel only. Unlike the token check, gRPC
	// reflection is NOT exempt: on an mTLS server the schema is mesh-only.
	if method == "/grpc.health.v1.Health/Check" || method == "/grpc.health.v1.Health/Watch" ||
		isDataPlaneService(method) {
		return nil
	}
	if p, ok := peer.FromContext(ctx); ok {
		if ti, ok := p.AuthInfo.(credentials.TLSInfo); ok && len(ti.State.VerifiedChains) > 0 {
			return nil
		}
	}
	logger.Warn("mTLS: call without a verified client certificate", zap.String("method", method))
	return status.Error(codes.Unauthenticated, "client certificate required")
}

// UnaryRequireServiceCert rejects unary calls without a verified client cert.
// Install it FIRST in the chain, and only when the server runs mTLS.
func UnaryRequireServiceCert(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if err := requireServiceCert(ctx, logger, info.FullMethod); err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

// StreamRequireServiceCert is the streaming twin of UnaryRequireServiceCert.
func StreamRequireServiceCert(logger *zap.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if err := requireServiceCert(ss.Context(), logger, info.FullMethod); err != nil {
			return err
		}
		return handler(srv, ss)
	}
}
