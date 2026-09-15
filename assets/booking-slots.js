export const TIME_ZONE = "Asia/Kolkata";
const MINUTE = 60000;
const IST_OFFSET = 330 * MINUTE;

function clockTime(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("A valid current time is required.");
  return now.getTime();
}

function parseDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.length !== 10) {
    throw new RangeError("Choose a valid date.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new RangeError("Choose a valid date.");
  }
  return utc;
}

export function todayInIST(now = new Date()) {
  return new Date(clockTime(now) + IST_OFFSET).toISOString().slice(0, 10);
}

export function formatTime(minutes) {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function preferredSlots(date, durationMinutes, now = new Date()) {
  const day = parseDate(date);
  if (![30, 60].includes(durationMinutes)) throw new RangeError("Choose a 30-minute or 60-minute session.");
  const nowMs = clockTime(now);
  const weekend = [0, 6].includes(day.getUTCDay());
  const open = (weekend ? 11 : 16) * 60;
  const close = 23 * 60;
  const midnight = day.getTime() - IST_OFFSET;
  const slots = [];
  for (let minute = open; minute + durationMinutes <= close; minute += 30) {
    const start = midnight + minute * MINUTE;
    if (start <= nowMs) continue;
    slots.push(Object.freeze({
      time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
      label: `${formatTime(minute)} - ${formatTime(minute + durationMinutes)}`,
      start: new Date(start).toISOString(),
      end: new Date(start + durationMinutes * MINUTE).toISOString(),
    }));
  }
  return slots;
}

export function selectedSlot(date, time, durationMinutes, now = new Date()) {
  const slot = preferredSlots(date, durationMinutes, now).find((candidate) => candidate.time === time);
  if (!slot) throw new RangeError("Choose a future time within the session hours. Your earlier selection may have passed.");
  return slot;
}

export function paymentNote(service, date, slot) {
  return `${service.name} | ${date} | ${slot.label} IST | INR ${service.priceInr} | Time not confirmed`;
}
