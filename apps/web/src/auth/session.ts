/**
 * Browser session for username + password login (ADR 0010). Tokens come from the Worker
 * (`/api/auth/login`, `/api/auth/refresh`); the access token is refreshed shortly before it
 * expires. Kept in localStorage so a reload stays signed in.
 */
import { useSyncExternalStore } from "react";

export interface SessionUser {
  id: string;
  username: string;
  /** `admin` has every privilege (Supabase app_metadata.role, ADR 0010). */
  role: "admin" | "user";
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  user: SessionUser;
}

const STORAGE_KEY = "dogtracker.session";
/** Refresh this many seconds before expiry. */
const REFRESH_MARGIN_S = 60;

function load(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let current: Session | null = load();
const listeners = new Set<() => void>();

function set(next: Session | null) {
  current = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the session still lives for this page.
  }
  listeners.forEach((l) => l());
}

export const getSession = () => current;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession);
}

export class LoginError extends Error {}

export async function login(username: string, password: string): Promise<Session> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) throw new LoginError("Wrong username or password.");
  if (!res.ok) throw new LoginError(`Sign-in is unavailable right now (HTTP ${res.status}).`);
  const session = (await res.json()) as Session;
  set(session);
  return session;
}

export function logout(): void {
  set(null);
}

let refreshing: Promise<string | null> | null = null;

async function doRefresh(session: Session): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (res.status === 401) {
      set(null);
      return null;
    }
    if (!res.ok) return session.accessToken; // transient: keep trying with what we have
    const next = (await res.json()) as Session;
    set(next);
    return next.accessToken;
  } catch {
    return session.accessToken;
  }
}

/** A valid access token (refreshed when close to expiry), or null when signed out. */
export async function accessToken(): Promise<string | null> {
  const session = current;
  if (!session) return null;
  if (session.expiresAt - Date.now() / 1000 > REFRESH_MARGIN_S) return session.accessToken;
  refreshing ??= doRefresh(session).finally(() => {
    refreshing = null;
  });
  return refreshing;
}
