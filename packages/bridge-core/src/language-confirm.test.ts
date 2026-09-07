//   cd packages/bridge-core && npx tsx --test src/language-confirm.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectLanguageHints, shouldConfirmLanguage, confirmLanguageHint, parseLanguageConfirmation, languageModalityHint } from "./language.ts";

test("only the weak romanized band asks the model; native script and strong signals never do", () => {
  assert.equal(shouldConfirmLanguage({ primary: "french", hasNativeScript: false, hasRomanized: true, mixed: false, confidence: 0.5 }), true);
  assert.equal(shouldConfirmLanguage({ primary: "telugu", hasNativeScript: true, hasRomanized: false, mixed: false, confidence: 0.5 }), false);
  assert.equal(shouldConfirmLanguage({ primary: "telugu", hasNativeScript: false, hasRomanized: true, mixed: false, confidence: 0.9 }), false);
  assert.equal(shouldConfirmLanguage({ primary: "english", hasNativeScript: false, hasRomanized: false, mixed: false, confidence: 0 }), false);
});

test("a confident 'english' from the model disengages the language mode; a weak or broken answer keeps the wordlist", async () => {
  const weak = { primary: "french" as const, hasNativeScript: false, hasRomanized: true, mixed: false, confidence: 0.5 };
  const eng = async () => '{"language":"english","confidence":0.95}';
  const h = await confirmLanguageHint("we're opening in Brambleton, VA next week", weak, eng);
  assert.equal(h.primary, "english");
  assert.equal(languageModalityHint(h), "", "no French reply mode");
  const unsure = async () => '{"language":"english","confidence":0.4}';
  assert.equal((await confirmLanguageHint("x", weak, unsure)).primary, "french");
  const dead = async () => { throw new Error("timeout"); };
  assert.equal((await confirmLanguageHint("x", weak, dead)).primary, "french");
  assert.equal(parseLanguageConfirmation('{"language":"klingon","confidence":1}'), null);
  // A confident non-English answer raises confidence so the mode engages.
  const tel = async () => '{"language":"telugu","confidence":0.9}';
  const t = await confirmLanguageHint("ela unnav", { ...weak, primary: "telugu" }, tel);
  assert.equal(t.confidence, 0.9);
  // Strong wordlist verdicts never spend a call.
  let calls = 0; const counting = async () => { calls++; return '{"language":"english","confidence":1}'; };
  await confirmLanguageHint("ela unnav ra", detectLanguageHints("ela unnav bagunnava"), counting);
  const strong = detectLanguageHints("ela unnav bagunnava");
  if (strong.confidence >= 0.7) assert.equal(calls, 0);
});
