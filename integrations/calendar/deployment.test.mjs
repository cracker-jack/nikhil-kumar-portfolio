import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readPrivateCredentials } from "./availability-server.mjs";
import { loadConfig, REDIRECT_URI, saveAuthorization, SCOPES } from "./google-oauth.mjs";
import { prepareRuntimeSecret } from "./prepare-runtime-secret.mjs";

function directory(t) {
  const folder = mkdtempSync(join(tmpdir(), "portfolio-calendar-deploy-"));
  t.after(() => rmSync(folder, { recursive: true }));
  return folder;
}

test("deployment packaging includes only allowlisted runtime source files and refuses existing content", (t) => {
  const destination = join(directory(t), "source");
  const run = (path) => spawnSync(process.execPath, [resolve("integrations", "calendar", "prepare-deployment.mjs"), path], { encoding: "utf8" });
  assert.equal(run(destination).status, 0);
  const files = readdirSync(destination, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  assert.equal(files.length, 8);
  const expected = [
    ["Dockerfile", "integrations", "calendar", "Dockerfile"],
    ["assets/booking-slots.js", "assets", "booking-slots.js"],
    ["integrations/razorpay/payment-model.mjs", "integrations", "razorpay", "payment-model.mjs"],
    ["integrations/razorpay/api-client.mjs", "integrations", "razorpay", "api-client.mjs"],
    ...["google-oauth.mjs", "availability.mjs", "booking-service.mjs", "availability-server.mjs"].map((file) => [`integrations/calendar/${file}`, "integrations", "calendar", file]),
  ];
  for (const [target, ...source] of expected) {
    assert.deepEqual(readFileSync(join(destination, ...target.split("/"))), readFileSync(resolve(...source)));
  }
  assert.notEqual(run(destination).status, 0);
  assert.notEqual(run(resolve("assets")).status, 0);
  const load = spawnSync(process.execPath, ["--input-type=module", "-e",
    "await import('./integrations/calendar/availability-server.mjs'); console.log('Runtime imports resolve.')"], { cwd: destination, encoding: "utf8" });
  assert.equal(load.status, 0, load.stderr);
});

test("private runtime bundles round-trip without carrying Razorpay or access tokens", async (t) => {
  const folder = directory(t);
  const env = {
    GOOGLE_CLIENT_ID: "fictional.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fictional-google-secret",
    GOOGLE_OWNER_EMAIL: "owner@example.invalid", GOOGLE_CALENDAR_ID: "calendar@example.invalid",
    GOOGLE_REDIRECT_URI: REDIRECT_URI, GOOGLE_TOKEN_FILE: join(folder, "google-calendar-tokens.json"),
    RAZORPAY_KEY_SECRET: "fictional-razorpay-secret",
  };
  const config = loadConfig(env);
  saveAuthorization(config, { refresh_token: "fictional-refresh", scope: SCOPES.join(" ") });
  const fetchImpl = async (url) => {
    let data;
    if (url.endsWith("/token")) data = { access_token: "fictional-access", token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") };
    else if (url.endsWith("/userinfo")) data = { email: config.ownerEmail, email_verified: true };
    else {
      assert.equal(url, "https://www.googleapis.com/calendar/v3/freeBusy");
      data = { kind: "calendar#freeBusy", calendars: { [config.calendarId]: { busy: [] }, primary: { busy: [] } } };
    }
    return new Response(JSON.stringify(data));
  };
  const destination = await prepareRuntimeSecret(env, { fetchImpl });
  const text = readFileSync(destination, "utf8");
  assert.ok(!text.includes(env.RAZORPAY_KEY_SECRET));
  assert.ok(!text.includes("fictional-access"));
  const loaded = readPrivateCredentials({ CALENDAR_CREDENTIALS_FILE: destination });
  assert.equal(loaded.config.clientId, config.clientId);
  assert.equal(loaded.config.clientSecret, config.clientSecret);
  assert.deepEqual(loaded.config.blockingCalendarIds, [config.calendarId, "primary"]);
  assert.equal(loaded.saved.refresh_token, "fictional-refresh");
  assert.equal(readPrivateCredentials(env).saved.refresh_token, loaded.saved.refresh_token);
  await assert.rejects(prepareRuntimeSecret(env, { fetchImpl }), { code: "EEXIST" });
  assert.equal(readFileSync(destination, "utf8"), text);
});

test("failed authorization cannot produce a runtime secret, and corrupt bundles fail explicitly", async (t) => {
  const folder = directory(t);
  const file = join(folder, "calendar-runtime.json");
  assert.throws(() => readPrivateCredentials({ CALENDAR_CREDENTIALS_FILE: file }));
  writeFileSync(file, "{");
  assert.throws(() => readPrivateCredentials({ CALENDAR_CREDENTIALS_FILE: file }), { code: "PRIVATE_CREDENTIALS_UNAVAILABLE" });
  const token = join(folder, "google-calendar-tokens.json");
  const env = {
    GOOGLE_CLIENT_ID: "fictional.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fictional-secret",
    GOOGLE_OWNER_EMAIL: "owner@example.invalid", GOOGLE_CALENDAR_ID: "calendar@example.invalid",
    GOOGLE_REDIRECT_URI: REDIRECT_URI, GOOGLE_TOKEN_FILE: token,
  };
  saveAuthorization(loadConfig(env), { refresh_token: "fictional-refresh", scope: SCOPES.join(" ") });
  await assert.rejects(prepareRuntimeSecret(env, { fetchImpl: async () => new Response("{}", { status: 401 }) }));
  assert.equal(readFileSync(file, "utf8"), "{");
  assert.ok(existsSync(token));
});
