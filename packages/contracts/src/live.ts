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
 * Lifecycle of one command/settings request (rule 3): `pending` until the collar answers with
 * the same request_id / setting_id, else `timeout` after the retries. A command's final state
 * is the response `status` (`success` / `error`, or `accepted` / `rejected` for reboot); a
 * settings SET succeeds on its ACK, a GET on its response. `failed` means we could not publish.
 */
export const REQUEST_STATES = [
  "pending",
  "success",
  "error",
  "accepted",
  "rejected",
  "timeout",
  "failed",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export interface RequestStatus {
  /** `request_id` of a command, `setting_id` of a settings request. */
  requestId: string;
  deviceId: string;
  /** Path after `pettracker/{device_id}/device/`, e.g. `command/buzzer`. */
  path: string;
  /** Live key of the expected answer, e.g. `response/buzzer` or `settings/ack/gps_settings`. */
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
  /** Why the request failed on our side (`failed`), e.g. broker disconnected. */
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

/** Topic key of a validated message (adds the setting name for settings topics). */
export function liveTopicKey(msg: InboundMessage): LiveTopicKey {
  return "setting" in msg ? `${msg.path}/${msg.setting}` : msg.path;
}

const RESPONSE_FIELDS = ["timestamp", "request_id", "status"] as const;
const SETTINGS_FIELDS = ["timestamp", "action", "setting_id", "setting_type"] as const;

const settings = (name: string, fields: readonly string[]) => ({
  [`settings/response/${name}`]: [...SETTINGS_FIELDS, ...fields],
  [`settings/ack/${name}`]: SETTINGS_FIELDS,
});

/**
 * Payload fields of every topic the bridge receives, so the UI can show a tile for each topic
 * before any data arrived. Zod-free on purpose (small main bundle); a contracts test keeps it
 * equal to the schemas.
 */
export const TOPIC_FIELDS: Readonly<Record<LiveTopicKey, readonly string[]>> = {
  "telemetry/gps": ["timestamp", "latitude", "longitude", "speed"],
  "telemetry/battery": ["timestamp", "voltage", "percentage", "charging"],
  "telemetry/imu": ["timestamp", "acceleration", "gyroscope"],
  "telemetry/signal_strength": ["timestamp", "strength_lower_limit", "strength_upper_limit"],
  "telemetry/bme_data": ["timestamp", "temperature", "pressure", "humidity"],
  "status/system": [
    "timestamp",
    "firmware_version",
    "uptime_seconds",
    "free_heap_bytes",
    "reset_reason",
    "device_state",
  ],
  "status/network": ["timestamp", "connection", "registration", "operator", "apn", "ip_address"],
  "status/connectivity": ["timestamp", "status"],
  "event/geofence": ["timestamp", "in_status", "out_status"],
  "event/low_battery": ["timestamp", "percentage", "voltage", "threshold_percentage", "charging"],
  "response/config": [...RESPONSE_FIELDS, "applied"],
  "response/location": [...RESPONSE_FIELDS, "location"],
  "response/buzzer": [...RESPONSE_FIELDS, "enabled", "duration_ms"],
  "response/reboot": RESPONSE_FIELDS,
  "response/peripheral": [...RESPONSE_FIELDS, "peripheral", "enabled"],
  "response/sleep": [...RESPONSE_FIELDS, "action", "duration_seconds"],
  ...settings("network_settings", [
    "mqtt_hb_interval",
    "mqtt_retry_interval",
    "telemetry_interval",
  ]),
  ...settings("gps_settings", ["gps_interval", "gps_enabled"]),
  ...settings("profile_settings", [
    "pet_name",
    "owner_qr",
    "vaccination_status",
    "next_vacc_due",
    "vaccines",
  ]),
  ...settings("power_settings", [
    "power_mode",
    "low_bat_thresh",
    "low_bat_alert_enable",
    "inactive_timeout",
    "display_timeout",
    "display_brightness",
  ]),
  ...settings("sensor_settings", [
    "imu_enable",
    "imu_sample_rate",
    "imu_sleep_detect_timeout",
    "imu_detach_detect_timeout",
    "bme_enable",
    "temp_max_value",
  ]),
  ...settings("device_settings", [
    "pwrkey_hold_timeout",
    "speaker_enable",
    "audio_volume",
    "audio_sample_rate",
    "display_enable",
    "display_rotation",
    "display_inverted",
    "display_timeout",
    "display_brightness",
    "geofence_alert_enable",
    "motion_alert_enable",
    "high_temp_alert_enable",
  ]),
  "diagnostic/log": ["timestamp", "error_type", "error_code"],
  "diagnostic/debug_log": ["timestamp", "level", "module", "message"],
};
