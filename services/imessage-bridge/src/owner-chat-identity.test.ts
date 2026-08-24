import { describe, it, expect } from "vitest";
import { isOwnerChatRow } from "./session.js";

// Regression for a TRUST BOUNDARY failure observed 2026-08-24.
//
// isSelfChat cached confirmed owner chats in a `Set<number>` keyed by chat
// rowid. chat.db yields rows with a NULL chat id (they arrive before the chat
// join resolves), and a Set stores `null` without complaint — so one owner
// message with a null rowid poisoned the cache, and every later null-rowid
// message from ANY contact was classified as the owner.
//
// Consequence: 10 non-owner handles were routed into the owner pipeline
// (personal documents + agentic actions), and one contact was answered with a
// raw "[[NO_REPLY]]" because the owner path lacks the contact path's guards.

const OWNER = "+15125550000";
const CONTACT = "+17036234171";

describe("isOwnerChatRow — owner identity is decided by handle, never by a null cache key", () => {
  it("does NOT treat a contact as the owner when the rowid is null", () => {
    // The poisoned state: `null` present in the cache from a prior owner row.
    const poisoned = new Set<number>([null as unknown as number]);
    expect(isOwnerChatRow(null, CONTACT, OWNER, poisoned)).toBe(false);
    expect(isOwnerChatRow(undefined, CONTACT, OWNER, poisoned)).toBe(false);
    expect(isOwnerChatRow(0, CONTACT, OWNER, poisoned)).toBe(false);
  });

  it("still recognizes the owner when the rowid is null", () => {
    expect(isOwnerChatRow(null, OWNER, OWNER, new Set())).toBe(true);
    // Formatting differences must not break owner recognition.
    expect(isOwnerChatRow(null, "+1 (512) 555-0000", OWNER, new Set())).toBe(true);
  });

  it("uses the cache only for real row ids", () => {
    const cache = new Set<number>([42]);
    expect(isOwnerChatRow(42, CONTACT, OWNER, cache)).toBe(true);   // known owner chat
    expect(isOwnerChatRow(43, CONTACT, OWNER, cache)).toBe(false);  // different chat
  });

  it("fails closed to the contact path when the owner handle is unset", () => {
    // No configured owner => nobody is the owner, even with a poisoned cache.
    const poisoned = new Set<number>([null as unknown as number]);
    expect(isOwnerChatRow(null, CONTACT, "", poisoned)).toBe(false);
    expect(isOwnerChatRow(7, CONTACT, "", new Set())).toBe(false);
  });
});
