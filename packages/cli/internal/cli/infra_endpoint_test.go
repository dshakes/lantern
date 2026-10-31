package cli

import "testing"

// The data-plane agent sends its bootstrap token to this endpoint: there is
// no default, and plain http is refused unless it is localhost.
func TestValidateControlPlaneEndpoint(t *testing.T) {
	for u, ok := range map[string]bool{
		"":                          false,
		"http://cp.example.com":     false,
		"ftp://cp.example.com":      false,
		"https://cp.example.com":    true,
		"http://localhost:8080":     true,
		"http://127.0.0.1:8080/api": true,
	} {
		if err := validateControlPlaneEndpoint(u); (err == nil) != ok {
			t.Errorf("validateControlPlaneEndpoint(%q) err=%v, want ok=%v", u, err, ok)
		}
	}
}
