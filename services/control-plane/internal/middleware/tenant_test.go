package middleware

import (
	"context"
	"testing"

	"go.uber.org/zap"
)

func TestExtractTenant_HealthCheck_NoMetadata(t *testing.T) {
	checks := []string{
		"/grpc.health.v1.Health/Check",
		"/grpc.health.v1.Health/Watch",
		"/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
		"/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
	}
	logger := zap.NewNop()
	for _, m := range checks {
		t.Run(m, func(t *testing.T) {
			_, err := extractTenant(context.Background(), logger, m)
			if err != nil {
				t.Errorf("expected no error for health-check method %q, got %v", m, err)
			}
		})
	}
}

func TestExtractTenant_DataPlaneService_NoMetadata(t *testing.T) {
	// DataPlaneService methods must NOT require tenant_id metadata — the service
	// authenticates via bootstrap token + session JWT. Any method under the
	// /lantern.v1.DataPlaneService/ prefix must pass through without metadata.
	methods := []string{
		"/lantern.v1.DataPlaneService/Register",
		"/lantern.v1.DataPlaneService/Heartbeat",
		"/lantern.v1.DataPlaneService/ReportMetrics",
		"/lantern.v1.DataPlaneService/RefreshToken",
		"/lantern.v1.DataPlaneService/RunStream",
	}
	logger := zap.NewNop()
	for _, m := range methods {
		t.Run(m, func(t *testing.T) {
			_, err := extractTenant(context.Background(), logger, m)
			if err != nil {
				t.Errorf("DataPlaneService method %q must not require tenant_id metadata, got %v", m, err)
			}
		})
	}
}

func TestExtractTenant_UnknownMethod_RequiresMetadata(t *testing.T) {
	logger := zap.NewNop()
	_, err := extractTenant(context.Background(), logger, "/lantern.v1.AgentService/ListAgents")
	if err == nil {
		t.Error("expected error for unknown method without metadata, got nil")
	}
}

func TestIsDataPlaneService(t *testing.T) {
	cases := []struct {
		method string
		want   bool
	}{
		{"/lantern.v1.DataPlaneService/Register", true},
		{"/lantern.v1.DataPlaneService/RunStream", true},
		{"/grpc.health.v1.Health/Check", false},
		{"/lantern.v1.AgentService/ListAgents", false},
		{"lantern.v1.DataPlaneService/Register", false}, // no leading slash
	}
	for _, tc := range cases {
		got := isDataPlaneService(tc.method)
		if got != tc.want {
			t.Errorf("isDataPlaneService(%q) = %v, want %v", tc.method, got, tc.want)
		}
	}
}
