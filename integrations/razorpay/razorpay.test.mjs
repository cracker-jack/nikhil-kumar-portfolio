import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  APPROVED_PRICES_PAISE, SERVICES, PaymentError, applyVerifiedPayment, buildCheckoutDisplay, createPaymentState,
  createPriceBook, normalizePayment, validId, verifyHmac, verifyWebhook,
} from "./payment-model.mjs";
import { RazorpayTestClient } from "./test-client.mjs";

// Fictional, offline fixtures; these are not account credentials or approved service prices.
const TEST_KEY = "rzp_test_OfflineFixture";
const TEST_SECRET = "offline-test-secret";
const WEBHOOK_SECRET = "offline-webhook-secret";
const PRICES = Object.fromEntries(SERVICES.map((service) => [service.id, 10000]));
const STORED = Object.freeze({
  mode: "test", orderId: "order_OfflineFixture", serviceId: "mentorship",
  amountPaise: 10000, currency: "INR", receipt: "offline-receipt",
});
const sign = (body, secret) => createHmac("sha256", secret).update(body).digest("hex");
const isError = (code) => (error) => error instanceof PaymentError && error.code === code;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function providerOrder(overrides = {}) {
  return {
    entity: "order", id: STORED.orderId, amount: 10000, currency: "INR",
    receipt: STORED.receipt, notes: { service_id: "mentorship" },
    status: "paid", amount_paid: 10000, amount_due: 0, ...overrides,
  };
}

function providerPayment(overrides = {}) {
  return {
    entity: "payment", id: "pay_OfflineFixture", order_id: STORED.orderId,
    amount: 10000, currency: "INR", method: "upi", status: "captured", captured: true,
    amount_refunded: 0, email: "private@example.invalid", vpa: "private@invalid",
    notes: { private: "not-for-public-output" }, ...overrides,
  };
}

function callback(overrides = {}) {
  return {
    razorpay_order_id: STORED.orderId, razorpay_payment_id: "pay_OfflineFixture",
    razorpay_signature: sign(`${STORED.orderId}|pay_OfflineFixture`, TEST_SECRET),
    ...overrides,
  };
}

function client(fetchImpl, overrides = {}) {
  assert.equal(typeof fetchImpl, "function", "Every test must explicitly replace network transport.");
  return new RazorpayTestClient({
    keyId: TEST_KEY, keySecret: TEST_SECRET, pricesPaise: PRICES, fetchImpl, ...overrides,
  });
}

function reader(payment = providerPayment(), order = providerOrder()) {
  return async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new URL(url).origin, "https://api.razorpay.com");
    if (url.endsWith(`/payments/${payment.id}`)) return json(payment);
    if (url.endsWith(`/orders/${STORED.orderId}`)) return json(order);
    assert.fail(`Unexpected provider path: ${url}`);
  };
}

function webhookBody(event = "payment.captured", payment = providerPayment(), extra = {}) {
  return {
    entity: "event", account_id: "acc_OfflineFixture", event, created_at: 1770000000,
    payload: { payment: { entity: payment }, ...extra },
  };
}

function webhook(body = webhookBody(), overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return verifyWebhook({
    rawBody, signature: sign(rawBody, WEBHOOK_SECRET), eventId: "event-offline",
    secrets: [WEBHOOK_SECRET], expectedAccountId: "acc_OfflineFixture", ...overrides,
  });
}

test("all five durations are confirmed and prices are explicit immutable paise values", () => {
  assert.deepEqual(SERVICES.map(({ id, durationMinutes }) => [id, durationMinutes]), [
    ["mentorship", 30], ["resume-review", 30], ["hld-mock", 60], ["lld-mock", 60], ["dsa-mock", 60],
  ]);
  const input = { ...PRICES };
  const book = createPriceBook(input);
  input.mentorship = 500;
  assert.equal(book[0].amountPaise, 10000);
  assert.throws(() => { book[0].amountPaise = 1; }, TypeError);
  assert.throws(() => book.push({}), TypeError);
});

test("the default catalog contains all five approved prices and unchanged durations", () => {
  const api = new RazorpayTestClient({
    keyId: TEST_KEY, keySecret: TEST_SECRET,
    fetchImpl: () => assert.fail("Reading the catalog must not contact Razorpay."),
  });
  assert.deepEqual(api.services.map(({ id, amountPaise, durationMinutes }) => [id, amountPaise, durationMinutes]), [
    ["mentorship", 49900, 30],
    ["resume-review", 39900, 30],
    ["hld-mock", 99900, 60],
    ["lld-mock", 99900, 60],
    ["dsa-mock", 69900, 60],
  ]);
  assert.deepEqual(Object.keys(APPROVED_PRICES_PAISE).sort(), SERVICES.map(({ id }) => id).sort());
  assert.ok(Object.isFrozen(APPROVED_PRICES_PAISE));
  assert.throws(() => { APPROVED_PRICES_PAISE.mentorship = 1; }, TypeError);
});

test("approved amounts flow unchanged through order creation, checkout and capture verification for every service", async () => {
  for (const [serviceId, amount] of [
    ["mentorship", 49900], ["resume-review", 39900], ["hld-mock", 99900],
    ["lld-mock", 99900], ["dsa-mock", 69900],
  ]) {
    const receipt = `approved-${serviceId}`;
    const paidOrder = providerOrder({
      amount, amount_paid: amount, receipt, notes: { service_id: serviceId },
    });
    const read = reader(providerPayment({ amount }), paidOrder);
    let calls = 0;
    const api = new RazorpayTestClient({
      keyId: TEST_KEY, keySecret: TEST_SECRET,
      fetchImpl: async (url, options) => {
        calls++;
        if (options.method !== "POST") return read(url, options);
        assert.equal(url, "https://api.razorpay.com/v1/orders");
        assert.deepEqual(JSON.parse(options.body), {
          amount, currency: "INR", receipt, partial_payment: false, notes: { service_id: serviceId },
        });
        return json({ ...paidOrder, status: "created", amount_paid: 0, amount_due: amount });
      },
    });
    const stored = await api.createOrder({ serviceId, receipt, amount: 1, currency: "USD" });
    const options = api.checkoutOptions(stored);
    assert.equal(stored.amountPaise, amount);
    assert.equal(stored.serviceId, serviceId);
    assert.equal(options.amount, amount);
    assert.equal(options.currency, "INR");
    const payment = await api.verifyCheckout(stored, callback());
    assert.equal(payment.amountPaise, amount);
    assert.equal(applyVerifiedPayment(createPaymentState(stored), payment).status, "captured");
    assert.equal(calls, 3);
  }
});

test("invalid explicit price overrides are rejected rather than replaced by approved defaults", () => {
  const unused = () => assert.fail("Invalid configuration must not perform I/O.");
  assert.throws(() => client(unused, { pricesPaise: null }), isError("MISSING_PRICES"));
  assert.throws(() => client(unused, { pricesPaise: {} }), isError("INVALID_PRICE"));
  assert.throws(() => client(unused, { pricesPaise: { mentorship: 49900 } }), isError("INVALID_PRICE"));
  assert.throws(() => client(unused, { pricesPaise: { ...APPROVED_PRICES_PAISE, mentorship: "49900" } }),
    isError("INVALID_PRICE"));
});

test("missing, inherited, unknown, fractional, nonnumeric and unsafe prices fail closed", () => {
  for (const input of [undefined, null, []]) {
    assert.throws(() => createPriceBook(input), isError("MISSING_PRICES"));
  }
  for (const price of [undefined, null, "", "10000", 0, -1, 99, 100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createPriceBook({ ...PRICES, mentorship: price }), isError("INVALID_PRICE"));
  }
  assert.throws(() => createPriceBook(Object.create(PRICES)), isError("INVALID_PRICE"));
  assert.throws(() => createPriceBook({ ...PRICES, invented: 10000 }), isError("INVALID_SERVICE"));
  assert.equal(createPriceBook({ ...PRICES, mentorship: 100 })[0].amountPaise, 100);
});

test("live, missing and malformed keys are rejected without network access", () => {
  const unused = () => assert.fail("Configuration validation must precede I/O.");
  assert.throws(() => new RazorpayTestClient(), isError("TEST_KEYS_REQUIRED"));
  for (const keyId of [undefined, "", "rzp_live_OfflineFixture", `${TEST_KEY}\n`, "rzp_test_../live"]) {
    assert.throws(() => client(unused, { keyId }), isError("TEST_KEYS_REQUIRED"));
  }
  for (const keySecret of [undefined, "", " ", " trailing "]) {
    assert.throws(() => client(unused, { keySecret }), isError("MISSING_SECRET"));
  }
  for (const timeoutMs of [0, -1, 30001, Infinity, 0.5]) {
    assert.throws(() => client(unused, { timeoutMs }), isError("INVALID_CONFIGURATION"));
  }
  assert.throws(() => client(unused, { cardsEnabled: "false" }), isError("INVALID_CONFIGURATION"));
});

test("order creation uses server price, stable receipt and no partial payments", async () => {
  let calls = 0;
  const api = client(async (url, options) => {
    calls++;
    assert.equal(url, "https://api.razorpay.com/v1/orders");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${TEST_KEY}:${TEST_SECRET}`).toString("base64")}`);
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      amount: 10000, currency: "INR", receipt: STORED.receipt,
      partial_payment: false, notes: { service_id: "mentorship" },
    });
    return json(providerOrder({ status: "created", amount_paid: 0, amount_due: 10000 }));
  });
  const result = await api.createOrder({ serviceId: "mentorship", receipt: STORED.receipt, amount: 1 });
  assert.deepEqual(result, STORED);
  assert.ok(Object.isFrozen(result));
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(api), "{}");
});

test("invalid services and receipts do not create provider orders", async () => {
  const api = client(() => assert.fail("Invalid order input must not reach Razorpay."));
  await assert.rejects(api.createOrder({ serviceId: "invented", receipt: "valid" }), isError("INVALID_SERVICE"));
  for (const receipt of [undefined, "", "x".repeat(41), "line\nbreak"]) {
    await assert.rejects(api.createOrder({ serviceId: "mentorship", receipt }), isError("INVALID_RECEIPT"));
  }
});

test("mismatched order creation is rejected and marked for reconciliation", async () => {
  for (const overrides of [
    { amount: 1 }, { id: "order_../invalid" }, { receipt: "other" },
    { currency: "USD" }, { notes: { service_id: "dsa-mock" } },
    { status: "paid", amount_paid: 10000, amount_due: 0 },
  ]) {
    const api = client(async () => json(providerOrder({ status: "created", amount_paid: 0, amount_due: 10000, ...overrides })));
    await assert.rejects(api.createOrder({ serviceId: "mentorship", receipt: STORED.receipt }),
      (error) => error instanceof PaymentError && error.reconciliationRequired);
  }
});

test("public checkout options exclude secrets, use saved pricing and default to UPI", () => {
  const api = client(() => assert.fail("Building public options needs no network."), {
    pricesPaise: { ...PRICES, mentorship: 20000 },
  });
  const options = api.checkoutOptions(STORED);
  assert.equal(options.amount, 10000, "An existing order retains its original price snapshot.");
  assert.equal(options.key, TEST_KEY);
  assert.match(options.description, /test payment; no booking created/);
  assert.ok(!JSON.stringify(options).includes(TEST_SECRET));
  assert.deepEqual(options.config.display.sequence, ["block.upi"]);
  assert.equal(options.config.display.preferences.show_default_blocks, false);
  assert.deepEqual(options.config.display.blocks.upi.instruments, [{ method: "upi" }]);
  assert.equal(api.checkoutOptions({ ...STORED, mode: "live" }).order_id, STORED.orderId);
});

test("live-display configuration excludes Collect even inside explicitly added blocks", () => {
  const upiOnly = buildCheckoutDisplay({ mode: "live" });
  assert.deepEqual(upiOnly.display.blocks.upi.instruments, [{ method: "upi", flows: ["intent", "qr"] }]);
  assert.ok(!JSON.stringify(upiOnly).includes("collect"));
  const withCards = buildCheckoutDisplay({ mode: "test", cardsEnabled: true });
  assert.deepEqual(withCards.display.sequence, ["block.upi", "block.cards"]);
  assert.deepEqual(withCards.display.blocks.cards.instruments, [{ method: "card" }]);
  assert.throws(() => buildCheckoutDisplay({ mode: "production" }), isError("INVALID_CONFIGURATION"));
});

test("HMAC checks exact bytes, fixed signature length and secret without throwing on malformed signatures", () => {
  const body = Buffer.from("exact signed bytes");
  const signature = sign(body, TEST_SECRET);
  assert.equal(verifyHmac(body, signature.toUpperCase(), TEST_SECRET), true);
  for (const invalid of [null, 123, "", "a", "g".repeat(64), `${signature}\n`, "0".repeat(64)]) {
    assert.equal(verifyHmac(body, invalid, TEST_SECRET), false);
  }
  assert.equal(verifyHmac(Buffer.from("different"), signature, TEST_SECRET), false);
  assert.equal(verifyHmac(body, signature, "different"), false);
  assert.throws(() => verifyHmac(body, signature, ""), isError("MISSING_SECRET"));
  assert.equal(validId("pay_valid\n", "pay"), false);
  assert.equal(validId("pay_../../orders", "pay"), false);
});

test("a verified callback must match the trusted stored ID before any provider reads", async () => {
  const api = client(() => assert.fail("An invalid callback must not perform I/O."));
  await assert.rejects(api.verifyCheckout(STORED, null), isError("CALLBACK_MISMATCH"));
  await assert.rejects(api.verifyCheckout(STORED, callback({
    razorpay_order_id: "order_Attacker",
    razorpay_signature: sign("order_Attacker|pay_OfflineFixture", TEST_SECRET),
  })), isError("CALLBACK_MISMATCH"));
  await assert.rejects(api.verifyCheckout(STORED, callback({ razorpay_payment_id: "pay_X/../orders" })), isError("CALLBACK_MISMATCH"));
  await assert.rejects(api.verifyCheckout(STORED, callback({ razorpay_signature: "0".repeat(64) })), isError("INVALID_SIGNATURE"));
});

test("valid signature plus matching paid order and captured payment yields a normalized snapshot", async () => {
  const result = await client(reader()).verifyCheckout(STORED, callback({ amount: 1, status: "failed" }));
  assert.equal(result.captured, true);
  assert.equal(result.amountPaise, STORED.amountPaise);
  assert.equal(result.refundedPaise, 0);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!Object.hasOwn(result, "bookingConfirmed"));
});

test("authorized payment is not captured or a confirmed booking", async () => {
  const result = await client(reader(
    providerPayment({ status: "authorized", captured: false }),
    providerOrder({ status: "attempted", amount_paid: 0, amount_due: 10000 }),
  )).verifyCheckout(STORED, callback());
  assert.equal(result.captured, false);
  assert.equal(result.status, "authorized");
  assert.equal(applyVerifiedPayment(createPaymentState(STORED), result).status, "authorized");
});

test("provider amount, currency, payment ID and order bindings are independently checked", async () => {
  for (const overrides of [{ amount: 9999 }, { currency: "USD" }, { order_id: "order_Other" }]) {
    await assert.rejects(client(reader(providerPayment(overrides))).verifyCheckout(STORED, callback()), PaymentError);
  }
  await assert.rejects(client(async (url) => json(url.includes("/payments/")
    ? providerPayment({ id: "pay_Other" }) : providerOrder())).verifyCheckout(STORED, callback()), isError("PAYMENT_MISMATCH"));
  for (const overrides of [
    { amount: 9999 }, { currency: "USD" }, { receipt: "other" },
    { notes: { service_id: "resume-review" } }, { amount_due: 1 },
    { id: "order_Other" }, { amount_paid: -1, amount_due: 10001 },
  ]) {
    await assert.rejects(client(reader(providerPayment(), providerOrder(overrides))).verifyCheckout(STORED, callback()),
      isError("ORDER_MISMATCH"));
  }
});

test("capture requires matching paid order and a consistent captured flag", async () => {
  await assert.rejects(client(reader(providerPayment(), providerOrder({
    status: "attempted", amount_paid: 0, amount_due: 10000,
  }))).verifyCheckout(STORED, callback()), isError("INCONSISTENT_CAPTURE"));
  await assert.rejects(client(reader(providerPayment({ captured: false }))).verifyCheckout(STORED, callback()),
    isError("INCONSISTENT_CAPTURE"));
});

test("cards are rejected unless explicitly enabled; unrelated methods remain disabled", async () => {
  await assert.rejects(client(reader(providerPayment({ method: "card" }))).verifyCheckout(STORED, callback()),
    isError("METHOD_NOT_ENABLED"));
  const enabled = client(reader(providerPayment({ method: "card" })), { cardsEnabled: true });
  assert.equal((await enabled.verifyCheckout(STORED, callback())).method, "card");
  await assert.rejects(client(reader(providerPayment({ method: "wallet" })), { cardsEnabled: true })
    .verifyCheckout(STORED, callback()), isError("METHOD_NOT_ENABLED"));
});

test("signed webhooks cannot bypass the reducer's UPI-only payment-method policy", () => {
  const initial = createPaymentState(STORED);
  const card = webhook(webhookBody("payment.captured", providerPayment({ method: "card" }))).payment;
  assert.throws(() => applyVerifiedPayment(initial, card), isError("METHOD_NOT_ENABLED"));
  assert.equal(applyVerifiedPayment(initial, card, { cardsEnabled: true }).status, "captured");
  const wallet = normalizePayment(providerPayment({ method: "wallet" }));
  assert.throws(() => applyVerifiedPayment(initial, wallet, { cardsEnabled: true }), isError("METHOD_NOT_ENABLED"));
  assert.throws(() => applyVerifiedPayment(initial, card, { cardsEnabled: "true" }), isError("INVALID_CONFIGURATION"));
});

test("paid order does not hide partial or complete refunds", async () => {
  for (const [amount_refunded, status, expected] of [
    [2500, "captured", "partially_refunded"], [10000, "refunded", "refunded"],
  ]) {
    const result = await client(reader(providerPayment({ amount_refunded, status }))).verifyCheckout(STORED, callback());
    assert.equal(applyVerifiedPayment(createPaymentState(STORED), result).status, expected);
  }
});

test("webhook reconciliation detects current refunds even after a historical capture and missing browser callback", async () => {
  const oldEvent = webhook();
  assert.equal(oldEvent.payment.refundedPaise, 0);
  const api = client(reader(providerPayment({ amount_refunded: 10000, status: "refunded" })));
  const current = await api.reconcilePayment(STORED, oldEvent.payment.paymentId);
  assert.equal(applyVerifiedPayment(createPaymentState(STORED), current).status, "refunded");
  await assert.rejects(api.reconcilePayment(STORED, "pay_../invalid"), isError("INVALID_PAYMENT_ID"));
});

test("provider read failures cannot return a successful payment snapshot", async () => {
  const api = client(async () => json({}, 503));
  await assert.rejects(api.reconcilePayment(STORED, "pay_OfflineFixture"),
    (error) => error.code === "PROVIDER_HTTP_ERROR" && error.reconciliationRequired === false);
});

test("network, timeout, HTTP and malformed-response errors never retry order creation", async () => {
  const failures = [
    [() => { throw new TypeError("network"); }, "PROVIDER_NETWORK_ERROR", true],
    [() => { throw new DOMException("timeout", "TimeoutError"); }, "PROVIDER_TIMEOUT", true],
    [() => json({ error: { description: "do-not-expose-provider-details" } }, 401), "PROVIDER_HTTP_ERROR", false],
    [() => json({}, 503), "PROVIDER_HTTP_ERROR", true],
    [() => new Response("{not-json"), "INVALID_PROVIDER_JSON", true],
    [() => json([]), "INVALID_PROVIDER_RESPONSE", true],
    [() => undefined, "INVALID_PROVIDER_RESPONSE", true],
  ];
  for (const [respond, code, reconciliationRequired] of failures) {
    let calls = 0;
    const api = client(async () => { calls++; return respond(); });
    await assert.rejects(api.createOrder({ serviceId: "mentorship", receipt: STORED.receipt }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.reconciliationRequired, reconciliationRequired);
      assert.ok(!error.message.includes(TEST_SECRET));
      assert.ok(!error.message.includes("do-not-expose-provider-details"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("invalid payment entities and inconsistent refund counters are rejected", () => {
  for (const changes of [
    { entity: "order" }, { id: "../pay" }, { amount: 0 }, { amount: 0.5 }, { currency: "USD" },
    { status: "unknown" }, { captured: "true" }, { amount_refunded: -1 }, { amount_refunded: 10001 },
    { method: "" }, { amount_refunded: 500, status: "authorized", captured: false },
    { status: "refunded", amount_refunded: 0 },
  ]) assert.throws(() => normalizePayment(providerPayment(changes)), PaymentError);
});

test("webhook authenticity uses raw bytes, rotating secrets and expected account", () => {
  const body = webhookBody();
  const result = webhook(body);
  assert.equal(result.action, "reconcile");
  assert.equal(result.eventId, "event-offline");
  assert.match(result.payloadHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(webhook(body, { secrets: ["new-secret", WEBHOOK_SECRET] }).action, "reconcile");
  assert.throws(() => webhook(body, { secrets: ["new-secret"] }), isError("INVALID_SIGNATURE"));
  assert.throws(() => webhook(body, { rawBody: Buffer.from(JSON.stringify(body, null, 2)) }), isError("INVALID_SIGNATURE"));
  assert.throws(() => webhook(body, { rawBody: JSON.stringify(body) }), isError("INVALID_WEBHOOK_BODY"));
  assert.throws(() => webhook(body, { expectedAccountId: "acc_Other" }), isError("ACCOUNT_MISMATCH"));
  assert.throws(() => webhook(body, { expectedAccountId: "" }), isError("INVALID_CONFIGURATION"));
});

test("webhook rejects invalid signatures before parsing and validates event metadata", () => {
  const invalidJson = Buffer.from("{");
  assert.throws(() => webhook(undefined, { rawBody: invalidJson, signature: "0".repeat(64) }), isError("INVALID_SIGNATURE"));
  assert.throws(() => webhook(undefined, { rawBody: invalidJson, signature: sign(invalidJson, WEBHOOK_SECRET) }),
    isError("INVALID_WEBHOOK_JSON"));
  for (const eventId of [undefined, "", "contains spaces", "x".repeat(129), "event\n"]) {
    assert.throws(() => webhook(undefined, { eventId }), isError("INVALID_EVENT_ID"));
  }
  assert.throws(() => webhook(undefined, { rawBody: Buffer.alloc(256 * 1024 + 1) }), isError("INVALID_WEBHOOK_BODY"));
  assert.throws(() => webhook(undefined, { secrets: [] }), isError("MISSING_SECRET"));
  assert.throws(() => webhook({ ...webhookBody(), account_id: "unknown" }), isError("INVALID_WEBHOOK"));
  assert.throws(() => webhook({ ...webhookBody(), created_at: -1 }), isError("INVALID_WEBHOOK"));
});

test("unsubscribed signed webhook has an explicit ignore result, not a payment confirmation", () => {
  const event = webhook(webhookBody("settlement.processed"));
  assert.equal(event.action, "ignore");
  assert.equal(event.reason, "UNSUBSCRIBED_EVENT");
  assert.ok(!Object.hasOwn(event, "payment"));
});

test("order.paid requires consistent order and payment entities", () => {
  assert.equal(webhook(webhookBody("order.paid", providerPayment(), {
    order: { entity: providerOrder() },
  })).payment.captured, true);
  assert.throws(() => webhook(webhookBody("order.paid")), isError("ORDER_MISMATCH"));
  assert.throws(() => webhook(webhookBody("order.paid", providerPayment(), {
    order: { entity: providerOrder({ amount_due: 1 }) },
  })), isError("ORDER_MISMATCH"));
  assert.throws(() => webhook(webhookBody("payment.failed")), isError("EVENT_MISMATCH"));
});

test("refund events preserve pending/processed/failed status and bind to their payment", () => {
  for (const [event, status] of [["refund.created", "pending"], ["refund.processed", "processed"], ["refund.failed", "failed"]]) {
    const refund = {
      entity: "refund", id: "rfnd_OfflineFixture", payment_id: "pay_OfflineFixture",
      currency: "INR", amount: 1000, status,
    };
    const result = webhook(webhookBody(event, providerPayment(), { refund: { entity: refund } }));
    assert.equal(result.refund.status, status);
    assert.equal(result.refund.amountPaise, 1000);
    assert.throws(() => webhook(webhookBody(event, providerPayment(), {
      refund: { entity: { ...refund, payment_id: "pay_Other" } },
    })), isError("REFUND_MISMATCH"));
  }
  const refund = { entity: "refund", id: "rfnd_OfflineFixture", payment_id: "pay_OfflineFixture", currency: "INR", amount: 1000, status: "pending" };
  assert.throws(() => webhook(webhookBody("refund.processed", providerPayment(), { refund: { entity: refund } })),
    isError("EVENT_MISMATCH"));
});

test("repeated signed events have stable hashes; changed payload under same ID is distinguishable", () => {
  const first = webhook();
  const second = webhook();
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.payloadHash, second.payloadHash);
  const changed = webhook(webhookBody("payment.captured", providerPayment({ amount: 20000 })));
  assert.equal(changed.eventId, first.eventId);
  assert.notEqual(changed.payloadHash, first.payloadHash);
});

test("failed then captured payments can recover; late failure never reverses capture", () => {
  const initial = createPaymentState(STORED);
  const failed = normalizePayment(providerPayment({ status: "failed", captured: false }));
  const captured = normalizePayment(providerPayment());
  const failedState = applyVerifiedPayment(initial, failed);
  assert.equal(failedState.status, "failed");
  const capturedState = applyVerifiedPayment(failedState, captured);
  assert.equal(capturedState.status, "captured");
  assert.deepEqual(applyVerifiedPayment(capturedState, failed), capturedState);
  assert.deepEqual(applyVerifiedPayment(capturedState, captured), capturedState);
  assert.equal(initial.status, "created");
});

test("refunds remain monotonic across duplicate events and older capture snapshots", () => {
  const initial = createPaymentState(STORED);
  const captured = normalizePayment(providerPayment());
  const partial = normalizePayment(providerPayment({ amount_refunded: 2500 }));
  const full = normalizePayment(providerPayment({ amount_refunded: 10000, status: "refunded" }));
  const partialState = applyVerifiedPayment(initial, partial);
  assert.equal(partialState.status, "partially_refunded");
  assert.deepEqual(applyVerifiedPayment(partialState, captured), partialState);
  const fullState = applyVerifiedPayment(partialState, full);
  assert.equal(fullState.status, "refunded");
  assert.deepEqual(applyVerifiedPayment(fullState, partial), fullState);
  assert.deepEqual(applyVerifiedPayment(fullState, captured), fullState);
});

test("other failed attempts cannot replace captured payment; conflicting capture is explicit", () => {
  const state = applyVerifiedPayment(createPaymentState(STORED), normalizePayment(providerPayment()));
  assert.equal(applyVerifiedPayment(state, normalizePayment(providerPayment({
    id: "pay_Other", status: "failed", captured: false,
  }))), state);
  assert.throws(() => applyVerifiedPayment(state, normalizePayment(providerPayment({ id: "pay_Other" }))),
    isError("MULTIPLE_CAPTURES"));
  assert.throws(() => applyVerifiedPayment(state, normalizePayment(providerPayment({ order_id: "order_Other" }))),
    isError("PAYMENT_MISMATCH"));
});

test("corrupt stored states or unnormalized capture flags cannot become successful states", () => {
  const initial = createPaymentState(STORED);
  const payment = normalizePayment(providerPayment());
  for (const changes of [
    { mode: "preview" }, { amountPaise: 0 }, { currency: "USD" }, { status: "unknown" },
    { refundedPaise: -1 }, { refundedPaise: 1 }, { captured: true, status: "captured", paymentId: null },
  ]) assert.throws(() => applyVerifiedPayment({ ...initial, ...changes }, payment), PaymentError);
  assert.throws(() => applyVerifiedPayment(initial, { ...payment, status: "failed", captured: true }),
    isError("INVALID_PAYMENT_STATE"));
  assert.throws(() => applyVerifiedPayment(initial, { ...payment, status: "refunded", refundedPaise: 0 }),
    isError("INVALID_PAYMENT_STATE"));
});
