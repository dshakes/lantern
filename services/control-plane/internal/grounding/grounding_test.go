package grounding

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Enabled
// ---------------------------------------------------------------------------

func TestEnabled_DefaultOn(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "")
	if !Enabled() {
		t.Error("Enabled() must be true when LANTERN_CLAIM_VERIFY is unset (default on)")
	}
}

func TestEnabled_ExplicitOff(t *testing.T) {
	for _, v := range []string{"0", "off", "false", "OFF", "False"} {
		t.Setenv("LANTERN_CLAIM_VERIFY", v)
		if Enabled() {
			t.Errorf("Enabled() must be false when env=%q", v)
		}
	}
}

func TestEnabled_ExplicitOn(t *testing.T) {
	for _, v := range []string{"1", "on", "true"} {
		t.Setenv("LANTERN_CLAIM_VERIFY", v)
		if !Enabled() {
			t.Errorf("Enabled() must be true when env=%q", v)
		}
	}
}

// ---------------------------------------------------------------------------
// RewriteActions
// ---------------------------------------------------------------------------

func TestRewriteActions_DisabledPassThrough(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "0")
	text := "I sent the email."
	out, rewrites := RewriteActions(text, nil)
	if out != text || len(rewrites) != 0 {
		t.Errorf("disabled: want (%q, 0 rewrites), got (%q, %v)", text, out, rewrites)
	}
}

func TestRewriteActions_UnbackedEmailSoftened(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	out, rewrites := RewriteActions("I emailed her about the meeting.", nil)
	if strings.Contains(out, "I emailed") {
		t.Errorf("unbacked 'I emailed' should be softened, got %q", out)
	}
	if !strings.Contains(out, "I'll email") {
		t.Errorf("unbacked claim should become \"I'll email\", got %q", out)
	}
	if len(rewrites) == 0 {
		t.Error("expected at least one rewrite entry")
	}
}

func TestRewriteActions_BackedSendKept(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	performed := map[string]bool{"send_message": true}
	text := "I sent the message to your contact."
	out, rewrites := RewriteActions(text, performed)
	if out != text {
		t.Errorf("backed 'I sent' must not be rewritten, got %q", out)
	}
	if len(rewrites) != 0 {
		t.Errorf("backed claim must produce no rewrites, got %v", rewrites)
	}
}

func TestRewriteActions_BackedBookingKept(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	performed := map[string]bool{"create_event": true}
	text := "I booked the meeting for 3pm."
	out, rewrites := RewriteActions(text, performed)
	if out != text {
		t.Errorf("backed 'I booked' must not be rewritten, got %q", out)
	}
	if len(rewrites) != 0 {
		t.Errorf("backed booking must produce no rewrites, got %v", rewrites)
	}
}

func TestRewriteActions_FailedToolDoesNotBack(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	// nil performed = send_email ran but failed; not in the map.
	out, _ := RewriteActions("I emailed the file over.", nil)
	if strings.Contains(out, "I emailed") {
		t.Errorf("absent (failed) tool must not back the claim, got %q", out)
	}
}

func TestRewriteActions_NoClaims_Unchanged(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	text := "Here is a summary of your inbox: 3 unread emails."
	out, rewrites := RewriteActions(text, nil)
	if out != text || len(rewrites) != 0 {
		t.Errorf("text without action claims must be unchanged, got %q (%v)", out, rewrites)
	}
}

func TestRewriteActions_MultipleVerbsPartialBacking(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "1")
	// send_message backs "I sent"; no calendar tool → "I booked" softened.
	performed := map[string]bool{"send_message": true}
	text := "I sent the invite and I booked the room."
	out, rewrites := RewriteActions(text, performed)
	if strings.Contains(out, "I booked") {
		t.Errorf("unbacked 'I booked' should be softened, got %q", out)
	}
	if !strings.Contains(out, "I sent") {
		t.Errorf("backed 'I sent' should be kept, got %q", out)
	}
	if len(rewrites) != 1 {
		t.Errorf("want exactly 1 rewrite, got %d: %v", len(rewrites), rewrites)
	}
}

// ---------------------------------------------------------------------------
// HasUnbackedClaims
// ---------------------------------------------------------------------------

func TestHasUnbackedClaims_RunsWhenDisabled(t *testing.T) {
	// HasUnbackedClaims is always active regardless of the env gate.
	t.Setenv("LANTERN_CLAIM_VERIFY", "0")
	if !HasUnbackedClaims("I booked the table.", nil) {
		t.Error("HasUnbackedClaims must detect unbacked 'I booked' even when Enabled()=false")
	}
}

func TestHasUnbackedClaims_BackedReturnsFalse(t *testing.T) {
	t.Setenv("LANTERN_CLAIM_VERIFY", "0")
	performed := map[string]bool{"create_event": true}
	if HasUnbackedClaims("I booked the meeting.", performed) {
		t.Error("HasUnbackedClaims must return false when claim is backed")
	}
}

func TestHasUnbackedClaims_NoClaims(t *testing.T) {
	if HasUnbackedClaims("Here is your schedule for today.", nil) {
		t.Error("HasUnbackedClaims must return false when no claims present")
	}
}

func TestHasUnbackedClaims_UnbackedReturnsTrue(t *testing.T) {
	if !HasUnbackedClaims("I scheduled the call for you.", nil) {
		t.Error("HasUnbackedClaims must return true for unbacked 'I scheduled'")
	}
}
