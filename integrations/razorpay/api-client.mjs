import {
  APPROVED_PRICES_PAISE, PaymentError, buildCheckoutDisplay, createPriceBook, isRecord,
  normalizePayment, requireValue, validAmount, validateOrderSnapshot, verifyHmac,
} from "./payment-model.mjs";

export class RazorpayApiClient {
  #keyId;
  #keySecret;
  #mode;
  #services;
  #fetch;
  #timeoutMs;
  #cardsEnabled;

  constructor({
    keyId, keySecret, pricesPaise = APPROVED_PRICES_PAISE, fetchImpl = globalThis.fetch,
    timeoutMs = 10000, cardsEnabled = false,
  } = {}) {
    requireValue(typeof keyId === "string" && keyId === keyId.trim()
      && /^rzp_(test|live)_[a-zA-Z0-9]+$/.test(keyId),
    "KEY_ID_REQUIRED", "Configure a valid Razorpay Key ID privately on the server.");
    requireValue(typeof keySecret === "string" && keySecret.trim().length > 0 && keySecret === keySecret.trim(),
      "MISSING_SECRET", "Configure the matching Razorpay Key Secret privately on the server.");
    requireValue(typeof fetchImpl === "function" && Number.isInteger(timeoutMs) && timeoutMs > 0
      && timeoutMs <= 30000 && typeof cardsEnabled === "boolean",
    "INVALID_CONFIGURATION", "Provide valid request settings and an explicit card flag.");
    this.#keyId = keyId;
    this.#keySecret = keySecret;
    this.#mode = keyId.startsWith("rzp_live_") ? "live" : "test";
    this.#services = createPriceBook(pricesPaise);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#cardsEnabled = cardsEnabled;
  }

  get mode() { return this.#mode; }
  get services() { return this.#services; }

  async #request(method, path, data) {
    let response;
    try {
      response = await this.#fetch(`https://api.razorpay.com/v1/${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const code = ["AbortError", "TimeoutError"].includes(error?.name) ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR";
      throw new PaymentError(code, "Razorpay could not be reached. No automatic request retry was made.",
        { reconciliationRequired: method === "POST" });
    }
    if (!response || !Number.isInteger(response.status) || typeof response.json !== "function") {
      throw new PaymentError("INVALID_PROVIDER_RESPONSE", "Razorpay did not return a valid HTTP response.",
        { reconciliationRequired: method === "POST" });
    }
    if (!response.ok) {
      throw new PaymentError("PROVIDER_HTTP_ERROR", `Razorpay rejected the request with HTTP ${response.status}.`,
        { status: response.status, reconciliationRequired: method === "POST" && response.status >= 500 });
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new PaymentError("INVALID_PROVIDER_JSON", "Razorpay returned an unreadable response.",
        { reconciliationRequired: method === "POST" });
    }
    if (!isRecord(result)) {
      throw new PaymentError("INVALID_PROVIDER_RESPONSE", "Razorpay returned an invalid response object.",
        { reconciliationRequired: method === "POST" });
    }
    return result;
  }

  #matchOrder(remote, stored) {
    requireValue(isRecord(remote) && remote.entity === "order" && remote.id === stored.orderId
      && remote.amount === stored.amountPaise && remote.currency === stored.currency
      && remote.receipt === stored.receipt && remote.notes?.service_id === stored.serviceId
      && remote.notes?.booking_id === stored.bookingId
      && ["created", "attempted", "paid"].includes(remote.status)
      && validAmount(remote.amount_paid) && validAmount(remote.amount_due)
      && remote.amount_paid <= stored.amountPaise && remote.amount_due <= stored.amountPaise
      && remote.amount_paid + remote.amount_due === stored.amountPaise,
    "ORDER_MISMATCH", "The Razorpay order does not match its trusted server-side booking.");
  }

  async createOrder({ serviceId, receipt, bookingId }) {
    const service = this.#services.find((item) => item.id === serviceId);
    requireValue(service, "INVALID_SERVICE", "Choose a configured service.");
    requireValue(typeof receipt === "string" && receipt.length > 0 && receipt.length <= 40
      && !/[\r\n]/.test(receipt), "INVALID_RECEIPT", "Provide a unique server-generated receipt of at most 40 characters.");
    requireValue(typeof bookingId === "string" && /^bk_[a-f0-9]{24}$/.test(bookingId),
      "INVALID_BOOKING_ID", "A server-generated booking identifier is required.");
    const remote = await this.#request("POST", "orders", {
      amount: service.amountPaise, currency: "INR", receipt, partial_payment: false,
      notes: { service_id: service.id, booking_id: bookingId },
    });
    const stored = {
      mode: this.#mode, orderId: remote.id, serviceId: service.id, bookingId,
      amountPaise: service.amountPaise, currency: "INR", receipt,
    };
    try {
      validateOrderSnapshot(stored);
      this.#matchOrder(remote, stored);
      requireValue(remote.status === "created" && remote.amount_paid === 0,
        "ORDER_MISMATCH", "A new Razorpay order must be unpaid.");
    } catch (error) {
      if (error instanceof PaymentError) error.reconciliationRequired = true;
      throw error;
    }
    return Object.freeze(stored);
  }

  checkoutOptions(stored, { customerName, customerEmail } = {}) {
    validateOrderSnapshot(stored);
    const service = this.#services.find((item) => item.id === stored.serviceId);
    return {
      key: this.#keyId, order_id: stored.orderId, amount: stored.amountPaise, currency: stored.currency,
      name: "Nikhil Kumar", description: `${service.name} session`,
      prefill: { name: customerName, email: customerEmail },
      notes: { booking_id: stored.bookingId, service_id: stored.serviceId },
      config: buildCheckoutDisplay({ mode: this.#mode, cardsEnabled: this.#cardsEnabled }),
      theme: { color: "#166458" },
    };
  }

  async verifyCheckout(stored, callback) {
    validateOrderSnapshot(stored);
    requireValue(isRecord(callback) && callback.razorpay_order_id === stored.orderId
      && typeof callback.razorpay_payment_id === "string" && /^pay_[a-zA-Z0-9]{1,64}$/.test(callback.razorpay_payment_id),
    "CALLBACK_MISMATCH", "The checkout response does not match the stored order.");
    requireValue(verifyHmac(`${stored.orderId}|${callback.razorpay_payment_id}`,
      callback.razorpay_signature, this.#keySecret),
    "INVALID_SIGNATURE", "The checkout payment signature is invalid.");
    return this.reconcilePayment(stored, callback.razorpay_payment_id);
  }

  async reconcilePayment(stored, paymentId) {
    validateOrderSnapshot(stored);
    requireValue(typeof paymentId === "string" && /^pay_[a-zA-Z0-9]{1,64}$/.test(paymentId),
      "INVALID_PAYMENT_ID", "A valid server-selected payment ID is required.");
    const [rawPayment, remoteOrder] = await Promise.all([
      this.#request("GET", `payments/${paymentId}`),
      this.#request("GET", `orders/${stored.orderId}`),
    ]);
    this.#matchOrder(remoteOrder, stored);
    const payment = normalizePayment(rawPayment);
    requireValue(payment.paymentId === paymentId && payment.orderId === stored.orderId
      && payment.amountPaise === stored.amountPaise && payment.currency === stored.currency,
    "PAYMENT_MISMATCH", "The Razorpay payment does not match its trusted server-side order.");
    requireValue(payment.method === "upi" || (this.#cardsEnabled && payment.method === "card"),
      "METHOD_NOT_ENABLED", "An unexpected payment method requires manual reconciliation.");
    if (payment.captured) {
      requireValue(remoteOrder.status === "paid" && remoteOrder.amount_paid === stored.amountPaise && remoteOrder.amount_due === 0,
        "INCONSISTENT_CAPTURE", "Payment capture and order status are not yet consistent. Do not confirm a booking.");
    }
    return payment;
  }
}
