package main

import "testing"

func TestInsecureFlagsDecision(t *testing.T) {
	cases := []struct {
		name       string
		prod       bool
		twilio     string
		claudeCode string
		wantFatal  bool
	}{
		{"prod clean", true, "", "", false},
		{"prod twilio off", true, "off", "", true},
		{"prod twilio OFF", true, "OFF", "", true},
		{"prod claude code", true, "", "1", true},
		{"prod claude code 0", true, "", "0", false},
		{"dev twilio off ok", false, "off", "1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fatal, msg := insecureFlagsDecision(tc.prod, tc.twilio, tc.claudeCode)
			if fatal != tc.wantFatal || (fatal && msg == "") {
				t.Fatalf("fatal=%v msg=%q want fatal=%v", fatal, msg, tc.wantFatal)
			}
		})
	}
}
