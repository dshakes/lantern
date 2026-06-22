package main

// pool_config_test.go — unit tests for Item 1 (connection-pool tuning).
//
// Tests the env→config parsing helpers without starting a real Postgres or Redis.

import (
	"os"
	"testing"
	"time"
)

func TestEnvIntMain_Default(t *testing.T) {
	os.Unsetenv("LANTERN_TEST_INT")
	got := envIntMain("LANTERN_TEST_INT", 42)
	if got != 42 {
		t.Fatalf("expected default 42, got %d", got)
	}
}

func TestEnvIntMain_Set(t *testing.T) {
	t.Setenv("LANTERN_TEST_INT", "99")
	got := envIntMain("LANTERN_TEST_INT", 42)
	if got != 99 {
		t.Fatalf("expected 99, got %d", got)
	}
}

func TestEnvIntMain_NonPositiveIgnored(t *testing.T) {
	t.Setenv("LANTERN_TEST_INT", "0")
	got := envIntMain("LANTERN_TEST_INT", 42)
	if got != 42 {
		t.Fatalf("expected default 42 for non-positive value, got %d", got)
	}
}

func TestEnvIntMain_InvalidIgnored(t *testing.T) {
	t.Setenv("LANTERN_TEST_INT", "notanumber")
	got := envIntMain("LANTERN_TEST_INT", 42)
	if got != 42 {
		t.Fatalf("expected default 42 for invalid value, got %d", got)
	}
}

func TestEnvDurationMain_Default(t *testing.T) {
	os.Unsetenv("LANTERN_TEST_DUR")
	got := envDurationMain("LANTERN_TEST_DUR", time.Hour)
	if got != time.Hour {
		t.Fatalf("expected default 1h, got %v", got)
	}
}

func TestEnvDurationMain_Set(t *testing.T) {
	t.Setenv("LANTERN_TEST_DUR", "45m")
	got := envDurationMain("LANTERN_TEST_DUR", time.Hour)
	if got != 45*time.Minute {
		t.Fatalf("expected 45m, got %v", got)
	}
}

func TestEnvDurationMain_InvalidIgnored(t *testing.T) {
	t.Setenv("LANTERN_TEST_DUR", "notaduration")
	got := envDurationMain("LANTERN_TEST_DUR", time.Hour)
	if got != time.Hour {
		t.Fatalf("expected default 1h for invalid value, got %v", got)
	}
}

func TestParsePgxPoolConfig_Defaults(t *testing.T) {
	os.Unsetenv("LANTERN_PG_MAX_CONNS")
	os.Unsetenv("LANTERN_PG_MAX_CONN_LIFETIME")
	os.Unsetenv("LANTERN_PG_MAX_CONN_IDLE_TIME")

	cfg, err := parsePgxPoolConfig("postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable")
	if err != nil {
		t.Fatalf("parsePgxPoolConfig returned error: %v", err)
	}
	if cfg.MaxConns != 20 {
		t.Errorf("expected MaxConns=20, got %d", cfg.MaxConns)
	}
	if cfg.MaxConnLifetime != time.Hour {
		t.Errorf("expected MaxConnLifetime=1h, got %v", cfg.MaxConnLifetime)
	}
	if cfg.MaxConnIdleTime != 30*time.Minute {
		t.Errorf("expected MaxConnIdleTime=30m, got %v", cfg.MaxConnIdleTime)
	}
}

func TestParsePgxPoolConfig_EnvOverrides(t *testing.T) {
	t.Setenv("LANTERN_PG_MAX_CONNS", "50")
	t.Setenv("LANTERN_PG_MAX_CONN_LIFETIME", "2h")
	t.Setenv("LANTERN_PG_MAX_CONN_IDLE_TIME", "15m")

	cfg, err := parsePgxPoolConfig("postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable")
	if err != nil {
		t.Fatalf("parsePgxPoolConfig returned error: %v", err)
	}
	if cfg.MaxConns != 50 {
		t.Errorf("expected MaxConns=50, got %d", cfg.MaxConns)
	}
	if cfg.MaxConnLifetime != 2*time.Hour {
		t.Errorf("expected MaxConnLifetime=2h, got %v", cfg.MaxConnLifetime)
	}
	if cfg.MaxConnIdleTime != 15*time.Minute {
		t.Errorf("expected MaxConnIdleTime=15m, got %v", cfg.MaxConnIdleTime)
	}
}

func TestParsePgxPoolConfig_InvalidDSN(t *testing.T) {
	_, err := parsePgxPoolConfig("not-a-dsn://::bad")
	if err == nil {
		t.Fatal("expected error for invalid DSN, got nil")
	}
}
