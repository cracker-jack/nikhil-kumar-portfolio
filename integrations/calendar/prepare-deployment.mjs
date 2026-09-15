import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error("Provide an absolute, empty deployment directory outside the repository.");
const location = relative(root, resolve(output));
if (!(location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location))) {
  throw new Error("The deployment directory must be outside the repository.");
}
if (existsSync(output) && readdirSync(output).length) throw new Error("Use an empty deployment directory; existing files are not overwritten.");
mkdirSync(output, { recursive: true });
const realLocation = relative(realpathSync(root), realpathSync(output));
if (!(realLocation === ".." || realLocation.startsWith(`..${sep}`) || isAbsolute(realLocation))) {
  throw new Error("The deployment directory must not resolve inside the repository.");
}
const sources = [
  ["integrations/calendar/Dockerfile", "Dockerfile"],
  ["assets/booking-slots.js", "assets/booking-slots.js"],
  ["integrations/razorpay/payment-model.mjs", "integrations/razorpay/payment-model.mjs"],
  ["integrations/calendar/google-oauth.mjs", "integrations/calendar/google-oauth.mjs"],
  ["integrations/calendar/availability.mjs", "integrations/calendar/availability.mjs"],
  ["integrations/calendar/availability-server.mjs", "integrations/calendar/availability-server.mjs"],
];
for (const [source, destination] of sources) {
  const target = resolve(output, ...destination.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, ...source.split("/")), target);
}
console.log("Prepared an allowlisted six-file backend source bundle. No credentials or website content were included.");
