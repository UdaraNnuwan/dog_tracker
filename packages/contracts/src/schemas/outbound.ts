import { z } from "zod";
import { SETTINGS, type SettingName } from "../settings.js";
import { commandEnvelope, nonNegative } from "./common.js";

/**
 * Payloads the backend publishes under `pettracker/device/{device_id}/…` (spec §7, §8).
 * OTA (`command/firmware_update`, §14) is a proposal and deliberately absent.
 */

export const locationCommand = z.object(commandEnvelope);

export const buzzerCommand = z.object({
  ...commandEnvelope,
  enabled: z.boolean(),
  duration: nonNegative.describe("seconds (unit not fixed by spec v1.2, see ADR 0002)"),
});

export const rebootCommand = z.object(commandEnvelope);

export const peripheralCommand = z.object({
  ...commandEnvelope,
  peripheral: z.string().min(1),
  enabled: z.boolean(),
});

export const sleepCommand = z.object({
  ...commandEnvelope,
  mode: z.string().min(1),
});

export function settingsSet<S extends SettingName>(setting: S) {
  return z.object({ ...commandEnvelope, value: SETTINGS[setting].schema });
}

export const settingsGet = z.object(commandEnvelope);
