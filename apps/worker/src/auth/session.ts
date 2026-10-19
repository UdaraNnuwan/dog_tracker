/**
 * Username + password login on Supabase Auth (ADR 0010).
 *
 * Supabase identifies users by email; people sign in with a username, which maps to a
 * synthetic, never-mailed address `<username>@users.dogtracker.local`. Users are seeded by an
 * admin (`pnpm seed:users`); there is no public sign-up, e-mail confirmation or reset mail.
 * The browser talks to the Worker only (no Supabase keys in the bundle); the Worker signs in,
 * refreshes and verifies sessions with the server-side client.
 */
import type { Db } from "../storage/supabase.js";
import { emailToUsername, usernameToEmail } from "./username.js";

export { USERNAME_DOMAIN, emailToUsername, usernameToEmail } from "./username.js";

export interface SessionUser {
  id: string;
  username: string;
}

/** What the browser keeps; times are epoch seconds (rule 5). */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: SessionUser;
}

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in: number;
  user: { id: string; email?: string };
}

function toTokens(s: SupabaseSession): SessionTokens {
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: s.expires_at ?? Math.floor(Date.now() / 1000) + s.expires_in,
    user: { id: s.user.id, username: emailToUsername(s.user.email) },
  };
}

export async function login(db: Db, username: string, password: string) {
  const email = usernameToEmail(username);
  if (!email || !password) return null;
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error || !data.session) return null;
  return toTokens(data.session);
}

export async function refresh(db: Db, refreshToken: string) {
  const { data, error } = await db.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) return null;
  return toTokens(data.session);
}

/** Verified-token cache: avoids re-verifying on every request (bounded, expiry-aware). */
const verified = new Map<string, { user: SessionUser; until: number }>();
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60_000;

/**
 * Verifies an access token (signature and expiry via Supabase `getClaims`; local with
 * asymmetric signing keys, a call to Supabase Auth otherwise). Returns null when invalid.
 */
export async function verifyAccessToken(db: Db, token: string): Promise<SessionUser | null> {
  const now = Date.now();
  const hit = verified.get(token);
  if (hit && hit.until > now) return hit.user;

  const { data, error } = await db.auth.getClaims(token);
  if (error || !data) return null;
  const { sub, email, exp } = data.claims;
  if (typeof sub !== "string" || !sub) return null;
  const user = {
    id: sub,
    username: emailToUsername(typeof email === "string" ? email : undefined),
  };

  if (verified.size >= CACHE_MAX) verified.clear();
  verified.set(token, { user, until: Math.min(now + CACHE_TTL_MS, exp * 1000) });
  return user;
}

/** Browser WebSockets can't send headers: the token rides in the subprotocol list. */
export const WS_PROTOCOL = "dogtracker.bearer";

/** Bearer token from `Authorization`, or from `Sec-WebSocket-Protocol: dogtracker.bearer, <jwt>`. */
export function bearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((p) => p.trim());
  const i = protocols.indexOf(WS_PROTOCOL);
  return i >= 0 ? (protocols[i + 1] ?? null) : null;
}

/** Test hook. */
export function clearVerifiedCache(): void {
  verified.clear();
}
