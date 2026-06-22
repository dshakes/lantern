package main

// TestRLSGuardDecision proves that rlsGuardDecision enforces the
// prod-fail-closed contract without triggering os.Exit in tests.
//
// The table covers:
//   (d) LANTERN_ENV=prod + RLS unset → fatal=true (the prod guard fires).
//   Corollaries:
//     - prod + enforce=1 but no password → fatal=true (incomplete config).
//     - prod + enforce=1 + password set  → fatal=false (correctly configured).
//     - dev (any RLS state)              → fatal=false (dev is advisory-only).

import (
	"strings"
	"testing"
)

func TestRLSGuardDecision(t *testing.T) {
	tests := []struct {
		name       string
		isProd     bool
		rlsEnforce string
		appPwd     string
		wantFatal  bool
		wantMsgHas string // non-empty substring that must appear in message when set
	}{
		// --- prod cases (fail-closed) ---
		{
			name:       "prod_rls_unset",
			isProd:     true,
			rlsEnforce: "",
			appPwd:     "",
			wantFatal:  true,
			wantMsgHas: "LANTERN_RLS_ENFORCE",
		},
		{
			name:       "prod_enforce_but_no_pwd",
			isProd:     true,
			rlsEnforce: "1",
			appPwd:     "",
			wantFatal:  true,
			wantMsgHas: "LANTERN_APP_DB_PASSWORD",
		},
		{
			name:       "prod_fully_configured",
			isProd:     true,
			rlsEnforce: "1",
			appPwd:     "s3cr3t",
			wantFatal:  false,
			wantMsgHas: "",
		},
		{
			name:       "prod_wrong_enforce_value",
			isProd:     true,
			rlsEnforce: "true",
			appPwd:     "s3cr3t",
			wantFatal:  true, // must be exactly "1"
			wantMsgHas: "LANTERN_RLS_ENFORCE",
		},

		// --- dev cases (advisory only, never fatal) ---
		{
			name:       "dev_rls_unset",
			isProd:     false,
			rlsEnforce: "",
			appPwd:     "",
			wantFatal:  false,
			wantMsgHas: "LANTERN_RLS_ENFORCE", // warn present
		},
		{
			name:       "dev_enforce_but_no_pwd",
			isProd:     false,
			rlsEnforce: "1",
			appPwd:     "",
			wantFatal:  false,
			wantMsgHas: "LANTERN_RLS_ENFORCE", // warn present
		},
		{
			name:       "dev_fully_configured",
			isProd:     false,
			rlsEnforce: "1",
			appPwd:     "s3cr3t",
			wantFatal:  false,
			wantMsgHas: "", // no warn needed
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			fatal, msg := rlsGuardDecision(tc.isProd, tc.rlsEnforce, tc.appPwd)
			if fatal != tc.wantFatal {
				t.Errorf("rlsGuardDecision(isProd=%v, enforce=%q, pwd=%q): fatal=%v, want %v (msg: %q)",
					tc.isProd, tc.rlsEnforce, tc.appPwd, fatal, tc.wantFatal, msg)
			}
			if tc.wantMsgHas != "" && msg == "" {
				t.Errorf("expected non-empty message containing %q, got empty", tc.wantMsgHas)
			}
			if tc.wantMsgHas != "" {
				if !strings.Contains(msg, tc.wantMsgHas) {
					t.Errorf("expected message to contain %q, got: %q", tc.wantMsgHas, msg)
				}
			}
		})
	}
}
