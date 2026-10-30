import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Regression: runner.ts guarded on `typeof require !== "undefined" ? require.main === module`.
// In the built ESM bundle that threw "module is not defined in ES module scope" as soon as
// an ES module imported the package, so a from-source install was unusable.
describe("built ESM bundle", () => {
  it("imports from an ES module without throwing", () => {
    const root = resolve(__dirname, "..");
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
    const dir = mkdtempSync(join(tmpdir(), "pal-sdk-esm-"));
    const probe = join(dir, "probe.mjs");
    const url = (f: string) => pathToFileURL(join(root, "dist", f)).href;
    writeFileSync(
      probe,
      `const m = await import(${JSON.stringify(url("index.js"))});\n` +
        `await import(${JSON.stringify(url("runner.js"))});\n` +
        `console.log(typeof m.PalClient);\n`,
    );
    expect(execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim()).toBe("function");
  }, 120_000);
});
