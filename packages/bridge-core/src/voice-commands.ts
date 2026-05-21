// Voice-note commands.
//
// When a voice note is transcribed (by media.ts → Whisper), check if
// the transcript begins with "lantern" / "hey lantern". If so, strip
// the wake word and run the rest through parseNLCommand — same parser
// that handles typed text.
//
// The "lantern" wake word is REQUIRED for voice — otherwise we'd be
// constantly trying to parse natural conversation as commands. Users
// don't typically start sentences with "pause" / "mute" verbatim
// unless they mean to.
//
// Examples:
//   "lantern, pause for two hours"     → mute 2h
//   "hey lantern, what's my status"    → status
//   "lantern, help"                    → help
//   "lantern, mute everyone for tonight" → mute until 7am tomorrow

import { parseNLCommand, type ParsedCommand } from "./nl-commands.js";

// Whisper transcripts have variable punctuation/capitalization. We
// normalize before matching.
const WAKE_PATTERN = /^\s*(?:hey\s+)?lantern[,!:\s]+/i;

export function isVoiceCommand(transcript: string): boolean {
  if (!transcript) return false;
  return WAKE_PATTERN.test(transcript);
}

export function parseVoiceCommand(transcript: string): ParsedCommand | null {
  if (!transcript) return null;
  const m = transcript.match(WAKE_PATTERN);
  if (!m) return null;
  // Drop the wake word + any trailing punctuation Whisper added.
  const rest = transcript.slice(m[0].length).trim().replace(/[.!?]+$/, "");
  if (!rest) return null;
  // Voice commands always use the "explicit" path (we already
  // verified the wake word). Force the explicit prefix so the parser
  // doesn't require a known command verb at the start.
  return parseNLCommand(`lantern, ${rest}`);
}
