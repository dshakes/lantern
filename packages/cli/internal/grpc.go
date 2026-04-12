package internal

import (
	"context"
	"fmt"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// ClientConfig holds the connection parameters for the Lantern API.
type ClientConfig struct {
	APIUrl   string
	APIKey   string
	TenantID string
}

// Clients bundles the typed gRPC service stubs.
type Clients struct {
	Agents lanternv1.AgentServiceClient
	Runs   lanternv1.RunServiceClient
	conn   *grpc.ClientConn
}

// Close releases the underlying gRPC connection.
func (c *Clients) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

// Dial creates a gRPC connection to the Lantern control plane and returns
// typed service clients. Every outgoing call automatically carries tenant_id
// and api_key as gRPC metadata.
func Dial(cfg ClientConfig) (*Clients, error) {
	conn, err := grpc.NewClient(
		cfg.APIUrl,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithUnaryInterceptor(metadataUnaryInterceptor(cfg)),
		grpc.WithStreamInterceptor(metadataStreamInterceptor(cfg)),
	)
	if err != nil {
		return nil, fmt.Errorf("grpc dial %s: %w", cfg.APIUrl, err)
	}

	return &Clients{
		Agents: lanternv1.NewAgentServiceClient(conn),
		Runs:   lanternv1.NewRunServiceClient(conn),
		conn:   conn,
	}, nil
}

// metadataUnaryInterceptor attaches tenant_id and api_key to every unary call.
func metadataUnaryInterceptor(cfg ClientConfig) grpc.UnaryClientInterceptor {
	return func(
		ctx context.Context,
		method string,
		req, reply any,
		cc *grpc.ClientConn,
		invoker grpc.UnaryInvoker,
		opts ...grpc.CallOption,
	) error {
		ctx = attachMetadata(ctx, cfg)
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}

// metadataStreamInterceptor attaches tenant_id and api_key to every streaming call.
func metadataStreamInterceptor(cfg ClientConfig) grpc.StreamClientInterceptor {
	return func(
		ctx context.Context,
		desc *grpc.StreamDesc,
		cc *grpc.ClientConn,
		method string,
		streamer grpc.Streamer,
		opts ...grpc.CallOption,
	) (grpc.ClientStream, error) {
		ctx = attachMetadata(ctx, cfg)
		return streamer(ctx, desc, cc, method, opts...)
	}
}

// attachMetadata injects tenant_id and api_key into outgoing gRPC metadata.
func attachMetadata(ctx context.Context, cfg ClientConfig) context.Context {
	md := metadata.New(map[string]string{})
	if cfg.TenantID != "" {
		md.Set("tenant_id", cfg.TenantID)
	}
	if cfg.APIKey != "" {
		md.Set("authorization", "Bearer "+cfg.APIKey)
	}
	return metadata.NewOutgoingContext(ctx, md)
}
