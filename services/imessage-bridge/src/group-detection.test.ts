// Regression tests for the iMessage group-detection predicate.
//
// PRODUCTION BUG: an unnamed group (chat.db ROWID 1829: style=43,
// participants=3, display_name="", a single handle on the message row)
// was classified as a 1:1 by the old heuristic
// (`chatDisplayName !== "" || handle === ""`). A group anniversary wish
// got answered in a SEPARATE 1:1 DM with the sender — wrong thread.
//
// The fix trusts chat.db's authoritative signals first: chat.style (43=group,
// 45=DM), chat.room_name, and a chat-identifier matching /^chat\d+/.

import { describe, it, expect } from "vitest";
import { isGroupRow } from "./session.js";

describe("isGroupRow", () => {
  it("style 43 with NO display name and a single handle is a GROUP (ROWID 1829 repro)", () => {
    // The exact production shape that regressed: group, but unnamed,
    // with one handle on the row and a chat… identifier.
    expect(
      isGroupRow({
        chatStyle: 43,
        chatRoomName: "chat480000000000000000",
        chatIdentifier: "chat480000000000000000",
        chatDisplayName: "",
        handle: "+15125551234",
      }),
    ).toBe(true);
  });

  it("style 43 alone (no room_name, no chat-id pattern, unnamed) is still a GROUP", () => {
    expect(
      isGroupRow({
        chatStyle: 43,
        chatRoomName: "",
        chatIdentifier: "",
        chatDisplayName: "",
        handle: "+15125551234",
      }),
    ).toBe(true);
  });

  it("style 45 (direct) with a handle is a 1:1 — must stay a DM (ROWID 25)", () => {
    expect(
      isGroupRow({
        chatStyle: 45,
        chatRoomName: "",
        chatIdentifier: "+15125551234",
        chatDisplayName: "",
        handle: "+15125551234",
      }),
    ).toBe(false);
  });

  it("named group stays a GROUP (ROWID 1827 — legacy display_name path)", () => {
    expect(
      isGroupRow({
        chatStyle: 43,
        chatRoomName: "chat999000000000000000",
        chatIdentifier: "chat999000000000000000",
        chatDisplayName: "Family",
        handle: "+15125551234",
      }),
    ).toBe(true);
  });

  it("named group is detected even if style is missing (legacy fallback)", () => {
    expect(
      isGroupRow({
        chatStyle: 0,
        chatRoomName: "",
        chatIdentifier: "+15125551234",
        chatDisplayName: "Trip 2031",
        handle: "+15125551234",
      }),
    ).toBe(true);
  });

  it("chat-identifier matching /^chat\\d+/ is a GROUP even without style/room_name", () => {
    expect(
      isGroupRow({
        chatStyle: 0,
        chatRoomName: "",
        chatIdentifier: "chat123456789",
        chatDisplayName: "",
        handle: "",
      }),
    ).toBe(true);
  });

  it("empty handle (multi-party row with no resolved sender) is a GROUP (legacy fallback)", () => {
    expect(
      isGroupRow({
        chatStyle: 0,
        chatRoomName: "",
        chatIdentifier: "",
        chatDisplayName: "",
        handle: "",
      }),
    ).toBe(true);
  });

  it("owner self-chat (style 45, identifier == own handle) is NOT a group", () => {
    // Self-chat must remain a 1:1 so the owner pipeline / self-chat
    // detection is unaffected.
    expect(
      isGroupRow({
        chatStyle: 45,
        chatRoomName: "",
        chatIdentifier: "ada@icloud.com",
        chatDisplayName: "",
        handle: "ada@icloud.com",
      }),
    ).toBe(false);
  });
});
