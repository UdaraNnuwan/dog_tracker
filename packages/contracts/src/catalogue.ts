import type { z } from "zod";
import * as inbound from "./schemas/inbound.js";
import * as outbound from "./schemas/outbound.js";

/**
 * Master topic catalogue (spec §4). `qos` / `retain` are what the *publisher* uses; the
 * simulator follows them and the bridge only ever publishes QoS 1, retain=false (rule 2).
 * "optional" retain means the spec leaves it to the firmware.
 */
type Retain = boolean | "optional";

interface CatalogueEntry<S extends z.ZodType> {
  schema: S;
  qos: 0 | 1;
  retain: Retain;
}

const entry = <S extends z.ZodType>(
  schema: S,
  qos: 0 | 1,
  retain: Retain = false,
): CatalogueEntry<S> => ({
  schema,
  qos,
  retain,
});

/**
 * Device → backend topics with a fixed path, keyed by the path after
 * `pettracker/backend/{device_id}/`. `settings/response/{setting}` is parameterised and
 * handled separately (see `settingsResponse`).
 */
export const INBOUND_TOPICS = {
  "telemetry/gps": entry(inbound.gpsTelemetry, 0),
  "telemetry/battery": entry(inbound.batteryTelemetry, 0),
  "telemetry/imu": entry(inbound.imuTelemetry, 0),
  "telemetry/signal_strength": entry(inbound.signalStrengthTelemetry, 0),
  "status/system": entry(inbound.systemStatus, 0, "optional"),
  "status/network": entry(inbound.networkStatus, 0, "optional"),
  "status/connectivity": entry(inbound.connectivityStatus, 1, true),
  "event/geofence": entry(inbound.geofenceEvent, 1),
  "event/low_battery": entry(inbound.lowBatteryEvent, 1),
  "event/tamper": entry(inbound.tamperEvent, 1),
  "response/location": entry(inbound.locationResponse, 1),
  "response/buzzer": entry(inbound.commandResponse, 1),
  "response/reboot": entry(inbound.commandResponse, 1),
  "response/peripheral": entry(inbound.commandResponse, 1),
  "response/sleep": entry(inbound.commandResponse, 1),
  "diagnostic/log": entry(inbound.diagnosticLog, 0),
  "diagnostic/crash": entry(inbound.diagnosticOpaque, 1),
  "diagnostic/debug_log": entry(inbound.diagnosticOpaque, 0),
  "diagnostic/sensor_health": entry(inbound.diagnosticOpaque, 0, "optional"),
} as const;

export type InboundTopicPath = keyof typeof INBOUND_TOPICS;

/** QoS / retain for `settings/response/{setting}` (spec §4). */
export const SETTINGS_RESPONSE_TOPIC = { qos: 1, retain: "optional" } as const;

/** Commands under `pettracker/device/{device_id}/command/{name}` (spec §7). */
export const COMMANDS = {
  location: outbound.locationCommand,
  buzzer: outbound.buzzerCommand,
  reboot: outbound.rebootCommand,
  peripheral: outbound.peripheralCommand,
  sleep: outbound.sleepCommand,
} as const;

export type CommandName = keyof typeof COMMANDS;
export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

/** The response topic path for each command (spec §7 table). */
export const responsePathFor = (command: CommandName) =>
  `response/${command}` as const satisfies InboundTopicPath;
