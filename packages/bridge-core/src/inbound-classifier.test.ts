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

// Transactional notices (payments, bills, OTPs, order/shipping receipts). These
// often carry "confirmation" + a date but are NOT calendar appointments — they
// must NEVER be surfaced as "add to your calendar". Regression: an AT&T payment
// confirmation was offered as a calendar event.
const PAYMENTS_NOT_APPOINTMENTS = [
  // The exact production false-positive:
  'AT&T Free Msg: Payment Confirmation #8WY7EPAYN0CK2Z0 for $256.67 paid 6/3/2026 Noted to account #********6011 on 6/3/2026. Visit us at att.com/myattapp Payment Terms & Conditions: tnc.att.com/48f06f39',
  "Your payment of $89.99 was received on 6/3. Thank you!",
  "Chase: A payment of $1,250.00 posted to your account ending 6011 on 06/03/2026.",
  "Your verification code is 472913. It expires in 10 minutes.",
  "Amazon: Your order #112-3344 has shipped, arriving 6/5. Track it here.",
  "Your electricity bill of $142.30 is due 6/15. Autopay scheduled.",
  "Zelle: You sent $50.00 to Raju on 6/3/2026. Confirmation #ABC123.",
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

for (const m of PAYMENTS_NOT_APPOINTMENTS) {
  test(`payment/OTP/bill is NOT an appointment: ${m.slice(0, 45)}`, () => {
    assert.notEqual(
      classifyUnknownInbound(m).kind,
      "appointment",
      `must not offer to calendar a transactional notice: ${m}`,
    );
  });
}

test("a booking that mentions a deposit amount is STILL an appointment", () => {
  // a strong booking word (reservation) + future time wins over the $ amount
  assert.equal(
    classifyUnknownInbound("Your reservation for 2 is confirmed for Fri 7:30pm. A $25 deposit was charged.").kind,
    "appointment",
  );
});
