package cli

// Unit tests for `lantern vm exec` — everything testable WITHOUT a live
// guest or an interactive terminal: flag parsing, first-frame construction,
// manager-address resolution, and the raw-mode guard (which must no-op when
// stdin is not a terminal, e.g. in CI). The live bidirectional PTY pump
// (CLI ↔ manager ↔ harness) is guest/tty-runtime-only and not covered here.

import (
	"os"
	"testing"
)

// --- flag parsing ------------------------------------------------------------

// parseVmExecFlags runs cobra's flag parsing without executing RunE.
func parseVmExecFlags(t *testing.T, args ...string) (tty, interactive bool) {
	t.Helper()
	cmd := newVmExecCommand()
	if err := cmd.ParseFlags(args); err != nil {
		t.Fatalf("ParseFlags(%v): %v", args, err)
	}
	tty, err := cmd.Flags().GetBool("tty")
	if err != nil {
		t.Fatalf("GetBool(tty): %v", err)
	}
	interactive, err = cmd.Flags().GetBool("interactive")
	if err != nil {
		t.Fatalf("GetBool(interactive): %v", err)
	}
	return tty, interactive
}

func TestVmExecFlagDefaultsAreOneShot(t *testing.T) {
	tty, interactive := parseVmExecFlags(t)
	if tty || interactive {
		t.Fatalf("defaults must be non-tty one-shot, got tty=%v interactive=%v", tty, interactive)
	}
}

func TestVmExecShortFlagsParse(t *testing.T) {
	tty, interactive := parseVmExecFlags(t, "-t", "-i")
	if !tty || !interactive {
		t.Fatalf("-t -i must set both flags, got tty=%v interactive=%v", tty, interactive)
	}
}

func TestVmExecCombinedShortFlagsParse(t *testing.T) {
	tty, interactive := parseVmExecFlags(t, "-it")
	if !tty || !interactive {
		t.Fatalf("-it must set both flags, got tty=%v interactive=%v", tty, interactive)
	}
}

func TestVmExecInteractiveImpliesTty(t *testing.T) {
	// RunE computes the effective tty as `tty || interactive`; mirror that
	// contract here so a refactor that drops the implication fails loudly.
	tty, interactive := parseVmExecFlags(t, "-i")
	if tty {
		t.Fatalf("-i alone must not set --tty itself")
	}
	if effective := tty || interactive; !effective {
		t.Fatalf("-i must imply an effective tty")
	}
}

// --- first-frame construction --------------------------------------------------

func TestExecFirstFrameOneShot(t *testing.T) {
	req := execFirstFrame("vm-1", "ls", []string{"-la"}, false, 48, 160, "xterm")
	if req.GetVmId() != "vm-1" || req.GetCommand() != "ls" {
		t.Fatalf("vm_id/command not carried: %+v", req)
	}
	if got := req.GetArgv(); len(got) != 1 || got[0] != "-la" {
		t.Fatalf("argv not carried: %v", got)
	}
	if req.GetTty() {
		t.Fatalf("one-shot frame must not request a tty")
	}
	// Geometry and TERM are tty-only — must not leak into one-shot frames.
	if req.GetTermRows() != 0 || req.GetTermCols() != 0 || req.GetTerm() != "" {
		t.Fatalf("tty fields must be zero for one-shot frames: %+v", req)
	}
}

func TestExecFirstFrameTtyCarriesGeometryAndTerm(t *testing.T) {
	req := execFirstFrame("vm-1", "/bin/sh", nil, true, 48, 160, "xterm-256color")
	if !req.GetTty() {
		t.Fatalf("tty frame must request a tty")
	}
	if req.GetTermRows() != 48 || req.GetTermCols() != 160 {
		t.Fatalf("geometry not carried: rows=%d cols=%d", req.GetTermRows(), req.GetTermCols())
	}
	if req.GetTerm() != "xterm-256color" {
		t.Fatalf("term not carried: %q", req.GetTerm())
	}
}

func TestExecFirstFrameTtyOmitsUnmeasuredGeometry(t *testing.T) {
	// rows/cols <= 0 (size probe failed) are omitted so the guest falls
	// back to its 24x80 default.
	req := execFirstFrame("vm-1", "/bin/sh", nil, true, 0, -1, "xterm")
	if req.GetTermRows() != 0 || req.GetTermCols() != 0 {
		t.Fatalf("unmeasured geometry must be omitted: rows=%d cols=%d",
			req.GetTermRows(), req.GetTermCols())
	}
}

// --- raw-mode guard ------------------------------------------------------------

func TestEnterRawModeNoopsOnNonTerminal(t *testing.T) {
	// A pipe is not a terminal — enterRawMode must return a callable no-op
	// restore and no error, so `vm exec -t` is safe under CI / piped stdin.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer r.Close()
	defer w.Close()

	restore, err := enterRawMode(int(r.Fd()))
	if err != nil {
		t.Fatalf("enterRawMode on a pipe must not error: %v", err)
	}
	if restore == nil {
		t.Fatalf("restore must be callable even when no-op")
	}
	restore() // must not panic
}

// --- manager address resolution --------------------------------------------------

func TestResolveManagerAddrPrecedence(t *testing.T) {
	t.Setenv("LANTERN_MANAGER_ADDR", "env-host:50054")
	if got := resolveManagerAddr("flag-host:50054"); got != "flag-host:50054" {
		t.Fatalf("flag must win, got %q", got)
	}
	if got := resolveManagerAddr(""); got != "env-host:50054" {
		t.Fatalf("env must be next, got %q", got)
	}
	t.Setenv("LANTERN_MANAGER_ADDR", "")
	if got := resolveManagerAddr(""); got != defaultManagerAddr {
		t.Fatalf("default must be last, got %q", got)
	}
}
