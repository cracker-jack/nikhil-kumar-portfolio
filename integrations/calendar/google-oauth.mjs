import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REDIRECT_URI = "http://127.0.0.1:4174/oauth/google/callback";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const SCOPES = Object.freeze(["openid", "email", CALENDAR_SCOPE, CALENDAR_EVENTS_SCOPE]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRIMARY_CALENDAR = "primary";

export class CalendarAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CalendarAuthError";
    this.code = code;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new CalendarAuthError(code, message);
}

function nonblank(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\r\n\0]/.test(value);
}

function uniqueCalendars(values) {
  const ids = [];
  for (const value of values) {
    requireValue(nonblank(value), "CALENDAR_ID_REQUIRED", "Calendar identifiers must be non-empty private values.");
    if (!ids.includes(value)) ids.push(value);
  }
  return Object.freeze(ids);
}

export function assertPrivateTokenPath(path, repoRoot = REPO_ROOT) {
  requireValue(nonblank(path) && isAbsolute(path) && path.endsWith(".json"),
    "PRIVATE_PATH_REQUIRED", "GOOGLE_TOKEN_FILE must be an absolute JSON file path outside the website repository.");
  const lexical = relative(resolve(repoRoot), resolve(dirname(path)));
  requireValue(lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical),
    "PUBLIC_TOKEN_PATH", "OAuth tokens must never be saved through a path inside the website repository.");
  requireValue(existsSync(dirname(path)), "PRIVATE_FOLDER_REQUIRED", "Create the private token folder before connecting.");
  const parent = realpathSync(dirname(path));
  const repo = realpathSync(repoRoot);
  const location = relative(repo, parent);
  requireValue(location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location),
    "PUBLIC_TOKEN_PATH", "OAuth tokens must never be saved inside the website repository.");
  if (existsSync(path)) {
    const file = lstatSync(path);
    requireValue(file.isFile() && !file.isSymbolicLink(), "INVALID_TOKEN_FILE", "The token destination must be a regular private file.");
  }
  return resolve(parent, basename(path));
}

export function loadConfig(env) {
  requireValue(nonblank(env.GOOGLE_CLIENT_ID) && /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID),
    "GOOGLE_CLIENT_ID_REQUIRED", "Set GOOGLE_CLIENT_ID from your Google Web application OAuth client.");
  requireValue(nonblank(env.GOOGLE_CLIENT_SECRET), "GOOGLE_CLIENT_SECRET_REQUIRED", "Set GOOGLE_CLIENT_SECRET privately.");
  requireValue(nonblank(env.GOOGLE_OWNER_EMAIL) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.GOOGLE_OWNER_EMAIL),
    "OWNER_EMAIL_REQUIRED", "Set GOOGLE_OWNER_EMAIL to the Google account that owns the booking calendar.");
  requireValue(nonblank(env.GOOGLE_CALENDAR_ID), "CALENDAR_ID_REQUIRED", "Set GOOGLE_CALENDAR_ID privately.");
  requireValue(env.GOOGLE_REDIRECT_URI === REDIRECT_URI, "REDIRECT_MISMATCH", `Register and configure this exact local redirect URI: ${REDIRECT_URI}`);
  return Object.freeze({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    ownerEmail: env.GOOGLE_OWNER_EMAIL.toLowerCase(),
    calendarId: env.GOOGLE_CALENDAR_ID,
    blockingCalendarIds: uniqueCalendars([
      env.GOOGLE_CALENDAR_ID,
      PRIMARY_CALENDAR,
      ...(env.GOOGLE_BLOCKING_CALENDAR_IDS ? env.GOOGLE_BLOCKING_CALENDAR_IDS.split(",").map((value) => value.trim()) : []),
    ]),
    tokenFile: assertPrivateTokenPath(env.GOOGLE_TOKEN_FILE),
    redirectUri: REDIRECT_URI,
  });
}

export function authorizationRequest(config) {
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    login_hint: config.ownerEmail,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { state, verifier, url: url.href };
}

export function validateCallback(url, expectedState) {
  const states = url.searchParams.getAll("state");
  requireValue(typeof expectedState === "string" && /^[a-f0-9]{64}$/.test(expectedState) && expectedState.length === 64
    && states.length === 1 && /^[a-f0-9]{64}$/.test(states[0]) && states[0].length === 64
    && timingSafeEqual(Buffer.from(states[0]), Buffer.from(expectedState)),
  "INVALID_STATE", "The OAuth state is missing or invalid. Use the authorization link from this running helper.");
  const errors = url.searchParams.getAll("error");
  requireValue(errors.length === 0, "CONSENT_NOT_GRANTED", "Google authorization was not granted. No calendar access was connected.");
  const codes = url.searchParams.getAll("code");
  requireValue(codes.length === 1 && nonblank(codes[0]) && codes[0].length <= 4096,
    "INVALID_CODE", "Google did not return a valid authorization code.");
  return codes[0];
}

async function googleJson(url, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch {
    throw new CalendarAuthError("GOOGLE_NETWORK_ERROR", "The Google request failed or timed out. No request was automatically retried.");
  }
  requireValue(response?.ok, "GOOGLE_REQUEST_FAILED",
    `Google rejected a request (HTTP ${Number.isInteger(response?.status) ? response.status : "unknown"}). Check credentials, consent and API enablement.`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new CalendarAuthError("INVALID_GOOGLE_RESPONSE", "Google returned an unreadable response.");
  }
  requireValue(body && typeof body === "object" && !Array.isArray(body),
    "INVALID_GOOGLE_RESPONSE", "Google returned an invalid response object.");
  return body;
}

function validateAccessToken(tokens) {
  requireValue(nonblank(tokens.access_token) && !/\s/.test(tokens.access_token)
    && typeof tokens.token_type === "string" && tokens.token_type.toLowerCase() === "bearer"
    && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0,
  "INVALID_TOKEN_RESPONSE", "Google did not return a valid access token.");
  requireValue(typeof tokens.scope === "string" && tokens.scope.split(/\s+/).includes(CALENDAR_SCOPE),
    "CALENDAR_SCOPE_MISSING", "Calendar availability permission was not granted. Review the requested scope and reconnect.");
}

export function requireEventWriteScope(scope) {
  requireValue(typeof scope === "string" && scope.split(/\s+/).includes(CALENDAR_EVENTS_SCOPE),
    "CALENDAR_EVENTS_SCOPE_MISSING", "Calendar event permission was not granted. Reconnect Google before confirming paid bookings.");
}

export async function exchangeAuthorization(config, code, verifier, fetchImpl = globalThis.fetch) {
  const tokens = await googleJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: verifier,
    }).toString(),
  }, fetchImpl);
  validateAccessToken(tokens);
  requireValue(nonblank(tokens.refresh_token), "REFRESH_TOKEN_MISSING",
    "Google did not return an offline refresh token. Reconnect using the consent link; do not paste tokens into chat.");
  const user = await googleJson("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET", headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, fetchImpl);
  requireValue(user.email_verified === true && typeof user.email === "string"
    && user.email.toLowerCase() === config.ownerEmail,
  "WRONG_GOOGLE_ACCOUNT", "The authorized Google account is not the configured calendar owner. No credentials were saved.");
  return tokens;
}

export function saveAuthorization(config, tokens) {
  requireValue(nonblank(tokens?.refresh_token) && typeof tokens.scope === "string"
    && tokens.scope.split(/\s+/).includes(CALENDAR_SCOPE),
  "INVALID_SAVED_AUTH", "Only a valid offline Calendar authorization can be saved.");
  const destination = assertPrivateTokenPath(config.tokenFile);
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  const data = {
    client_id: config.clientId, authorized_email: config.ownerEmail,
    refresh_token: tokens.refresh_token, scope: tokens.scope,
    saved_at: new Date().toISOString(),
  };
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } catch {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new CalendarAuthError("TOKEN_STORAGE_FAILED", "Could not save authorization in the private token file.");
  }
}

export async function readCalendarBusy(config, accessToken, timeMin, timeMax, fetchImpl = globalThis.fetch) {
  const calendarIds = config.blockingCalendarIds?.length ? config.blockingCalendarIds : [config.calendarId];
  const data = await googleJson("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin, timeMax, timeZone: "Asia/Kolkata", items: calendarIds.map((id) => ({ id })) }),
  }, fetchImpl);
  requireValue(data.kind === "calendar#freeBusy" && data.calendars,
    "CALENDAR_CHECK_FAILED", "The configured calendars were not returned. Check calendar IDs and access permissions.");
  const busy = [];
  for (const id of calendarIds) {
    requireValue(Object.hasOwn(data.calendars, id),
      "CALENDAR_CHECK_FAILED", "Google did not return every configured calendar. Do not treat it as free.");
    const calendar = data.calendars[id];
    requireValue(calendar && (!Object.hasOwn(calendar, "errors") || (Array.isArray(calendar.errors) && calendar.errors.length === 0))
      && Array.isArray(calendar.busy),
    "CALENDAR_CHECK_FAILED", "Google could not read a configured calendar's availability. Do not treat it as free.");
    busy.push(...calendar.busy);
  }
  return busy;
}

export async function createCalendarEvent(config, accessToken, {
  bookingId, serviceName, customerName, customerEmail, start, end,
}, fetchImpl = globalThis.fetch) {
  requireValue(typeof bookingId === "string" && /^bk_[a-f0-9]{24}$/.test(bookingId)
    && nonblank(serviceName) && serviceName.length <= 80
    && nonblank(customerName) && customerName.length <= 80
    && nonblank(customerEmail) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
    && nonblank(start) && nonblank(end),
  "INVALID_EVENT_REQUEST", "A complete booking is required to create a calendar invitation.");
  const data = await googleJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events?sendUpdates=all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: `${serviceName} with ${customerName}`,
      description: `Paid direct session booking.\nBooking ID: ${bookingId}\nCustomer: ${customerName} <${customerEmail}>`,
      start: { dateTime: start, timeZone: "Asia/Kolkata" },
      end: { dateTime: end, timeZone: "Asia/Kolkata" },
      attendees: [{ email: customerEmail, displayName: customerName }],
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false,
      extendedProperties: { private: { booking_id: bookingId } },
    }),
  }, fetchImpl);
  requireValue(data.kind === "calendar#event" && nonblank(data.id) && nonblank(data.htmlLink),
    "EVENT_CREATE_FAILED", "Google did not return a valid created event.");
  return Object.freeze({ eventId: data.id, eventLink: data.htmlLink });
}

export async function probeCalendar(config, accessToken, fetchImpl = globalThis.fetch, now = new Date()) {
  await readCalendarBusy(config, accessToken, now.toISOString(), new Date(now.getTime() + 3600000).toISOString(), fetchImpl);
}

export async function refreshCalendarAccess(config, saved, fetchImpl = globalThis.fetch) {
  requireValue(saved?.client_id === config.clientId && saved.authorized_email === config.ownerEmail && nonblank(saved.refresh_token),
    "SAVED_AUTH_MISMATCH", "The saved authorization does not match this client and owner. Reconnect.");
  const tokens = await googleJson("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret,
      refresh_token: saved.refresh_token, grant_type: "refresh_token",
    }).toString(),
  }, fetchImpl);
  validateAccessToken(tokens);
  const user = await googleJson("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET", headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, fetchImpl);
  requireValue(user.email_verified === true && typeof user.email === "string" && user.email.toLowerCase() === config.ownerEmail,
    "WRONG_GOOGLE_ACCOUNT", "The saved authorization belongs to a different Google account.");
  return tokens;
}

export async function checkSavedAuthorization(config, saved, fetchImpl = globalThis.fetch) {
  const tokens = await refreshCalendarAccess(config, saved, fetchImpl);
  await probeCalendar(config, tokens.access_token, fetchImpl);
}

export function createOAuthServer(config, { fetchImpl = globalThis.fetch, timeoutMs = 600000 } = {}) {
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000,
    "INVALID_TIMEOUT", "The OAuth helper timeout must be between 1 millisecond and 10 minutes.");
  const authorization = authorizationRequest(config);
  let used = false;
  let settled = false;
  let resolveDone;
  let rejectDone;
  let timer;
  const done = new Promise((resolvePromise, rejectPromise) => { resolveDone = resolvePromise; rejectDone = rejectPromise; });
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    if (error) rejectDone(error);
    else resolveDone();
  };
  const send = (res, status, heading, message) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Calendar connection</title><h1>${heading}</h1><p>${message}</p></html>`);
  };
  const server = createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") return send(res, 503, "Helper stopped", "Run the connection helper again when ready.");
    const origin = `http://127.0.0.1:${address.port}`;
    if (req.headers.host !== `127.0.0.1:${address.port}`) return send(res, 400, "Invalid host", "Use the local callback address.");
    if (req.method !== "GET") return send(res, 405, "Method not allowed", "Only the Google redirect is accepted.");
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      return send(res, 400, "Invalid request", "Use the authorization link from the terminal.");
    }
    if (url.origin !== origin || url.pathname !== "/oauth/google/callback") {
      return send(res, 404, "Not found", "This helper does not serve website files or credentials.");
    }
    if (used) return send(res, 409, "Already processed", "This authorization attempt has already been used.");
    let code;
    try {
      code = validateCallback(url, authorization.state);
    } catch (error) {
      send(res, 400, "Authorization not completed", "The callback was invalid or consent was not granted. See the terminal instructions.");
      if (error.code === "CONSENT_NOT_GRANTED") {
        used = true;
        finish(error);
      }
      return;
    }
    used = true;
    clearTimeout(timer);
    try {
      const tokens = await exchangeAuthorization(config, code, authorization.verifier, fetchImpl);
      if (settled) return send(res, 409, "Connection cancelled", "No authorization was saved by this attempt.");
      saveAuthorization(config, tokens);
      try {
        await probeCalendar(config, tokens.access_token, fetchImpl);
      } catch {
        throw new CalendarAuthError("AUTHORIZED_CALENDAR_UNVERIFIED",
          "Authorization was saved privately, but the calendar check failed. Verify the Calendar API and calendar ID, then run --check.");
      }
      send(res, 200, "Google Calendar authorization saved", "The read-only availability check succeeded. No appointment, invitation or payment was created. You can close this tab.");
      finish();
    } catch (error) {
      send(res, 502, "Connection needs attention", "No booking was created. See the terminal for a safe error description.");
      finish(error instanceof CalendarAuthError ? error : new CalendarAuthError("CONNECTION_FAILED", "The calendar connection could not be completed."));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.on("error", () => finish(new CalendarAuthError("LISTENER_FAILED", "The local OAuth port could not be opened. Do not stop another process; check port 4174.")));
  server.once("listening", () => {
    timer = setTimeout(() => finish(new CalendarAuthError("CONSENT_TIMEOUT", "Authorization timed out after waiting for consent. Run the helper again when ready.")), timeoutMs);
  });
  return {
    server, done, authorizationUrl: authorization.url,
    cancel: () => finish(new CalendarAuthError("CONNECTION_CANCELLED", "The connection helper was cancelled.")),
  };
}
