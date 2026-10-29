// Package palenv is the Go side of the Lantern→PAL env compat contract
// (ADR 0032): every PAL_X / LANTERN_X variable is visible under both names,
// and PAL_X wins when both are set and differ.
//
// Binaries call Bridge() as the first statement of main(), so existing
// os.Getenv("LANTERN_X") reads keep working when an operator sets PAL_X, and
// new PAL_X reads keep working against an unchanged LANTERN_X env file.
// Libraries, which do not own the process env, read through Get instead.
package palenv

import (
	"log"
	"os"
	"sort"
	"strings"
)

const (
	palPrefix    = "PAL_"
	legacyPrefix = "LANTERN_"
)

// Bridge mirrors every PAL_X <-> LANTERN_X pair into the process env. Only
// key names are ever logged, never values. Idempotent.
func Bridge() {
	sets, conflicts := plan(os.Environ())
	for k, v := range sets {
		_ = os.Setenv(k, v) // only fails on an invalid key, and these came from the env
	}
	for _, suffix := range conflicts {
		log.Printf("palenv: %s%s and %s%s differ; using %s%s", palPrefix, suffix, legacyPrefix, suffix, palPrefix, suffix)
	}
}

// Get reads PAL_<suffix>, falling back to LANTERN_<suffix>. A PAL_ value that
// is set (even empty) wins, matching Bridge.
func Get(suffix string) string {
	if v, ok := os.LookupEnv(palPrefix + suffix); ok {
		return v
	}
	return os.Getenv(legacyPrefix + suffix)
}

// plan computes the variables Bridge must set for env (os.Environ format),
// and the suffixes whose PAL_ and LANTERN_ values conflicted.
func plan(env []string) (sets map[string]string, conflicts []string) {
	pal := map[string]string{}
	legacy := map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if s, found := strings.CutPrefix(k, palPrefix); found && s != "" {
			pal[s] = v
		} else if s, found := strings.CutPrefix(k, legacyPrefix); found && s != "" {
			legacy[s] = v
		}
	}
	sets = map[string]string{}
	for s, v := range pal {
		lv, ok := legacy[s]
		if !ok || lv != v {
			sets[legacyPrefix+s] = v
		}
		if ok && lv != v {
			conflicts = append(conflicts, s)
		}
	}
	for s, v := range legacy {
		if _, ok := pal[s]; !ok {
			sets[palPrefix+s] = v
		}
	}
	sort.Strings(conflicts)
	return sets, conflicts
}
