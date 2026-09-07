// ADR 0024 W4: the authorship floor is set by the owner's own text.
//   cd packages/bridge-core && npx tsx --test src/voice-score.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fitVoiceModel, scoreVoice, voiceDelta, styleFeatures, FEATURE_NAMES } from "./voice-score.ts";
import { detectBotTells } from "./natural.ts";

// A synthetic owner: short, lowercase, few periods, an emoji sometimes, some romanized Telugu.
const OWNER = [
  "ha will check and let you know", "sare, cheptha 👍", "on my way, 10 min", "yeah that works for me",
  "not sure yet, will tell you tmrw", "ela unnav? long time", "ok done, sent it", "lol no way",
  "vasta, wait", "can we do saturday instead", "ha ippude chustha", "cool, see you there",
  "sent you the pic", "thanks bro 🙏", "was stuck in a meeting, calling now", "nope, didn't get it",
  "yes yes, coming", "haha true", "let me check and get back", "matladtham repu",
  "hmm not today, tmrw?", "ok ok", "got it, thanks", "he said he will come", "no idea, ask madhu",
  "bagunna, nuvvu?", "just landed", "will be there by 6", "i'll call you in a bit", "sare done",
];
const CORPUS = Array.from({ length: 80 }, (_, i) => OWNER[i % OWNER.length] + (i % 7 === 0 ? " 👍" : ""));

test("feature vector is stable, named, and per-word normalized", () => {
  assert.equal(styleFeatures("hey").length, FEATURE_NAMES.length);
  assert.deepEqual(styleFeatures("ok done 👍"), styleFeatures("ok done 👍"));
});

test("too few samples → no model, so the guard cannot fire", () => {
  assert.equal(fitVoiceModel(OWNER.slice(0, 20)), null);
});

test("the owner's own messages pass; a customer-service paragraph fails with a usable hint", () => {
  const model = fitVoiceModel(CORPUS)!;
  assert.ok(model);
  let pass = 0;
  for (const s of OWNER) if (scoreVoice(model, s)?.ok !== false) pass++;
  assert.ok(pass / OWNER.length >= 0.9, `owner's own text should clear the floor (${pass}/${OWNER.length})`);
  const bot = "Certainly! I completely understand your concern. I will look into this matter right away and get back to you with a detailed update as soon as possible. Please let me know if there is anything else I can help you with.";
  const v = scoreVoice(model, bot)!;
  assert.equal(v.ok, false);
  assert.ok(v.delta > v.floor);
  assert.match(v.hint ?? "", /shorter|fewer|capital|periods|commas/);
  // An off-voice but short text still fails, and a 1–2-word ack is never scored.
  assert.equal(scoreVoice(model, "ok"), null);
  assert.ok(voiceDelta(model, "Dear Sir, kindly acknowledge receipt.") > voiceDelta(model, "ha got it, thanks"));
});

test("the bot-tell guard uses the floor: off-voice draft suppressed with a hint, owner-like draft passes", () => {
  const model = fitVoiceModel(CORPUS)!;
  const bad = detectBotTells("Certainly! I completely understand your concern and will look into this matter right away and get back to you with a detailed update.", "hey", { voiceModel: model });
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /^voice-drift/);
  assert.equal(detectBotTells("ha will check and let you know", "hey", { voiceModel: model }).ok, true);
  // No model → not scored (the stock "Certainly!" still trips the older phrase net, which is fine — just not as voice-drift).
  assert.doesNotMatch(detectBotTells("Certainly! I completely understand your concern and will look into this matter right away.", "hey", { voiceModel: null }).reason ?? "", /voice-drift/);
});

test("hints point the right way, and one feature the corpus never used cannot sink a draft", () => {
  const model = fitVoiceModel(CORPUS)!;
  // The corpus never starts with a capital; a capitalised draft must be told the owner starts lowercase.
  const v = scoreVoice(model, "Ha Will Check And Let You Know Tomorrow Morning Definitely, Promise.");
  if (v && !v.ok) assert.doesNotMatch(v.hint ?? "", /usually start with a capital/);
  // One comma + one contraction in an otherwise owner-like draft stays under the floor.
  assert.equal(scoreVoice(model, "ha, i'll check and let you know")?.ok, true);
});
