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
  ) {
    super(`${status} ${code}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? "request_failed");
  return body;
}

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

/** Postgres timestamptz → epoch seconds (rule 5: convert at the UI edge only). */
export const toEpoch = (iso: string) => Date.parse(iso) / 1000;
