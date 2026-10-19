/**
 * Usernames ↔ Supabase emails (ADR 0010). No imports: shared by the Worker and the Node seed
 * script.
 */
export const USERNAME_DOMAIN = "users.dogtracker.local";
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** `udara` → `udara@users.dogtracker.local`; null when the username is invalid. */
export function usernameToEmail(username: string): string | null {
  const u = username.trim().toLowerCase();
  return USERNAME_RE.test(u) ? `${u}@${USERNAME_DOMAIN}` : null;
}

/**
 * `admin` has every privilege; `user` is a plain signed-in user. Stored in Supabase
 * `app_metadata.role`, which only the secret key can write (users can't promote themselves).
 */
export type Role = "admin" | "user";

export const roleOf = (appMetadata: unknown): Role =>
  appMetadata !== null &&
  typeof appMetadata === "object" &&
  (appMetadata as { role?: unknown }).role === "admin"
    ? "admin"
    : "user";

export function emailToUsername(email: string | undefined): string {
  if (!email) return "unknown";
  const suffix = `@${USERNAME_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
