package palenv

import (
	"bytes"
	"log"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestPlan(t *testing.T) {
	tests := []struct {
		name      string
		env       []string
		sets      map[string]string
		conflicts []string
	}{
		{"empty", nil, map[string]string{}, nil},
		{"legacy only is mirrored to PAL", []string{"LANTERN_ENV=prod"},
			map[string]string{"PAL_ENV": "prod"}, nil},
		{"PAL only is mirrored to LANTERN", []string{"PAL_API_URL=http://x"},
			map[string]string{"LANTERN_API_URL": "http://x"}, nil},
		{"both equal: nothing to set", []string{"PAL_ENV=dev", "LANTERN_ENV=dev"},
			map[string]string{}, nil},
		{"both differ: PAL wins", []string{"LANTERN_ENV=dev", "PAL_ENV=prod"},
			map[string]string{"LANTERN_ENV": "prod"}, []string{"ENV"}},
		{"empty PAL never blanks a non-empty LANTERN", []string{"PAL_X=", "LANTERN_X=v"},
			map[string]string{"PAL_X": "v"}, nil},
		{"empty PAL with empty LANTERN: nothing to set", []string{"PAL_X=", "LANTERN_X="},
			map[string]string{}, nil},
		{"empty PAL alone is mirrored", []string{"PAL_X="},
			map[string]string{"LANTERN_X": ""}, nil},
		{"value with '=' kept intact", []string{"LANTERN_DSN=a=b=c"},
			map[string]string{"PAL_DSN": "a=b=c"}, nil},
		{"bare prefixes and unrelated keys ignored",
			[]string{"PAL_=x", "LANTERN_=y", "PATH=/bin", "PALX=1", "XLANTERN_Y=2"},
			map[string]string{}, nil},
		{"lowercase prefix is not ours", []string{"lantern_env=x", "pal_env=y"},
			map[string]string{}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sets, conflicts := plan(tt.env)
			if !reflect.DeepEqual(sets, tt.sets) {
				t.Errorf("sets = %v, want %v", sets, tt.sets)
			}
			if !reflect.DeepEqual(conflicts, tt.conflicts) {
				t.Errorf("conflicts = %v, want %v", conflicts, tt.conflicts)
			}
		})
	}
}

func TestBridgeAppliesAndLogsNamesOnly(t *testing.T) {
	t.Setenv("LANTERN_PALENV_TEST_A", "a")
	t.Setenv("PAL_PALENV_TEST_B", "b")
	t.Setenv("LANTERN_PALENV_TEST_C", "old-secret-value")
	t.Setenv("PAL_PALENV_TEST_C", "new-secret-value")
	// t.Setenv restores what it set; register the mirrored keys too.
	t.Setenv("PAL_PALENV_TEST_A", "")
	os.Unsetenv("PAL_PALENV_TEST_A")
	t.Setenv("LANTERN_PALENV_TEST_B", "")
	os.Unsetenv("LANTERN_PALENV_TEST_B")

	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	Bridge()
	Bridge() // idempotent

	for k, want := range map[string]string{
		"PAL_PALENV_TEST_A":     "a",
		"LANTERN_PALENV_TEST_B": "b",
		"LANTERN_PALENV_TEST_C": "new-secret-value",
		"PAL_PALENV_TEST_C":     "new-secret-value",
	} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	out := buf.String()
	if !strings.Contains(out, "PAL_PALENV_TEST_C") {
		t.Errorf("conflict not logged: %q", out)
	}
	if strings.Contains(out, "secret-value") {
		t.Errorf("log leaked a value: %q", out)
	}
}

func TestGet(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"unset", nil, ""},
		{"legacy fallback", map[string]string{"LANTERN_PALENV_GET": "l"}, "l"},
		{"PAL preferred", map[string]string{"LANTERN_PALENV_GET": "l", "PAL_PALENV_GET": "p"}, "p"},
		{"empty PAL falls back", map[string]string{"LANTERN_PALENV_GET": "l", "PAL_PALENV_GET": ""}, "l"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, k := range []string{"PAL_PALENV_GET", "LANTERN_PALENV_GET"} {
				t.Setenv(k, "")
				os.Unsetenv(k)
			}
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			if got := Get("PALENV_GET"); got != tt.want {
				t.Errorf("Get = %q, want %q", got, tt.want)
			}
		})
	}
}
