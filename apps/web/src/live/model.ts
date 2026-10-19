import type { LiveEvent, LiveReading } from "@udara/contracts";

/** Points kept per device for the map trail. */
const MAX_TRAIL = 300;
/** Entries kept in the message log. */
const MAX_LOG = 200;
/** Entries kept per topic in the topic log. */
const MAX_TOPIC_LOG = 100;
/** Topic-log key for messages that failed validation. */
export const REJECTED_KEY = "rejected";

export type Payload = Record<string, unknown>;

export interface DeviceView {
  deviceId: string;
  latest: Record<string, LiveReading>;
  /** Epoch seconds of the most recent message. */
  lastSeen: number;
  /** [longitude, latitude] pairs, oldest first. */
  trail: [number, number][];
}

export interface LogEntry {
  seq: number;
  at: number;
  ok: boolean;
  deviceId: string | null;
  label: string;
  body: string;
}

/** One row of a topic section: the message's own fields, newest first. */
export interface TopicEntry {
  seq: number;
  at: number;
  deviceId: string | null;
  retained: boolean;
  data: Payload;
}

export interface LiveModel {
  devices: Record<string, DeviceView>;
  log: LogEntry[];
  /** Per topic key (`telemetry/gps`, …, `rejected`), newest first. */
  byTopic: Record<string, TopicEntry[]>;
  seq: number;
  rejected: number;
}

export const emptyModel: LiveModel = { devices: {}, log: [], byTopic: {}, seq: 0, rejected: 0 };

export const asPayload = (data: unknown): Payload =>
  data !== null && typeof data === "object" ? (data as Payload) : {};

function lonLat(data: unknown): [number, number] | null {
  const p = asPayload(data);
  return typeof p.latitude === "number" && typeof p.longitude === "number"
    ? [p.longitude, p.latitude]
    : null;
}

function pushLog(
  model: LiveModel,
  entry: Omit<LogEntry, "seq">,
  topic: { key: string; entry: Omit<TopicEntry, "seq"> },
): Pick<LiveModel, "log" | "byTopic" | "seq"> {
  const seq = model.seq + 1;
  const previous = model.byTopic[topic.key] ?? [];
  return {
    seq,
    log: [{ ...entry, seq }, ...model.log].slice(0, MAX_LOG),
    byTopic: {
      ...model.byTopic,
      [topic.key]: [{ ...topic.entry, seq }, ...previous].slice(0, MAX_TOPIC_LOG),
    },
  };
}

/** Pure reducer from `/api/live` events to view state. */
export function reduce(model: LiveModel, event: LiveEvent): LiveModel {
  switch (event.type) {
    case "snapshot": {
      const devices: Record<string, DeviceView> = {};
      for (const d of event.devices) {
        const readings = Object.values(d.latest);
        const gps = d.latest["telemetry/gps"];
        const point = gps ? lonLat(gps.data) : null;
        devices[d.deviceId] = {
          deviceId: d.deviceId,
          latest: d.latest,
          lastSeen: Math.max(0, ...readings.map((r) => r.receivedAt)),
          // Keep trails across reconnects; the snapshot only carries the latest fix.
          trail: model.devices[d.deviceId]?.trail ?? (point ? [point] : []),
        };
      }
      return { ...model, devices };
    }

    case "message": {
      const prev = model.devices[event.deviceId];
      const point = event.key === "telemetry/gps" ? lonLat(event.data) : null;
      const trail = prev?.trail ?? [];
      const device: DeviceView = {
        deviceId: event.deviceId,
        latest: {
          ...prev?.latest,
          [event.key]: { data: event.data, receivedAt: event.receivedAt },
        },
        lastSeen: event.receivedAt,
        trail: point ? [...trail, point].slice(-MAX_TRAIL) : trail,
      };
      return {
        ...model,
        devices: { ...model.devices, [event.deviceId]: device },
        ...pushLog(
          model,
          {
            at: event.receivedAt,
            ok: true,
            deviceId: event.deviceId,
            label: `${event.deviceId} · ${event.key}${event.retained ? " (retained)" : ""}`,
            body: JSON.stringify(event.data),
          },
          {
            key: event.key,
            entry: {
              at: event.receivedAt,
              deviceId: event.deviceId,
              retained: event.retained,
              data: asPayload(event.data),
            },
          },
        ),
      };
    }

    case "rejected":
      return {
        ...model,
        rejected: model.rejected + 1,
        ...pushLog(
          model,
          {
            at: event.receivedAt,
            ok: false,
            deviceId: null,
            label: `${event.topic} · ${event.reason}`,
            body: event.issues.join("; "),
          },
          {
            key: REJECTED_KEY,
            entry: {
              at: event.receivedAt,
              deviceId: null,
              retained: false,
              data: { topic: event.topic, reason: event.reason, issues: event.issues.join("; ") },
            },
          },
        ),
      };
  }
}

export type Connectivity = "online" | "offline" | "unknown";

export function connectivity(device: DeviceView): Connectivity {
  const status = asPayload(device.latest["status/connectivity"]?.data).status;
  return status === "online" || status === "offline" ? status : "unknown";
}

export function batteryPercent(device: DeviceView): number | null {
  const pct = asPayload(device.latest["telemetry/battery"]?.data).percentage;
  return typeof pct === "number" ? pct : null;
}

/** Online first, then most recently seen. */
export function sortDevices(devices: DeviceView[]): DeviceView[] {
  const rank = (d: DeviceView) => (connectivity(d) === "online" ? 0 : 1);
  return [...devices].sort((a, b) => rank(a) - rank(b) || b.lastSeen - a.lastSeen);
}
