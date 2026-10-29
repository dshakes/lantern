// node:test suite for env-compat.ts (ADR 0032 PAL_/LANTERN_ env mirroring).
// Run: node --import=tsx/esm --test src/env-compat.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bridgeEnv } from "./env-compat.ts";
import { execFileSync } from "node:child_process";

type Env = Record<string, string | undefined>;

function run(env: Env): { env: Env; warnings: string[] } {
  const warnings: string[] = [];
  bridgeEnv(env, (m) => warnings.push(m));
  return { env, warnings };
}

describe("bridgeEnv", () => {
  const cases: Array<{ name: string; env: Env; want: Env; warns: number }> = [
    { name: "legacy only is mirrored to PAL", env: { LANTERN_API_URL: "u" },
      want: { LANTERN_API_URL: "u", PAL_API_URL: "u" }, warns: 0 },
    { name: "PAL only is mirrored to LANTERN", env: { PAL_ENV: "prod" },
      want: { PAL_ENV: "prod", LANTERN_ENV: "prod" }, warns: 0 },
    { name: "both equal: untouched", env: { PAL_X: "v", LANTERN_X: "v" },
      want: { PAL_X: "v", LANTERN_X: "v" }, warns: 0 },
    { name: "both differ: PAL wins, one warning", env: { PAL_X: "new", LANTERN_X: "old" },
      want: { PAL_X: "new", LANTERN_X: "new" }, warns: 1 },
    { name: "empty PAL never blanks a non-empty LANTERN", env: { PAL_X: "", LANTERN_X: "v" },
      want: { PAL_X: "v", LANTERN_X: "v" }, warns: 0 },
    { name: "empty PAL beside empty LANTERN: untouched", env: { PAL_X: "", LANTERN_X: "" },
      want: { PAL_X: "", LANTERN_X: "" }, warns: 0 },
    { name: "empty PAL alone is mirrored", env: { PAL_X: "" },
      want: { PAL_X: "", LANTERN_X: "" }, warns: 0 },
    { name: "bare prefixes and unrelated keys ignored",
      env: { PAL_: "a", LANTERN_: "b", PATH: "/bin", PALX: "1", lantern_x: "2" },
      want: { PAL_: "a", LANTERN_: "b", PATH: "/bin", PALX: "1", lantern_x: "2" }, warns: 0 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const { env, warnings } = run({ ...c.env });
      assert.deepEqual(env, c.want);
      assert.equal(warnings.length, c.warns);
    });
  }

  it("logs key names only, never values", () => {
    const { warnings } = run({ PAL_TOKEN: "s3cret-new", LANTERN_TOKEN: "s3cret-old" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PAL_TOKEN/);
    assert.doesNotMatch(warnings[0], /s3cret/);
  });

  it("is idempotent", () => {
    const env: Env = { LANTERN_A: "1", PAL_B: "2" };
    bridgeEnv(env, () => {});
    const once = { ...env };
    bridgeEnv(env, () => {});
    assert.deepEqual(env, once);
  });

  // imessage index.ts: env-compat runs on import, then loadEnvFile adds keys
  // (never overriding existing ones), then bridgeEnv() runs again.
  it("a re-run picks up keys added after the first run", () => {
    const env: Env = { LANTERN_A: "plist" };
    bridgeEnv(env, () => {});
    env.LANTERN_B = "file";
    bridgeEnv(env, () => {});
    assert.deepEqual(env, { LANTERN_A: "plist", PAL_A: "plist", LANTERN_B: "file", PAL_B: "file" });
  });

  // Our own mirror must never "win" over a later explicit LANTERN_ value.
  it("a re-run refreshes a stale mirror instead of letting it win", () => {
    const warnings: string[] = [];
    const env: Env = { LANTERN_A: "old" };
    bridgeEnv(env, (m) => warnings.push(m));
    env.LANTERN_A = "new"; // e.g. a later explicit write
    bridgeEnv(env, (m) => warnings.push(m));
    assert.deepEqual(env, { LANTERN_A: "new", PAL_A: "new" });
    assert.equal(warnings.length, 0);
  });

  it("an explicit PAL_ set after the first run still wins", () => {
    const env: Env = { LANTERN_A: "legacy" };
    bridgeEnv(env, () => {});
    env.PAL_A = "operator";
    bridgeEnv(env, () => {});
    assert.deepEqual(env, { LANTERN_A: "operator", PAL_A: "operator" });
  });

  it("bridges process.env on import", () => {
    // The import above already ran bridgeEnv() on the real env; any LANTERN_
    // key the test process inherited must have its PAL_ twin.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("LANTERN_") && k.length > 8) {
        assert.equal(process.env["PAL_" + k.slice(8)], process.env[k], k);
      }
    }
  });
});

// Regression (PR #365 review): a consumer that imports auth.ts/agent.ts
// WITHOUT importing env-compat first must still see legacy LANTERN_* values,
// because those modules read PAL_* in top-level consts.
describe("modules with top-level env reads self-bridge", () => {
  for (const mod of ["./auth.ts", "./agent.ts", "./owner-profile.ts"]) {
    it(`${mod} mirrors LANTERN_API_TOKEN before it evaluates`, () => {
      const env: Env = { ...process.env, LANTERN_API_TOKEN: "legacy-tok" };
      for (const k of Object.keys(env)) if (k.startsWith("PAL_")) delete env[k];
      const out = execFileSync(
        process.execPath,
        ["--import=tsx/esm", "--input-type=module", "-e",
          `await import(${JSON.stringify(new URL(mod, import.meta.url).href)}); process.stdout.write(process.env.PAL_API_TOKEN ?? "")`],
        { env: env as NodeJS.ProcessEnv, encoding: "utf8" },
      );
      assert.equal(out, "legacy-tok");
    });
  }
});

describe("auth.ts resolves legacy-only config", () => {
  it("uses LANTERN_API_URL + LANTERN_API_TOKEN when no PAL_* is set", () => {
    const env: Env = {
      ...process.env,
      LANTERN_API_URL: "http://legacy.invalid",
      LANTERN_API_TOKEN: "legacy-tok",
    };
    for (const k of Object.keys(env)) if (k.startsWith("PAL_")) delete env[k];
    const auth = JSON.stringify(new URL("./auth.ts", import.meta.url).href);
    const script = `
      globalThis.fetch = async (u, init) => {
        process.stdout.write(JSON.stringify({ url: String(u), auth: new Headers(init?.headers).get("authorization") }));
        return new Response("{}");
      };
      const { authedFetch } = await import(${auth});
      await authedFetch("/v1/ping");`;
    const out = execFileSync(
      process.execPath,
      ["--import=tsx/esm", "--input-type=module", "-e", script],
      { env: env as NodeJS.ProcessEnv, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(out), { url: "http://legacy.invalid/v1/ping", auth: "Bearer legacy-tok" });
  });
});
