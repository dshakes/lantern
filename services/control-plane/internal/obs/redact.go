// Package obs holds the pure (no I/O) logic behind post-deployment
// observability (ADR 0056): trace-tree assembly, secret redaction, anomaly
// detection and SLO burn rates. Everything here is deterministic.
package obs

import (
	"regexp"
	"strings"
)

const (
	// Redacted replaces any value judged secret.
	Redacted = "[redacted]"
	// maxStr bounds every string that leaves the trace API.
	maxStr = 2000
)

// secretKey matches map keys whose VALUE must never be shown, whatever it
// holds. "tokens_in" / "max_tokens" are not secrets, so a bare "token" only
// matches as a suffix ("token", "auth_token", "accessToken").
var secretKey = regexp.MustCompile(`(?i)(secret|passw|api[_-]?key|authorization|credential|cookie|private[_-]?key|signature|bearer|token$)`)

// secretVal matches secret-shaped substrings inside any string value.
var secretVal = []*regexp.Regexp{
	regexp.MustCompile(`sk-ant-[A-Za-z0-9_\-]{8,}`),
	regexp.MustCompile(`sk-[A-Za-z0-9_\-]{16,}`),
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._\-~+/=]{8,}`),
	regexp.MustCompile(`eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`),
	regexp.MustCompile(`AKIA[0-9A-Z]{16}`),
	regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`xox[abprs]-[A-Za-z0-9\-]{10,}`),
	regexp.MustCompile(`(?i)(?:pal|lantern)\.secret/[A-Za-z0-9_./\-]+`),
	regexp.MustCompile(`(?i)(password|passwd|secret|api[_-]?key|token)\s*[=:]\s*[^\s"',;&]{4,}`),
	regexp.MustCompile(`pal_brg_[A-Za-z0-9]{8,}`),
}

// RedactString masks secret-shaped substrings and bounds the length.
func RedactString(s string) string {
	for _, re := range secretVal {
		s = re.ReplaceAllString(s, Redacted)
	}
	if len(s) > maxStr {
		s = s[:maxStr] + "…[truncated]"
	}
	return s
}

// Redact returns a deep copy of v (as decoded from JSON) with secret values
// masked by key name and by value shape. Invariant #10: nothing the trace API
// returns may carry a secret.
func Redact(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if secretKey.MatchString(k) && val != nil {
				out[k] = Redacted
				continue
			}
			out[k] = Redact(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = Redact(val)
		}
		return out
	case string:
		return RedactString(t)
	default:
		return v
	}
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return strings.TrimSpace(s)
}
