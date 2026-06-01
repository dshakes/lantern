package handlers

import "math"

// Approximate all-in per-minute voice cost (PSTN/SIP transport + the realtime
// STT→LLM→TTS media pipeline), used to reconcile the flat connect-time
// reservation to a duration-based actual when a call ends. Telephony alone is
// ~$0.0085/min inbound on Twilio; the remainder is the media loop. These are
// deliberately conservative defaults a deployment can tune.
const (
	twilioVoiceUsdPerMin  = 0.03
	livekitVoiceUsdPerMin = 0.04
)

// voiceCallCostUsd computes the billed cost of a completed call from its
// duration. Telephony is billed per STARTED minute (ceil), matching how PSTN
// carriers bill. A zero-duration call (unanswered, declined, failed) costs
// nothing, which lets the reconciler refund the connect-time reservation.
func voiceCallCostUsd(provider string, durationSec int) float64 {
	if durationSec <= 0 {
		return 0
	}
	perMin := twilioVoiceUsdPerMin
	if provider == "livekit" {
		perMin = livekitVoiceUsdPerMin
	}
	minutes := math.Ceil(float64(durationSec) / 60.0)
	return roundMoney(minutes * perMin)
}
