package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `jsonb::text::bytea` parses the JSON text as bytea ESCAPE input, so any
// backslash (a JSON \" or \n -- i.e. every workflow prompt with a newline, every
// message with a quote) is "invalid input syntax for type bytea". Callers
// swallowed the error, so workflows silently fell back to the plain-LLM path and
// recovery could not re-drive such runs. Scan jsonb as ::text instead.
func TestNoJSONBTextBytea(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "::text::bytea") {
			t.Errorf("%s: use ::text, not ::text::bytea, to read jsonb into []byte (backslashes break the bytea cast)", f)
		}
	}
}
