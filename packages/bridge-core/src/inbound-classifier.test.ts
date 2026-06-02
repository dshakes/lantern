// Tests for the unknown-sender inbound classifier. The bar: never silence a
// real person as spam (conservative), never miss a booking confirmation
// (generous), and tag obvious marketing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyUnknownInbound } from "./inbound-classifier.ts";

const APPOINTMENTS = [
  "Your appointment at Hammer and Nails is confirmed for Wed June 3 at 6:45 PM.",
  "Reminder: you're booked with Dr. Chand tomorrow at 10am.",
  "Hi! This confirms your reservation for 2 on Friday 7:30pm.",
  "Your visit is scheduled for 6/3 at 3:45pm. See you then!",
  "Delivery window scheduled for tomorrow 2-4pm.",
];

const SPAM = [
  "🎉 50% off all services this weekend only! Reply STOP to opt out.",
  "Limited time deal — claim your exclusive offer now: bit.ly/abc123",
  "Congratulations you're a winner! Click here to claim your free gift.",
  "Lowest prices of the year. Shop now and save big!",
];

const OTHER = [
  "hey are you free to chat later?",
  "can you send me that doc when you get a chance",
  "running 10 min late sorry",
  "happy birthday!!",
];

for (const m of APPOINTMENTS) {
  test(`appointment: ${m.slice(0, 40)}`, () => {
    assert.equal(classifyUnknownInbound(m).kind, "appointment", m);
  });
}

for (const m of SPAM) {
  test(`spam: ${m.slice(0, 40)}`, () => {
    assert.equal(classifyUnknownInbound(m).kind, "spam", m);
  });
}

for (const m of OTHER) {
  test(`other (never silenced): ${m.slice(0, 40)}`, () => {
    assert.equal(classifyUnknownInbound(m).kind, "other", m);
  });
}

test("a salon PROMO with a date is spam, not an appointment", () => {
  // marketing words present → must not be mistaken for a booking
  assert.equal(
    classifyUnknownInbound("20% off haircuts this Friday only! Book now.").kind,
    "spam",
  );
});

test("a real booking with a link is still an appointment", () => {
  assert.equal(
    classifyUnknownInbound("Your appointment is confirmed for June 3 6:45pm. Manage it: myvagaro.com/x").kind,
    "appointment",
  );
});
