import { afterEach, describe, expect, it } from "vitest";
import { palEnv } from "../src/env.js";

describe("palEnv", () => {
  afterEach(() => {
    delete process.env.PAL_ZZ_TEST;
    delete process.env.LANTERN_ZZ_TEST;
  });

  it("falls back to LANTERN_ when only the legacy name is set", () => {
    process.env.LANTERN_ZZ_TEST = "legacy";
    expect(palEnv("ZZ_TEST")).toBe("legacy");
  });

  it("PAL_ wins when both are set; empty PAL_ does not override", () => {
    process.env.LANTERN_ZZ_TEST = "legacy";
    process.env.PAL_ZZ_TEST = "pal";
    expect(palEnv("ZZ_TEST")).toBe("pal");
    process.env.PAL_ZZ_TEST = "";
    expect(palEnv("ZZ_TEST")).toBe("legacy");
  });

  it("is undefined when neither is set", () => {
    expect(palEnv("ZZ_TEST")).toBeUndefined();
  });
});
