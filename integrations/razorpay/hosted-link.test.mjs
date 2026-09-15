import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APPROVED_PRICES_PAISE, SERVICES } from "./payment-model.mjs";

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"), "utf8");
const section = html.match(/<section\b[^>]*id="direct-sessions"[^>]*>([\s\S]*?)<\/section>/)?.[1];

test("classic direct-session prices and durations match the approved server catalog", () => {
  assert.ok(section, "The direct-session section must exist in the static HTML.");
  const rows = [...section.matchAll(
    /<div data-service-id="([^"]+)"><dt>[^<]+<span>(\d+) minutes<\/span><\/dt><dd><data value="(\d+)">&#8377;(\d+)<\/data><\/dd><\/div>/g,
  )];
  assert.equal(rows.length, SERVICES.length);
  assert.equal(new Set(rows.map((row) => row[1])).size, SERVICES.length);
  for (const [, id, minutes, value, displayedPrice] of rows) {
    assert.equal(Number(value) * 100, APPROVED_PRICES_PAISE[id], `Wrong price for ${id}.`);
    assert.equal(value, displayedPrice, `Displayed price differs from its data value for ${id}.`);
    assert.equal(Number(minutes), SERVICES.find((service) => service.id === id)?.durationMinutes);
  }
});

test("Standard Checkout is explicit and no unverified hosted-payment fallback remains", () => {
  assert.ok(section);
  assert.doesNotMatch(section, /razorpay\.me/i);
  assert.match(html, /data-booking-api="https:\/\/nikhil-bookings-api-otzn3ne7rq-el\.a\.run\.app"/);
  assert.match(section, /data-booking-pay>Pay with Razorpay/);
  assert.match(section, /id="direct-payment-note"/);
  assert.match(section, /Booking is confirmed only after verified payment\./);
  assert.match(section, /confirmed payments receive a Google Calendar invitation/i);
  assert.doesNotMatch(section, /<(?:iframe|script)\b/);
  assert.match(section, /data-slot-picker hidden/);
  assert.match(section, /<div data-booking-fallback>/);
  assert.match(section, /do not send payment until the service is restored/i);
  assert.match(section, /live Google Calendar availability is not connected/);
  assert.match(section, /After a verified captured payment/);
});

test("direct sessions retain an email-first path and separate Topmate pricing", () => {
  assert.ok(section);
  assert.match(section, /href="mailto:kumarnikhil374@gmail\.com\?subject=Direct%20session%20enquiry"/);
  assert.match(section, /Topmate bookings follow the pricing shown on Topmate/);
  assert.match(html, /href="#direct-sessions"/);
  for (const serviceId of ["12607", "12608", "445164", "457759"]) {
    assert.ok(html.includes(`href="https://topmate.io/nikhil_kr/${serviceId}"`));
  }
});

test("browser modules use JavaScript filenames compatible with the static preview server", () => {
  assert.match(html, /<script type="module" src="assets\/booking\.js"><\/script>/);
  const browserScript = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "booking.js"), "utf8");
  assert.match(browserScript, /from "\.\/booking-slots\.js"/);
  assert.doesNotMatch(browserScript, /from ["'][^"']+\.mjs["']/);
  assert.match(browserScript, /payment\.failed/);
  assert.match(section, /aria-describedby="booking-service-details"/);
});
