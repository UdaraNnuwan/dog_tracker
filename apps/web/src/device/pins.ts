import type { MapPin } from "../live/DeviceMap.js";
import { clock } from "../live/format.js";
import type { TopicEntry } from "../live/model.js";

/** A fallback GPS fix must be at most this far from the event in time. */
const MAX_GAP_S = 300;
const MAX_PINS = 50;

/** Device time of a row (payload `timestamp`), else when it was received. */
const timeOf = (r: TopicEntry) => (typeof r.data.timestamp === "number" ? r.data.timestamp : r.at);

/** A fix at the top level (GPS) or under `location` (spec V3 §5 location response). */
function latLon(r: TopicEntry) {
  const loc = (r.data.location ?? r.data) as Record<string, unknown> | null;
  return loc && typeof loc.latitude === "number" && typeof loc.longitude === "number"
    ? { latitude: loc.latitude, longitude: loc.longitude }
    : null;
}

/** The device's GPS fix closest in time to `t`, within MAX_GAP_S. */
function nearestFix(gps: TopicEntry[], deviceId: string | null, t: number) {
  let best: { latitude: number; longitude: number } | null = null;
  let bestGap = MAX_GAP_S + 1;
  for (const g of gps) {
    if (g.deviceId !== deviceId) continue;
    const pos = latLon(g);
    const gap = Math.abs(timeOf(g) - t);
    if (pos && gap < bestGap) {
      best = pos;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Map pins for a topic's rows, newest first: `response/location` fixes and geofence events.
 * Geofence events carry no position (spec V3 §3); they are placed at the device's nearest
 * GPS fix and marked "≈".
 */
export function pinsFor(
  key: string,
  rows: TopicEntry[],
  gps: TopicEntry[],
  deviceId: string,
): MapPin[] {
  if (key === "telemetry/gps") return []; // shown as the trail
  const pins: MapPin[] = [];
  for (const r of rows) {
    if (deviceId && r.deviceId !== deviceId) continue;
    let pos = latLon(r);
    let approx = false;
    if (!pos && key === "event/geofence") {
      pos = nearestFix(gps, r.deviceId, timeOf(r));
      approx = pos !== null;
    }
    if (!pos) continue;
    const what =
      key === "event/geofence"
        ? r.data.out_status === true
          ? "left the geofence"
          : "inside the geofence"
        : "location fix";
    pins.push({
      ...pos,
      label: `${r.deviceId ?? ""} · ${what} · ${clock(r.at)}${approx ? " · ≈ nearest GPS fix" : ""}`,
    });
    if (pins.length >= MAX_PINS) break;
  }
  return pins;
}
