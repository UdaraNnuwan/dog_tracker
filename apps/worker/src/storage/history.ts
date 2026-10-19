import { isValidDeviceId } from "@udara/contracts";
import type { Db } from "./supabase.js";

/** History sections of the dashboard (ADR 0006). */
export const HISTORY_KINDS = ["gps", "battery", "signal", "messages"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export const MESSAGE_CATEGORIES = [
  "status",
  "event",
  "response",
  "settings",
  "diagnostic",
] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 10_000;
const DEFAULT_RANGE_MS = 24 * 3600_000;

export interface HistoryQuery {
  deviceId: string;
  kind: HistoryKind;
  from: string;
  to: string;
  limit: number;
  category: MessageCategory | null;
}

/** Validates query-string input; returns an error message for a 400 instead of throwing. */
export function parseHistoryQuery(
  deviceId: string,
  kind: string,
  params: { from?: string; to?: string; limit?: string; category?: string },
  now = Date.now(),
): HistoryQuery | string {
  if (!isValidDeviceId(deviceId)) return "invalid device id";
  if (!(HISTORY_KINDS as readonly string[]).includes(kind)) {
    return `kind must be one of ${HISTORY_KINDS.join(", ")}`;
  }
  const to = params.to ? Date.parse(params.to) : now;
  const from = params.from ? Date.parse(params.from) : to - DEFAULT_RANGE_MS;
  if (Number.isNaN(from) || Number.isNaN(to)) return "from/to must be ISO dates";
  if (from > to) return "from must be before to";
  const limit = params.limit ? Number(params.limit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `limit must be 1..${MAX_LIMIT}`;
  }
  const category = params.category ?? null;
  if (category !== null && !(MESSAGE_CATEGORIES as readonly string[]).includes(category)) {
    return `category must be one of ${MESSAGE_CATEGORIES.join(", ")}`;
  }
  return {
    deviceId,
    kind: kind as HistoryKind,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    limit,
    category: category as MessageCategory | null,
  };
}

/** Rows for one section, oldest first for time series and newest first for messages. */
export async function queryHistory(db: Db, q: HistoryQuery) {
  switch (q.kind) {
    case "gps":
      return db
        .from("gps_points")
        .select("ts, received_at, latitude, longitude, speed, accuracy, satellites")
        .eq("device_id", q.deviceId)
        .gte("ts", q.from)
        .lte("ts", q.to)
        .order("ts", { ascending: true })
        .limit(q.limit);
    case "battery":
      return db
        .from("battery_readings")
        .select("ts, received_at, voltage, percentage, charging, temperature")
        .eq("device_id", q.deviceId)
        .gte("ts", q.from)
        .lte("ts", q.to)
        .order("ts", { ascending: true })
        .limit(q.limit);
    case "signal":
      return db
        .from("signal_readings")
        .select("ts, received_at, rssi, rsrp, rsrq, sinr")
        .eq("device_id", q.deviceId)
        .gte("ts", q.from)
        .lte("ts", q.to)
        .order("ts", { ascending: true })
        .limit(q.limit);
    case "messages": {
      let query = db
        .from("device_messages")
        .select("id, topic, category, ts, received_at, payload")
        .eq("device_id", q.deviceId)
        .gte("ts", q.from)
        .lte("ts", q.to);
      if (q.category) query = query.eq("category", q.category);
      return query.order("ts", { ascending: false }).limit(q.limit);
    }
  }
}

export function listDevices(db: Db) {
  return db.from("devices").select("*").order("last_seen_at", { ascending: false }).limit(500);
}
