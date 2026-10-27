import type { z } from "zod";
import { COMMANDS, type CommandName } from "./catalogue.js";
import { formatIssues, type ParseResult } from "./inbound.js";
import { settingsGet, settingsSet } from "./schemas/outbound.js";
import { SETTINGS, isSettingName, type SettingName, type SettingOp } from "./settings.js";
import { deviceTopic, isValidDeviceId } from "./topics.js";

/** Supplied by the caller so builders stay pure: a fresh UUID and the current epoch seconds. */
export interface RequestMeta {
  requestId: string;
  timestamp: number;
}

/** Command-specific fields; the envelope (timestamp, request_id) is added by the builder. */
export type CommandParams<C extends CommandName> = Omit<
  z.input<(typeof COMMANDS)[C]>,
  "timestamp" | "request_id"
>;

export interface OutboundMessage {
  topic: string;
  /** Validated payload, ready for `JSON.stringify`. */
  payload: Record<string, unknown>;
  /** `request_id` of a command, `setting_id` of a settings request. */
  requestId: string;
}

/** Per-group schema types erased: their union over every group is too complex for TS. */
type AnySettingsSchema = (setting: SettingName) => z.ZodType<Record<string, unknown>>;
const setSchema = settingsSet as AnySettingsSchema;
const getSchema = settingsGet as AnySettingsSchema;

function build(
  deviceId: string,
  path: string,
  schema: z.ZodType<Record<string, unknown>>,
  fields: object,
  envelope: Record<string, unknown>,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  if (!isValidDeviceId(deviceId))
    return { ok: false, reason: "invalid_device_id", issues: [], path };
  // Envelope last, so caller-supplied fields can never override the id, action or timestamp.
  const result = schema.safeParse({ ...fields, ...envelope, timestamp: meta.timestamp });
  if (!result.success) {
    return {
      ok: false,
      reason: "invalid_payload",
      issues: formatIssues(result.error),
      deviceId,
      path,
    };
  }
  return {
    ok: true,
    value: { topic: deviceTopic(deviceId, path), payload: result.data, requestId: meta.requestId },
  };
}

/** `pettracker/{id}/device/command/{command}` (spec V3 §4). */
export function buildCommand<C extends CommandName>(
  deviceId: string,
  command: C,
  params: CommandParams<C>,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  const envelope = { request_id: meta.requestId };
  return build(deviceId, `command/${command}`, COMMANDS[command], params, envelope, meta);
}

/**
 * `pettracker/{id}/device/settings/set/{setting}` (spec V3 §6). `fields` are checked against
 * the settings registry before anything is published (rule 8), so it accepts untrusted input;
 * string forms like "60" are published as numbers (ADR 0011).
 */
export function buildSettingsSet(
  deviceId: string,
  setting: string,
  fields: Record<string, unknown>,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  const path = `settings/set/${setting}`;
  if (!isSettingName(setting))
    return { ok: false, reason: "unknown_setting", issues: [], deviceId, path };
  const known = Object.keys(SETTINGS[setting].fields);
  if (!known.some((k) => fields[k] !== undefined)) {
    return {
      ok: false,
      reason: "invalid_payload",
      issues: [`(root): set at least one of ${known.join(", ")}`],
      deviceId,
      path,
    };
  }
  const envelope = settingsEnvelope(setting, "set", meta);
  return build(deviceId, path, setSchema(setting), fields, envelope, meta);
}

/** `pettracker/{id}/device/settings/get/{setting}` (spec V3 §6). */
export function buildSettingsGet(
  deviceId: string,
  setting: string,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  const path = `settings/get/${setting}`;
  if (!isSettingName(setting))
    return { ok: false, reason: "unknown_setting", issues: [], deviceId, path };
  const envelope = settingsEnvelope(setting, "get", meta);
  return build(deviceId, path, getSchema(setting), {}, envelope, meta);
}

function settingsEnvelope(setting: SettingName, action: SettingOp, meta: RequestMeta) {
  return { action, setting_id: meta.requestId, setting_type: SETTINGS[setting].type };
}
