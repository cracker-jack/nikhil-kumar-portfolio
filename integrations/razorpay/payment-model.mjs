import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SERVICES = Object.freeze([
  Object.freeze({ id: "mentorship", name: "Mentorship", durationMinutes: 30 }),
  Object.freeze({ id: "resume-review", name: "Resume review", durationMinutes: 30 }),
  Object.freeze({ id: "hld-mock", name: "HLD mock interview", durationMinutes: 60 }),
  Object.freeze({ id: "lld-mock", name: "LLD mock interview", durationMinutes: 60 }),
  Object.freeze({ id: "dsa-mock", name: "DSA mock interview", durationMinutes: 60 }),
]);

export const APPROVED_PRICES_PAISE = Object.freeze({
  mentorship: 49900,
  "resume-review": 39900,
  "hld-mock": 99900,
  "lld-mock": 99900,
  "dsa-mock": 69900,
});

export class PaymentError extends Error {
  constructor(code, message, { status, reconciliationRequired = false } = {}) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
    this.status = status;
    this.reconciliationRequired = reconciliationRequired;
  }
}

export function requireValue(condition, code, message) {
  if (!condition) throw new PaymentError(code, message);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validId(value, prefix) {
  return typeof value === "string" && value === value.trim()
    && new RegExp(`^${prefix}_[a-zA-Z0-9]{1,64}$`).test(value);
}

export function validAmount(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

export function createPriceBook(pricesPaise) {
  requireValue(isRecord(pricesPaise), "MISSING_PRICES", "Provide explicit server-side prices in INR paise.");
  const ids = new Set(SERVICES.map((service) => service.id));
  requireValue(Object.keys(pricesPaise).every((id) => ids.has(id)), "INVALID_SERVICE", "The price book contains an unknown service.");
  return Object.freeze(SERVICES.map((service) => {
    const amountPaise = pricesPaise[service.id];
    requireValue(Object.hasOwn(pricesPaise, service.id) && validAmount(amountPaise, 100),
      "INVALID_PRICE", `Configure an integer price of at least 100 paise for ${service.id}.`);
    return Object.freeze({ ...service, amountPaise, currency: "INR" });
  }));
}

export function validateOrderSnapshot(order) {
  requireValue(isRecord(order) && order.mode === "test" && validId(order.orderId, "order")
    && SERVICES.some((service) => service.id === order.serviceId)
    && validAmount(order.amountPaise, 100) && order.currency === "INR"
    && typeof order.receipt === "string" && order.receipt.length > 0 && order.receipt.length <= 40,
  "INVALID_ORDER", "A trusted, persisted Test Mode order snapshot is required.");
}

export function buildCheckoutDisplay({ mode = "test", cardsEnabled = false } = {}) {
  requireValue(["test", "live"].includes(mode) && typeof cardsEnabled === "boolean",
    "INVALID_CONFIGURATION", "Specify a valid checkout mode and an explicit card flag.");
  const upi = mode === "live" ? { method: "upi", flows: ["intent", "qr"] } : { method: "upi" };
  const blocks = { upi: { name: "Pay via UPI", instruments: [upi] } };
  const sequence = ["block.upi"];
  if (cardsEnabled) {
    blocks.cards = { name: "Pay via card", instruments: [{ method: "card" }] };
    sequence.push("block.cards");
  }
  return { display: { blocks, sequence, preferences: { show_default_blocks: false } } };
}

export function verifyHmac(body, signature, secret) {
  requireValue(typeof secret === "string" && secret.trim().length > 0,
    "MISSING_SECRET", "A signing secret must be configured on the server.");
  if (typeof signature !== "string" || signature.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function normalizePayment(payment) {
  requireValue(isRecord(payment) && payment.entity === "payment"
    && validId(payment.id, "pay") && validId(payment.order_id, "order")
    && validAmount(payment.amount, 100) && payment.currency === "INR"
    && ["created", "authorized", "captured", "failed", "refunded"].includes(payment.status)
    && typeof payment.captured === "boolean"
    && validAmount(payment.amount_refunded) && payment.amount_refunded <= payment.amount
    && typeof payment.method === "string" && payment.method.length > 0,
  "INVALID_PAYMENT", "Razorpay returned an invalid payment entity.");
  const captured = ["captured", "refunded"].includes(payment.status);
  requireValue(!captured || payment.captured, "INCONSISTENT_CAPTURE", "The payment capture fields disagree.");
  requireValue(payment.amount_refunded === 0 || captured,
    "INCONSISTENT_REFUND", "Refunded funds require a captured payment.");
  requireValue(payment.status !== "refunded" || payment.amount_refunded === payment.amount,
    "INCONSISTENT_REFUND", "The full-refund status does not match the refunded amount.");
  return Object.freeze({
    paymentId: payment.id,
    orderId: payment.order_id,
    amountPaise: payment.amount,
    currency: payment.currency,
    method: payment.method,
    status: payment.status,
    captured,
    refundedPaise: payment.amount_refunded,
  });
}

export function createPaymentState(order) {
  validateOrderSnapshot(order);
  return Object.freeze({
    mode: "test", orderId: order.orderId, amountPaise: order.amountPaise, currency: order.currency,
    paymentId: null, status: "created", captured: false, refundedPaise: 0,
  });
}

// Call only with a server-verified API or signed-webhook snapshot, never browser JSON.
export function applyVerifiedPayment(current, payment, { cardsEnabled = false } = {}) {
  requireValue(typeof cardsEnabled === "boolean", "INVALID_CONFIGURATION", "Provide an explicit card flag.");
  requireValue(isRecord(current) && current.mode === "test" && isRecord(payment)
    && validId(current.orderId, "order") && validAmount(current.amountPaise, 100) && current.currency === "INR"
    && ["created", "authorized", "failed", "captured", "partially_refunded", "refunded"].includes(current.status)
    && payment.orderId === current.orderId && payment.amountPaise === current.amountPaise
    && payment.currency === current.currency && validId(payment.paymentId, "pay")
    && ["created", "authorized", "captured", "failed", "refunded"].includes(payment.status)
    && typeof payment.captured === "boolean" && typeof current.captured === "boolean"
    && validAmount(current.refundedPaise) && current.refundedPaise <= current.amountPaise
    && validAmount(payment.refundedPaise) && payment.refundedPaise <= current.amountPaise,
  "PAYMENT_MISMATCH", "The verified payment does not match the stored order.");
  requireValue(!current.captured || validId(current.paymentId, "pay"),
    "INVALID_PAYMENT_STATE", "A captured state must retain its payment identifier.");
  requireValue(current.captured === ["captured", "partially_refunded", "refunded"].includes(current.status)
    && (current.refundedPaise === 0 || current.captured)
    && (current.status !== "refunded" || current.refundedPaise === current.amountPaise)
    && (current.status !== "partially_refunded" || (current.refundedPaise > 0 && current.refundedPaise < current.amountPaise))
    && (current.status !== "captured" || current.refundedPaise === 0),
  "INVALID_PAYMENT_STATE", "The stored payment and refund states disagree.");
  requireValue(payment.captured === ["captured", "refunded"].includes(payment.status)
    && (payment.refundedPaise === 0 || payment.captured)
    && (payment.status !== "refunded" || payment.refundedPaise === current.amountPaise),
    "INVALID_PAYMENT_STATE", "A refunded snapshot must be captured.");
  if (current.captured && current.paymentId !== payment.paymentId) {
    requireValue(!payment.captured, "MULTIPLE_CAPTURES", "Different captured payments require manual reconciliation.");
    return current;
  }
  requireValue(payment.method === "upi" || (cardsEnabled && payment.method === "card"),
    "METHOD_NOT_ENABLED", "An unexpected payment method requires manual reconciliation.");
  const captured = current.captured || payment.captured;
  const refundedPaise = Math.max(current.refundedPaise, payment.refundedPaise);
  const status = captured
    ? refundedPaise === current.amountPaise ? "refunded" : refundedPaise > 0 ? "partially_refunded" : "captured"
    : payment.status;
  return Object.freeze({
    ...current, paymentId: payment.paymentId, status, captured, refundedPaise,
  });
}

const SUPPORTED_EVENTS = new Set([
  "payment.authorized", "payment.captured", "payment.failed", "order.paid",
  "refund.created", "refund.processed", "refund.failed",
]);

export function verifyWebhook({ rawBody, signature, eventId, secrets, expectedAccountId }) {
  requireValue(Buffer.isBuffer(rawBody) && rawBody.length > 0 && rawBody.length <= 256 * 1024,
    "INVALID_WEBHOOK_BODY", "Supply the exact raw request bytes, up to 256 KiB.");
  requireValue(Array.isArray(secrets) && secrets.length > 0
    && secrets.every((secret) => typeof secret === "string" && secret.trim().length > 0),
  "MISSING_SECRET", "Configure the current webhook secret and any retained rotation secrets.");
  requireValue(secrets.map((secret) => verifyHmac(rawBody, signature, secret)).some(Boolean),
    "INVALID_SIGNATURE", "The webhook signature is invalid.");
  requireValue(typeof eventId === "string" && eventId === eventId.trim() && /^[a-zA-Z0-9_-]{1,128}$/.test(eventId),
    "INVALID_EVENT_ID", "A valid x-razorpay-event-id header is required.");
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new PaymentError("INVALID_WEBHOOK_JSON", "The signed webhook body is not valid JSON.");
  }
  requireValue(isRecord(body) && body.entity === "event" && typeof body.event === "string"
    && validId(body.account_id, "acc") && validAmount(body.created_at, 1),
  "INVALID_WEBHOOK", "The signed webhook envelope is invalid.");
  if (expectedAccountId !== undefined) {
    requireValue(validId(expectedAccountId, "acc"), "INVALID_CONFIGURATION", "Configure a valid merchant account ID.");
    requireValue(body.account_id === expectedAccountId, "ACCOUNT_MISMATCH", "The webhook belongs to a different merchant.");
  }
  const metadata = {
    eventId, payloadHash: createHash("sha256").update(rawBody).digest("hex"),
    event: body.event, accountId: body.account_id, occurredAt: body.created_at,
  };
  if (!SUPPORTED_EVENTS.has(body.event)) {
    return Object.freeze({ ...metadata, action: "ignore", reason: "UNSUBSCRIBED_EVENT" });
  }
  const payment = normalizePayment(body.payload?.payment?.entity);
  if (body.event.startsWith("payment.")) {
    requireValue(body.event === `payment.${payment.status}`,
      "EVENT_MISMATCH", "The webhook event and payment status disagree.");
  }
  if (body.event === "order.paid") {
    const order = body.payload?.order?.entity;
    requireValue(isRecord(order) && order.entity === "order" && order.id === payment.orderId
      && order.amount === payment.amountPaise && order.currency === payment.currency
      && order.status === "paid" && order.amount_paid === payment.amountPaise && order.amount_due === 0
      && payment.captured,
    "ORDER_MISMATCH", "The paid-order event does not match its captured payment.");
  }
  let refund;
  if (body.event.startsWith("refund.")) {
    const entity = body.payload?.refund?.entity;
    requireValue(isRecord(entity) && entity.entity === "refund" && validId(entity.id, "rfnd")
      && entity.payment_id === payment.paymentId && entity.currency === payment.currency
      && validAmount(entity.amount, 1) && entity.amount <= payment.amountPaise
      && ["pending", "processed", "failed"].includes(entity.status),
    "REFUND_MISMATCH", "The refund does not match its payment.");
    requireValue(body.event === "refund.created" || body.event === `refund.${entity.status}`,
      "EVENT_MISMATCH", "The webhook event and refund status disagree.");
    refund = Object.freeze({
      refundId: entity.id, paymentId: entity.payment_id, amountPaise: entity.amount, status: entity.status,
    });
  }
  return Object.freeze({ ...metadata, action: "reconcile", payment, ...(refund ? { refund } : {}) });
}
