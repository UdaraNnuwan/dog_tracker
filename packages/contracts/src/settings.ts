import { z } from "zod";

/**
 * Settings registry (spec §8, rule 8). The spec's settings catalogue is still open (§18);
 * until it is frozen this is the complete list. Adding a setting here makes its
 * settings/{set,get,response} topics valid everywhere.
 */
export const SETTINGS = {
  gps_interval: {
    schema: z.number().int().min(10).max(86_400),
    unit: "seconds",
    description: "GPS reporting interval. Non-volatile; applies after successful validation/write.",
  },
} as const;

export type SettingName = keyof typeof SETTINGS;
export type SettingValue<S extends SettingName = SettingName> = z.infer<
  (typeof SETTINGS)[S]["schema"]
>;

export const SETTING_NAMES = Object.keys(SETTINGS) as SettingName[];

export function isSettingName(name: string): name is SettingName {
  return Object.hasOwn(SETTINGS, name);
}
