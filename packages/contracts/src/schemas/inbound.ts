import { z } from "zod";
import { SETTINGS, type SettingName } from "../settings.js";
import {
  envelope,
  latitude,
  longitude,
  nonNegative,
  nonNegativeInt,
  percentage,
  responseEnvelope,
  responseStatus,
  vector3,
} from "./common.js";

/**
 * Payloads published by the collar under `pettracker/backend/{device_id}/…` (spec §5, §6, §7, §9).
 *
 * Where the spec gives a field table, "Req. = Y" fields are required. Where it only gives an
 * example (§6.1, §6.2, §6.4, §6.5, §9.1), every field except `timestamp` is optional (ADR 0002).
 */

// ---------------------------------------------------------------- telemetry (§5)

export const gpsTelemetry = z.object({
  ...envelope,
  latitude,
  longitude,
  speed: nonNegative.optional().describe("m/s"),
  accuracy: nonNegative.optional().describe("m, horizontal"),
  satellites: nonNegativeInt.optional(),
});

export const batteryTelemetry = z.object({
  ...envelope,
  voltage: nonNegative.describe("V"),
  percentage: percentage.describe("estimated state of charge, %"),
  charging: z.boolean(),
  temperature: z.number().optional().describe("degC"),
});

export const imuTelemetry = z.object({
  ...envelope,
  accelerometer: vector3.describe("m/s^2"),
  gyroscope: vector3.describe("deg/s"),
});

export const signalStrengthTelemetry = z.object({
  ...envelope,
  rssi: z.number().optional().describe("dBm"),
  rsrp: z.number().optional().describe("dBm"),
  rsrq: z.number().optional().describe("dB"),
  sinr: z.number().optional().describe("dB"),
});

// ---------------------------------------------------------------- status (§6.1, §6.2, §11)

export const systemStatus = z.object({
  ...envelope,
  firmware_version: z.string().optional(),
  uptime: nonNegativeInt.optional().describe("s"),
  free_memory: nonNegativeInt.optional().describe("bytes"),
  reset_reason: z.string().optional(),
});

export const networkStatus = z.object({
  ...envelope,
  connected: z.boolean().optional(),
  network_type: z.string().optional(),
  operator: z.string().optional(),
  ip_address: z.string().optional(),
});

/** Retained; the broker's Last Will publishes `{"status":"offline"}` without a timestamp (§11). */
export const connectivityStatus = z.object({
  ...envelope,
  timestamp: envelope.timestamp.optional(),
  status: z.enum(["online", "offline"]),
});

// ---------------------------------------------------------------- events (§6.3–§6.5)

export const geofenceEvent = z.object({
  ...envelope,
  geofence_id: z.string().min(1),
  event: z.enum(["enter", "exit"]),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
});

export const lowBatteryEvent = z.object({
  ...envelope,
  percentage: percentage.optional(),
  voltage: nonNegative.optional().describe("V"),
});

export const tamperEvent = z.object({
  ...envelope,
  detected: z.boolean().optional(),
});

// ---------------------------------------------------------------- command responses (§7)

const failedStatus = responseStatus.exclude(["success"]);

/** A successful location response carries the fix; other statuses don't (§7 table). */
export const locationResponse = z.discriminatedUnion("status", [
  z.object({ ...responseEnvelope, status: z.literal("success"), latitude, longitude }),
  z.object({
    ...responseEnvelope,
    status: failedStatus,
    latitude: latitude.optional(),
    longitude: longitude.optional(),
  }),
]);

export const commandResponse = z.object(responseEnvelope);

/**
 * `settings/response/{setting}` (§8.2). A successful response echoes the value, which must
 * satisfy the setting's registry schema.
 */
export function settingsResponse<S extends SettingName>(setting: S) {
  const value = SETTINGS[setting].schema;
  return z.discriminatedUnion("status", [
    z.object({ ...responseEnvelope, status: z.literal("success"), value }),
    z.object({ ...responseEnvelope, status: failedStatus, value: z.unknown().optional() }),
  ]);
}

// ---------------------------------------------------------------- diagnostics (§9)

export const diagnosticLog = z.object({
  ...envelope,
  level: z.string().optional(),
  module: z.string().optional(),
  error_type: z.string().optional(),
  error_code: z.string().optional(),
  message: z.string().optional(),
});

/** Content not defined by the spec yet: keep every field so nothing is lost. */
export const diagnosticOpaque = z.looseObject({ ...envelope });
