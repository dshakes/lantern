package placement

import (
	"strconv"
	"strings"
)

// parseVcpuMillis parses K8s-style CPU strings ("500m", "2") into millis.
// Returns 0 if the input is empty or unparseable.
func parseVcpuMillis(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if strings.HasSuffix(s, "m") {
		n, err := strconv.ParseInt(strings.TrimSuffix(s, "m"), 10, 64)
		if err != nil {
			return 0
		}
		return n
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int64(f * 1000)
}

// parseMemoryBytes parses K8s-style memory strings ("512Mi", "2Gi", "1G") into bytes.
// Returns 0 on parse error.
func parseMemoryBytes(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	var (
		mul int64 = 1
		num       = s
	)
	switch {
	case strings.HasSuffix(s, "Ki"):
		mul = 1024
		num = strings.TrimSuffix(s, "Ki")
	case strings.HasSuffix(s, "Mi"):
		mul = 1024 * 1024
		num = strings.TrimSuffix(s, "Mi")
	case strings.HasSuffix(s, "Gi"):
		mul = 1024 * 1024 * 1024
		num = strings.TrimSuffix(s, "Gi")
	case strings.HasSuffix(s, "Ti"):
		mul = 1024 * 1024 * 1024 * 1024
		num = strings.TrimSuffix(s, "Ti")
	case strings.HasSuffix(s, "K"):
		mul = 1000
		num = strings.TrimSuffix(s, "K")
	case strings.HasSuffix(s, "M"):
		mul = 1000 * 1000
		num = strings.TrimSuffix(s, "M")
	case strings.HasSuffix(s, "G"):
		mul = 1000 * 1000 * 1000
		num = strings.TrimSuffix(s, "G")
	}
	n, err := strconv.ParseInt(strings.TrimSpace(num), 10, 64)
	if err != nil {
		return 0
	}
	return n * mul
}
