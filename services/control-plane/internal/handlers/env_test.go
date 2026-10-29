package handlers

import "testing"

func TestAuthzEnforcing(t *testing.T) {
	for v, want := range map[string]bool{"": false, "0": false, "off": false, "1": true, "true": true, "ON": true} {
		t.Setenv("PAL_AUTHZ_ENFORCE", v)
		if got := AuthzEnforcing(); got != want {
			t.Errorf("LANTERN_AUTHZ_ENFORCE=%q: got %v want %v", v, got, want)
		}
	}
}
