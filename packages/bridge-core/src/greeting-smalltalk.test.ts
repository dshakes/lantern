// Regression tests for the greeting/small-talk fast-path predicate.
//
// SMALL_TALK strings must route to lightweight natural chat (no agentic
// tool pipeline) — they're pure openers. ACTIONABLE strings must FAIL the
// predicate so they still reach the pipeline (file/Gmail/Calendar tools).
// The bug this guards: "Hi. Hi." and "Hi, how are you?" were spending
// ~1.2s spinning up tools because the period separator / "how are you"
// tail weren't recognised as small-talk.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isGreetingSmallTalk, isCelebratoryWish } from "./personal-docs.ts";

const SMALL_TALK = [
  "Hi. Hi.",
  "Hi, how are you?",
  "hi",
  "hey",
  "hello how are you",
  "hello how are you doing",
  "hey how's it going",
  "good morning",
  "good morning!",
  "good night",
  "what's up",
  "whats up",
  "sup",
  "namaste",
  "hey hey",
  "hi how r u",
  "hope you're doing well",
];

const ACTIONABLE = [
  "hi when does my passport expire",
  "hey can you check my email",
  "good morning, set a reminder for 9am",
  "how do I renew my license",
  "what's up with my flight booking",
  "hello, draft a reply to maya",
  "morning — what's on my calendar today",
];

for (const t of SMALL_TALK) {
  test(`small-talk fast-path: ${JSON.stringify(t)}`, () => {
    assert.equal(isGreetingSmallTalk(t), true, `expected small-talk: ${t}`);
  });
}

for (const t of ACTIONABLE) {
  test(`actionable stays on pipeline: ${JSON.stringify(t)}`, () => {
    assert.equal(isGreetingSmallTalk(t), false, `expected NOT small-talk: ${t}`);
  });
}

// ---------------------------------------------------------------------------
// isCelebratoryWish — group-gate exception (BUG 1).
//
// A celebratory wish (birthday / anniversary / congrats / festival), English
// or Telugu (native + Romanized) or wish-emoji, must be detected so a wish
// that names the owner gets a reply IN an unmonitored group. General chatter
// must NOT match (the predicate stays narrow so it doesn't widen the group
// reply surface).
// ---------------------------------------------------------------------------

const WISHES = [
  "Happy Wedding Anniversary Shekhar & Maya",
  "Happy Wedding Anniversary Shekhar & Maya 🎉",
  "Happy Birthday!!",
  "happy bday bro",
  "Happy anniversary to you both 💐",
  "Belated happy birthday Shekhar",
  "Congratulations on the new house!",
  "congrats man 🎉",
  "Many more happy returns of the day",
  "Best wishes for the new journey",
  "Happy New Year everyone",
  "Happy Diwali 🪔",
  "Happy Sankranti to the family",
  // Telugu Romanized
  "Pelliroju shubhakankshalu Shekhar anna",
  "Puttinaroju subhakankshalu 🎂",
  "janmadina subhakankshalu",
  "Sankranti subhakankshalu andariki",
  // Telugu native script
  "శుభాకాంక్షలు Shekhar",
  "పుట్టినరోజు శుభాకాంక్షలు",
  "పెళ్లిరోజు శుభాకాంక్షలు మనసా & శేఖర్",
  // Emoji-only wish
  "🎉🎂",
  "💐🥳",
];

const NOT_WISHES = [
  "hey what time is the meeting",
  "can you send me the doc",
  "are we still on for lunch",
  "did you see the news today",
  "the project deadline is tomorrow",
  "lol that was hilarious",
  "ok sounds good",
  "where are you guys",
  "I'll call you in 5",
  "good morning all", // a greeting, not a celebratory wish
];

for (const t of WISHES) {
  test(`celebratory wish: ${JSON.stringify(t)}`, () => {
    assert.equal(isCelebratoryWish(t), true, `expected wish: ${t}`);
  });
}

for (const t of NOT_WISHES) {
  test(`not a celebratory wish: ${JSON.stringify(t)}`, () => {
    assert.equal(isCelebratoryWish(t), false, `expected NOT a wish: ${t}`);
  });
}
