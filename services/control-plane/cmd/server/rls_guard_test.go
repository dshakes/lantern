package main

// TestRLSGuardDecision proves that rlsGuardDecision enforces the
// prod-fail-closed contract (ADR 0042) without triggering os.Exit in tests.
//
// Secure-default semantics (ADR 0042):
//   - prod + PAL_APP_DB_PASSWORD set → implicit RLS ON (fatal=false, no msg).
//     The enforce value is irrelevant when the password is present.
//   - prod + no pwd + no explicit PAL_RLS_ENFORCE=0 → FATAL.
//   - prod + no pwd + PAL_RLS_ENFORCE=0 → WARN (acknowledged opt-out).
//   - dev → advisory only, never fatal.

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
		// No password, no explicit opt-out → fatal.
		{
			name:       "prod_rls_unset",
			isProd:     true,
			rlsEnforce: "",
			appPwd:     "",
			wantFatal:  true,
			wantMsgHas: "PAL_APP_DB_PASSWORD",
		},
		// enforce=1 but no password is still fatal (incomplete config).
		{
			name:       "prod_enforce_but_no_pwd",
			isProd:     true,
			rlsEnforce: "1",
			appPwd:     "",
			wantFatal:  true,
			wantMsgHas: "PAL_APP_DB_PASSWORD",
		},
		// Password set + explicit enforce=1: fully configured, no message.
		{
			name:       "prod_fully_configured",
			isProd:     true,
			rlsEnforce: "1",
			appPwd:     "s3cr3t",
			wantFatal:  false,
			wantMsgHas: "",
		},
		// Password set without explicit enforce: implicit secure default ON — not fatal.
		// ADR 0042: in prod, PAL_APP_DB_PASSWORD alone activates the app pool.
		{
			name:       "prod_implicit_secure_default",
			isProd:     true,
			rlsEnforce: "",
			appPwd:     "s3cr3t",
			wantFatal:  false,
			wantMsgHas: "",
		},
		// Password set with non-canonical enforce value: password wins → not fatal.
		{
			name:       "prod_pwd_set_enforce_any_value",
			isProd:     true,
			rlsEnforce: "true",
			appPwd:     "s3cr3t",
			wantFatal:  false,
			wantMsgHas: "",
		},
		// Explicit opt-out in prod (acknowledged, not fatal, but loud WARN).
		{
			name:       "prod_explicit_opt_out",
			isProd:     true,
			rlsEnforce: "0",
			appPwd:     "",
			wantFatal:  false,
			wantMsgHas: "PAL_RLS_ENFORCE",
		},
		// Explicit opt-out wins even when the password IS set: rlsEnforceActive
		// returns false when PAL_RLS_ENFORCE=0 regardless of appPwd, so the guard
		// must emit the same WARN (not silently succeed) to match the activation logic.
		{
			name:       "prod_explicit_opt_out_with_pwd",
			isProd:     true,
			rlsEnforce: "0",
			appPwd:     "s3cr3t",
			wantFatal:  false,
			wantMsgHas: "PAL_RLS_ENFORCE",
		},

		// --- dev cases (advisory only, never fatal) ---
		{
			name:       "dev_rls_unset",
			isProd:     false,
			rlsEnforce: "",
			appPwd:     "",
			wantFatal:  false,
			wantMsgHas: "PAL_APP_DB_PASSWORD", // advisory warn about missing password
		},
		{
			name:       "dev_enforce_but_no_pwd",
			isProd:     false,
			rlsEnforce: "1",
			appPwd:     "",
			wantFatal:  false,
			wantMsgHas: "PAL_APP_DB_PASSWORD", // advisory warn about missing password
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
