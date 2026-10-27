import { z } from "zod";
import { boolSetting, intSetting, positiveInt } from "./schemas/common.js";

/**
 * Settings registry (spec V3 §6, rule 8). Each group has its own
 * `settings/{set,ack,get}/{group}` and `settings/response/{group}` topics; `type` is the
 * payload's `setting_type`. Fields are optional unless the spec marks them required.
 * Adding a group here makes its topics valid everywhere.
 */
const seconds = intSetting(positiveInt).describe("seconds");
const milliseconds = intSetting(positiveInt).describe("milliseconds");
const onePercentStep = intSetting(z.number().int().min(1).max(100)).describe("1..100");

export const SETTINGS = {
  network_settings: {
    type: "network",
    description: "MQTT and 4G settings.",
    // The spec's response table lists gps_interval/gps_enabled here; its example (and the SET
    // table) use these fields, which is what we follow (ADR 0011).
    fields: {
      mqtt_hb_interval: seconds.optional(),
      mqtt_retry_interval: seconds.optional(),
      telemetry_interval: seconds.optional(),
    },
  },
  gps_settings: {
    type: "gps",
    description: "GPS reporting.",
    fields: {
      gps_interval: seconds.optional(),
      gps_enabled: boolSetting.optional(),
    },
  },
  profile_settings: {
    type: "profile",
    description: "Pet and owner profile shown on the collar.",
    fields: {
      pet_name: z.string().min(1),
      owner_qr: z.string().optional(),
      vaccination_status: intSetting(z.number().int().min(0).max(2)).optional().describe("0, 1, 2"),
      next_vacc_due: z.string().optional(),
      vaccines: z
        .array(z.object({ name: z.string(), date: z.string(), completed: boolSetting }))
        .optional(),
    },
  },
  power_settings: {
    type: "power",
    description: "Power mode and battery alerts.",
    fields: {
      power_mode: z.string().optional(),
      low_bat_thresh: intSetting(z.number().int().min(0).max(100)).optional().describe("%"),
      low_bat_alert_enable: boolSetting.optional(),
      inactive_timeout: seconds.optional(),
      // In the spec's example only, not in its table.
      display_timeout: seconds.optional(),
      display_brightness: onePercentStep.optional(),
    },
  },
  sensor_settings: {
    type: "sensor",
    description: "IMU and environment sensor.",
    fields: {
      // The table says "integer, >0 seconds", which reads like a copy error for an enable flag
      // (ADR 0011). Accepted as a boolean until the firmware team confirms.
      imu_enable: boolSetting.optional(),
      imu_sample_rate: milliseconds.optional(),
      imu_sleep_detect_timeout: seconds.optional(),
      imu_detach_detect_timeout: seconds.optional(),
      bme_enable: boolSetting.optional(),
      temp_max_value: intSetting(z.number().int()).optional().describe("degC"),
    },
  },
  device_settings: {
    type: "device",
    description: "Buttons, audio, display and alert switches.",
    fields: {
      pwrkey_hold_timeout: seconds.optional(),
      speaker_enable: boolSetting.optional(),
      audio_volume: onePercentStep.optional(),
      audio_sample_rate: milliseconds.optional(),
      display_enable: boolSetting.optional(),
      display_rotation: intSetting(
        z
          .number()
          .int()
          .refine((v) => v === 0 || v === 2, "must be 0 or 2"),
      )
        .optional()
        .describe("0 = portrait, 2 = portrait rotated 180°"),
      display_inverted: boolSetting.optional().describe("true = white on black"),
      display_timeout: seconds.optional(),
      display_brightness: onePercentStep.optional(),
      geofence_alert_enable: boolSetting.optional(),
      motion_alert_enable: boolSetting.optional(),
      high_temp_alert_enable: boolSetting.optional(),
    },
  },
} as const;

export type SettingName = keyof typeof SETTINGS;
export type SettingFields<S extends SettingName = SettingName> = (typeof SETTINGS)[S]["fields"];

export const SETTING_NAMES = Object.keys(SETTINGS) as SettingName[];

export function isSettingName(name: string): name is SettingName {
  return Object.hasOwn(SETTINGS, name);
}

/** The operations the backend publishes for a settings group. */
export const SETTING_OPS = ["set", "get"] as const;
export type SettingOp = (typeof SETTING_OPS)[number];
