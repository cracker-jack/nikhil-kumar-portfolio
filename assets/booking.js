import { preferredSlots, selectedSlot, todayInIST } from "./booking-slots.js";
import { availabilityEndpoint, checkedAvailability } from "./availability-client.js";
import {
  bookingCapabilities, bookingEndpoint, confirmCheckout, createBookingIntent,
} from "./booking-api-client.js";

const root = document.querySelector("#direct-sessions");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
if (root) {
  const picker = root.querySelector("[data-slot-picker]");
  const fallback = root.querySelector("[data-booking-fallback]");
  const form = root.querySelector("[data-booking-form]");
  const serviceInput = root.querySelector("#booking-service");
  const serviceDetails = root.querySelector("#booking-service-details");
  const dateInput = root.querySelector("#booking-date");
  const timeInput = root.querySelector("#booking-time");
  const status = root.querySelector("#booking-status");
  const review = root.querySelector("[data-booking-review]");
  const payLink = root.querySelector("[data-booking-pay]");
  const nameInput = root.querySelector("#booking-name");
  const emailInput = root.querySelector("#booking-email");
  const customerFields = root.querySelectorAll("[data-customer-field]");
  const whatsappOption = root.querySelector("[data-whatsapp-option]");
  const whatsappConsent = root.querySelector("#booking-whatsapp-consent");
  const whatsappPhoneGroup = root.querySelector("[data-whatsapp-phone]");
  const whatsappPhone = root.querySelector("#booking-phone");
  const calendarFailure = root.querySelector("[data-calendar-failure]");
  const slotOptions = root.querySelector("[data-slot-options]");
  const timeSelect = root.querySelector(".booking-time-select");
  const serviceOutcome = root.querySelector("[data-service-outcome]");
  const serviceOutcomeCopy = root.querySelector("[data-service-outcome-copy]");
  const slotRecovery = root.querySelector("[data-slot-recovery]");
  const confirmation = root.querySelector("[data-booking-confirmation]");
  const confirmationTitle = root.querySelector("#booking-confirmation-title");
  const confirmationMessage = root.querySelector("[data-confirmation-message]");
  const confirmationService = root.querySelector("[data-confirmation-service]");
  const confirmationTime = root.querySelector("[data-confirmation-time]");
  const confirmationBookingReference = root.querySelector("[data-confirmation-booking-reference]");
  const confirmationPaymentReference = root.querySelector("[data-confirmation-payment-reference]");
  const confirmationCalendarLink = root.querySelector("[data-confirmation-calendar-link]");
  const confirmationWhatsApp = root.querySelector("[data-confirmation-whatsapp]");
  const bookAnotherButton = root.querySelector("[data-book-another]");
  let endpoint = "";
  let bookingApi = "";
  let configurationError = false;
  try {
    endpoint = availabilityEndpoint(root.dataset.availabilityApi, location.href);
    bookingApi = bookingEndpoint(root.dataset.bookingApi, location.href);
  } catch {
    configurationError = true;
    console.error("The calendar endpoint configuration is invalid; use the email-first fallback.");
  }
  const prices = [...root.querySelectorAll("[data-service-id]")].map((row) => ({
    id: row.dataset.serviceId,
    name: row.querySelector("dt").firstChild.textContent.trim(),
    duration: Number.parseInt(row.querySelector("dt span").textContent, 10),
    priceInr: Number(row.querySelector("data").value),
  }));
  const serviceOutcomes = Object.freeze({
    mentorship: "Bring a career decision, interview plan, or engineering question to work through together.",
    "resume-review": "Bring your current resume to review its clarity, evidence, and alignment with the roles you want.",
    "hld-mock": "Practice a high-level design interview and discuss requirements, trade-offs, and how you communicate your approach.",
    "lld-mock": "Practice designing a focused component with attention to interfaces, edge cases, and the reasoning behind your choices.",
    "dsa-mock": "Work through a coding problem and discuss your approach, complexity, trade-offs, and interview communication.",
  });

  if (configurationError || prices.length !== 5 || new Set(prices.map((service) => service.id)).size !== 5
    || prices.some((service) => !service.name || ![30, 60].includes(service.duration)
      || !Number.isSafeInteger(service.priceInr) || service.priceInr < 1)) {
    if (!configurationError) console.error("The booking picker price list is invalid; the email-first fallback remains available.");
  } else {
    let serial = 0;
    let inFlight;
    let calendarResult;
    let razorpayScript;
    let checkoutInProgress = false;
    let bookingComplete = false;
    function enforceDateFloor() {
      const minimum = todayInIST();
      dateInput.min = minimum;
      if (dateInput.value && dateInput.value < minimum) {
        dateInput.value = "";
        timeInput.replaceChildren(new Option("Choose a time", ""));
        timeInput.disabled = true;
        resetReview();
        status.textContent = "Older dates are unavailable. Choose today or a future date in IST.";
      }
      return minimum;
    }

    if (endpoint) {
      root.querySelector("#booking-notice").textContent = bookingApi
        ? "Times are checked against my Google Calendar. Your slot is confirmed only after verified Razorpay payment and a calendar invite."
        : "Times are checked against my Google Calendar. Selecting a time does not reserve it or confirm a booking. Please agree the slot with me before paying.";
    }
    if (bookingApi) {
      for (const field of customerFields) field.hidden = false;
      nameInput.required = true;
      emailInput.required = true;
      bookingCapabilities(bookingApi).then((capabilities) => {
        if (capabilities.whatsappConfirmationEnabled) whatsappOption.hidden = false;
      }).catch(() => {
        whatsappOption.hidden = true;
      });
    }
    for (const service of prices) {
      const optionName = service.id === "dsa-mock" ? "Coding / DSA interview" : service.name;
      serviceInput.add(new Option(optionName, service.id));
    }

    function resetReview() {
      review.hidden = true;
    }

    function resetSlotOptions() {
      slotOptions.replaceChildren();
      slotOptions.hidden = true;
      timeSelect.hidden = false;
    }

    function updateServiceOutcome(service) {
      const outcome = service && serviceOutcomes[service.id];
      serviceOutcome.hidden = !outcome;
      serviceOutcomeCopy.textContent = outcome || "";
    }

    function updateSlotRecovery(service) {
      if (!service || !dateInput.value) {
        slotRecovery.hidden = true;
        return;
      }
      const subject = `Direct session request: ${service.name}`;
      const body = [
        "Hello Nikhil,",
        "",
        `I would like to book a ${service.name} session.`,
        `My preferred date is ${dateInput.value} (IST).`,
        "Please share another available time.",
      ].join("\n");
      const link = slotRecovery.querySelector("a");
      link.href = `mailto:kumarnikhil374@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      slotRecovery.hidden = false;
    }

    function renderSlotOptions(slots) {
      resetSlotOptions();
      const groups = new Map();
      for (const slot of slots) {
        const hour = Number.parseInt(slot.time.slice(0, 2), 10);
        const label = hour < 18 ? "Daytime" : "Evening";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(slot);
      }
      for (const [label, groupSlots] of groups) {
        const group = document.createElement("div");
        group.className = "booking-slot-group";
        const heading = document.createElement("p");
        heading.className = "booking-slot-group-title";
        heading.textContent = label;
        const chips = document.createElement("div");
        chips.className = "booking-slot-chips";
        for (const slot of groupSlots) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "booking-slot-chip";
          button.dataset.slotTime = slot.time;
          button.setAttribute("aria-pressed", "false");
          button.textContent = slot.label;
          chips.append(button);
        }
        group.append(heading, chips);
        slotOptions.append(group);
      }
      timeSelect.hidden = true;
      slotOptions.hidden = false;
    }

    function selectSlot(time, { reset = true } = {}) {
      timeInput.value = time;
      for (const button of slotOptions.querySelectorAll("[data-slot-time]")) {
        const selected = button.dataset.slotTime === time;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      }
      if (reset) {
        timeInput.setCustomValidity("");
        resetReview();
      }
    }

    function resetPicker() {
      serial++;
      inFlight?.abort();
      inFlight = undefined;
      calendarResult = undefined;
      form.reset();
      serviceDetails.textContent = "";
      timeInput.replaceChildren(new Option("Choose a time", ""));
      timeInput.disabled = true;
      resetSlotOptions();
      updateServiceOutcome();
      calendarFailure.hidden = true;
      slotRecovery.hidden = true;
      resetReview();
      whatsappPhoneGroup.hidden = true;
      whatsappPhone.required = false;
      whatsappPhone.setCustomValidity("");
    }

    function showConfirmation(booking, selection, customer, response) {
      bookingComplete = true;
      checkoutInProgress = false;
      const serviceName = booking.serviceName || selection.service.name;
      const slotLabel = booking.slotLabel || selection.slot.label;
      const customerEmail = booking.customerEmail || customer.email;
      resetPicker();
      form.hidden = true;
      confirmationService.textContent = serviceName;
      confirmationTime.textContent = `${booking.date || selection.date}, ${slotLabel} IST`;
      confirmationBookingReference.textContent = booking.bookingId;
      confirmationPaymentReference.textContent = booking.paymentReference || response.razorpay_payment_id;
      confirmationMessage.textContent = `Payment is verified. A Google Calendar invitation was sent to ${customerEmail}. Keep the booking reference below if you need help.`;
      if (booking.whatsapp?.requested) {
        confirmationWhatsApp.textContent = booking.whatsapp.status === "sent"
          ? `A WhatsApp confirmation was also sent to ${customer.phone}.`
          : "Your booking is confirmed, but the optional WhatsApp confirmation could not be sent. Your email and calendar invitation remain valid.";
        confirmationWhatsApp.hidden = false;
      } else {
        confirmationWhatsApp.hidden = true;
        confirmationWhatsApp.textContent = "";
      }
      if (booking.calendarEvent?.eventLink) {
        confirmationCalendarLink.href = booking.calendarEvent.eventLink;
        confirmationCalendarLink.hidden = false;
      } else {
        confirmationCalendarLink.removeAttribute("href");
        confirmationCalendarLink.hidden = true;
      }
      confirmation.hidden = false;
      status.textContent = "";
      confirmationTitle.focus();
    }

    async function updateTimes({ preserveReview = false } = {}) {
      if (bookingComplete || checkoutInProgress) return;
      const request = ++serial;
      inFlight?.abort();
      inFlight = undefined;
      const wasReviewed = preserveReview && !review.hidden;
      const reviewFocus = wasReviewed && review.contains(document.activeElement) ? document.activeElement : null;
      const previousTime = timeInput.value;
      const minimumDate = enforceDateFloor();
      dateInput.setCustomValidity("");
      timeInput.setCustomValidity("");
      timeInput.replaceChildren(new Option("Choose a time", ""));
      timeInput.disabled = true;
      resetSlotOptions();
      calendarResult = undefined;
      calendarFailure.hidden = true;
      slotRecovery.hidden = true;
      resetReview();
      const service = prices.find((item) => item.id === serviceInput.value);
      serviceDetails.textContent = service ? `${service.duration} minutes / INR ${service.priceInr}` : "";
      updateServiceOutcome(service);
      if (!service || !dateInput.value) {
        status.textContent = "Choose a session and date to see calendar-checked times in IST.";
        return;
      }
      if (dateInput.value < minimumDate) {
        dateInput.setCustomValidity("Choose today or a future date in IST.");
        status.textContent = "That date has passed in IST. Choose a future date.";
        return;
      }
      let slots;
      try {
        if (endpoint) {
          status.textContent = "Checking Google Calendar availability...";
          inFlight = new AbortController();
          const result = await checkedAvailability(endpoint, service, dateInput.value, { signal: inFlight.signal });
          if (request !== serial) return;
          calendarResult = result;
          slots = result.slots;
        } else {
          slots = preferredSlots(dateInput.value, service.duration);
        }
      } catch (error) {
        if (request !== serial) return;
        if (endpoint) {
          calendarFailure.hidden = false;
          status.textContent = "Calendar availability could not be checked. No times have been marked as free.";
          return;
        }
        if (!(error instanceof RangeError)) throw error;
        dateInput.setCustomValidity(error.message);
        status.textContent = error.message;
        return;
      }
      if (!slots.length) {
        status.textContent = endpoint
          ? "No calendar-free times fit this session on this date. Choose another date or request another time by email."
          : "No future times remain within these hours. Choose another date.";
        if (endpoint) updateSlotRecovery(service);
        return;
      }
      for (const slot of slots) timeInput.add(new Option(slot.label, slot.time));
      timeInput.disabled = false;
      renderSlotOptions(slots);
      if (slots.some((slot) => slot.time === previousTime)) selectSlot(previousTime, { reset: false });
      status.textContent = endpoint
        ? "Calendar checked. Select a time to continue."
        : "Times follow the published hours, not live calendar availability.";
      if (wasReviewed && timeInput.value) {
        const selection = validateSelection();
        if (selection) {
          showReview(selection);
          if (reviewFocus && document.activeElement === document.body) reviewFocus.focus({ preventScroll: true });
        }
      } else if (wasReviewed && previousTime) {
        status.textContent = "Your selected time is no longer available. Choose another time; no booking was created here.";
      }
    }

    function calendarExpired() {
      return endpoint && (!calendarResult || calendarResult.expiresAt <= Date.now());
    }

    function validateSelection() {
      const minimumDate = enforceDateFloor();
      dateInput.setCustomValidity("");
      timeInput.setCustomValidity("");
      if (!form.reportValidity()) return null;
      if (dateInput.value < minimumDate) {
        dateInput.setCustomValidity("Choose today or a future date in IST.");
        dateInput.reportValidity();
        dateInput.setCustomValidity("");
        status.textContent = "Older dates are unavailable. Choose today or a future date in IST.";
        return null;
      }
      const service = prices.find((item) => item.id === serviceInput.value);
      if (!service) {
        status.textContent = "Choose one of the listed services.";
        serviceInput.focus();
        return null;
      }
      try {
        const slot = selectedSlot(dateInput.value, timeInput.value, service.duration);
        if (endpoint && (calendarExpired() || !calendarResult.slots.some((item) => item.time === timeInput.value))) {
          resetReview();
          status.textContent = "Recheck calendar availability before continuing.";
          return null;
        }
        return { service, slot, date: dateInput.value };
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        resetReview();
        status.textContent = error.message;
        timeInput.setCustomValidity(error.message);
        timeInput.reportValidity();
        return null;
      }
    }

    function showReview(selection) {
      const { service, date, slot } = selection;
      root.querySelector("[data-review-service]").textContent = `${service.name} (${service.duration} minutes)`;
      root.querySelector("[data-review-date]").textContent = `${date}, ${slot.label} IST`;
      root.querySelector("[data-review-price]").textContent = `INR ${service.priceInr}`;
      review.hidden = false;
      status.textContent = bookingApi ? "Review the session details, then continue to secure payment." : "Review the session details. No payment has been started.";
    }

    function customerDetails() {
      if (!bookingApi) return {};
      const name = nameInput.value.trim().replace(/\s+/g, " ");
      const email = emailInput.value.trim().toLowerCase();
      if (name.length < 2) {
        nameInput.setCustomValidity("Enter your name.");
        nameInput.reportValidity();
        nameInput.setCustomValidity("");
        return null;
      }
      if (!emailInput.validity.valid || !EMAIL_PATTERN.test(email)) {
        emailInput.setCustomValidity("Enter a valid email address.");
        emailInput.reportValidity();
        emailInput.setCustomValidity("");
        return null;
      }
      if (!whatsappOption.hidden && whatsappConsent.checked) {
        const phone = whatsappPhone.value.trim().replace(/[\s()-]/g, "");
        if (!E164_PATTERN.test(phone)) {
          whatsappPhone.setCustomValidity("Use international format, such as +919876543210.");
          whatsappPhone.reportValidity();
          whatsappPhone.setCustomValidity("");
          return null;
        }
        return { name, email, phone, whatsappConsent: true };
      }
      return { name, email, whatsappConsent: false };
    }

    function loadRazorpay() {
      if (window.Razorpay) return Promise.resolve();
      if (razorpayScript) return razorpayScript;
      razorpayScript = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://checkout.razorpay.com/v1/checkout.js";
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded."));
        document.head.append(script);
      });
      return razorpayScript;
    }

    async function startCheckout(selection, customer) {
      payLink.disabled = true;
      status.textContent = "Creating a secure Razorpay order...";
      try {
        const intent = await createBookingIntent(bookingApi, selection, customer);
        await loadRazorpay();
        status.textContent = "Complete payment in Razorpay Checkout.";
        checkoutInProgress = true;
        const options = {
          ...intent.checkout,
          modal: {
            ondismiss() {
              if (bookingComplete) return;
              checkoutInProgress = false;
              payLink.disabled = false;
              status.textContent = "Payment was not completed. No booking was confirmed.";
            },
          },
          handler: async (response) => {
            status.textContent = "Verifying payment and creating your calendar invitation...";
            try {
              const booking = await confirmCheckout(bookingApi, response);
              payLink.disabled = false;
              if (booking.status === "confirmed") {
                showConfirmation(booking, selection, customer, response);
              } else if (booking.status === "paid_needs_manual_resolution") {
                checkoutInProgress = false;
                status.textContent = booking.resolutionReason === "calendar_invite_failed"
                  ? "Payment is verified, but Google Calendar could not send the invite. I will follow up by email."
                  : "Payment is verified, but the slot needs manual resolution. I will follow up by email.";
              } else {
                checkoutInProgress = false;
                status.textContent = "Payment is not captured yet. No booking is confirmed until Razorpay confirms capture.";
              }
            } catch {
              checkoutInProgress = false;
              payLink.disabled = false;
              status.textContent = "Payment verification could not be completed here. If Razorpay charged you, I will reconcile it manually.";
            }
          },
        };
        const checkout = new window.Razorpay(options);
        if (typeof checkout.on === "function") {
          checkout.on("payment.failed", () => {
            checkoutInProgress = false;
            payLink.disabled = false;
            status.textContent = "Payment failed in Razorpay. No booking was confirmed and no calendar invitation was sent.";
          });
        }
        checkout.open();
      } catch (error) {
        checkoutInProgress = false;
        payLink.disabled = false;
        status.textContent = error?.code === "slot_unavailable"
          ? "That time is no longer available. Choose another slot."
          : "Could not create a payment order. Please try again or email me.";
      }
    }

    serviceInput.addEventListener("change", updateTimes);
    dateInput.addEventListener("focus", enforceDateFloor);
    dateInput.addEventListener("click", enforceDateFloor);
    dateInput.addEventListener("input", updateTimes);
    timeInput.addEventListener("change", () => {
      selectSlot(timeInput.value);
    });
    slotOptions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-slot-time]");
      if (!button) return;
      selectSlot(button.dataset.slotTime);
    });
    whatsappConsent.addEventListener("change", () => {
      whatsappPhoneGroup.hidden = !whatsappConsent.checked;
      whatsappPhone.required = whatsappConsent.checked;
      whatsappPhone.setCustomValidity("");
      if (whatsappConsent.checked) whatsappPhone.focus();
      else whatsappPhone.value = "";
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitted = `${serviceInput.value}|${dateInput.value}|${timeInput.value}`;
      if (calendarExpired()) await updateTimes();
      if (`${serviceInput.value}|${dateInput.value}|${timeInput.value}` !== submitted
        || (endpoint && (!calendarResult || timeInput.disabled))) return;
      const selection = validateSelection();
      if (!selection) return;
      showReview(selection);
      root.querySelector("#booking-review-title").focus();
    });
    payLink.addEventListener("click", async (event) => {
      event.preventDefault();
      if (calendarExpired()) {
        await updateTimes({ preserveReview: true });
        if (!review.hidden) status.textContent = "Availability refreshed. Review the session and pay again to continue.";
        return;
      }
      const selection = validateSelection();
      if (!selection) {
        resetReview();
        return;
      }
      showReview(selection);
      const customer = customerDetails();
      if (bookingApi && customer) await startCheckout(selection, customer);
      else if (!bookingApi) status.textContent = "Secure Razorpay Checkout is unavailable. No payment was started.";
    });
    bookAnotherButton.addEventListener("click", () => {
      bookingComplete = false;
      confirmation.hidden = true;
      form.hidden = false;
      confirmationCalendarLink.hidden = true;
      confirmationCalendarLink.removeAttribute("href");
      confirmationWhatsApp.hidden = true;
      confirmationWhatsApp.textContent = "";
      resetPicker();
      enforceDateFloor();
      status.textContent = "Choose a session and date to see calendar-checked times in IST.";
      serviceInput.focus();
    });
    function refreshClock() {
      if (document.hidden || checkoutInProgress || bookingComplete) return;
      updateTimes({ preserveReview: true });
    }
    window.addEventListener("pageshow", refreshClock);
    document.addEventListener("visibilitychange", refreshClock);
    enforceDateFloor();
    updateTimes();
    picker.hidden = false;
    fallback.hidden = true;
  }
}
