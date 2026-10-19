/**
 * Copies the deployed Worker's secrets from the root `.env` to Cloudflare in one go:
 *
 *   pnpm deploy:secrets              # production Worker
 *   pnpm deploy:secrets --env staging
 *
 * Only the names below are sent, and empty values are skipped (e.g. no HIVEMQ_USERNAME for the
 * anonymous public broker). Values are never printed. LIVE_VIEW_UNAUTHENTICATED is never sent:
 * a deployed Worker must not skip login (ADR 0004, ADR 0010).
 */
import { spawnSync } from "node:child_process";

const SECRET_NAMES = [
  "HIVEMQ_HOST",
  "HIVEMQ_USERNAME",
  "HIVEMQ_PASSWORD",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
] as const;

const REQUIRED = ["HIVEMQ_HOST", "SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;

const secrets: Record<string, string> = {};
for (const name of SECRET_NAMES) {
  const value = process.env[name]?.trim();
  if (value && !value.includes("xxxxxxxx")) secrets[name] = value;
}

const missing = REQUIRED.filter((n) => !(n in secrets));
if (missing.length) {
  console.error(`set these in .env first: ${missing.join(", ")}`);
  process.exit(1);
}
if ("HIVEMQ_USERNAME" in secrets !== "HIVEMQ_PASSWORD" in secrets) {
  console.error("set both HIVEMQ_USERNAME and HIVEMQ_PASSWORD, or neither (anonymous broker)");
  process.exit(1);
}

console.log(`uploading ${Object.keys(secrets).join(", ")}`);
// `wrangler secret bulk` reads a JSON object from stdin; values never touch argv or disk.
const result = spawnSync("wrangler", ["secret", "bulk", ...process.argv.slice(2)], {
  input: JSON.stringify(secrets),
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(result.status ?? 1);
