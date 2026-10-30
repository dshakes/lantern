package middleware

import (
	"context"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Without a verified client cert only health and the customer-VPC tunnel pass;
// reflection and every service method are refused (ADR 0043).
func TestRequireServiceCert_Exemptions(t *testing.T) {
	for method, allowed := range map[string]bool{
		"/grpc.health.v1.Health/Check":                                   true,
		"/lantern.v1.DataPlaneService/Register":                          true,
		"/grpc.reflection.v1.ServerReflection/ServerReflectionInfo":      false,
		"/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo": false,
		"/lantern.v1.AgentService/ListAgents":                            false,
	} {
		err := requireServiceCert(context.Background(), zap.NewNop(), method)
		if allowed != (err == nil) {
			t.Errorf("%s: err=%v, want allowed=%v", method, err, allowed)
		}
		if err != nil && status.Code(err) != codes.Unauthenticated {
			t.Errorf("%s: code %v, want Unauthenticated", method, status.Code(err))
		}
	}
}
