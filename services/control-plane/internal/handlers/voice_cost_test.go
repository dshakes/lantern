package handlers

import "testing"

func TestVoiceCallCostUsd(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		dur      int
		want     float64
	}{
		{"zero duration is free", "twilio", 0, 0},
		{"negative duration is free", "twilio", -5, 0},
		{"1s bills one started minute (twilio)", "twilio", 1, 0.03},
		{"exactly 60s is one minute", "twilio", 60, 0.03},
		{"61s rounds up to two minutes", "twilio", 61, 0.06},
		{"livekit uses its own rate", "livekit", 1, 0.04},
		{"unknown provider falls back to twilio rate", "vonage", 60, 0.03},
		{"three full minutes", "twilio", 180, 0.09},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := voiceCallCostUsd(c.provider, c.dur)
			if got != c.want {
				t.Fatalf("voiceCallCostUsd(%q, %d) = %v, want %v", c.provider, c.dur, got, c.want)
			}
		})
	}
}

// A completed call must cost at least the flat connect-time reservation once it
// runs a minute, so reconciliation tops the budget up rather than always
// refunding — guards against the rates drifting below the estimate by accident.
func TestVoiceCostCoversReservationForRealCalls(t *testing.T) {
	if voiceCallCostUsd("twilio", 120) < estimatedInboundVoiceUsd {
		t.Fatalf("a 2-minute call (%.3f) should cost at least the reservation (%.3f)",
			voiceCallCostUsd("twilio", 120), estimatedInboundVoiceUsd)
	}
}
