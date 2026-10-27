import type { z } from "zod";
import { INBOUND_TOPICS, type InboundTopicPath } from "./catalogue.js";
import { settingsAck, settingsResponse } from "./schemas/inbound.js";
import { isSettingName, type SettingName } from "./settings.js";
import { BACKEND, DEVICE, isValidDeviceId, splitTopic } from "./topics.js";

/** Payloads above this are rejected before JSON parsing (rule 4). */
export const MAX_INBOUND_PAYLOAD_BYTES = 16 * 1024;

/** Settings topics the bridge receives: answers to GET (backend) and ACKs to SET (device). */
const SETTINGS_INBOUND = {
  "settings/response": { publisher: BACKEND, schema: settingsResponse },
  "settings/ack": { publisher: DEVICE, schema: settingsAck },
} as const;
type SettingsInboundPath = keyof typeof SETTINGS_INBOUND;

export type InboundTopic =
  | { deviceId: string; path: InboundTopicPath }
  | { deviceId: string; path: SettingsInboundPath; setting: SettingName };

/** A validated inbound message. `data` is typed by `path` (and `setting`). */
export type InboundMessage =
  | {
      [P in InboundTopicPath]: {
        deviceId: string;
        path: P;
        data: z.infer<(typeof INBOUND_TOPICS)[P]["schema"]>;
      };
    }[InboundTopicPath]
  | {
      [S in SettingName]: {
        deviceId: string;
        path: "settings/response";
        setting: S;
        data: z.infer<ReturnType<typeof settingsResponse<S>>>;
      };
    }[SettingName]
  | {
      [S in SettingName]: {
        deviceId: string;
        path: "settings/ack";
        setting: S;
        data: z.infer<ReturnType<typeof settingsAck<S>>>;
      };
    }[SettingName];

export type RejectReason =
  | "outside_namespace"
  | "invalid_device_id"
  | "unknown_topic"
  | "unknown_setting"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_payload";

export interface Rejection {
  reason: RejectReason;
  /** Human-readable details, e.g. Zod issues as `field: message`. */
  issues: string[];
  /** Present once the topic has been parsed far enough to know it. */
  deviceId?: string;
  path?: string;
}

export type ParseResult<T> = { ok: true; value: T } | ({ ok: false } & Rejection);

const reject = (
  reason: RejectReason,
  extra: Omit<Rejection, "reason" | "issues"> & { issues?: string[] } = {},
): { ok: false } & Rejection => ({ ok: false, reason, issues: [], ...extra });

/**
 * Parse `pettracker/{device_id}/backend/{path}` (and the collar's
 * `pettracker/{device_id}/device/settings/ack/{setting}`) against the catalogue.
 */
export function parseBackendTopic(topic: string): ParseResult<InboundTopic> {
  const t = splitTopic(topic);
  if (!t || (t.publisher !== BACKEND && t.publisher !== DEVICE)) return reject("outside_namespace");
  const { deviceId, publisher, path } = t;
  if (!isValidDeviceId(deviceId)) return reject("invalid_device_id", { path });

  if (publisher === BACKEND && Object.hasOwn(INBOUND_TOPICS, path)) {
    return { ok: true, value: { deviceId, path: path as InboundTopicPath } };
  }
  for (const [prefix, e] of Object.entries(SETTINGS_INBOUND)) {
    if (publisher !== e.publisher || !path.startsWith(`${prefix}/`)) continue;
    const setting = path.slice(prefix.length + 1);
    if (!isSettingName(setting)) return reject("unknown_setting", { deviceId, path });
    return { ok: true, value: { deviceId, path: prefix as SettingsInboundPath, setting } };
  }
  // Commands and SET/GET are the backend's own messages, not something it ingests.
  if (publisher === DEVICE) return reject("outside_namespace", { deviceId, path });
  return reject("unknown_topic", { deviceId, path });
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Validate one inbound MQTT message: namespace, device id, known topic, size, UTF-8 JSON and
 * the topic's payload schema (rule 4). Never throws.
 */
export function parseInbound(
  topic: string,
  payload: Uint8Array | string,
): ParseResult<InboundMessage> {
  const parsedTopic = parseBackendTopic(topic);
  if (!parsedTopic.ok) return parsedTopic;
  const t = parsedTopic.value;
  const where = { deviceId: t.deviceId, path: "setting" in t ? `${t.path}/${t.setting}` : t.path };

  const size =
    typeof payload === "string" ? new TextEncoder().encode(payload).length : payload.length;
  if (size > MAX_INBOUND_PAYLOAD_BYTES)
    return reject("payload_too_large", { ...where, issues: [`${size} bytes`] });

  let json: unknown;
  try {
    json = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
  } catch (err) {
    return reject("invalid_json", { ...where, issues: [String(err)] });
  }

  const schema =
    "setting" in t ? SETTINGS_INBOUND[t.path].schema(t.setting) : INBOUND_TOPICS[t.path].schema;
  const result = schema.safeParse(json);
  if (!result.success)
    return reject("invalid_payload", { ...where, issues: formatIssues(result.error) });

  // The cast pairs `data` with its own path; TS can't correlate the two through the union.
  return { ok: true, value: { ...t, data: result.data } as InboundMessage };
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}
