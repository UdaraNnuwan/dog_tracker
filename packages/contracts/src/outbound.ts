import type { z } from "zod";
import { COMMANDS, type CommandName } from "./catalogue.js";
import { formatIssues, type ParseResult } from "./inbound.js";
import { settingsGet, settingsSet } from "./schemas/outbound.js";
import { isSettingName } from "./settings.js";
import { deviceTopic, isValidDeviceId } from "./topics.js";

/** Payload contract version sent with every outbound message (spec §3, §15). */
export const PROTOCOL_VERSION = "1.2";

/** Supplied by the caller so builders stay pure: a fresh UUID and the current epoch seconds. */
export interface RequestMeta {
  requestId: string;
  timestamp: number;
}

/** Command-specific fields; the envelope (timestamp, request_id, protocol_version) is added by the builder. */
export type CommandParams<C extends CommandName> = Omit<
  z.input<(typeof COMMANDS)[C]>,
  "timestamp" | "request_id" | "protocol_version"
>;

export interface OutboundMessage {
  topic: string;
  /** Validated payload, ready for `JSON.stringify`. */
  payload: Record<string, unknown>;
  requestId: string;
}

function build(
  deviceId: string,
  path: string,
  schema: z.ZodType<Record<string, unknown>>,
  fields: object,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  if (!isValidDeviceId(deviceId))
    return { ok: false, reason: "invalid_device_id", issues: [], path };
  // Envelope last, so caller-supplied fields can never override request_id or timestamp.
  const result = schema.safeParse({
    ...fields,
    timestamp: meta.timestamp,
    request_id: meta.requestId,
    protocol_version: PROTOCOL_VERSION,
  });
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

/** `pettracker/device/{id}/command/{command}` (spec §7). */
export function buildCommand<C extends CommandName>(
  deviceId: string,
  command: C,
  params: CommandParams<C>,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  return build(deviceId, `command/${command}`, COMMANDS[command], params, meta);
}

/**
 * `pettracker/device/{id}/settings/set/{setting}` (spec §8). `value` is checked against the
 * settings registry before anything is published (rule 8), so it accepts untrusted input.
 */
export function buildSettingsSet(
  deviceId: string,
  setting: string,
  value: unknown,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  const path = `settings/set/${setting}`;
  if (!isSettingName(setting))
    return { ok: false, reason: "unknown_setting", issues: [], deviceId, path };
  return build(deviceId, path, settingsSet(setting), { value }, meta);
}

/** `pettracker/device/{id}/settings/get/{setting}` (spec §8). */
export function buildSettingsGet(
  deviceId: string,
  setting: string,
  meta: RequestMeta,
): ParseResult<OutboundMessage> {
  const path = `settings/get/${setting}`;
  if (!isSettingName(setting))
    return { ok: false, reason: "unknown_setting", issues: [], deviceId, path };
  return build(deviceId, path, settingsGet, {}, meta);
}
