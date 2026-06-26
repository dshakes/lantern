package dialer

// guard_test.go covers the prod-safety startup guards added in manager.go:
//
//   IsProd  — env parsing cases (mirrors control-plane handlers.IsProd)
//   R2      — CheckManagerDialer: prod+unset => fatal; prod+stub => fatal;
//              dev+unset => ok; dev+stub => ok; prod+set => ok.

import (
	"testing"
)

// ---------- IsProd ----------

func TestIsProd_UnsetIsNotProd(t *testing.T) {
	t.Setenv("LANTERN_ENV", "")
	if IsProd() {
		t.Error("expected IsProd()=false when LANTERN_ENV is unset")
	}
}

func TestIsProd_ProdValues(t *testing.T) {
	cases := []string{"prod", "PROD", "production", "Production", "PRODUCTION", "staging", "STAGING"}
	for _, v := range cases {
		t.Run(v, func(t *testing.T) {
			t.Setenv("LANTERN_ENV", v)
			if !IsProd() {
				t.Errorf("expected IsProd()=true for LANTERN_ENV=%q", v)
			}
		})
	}
}

func TestIsProd_DevValues(t *testing.T) {
	cases := []string{"dev", "development", "test", "local", ""}
	for _, v := range cases {
		t.Run(v, func(t *testing.T) {
			t.Setenv("LANTERN_ENV", v)
			if IsProd() {
				t.Errorf("expected IsProd()=false for LANTERN_ENV=%q", v)
			}
		})
	}
}

// ---------- CheckManagerDialer ----------

func TestCheckManagerDialer_ProdUnsetAddr_Fatal(t *testing.T) {
	fatal, msg := CheckManagerDialer(true, "", "")
	if !fatal {
		t.Error("prod + unset addr: expected fatal=true")
	}
	if msg == "" {
		t.Error("prod + unset addr: expected non-empty message")
	}
}

func TestCheckManagerDialer_ProdStubDialer_Fatal(t *testing.T) {
	// Even if addr is set, LANTERN_DIALER=stub must be fatal in prod.
	fatal, msg := CheckManagerDialer(true, "manager.internal:50054", "stub")
	if !fatal {
		t.Error("prod + LANTERN_DIALER=stub: expected fatal=true")
	}
	if msg == "" {
		t.Error("prod + LANTERN_DIALER=stub: expected non-empty message")
	}
}

func TestCheckManagerDialer_ProdSet_OK(t *testing.T) {
	fatal, msg := CheckManagerDialer(true, "manager.internal:50054", "")
	if fatal {
		t.Errorf("prod + set addr + no stub: expected fatal=false, got msg=%q", msg)
	}
	if msg != "" {
		t.Errorf("prod + set addr: expected empty message, got %q", msg)
	}
}

func TestCheckManagerDialer_DevUnset_OK(t *testing.T) {
	fatal, msg := CheckManagerDialer(false, "", "")
	if fatal {
		t.Errorf("dev + unset addr: expected fatal=false, got msg=%q", msg)
	}
	_ = msg
}

func TestCheckManagerDialer_DevStub_OK(t *testing.T) {
	// In dev, LANTERN_DIALER=stub is the explicit dev override — must be allowed.
	fatal, msg := CheckManagerDialer(false, "", "stub")
	if fatal {
		t.Errorf("dev + LANTERN_DIALER=stub: expected fatal=false, got msg=%q", msg)
	}
	_ = msg
}

func TestCheckManagerDialer_DevSet_OK(t *testing.T) {
	fatal, msg := CheckManagerDialer(false, "localhost:50054", "")
	if fatal {
		t.Errorf("dev + set addr: expected fatal=false, got msg=%q", msg)
	}
	_ = msg
}

// TestCheckManagerDialer_ViaEnv_ProdFatal wires the guard through the real env
// vars, matching the call site in cmd/scheduler/main.go.
func TestCheckManagerDialer_ViaEnv_ProdFatal(t *testing.T) {
	t.Setenv("LANTERN_ENV", "prod")
	t.Setenv("LANTERN_DEFAULT_MANAGER_ADDR", "")
	t.Setenv("LANTERN_DIALER", "")

	fatal, msg := CheckManagerDialer(IsProd(), "", "")
	if !fatal {
		t.Errorf("expected fatal via env: IsProd()=%v msg=%q", IsProd(), msg)
	}
}

func TestCheckManagerDialer_ViaEnv_DevSafe(t *testing.T) {
	t.Setenv("LANTERN_ENV", "")
	t.Setenv("LANTERN_DEFAULT_MANAGER_ADDR", "")
	t.Setenv("LANTERN_DIALER", "")

	fatal, _ := CheckManagerDialer(IsProd(), "", "")
	if fatal {
		t.Error("dev mode with no addr: expected fatal=false")
	}
}

func TestCheckManagerDialer_ViaEnv_ProdStubFatal(t *testing.T) {
	t.Setenv("LANTERN_ENV", "production")
	t.Setenv("LANTERN_DEFAULT_MANAGER_ADDR", "manager:50054")
	t.Setenv("LANTERN_DIALER", "stub")

	fatal, msg := CheckManagerDialer(IsProd(), "manager:50054", "stub")
	if !fatal {
		t.Errorf("prod + stub override via env: expected fatal=true, got msg=%q", msg)
	}
}
