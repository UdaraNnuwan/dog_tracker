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

export function emailToUsername(email: string | undefined): string {
  if (!email) return "unknown";
  const suffix = `@${USERNAME_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
