package handlers

// White-box tests for the env-configurable fork cap + concurrency helpers.
// Kept separate from lifecycle_test.go (package handlers_test) because the
// functions under test are unexported.

import (
	"os"
	"testing"
)

func TestMaxForkCount_defaults(t *testing.T) {
	os.Unsetenv("LANTERN_MAX_FORK_COUNT")
	if got := maxForkCount(); got != defaultMaxForkCount {
		t.Errorf("unset LANTERN_MAX_FORK_COUNT: got %d, want %d", got, defaultMaxForkCount)
	}
}

func TestMaxForkCount_custom(t *testing.T) {
	t.Setenv("LANTERN_MAX_FORK_COUNT", "50")
	if got := maxForkCount(); got != 50 {
		t.Errorf("LANTERN_MAX_FORK_COUNT=50: got %d", got)
	}
}

func TestMaxForkCount_ceiling(t *testing.T) {
	t.Setenv("LANTERN_MAX_FORK_COUNT", "9999")
	if got := maxForkCount(); got != maxForkCountCeiling {
		t.Errorf("LANTERN_MAX_FORK_COUNT=9999: got %d, want ceiling %d", got, maxForkCountCeiling)
	}
}

func TestMaxForkCount_invalid(t *testing.T) {
	t.Setenv("LANTERN_MAX_FORK_COUNT", "not-a-number")
	if got := maxForkCount(); got != defaultMaxForkCount {
		t.Errorf("invalid LANTERN_MAX_FORK_COUNT: got %d, want default %d", got, defaultMaxForkCount)
	}
}

func TestMaxForkCount_zero_or_negative(t *testing.T) {
	for _, v := range []string{"0", "-1"} {
		t.Setenv("LANTERN_MAX_FORK_COUNT", v)
		if got := maxForkCount(); got != defaultMaxForkCount {
			t.Errorf("LANTERN_MAX_FORK_COUNT=%s: got %d, want default %d", v, got, defaultMaxForkCount)
		}
	}
}

func TestForkConcurrency_default(t *testing.T) {
	os.Unsetenv("LANTERN_FORK_CONCURRENCY")
	if got := forkConcurrency(); got != defaultForkConcurrency {
		t.Errorf("unset LANTERN_FORK_CONCURRENCY: got %d, want %d", got, defaultForkConcurrency)
	}
}

func TestForkConcurrency_custom(t *testing.T) {
	t.Setenv("LANTERN_FORK_CONCURRENCY", "32")
	if got := forkConcurrency(); got != 32 {
		t.Errorf("LANTERN_FORK_CONCURRENCY=32: got %d", got)
	}
}

func TestEnvInt_missing_returns_default(t *testing.T) {
	os.Unsetenv("LANTERN_TEST_ENVINT_MISSING")
	if got := envInt("LANTERN_TEST_ENVINT_MISSING", 7); got != 7 {
		t.Errorf("missing env: got %d, want 7", got)
	}
}

func TestEnvInt_valid(t *testing.T) {
	t.Setenv("LANTERN_TEST_ENVINT_VAL", "42")
	if got := envInt("LANTERN_TEST_ENVINT_VAL", 1); got != 42 {
		t.Errorf("envInt: got %d, want 42", got)
	}
}

func TestEnvInt_invalid_returns_default(t *testing.T) {
	t.Setenv("LANTERN_TEST_ENVINT_BAD", "banana")
	if got := envInt("LANTERN_TEST_ENVINT_BAD", 5); got != 5 {
		t.Errorf("invalid envInt: got %d, want 5", got)
	}
}
