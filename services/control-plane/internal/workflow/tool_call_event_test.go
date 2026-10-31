package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The journal must record a tool node's arguments (so the trace tree can show
// them) but never a secret: invariant #10.
func TestToolCallEventRecordsRedactedArgs(t *testing.T) {
	secret := "sk" + "-ant-api03-" + "QQQQQQQQQQQQQQQQ"
	def := Definition{
		Nodes: []Node{
			{ID: "t", Type: "trigger", Data: map[string]any{}},
			{ID: "x", Type: "tool", Data: map[string]any{"tool": "http", "parameters": map[string]any{"url": "https://a.test", "api_key": secret, "note": "use " + secret}}},
			{ID: "z", Type: "end", Data: map[string]any{}},
		},
		Edges: []Edge{{ID: "1", Source: "t", Target: "x"}, {ID: "2", Source: "x", Target: "z"}},
	}
	stub := newStubDeps(nil)
	if _, err := Run(context.Background(), "run_1", stub.deps(), def, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	var got *JournalEvent
	for i := range stub.events {
		if stub.events[i].Kind == "tool_call" {
			got = &stub.events[i]
		}
	}
	if got == nil {
		t.Fatalf("no tool_call event; kinds=%v", eventKinds(stub))
	}
	raw, _ := json.Marshal(got.Payload)
	if strings.Contains(string(raw), secret) || !strings.Contains(string(raw), "a.test") {
		t.Fatalf("args not redacted-but-present: %s", raw)
	}
}
