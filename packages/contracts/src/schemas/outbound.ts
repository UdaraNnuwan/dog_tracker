import { z } from "zod";
import { SETTINGS, type SettingName } from "../settings.js";
import { commandEnvelope, percentage, positiveInt } from "./common.js";
import { settingsEnvelope } from "./inbound.js";

/**
 * Payloads the backend publishes under `pettracker/{device_id}/device/…` (spec V3 §4, §6).
 * `command/firmware_update` is a proposal and deliberately absent: OTA is an HTTPS pull
 * (`firmware.ts`, ADR 0012).
 */

/** Marked TBD in spec V3: the config keys aren't defined yet. */
export const configCommand = z.object({
  ...commandEnvelope,
  config: z.record(z.string(), z.unknown()),
});

export const locationCommand = z.object({
  ...commandEnvelope,
  action: z.literal("get_current_location").default("get_current_location"),
});

export const buzzerCommand = z.object({
  ...commandEnvelope,
  enabled: z.boolean(),
  duration_ms: positiveInt.describe("ms"),
  volume_percent: percentage.optional(),
});

export const rebootCommand = z.object({
  ...commandEnvelope,
  reboot_enable: z.boolean().default(true),
});

export const peripheralCommand = z.object({
  ...commandEnvelope,
  peripheral: z.string().min(1).describe("e.g. speaker"),
  enabled: z.boolean(),
});

export const sleepCommand = z.object({
  ...commandEnvelope,
  action: z.literal("enter_sleep").default("enter_sleep"),
  duration_seconds: positiveInt.describe("s"),
});

/** `settings/set/{setting}`: the group's fields; values are published typed (ADR 0011). */
export function settingsSet<S extends SettingName>(setting: S) {
  return z.object({
    ...settingsEnvelope(setting),
    action: z.literal("set"),
    ...SETTINGS[setting].fields,
  });
}

/** `settings/get/{setting}`: the collar answers on `settings/response/{setting}`. */
export function settingsGet<S extends SettingName>(setting: S) {
  return z.object({ ...settingsEnvelope(setting), action: z.literal("get") });
}
