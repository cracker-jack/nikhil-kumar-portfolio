import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { normalizePayment } from "../razorpay/payment-model.mjs";
import { MemoryBookingStore, createBookingService, validateBookingIntent } from "./booking-service.mjs";

const NOW = new Date("2026-09-15T09:00:00.000Z");
const SERVICES = Object.freeze([
  Object.freeze({ id: "mentorship", name: "Mentorship", durationMinutes: 30, amountPaise: 100, currency: "INR" }),
]);
const ORDER = Object.freeze({
  mode: "test", orderId: "order_BookingFixture", serviceId: "mentorship", bookingId: "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
  amountPaise: 100, currency: "INR", receipt: "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
});
const PAYMENT = normalizePayment({
  entity: "payment", id: "pay_BookingFixture", order_id: ORDER.orderId, amount: 100,
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
  const calls = { orders: 0, verify: 0, availability: 0, events: 0, whatsapp: [], logs: [] };
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
      return { key: "rzp_test_fixture", order_id: order.orderId, amount: 100, currency: "INR", prefill: customer };
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
  const whatsapp = overrides.whatsapp === false ? null : overrides.whatsapp || null;
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
      if (overrides.eventResponse) return overrides.eventResponse;
      return new Response(JSON.stringify({ kind: "calendar#event", id: "event_fixture", htmlLink: "https://calendar.example.invalid/event" }));
    },
    whatsapp,
    now: () => NOW,
    logger: (message) => calls.logs.push(message),
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
  assert.equal(result.checkout.amount, 100);
  assert.equal(calls.availability, 1);
  assert.equal(calls.orders, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("active payment hold prevents a second checkout for the same slot", async () => {
  const { service, calls } = fixture();
  const input = {
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: "First Customer", customerEmail: "first@example.com",
  };
  await service.createIntent(input);
  await assert.rejects(service.createIntent({
    ...input, customerName: "Second Customer", customerEmail: "second@example.com",
  }), { code: "slot_unavailable" });
  assert.equal(calls.orders, 1);
});

test("WhatsApp opt-in fails explicitly when notifications are not configured", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: "Nikhil Kumar", customerEmail: "user@example.com",
    customerPhone: "+919876543210", whatsappConsent: true,
  }), { code: "whatsapp_unavailable", status: 503 });
  assert.equal(calls.orders, 0);
});

test("invalid slot and customer details fail before payment order creation", async () => {
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "A", customerEmail: "bad",
  }, SERVICES, NOW), /Name is invalid/);
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "bad@example",
  }, SERVICES, NOW), /Email is invalid/);
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "bad..dots@example.com",
  }, SERVICES, NOW), /Email is invalid/);
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: "Nikhil Kumar", customerEmail: "user@example.com", customerPhone: "+919876543210",
  }, SERVICES, NOW), /WhatsApp consent is required/);
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: "Nikhil Kumar", customerEmail: "user@example.com",
    customerPhone: "9876543210", whatsappConsent: true,
  }, SERVICES, NOW), /international format/);
  assert.throws(() => validateBookingIntent({
    serviceId: "mentorship", date: "2026-09-14", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "user@example.com",
  }, SERVICES, NOW), /Choose today or a future date/);
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
  assert.equal(booking.serviceName, "Mentorship");
  assert.equal(booking.slotLabel, "4:00 PM - 4:30 PM");
  assert.equal(booking.paymentReference, "pay_BookingFixture");
  assert.equal(booking.calendarEvent.eventLink, "https://calendar.example.invalid/event");
  assert.equal(calls.verify, 1);
  assert.equal(calls.events, 1);
});

test("confirmed booking sends an opted-in WhatsApp confirmation and records delivery", async () => {
  const calls = [];
  const { service } = fixture({
    whatsapp: {
      async sendBookingConfirmation(message) {
        calls.push(message);
        return { messageId: "wamid.booking-fixture" };
      },
    },
  });
  const intent = await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: "Nikhil Kumar", customerEmail: "user@example.com",
    customerPhone: "+91 98765 43210", whatsappConsent: true,
  });
  assert.deepEqual(intent.booking.whatsapp, { requested: true, status: "pending" });
  const booking = await service.confirmCheckout(callback());
  assert.equal(booking.status, "confirmed");
  assert.deepEqual(booking.whatsapp, { requested: true, status: "sent" });
  assert.deepEqual(calls, [{
    phone: "+919876543210",
    customerName: "Nikhil Kumar",
    serviceName: "Mentorship",
    confirmedTime: "16 September 2026, 4:00 PM - 4:30 PM IST",
    bookingId: intent.booking.bookingId,
    paymentReference: "pay_BookingFixture",
  }]);
});

test("WhatsApp failure is recorded without downgrading a confirmed booking", async () => {
  const { service, calls } = fixture({
    whatsapp: {
      async sendBookingConfirmation() {
        const error = new Error("private provider detail");
        error.code = "whatsapp_delivery_failed";
        throw error;
      },
    },
  });
  await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00",
    customerName: "Nikhil Kumar", customerEmail: "user@example.com",
    customerPhone: "+919876543210", whatsappConsent: true,
  });
  const booking = await service.confirmCheckout(callback());
  assert.equal(booking.status, "confirmed");
  assert.deepEqual(booking.whatsapp, { requested: true, status: "failed" });
  assert.deepEqual(calls.logs, ["WHATSAPP_CONFIRMATION_FAILED: whatsapp_delivery_failed"]);
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

test("captured payment is flagged for manual resolution when invite creation fails", async () => {
  const { service, calls } = fixture({
    eventResponse: new Response(JSON.stringify({ error: { message: "calendar write denied" } }), { status: 403 }),
  });
  await service.createIntent({
    serviceId: "mentorship", date: "2026-09-16", time: "16:00", customerName: "Nikhil Kumar", customerEmail: "user@example.com",
  });
  const booking = await service.confirmCheckout(callback());
  assert.equal(booking.status, "paid_needs_manual_resolution");
  assert.equal(booking.resolutionReason, "calendar_invite_failed");
  assert.equal(calls.events, 1);
  assert.deepEqual(calls.logs, ["CALENDAR_INVITE_FAILED: GOOGLE_REQUEST_FAILED"]);
});

test("booking checkout is disabled when authorization lacks Calendar event-write scope", () => {
  assert.throws(() => createBookingService({
    availabilityService: { getAvailability: async () => ({ slots: [slot] }) },
    razorpay: { services: SERVICES },
    store: new MemoryBookingStore(),
    calendarConfig: { calendarId: "calendar@example.invalid" },
    savedAuthorization: { scope: "https://www.googleapis.com/auth/calendar.events.freebusy" },
  }), /Calendar event permission/);
});

test("uncaptured payment does not create a calendar event", async () => {
  const { service, calls } = fixture({
    payment: normalizePayment({
      entity: "payment", id: "pay_BookingFixture", order_id: ORDER.orderId, amount: 100,
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
