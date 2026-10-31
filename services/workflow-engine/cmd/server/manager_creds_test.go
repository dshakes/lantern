package main

import (
	"context"
	"testing"
)

func TestManagerTransportCreds(t *testing.T) {
	tests := []struct {
		name         string
		prod         bool
		ca, crt, key string
		wantErr      bool
	}{
		{"dev unset → insecure", false, "", "", "", false},
		{"prod unset → error", true, "", "", "", true},
		{"half cert/key → error", false, "", "/c.pem", "", true},
		{"prod CA without client cert → error", true, "/ca.pem", "", "", true},
		{"missing CA file → error", false, "/does/not/exist.pem", "", "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PAL_RUNTIME_MANAGER_TLS_CA", tc.ca)
			t.Setenv("PAL_RUNTIME_MANAGER_TLS_CERT", tc.crt)
			t.Setenv("PAL_RUNTIME_MANAGER_TLS_KEY", tc.key)
			_, err := managerTransportCreds(tc.prod)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestServiceTokenCreds_AttachesToken(t *testing.T) {
	md, _ := serviceTokenCreds{token: "s3cret"}.GetRequestMetadata(context.Background())
	if md["x-pal-service-token"] != "s3cret" {
		t.Fatalf("metadata = %v", md)
	}
}
