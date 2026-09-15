export function bookingEndpoint(configured, currentHref = location.href) {
  if (!configured) return "";
  const page = new URL(currentHref);
  const endpoint = new URL(configured, page);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new TypeError("Booking endpoint must be HTTPS, except local loopback testing.");
  }
  if (endpoint.search || endpoint.hash) throw new TypeError("Booking endpoint cannot include query or fragment values.");
  return endpoint.href.replace(/\/$/, "");
}

async function postJson(endpoint, path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error("The booking service returned an unreadable response."); }
  if (!response.ok) {
    const error = new Error(data?.error || "booking_failed");
    error.code = data?.error;
    throw error;
  }
  return data;
}

export async function createBookingIntent(endpoint, selection, customer) {
  const data = await postJson(endpoint, "/api/bookings/intent", {
    serviceId: selection.service.id,
    date: selection.date,
    time: selection.slot.time,
    customerName: customer.name,
    customerEmail: customer.email,
  });
  if (!data || typeof data !== "object" || !data.checkout || !data.booking
    || typeof data.checkout.key !== "string" || typeof data.checkout.order_id !== "string"
    || data.checkout.amount !== selection.service.priceInr * 100 || data.checkout.currency !== "INR"
    || data.booking.serviceId !== selection.service.id || data.booking.date !== selection.date
    || data.booking.time !== selection.slot.time) {
    throw new Error("The booking service returned mismatched checkout details.");
  }
  return data;
}

export async function confirmCheckout(endpoint, response) {
  const data = await postJson(endpoint, "/api/payments/checkout-callback", {
    razorpay_order_id: response?.razorpay_order_id,
    razorpay_payment_id: response?.razorpay_payment_id,
    razorpay_signature: response?.razorpay_signature,
  });
  if (!data?.booking?.status) throw new Error("The booking confirmation response was invalid.");
  return data.booking;
}
