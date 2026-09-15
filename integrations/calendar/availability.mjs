import { SERVICES, APPROVED_PRICES_PAISE } from "../razorpay/payment-model.mjs";
import { preferredSlots, todayInIST, TIME_ZONE } from "../../assets/booking-slots.js";
import { CalendarAuthError, readCalendarBusy, refreshCalendarAccess } from "./google-oauth.mjs";

const CACHE_MS = 30000;
const MAX_CACHED_DATES = 64;

export class AvailabilityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AvailabilityError";
    this.code = code;
    this.status = status;
  }
}

export function validateAvailabilityRequest(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["serviceId", "date"].includes(key))) {
    throw new AvailabilityError("invalid_request", "Provide only a serviceId and date.");
  }
  const service = SERVICES.find((item) => item.id === input.serviceId);
  if (!service) throw new AvailabilityError("invalid_service", "Choose a listed service.");
  let candidates;
  try {
    candidates = preferredSlots(input.date, service.durationMinutes, now);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new AvailabilityError("invalid_date", "Choose a valid date in YYYY-MM-DD format.");
  }
  if (input.date < todayInIST(now)) throw new AvailabilityError("past_date", "Choose today or a future date in IST.");
  return { service, candidates };
}

function timestamp(value) {
  if (typeof value !== "string" || value !== value.trim()
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    throw new CalendarAuthError("INVALID_BUSY_DATA", "Google returned an invalid busy interval.");
  }
  const time = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CalendarAuthError("INVALID_BUSY_DATA", "Google returned an invalid busy date.");
  }
  if (!Number.isFinite(time)) throw new CalendarAuthError("INVALID_BUSY_DATA", "Google returned an invalid busy timestamp.");
  return time;
}

export function normalizeBusy(intervals) {
  if (!Array.isArray(intervals)) throw new CalendarAuthError("INVALID_BUSY_DATA", "Google did not return busy intervals.");
  return intervals.map((interval) => {
    const start = timestamp(interval?.start);
    const end = timestamp(interval?.end);
    if (start >= end) throw new CalendarAuthError("INVALID_BUSY_DATA", "Google returned a non-positive busy interval.");
    return { start, end };
  });
}

export function removeBusySlots(slots, busy) {
  return slots.filter((slot) => !busy.some((interval) =>
    interval.start < Date.parse(slot.end) && interval.end > Date.parse(slot.start)));
}

export function createAvailabilityService(config, saved, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  let access;
  let accessFlight;
  let failureUntil = 0;
  const dates = new Map();
  const pending = new Map();

  async function accessToken() {
    if (access && access.expiresAt > now().getTime()) return access.value;
    if (!accessFlight) {
      accessFlight = refreshCalendarAccess(config, saved, fetchImpl).then((tokens) => {
        access = {
          value: tokens.access_token,
          expiresAt: now().getTime() + Math.max(0, tokens.expires_in * 1000 - 60000),
        };
        return access.value;
      }).finally(() => { accessFlight = undefined; });
    }
    return accessFlight;
  }

  async function busyForDate(date) {
    const cached = dates.get(date);
    if (cached && cached.checkedAt + CACHE_MS > now().getTime()) return cached;
    if (pending.has(date)) return pending.get(date);
    if (now().getTime() < failureUntil) {
      throw new CalendarAuthError("CALENDAR_BACKOFF", "Calendar access is temporarily unavailable.");
    }
    if (pending.size >= 8) throw new AvailabilityError("busy", "Please retry the availability check shortly.", 503);
    const task = (async () => {
      try {
        const token = await accessToken();
        const fullDay = preferredSlots(date, 30, new Date(0));
        const intervals = await readCalendarBusy(config, token, fullDay[0].start, fullDay.at(-1).end, fetchImpl);
        const entry = { busy: normalizeBusy(intervals), checkedAt: now().getTime() };
        if (dates.size >= MAX_CACHED_DATES && !dates.has(date)) dates.delete(dates.keys().next().value);
        dates.set(date, entry);
        failureUntil = 0;
        return entry;
      } catch (error) {
        access = undefined;
        failureUntil = now().getTime() + 5000;
        throw error;
      } finally {
        pending.delete(date);
      }
    })();
    pending.set(date, task);
    return task;
  }

  return {
    async getAvailability(input) {
      const { service } = validateAvailabilityRequest(input, now());
      const entry = await busyForDate(input.date);
      const checkedNow = now();
      const candidates = preferredSlots(input.date, service.durationMinutes, checkedNow);
      return {
        source: "google-calendar",
        serviceId: service.id,
        date: input.date,
        timeZone: TIME_ZONE,
        durationMinutes: service.durationMinutes,
        priceInr: APPROVED_PRICES_PAISE[service.id] / 100,
        checkedAt: new Date(entry.checkedAt).toISOString(),
        validForSeconds: Math.max(1, Math.min(30, Math.ceil((entry.checkedAt + CACHE_MS - checkedNow.getTime()) / 1000))),
        reserved: false,
        slots: removeBusySlots(candidates, entry.busy),
      };
    },
  };
}
