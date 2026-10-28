package handlers

import (
	"net/http/httptest"
	"testing"
)

// The deploy response URL is built from this; it once hardcoded localhost:8080.
func TestDerivePublicURL(t *testing.T) {
	r := httptest.NewRequest("POST", "http://api.example.com/v1/agents/a/deploy", nil)
	if got := derivePublicURL(r); got != "http://api.example.com" {
		t.Errorf("plain: got %q", got)
	}
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Forwarded-Host", "lantern.example.org")
	if got := derivePublicURL(r); got != "https://lantern.example.org" {
		t.Errorf("forwarded: got %q", got)
	}
	t.Setenv("LANTERN_PUBLIC_BASE_URL", "https://public.example.net/")
	if got := derivePublicURL(r); got != "https://public.example.net" {
		t.Errorf("override: got %q", got)
	}
}
