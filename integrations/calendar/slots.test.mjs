import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentNote, preferredSlots, selectedSlot, todayInIST } from "../../assets/booking-slots.js";

const before = new Date("2026-09-13T00:00:00Z");

test("IST dates are independent of the browser or machine timezone", () => {
  assert.equal(todayInIST(new Date("2026-09-14T18:29:59Z")), "2026-09-14");
  assert.equal(todayInIST(new Date("2026-09-14T18:30:00Z")), "2026-09-15");
  assert.throws(() => todayInIST(new Date("invalid")), RangeError);
});

test("weekday slots begin at 4 PM and finish by 11 PM for both durations", () => {
  for (const date of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]) {
    for (const [duration, count, last] of [[30, 14, "22:30"], [60, 13, "22:00"]]) {
      const slots = preferredSlots(date, duration, before);
      assert.equal(slots.length, count);
      assert.equal(slots[0].time, "16:00");
      assert.equal(slots.at(-1).time, last);
      assert.equal(slots[0].start, `${date}T10:30:00.000Z`);
      assert.equal(slots.at(-1).end, `${date}T17:30:00.000Z`);
      for (const slot of slots) assert.equal(Date.parse(slot.end) - Date.parse(slot.start), duration * 60000);
    }
  }
});

test("Saturday and Sunday slots start at 11 AM, with no late-ending sessions", () => {
  for (const date of ["2026-09-19", "2026-09-20"]) {
    for (const [duration, count, last] of [[30, 24, "22:30"], [60, 23, "22:00"]]) {
      const slots = preferredSlots(date, duration, before);
      assert.equal(slots.length, count);
      assert.equal(slots[0].time, "11:00");
      assert.equal(slots.at(-1).time, last);
      assert.equal(slots[0].start, `${date}T05:30:00.000Z`);
    }
  }
});

test("past dates, past start times and a slot starting exactly now are excluded", () => {
  assert.deepEqual(preferredSlots("2026-09-12", 30, before), []);
  const now = new Date("2026-09-14T10:30:00Z");
  assert.equal(preferredSlots("2026-09-14", 30, now)[0].time, "16:30");
  assert.throws(() => selectedSlot("2026-09-14", "16:00", 30, now), RangeError);
  assert.deepEqual(preferredSlots("2026-09-14", 60, new Date("2026-09-14T16:30:00Z")), []);
});

test("malformed dates, impossible calendar dates and unsupported durations are rejected", () => {
  for (const date of ["", "2026-2-01", "2026-02-30", "2026-13-01", "2026-04-31", "2026-09-14\n", "2026-09-14<script>"]) {
    assert.throws(() => preferredSlots(date, 30, before), RangeError);
  }
  assert.ok(preferredSlots("2028-02-29", 30, before).length > 0);
  assert.throws(() => preferredSlots("2027-02-29", 30, before), RangeError);
  for (const duration of [0, 15, 90, "30", NaN]) assert.throws(() => preferredSlots("2026-09-14", duration, before), RangeError);
  assert.throws(() => selectedSlot("2026-09-14", "22:30", 60, before), RangeError);
  assert.throws(() => selectedSlot("2026-09-14", "16:15", 30, before), RangeError);
});

test("review notes include the exact preference and fee without claiming a reservation", () => {
  const slot = selectedSlot("2026-09-14", "16:00", 30, before);
  assert.equal(paymentNote({ name: "Mentorship", priceInr: 499 }, "2026-09-14", slot),
    "Mentorship | 2026-09-14 | 4:00 PM - 4:30 PM IST | INR 499 | Time not confirmed");
});
