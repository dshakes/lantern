package tunnel

import (
	"os"
	"runtime"
)

// hostname returns the machine's hostname, falling back to "unknown".
func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

// goOS returns GOOS (e.g. "linux", "darwin").
func goOS() string { return runtime.GOOS }

// goArch returns GOARCH (e.g. "amd64", "arm64").
func goArch() string { return runtime.GOARCH }
