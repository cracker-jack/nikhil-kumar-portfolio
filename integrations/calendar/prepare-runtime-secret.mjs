import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CalendarAuthError, assertPrivateTokenPath, checkSavedAuthorization, loadConfig } from "./google-oauth.mjs";

export async function prepareRuntimeSecret(env, { fetchImpl = globalThis.fetch } = {}) {
  const config = loadConfig(env);
  const authorization = JSON.parse(readFileSync(config.tokenFile, "utf8"));
  await checkSavedAuthorization(config, authorization, fetchImpl);
  const destination = assertPrivateTokenPath(join(dirname(config.tokenFile), "calendar-runtime.json"));
  writeFileSync(destination, JSON.stringify({
    clientId: config.clientId, clientSecret: config.clientSecret,
    ownerEmail: config.ownerEmail, calendarId: config.calendarId, authorization,
  }, null, 2), { flag: "wx", mode: 0o600 });
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prepareRuntimeSecret(process.env);
    console.log("Verified authorization and created calendar-runtime.json beside the private token file. Upload it only to your approved private Secret Manager secret, never the source bundle.");
  } catch (error) {
    const code = error instanceof CalendarAuthError ? error.code
      : ["EEXIST", "EACCES", "ENOENT", "EPERM"].includes(error.code) ? error.code : "EXPORT_FAILED";
    console.error(`Private runtime export failed (${code}). Check authorization and the private output path. Existing files are not overwritten.`);
    process.exitCode = 1;
  }
}
