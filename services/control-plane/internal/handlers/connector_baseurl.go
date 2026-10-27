package handlers

// Test-mode base-URL override for connector HTTP calls.
//
// LANTERN_CONNECTOR_BASEURL_<NAME>=http://127.0.0.1:PORT re-points every outbound
// request a connector would send to that vendor's host at a recorded-fixture
// server (e2e/connectorreplay), so examples and tests run without a real SaaS
// account. Only scheme+host are replaced; the vendor path is preserved, so the
// replay server serves the vendor's real paths (/api/chat.postMessage, ...).
//
// It is dev/test only: IsProd() ignores overrides at request time and
// CheckConnectorBaseURLOverrides makes the control-plane refuse to boot with one
// set (a prod tenant's bearer token must never be sent to an arbitrary host).

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
)

// connectorHosts maps a vendor API host to its override name.
var connectorHosts = map[string]string{
	"slack.com":          "SLACK",
	"api.github.com":     "GITHUB",
	"sentry.io":          "SENTRY",
	"www.googleapis.com": "GOOGLE",
	"api.pagerduty.com":  "PAGERDUTY",
}

const connectorBaseURLPrefix = "LANTERN_CONNECTOR_BASEURL_"

// parseConnectorBaseURL validates an override value: absolute http(s) URL with a host.
func parseConnectorBaseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("must be an absolute http(s) URL, got %q", raw)
	}
	return u, nil
}

// CheckConnectorBaseURLOverrides is the startup guard: fatal in prod when any
// override env var is set, and in every environment when a value is malformed.
func CheckConnectorBaseURLOverrides(isProdEnv bool, getenv func(string) string) (fatal bool, message string) {
	var set []string
	for _, name := range connectorHosts {
		key := connectorBaseURLPrefix + name
		raw := getenv(key)
		if raw == "" {
			continue
		}
		if isProdEnv {
			set = append(set, key)
			continue
		}
		if _, err := parseConnectorBaseURL(raw); err != nil {
			return true, fmt.Sprintf("%s is malformed: %v", key, err)
		}
	}
	if len(set) > 0 {
		sort.Strings(set)
		return true, fmt.Sprintf("%s set in production — connector base-URL overrides are test-only and would redirect tenant credentials to another host; unset them", strings.Join(set, ", "))
	}
	return false, ""
}

// baseURLTransport rewrites requests to known vendor hosts when an override is set.
type baseURLTransport struct{ next http.RoundTripper }

func (t baseURLTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if name, ok := connectorHosts[req.URL.Host]; ok && !IsProd() {
		if raw := os.Getenv(connectorBaseURLPrefix + name); raw != "" {
			if base, err := parseConnectorBaseURL(raw); err == nil {
				r := req.Clone(req.Context())
				r.URL.Scheme, r.URL.Host, r.Host = base.Scheme, base.Host, ""
				req = r
			}
		}
	}
	return t.next.RoundTrip(req)
}
