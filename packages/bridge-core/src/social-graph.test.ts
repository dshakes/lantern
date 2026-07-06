import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocialGraph } from "./social-graph.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "social-")), "topic-index.jsonl");
}

describe("SocialGraph encryption at rest", () => {
  test("record encrypts on disk; a fresh instance reads it back", async () => {
    const file = tmpFile();
    const g = new SocialGraph({ path: file });
    await g.record({
      jid: "raju@x",
      contactName: "Raju",
      text: "SECRETMORTGAGE9911 approved today",
      fromMe: false,
      topics: ["mortgage"],
    });

    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("SECRETMORTGAGE9911"), "message text not in plaintext on disk");
    assert.ok(raw.split("\n").filter(Boolean).every((l) => l.startsWith("enc1:")));

    const fresh = new SocialGraph({ path: file });
    const hits = await fresh.related({ topics: ["mortgage"], excludeJid: "someone-else@x" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text, "SECRETMORTGAGE9911 approved today");
  });

  test("mixed legacy-plaintext + encrypted lines both read", async () => {
    const file = tmpFile();
    appendFileSync(
      file,
      JSON.stringify({ jid: "raju@x", text: "legacy msg", fromMe: false, topics: ["loan"], ts: Date.now() }) + "\n",
    );
    const g = new SocialGraph({ path: file });
    await g.record({ jid: "madhu@x", text: "new msg", fromMe: false, topics: ["loan"] });

    const texts = (await new SocialGraph({ path: file }).related({ topics: ["loan"], excludeJid: "z@x" })).map((m) => m.text);
    assert.ok(texts.includes("legacy msg"), "legacy plaintext still readable");
    assert.ok(texts.includes("new msg"), "new encrypted readable");
  });
});
