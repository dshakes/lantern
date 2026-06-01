import { detectLanguageHints, languageModalityHint } from "@lantern/bridge-core/language";
const CASES = [
  { text: "vadina వాళ్లు eppudostunnaru repu", expect: "telugu" },
  { text: "ela undi anna", expect: "telugu" },
  { text: "em chestunnav?", expect: "telugu" },
  { text: "ఎప్పుడు వస్తున్నారు రేపు", expect: "telugu" },
  { text: "kya kar rahe ho yaar", expect: "hindi" },
  { text: "How are you doing today?", expect: "english" },
  { text: "ok cool", expect: "english" },
  { text: "Hola, como estas amigo?", expect: "spanish" },
  { text: "ela", expect: "telugu" },   // single high-conf token
  { text: "", expect: "english" },     // empty
];
let pass = 0, fail = 0;
for (const c of CASES) {
  const h = detectLanguageHints(c.text);
  const ok = h.primary === c.expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✓" : "✗"} primary=${h.primary} conf=${h.confidence.toFixed(2)} script=${h.hasNativeScript} romanized=${h.hasRomanized} | "${c.text}" (expected ${c.expect})`);
}
console.log(`\n${pass} pass / ${fail} fail`);

console.log("\n--- language modality preview for the user's example ---");
console.log(languageModalityHint(detectLanguageHints("vadina వాళ్లు eppudostunnaru repu"), { nativity: "Karimnagar, Telangana — Telugu (Telangana dialect)" }));
