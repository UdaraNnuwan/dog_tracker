import type { z } from "zod";
import { INBOUND_TOPICS, type InboundTopicPath } from "./catalogue.js";
import { settingsResponse } from "./schemas/inbound.js";
import { isSettingName, type SettingName } from "./settings.js";
import { BACKEND_PREFIX, isValidDeviceId } from "./topics.js";

/** Payloads above this are rejected before JSON parsing (rule 4). */
export const MAX_INBOUND_PAYLOAD_BYTES = 16 * 1024;

const SETTINGS_RESPONSE_PREFIX = "settings/response/";

export type InboundTopic =
  | { deviceId: string; path: InboundTopicPath }
  | { deviceId: string; path: "settings/response"; setting: SettingName };

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

/** Parse `pettracker/backend/{device_id}/{path}` against the catalogue. */
export function parseBackendTopic(topic: string): ParseResult<InboundTopic> {
  if (!topic.startsWith(BACKEND_PREFIX)) return reject("outside_namespace");
  const rest = topic.slice(BACKEND_PREFIX.length);
  const slash = rest.indexOf("/");
  const deviceId = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash + 1);
  if (!isValidDeviceId(deviceId)) return reject("invalid_device_id", { path });

  if (Object.hasOwn(INBOUND_TOPICS, path)) {
    return { ok: true, value: { deviceId, path: path as InboundTopicPath } };
  }
  if (path.startsWith(SETTINGS_RESPONSE_PREFIX)) {
    const setting = path.slice(SETTINGS_RESPONSE_PREFIX.length);
    if (!isSettingName(setting)) return reject("unknown_setting", { deviceId, path });
    return { ok: true, value: { deviceId, path: "settings/response", setting } };
  }
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

  const schema = "setting" in t ? settingsResponse(t.setting) : INBOUND_TOPICS[t.path].schema;
  const result = schema.safeParse(json);
  if (!result.success)
    return reject("invalid_payload", { ...where, issues: formatIssues(result.error) });

  // The cast pairs `data` with its own path; TS can't correlate the two through the union.
  return { ok: true, value: { ...t, data: result.data } as InboundMessage };
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}
