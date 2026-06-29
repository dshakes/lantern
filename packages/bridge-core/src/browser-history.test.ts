// Tests for the owner "what did I watch / browse" browser-history reader.
//   cd packages/bridge-core && npx tsx --test src/browser-history.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { isWatchQuery, watchSummary, readWatchHistory, iphoneUsageBlock, type WatchItem, type PhoneSignalLite } from "./browser-history.ts";

test("isWatchQuery recognizes watch/browse asks, ignores unrelated", () => {
  for (const q of ["what did i watch", "what was i watching", "what have i been watching today", "my youtube history", "what did i browse earlier", "what did I watch on youtube"]) {
    assert.equal(isWatchQuery(q), true, q);
  }
  for (const q of ["watch out!", "send him a message", "set a reminder to watch the game", "news openai"]) {
    assert.equal(isWatchQuery(q), false, q);
  }
});

test("watchSummary: YouTube first, strips '- YouTube', empty → honest line", () => {
  assert.match(watchSummary([]), /no browser history|Full Disk Access/);
  const now = 1_000_000_000_000;
  const items: WatchItem[] = [
    { title: "Cool Song - YouTube", url: "https://youtube.com/watch?v=1", source: "youtube", ts: now - 600_000 },
    { title: "Some Docs Page", url: "https://example.com/x", source: "web", ts: now - 7_200_000 },
  ];
  const out = watchSummary(items, now);
  assert.match(out, /📺 Recently watched on YouTube/);
  assert.match(out, /Cool Song —/); // "- YouTube" suffix stripped
  assert.doesNotMatch(out, /Cool Song - YouTube/);
  assert.match(out, /🌐 Also browsed/);
  assert.match(out, /10m ago/);
});

test("iphoneUsageBlock: now_playing first, app_open counts, empty when nothing in window", () => {
  const now = 2_000_000_000_000;
  assert.equal(iphoneUsageBlock([], now), ""); // nothing → empty (caller shows browser-only)
  assert.equal(iphoneUsageBlock([{ kind: "now_playing", detail: "Old Song", ts: now - 5 * 24 * 3_600_000 }], now), ""); // out of window
  const sigs: PhoneSignalLite[] = [
    { kind: "now_playing", detail: "Lofi Beats", ts: now - 600_000 },
    { kind: "now_playing", detail: "Lofi Beats", ts: now - 700_000 }, // dup title
    { kind: "app_open", app: "YouTube", ts: now - 1_200_000 },
    { kind: "app_open", app: "YouTube", ts: now - 1_800_000 },
    { kind: "app_open", app: "Instagram", ts: now - 2_400_000 },
  ];
  const out = iphoneUsageBlock(sigs, now);
  assert.match(out, /📱 On your iPhone/);
  assert.match(out, /▶ Lofi Beats/);
  assert.equal((out.match(/Lofi Beats/g) ?? []).length, 1); // deduped
  assert.match(out, /YouTube ×2/);
  assert.match(out, /Instagram/);
});

test("readWatchHistory parses a Chrome History DB with correct time conversion", async () => {
  if (process.platform !== "darwin") return; // reader is darwin-only
  let Database: any;
  try { Database = (await import("better-sqlite3")).default; } catch { return; } // skip if native module absent
  const home = mkdtempSync(join(tmpdir(), "lantern-bh-test-"));
  try {
    const profDir = join(home, "Library", "Application Support", "Google", "Chrome", "Default");
    mkdirSync(profDir, { recursive: true });
    const db = new Database(join(profDir, "History"));
    db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)");
    const now = Date.now();
    const chromeMicros = (unixMs: number) => Math.round((unixMs / 1000 + 11644473600) * 1_000_000);
    db.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?,?,?)").run("https://www.youtube.com/watch?v=abc", "My Watched Video", chromeMicros(now - 1_800_000));
    db.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?,?,?)").run("https://news.site/a", "A News Page", chromeMicros(now - 3_600_000));
    db.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?,?,?)").run("https://old.site/z", "Too Old", chromeMicros(now - 5 * 24 * 3_600_000));
    db.close();

    const items = await readWatchHistory({ homeDir: home, nowMs: now, windowHours: 48 });
    const yt = items.find((i) => i.url.includes("youtube"));
    assert.ok(yt, "youtube item found");
    assert.equal(yt!.source, "youtube");
    assert.equal(yt!.title, "My Watched Video");
    assert.ok(Math.abs(yt!.ts - (now - 1_800_000)) < 2000, "ts round-trips within 2s");
    assert.ok(items.some((i) => i.url.includes("news.site")), "web item found");
    assert.ok(!items.some((i) => i.url.includes("old.site")), "out-of-window item excluded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
