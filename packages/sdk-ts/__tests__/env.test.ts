import { afterEach, describe, expect, it } from "vitest";
import { palEnv } from "../src/env.js";

describe("palEnv", () => {
  afterEach(() => {
    delete process.env.PAL_ZZ_TEST;
  });

  it("reads PAL_<suffix>", () => {
    process.env.PAL_ZZ_TEST = "pal";
    expect(palEnv("ZZ_TEST")).toBe("pal");
  });

  it("treats an empty value as unset", () => {
    process.env.PAL_ZZ_TEST = "";
    expect(palEnv("ZZ_TEST")).toBeUndefined();
  });

  it("is undefined when not set", () => {
    expect(palEnv("ZZ_TEST")).toBeUndefined();
  });
});
