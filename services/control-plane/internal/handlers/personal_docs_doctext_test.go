package handlers

import (
	"strings"
	"testing"
)

// Pure, DB-free test for the doc-text ground-truth capture that feeds the
// bridge's id re-extraction (humanizeWithOffer rawSource). See sessions.go.
func TestDocTextFromToolResult(t *testing.T) {
	long := strings.Repeat("A1", docTextCap) // 2*docTextCap chars

	cases := []struct {
		name string
		inv  ToolInvocation
		want string
	}{
		{
			name: "read_personal_file surfaces content",
			inv:  ToolInvocation{Name: personalDocsReadTool, Result: map[string]any{"ok": true, "content": "Passport No: A1234567"}},
			want: "Passport No: A1234567",
		},
		{
			name: "non-doc tool surfaces nothing",
			inv:  ToolInvocation{Name: searchContactsTool, Result: map[string]any{"content": "should be ignored"}},
			want: "",
		},
		{
			name: "search tool (snippets) surfaces nothing",
			inv:  ToolInvocation{Name: personalDocsSearchTool, Result: map[string]any{"results": []any{}}},
			want: "",
		},
		{
			name: "started invocation (nil result) surfaces nothing",
			inv:  ToolInvocation{Name: personalDocsReadTool, Result: nil},
			want: "",
		},
		{
			name: "extraction failure (ok=false) surfaces nothing",
			inv:  ToolInvocation{Name: personalDocsReadTool, Result: map[string]any{"ok": false, "content": "leftover"}},
			want: "",
		},
		{
			name: "no content field surfaces nothing",
			inv:  ToolInvocation{Name: personalDocsReadTool, Result: map[string]any{"ok": true, "path": "/x"}},
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := docTextFromToolResult(tc.inv); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}

	t.Run("caps long content", func(t *testing.T) {
		got := docTextFromToolResult(ToolInvocation{Name: personalDocsReadTool, Result: map[string]any{"ok": true, "content": long}})
		if len(got) != docTextCap {
			t.Fatalf("got len %d want cap %d", len(got), docTextCap)
		}
	})
}
