import { paymentNote, preferredSlots, selectedSlot, todayInIST } from "./booking-slots.js";

const root = document.querySelector("#direct-sessions");
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
  const note = root.querySelector("#booking-note");
  const emailLink = root.querySelector("[data-booking-email]");
  const payLink = root.querySelector("[data-booking-pay]");
  const copyButton = root.querySelector("[data-copy-booking-note]");
  const copyStatus = root.querySelector("#booking-copy-status");
  const prices = [...root.querySelectorAll("[data-service-id]")].map((row) => ({
    id: row.dataset.serviceId,
    name: row.querySelector("dt").firstChild.textContent.trim(),
    duration: Number.parseInt(row.querySelector("dt span").textContent, 10),
    priceInr: Number(row.querySelector("data").value),
  }));

  if (prices.length !== 5 || new Set(prices.map((service) => service.id)).size !== 5
    || prices.some((service) => !service.name || ![30, 60].includes(service.duration)
      || !Number.isSafeInteger(service.priceInr) || service.priceInr < 1)) {
    console.error("The booking picker price list is invalid; the email-first fallback remains available.");
  } else {
    for (const service of prices) {
      const optionName = service.id === "dsa-mock" ? "Coding / DSA interview" : service.name;
      serviceInput.add(new Option(optionName, service.id));
    }

    function resetReview() {
      review.hidden = true;
      note.value = "";
      copyStatus.textContent = "";
    }

    function updateTimes() {
      const previousTime = timeInput.value;
      dateInput.min = todayInIST();
      dateInput.setCustomValidity("");
      timeInput.setCustomValidity("");
      timeInput.replaceChildren(new Option("Choose a time", ""));
      timeInput.disabled = true;
      resetReview();
      const service = prices.find((item) => item.id === serviceInput.value);
      serviceDetails.textContent = service ? `${service.duration} minutes / INR ${service.priceInr}` : "";
      if (!service || !dateInput.value) {
        status.textContent = "Choose a service and date to see preferred times in IST.";
        return;
      }
      if (dateInput.value < dateInput.min) {
        dateInput.setCustomValidity("Choose today or a future date in IST.");
        status.textContent = "That date has passed in IST. Choose a future date.";
        return;
      }
      let slots;
      try {
        slots = preferredSlots(dateInput.value, service.duration);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        dateInput.setCustomValidity(error.message);
        status.textContent = error.message;
        return;
      }
      if (!slots.length) {
        status.textContent = "No future times remain within these hours. Choose another date.";
        return;
      }
      for (const slot of slots) timeInput.add(new Option(slot.label, slot.time));
      timeInput.disabled = false;
      if (slots.some((slot) => slot.time === previousTime)) timeInput.value = previousTime;
      status.textContent = "Times follow the published hours, not live calendar availability.";
    }

    function validateSelection() {
      dateInput.min = todayInIST();
      dateInput.setCustomValidity("");
      timeInput.setCustomValidity("");
      if (!form.reportValidity()) return null;
      const service = prices.find((item) => item.id === serviceInput.value);
      if (!service) {
        status.textContent = "Choose one of the listed services.";
        serviceInput.focus();
        return null;
      }
      try {
        const slot = selectedSlot(dateInput.value, timeInput.value, service.duration);
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
      note.value = paymentNote(service, date, slot);
      const body = `Hi Nikhil,\r\n\r\nI would like to request this session:\r\n${note.value}\r\n\r\nPlease confirm availability before I pay.\r\n`;
      emailLink.href = `mailto:kumarnikhil374@gmail.com?subject=${encodeURIComponent(`${service.name} session request`)}&body=${encodeURIComponent(body)}`;
      review.hidden = false;
      status.textContent = "Preference ready to review. No slot has been reserved.";
    }

    serviceInput.addEventListener("change", updateTimes);
    dateInput.addEventListener("input", updateTimes);
    timeInput.addEventListener("change", () => {
      timeInput.setCustomValidity("");
      resetReview();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selection = validateSelection();
      if (!selection) return;
      showReview(selection);
      root.querySelector("#booking-review-title").focus();
    });
    for (const link of [emailLink, payLink]) {
      link.addEventListener("click", (event) => {
        const selection = validateSelection();
        if (!selection) {
          event.preventDefault();
          resetReview();
          return;
        }
        showReview(selection);
      });
    }
    copyButton.addEventListener("click", async () => {
      const selection = validateSelection();
      if (!selection) return;
      showReview(selection);
      const copiedNote = note.value;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable.");
        await navigator.clipboard.writeText(copiedNote);
        if (note.value === copiedNote && !review.hidden) {
          copyStatus.textContent = "Payment note copied. Paste it into the note field on Razorpay.";
        }
      } catch {
        if (note.value !== copiedNote || review.hidden) {
          status.textContent = "The selection changed. Review the session again before copying its note.";
          return;
        }
        note.focus();
        note.select();
        copyStatus.textContent = "Automatic copying is unavailable. Copy the selected note manually.";
      }
    });
    function refreshClock() {
      if (document.hidden) return;
      const wasReviewed = !review.hidden;
      updateTimes();
      if (wasReviewed && timeInput.value && !timeInput.disabled && dateInput.validity.valid) {
        const selection = validateSelection();
        if (selection) showReview(selection);
      }
    }
    window.addEventListener("pageshow", refreshClock);
    document.addEventListener("visibilitychange", refreshClock);
    updateTimes();
    picker.hidden = false;
    fallback.hidden = true;
  }
}
