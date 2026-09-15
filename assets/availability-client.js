import { preferredSlots, TIME_ZONE } from "./booking-slots.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

export function availabilityEndpoint(configured, pageHref) {
  const page = new URL(pageHref);
  if (LOOPBACK.has(page.hostname) && page.searchParams.get("calendar") === "local") {
    return "http://127.0.0.1:4175/api/availability";
  }
  if (!configured) return "";
  const endpoint = new URL(configured);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== "/api/availability") {
    throw new Error("The calendar endpoint configuration is invalid.");
  }
  return endpoint.href;
}

export async function checkedAvailability(endpoint, service, date, {
  fetchImpl = globalThis.fetch, signal, now = Date.now,
} = {}) {
  const controller = new AbortController();
  const requestedAt = now();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 20000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId: service.id, date }),
      credentials: "omit", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new Error("Calendar availability could not be checked. Please retry or arrange the session by email.");
    const data = await response.json();
    if (!data || typeof data !== "object" || data.source !== "google-calendar" || data.serviceId !== service.id || data.date !== date
      || data.timeZone !== TIME_ZONE || data.durationMinutes !== service.duration || data.priceInr !== service.priceInr
      || data.reserved !== false || !Array.isArray(data.slots) || !Number.isFinite(Date.parse(data.checkedAt))
      || !Number.isInteger(data.validForSeconds) || data.validForSeconds < 1 || data.validForSeconds > 30) {
      throw new Error("The calendar response does not match this session. Reload or arrange the session by email.");
    }
    const candidates = new Map(preferredSlots(date, service.duration, new Date(0)).map((slot) => [slot.time, slot]));
    const seen = new Set();
    const slots = data.slots.map((slot) => {
      if (!slot || typeof slot !== "object") throw new Error("The calendar returned an invalid time.");
      const expected = candidates.get(slot.time);
      if (!expected || seen.has(slot.time) || slot.start !== expected.start || slot.end !== expected.end) {
        throw new Error("The calendar returned an invalid time. Please retry the check.");
      }
      seen.add(slot.time);
      return expected;
    }).sort((left, right) => left.start.localeCompare(right.start));
    return { slots, expiresAt: requestedAt + data.validForSeconds * 1000, checkedAt: data.checkedAt };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
