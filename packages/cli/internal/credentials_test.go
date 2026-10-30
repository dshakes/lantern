package internal

import (
	"path/filepath"
	"testing"
)

func TestConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PAL_HOME", "")
	if got, err := ConfigDir(); err != nil || got != filepath.Join(home, ".pal") {
		t.Fatalf("ConfigDir() = %q, %v; want ~/.pal", got, err)
	}
	custom := filepath.Join(t.TempDir(), "custom")
	t.Setenv("PAL_HOME", custom)
	if got, err := ConfigDir(); err != nil || got != custom {
		t.Fatalf("ConfigDir() = %q, %v; want PAL_HOME", got, err)
	}
}

func TestCredentials_RoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PAL_HOME", "")
	if err := SaveCredentials(&Credentials{Token: "new"}); err != nil {
		t.Fatal(err)
	}
	if c, err := LoadCredentials(); err != nil || c == nil || c.Token != "new" {
		t.Fatalf("round trip lost the token: %+v, %v", c, err)
	}
}
