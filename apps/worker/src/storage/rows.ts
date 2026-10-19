import { liveTopicKey, type InboundMessage, type Rejection } from "@udara/contracts";

/** One item of `ingest_batch(p_messages)` (supabase/migrations/…_telemetry_storage.sql). */
export interface StoredMessage {
  device_id: string;
  topic: string;
  /** Device time, epoch seconds (payload `timestamp`, or received_at when absent). */
  ts: number;
  received_at: number;
  retained: boolean;
  data: InboundMessage["data"];
}

/** One item of `ingest_batch(p_rejected)`. */
export interface StoredRejection {
  received_at: number;
  topic: string;
  device_id: string | null;
  reason: string;
  issues: string[];
}

/**
 * Maps a validated message to its storage row, or null when it isn't persisted:
 * raw IMU is live-only (rule 10).
 */
export function toStoredMessage(
  msg: InboundMessage,
  receivedAt: number,
  retained: boolean,
): StoredMessage | null {
  if (msg.path === "telemetry/imu") return null;
  const timestamp = (msg.data as { timestamp?: number }).timestamp;
  return {
    device_id: msg.deviceId,
    topic: liveTopicKey(msg),
    ts: timestamp ?? receivedAt,
    received_at: receivedAt,
    retained,
    data: msg.data,
  };
}

export function toStoredRejection(
  topic: string,
  rejection: Rejection,
  receivedAt: number,
): StoredRejection {
  return {
    received_at: receivedAt,
    topic,
    device_id: rejection.deviceId ?? null,
    reason: rejection.reason,
    issues: rejection.issues,
  };
}

// ------------------------------------------------------------------ GPS thinning (rule 10)

/** Skip GPS points closer than this to the last stored point… */
const MIN_MOVE_M = 5;
/** …unless this long has passed, so a resting dog still leaves a timeline. */
const MAX_GAP_S = 300;

const rad = (d: number) => (d * Math.PI) / 180;
function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Remembers the last stored fix per device (in memory; after an eviction the first point is
 * simply stored again).
 */
export class GpsThinner {
  private last = new Map<string, { lat: number; lon: number; ts: number }>();

  /** True when this fix should be stored; records it if so. */
  keep(deviceId: string, lat: number, lon: number, ts: number): boolean {
    const prev = this.last.get(deviceId);
    if (
      prev &&
      ts >= prev.ts &&
      ts - prev.ts < MAX_GAP_S &&
      distanceM(prev.lat, prev.lon, lat, lon) < MIN_MOVE_M
    ) {
      return false;
    }
    this.last.set(deviceId, { lat, lon, ts });
    return true;
  }

  forget(deviceId?: string): void {
    if (deviceId === undefined) this.last.clear();
    else this.last.delete(deviceId);
  }
}
