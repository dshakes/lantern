// Regression: a file with an unrelated NAME inside an aptly-named FOLDER
// must be found and outrank the folder itself. Real-world miss: query
// "green card" → folder `I-485/Manasa/Green Card/` matched by find, but
// `SeshamManasa_LatestGC.pdf` inside it never entered the pool, so the
// assistant reported "no green card doc on the mac".
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { PersonalDocs } from "./personal-docs.ts";

test("search descends into phrase-matched folders and ranks the file above the folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdocs-"));
  try {
    const gcDir = join(root, "I-485", "Manasa", "Green Card");
    mkdirSync(gcDir, { recursive: true });
    writeFileSync(join(gcDir, "SeshamManasa_LatestGC.pdf"), "%PDF-1.4 stub");
    // Decoy sibling that DOES contain a query word in its name.
    writeFileSync(join(root, "I-485", "Manasa", "H1B card notes.txt"), "h1b");

    const docs = new PersonalDocs(
      { roots: [root], maxResults: 10, maxReadChars: 4000, auditLogPath: join(root, "audit.log") },
      pino({ level: "silent" }),
    );
    const results = await docs.search("green card");
    const paths = results.map((r) => r.path);
    const gcFile = join(gcDir, "SeshamManasa_LatestGC.pdf");
    assert.ok(paths.includes(gcFile), `expected ${gcFile} in results, got: ${paths.join(", ")}`);
    // The card file must rank above the bare folder breadcrumb.
    assert.ok(
      paths.indexOf(gcFile) < paths.findIndex((p) => p === gcDir || p.endsWith("Green Card")),
      `file ranked below folder: ${paths.join(", ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
