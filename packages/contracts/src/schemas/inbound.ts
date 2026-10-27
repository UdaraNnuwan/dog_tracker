import { z } from "zod";
import { SETTINGS, type SettingName } from "../settings.js";
import {
  envelope,
  latitude,
  longitude,
  nonNegative,
  nonNegativeInt,
  percentage,
  positiveInt,
  requestId,
  responseEnvelope,
  vector3,
} from "./common.js";

/**
 * Payloads published by the collar under `pettracker/{device_id}/backend/…`, plus the
 * settings ACK it publishes under `…/device/settings/ack/…` (spec V3 §1–§3, §5–§7).
 * Required fields follow the spec's field tables (ADR 0011).
 */

// ---------------------------------------------------------------- telemetry (§1)

export const gpsTelemetry = z.object({
  ...envelope,
  latitude,
  longitude,
  speed: nonNegative.describe("m/s"),
});

export const batteryTelemetry = z.object({
  ...envelope,
  voltage: nonNegative.describe("V"),
  percentage: percentage.describe("estimated state of charge, %"),
  charging: z.boolean(),
});

export const imuTelemetry = z.object({
  ...envelope,
  acceleration: vector3.describe("m/s^2"),
  gyroscope: vector3.describe("deg/s"),
});

export const signalStrengthTelemetry = z
  .object({
    ...envelope,
    strength_lower_limit: z.number(),
    strength_upper_limit: z.number(),
  })
  .refine((s) => s.strength_lower_limit <= s.strength_upper_limit, {
    message: "strength_lower_limit must be <= strength_upper_limit",
    path: ["strength_lower_limit"],
  });

export const bmeTelemetry = z.object({
  ...envelope,
  temperature: z.number().describe("degC"),
  pressure: z.number().describe("hPa or kPa (unit not fixed by spec V3)"),
  humidity: z.number().min(0).max(100).describe("%RH"),
});

// ---------------------------------------------------------------- status (§2)

/** SemVer core, optionally with pre-release/build suffix (`1.0.0`, `1.1.0-sim`). */
const semver = z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/, "expected SemVer");

export const systemStatus = z.object({
  ...envelope,
  firmware_version: semver,
  uptime_seconds: nonNegativeInt.describe("s"),
  free_heap_bytes: nonNegativeInt.optional().describe("bytes"),
  reset_reason: z.string().optional(),
  device_state: z.enum(["active", "sleep", "idle"]),
});

export const networkStatus = z.object({
  ...envelope,
  connection: z.enum(["lte", "wifi", "2g", "3g"]),
  registration: z.string(),
  operator: z.string().optional(),
  apn: z.string().optional(),
  ip_address: z.union([z.ipv4(), z.ipv6()]),
});

/**
 * Not in spec V3; kept for the Last Will (ADR 0011). Retained; the broker publishes
 * `{"status":"offline"}` without a timestamp.
 */
export const connectivityStatus = z.object({
  timestamp: envelope.timestamp.optional(),
  status: z.enum(["online", "offline"]),
});

// ---------------------------------------------------------------- events (§3)

export const geofenceEvent = z.object({
  ...envelope,
  in_status: z.boolean(),
  out_status: z.boolean(),
});

export const lowBatteryEvent = z.object({
  ...envelope,
  percentage,
  voltage: nonNegative.describe("V"),
  threshold_percentage: percentage,
  charging: z.boolean().optional(),
});

// ---------------------------------------------------------------- command responses (§5)

/**
 * The fields the spec lists for a response are required on success. An `error` response may
 * leave them out: rejecting it would leave the command waiting until timeout (ADR 0011).
 */
function commandResponse<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion("status", [
    z.object({ ...responseEnvelope, status: z.literal("success"), ...fields }),
    z.object({
      ...responseEnvelope,
      status: z.literal("error"),
      ...z.object(fields).partial().shape,
    }),
  ]);
}

export const configResponse = commandResponse({
  applied: z.record(z.string(), z.unknown()),
});

export const locationResponse = commandResponse({
  location: z.object({
    latitude,
    longitude,
    accuracy_m: nonNegative.describe("m"),
    fix_valid: z.boolean(),
  }),
});

export const buzzerResponse = commandResponse({
  enabled: z.boolean(),
  duration_ms: positiveInt.describe("ms"),
});

export const rebootResponse = z.object({
  ...responseEnvelope,
  status: z.enum(["accepted", "rejected"]),
});

export const peripheralResponse = commandResponse({
  peripheral: z.string().min(1),
  enabled: z.boolean(),
});

export const sleepResponse = commandResponse({
  action: z.literal("enter_sleep"),
  duration_seconds: positiveInt.describe("s"),
});

// ---------------------------------------------------------------- settings (§6)

/**
 * Inbound settings payloads are read leniently: keys are trimmed and lowercased, because the
 * spec's own examples use `"gps_interval "`, `"Vaccines"` and `"Display_inverted"` (ADR 0011).
 */
const normaliseKeys = (v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.trim().toLowerCase(), x]))
    : v;

export const settingsEnvelope = <S extends SettingName>(setting: S) => ({
  ...envelope,
  setting_id: requestId,
  setting_type: z.literal(SETTINGS[setting].type),
});

/** `device/settings/ack/{setting}`: the collar confirms a SET with the same setting_id. */
export function settingsAck<S extends SettingName>(setting: S) {
  return z.preprocess(
    normaliseKeys,
    z.object({ ...settingsEnvelope(setting), action: z.literal("ack") }),
  );
}

/**
 * `backend/settings/response/{setting}`: the collar's answer to a GET. The spec's sensor and
 * device examples say `"action": "set"` where the tables say `get_response`; both are accepted.
 */
export function settingsResponse<S extends SettingName>(setting: S) {
  return z.preprocess(
    normaliseKeys,
    z.object({
      ...settingsEnvelope(setting),
      action: z.enum(["get_response", "set"]),
      ...SETTINGS[setting].fields,
    }),
  );
}

// ---------------------------------------------------------------- diagnostics (§7)

export const diagnosticLog = z.object({
  ...envelope,
  error_type: z.string(),
  error_code: z.string().describe("numeric or alphanumeric"),
});

export const debugLog = z.object({
  ...envelope,
  level: z.enum(["debug", "info", "warn", "error"]),
  module: z.string(),
  message: z.string(),
});
