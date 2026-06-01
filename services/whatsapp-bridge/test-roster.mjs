import { looksLikeRosterQuery } from "@lantern/bridge-core/roster";
const CASES = [
  "Monna japan ki evaru poindru",
  "Who came to my recent Japan trip",
  "who's in the family group",
  "kaun kaun aaye the wedding mein",
  "ఎవరు వెళ్లారు జపాన్‌కి",
  "what's the weather",     // NOT a roster
  "hi how are you",          // NOT
];
for (const c of CASES) {
  const r = looksLikeRosterQuery(c);
  console.log(`${r.isRoster ? "✓" : " "} ${r.isRoster ? "ROSTER" : "       "} tokens=[${r.tokens.join(",")}] | "${c}" — ${r.reason}`);
}
