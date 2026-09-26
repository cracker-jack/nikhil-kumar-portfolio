const GRAPH_VERSION = /^v\d+\.\d+$/;
const PHONE_NUMBER_ID = /^\d{5,32}$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;

export class WhatsAppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WhatsAppError";
    this.code = code;
  }
}

function required(value, pattern, code, message) {
  if (typeof value !== "string" || !pattern.test(value.trim())) throw new WhatsAppError(code, message);
  return value.trim();
}

export class WhatsAppCloudApi {
  #accessToken;
  #phoneNumberId;
  #templateName;
  #languageCode;
  #graphVersion;
  #fetch;

  constructor({
    accessToken,
    phoneNumberId,
    templateName = "booking_confirmation",
    languageCode = "en",
    graphVersion,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.#accessToken = required(accessToken, /^\S{20,4096}$/, "invalid_whatsapp_token",
      "Configure a valid WhatsApp access token.");
    this.#phoneNumberId = required(phoneNumberId, PHONE_NUMBER_ID, "invalid_whatsapp_phone_number_id",
      "Configure a valid WhatsApp phone number ID.");
    this.#templateName = required(templateName, TEMPLATE_NAME, "invalid_whatsapp_template",
      "Configure a valid WhatsApp template name.");
    this.#languageCode = required(languageCode, LANGUAGE, "invalid_whatsapp_language",
      "Configure a valid WhatsApp template language.");
    this.#graphVersion = required(graphVersion, GRAPH_VERSION, "invalid_whatsapp_graph_version",
      "Configure an explicit WhatsApp Graph API version.");
    if (typeof fetchImpl !== "function") throw new WhatsAppError("invalid_whatsapp_fetch", "Configure a valid fetch implementation.");
    this.#fetch = fetchImpl;
  }

  async sendBookingConfirmation({
    phone,
    customerName,
    serviceName,
    confirmedTime,
    bookingId,
    paymentReference,
  } = {}) {
    const destination = required(phone, /^\+[1-9]\d{7,14}$/, "invalid_whatsapp_destination",
      "WhatsApp destination must use international format.");
    const values = [customerName, serviceName, confirmedTime, bookingId, paymentReference];
    if (values.some((value) => typeof value !== "string" || !value.trim() || value.length > 180)) {
      throw new WhatsAppError("invalid_whatsapp_message", "WhatsApp confirmation data is invalid.");
    }
    const response = await this.#fetch(
      `https://graph.facebook.com/${this.#graphVersion}/${this.#phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: destination.slice(1),
          type: "template",
          template: {
            name: this.#templateName,
            language: { code: this.#languageCode },
            components: [{
              type: "body",
              parameters: values.map((text) => ({ type: "text", text: text.trim() })),
            }],
          },
        }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    let body;
    try { body = await response.json(); }
    catch { throw new WhatsAppError("whatsapp_unreadable_response", "WhatsApp returned an unreadable response."); }
    if (!response.ok) {
      const providerCode = body?.error?.code;
      throw new WhatsAppError(
        "whatsapp_delivery_failed",
        `WhatsApp rejected the confirmation${Number.isInteger(providerCode) ? ` (${providerCode})` : ""}.`,
      );
    }
    const messageId = body?.messages?.[0]?.id;
    if (typeof messageId !== "string" || !messageId) {
      throw new WhatsAppError("whatsapp_invalid_response", "WhatsApp did not return a message identifier.");
    }
    return Object.freeze({ messageId });
  }
}

export function createWhatsAppFromEnv(env, options = {}) {
  const values = [
    env.WHATSAPP_ACCESS_TOKEN,
    env.WHATSAPP_PHONE_NUMBER_ID,
    env.WHATSAPP_GRAPH_API_VERSION,
  ].map((value) => value?.trim()).filter(Boolean);
  if (!values.length) return null;
  if (values.length !== 3) {
    throw new WhatsAppError("incomplete_whatsapp_configuration",
      "WhatsApp access token, phone number ID, and Graph API version must be configured together.");
  }
  return new WhatsAppCloudApi({
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    graphVersion: env.WHATSAPP_GRAPH_API_VERSION,
    templateName: env.WHATSAPP_TEMPLATE_NAME || "booking_confirmation",
    languageCode: env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    ...options,
  });
}
