import { readFileSync } from "node:fs";
import { CalendarAuthError, checkSavedAuthorization, createOAuthServer, loadConfig } from "./google-oauth.mjs";

try {
  if (process.argv.slice(2).some((argument) => argument !== "--check") || process.argv.slice(2).length > 1) {
    throw new CalendarAuthError("INVALID_ARGUMENT", "Use no argument to connect, or --check to verify saved authorization.");
  }
  const config = loadConfig(process.env);
  if (process.argv.includes("--check")) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(config.tokenFile, "utf8"));
    } catch {
      throw new CalendarAuthError("SAVED_AUTH_UNAVAILABLE", "The private authorization file is missing or unreadable. Run the connection helper first.");
    }
    await checkSavedAuthorization(config, saved);
    console.log("Saved Google authorization and calendar availability access are valid. No events were created.");
  } else {
    const connection = createOAuthServer(config);
    connection.server.once("listening", () => {
      console.log("Open this Google consent link yourself. It expires in 10 minutes:");
      console.log(connection.authorizationUrl);
      console.log("No passwords, authorization codes or tokens should be pasted into chat.");
    });
    connection.server.listen(4174, "127.0.0.1");
    await connection.done;
    console.log("Google authorization saved privately; calendar availability check passed. No events or invitations were created.");
  }
} catch (error) {
  if (error instanceof CalendarAuthError) console.error(`${error.code}: ${error.message}`);
  else console.error("CONNECTION_FAILED: The helper stopped unexpectedly. No credentials have been printed.");
  process.exitCode = 1;
}
