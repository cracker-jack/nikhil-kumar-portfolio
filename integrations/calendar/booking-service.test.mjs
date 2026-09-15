import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { normalizePayment } from "../razorpay/payment-model.mjs";
import { MemoryBookingStore, createBookingService, validateBookingIntent } from "./booking-service.mjs";

const NOW = new Date("2026-09-15T09:00:00.000Z");
const SERVICES = Object.freeze([
  Object.freeze({ id: "mentorship", name: "Mentorship", durationMinutes: 30, amountPaise: 49900, currency: "INR" }),
]);
const ORDER = Object.freeze({
  mode: "test", orderId: "order_BookingFixture", serviceId: "mentorship", bookingId: "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
  amountPaise: 49900, currency: "INR", receipt: "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
});
const PAYMENT = normalizePayment({
  entity: "payment", id: "pay_BookingFixture", order_id: ORDER.orderId, amount: 49900,
  currency: "INR", method: "upi", status: "captured", captured: true, amount_refunded: 0,
});
const slot = Object.freeze({
  time: "16:00", label: "4:00 PM - 4:30 PM", start: "2026-09-16T10:30:00.000Z", end: "2026-09-16T11:00:00.000Z",
});
const callback = () => ({
  razorpay_order_id: ORDER.orderId,
  razorpay_payment_id: PAYMENT.paymentId,
  razorpay_signature: createHmac("sha256", "secret").update(`${ORDER.orderId}|${PAYMENT.paymentId}`).digest("hex"),
});

function fixture(overrides = {}) {
  const calls = { orders: 0, verify: 0, availability: 0, events: 0 };
  const availabilityService = {
    async getAvailability(input) {
      calls.availability++;
      assert.deepEqual(input, { serviceId: "mentorship", date: "2026-09-16" });
      const sequence = overrides.slotsSequence || [overrides.slots || [slot]];
      return { slots: sequence[Math.min(calls.availability - 1, sequence.length - 1)] };
    },
  };
  const razorpay = {
    services: SERVICES,
    async createOrder({ serviceId, receipt, bookingId }) {
      calls.orders++;
      assert.equal(serviceId, "mentorship");
      return { ...ORDER, receipt, bookingId };
    },
    checkoutOptions(order, customer) {
      return { key: "rzp_test_fixture", order_id: order.orderId, amount: 49900, currency: "INR", prefill: customer };
    },
    async verifyCheckout(order, body) {
      calls.verify++;
      assert.equal(order.orderId, body.razorpay_order_id);
      return overrides.payment || PAYMENT;
    },
    async reconcilePayment() {
      return overrides.payment || PAYMENT;
    },
  };
  const store = new MemoryBookingStore();
  const service = createBookingService({
    availabilityService, razorpay, store,
    calendarConfig: { calendarId: "calendar@example.invalid", ownerEmail: "owner@example.invalid", clientId: "client.apps.googleusercontent.com", clientSecret: "secret" },
    savedAuthorization: {
      client_id: "client.apps.googleusercontent.com",
      authorized_email: "owner@example.invalid",
      refresh_token: "refresh",
      scope: "https://www.googleapis.com/auth/calendar.events",
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/token")) {
        return new Response(JSON.stringify({
          access_token: "access", token_type: "Bearer", expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events",
        }));
      }
      if (url.endsWith("/userinfo")) return new Response(JSON.stringify({ email: "owner@example.invalid", email_verified: true }));
      calls.events++;
      assert.equal(options.method, "POST");
      return new Response(JSON.stringify({ kind: "calendar#event", id: "event_fixture", htmlLink: "https://calendar.example.invalid/event" }));
    },
    now: () => NOW,
  });
  return { service, store, calls };
}

test("booking intent validates customer data, rechecks availability and returns safe checkout", async () => {
  const { service, calls } = fixture();
  const result = await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: " Nikhil  Kumar ", customerEmail: "USER@Example.com",
  });
  assert.equal(result.booking.status, "payment_created");
  assert.equal(result.booking.customerEmail, "user@example.com");
  assert.equal(result.checkout.amount, 49900);
  assert.equal(calls.availability, 1);
  assert.equal(calls.orders, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("invalid slot and customer details fail before payment order creation", async () => {
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "A", customerEmail: "bad",
  }, SERVICES, NOW), /Name is invalid/);
  const { service, calls } = fixture({ slots: [] });
  await assert.rejects(service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "user@example.com",
  }), { code: "slot_unavailable" });
  assert.equal(calls.orders, 0);
});

test("captured checkout creates a calendar invitation and reports confirmed booking", async () => {
  const { service, calls } = fixture();
  await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "user@example.com",
  });
  const booking = await service.confirmCheckout(callback());
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.calendarEvent.eventLink, "https://calendar.example.invalid/event");
  assert.equal(calls.verify, 1);
  assert.equal(calls.events, 1);
});

test("captured payment is flagged for manual resolution when calendar turns busy", async () => {
  const { service, calls } = fixture({ slotsSequence: [[slot], []] });
  await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "user@example.com",
  });
  const booking = await service.confirmCheckout(callback());
  assert.equal(booking.status, "paid_needs_manual_resolution");
  assert.equal(calls.events, 0);
});

test("uncaptured payment does not create a calendar event", async () => {
  const { service, calls } = fixture({
    payment: normalizePayment({
      entity: "payment", id: "pay_BookingFixture", order_id: ORDER.orderId, amount: 49900,
      currency: "INR", method: "upi", status: "authorized", captured: false, amount_refunded: 0,
    }),
  });
  await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "user@example.com",
  });
  const booking = await service.confirmCheckout(callback());
  assert.equal(booking.status, "payment_pending");
  assert.equal(calls.events, 0);
});
