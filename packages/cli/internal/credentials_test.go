package internal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigDir(t *testing.T) {
	cases := []struct {
		name    string
		palHome bool     // set PAL_HOME
		mkdirs  []string // dirs created under HOME
		want    string   // relative to HOME, or "PAL_HOME"
	}{
		{"fresh install defaults to .pal", false, nil, ".pal"},
		{"legacy .pal used in place", false, []string{".pal"}, ".pal"},
		{".pal wins over legacy", false, []string{".pal", ".pal"}, ".pal"},
		{"PAL_HOME wins over both", true, []string{".pal", ".pal"}, "PAL_HOME"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("PAL_HOME", "")
			for _, d := range tc.mkdirs {
				if err := os.Mkdir(filepath.Join(home, d), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			want := filepath.Join(home, tc.want)
			if tc.palHome {
				want = filepath.Join(t.TempDir(), "custom")
				t.Setenv("PAL_HOME", want)
			}
			got, err := ConfigDir()
			if err != nil || got != want {
				t.Fatalf("ConfigDir() = %q, %v; want %q", got, err, want)
			}
		})
	}
}

// A user logged in before the rename keeps their session: credentials in the
// legacy ~/.pal are read, and a new login writes back to the same file.
func TestCredentials_LegacyDirRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PAL_HOME", "")
	legacy := filepath.Join(home, ".pal", "credentials.json")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte(`{"token":"old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadCredentials()
	if err != nil || c == nil || c.Token != "old" {
		t.Fatalf("LoadCredentials = %+v, %v; want token old", c, err)
	}
	if err := SaveCredentials(&Credentials{Token: "new"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".pal")); !os.IsNotExist(err) {
		t.Fatalf("save created ~/.pal next to the legacy dir (err=%v)", err)
	}
	if c, _ := LoadCredentials(); c == nil || c.Token != "new" {
		t.Fatalf("round trip lost the token: %+v", c)
	}
}
