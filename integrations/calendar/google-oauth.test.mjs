import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  CALENDAR_SCOPE, REDIRECT_URI, SCOPES, CalendarAuthError, assertPrivateTokenPath,
  authorizationRequest, checkSavedAuthorization, createOAuthServer, exchangeAuthorization,
  loadConfig, probeCalendar, saveAuthorization, validateCallback,
} from "./google-oauth.mjs";

const OWNER = "owner@example.invalid";
const SECRET = "fictional-client-secret";
const ACCESS = "fictional-access-token";
const REFRESH = "fictional-refresh-token";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const isError = (code) => (error) => error instanceof CalendarAuthError && error.code === code;

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "portfolio-oauth-test-"));
  t.after(() => rmSync(folder, { recursive: true }));
  const env = {
    GOOGLE_CLIENT_ID: "offline-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: SECRET,
    GOOGLE_OWNER_EMAIL: OWNER, GOOGLE_CALENDAR_ID: "calendar@example.invalid",
    GOOGLE_REDIRECT_URI: REDIRECT_URI, GOOGLE_TOKEN_FILE: join(folder, "google-calendar-tokens.json"),
  };
  return { env, config: loadConfig(env) };
}

function google(config, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(options.method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("client_secret"), SECRET);
      return json({
        access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer",
        expires_in: 3600, scope: SCOPES.join(" "), ...overrides.tokens,
      });
    }
    assert.equal(options.headers.Authorization, `Bearer ${ACCESS}`);
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: OWNER, email_verified: true, ...overrides.user });
    }
    if (url === "https://www.googleapis.com/calendar/v3/freeBusy") {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body).items, [{ id: config.calendarId }, { id: "primary" }]);
      return json({
        kind: "calendar#freeBusy", calendars: { [config.calendarId]: { busy: [] }, primary: { busy: [] } }, ...overrides.calendar,
      });
    }
    assert.fail("An unexpected Google endpoint was requested.");
  };
  return { fetchImpl, calls };
}

async function running(t, config, fetchImpl, timeoutMs = 600000) {
  const connection = createOAuthServer(config, { fetchImpl, timeoutMs });
  const result = connection.done.then(() => ({ ok: true }), (error) => ({ error }));
  t.after(() => connection.cancel());
  connection.server.listen(0, "127.0.0.1");
  await once(connection.server, "listening");
  const base = `http://127.0.0.1:${connection.server.address().port}`;
  const state = new URL(connection.authorizationUrl).searchParams.get("state");
  return { ...connection, result, base, state };
}

test("configuration rejects missing credentials, changed redirect and public token paths", (t) => {
  const { env } = fixture(t);
  for (const [name, code] of [
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID_REQUIRED"], ["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET_REQUIRED"],
    ["GOOGLE_OWNER_EMAIL", "OWNER_EMAIL_REQUIRED"], ["GOOGLE_CALENDAR_ID", "CALENDAR_ID_REQUIRED"],
  ]) assert.throws(() => loadConfig({ ...env, [name]: "" }), isError(code));
  assert.throws(() => loadConfig({ ...env, GOOGLE_REDIRECT_URI: "https://example.invalid/callback" }), isError("REDIRECT_MISMATCH"));
  assert.throws(() => assertPrivateTokenPath("tokens.json"), isError("PRIVATE_PATH_REQUIRED"));
  assert.throws(() => assertPrivateTokenPath(resolve("tokens.json")), isError("PUBLIC_TOKEN_PATH"));
  assert.throws(() => assertPrivateTokenPath(resolve("assets", "tokens.json")), isError("PUBLIC_TOKEN_PATH"));
});

test("authorization URL uses offline consent, least-privilege scope, state and PKCE without secrets", (t) => {
  const { config } = fixture(t);
  const auth = authorizationRequest(config);
  const url = new URL(auth.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.deepEqual(url.searchParams.get("scope").split(" "), SCOPES);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(auth.verifier).digest("base64url"));
  assert.match(auth.state, /^[a-f0-9]{64}$/);
  assert.ok(!auth.url.includes(SECRET));
  assert.ok(!auth.url.includes(auth.verifier));
  assert.notEqual(authorizationRequest(config).state, auth.state);
});

test("callback state and duplicate parameters are rejected; consent denial is explicit", (t) => {
  const { config } = fixture(t);
  const { state } = authorizationRequest(config);
  const callback = (query) => new URL(`${REDIRECT_URI}?${query}`);
  assert.equal(validateCallback(callback(`state=${state}&code=one-use-code`), state), "one-use-code");
  for (const query of [`code=x`, `state=${"0".repeat(64)}&code=x`, `state=${state}&state=${state}&code=x`]) {
    assert.throws(() => validateCallback(callback(query), state), isError("INVALID_STATE"));
  }
  assert.throws(() => validateCallback(callback(`state=${state}&code=x&code=y`), state), isError("INVALID_CODE"));
  assert.throws(() => validateCallback(callback(`state=${state}&error=access_denied`), state), isError("CONSENT_NOT_GRANTED"));
});

test("token exchange binds the client, callback and PKCE, then verifies the owner", async (t) => {
  const { config } = fixture(t);
  const mock = google(config);
  const tokens = await exchangeAuthorization(config, "one-use-code", "private-verifier", mock.fetchImpl);
  const body = new URLSearchParams(mock.calls[0].options.body);
  assert.equal(body.get("code_verifier"), "private-verifier");
  assert.equal(body.get("redirect_uri"), REDIRECT_URI);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(tokens.refresh_token, REFRESH);
  assert.equal(mock.calls.length, 2);
  for (const user of [{ email: "someone-else@example.invalid" }, { email_verified: false }, { email: 1 }]) {
    await assert.rejects(exchangeAuthorization(config, "code", "verifier", google(config, { user }).fetchImpl),
      isError("WRONG_GOOGLE_ACCOUNT"));
  }
  assert.equal(existsSync(config.tokenFile), false);
});

test("missing offline tokens, scopes and malformed token responses fail explicitly", async (t) => {
  const { config } = fixture(t);
  for (const [tokens, code] of [
    [{ refresh_token: undefined }, "REFRESH_TOKEN_MISSING"],
    [{ scope: "openid email" }, "CALENDAR_SCOPE_MISSING"],
    [{ access_token: "invalid\nheader" }, "INVALID_TOKEN_RESPONSE"],
    [{ token_type: 42 }, "INVALID_TOKEN_RESPONSE"],
    [{ expires_in: 0 }, "INVALID_TOKEN_RESPONSE"],
  ]) {
    await assert.rejects(exchangeAuthorization(config, "code", "verifier", google(config, { tokens }).fetchImpl), isError(code));
  }
});

test("provider failures are not retried and do not expose response bodies or credentials", async (t) => {
  const { config } = fixture(t);
  for (const respond of [
    () => json({ error: SECRET }, 401),
    () => new Response("not-json"),
    () => { throw new Error(SECRET); },
  ]) {
    let calls = 0;
    await assert.rejects(exchangeAuthorization(config, "code", "verifier", async () => { calls++; return respond(); }),
      (error) => error instanceof CalendarAuthError && !error.message.includes(SECRET));
    assert.equal(calls, 1);
  }
});

test("only the refresh token is stored, outside the website, and successful checks create no events", async (t) => {
  const { config } = fixture(t);
  assert.throws(() => saveAuthorization(config, { refresh_token: "" }), isError("INVALID_SAVED_AUTH"));
  assert.equal(existsSync(config.tokenFile), false);
  saveAuthorization(config, { refresh_token: REFRESH, access_token: ACCESS, scope: SCOPES.join(" ") });
  const storedText = readFileSync(config.tokenFile, "utf8");
  assert.ok(storedText.includes(REFRESH));
  assert.ok(!storedText.includes(ACCESS));
  assert.ok(!storedText.includes(SECRET));
  const mock = google(config);
  await checkSavedAuthorization(config, JSON.parse(storedText), mock.fetchImpl);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every(({ url }) => !url.includes("/events")));
  const body = new URLSearchParams(mock.calls[0].options.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), REFRESH);
});

test("failed or missing calendar results never count as free availability", async (t) => {
  const { config } = fixture(t);
  for (const calendar of [
    { calendars: {} }, { kind: "unexpected" },
    { calendars: { [config.calendarId]: { busy: [] } } },
    { calendars: { [config.calendarId]: { errors: [{ reason: "notFound" }], busy: [] } } },
    { calendars: { [config.calendarId]: { busy: null } } },
    { calendars: { [config.calendarId]: { busy: [] }, primary: { errors: [{ reason: "forbidden" }], busy: [] } } },
  ]) await assert.rejects(probeCalendar(config, ACCESS, google(config, { calendar }).fetchImpl), isError("CALENDAR_CHECK_FAILED"));
  await assert.rejects(checkSavedAuthorization(config, { client_id: "other" }, google(config).fetchImpl), isError("SAVED_AUTH_MISMATCH"));
});

test("loopback helper refuses invalid state, other hosts, file requests and non-GET requests", async (t) => {
  const { config } = fixture(t);
  const mock = google(config);
  const app = await running(t, config, mock.fetchImpl);
  assert.equal((await fetch(`${app.base}/.env`)).status, 404);
  assert.equal((await fetch(`${app.base}/oauth/google/callback?state=wrong&code=x`)).status, 400);
  assert.equal((await fetch(`${app.base}/oauth/google/callback`, { method: "POST" })).status, 405);
  const otherHost = await new Promise((resolvePromise, rejectPromise) => {
    const req = request(`${app.base}/oauth/google/callback?state=${app.state}&code=x`, {
      headers: { Host: "attacker.invalid" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolvePromise({ status: res.statusCode, text }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
  assert.equal(otherHost.status, 400);
  assert.match(otherHost.text, /Invalid host/);
  assert.equal(mock.calls.length, 0);
  assert.equal(existsSync(config.tokenFile), false);
});

test("loopback callback saves authorization and probes access without exposing tokens in HTML", async (t) => {
  const { config } = fixture(t);
  const mock = google(config);
  const app = await running(t, config, mock.fetchImpl);
  const response = await fetch(`${app.base}/oauth/google/callback?state=${app.state}&code=one-use-code`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const html = await response.text();
  assert.ok(!html.includes(SECRET) && !html.includes(ACCESS) && !html.includes(REFRESH));
  assert.equal((await app.result).ok, true);
  assert.equal(mock.calls.length, 3);
  assert.equal(JSON.parse(readFileSync(config.tokenFile)).authorized_email, OWNER);
});

test("simultaneous callback replay cannot exchange the same authorization twice", { timeout: 5000 }, async (t) => {
  const { config } = fixture(t);
  const mock = google(config);
  let release;
  let signalEntered;
  const pending = new Promise((resolvePromise) => { release = resolvePromise; });
  const entered = new Promise((resolvePromise) => { signalEntered = resolvePromise; });
  t.after(() => release());
  const app = await running(t, config, async (url, options) => {
    if (url.endsWith("/token")) {
      signalEntered();
      await pending;
    }
    return mock.fetchImpl(url, options);
  });
  const callback = `${app.base}/oauth/google/callback?state=${app.state}&code=x`;
  const first = fetch(callback);
  await entered;
  const second = await fetch(callback);
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await app.result).ok, true);
  assert.equal(mock.calls.filter(({ url }) => url.endsWith("/token")).length, 1);
});

test("wrong-account callbacks never save tokens, and consent denial and timeout stop the helper", async (t) => {
  const { config } = fixture(t);
  const wrong = await running(t, config, google(config, { user: { email: "other@example.invalid" } }).fetchImpl);
  assert.equal((await fetch(`${wrong.base}/oauth/google/callback?state=${wrong.state}&code=x`)).status, 502);
  assert.equal((await wrong.result).error.code, "WRONG_GOOGLE_ACCOUNT");
  assert.equal(existsSync(config.tokenFile), false);
  const denied = await running(t, config, () => assert.fail("Denied consent must not call Google."));
  assert.equal((await fetch(`${denied.base}/oauth/google/callback?state=${denied.state}&error=access_denied`)).status, 400);
  assert.equal((await denied.result).error.code, "CONSENT_NOT_GRANTED");
  const timeout = await running(t, config, () => assert.fail("No consent was supplied."), 20);
  assert.equal((await timeout.result).error.code, "CONSENT_TIMEOUT");
});

test("saved consent is distinguished from a failed calendar access check", async (t) => {
  const { config } = fixture(t);
  const app = await running(t, config, google(config, { calendar: { calendars: {} } }).fetchImpl);
  assert.equal((await fetch(`${app.base}/oauth/google/callback?state=${app.state}&code=x`)).status, 502);
  assert.equal((await app.result).error.code, "AUTHORIZED_CALENDAR_UNVERIFIED");
  assert.equal(existsSync(config.tokenFile), true);
});

test("CLI stops before opening OAuth when real Google configuration is missing", () => {
  const result = spawnSync(process.execPath, ["integrations\\calendar\\connect-google.mjs"], {
    encoding: "utf8", env: { ...process.env, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: SECRET },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GOOGLE_CLIENT_ID_REQUIRED/);
  assert.ok(!result.stderr.includes(SECRET));
  assert.equal(result.stdout, "");
});

test("an occupied local port fails explicitly without disturbing its existing listener", async (t) => {
  const { config } = fixture(t);
  const blocker = await running(t, config, () => assert.fail("No consent was supplied."));
  const another = createOAuthServer(config, { fetchImpl: () => assert.fail("No consent was supplied.") });
  const result = another.done.then(() => ({ ok: true }), (error) => ({ error }));
  t.after(() => another.cancel());
  another.server.listen(blocker.server.address().port, "127.0.0.1");
  assert.equal((await result).error.code, "LISTENER_FAILED");
  assert.equal((await fetch(`${blocker.base}/still-running`)).status, 404);
});
