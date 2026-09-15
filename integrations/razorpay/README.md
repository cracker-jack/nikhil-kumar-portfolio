# Razorpay Test Mode integration core

This is server-side integration code, **not a deployed checkout or booking service**. The portfolio retains its Topmate links and separately offers an external Razorpay.me link for manually arranged direct sessions. That hosted link does not use this Test Mode module. There is no HTTP server, database, customer form, calendar access, email sending, or live-payment switch in this module.

## Scope and cost

- The client rejects live API keys and accepts only `rzp_test_...` credentials. Do not weaken that guard as a shortcut to production.
- Razorpay's India pricing, reviewed on 14 September 2026, lists no setup, annual maintenance, or integration fee, but a standard domestic platform fee of **2% per successful transaction plus 18% GST on that fee**, including standard UPI. Account-specific terms and optional products can differ.
- Test Mode simulates payments without real money. It does not prove that real UPI app hand-offs or QR payments work: Razorpay's Standard Checkout guide specifies Live Mode for testing Intent/QR.
- The client uses the approved server-side prices below. Prices are integer amounts in INR paise; the integration does not automatically add gateway fees or a surcharge.
- These Standard Checkout notes do not establish account-specific fees or payment-method availability for the separate Razorpay.me page; check the merchant's terms for that product.

## Approved session prices

Confirmed by Nikhil on 14 September 2026 and stored in the immutable `APPROVED_PRICES_PAISE` catalog in `payment-model.mjs`:

| Service | Duration | Price (INR) |
| --- | --- | --- |
| Mentorship | 30 minutes | 499 |
| Resume review | 30 minutes | 399 |
| HLD mock interview | 60 minutes | 999 |
| LLD mock interview | 60 minutes | 999 |
| Coding / DSA mock interview | 60 minutes | 699 |

"Coding interview" maps to the existing `dsa-mock` service. `RazorpayTestClient` uses this catalog by default. Deliberate server-side price overrides must supply all five valid integer paise amounts; partial or malformed overrides are rejected. Existing orders retain their stored price snapshot when the catalog changes.

## Run the offline tests

From the repository root, using Node.js 24:

```powershell
node --test .\integrations\razorpay\razorpay.test.mjs .\integrations\razorpay\hosted-link.test.mjs
```

There are no dependencies to install. Tests inject an in-process HTTP substitute and fictional credentials; they never contact Razorpay, move money, or send invitations. Passing them is not an end-to-end gateway certification.

`hosted-link.test.mjs` also checks the classic homepage's static prices, exact outbound payment URL, manual-scheduling disclosures, and retained Topmate links. Those repository-specific checks do not exercise a real hosted payment.

## Module contracts

`RazorpayTestClient` in `test-client.mjs` accepts:

| Option | Requirement |
| --- | --- |
| `keyId` | Actual Test Mode key ID, supplied privately by the future backend |
| `keySecret` | Actual Test Mode secret; never include in browser code, logs, Git, or chat |
| `pricesPaise` | Optional complete server-side price override; defaults to the approved catalog above |
| `cardsEnabled` | Optional boolean; defaults to `false`, so checkout displays UPI only |
| `timeoutMs` | Optional bounded request timeout; defaults to 10 seconds |
| `fetchImpl` | HTTP dependency injection for tests; the real client uses native `fetch` |

- `createOrder({ serviceId, receipt })` gets the amount from the validated server-side price book and creates a non-partial-payment Razorpay order. Persist the returned immutable order snapshot, tied to the owning checkout/booking.
- `checkoutOptions(storedOrder)` produces public Standard Checkout options. It includes the public test key ID, never the secret. The hosted SDK and its success/failure/dismiss handlers must be wired by a future checkout application.
- `verifyCheckout(storedOrder, callback)` uses the **stored** order ID for HMAC verification, then fetches the payment and order from Razorpay. It checks their identity, amount, currency, receipt, service binding, capture state, and configured payment method. An authentic `authorized` payment is not a captured payment.
- `reconcilePayment(storedOrder, paymentId)` performs those same provider reads and business checks without needing a browser callback. Use it from a trusted background worker after validating a webhook or loading a persisted reconciliation job; never expose it as an unrestricted customer endpoint. A historical capture event can predate a refund, so re-fetch current state before fulfilment.
- `verifyWebhook(...)` verifies the exact raw bytes before parsing, supports retained signing secrets during rotation, optionally checks the merchant account, and returns only normalized event/payment/refund metadata. Card, contact, email, VPA, notes, and the original payload are not returned.
- `createPaymentState` and `applyVerifiedPayment` reconcile verified snapshots without downgrading a captured/refunded payment when older events or other failed attempts arrive. The reducer enforces UPI-only processing by default; pass `{ cardsEnabled: true }` consistently with the checkout client when deliberately enabling cards. These functions do **not** perform persistence, deduplicate deliveries, settle funds, reserve a slot, or send confirmations.
- `buildCheckoutDisplay` has a separately tested live-display configuration for Intent/QR with Collect excluded, and an explicit optional cards block. This does **not** enable live keys or live payments in the client. Account eligibility still governs available methods.

## Required before adding automated checkout

1. Supply test credentials through server secrets. Approved service prices are already configured above. Never place credentials, calendar IDs, customer records, payment data, or `.env` files in this GitHub Pages publishing root.
2. Implement an externally hosted backend and durable storage. Keep payment processing outside GitHub Pages. A Cloud Run container's local filesystem is not a durable payment database.
3. Bind stored orders to their owning checkout, enforce request validation, authentication where needed, CSRF/CORS protections, rate limits, and authorized administrative access. Treat browser-supplied amounts, service metadata, IDs, statuses, and redirect query strings as untrusted.
4. Persist order-creation intent and a stable receipt before the provider call. This core deliberately does not retry POST requests. A timeout or malformed success response may mean the order was created; `reconciliationRequired` flags that ambiguity. Reconcile with Razorpay before creating another order.
5. Subscribe to `payment.captured`, `payment.failed`, `order.paid`, and the relevant refund events. Atomically deduplicate using the event ID and payload hash and persist the event plus its reconciliation job before returning 2xx. Log an explicit conflict if an existing event ID has a different hash. Acknowledge within Razorpay's five-second window after durable acceptance; do not wait on provider API calls in the webhook handler. Run reconciliation in a worker. Duplicate delivery is expected; the state reducer alone is **not** an idempotent fulfilment system.
6. Webhooks need an approved public endpoint; localhost is not usable directly. The docs list blocked interceptor/tunnel domains. Do not send customer payloads to third-party debugging endpoints or open a tunnel without approval. Keep signature validation on during testing.
7. Handle payment failure followed by later capture, out-of-order delivery, refunds, abandoned checkout, and uncertain network outcomes. Persist refund-entity status separately: this reducer tracks the payment's cumulative refunded amount, not pending refund requests. Cancellations and pending refunds must block fulfilment even if the payment still says `captured`. Refunds require separate authorized operations and a user-approved policy; a refund request being created is not proof the customer has received funds. Retry refund creation with the same `X-Refund-Idempotency` key and identical body.
8. Test actual hosted checkout, success/failure/dismiss/retry, authenticated callbacks, provider webhook delivery, and operational recovery using the merchant's Test Mode account. A plain success page is not payment verification.
9. Obtain explicit approval for live transaction fees, merchant activation, hosting, policies, and any real-money test. Actual UPI Intent/QR needs separate authorized validation. Do not infer that a zero-MDR instrument has no gateway platform fee.
10. Add atomic slot reservation and payment/booking reconciliation, then calendar invitations and reliable confirmation-email delivery. Until those exist, a test payment must never be described as a confirmed appointment.

## Documentation reviewed

The complete Standard Checkout build/test/go-live guide and the related chapters below were read for this integration. This is not a claim to have read unrelated RazorpayX, payroll, POS, subscriptions, or every product in Razorpay's documentation.

- [India pricing](https://razorpay.com/pricing/)
- [Standard Checkout integration steps](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Standard Checkout best practices](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/best-practices/)
- [Troubleshooting](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/troubleshooting-faqs/)
- [Payment configuration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/configure-payment-methods/), including its configuration-model and sample-code chapters
- [Standard Checkout UPI migration](https://razorpay.com/docs/announcements/upi-collect-migration/standard-integration/)
- [Orders API: create](https://razorpay.com/docs/api/orders/create/) and [fetch](https://razorpay.com/docs/api/orders/fetch-with-id/)
- [Fetch payment](https://razorpay.com/docs/api/payments/fetch-with-id/) and [capture settings](https://razorpay.com/docs/payments/payments/capture-settings/)
- [API keys](https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/)
- [Webhook setup](https://razorpay.com/docs/webhooks/setup-edit-payments/), [validation/testing](https://razorpay.com/docs/webhooks/validate-test/), and [best practices](https://razorpay.com/docs/webhooks/best-practices/)
- Webhook payloads for [payments](https://razorpay.com/docs/webhooks/payments/), [orders](https://razorpay.com/docs/webhooks/orders/), and [refunds](https://razorpay.com/docs/webhooks/refunds/)
- [Refund lifecycle](https://razorpay.com/docs/payments/refunds/) and [idempotent normal refunds](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/)
- [Settlements](https://razorpay.com/docs/payments/settlements/)

Implementation notes from the documentation: HMAC must use raw webhook bytes; delivery can be duplicated or reordered; webhook failures retry for up to 24 hours before deactivation; uncaptured payments can be automatically refunded; orders stay `paid` after refunds. Settlement timing depends on the merchant's terms and bank approval; use the merchant dashboard/agreement rather than hardcoding a payout promise.

The raw documentation archive and review evidence are outside this repository.
