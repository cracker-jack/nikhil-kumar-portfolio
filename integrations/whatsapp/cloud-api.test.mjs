import assert from "node:assert/strict";
import { test } from "node:test";
import { WhatsAppCloudApi, createWhatsAppFromEnv } from "./cloud-api.mjs";

const CONFIG = Object.freeze({
  accessToken: "test_access_token_that_is_long_enough",
  phoneNumberId: "123456789012345",
  graphVersion: "v24.0",
});

test("WhatsApp Cloud API sends the approved utility template without exposing the token", async () => {
  let request;
  const client = new WhatsAppCloudApi({
    ...CONFIG,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.fixture" }] }));
    },
  });
  const result = await client.sendBookingConfirmation({
    phone: "+919876543210",
    customerName: "Nikhil Kumar",
    serviceName: "Mentorship",
    confirmedTime: "23 September 2026, 4:00 PM - 4:30 PM IST",
    bookingId: "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
    paymentReference: "pay_fixture",
  });
  assert.equal(result.messageId, "wamid.fixture");
  assert.equal(request.url, "https://graph.facebook.com/v24.0/123456789012345/messages");
  assert.equal(request.options.headers.Authorization, "Bearer test_access_token_that_is_long_enough");
  const body = JSON.parse(request.options.body);
  assert.equal(body.to, "919876543210");
  assert.equal(body.template.name, "booking_confirmation");
  assert.deepEqual(body.template.components[0].parameters.map((parameter) => parameter.text), [
    "Nikhil Kumar",
    "Mentorship",
    "23 September 2026, 4:00 PM - 4:30 PM IST",
    "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
    "pay_fixture",
  ]);
  assert.ok(!JSON.stringify(body).includes(CONFIG.accessToken));
});

test("WhatsApp configuration is disabled when empty and rejects partial values", () => {
  assert.equal(createWhatsAppFromEnv({}), null);
  assert.throws(() => createWhatsAppFromEnv({
    WHATSAPP_ACCESS_TOKEN: CONFIG.accessToken,
  }), { code: "incomplete_whatsapp_configuration" });
});

test("WhatsApp rejects invalid destinations and provider failures", async () => {
  const client = new WhatsAppCloudApi({
    ...CONFIG,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 131000 } }), { status: 400 }),
  });
  const message = {
    customerName: "Nikhil Kumar",
    serviceName: "Mentorship",
    confirmedTime: "23 September 2026, 4:00 PM IST",
    bookingId: "bk_aaaaaaaaaaaaaaaaaaaaaaaa",
    paymentReference: "pay_fixture",
  };
  await assert.rejects(client.sendBookingConfirmation({ ...message, phone: "9876543210" }),
    { code: "invalid_whatsapp_destination" });
  await assert.rejects(client.sendBookingConfirmation({ ...message, phone: "+919876543210" }),
    { code: "whatsapp_delivery_failed" });
});
