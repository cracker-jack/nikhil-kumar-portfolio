import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { checkedAvailability, availabilityEndpoint } from "../../assets/availability-client.js";
import { preferredSlots } from "../../assets/booking-slots.js";
import { AvailabilityError, createAvailabilityService, normalizeBusy, removeBusySlots, validateAvailabilityRequest } from "./availability.mjs";
import { createAvailabilityServer } from "./availability-server.mjs";
import { CalendarAuthError, SCOPES } from "./google-oauth.mjs";

const DAY = "2026-09-18";
const START = Date.parse(`${DAY}T10:29:50Z`);
const config = {
  clientId: "fictional.apps.googleusercontent.com", clientSecret: "fictional-secret",
  ownerEmail: "owner@example.invalid", calendarId: "private@example.invalid",
  blockingCalendarIds: Object.freeze(["private@example.invalid", "primary"]),
};
const saved = { client_id: config.clientId, authorized_email: config.ownerEmail, refresh_token: "fictional-refresh" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const input = (serviceId = "mentorship", date = DAY) => ({ serviceId, date });

function fixture() {
  let clock = START;
  const state = { busy: [], calls: [], fail: false };
  const service = createAvailabilityService(config, saved, {
    now: () => new Date(clock),
    fetchImpl: async (url, options) => {
      state.calls.push({ url, options });
      if (url.endsWith("/token")) {
        return json({ access_token: "fictional-access", token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
      }
      if (url.endsWith("/userinfo")) return json({ email: config.ownerEmail, email_verified: true });
      assert.equal(url, "https://www.googleapis.com/calendar/v3/freeBusy");
      assert.equal(options.method, "POST");
      await state.waitForBusy;
      if (state.fail) return json({ error: "private provider detail" }, 503);
      const query = JSON.parse(options.body);
      assert.deepEqual(query.items, [{ id: config.calendarId }, { id: "primary" }]);
      return json({
        kind: "calendar#freeBusy",
        calendars: { [config.calendarId]: { busy: state.busy }, primary: { busy: state.primaryBusy || [] } },
      });
    },
  });
  return { state, service, advance: (ms) => { clock += ms; } };
}

test("requests accept only approved services and valid non-past IST dates", () => {
  for (const value of [
    null, [], {}, { ...input(), calendarId: "other" }, input("other"), input("mentorship", "2026-02-30"),
    input("mentorship", "2026-09-17"), input("mentorship", `${DAY}\n`), input("mentorship", 20260918),
  ]) assert.throws(() => validateAvailabilityRequest(value, new Date(START)), AvailabilityError);
  for (const id of ["mentorship", "resume-review", "hld-mock", "lld-mock", "dsa-mock"]) {
    assert.equal(validateAvailabilityRequest(input(id), new Date(START)).service.id, id);
  }
});

test("overlaps block both durations, but touching boundaries remain free", () => {
  const busy = normalizeBusy([{ start: `${DAY}T16:30:00+05:30`, end: `${DAY}T17:00:00+05:30` }]);
  const short = removeBusySlots(preferredSlots(DAY, 30, new Date(START)), busy);
  assert.equal(short.length, 13);
  assert.ok(short.some((slot) => slot.time === "16:00"));
  assert.ok(!short.some((slot) => slot.time === "16:30"));
  assert.ok(short.some((slot) => slot.time === "17:00"));
  const long = removeBusySlots(preferredSlots(DAY, 60, new Date(START)), busy);
  assert.equal(long.length, 11);
  assert.equal(long[0].time, "17:00");
  const allDay = normalizeBusy([{ start: `${DAY}T00:00:00+05:30`, end: "2026-09-19T00:00:00+05:30" }]);
  assert.equal(removeBusySlots(short, allDay).length, 0);
});

test("primary-calendar busy intervals also block public slots", async () => {
  const { service, state } = fixture();
  state.primaryBusy = [{ start: "2026-09-19T16:00:00+05:30", end: "2026-09-19T17:00:00+05:30" }];
  const short = await service.getAvailability(input("mentorship", "2026-09-19"));
  assert.ok(!short.slots.some((slot) => ["16:00", "16:30"].includes(slot.time)));
  assert.ok(short.slots.some((slot) => slot.time === "15:30"));
  assert.ok(short.slots.some((slot) => slot.time === "17:00"));
  const long = await service.getAvailability(input("hld-mock", "2026-09-19"));
  assert.ok(!long.slots.some((slot) => ["15:30", "16:00", "16:30"].includes(slot.time)));
  assert.ok(long.slots.some((slot) => slot.time === "15:00"));
  assert.ok(long.slots.some((slot) => slot.time === "17:00"));
});

test("malformed, impossible and non-positive Google intervals fail closed", () => {
  const end = `${DAY}T17:00:00Z`;
  for (const intervals of [
    null, {}, [null], [{ start: `${DAY}T16:00:00`, end }],
    [{ start: "2026-02-30T16:00:00Z", end }], [{ start: `${DAY}T24:00:00Z`, end }],
    [{ start: `${DAY}T16:00:00Z\n`, end }], [{ start: end, end }],
    [{ start: `${DAY}T18:00:00Z`, end }],
  ]) assert.throws(() => normalizeBusy(intervals), CalendarAuthError);
});

test("real service path shares token and date requests and returns only safe public fields", async () => {
  const { service, state } = fixture();
  const [short, long] = await Promise.all([service.getAvailability(input()), service.getAvailability(input("hld-mock"))]);
  assert.equal(state.calls.length, 3);
  assert.equal(short.slots.length, 14);
  assert.equal(long.slots.length, 13);
  assert.equal(short.priceInr, 499);
  assert.equal(long.priceInr, 999);
  assert.equal(short.reserved, false);
  assert.equal(short.source, "google-calendar");
  assert.equal(short.timeZone, "Asia/Kolkata");
  assert.equal(short.validForSeconds, 30);
  assert.deepEqual(Object.keys(short).sort(), [
    "checkedAt", "date", "durationMinutes", "priceInr", "reserved", "serviceId", "slots", "source", "timeZone", "validForSeconds",
  ].sort());
  for (const privateValue of Object.values(config).concat(saved.refresh_token)) {
    assert.ok(!JSON.stringify(short).includes(privateValue));
  }
  assert.ok(state.calls.every(({ url }) => !url.includes("/events")));
  const weekend = await service.getAvailability(input("resume-review", "2026-09-19"));
  assert.equal(weekend.slots[0].time, "11:00");
  assert.equal(weekend.slots.at(-1).time, "22:30");
  assert.equal(weekend.priceInr, 399);
});

test("cached busy data re-filters past starts and expires after thirty seconds", async () => {
  const { service, state, advance } = fixture();
  await service.getAvailability(input());
  advance(10000);
  const cached = await service.getAvailability(input());
  assert.equal(cached.slots[0].time, "16:30");
  assert.equal(cached.validForSeconds, 20);
  assert.equal(state.calls.length, 3);
  advance(20000);
  await service.getAvailability(input());
  assert.equal(state.calls.length, 4);
  advance(3540000);
  await service.getAvailability(input());
  assert.equal(state.calls.length, 7);
});

test("provider failures and malformed busy data never become free slots, with bounded retry cooldown", async () => {
  const { service, state, advance } = fixture();
  state.fail = true;
  await assert.rejects(service.getAvailability(input()), CalendarAuthError);
  const count = state.calls.length;
  await assert.rejects(service.getAvailability(input()), (error) => error.code === "CALENDAR_BACKOFF");
  assert.equal(state.calls.length, count);
  advance(5000);
  state.fail = false;
  state.busy = [{ start: "invalid", end: "invalid" }];
  await assert.rejects(service.getAvailability(input()), (error) => error.code === "INVALID_BUSY_DATA");
  advance(5000);
  state.busy = [];
  assert.equal((await service.getAvailability(input())).slots.length, 13);
});

test("date-query concurrency and retained-date cache are bounded", async () => {
  const { service, state } = fixture();
  const date = (offset) => new Date(Date.parse(DAY) + offset * 86400000).toISOString().slice(0, 10);
  let release;
  state.waitForBusy = new Promise((resolve) => { release = resolve; });
  const pending = Array.from({ length: 8 }, (_, index) => service.getAvailability(input("mentorship", date(index))));
  await assert.rejects(service.getAvailability(input("mentorship", date(8))), (error) => error.code === "busy" && error.status === 503);
  release();
  await Promise.all(pending);
  assert.equal(state.calls.filter(({ url }) => url.endsWith("/token")).length, 1);
  for (let index = 8; index < 65; index++) await service.getAvailability(input("mentorship", date(index)));
  const count = state.calls.length;
  await service.getAvailability(input("mentorship", date(64)));
  assert.equal(state.calls.length, count);
  await service.getAvailability(input());
  assert.equal(state.calls.length, count + 1);
});

async function serverFixture(t, service = { getAvailability: async () => ({ reserved: false, slots: [] }) }, options) {
  const server = createAvailabilityServer(service, options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${url}/api/availability`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  });
  return { url, post };
}

test("HTTP routes, exact CORS, methods and malformed bodies are guarded", async (t) => {
  const { url, post } = await serverFixture(t);
  const allowed = "http://127.0.0.1:4173";
  const response = await post(JSON.stringify(input()), { Origin: allowed });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowed);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal((await post("{}", { Origin: "https://attacker.example.invalid" })).status, 403);
  assert.equal((await post("{}")).status, 200);
  assert.equal((await fetch(`${url}/api/availability`)).status, 405);
  const preflight = await fetch(`${url}/api/availability`, { method: "OPTIONS", headers: { Origin: allowed } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  for (const path of ["/.env", "/google-calendar-tokens.json", "/api/events", "/api/availability?calendarId=other"]) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("x".repeat(1025))).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/availability`, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write("x".repeat(600));
    req.end("y".repeat(600));
  });
  assert.equal(chunked, 413);
});

test("HTTP errors never expose provider messages, and rate limits reset", async (t) => {
  const logged = [];
  let clock = START;
  const { post, url } = await serverFixture(t, {
    getAvailability: async (value) => {
      if (!value.serviceId) throw new AvailabilityError("invalid_service", "Choose a service");
      throw new Error("fictional-private-provider-secret");
    },
  }, { maxRequestsPerMinute: 2, now: () => clock, logger: (code) => logged.push(code) });
  assert.equal((await post("{}")).status, 400);
  const failed = await post(JSON.stringify(input()));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "availability_unavailable" });
  assert.deepEqual(logged, ["INTERNAL_ERROR"]);
  assert.equal((await post("{}")).status, 429);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  clock += 60000;
  assert.equal((await post("{}")).status, 400);
});

test("browser endpoint configuration ignores public query overrides and rejects unsafe configured URLs", () => {
  assert.equal(availabilityEndpoint("", "https://cracker-jack.github.io/nikhil-kumar-portfolio/?calendar=local"), "");
  assert.equal(availabilityEndpoint("", "http://127.0.0.1:4173/?calendar=local"), "http://127.0.0.1:4175/api/availability");
  assert.equal(availabilityEndpoint("", "http://localhost:4173/"), "");
  const endpoint = "https://calendar.example.invalid/api/availability";
  assert.equal(availabilityEndpoint(endpoint, "https://cracker-jack.github.io/"), endpoint);
  for (const url of ["http://calendar.example.invalid/api/availability", `${endpoint}?token=x`, `${endpoint}#x`, "https://user:pass@calendar.example.invalid/api/availability"]) {
    assert.throws(() => availabilityEndpoint(url, "https://cracker-jack.github.io/"));
  }
});

test("browser client sends only the service/date, validates slots and never accepts a reservation", async () => {
  const { service } = fixture();
  const data = await service.getAvailability(input());
  const selection = { id: "mentorship", duration: 30, priceInr: 499 };
  const request = async (body) => checkedAvailability("https://calendar.example.invalid/api/availability", selection, DAY, {
    now: () => START,
    fetchImpl: async (url, options) => {
      assert.deepEqual(JSON.parse(options.body), input());
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.headers, { "Content-Type": "application/json" });
      return json(body);
    },
  });
  const result = await request(data);
  assert.equal(result.expiresAt, START + 30000);
  assert.deepEqual(result.slots, data.slots);
  for (const patch of [
    { reserved: true }, { priceInr: 1 }, { durationMinutes: 60 }, { date: "2026-09-19" },
    { serviceId: "hld-mock" }, { source: "preferred" }, { timeZone: "UTC" }, { checkedAt: null },
    { validForSeconds: 31 }, { slots: null }, { slots: [null] },
    { slots: [{ ...data.slots[0], end: data.slots[1].end }] }, { slots: [data.slots[0], data.slots[0]] },
  ]) await assert.rejects(request({ ...data, ...patch }));
  await assert.rejects(request(null));
  await assert.rejects(checkedAvailability("https://calendar.example.invalid/api/availability", selection, DAY, {
    fetchImpl: async () => json({ error: "private" }, 503),
  }), /could not be checked/);
});

test("browser request latency cannot extend freshness and cancellation reaches fetch", async () => {
  const { service } = fixture();
  const data = await service.getAvailability(input());
  const selection = { id: "mentorship", duration: 30, priceInr: 499 };
  let clock = START;
  const result = await checkedAvailability("https://calendar.example.invalid/api/availability", selection, DAY, {
    now: () => clock,
    fetchImpl: async () => { clock += 5000; return json(data); },
  });
  assert.equal(result.expiresAt - clock, 25000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkedAvailability("https://calendar.example.invalid/api/availability", selection, DAY, {
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      assert.equal(options.signal.aborted, true);
      options.signal.throwIfAborted();
    },
  }), { name: "AbortError" });
});
