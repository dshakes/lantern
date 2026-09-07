//   cd packages/bridge-core && npx tsx --test src/register-judge.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectEmotionalRegister, shouldJudgeRegister, parseRegisterJudgment, resolveEmotionalRegister } from "./emotional-register.ts";

const TELUGU_DISTRESS = "Abba please shekar tensionga undi chethilo dabbulu levu emcheyyalo ardamirhaledu";

test("the English table is silent on Telugu distress, and that is exactly when the model is asked", () => {
  const table = detectEmotionalRegister(TELUGU_DISTRESS);
  assert.equal(shouldJudgeRegister(TELUGU_DISTRESS, table), table.register === "neutral");
  assert.equal(shouldJudgeRegister("I am so sad and scared right now", detectEmotionalRegister("I am so sad and scared right now")), false, "table already fired → no call");
  assert.equal(shouldJudgeRegister("ok", detectEmotionalRegister("ok")), false, "too short");
  assert.equal(shouldJudgeRegister("see you at 6", detectEmotionalRegister("see you at 6")), false, "plain English neutral → no call");
});

test("tolerant parse, conservative acceptance, fail-safe to the table", async () => {
  assert.deepEqual(parseRegisterJudgment('```json\n{"register":"distress","confidence":0.9}\n```')?.register, "distress");
  assert.equal(parseRegisterJudgment('{"register":"panic","confidence":0.9}'), null);
  assert.equal(parseRegisterJudgment("not json"), null);
  const yes = async () => '{"register":"distress","confidence":0.85}';
  const v = await resolveEmotionalRegister(TELUGU_DISTRESS, yes);
  assert.equal(v.register, "distress");
  const weak = async () => '{"register":"distress","confidence":0.3}';
  assert.equal((await resolveEmotionalRegister(TELUGU_DISTRESS, weak)).register, detectEmotionalRegister(TELUGU_DISTRESS).register, "low confidence → table stands");
  const dead = async () => { throw new Error("timeout"); };
  assert.equal((await resolveEmotionalRegister(TELUGU_DISTRESS, dead)).register, detectEmotionalRegister(TELUGU_DISTRESS).register);
  // English text never spends a call even with an LLM wired.
  let calls = 0; const counting = async () => { calls++; return '{"register":"distress","confidence":1}'; };
  await resolveEmotionalRegister("see you at 6", counting);
  assert.equal(calls, 0);
});
