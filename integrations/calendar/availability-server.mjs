import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AvailabilityError, createAvailabilityService } from "./availability.mjs";
import { CalendarAuthError, assertPrivateTokenPath, loadConfig, REDIRECT_URI } from "./google-oauth.mjs";
import {
  BookingError, FirestoreBookingStore, createBookingService, createRazorpayFromEnv,
  verifyRazorpayWebhookFromEnv,
} from "./booking-service.mjs";
import { PaymentError } from "../razorpay/payment-model.mjs";

export function readPrivateCredentials(env) {
  try {
    if (env.CALENDAR_CREDENTIALS_FILE) {
      const file = assertPrivateTokenPath(env.CALENDAR_CREDENTIALS_FILE);
      const bundle = JSON.parse(readFileSync(file, "utf8"));
      const config = loadConfig({
        GOOGLE_CLIENT_ID: bundle.clientId, GOOGLE_CLIENT_SECRET: bundle.clientSecret,
        GOOGLE_OWNER_EMAIL: bundle.ownerEmail, GOOGLE_CALENDAR_ID: bundle.calendarId,
        GOOGLE_BLOCKING_CALENDAR_IDS: Array.isArray(bundle.blockingCalendarIds) ? bundle.blockingCalendarIds.join(",") : "",
        GOOGLE_REDIRECT_URI: REDIRECT_URI, GOOGLE_TOKEN_FILE: file,
      });
      return { config, saved: bundle.authorization };
    }
    const config = loadConfig(env);
    return { config, saved: JSON.parse(readFileSync(config.tokenFile, "utf8")) };
  } catch (error) {
    if (error instanceof CalendarAuthError) throw error;
    throw new CalendarAuthError("PRIVATE_CREDENTIALS_UNAVAILABLE", "Private calendar credentials are missing or unreadable.");
  }
}

export function createAvailabilityServer(service, {
  bookingService,
  webhookVerifier,
  allowedOrigins = ["https://cracker-jack.github.io", "http://127.0.0.1:4173", "http://localhost:4173"],
  maxRequestsPerMinute = 60,
  now = Date.now,
  logger = (code) => console.error(`Calendar availability error: ${code}`),
} = {}) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length
    || allowedOrigins.some((origin) => !/^https?:\/\/[^/?#]+$/.test(origin))
    || !Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1) {
    throw new Error("Invalid availability server configuration.");
  }
  const origins = new Set(allowedOrigins);
  let windowStart = now();
  let requests = 0;

  function send(res, status, data, origin, extra = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Vary": "Origin",
      ...(origin && origins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
      ...extra,
    });
    res.end(JSON.stringify(data));
  }

  async function handle(req, res) {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return send(res, 403, { error: "origin_not_allowed" });
    if (req.url === "/healthz" && req.method === "GET") return send(res, 200, { status: "ok" }, origin);
    const route = req.url?.split("?")[0];
    const routes = new Set(["/api/availability", "/api/bookings/intent", "/api/payments/checkout-callback", "/api/razorpay/webhook"]);
    if (!routes.has(route)) return send(res, 404, { error: "not_found" }, origin);
    if (req.url !== route) return send(res, 404, { error: "not_found" }, origin);
    if (req.method === "OPTIONS") {
      return send(res, 204, {}, origin, {
        "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
    }
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, origin, { Allow: "POST, OPTIONS" });
    if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
    if (++requests > maxRequestsPerMinute) return send(res, 429, { error: "rate_limited" }, origin, { "Retry-After": "60" });
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      return send(res, 415, { error: "json_required" }, origin);
    }
    const maxBytes = route === "/api/razorpay/webhook" ? 256 * 1024 : route === "/api/availability" ? 1024 : 4096;
    if (Number(req.headers["content-length"]) > maxBytes) {
      req.resume();
      return send(res, 413, { error: "request_too_large" }, origin, { Connection: "close" });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) {
        send(res, 413, { error: "request_too_large" }, origin, { Connection: "close" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);
    const body = rawBody.toString("utf8");
    let input;
    if (route !== "/api/razorpay/webhook") {
      try { input = JSON.parse(body); }
      catch { return send(res, 400, { error: "invalid_json" }, origin); }
    }
    try {
      let result;
      if (route === "/api/availability") {
        result = await service.getAvailability(input);
      } else if (route === "/api/bookings/intent" && bookingService) {
        result = await bookingService.createIntent(input);
      } else if (route === "/api/payments/checkout-callback" && bookingService) {
        result = { booking: await bookingService.confirmCheckout(input) };
      } else if (route === "/api/razorpay/webhook" && bookingService && webhookVerifier) {
        const verified = webhookVerifier(rawBody, req.headers);
        result = await bookingService.reconcileWebhook(verified);
      } else {
        return send(res, 404, { error: "not_found" }, origin);
      }
      send(res, 200, result, origin);
    } catch (error) {
      if (error instanceof AvailabilityError) return send(res, error.status, { error: error.code }, origin);
      if (error instanceof BookingError) return send(res, error.status, { error: error.code }, origin);
      if (error instanceof PaymentError) return send(res, error.status || 400, { error: error.code }, origin);
      logger(error instanceof CalendarAuthError ? error.code : "INTERNAL_ERROR");
      const code = route === "/api/availability" ? "availability_unavailable" : "booking_unavailable";
      send(res, 503, { error: code }, origin, { "Retry-After": "5" });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      logger("REQUEST_FAILED");
      if (!res.headersSent) send(res, 500, { error: "request_failed" }, req.headers.origin);
      else res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT || 4175);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
    const { config, saved } = readPrivateCredentials(process.env);
    const origins = process.env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim());
    const service = createAvailabilityService(config, saved);
    let bookingService;
    let webhookVerifier;
    if (process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_SECRET || process.env.BOOKINGS_PROJECT_ID) {
      try {
        const razorpay = createRazorpayFromEnv(process.env);
        const store = new FirestoreBookingStore({
          projectId: process.env.BOOKINGS_PROJECT_ID,
          databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
        });
        bookingService = createBookingService({
          availabilityService: service, razorpay, store, calendarConfig: config, savedAuthorization: saved,
          logger: (message) => console.error(message),
        });
        if (process.env.RAZORPAY_WEBHOOK_SECRET) {
          webhookVerifier = (rawBody, headers) => verifyRazorpayWebhookFromEnv(process.env, rawBody, headers);
        }
      } catch (error) {
        console.error(error instanceof BookingError || error instanceof PaymentError || error instanceof CalendarAuthError
          ? `BOOKING_CONFIGURATION_DISABLED: ${error.code}`
          : "BOOKING_CONFIGURATION_DISABLED: UNKNOWN_ERROR");
      }
    }
    const server = createAvailabilityServer(service, { ...(origins ? { allowedOrigins: origins } : {}), bookingService, webhookVerifier });
    server.on("error", () => { console.error("Availability listener could not start; check the configured port."); process.exitCode = 1; });
    server.listen(port, process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1", () => {
      console.log(bookingService
        ? `Calendar availability and verified booking API listening on port ${port}.`
        : `Read-only calendar availability API listening on port ${port}. No booking or payment writes are enabled.`);
    });
  } catch (error) {
    if (error instanceof CalendarAuthError || error instanceof BookingError || error instanceof PaymentError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error("Availability API configuration is invalid.");
    }
    process.exitCode = 1;
  }
}
