import type {
  DemoStatus,
  LiveEvent,
  LiveReading,
  PipelineLog,
  RequestStatus,
} from "@udara/contracts";

/** Points kept per device for the map trail. */
const MAX_TRAIL = 300;
/** Processing-log lines kept in the browser (the rest are in `pipeline_logs`). */
const MAX_LOGS = 1_000;
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
  /** Bridge processing log (ADR 0008), newest first. */
  logs: PipelineLog[];
  demo: DemoStatus;
  /** Command/settings requests by request_id (rule 3). */
  requests: Record<string, RequestStatus>;
  /** Per topic key (`telemetry/gps`, …, `rejected`), newest first. */
  byTopic: Record<string, TopicEntry[]>;
  seq: number;
  rejected: number;
}

const IDLE_DEMO: DemoStatus = { running: false, devices: [], startedAt: null, endsAt: null };

export const emptyModel: LiveModel = {
  devices: {},
  logs: [],
  demo: IDLE_DEMO,
  requests: {},
  byTopic: {},
  seq: 0,
  rejected: 0,
};

/** Identity of a log line across reconnects (seq restarts when the bridge does). */
export const logKey = (l: PipelineLog) => `${l.at}:${l.seq}`;

/** Newest first: by time, then by sequence within the same second. */
const newestFirst = (a: PipelineLog, b: PipelineLog) => b.at - a.at || b.seq - a.seq;

/** Adds snapshot lines to the ones already shown, without duplicates. */
function mergeLogs(current: PipelineLog[], incoming: PipelineLog[]): PipelineLog[] {
  const seen = new Set(current.map(logKey));
  const fresh = incoming.filter((l) => !seen.has(logKey(l)));
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort(newestFirst).slice(0, MAX_LOGS);
}

export const asPayload = (data: unknown): Payload =>
  data !== null && typeof data === "object" ? (data as Payload) : {};

function lonLat(data: unknown): [number, number] | null {
  const p = asPayload(data);
  return typeof p.latitude === "number" && typeof p.longitude === "number"
    ? [p.longitude, p.latitude]
    : null;
}

function pushTopic(
  model: LiveModel,
  topic: { key: string; entry: Omit<TopicEntry, "seq"> },
): Pick<LiveModel, "byTopic" | "seq"> {
  const seq = model.seq + 1;
  const previous = model.byTopic[topic.key] ?? [];
  return {
    seq,
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
      const requests = { ...model.requests };
      for (const req of event.requests) requests[req.requestId] = req;
      return {
        ...model,
        devices,
        logs: mergeLogs(model.logs, event.logs),
        demo: event.demo,
        requests,
      };
    }

    case "request":
      return {
        ...model,
        requests: { ...model.requests, [event.request.requestId]: event.request },
      };

    case "log":
      return { ...model, logs: [event.entry, ...model.logs].slice(0, MAX_LOGS) };

    case "demo":
      return { ...model, demo: event.demo };

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
        ...pushTopic(model, {
          key: event.key,
          entry: {
            at: event.receivedAt,
            deviceId: event.deviceId,
            retained: event.retained,
            data: asPayload(event.data),
          },
        }),
      };
    }

    case "rejected":
      return {
        ...model,
        rejected: model.rejected + 1,
        ...pushTopic(model, {
          key: REJECTED_KEY,
          entry: {
            at: event.receivedAt,
            deviceId: null,
            retained: false,
            data: { topic: event.topic, reason: event.reason, issues: event.issues.join("; ") },
          },
        }),
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
