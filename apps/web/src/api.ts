import { accessToken, getSession, logout, type SessionUser } from "./auth/session.js";
import type { DemoStatus, RequestStatus } from "@udara/contracts";
import type { Tables } from "@udara/db-types";

/** Client for the Worker's history API (ADR 0006). Times are ISO strings from Postgres. */

export type DeviceRow = Tables<"devices">;
export type GpsRow = Omit<Tables<"gps_points">, "device_id">;
export type BatteryRow = Omit<Tables<"battery_readings">, "device_id">;
export type SignalRow = Omit<Tables<"signal_readings">, "device_id">;
export type MessageRow = Omit<Tables<"device_messages">, "device_id" | "dedupe_key">;

export interface HistoryRows {
  gps: GpsRow;
  battery: BatteryRow;
  signal: SignalRow;
  messages: MessageRow;
}
export type HistoryKind = keyof HistoryRows;

export const MESSAGE_CATEGORIES = [
  "status",
  "event",
  "response",
  "settings",
  "diagnostic",
] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export interface Range {
  from: Date;
  to: Date;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Validation details, e.g. Zod issues for a rejected command. */
    readonly issues: string[] = [],
  ) {
    super(`${status} ${code}`);
  }
}

/** Adds the signed-in user's bearer token (ADR 0010). */
export async function authHeaders(init?: HeadersInit): Promise<Headers> {
  const headers = new Headers(init);
  const token = await accessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: await authHeaders(init?.headers) });
  // An expired or revoked session: back to the login page.
  if (res.status === 401 && getSession()) logout();
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
    reason?: string;
    issues?: string[];
  };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body.message ?? body.reason ?? body.error ?? "request_failed",
      body.issues ?? [],
    );
  }
  return body;
}

export interface Me {
  user: SessionUser;
  /** True for local development without login (ADR 0004). */
  dev: boolean;
}

export const fetchMe = () => request<Me>("/api/auth/me");

export async function fetchDevices(): Promise<DeviceRow[]> {
  return (await request<{ devices: DeviceRow[] }>("/api/devices")).devices;
}

export async function fetchHistory<K extends HistoryKind>(
  deviceId: string,
  kind: K,
  range: Range,
  opts: { limit?: number; category?: MessageCategory | null } = {},
): Promise<HistoryRows[K][]> {
  const params = new URLSearchParams({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    limit: String(opts.limit ?? 5000),
  });
  if (opts.category) params.set("category", opts.category);
  const path = `/api/devices/${encodeURIComponent(deviceId)}/history/${kind}?${params}`;
  return (await request<{ rows: HistoryRows[K][] }>(path)).rows;
}

/** Deletes stored history for one device, or for all devices when deviceId is null. */
export async function clearHistory(deviceId: string | null): Promise<number> {
  const path = deviceId ? `/api/devices/${encodeURIComponent(deviceId)}/history` : "/api/history";
  return (await request<{ deleted: number }>(path, { method: "DELETE" })).deleted;
}

// ------------------------------------------------------------------ saved logs (ADR 0008)

export type LogRow = Tables<"pipeline_logs">;
export type SavedLevel = "info" | "warn" | "error";

export interface LogFilters {
  from?: Date | null;
  to?: Date | null;
  deviceId?: string | null;
  topic?: string | null;
  /** Minimum level. */
  level?: SavedLevel | null;
  source?: string | null;
  search?: string | null;
  /** Older than this id ("load older"). */
  beforeId?: number | null;
  /** Newer than this id (live tail). */
  afterId?: number | null;
  limit?: number;
}

/** Saved processing log, newest first. */
export async function fetchLogs(f: LogFilters = {}): Promise<LogRow[]> {
  const params = new URLSearchParams();
  if (f.from) params.set("from", f.from.toISOString());
  if (f.to) params.set("to", f.to.toISOString());
  if (f.deviceId) params.set("device", f.deviceId);
  if (f.topic) params.set("topic", f.topic);
  if (f.level) params.set("level", f.level);
  if (f.source) params.set("source", f.source);
  if (f.search?.trim()) params.set("q", f.search.trim());
  if (f.beforeId) params.set("before", String(f.beforeId));
  if (f.afterId) params.set("after", String(f.afterId));
  params.set("limit", String(f.limit ?? 200));
  return (await request<{ rows: LogRow[] }>(`/api/logs?${params}`)).rows;
}

// ------------------------------------------------------------------ commands & settings

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const devicePath = (deviceId: string) => `/api/devices/${encodeURIComponent(deviceId)}`;

/**
 * Publishes `pettracker/device/{id}/{path}` for a command or settings path, e.g.
 * `command/buzzer` or `settings/set/gps_interval`. The backend adds timestamp, request_id
 * (UUID) and protocol_version, validates, and tracks the answer (rule 3).
 */
export function sendToDevice(
  deviceId: string,
  path: string,
  fields: Record<string, unknown>,
): Promise<RequestStatus> {
  const [kind, a, b] = path.split("/");
  if (kind === "command" && a) {
    return postJson(`${devicePath(deviceId)}/commands/${encodeURIComponent(a)}`, fields);
  }
  if (kind === "settings" && (a === "set" || a === "get") && b) {
    return postJson(`${devicePath(deviceId)}/settings/${encodeURIComponent(b)}/${a}`, fields);
  }
  return Promise.reject(new Error(`cannot send to ${path}`));
}

// ------------------------------------------------------------------ demo run (ADR 0008)

export const fetchDemo = () => request<DemoStatus>("/api/demo");

export const startDemo = (opts: { devices?: number; seconds?: number } = {}) =>
  request<DemoStatus>("/api/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });

export const stopDemo = () => request<DemoStatus>("/api/demo", { method: "DELETE" });

/** Postgres timestamptz → epoch seconds (rule 5: convert at the UI edge only). */
export const toEpoch = (iso: string) => Date.parse(iso) / 1000;
