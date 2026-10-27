import type { z } from "zod";
import * as inbound from "./schemas/inbound.js";
import * as outbound from "./schemas/outbound.js";

/**
 * Master topic catalogue (spec V3 "Complete MQTT topic list"). `qos` / `retain` are what the
 * *publisher* uses; the simulator follows them and the bridge only ever publishes QoS 1,
 * retain=false (rule 2). `tbd` marks topics the spec leaves to the pilot phase.
 */
interface CatalogueEntry<S extends z.ZodType> {
  schema: S;
  qos: 0 | 1;
  retain: boolean;
  tbd?: true;
}

const entry = <S extends z.ZodType>(
  schema: S,
  qos: 0 | 1,
  extra: { retain?: boolean; tbd?: true } = {},
): CatalogueEntry<S> => ({ schema, qos, retain: extra.retain ?? false, ...extra });

const tbd = { tbd: true } as const;

/**
 * Collar → backend topics with a fixed path, keyed by the path after
 * `pettracker/{device_id}/backend/`. `settings/response/{setting}` is parameterised and
 * handled separately (see `settingsResponse`).
 */
export const INBOUND_TOPICS = {
  "telemetry/gps": entry(inbound.gpsTelemetry, 0),
  "telemetry/battery": entry(inbound.batteryTelemetry, 0),
  "telemetry/imu": entry(inbound.imuTelemetry, 0),
  "telemetry/signal_strength": entry(inbound.signalStrengthTelemetry, 0),
  "telemetry/bme_data": entry(inbound.bmeTelemetry, 0),
  "status/system": entry(inbound.systemStatus, 0),
  "status/network": entry(inbound.networkStatus, 0),
  // Not in spec V3: retained online/offline + Last Will (ADR 0011).
  "status/connectivity": entry(inbound.connectivityStatus, 1, { retain: true }),
  "event/geofence": entry(inbound.geofenceEvent, 1, tbd),
  "event/low_battery": entry(inbound.lowBatteryEvent, 1),
  "response/config": entry(inbound.configResponse, 1, tbd),
  "response/location": entry(inbound.locationResponse, 1),
  "response/buzzer": entry(inbound.buzzerResponse, 1, tbd),
  "response/reboot": entry(inbound.rebootResponse, 1, tbd),
  "response/peripheral": entry(inbound.peripheralResponse, 1),
  "response/sleep": entry(inbound.sleepResponse, 1, tbd),
  "diagnostic/log": entry(inbound.diagnosticLog, 0),
  "diagnostic/debug_log": entry(inbound.debugLog, 0),
} as const;

export type InboundTopicPath = keyof typeof INBOUND_TOPICS;

/** QoS / retain of the settings topics, in both directions (spec V3 §6). */
export const SETTINGS_TOPIC = { qos: 1, retain: false } as const;

/** Commands under `pettracker/{device_id}/device/command/{name}` (spec V3 §4). */
export const COMMANDS = {
  config: outbound.configCommand,
  location: outbound.locationCommand,
  buzzer: outbound.buzzerCommand,
  reboot: outbound.rebootCommand,
  peripheral: outbound.peripheralCommand,
  sleep: outbound.sleepCommand,
} as const;

/** Commands the spec marks TBD (pilot phase). */
export const TBD_COMMANDS: ReadonlySet<CommandName> = new Set(["config", "buzzer", "sleep"]);

export type CommandName = keyof typeof COMMANDS;
export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

/** The response topic path for each command (spec V3 §5). */
export const responsePathFor = (command: CommandName) =>
  `response/${command}` as const satisfies InboundTopicPath;
