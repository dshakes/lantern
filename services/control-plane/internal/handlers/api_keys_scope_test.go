package handlers

import "testing"

func TestValidateGrantableScopes(t *testing.T) {
	svc := func(scopes ...string) *LanternClaims { return &LanternClaims{Role: "service", Scopes: scopes} }
	cases := []struct {
		name      string
		caller    *LanternClaims
		requested []string
		wantErr   bool
	}{
		{"owner jwt grants admin", &LanternClaims{Role: "owner"}, []string{"admin"}, false},
		{"admin jwt grants empty", &LanternClaims{Role: "admin"}, nil, false},
		{"member jwt denied", &LanternClaims{Role: "member"}, []string{"read"}, true},
		{"unknown scope", &LanternClaims{Role: "owner"}, []string{"root"}, true},
		{"subset allowed", svc("write"), []string{"agents:write", "read"}, false},
		{"escalate read->write", svc("read"), []string{"write"}, true},
		{"escalate to admin", svc("write"), []string{"admin"}, true},
		{"scoped caller empty request", svc("read"), nil, true},
		{"legacy unrestricted key", svc(), []string{"admin"}, false},
		{"admin key grants anything", svc("admin"), []string{"runs:execute"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateGrantableScopes(tc.caller, tc.requested)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}
