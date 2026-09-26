import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingCapabilities, createBookingIntent } from "../../assets/booking-api-client.js";

test("browser client reads booking capabilities and sends WhatsApp data only with consent", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/capabilities")) {
      return new Response(JSON.stringify({
        bookingEnabled: true,
        whatsappConfirmationEnabled: true,
      }));
    }
    return new Response(JSON.stringify({
      checkout: { key: "rzp_test_fixture", order_id: "order_fixture", amount: 100, currency: "INR" },
      booking: { serviceId: "mentorship", date: "2026-09-24", time: "16:00" },
    }));
  };
  assert.deepEqual(await bookingCapabilities("https://booking.example.invalid"), {
    bookingEnabled: true,
    whatsappConfirmationEnabled: true,
  });
  const selection = {
    service: { id: "mentorship", priceInr: 1 },
    date: "2026-09-24",
    slot: { time: "16:00" },
  };
  await createBookingIntent("https://booking.example.invalid", selection, {
    name: "Nikhil Kumar",
    email: "user@example.com",
    phone: "+919876543210",
    whatsappConsent: true,
  });
  const optedIn = JSON.parse(requests[1].options.body);
  assert.equal(optedIn.customerPhone, "+919876543210");
  assert.equal(optedIn.whatsappConsent, true);
  await createBookingIntent("https://booking.example.invalid", selection, {
    name: "Nikhil Kumar",
    email: "user@example.com",
    whatsappConsent: false,
  });
  const declined = JSON.parse(requests[2].options.body);
  assert.equal("customerPhone" in declined, false);
  assert.equal("whatsappConsent" in declined, false);
});
