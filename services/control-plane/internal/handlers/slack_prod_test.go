package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

func TestSlackCommand_ProdWithoutSigningSecretIs401(t *testing.T) {
	cases := []struct {
		env  string
		want int
	}{
		{"production", http.StatusUnauthorized},
		{"staging", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run("env="+tc.env, func(t *testing.T) {
			t.Setenv("PAL_ENV", tc.env)
			t.Setenv("SLACK_SIGNING_SECRET", "")
			h := NewSlackCommandHandler(&server.Server{Logger: zap.NewNop()})
			req := httptest.NewRequest(http.MethodPost, "/v1/surfaces/slack/command", strings.NewReader("text=ping"))
			rec := httptest.NewRecorder()
			h.HandleCommand(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("code=%d want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestSlackFallbackTenant(t *testing.T) {
	for env, want := range map[string]string{"": devTenantID, "dev": devTenantID, "production": ""} {
		t.Setenv("PAL_ENV", env)
		if got := slackFallbackTenant(); got != want {
			t.Errorf("env=%q got %q want %q", env, got, want)
		}
	}
}
