package handlers

import "testing"

func TestShouldSendOutbound_AllowsRealReply(t *testing.T) {
	good := []string{
		"sounds good, see you at 7!",
		"he's out till friday — want me to pass along a message?",
		"yeah that works for me",
		"Sure, I'll let him know.",
		// Must NOT be caught by the narrowed contact/sender/recipient pattern.
		"I'll send you the contact info in a sec.",
		"the recipient address is on file, all good",
	}
	for _, draft := range good {
		if ok, reason := shouldSendOutbound(draft); !ok {
			t.Errorf("shouldSendOutbound(%q) = (false, %q), want true", draft, reason)
		}
	}
}

func TestShouldSendOutbound_SuppressesEmpty(t *testing.T) {
	for _, draft := range []string{"", "   ", "\n\t "} {
		if ok, _ := shouldSendOutbound(draft); ok {
			t.Errorf("shouldSendOutbound(%q) = true, want false (empty)", draft)
		}
	}
}

func TestShouldSendOutbound_SuppressesBareNoReplyTokens(t *testing.T) {
	for _, draft := range []string{
		"empty", "none", "N/A", "no reply needed", "nothing to add",
		"skip", "(none)", "\"empty string\"", "pass", "*ignore*",
	} {
		if ok, reason := shouldSendOutbound(draft); ok {
			t.Errorf("shouldSendOutbound(%q) = true, want false; reason=%q", draft, reason)
		}
	}
}

func TestShouldSendOutbound_SuppressesReasoningLeak(t *testing.T) {
	// These are the exact shapes of the production leak bug: the model's
	// internal deliberation reaching a contact.
	for _, draft := range []string{
		"The contact is just saying hi, so no reply is needed.",
		"No response is required here.",
		"A real person wouldn't respond to this.",
		"I've already answered this earlier.",
		"Nothing else to add.",
		"As an AI, I can't make that decision.",
		"I am an assistant and cannot do that.",
	} {
		if ok, reason := shouldSendOutbound(draft); ok {
			t.Errorf("shouldSendOutbound(%q) = true, want false (leak); reason=%q", draft, reason)
		}
	}
}
