package handlers

// Test-mode base-URL override for LLM provider calls (the "fixture LLM tier").
//
// PAL_LLM_BASEURL_OPENAI / PAL_LLM_BASEURL_ANTHROPIC re-point every
// outbound request to api.openai.com / api.anthropic.com (completions, streaming,
// tool loop, web_search, embeddings, ...) at a fixture server such as
// cmd/llm-replay, so CI and kiosk mode get deterministic replies with no real
// provider key. Only scheme+host are replaced; the provider path is preserved.
//
// Every provider call site uses http.DefaultClient or a zero-Transport
// http.Client, so wrapping http.DefaultTransport once (init below) routes all of
// them — present and future — through this single helper.
//
// Dev/test only: IsProd() ignores overrides at request time and
// CheckLLMBaseURLOverrides makes the control-plane refuse to boot with one set
// (a prod tenant's provider key must never be sent to an arbitrary host).

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
)

// llmHosts maps a provider API host to its override env var.
var llmHosts = map[string]string{
	"api.openai.com":    "PAL_LLM_BASEURL_OPENAI",
	"api.anthropic.com": "PAL_LLM_BASEURL_ANTHROPIC",
}

// CheckLLMBaseURLOverrides is the startup guard: fatal in prod when any override
// is set, and in every environment when a value is malformed.
func CheckLLMBaseURLOverrides(isProdEnv bool, getenv func(string) string) (fatal bool, message string) {
	var set []string
	for _, key := range llmHosts {
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
		return true, fmt.Sprintf("%s set in production — LLM base-URL overrides are test-only and would redirect tenant provider keys to another host; unset them", strings.Join(set, ", "))
	}
	return false, ""
}

// llmBaseURLTransport rewrites requests to provider hosts when an override is set.
type llmBaseURLTransport struct{ next http.RoundTripper }

func (t llmBaseURLTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if key, ok := llmHosts[req.URL.Host]; ok && !IsProd() {
		if raw := os.Getenv(key); raw != "" {
			if base, err := parseConnectorBaseURL(raw); err == nil {
				r := req.Clone(req.Context())
				r.URL.Scheme, r.URL.Host, r.Host = base.Scheme, base.Host, ""
				req = r
			}
		}
	}
	return t.next.RoundTrip(req)
}

func init() { http.DefaultTransport = llmBaseURLTransport{next: http.DefaultTransport} }
