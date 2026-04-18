// Tests for the JID validators that gate every mutation endpoint.
//
// These are pure string checks, but the risk of getting them wrong is
// high — a lax validator lets a caller pass "/../../" or a 5MB blob as a
// "jid" and reach into Baileys internals. A strict validator rejects
// legitimate inputs like newer `@lid` IDs and breaks groups.

import { describe, it, expect } from "vitest";
import { isValidJid, isValidGroupJid, timingSafeEqual } from "../src/validation.js";

describe("isValidJid", () => {
  it("accepts a standard WhatsApp DM jid", () => {
    expect(isValidJid("15551234567@s.whatsapp.net")).toBe(true);
  });

  it("accepts a group jid", () => {
    expect(isValidJid("120363042055163051@g.us")).toBe(true);
  });

  it("accepts an @lid (newer privacy format)", () => {
    expect(isValidJid("184748035047628@lid")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isValidJid(undefined)).toBe(false);
    expect(isValidJid(null)).toBe(false);
    expect(isValidJid(42)).toBe(false);
    expect(isValidJid({})).toBe(false);
    expect(isValidJid([])).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isValidJid("")).toBe(false);
  });

  it("rejects unknown suffixes", () => {
    expect(isValidJid("foo@example.com")).toBe(false);
    expect(isValidJid("1234567890@other")).toBe(false);
    expect(isValidJid("nobody")).toBe(false);
  });

  it("rejects strings with whitespace or control chars", () => {
    expect(isValidJid("1234 567@s.whatsapp.net")).toBe(false);
    expect(isValidJid("1234\n567@g.us")).toBe(false);
    expect(isValidJid("\x001234@lid")).toBe(false);
  });

  it("rejects absurdly long inputs", () => {
    const long = "1".repeat(200) + "@s.whatsapp.net";
    expect(isValidJid(long)).toBe(false);
  });
});

describe("isValidGroupJid", () => {
  it("accepts only @g.us jids", () => {
    expect(isValidGroupJid("120363042055163051@g.us")).toBe(true);
    expect(isValidGroupJid("15551234567@s.whatsapp.net")).toBe(false);
    expect(isValidGroupJid("184748035047628@lid")).toBe(false);
  });

  it("rejects invalid inputs", () => {
    expect(isValidGroupJid(undefined)).toBe(false);
    expect(isValidGroupJid("")).toBe(false);
    expect(isValidGroupJid(123)).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeEqual("hello", "world")).toBe(false);
  });

  it("returns false for different lengths (short-circuits safely)", () => {
    expect(timingSafeEqual("hello", "helloworld")).toBe(false);
    expect(timingSafeEqual("a", "")).toBe(false);
  });

  it("treats empty strings as equal", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
