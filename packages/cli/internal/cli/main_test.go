package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestInvokedAs(t *testing.T) {
	for argv0, want := range map[string]string{
		"pal":                       "pal",
		"/usr/local/bin/lantern":    legacyBinaryName,
		"/opt/homebrew/bin/lantern": legacyBinaryName,
		"./pal.exe":                 "pal",
	} {
		if got := invokedAs(argv0); got != want {
			t.Errorf("invokedAs(%q) = %q, want %q", argv0, got, want)
		}
	}
}

// The hot-reload inner loop must be discoverable from top-level help, not
// only from `pal agents --help`.
func TestRootHelp_SurfacesAgentDev(t *testing.T) {
	root := NewRootCommand("test", "none", "now")
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	help := out.String()
	for _, want := range []string{"pal agent dev <name>", "agent dev <name>` is the hot-reload inner loop"} {
		if !strings.Contains(help, want) {
			t.Errorf("root help missing %q:\n%s", want, help)
		}
	}
	if !strings.HasPrefix(strings.SplitN(help, "Usage:\n", 2)[1], "  pal ") {
		t.Errorf("usage line should name the pal binary:\n%s", help)
	}
}
