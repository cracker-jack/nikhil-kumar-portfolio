import { randomBytes } from "node:crypto";
import { selectedSlot } from "../../assets/booking-slots.js";
import { PaymentError, applyVerifiedPayment, createPaymentState, isRecord, verifyWebhook } from "../razorpay/payment-model.mjs";
import { RazorpayApiClient } from "../razorpay/api-client.mjs";
import { createCalendarEvent, refreshCalendarAccess, requireEventWriteScope } from "./google-oauth.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class BookingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.status = status;
  }
}

function fail(condition, code, message, status) {
  if (!condition) throw new BookingError(code, message, status);
}

function cleanText(value, code, label, max = 80) {
  fail(typeof value === "string", code, `${label} is required.`);
  const text = value.trim().replace(/\s+/g, " ");
  fail(text.length >= 2 && text.length <= max && !/[\r\n\0<>]/.test(text), code, `${label} is invalid.`);
  return text;
}

function cleanEmail(value) {
  fail(typeof value === "string", "invalid_email", "Email is required.");
  const email = value.trim().toLowerCase();
  fail(email.length <= 120 && EMAIL.test(email) && !/[\r\n\0]/.test(email), "invalid_email", "Email is invalid.");
  return email;
}

export function validateBookingIntent(input, services, now = new Date()) {
  fail(isRecord(input), "invalid_request", "Provide booking details.");
  fail(Object.keys(input).every((key) => ["serviceId", "date", "time", "customerName", "customerEmail"].includes(key)),
    "invalid_request", "Unexpected booking fields were supplied.");
  const service = services.find((item) => item.id === input.serviceId);
  fail(service, "invalid_service", "Choose a listed service.");
  let slot;
  try {
    slot = selectedSlot(input.date, input.time, service.durationMinutes, now);
  } catch {
    throw new BookingError("invalid_slot", "Choose an available future session time.");
  }
  return {
    service, date: input.date, time: input.time, slot,
    customerName: cleanText(input.customerName, "invalid_name", "Name"),
    customerEmail: cleanEmail(input.customerEmail),
  };
}

export class MemoryBookingStore {
  #records = new Map();

  async create(record) {
    fail(!this.#records.has(record.bookingId), "booking_conflict", "Booking identifier already exists.", 409);
    this.#records.set(record.bookingId, structuredClone(record));
  }

  async update(bookingId, patch) {
    const current = await this.get(bookingId);
    fail(current, "booking_not_found", "Booking was not found.", 404);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.#records.set(bookingId, structuredClone(next));
    return this.get(bookingId);
  }

  async get(bookingId) {
    const record = this.#records.get(bookingId);
    return record ? structuredClone(record) : null;
  }

  async getByOrder(orderId) {
    for (const record of this.#records.values()) if (record.order?.orderId === orderId) return structuredClone(record);
    return null;
  }

  async findConfirmedSlot({ date, time }) {
    for (const record of this.#records.values()) {
      if (record.date === date && record.time === time && ["confirmed", "paid_needs_manual_resolution"].includes(record.status)) {
        return structuredClone(record);
      }
    }
    return null;
  }
}

function firestoreFields(record) {
  return {
    bookingId: { stringValue: record.bookingId },
    orderId: { stringValue: record.order?.orderId || "" },
    date: { stringValue: record.date || "" },
    time: { stringValue: record.time || "" },
    status: { stringValue: record.status || "" },
    recordJson: { stringValue: JSON.stringify(record) },
    updatedAt: { timestampValue: new Date().toISOString() },
  };
}

function firestoreRecord(document) {
  if (!document?.fields?.recordJson?.stringValue) return null;
  return JSON.parse(document.fields.recordJson.stringValue);
}

export class FirestoreBookingStore {
  #projectId;
  #databaseId;
  #fetch;
  #token;

  constructor({ projectId, databaseId = "(default)", fetchImpl = globalThis.fetch } = {}) {
    fail(typeof projectId === "string" && /^[a-z][a-z0-9-]{4,62}$/.test(projectId),
      "invalid_store", "Configure a valid Google Cloud project ID for Firestore bookings.");
    fail(typeof databaseId === "string" && databaseId.length > 0 && !/[/?#]/.test(databaseId)
      && typeof fetchImpl === "function", "invalid_store", "Configure a valid Firestore database.");
    this.#projectId = projectId;
    this.#databaseId = databaseId;
    this.#fetch = fetchImpl;
  }

  async #accessToken() {
    if (this.#token && this.#token.expiresAt > Date.now()) return this.#token.value;
    const response = await this.#fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5000),
    });
    fail(response?.ok, "store_unavailable", "Could not authorize Firestore access.", 503);
    const body = await response.json();
    fail(typeof body.access_token === "string" && Number.isFinite(body.expires_in),
      "store_unavailable", "Firestore authorization returned an invalid token.", 503);
    this.#token = { value: body.access_token, expiresAt: Date.now() + Math.max(0, body.expires_in * 1000 - 60000) };
    return this.#token.value;
  }

  #base() {
    return `https://firestore.googleapis.com/v1/projects/${this.#projectId}/databases/${encodeURIComponent(this.#databaseId)}/documents/bookings`;
  }

  async #request(method, url, body) {
    const token = await this.#accessToken();
    const response = await this.#fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (response.status === 404) return null;
    fail(response?.ok, "store_unavailable", "Firestore booking storage is unavailable.", 503);
    return response.json();
  }

  async create(record) {
    await this.#request("PATCH", `${this.#base()}/${record.bookingId}?currentDocument.exists=false`, { fields: firestoreFields(record) });
  }

  async update(bookingId, patch) {
    const current = await this.get(bookingId);
    fail(current, "booking_not_found", "Booking was not found.", 404);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.#request("PATCH", `${this.#base()}/${bookingId}`, { fields: firestoreFields(next) });
    return next;
  }

  async get(bookingId) {
    fail(typeof bookingId === "string" && /^bk_[a-f0-9]{24}$/.test(bookingId), "invalid_booking_id", "Invalid booking ID.");
    return firestoreRecord(await this.#request("GET", `${this.#base()}/${bookingId}`));
  }

  async #query(field, value) {
    const rows = await this.#request("POST", `${this.#base().replace(/\/bookings$/, "")}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: "bookings" }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } },
        limit: 1,
      },
    });
    return Array.isArray(rows) ? firestoreRecord(rows.find((row) => row.document)?.document) : null;
  }

  async getByOrder(orderId) {
    return this.#query("orderId", orderId);
  }

  async findConfirmedSlot({ date, time }) {
    const rows = await this.#request("POST", `${this.#base().replace(/\/bookings$/, "")}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: "bookings" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: date } } },
              { fieldFilter: { field: { fieldPath: "time" }, op: "EQUAL", value: { stringValue: time } } },
            ],
          },
        },
        limit: 10,
      },
    });
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const record = firestoreRecord(row.document);
      if (record && ["confirmed", "paid_needs_manual_resolution"].includes(record.status)) return record;
    }
    return null;
  }
}

export function createRazorpayFromEnv(env, options = {}) {
  return new RazorpayApiClient({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    cardsEnabled: env.RAZORPAY_ENABLE_CARDS === "true",
    ...options,
  });
}

export function publicBooking(record) {
  return Object.freeze({
    bookingId: record.bookingId,
    status: record.status,
    serviceId: record.serviceId,
    date: record.date,
    time: record.time,
    customerEmail: record.customerEmail,
    ...(record.calendarEvent ? { calendarEvent: { eventLink: record.calendarEvent.eventLink } } : {}),
  });
}

export function createBookingService({
  availabilityService, razorpay, store = new MemoryBookingStore(), calendarConfig, savedAuthorization,
  fetchImpl = globalThis.fetch, now = () => new Date(),
} = {}) {
  fail(availabilityService && typeof availabilityService.getAvailability === "function",
    "invalid_configuration", "Availability service is required.");
  fail(razorpay && Array.isArray(razorpay.services), "invalid_configuration", "Razorpay client is required.");
  fail(store && typeof store.create === "function" && typeof store.update === "function"
    && typeof store.getByOrder === "function" && typeof store.findConfirmedSlot === "function",
  "invalid_configuration", "Booking store is required.");
  fail(calendarConfig && savedAuthorization, "invalid_configuration", "Calendar configuration is required.");
  const slotLocks = new Map();

  async function withSlotLock(key, task) {
    const previous = slotLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolveRelease) => { release = resolveRelease; });
    const chain = previous.then(() => current);
    slotLocks.set(key, chain);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (slotLocks.get(key) === chain) slotLocks.delete(key);
    }
  }

  async function confirmCaptured(record, payment) {
    if (!payment.captured) {
      return store.update(record.bookingId, {
        status: "payment_pending", payment: { ...record.payment, ...payment },
      });
    }
    return withSlotLock(`${record.date}|${record.time}`, async () => {
      const existing = await store.findConfirmedSlot(record);
      if (existing && existing.bookingId !== record.bookingId) {
        return store.update(record.bookingId, {
          status: "paid_needs_manual_resolution", payment: { ...record.payment, ...payment },
          resolutionReason: "slot_taken_after_payment",
        });
      }
      const fresh = await availabilityService.getAvailability({ serviceId: record.serviceId, date: record.date });
      if (!fresh.slots.some((slot) => slot.time === record.time)) {
        return store.update(record.bookingId, {
          status: "paid_needs_manual_resolution", payment: { ...record.payment, ...payment },
          resolutionReason: "calendar_busy_after_payment",
        });
      }
      requireEventWriteScope(savedAuthorization.scope);
      const tokens = await refreshCalendarAccess(calendarConfig, savedAuthorization, fetchImpl);
      requireEventWriteScope(tokens.scope);
      const calendarEvent = await createCalendarEvent(calendarConfig, tokens.access_token, {
        bookingId: record.bookingId, serviceName: record.serviceName,
        customerName: record.customerName, customerEmail: record.customerEmail,
        start: record.slot.start, end: record.slot.end,
      }, fetchImpl);
      return store.update(record.bookingId, {
        status: "confirmed", payment: { ...record.payment, ...payment }, calendarEvent,
        confirmedAt: now().toISOString(),
      });
    });
  }

  return {
    async createIntent(input) {
      const selection = validateBookingIntent(input, razorpay.services, now());
      const fresh = await availabilityService.getAvailability({ serviceId: selection.service.id, date: selection.date });
      fail(fresh.slots.some((slot) => slot.time === selection.time),
        "slot_unavailable", "That time is no longer available. Choose another slot.", 409);
      const bookingId = `bk_${randomBytes(12).toString("hex")}`;
      const order = await razorpay.createOrder({
        serviceId: selection.service.id, bookingId, receipt: `bk_${bookingId.slice(3, 27)}`,
      });
      const record = {
        bookingId, status: "payment_created", createdAt: now().toISOString(), updatedAt: now().toISOString(),
        serviceId: selection.service.id, serviceName: selection.service.name,
        date: selection.date, time: selection.time, slot: selection.slot,
        customerName: selection.customerName, customerEmail: selection.customerEmail,
        order, payment: createPaymentState(order),
      };
      await store.create(record);
      return {
        booking: publicBooking(record),
        checkout: razorpay.checkoutOptions(order, {
          customerName: record.customerName, customerEmail: record.customerEmail,
        }),
      };
    },

    async confirmCheckout(callback) {
      fail(isRecord(callback), "invalid_request", "Payment callback is required.");
      const record = await store.getByOrder(callback.razorpay_order_id);
      fail(record, "booking_not_found", "Booking was not found for this payment.", 404);
      if (record.status === "confirmed") return publicBooking(record);
      const payment = await razorpay.verifyCheckout(record.order, callback);
      const updated = await confirmCaptured(record, payment);
      return publicBooking(updated);
    },

    async reconcileWebhook(verified) {
      if (verified.action === "ignore") return { action: "ignored" };
      const record = await store.getByOrder(verified.payment.orderId);
      if (!record) return { action: "unknown_order" };
      const payment = await razorpay.reconcilePayment(record.order, verified.payment.paymentId);
      const state = applyVerifiedPayment(record.payment, payment);
      const updated = await confirmCaptured({ ...record, payment: state }, payment);
      return { action: "reconciled", booking: publicBooking(updated) };
    },
  };
}

export function verifyRazorpayWebhookFromEnv(env, rawBody, headers) {
  const secrets = [env.RAZORPAY_WEBHOOK_SECRET, env.RAZORPAY_OLD_WEBHOOK_SECRET].filter(Boolean);
  return verifyWebhook({
    rawBody,
    signature: headers["x-razorpay-signature"],
    eventId: headers["x-razorpay-event-id"],
    secrets,
    expectedAccountId: env.RAZORPAY_ACCOUNT_ID || undefined,
  });
}
