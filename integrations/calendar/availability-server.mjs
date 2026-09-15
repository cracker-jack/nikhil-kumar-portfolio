import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AvailabilityError, createAvailabilityService } from "./availability.mjs";
import { CalendarAuthError, assertPrivateTokenPath, loadConfig, REDIRECT_URI } from "./google-oauth.mjs";

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
    if (req.url !== "/api/availability") return send(res, 404, { error: "not_found" }, origin);
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
    if (Number(req.headers["content-length"]) > 1024) {
      req.resume();
      return send(res, 413, { error: "request_too_large" }, origin, { Connection: "close" });
    }
    let body = "";
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 1024) {
        send(res, 413, { error: "request_too_large" }, origin, { Connection: "close" });
        req.resume();
        return;
      }
      body += chunk.toString("utf8");
    }
    let input;
    try { input = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid_json" }, origin); }
    try {
      const result = await service.getAvailability(input);
      send(res, 200, result, origin);
    } catch (error) {
      if (error instanceof AvailabilityError) return send(res, error.status, { error: error.code }, origin);
      logger(error instanceof CalendarAuthError ? error.code : "INTERNAL_ERROR");
      send(res, 503, { error: "availability_unavailable" }, origin, { "Retry-After": "5" });
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
    const server = createAvailabilityServer(service, origins ? { allowedOrigins: origins } : {});
    server.on("error", () => { console.error("Availability listener could not start; check the configured port."); process.exitCode = 1; });
    server.listen(port, process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1", () => {
      console.log(`Read-only calendar availability API listening on port ${port}. No booking or payment writes are enabled.`);
    });
  } catch (error) {
    console.error(error instanceof CalendarAuthError ? `${error.code}: ${error.message}` : "Availability API configuration is invalid.");
    process.exitCode = 1;
  }
}
