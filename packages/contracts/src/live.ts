import type { InboundMessage, RejectReason } from "./inbound.js";

/**
 * Messages the `MqttBridge` sends to browsers on the `/api/live` WebSocket.
 * Times are epoch seconds (rule 5).
 */

/** `path` as it appears in the topic, e.g. `telemetry/gps` or `settings/response/gps_interval`. */
export type LiveTopicKey = string;

export interface LiveReading {
  data: InboundMessage["data"];
  receivedAt: number;
}

export interface LiveDevice {
  deviceId: string;
  latest: Record<LiveTopicKey, LiveReading>;
}

export const PIPELINE_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type PipelineLogLevel = (typeof PIPELINE_LOG_LEVELS)[number];

/** Where a log line comes from (ADR 0008). */
export const PIPELINE_LOG_SOURCES = ["ingest", "bridge", "storage", "demo"] as const;
export type PipelineLogSource = (typeof PIPELINE_LOG_SOURCES)[number];

/**
 * One line of the bridge's processing log: what happened to a message (accepted, stored,
 * thinned, rejected…) or to the bridge itself. `debug` lines are live-only; the rest are
 * also saved to `pipeline_logs` (ADR 0008).
 */
export interface PipelineLog {
  /** Unique per bridge instance; ordering within the same second. */
  seq: number;
  /** Epoch seconds (rule 5). */
  at: number;
  level: PipelineLogLevel;
  source: PipelineLogSource;
  deviceId: string | null;
  /** Topic key (`telemetry/gps`, …) or the raw topic for rejections. */
  topic: string | null;
  message: string;
  detail: Record<string, unknown> | null;
}

/** State of the dashboard's Demo run (ADR 0008). */
export interface DemoStatus {
  running: boolean;
  devices: string[];
  /** Epoch seconds. */
  startedAt: number | null;
  endsAt: number | null;
}

/**
 * Lifecycle of one command/settings request (rule 3): `pending` until the device answers
 * with the same request_id, else `timeout` after the retries. Final device answers use the
 * response `status` (spec §3).
 */
export const REQUEST_STATES = [
  "pending",
  "success",
  "failed",
  "rejected",
  "unsupported",
  "timeout",
  "error",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export interface RequestStatus {
  requestId: string;
  deviceId: string;
  /** Path after `pettracker/device/{device_id}/`, e.g. `command/buzzer`. */
  path: string;
  /** Path of the expected answer, e.g. `response/buzzer`. */
  responsePath: string;
  /** JSON text exactly as published (the same on every retry). */
  payload: string;
  state: RequestState;
  /** Publishes so far: 1 + retries (max 3). */
  attempts: number;
  /** Epoch seconds. */
  sentAt: number;
  updatedAt: number;
  /** JSON text of the device's (validated) answer, once it arrived. */
  response: string | null;
  /** Why the request failed on our side (`error`), e.g. broker disconnected. */
  error: string | null;
}

export type LiveEvent =
  | {
      type: "snapshot";
      devices: LiveDevice[];
      logs: PipelineLog[];
      demo: DemoStatus;
      requests: RequestStatus[];
    }
  | { type: "request"; request: RequestStatus }
  | { type: "log"; entry: PipelineLog }
  | { type: "demo"; demo: DemoStatus }
  | {
      type: "message";
      deviceId: string;
      key: LiveTopicKey;
      data: InboundMessage["data"];
      receivedAt: number;
      retained: boolean;
    }
  | {
      type: "rejected";
      topic: string;
      reason: RejectReason;
      issues: string[];
      receivedAt: number;
    };

/** Topic key of a validated message (adds the setting name for settings responses). */
export function liveTopicKey(msg: InboundMessage): LiveTopicKey {
  return msg.path === "settings/response" ? `${msg.path}/${msg.setting}` : msg.path;
}

const RESPONSE_FIELDS = ["timestamp", "request_id", "status", "error_code", "message"] as const;

/**
 * Payload fields of every subscribed topic (without `protocol_version`), so the UI can show
 * a tile for each topic before any data arrived. Zod-free on purpose (small main bundle);
 * a contracts test keeps it equal to the schemas.
 */
export const TOPIC_FIELDS: Readonly<Record<LiveTopicKey, readonly string[]>> = {
  "telemetry/gps": ["timestamp", "latitude", "longitude", "speed", "accuracy", "satellites"],
  "telemetry/battery": ["timestamp", "voltage", "percentage", "charging", "temperature"],
  "telemetry/imu": ["timestamp", "accelerometer", "gyroscope"],
  "telemetry/signal_strength": ["timestamp", "rssi", "rsrp", "rsrq", "sinr"],
  "status/system": ["timestamp", "firmware_version", "uptime", "free_memory", "reset_reason"],
  "status/network": ["timestamp", "connected", "network_type", "operator", "ip_address"],
  "status/connectivity": ["timestamp", "status"],
  "event/geofence": ["timestamp", "geofence_id", "event", "latitude", "longitude"],
  "event/low_battery": ["timestamp", "percentage", "voltage"],
  "event/tamper": ["timestamp", "detected"],
  "response/location": [...RESPONSE_FIELDS, "latitude", "longitude"],
  "response/buzzer": RESPONSE_FIELDS,
  "response/reboot": RESPONSE_FIELDS,
  "response/peripheral": RESPONSE_FIELDS,
  "response/sleep": RESPONSE_FIELDS,
  "settings/response/gps_interval": [...RESPONSE_FIELDS, "value"],
  "diagnostic/log": ["timestamp", "level", "module", "error_type", "error_code", "message"],
  "diagnostic/crash": ["timestamp"],
  "diagnostic/debug_log": ["timestamp"],
  "diagnostic/sensor_health": ["timestamp"],
};
