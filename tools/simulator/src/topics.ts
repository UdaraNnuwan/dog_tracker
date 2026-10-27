import {
  COMMANDS,
  INBOUND_TOPICS,
  SETTINGS_TOPIC,
  formatIssues,
  isCommandName,
  isSettingName,
  parseInbound,
  schemas,
  type InboundTopicPath,
} from "@udara/contracts";

/** The topic's publisher segment (spec V3): `backend` = collar → backend, `device` = backend → collar. */
export type Direction = "backend" | "device";

export interface TopicSpec {
  direction: Direction;
  /** Path after `pettracker/{device_id}/{direction}/`. */
  path: string;
  qos: 0 | 1;
  retain: boolean;
}

/** `backend/telemetry/gps` (file path without .csv) → topic spec, or an error message. */
export function topicFromFile(relative: string): TopicSpec | string {
  const [direction, ...rest] = relative
    .replace(/\\/g, "/")
    .replace(/\.csv$/, "")
    .split("/");
  const path = rest.join("/");
  if (direction === "backend") {
    if (Object.hasOwn(INBOUND_TOPICS, path)) {
      const e = INBOUND_TOPICS[path as InboundTopicPath];
      return { direction, path, qos: e.qos, retain: e.retain };
    }
    const setting = path.match(/^settings\/response\/(.+)$/)?.[1];
    if (setting !== undefined && isSettingName(setting)) {
      return { direction, path, ...SETTINGS_TOPIC };
    }
    return `unknown backend topic "${path}"`;
  }
  if (direction === "device") {
    const [kind, a = "", b] = path.split("/");
    if (kind === "command" && isCommandName(a) && b === undefined) {
      return { direction, path, qos: 1, retain: false };
    }
    // `ack` is published by the collar, but lives under `device/` (spec V3 §6).
    if (kind === "settings" && ["set", "get", "ack"].includes(a) && b && isSettingName(b)) {
      return { direction, path, ...SETTINGS_TOPIC };
    }
    return `unknown device topic "${path}"`;
  }
  return `first folder must be "backend" or "device", got "${direction}"`;
}

/** Topics the collar publishes, i.e. the ones the bridge ingests. */
export const isCollarTopic = (spec: TopicSpec) =>
  spec.direction === "backend" || spec.path.startsWith("settings/ack/");

/**
 * Validates a payload with the same contracts the bridge (collar topics) and the collar
 * (backend-published topics) use. Returns issues; empty means valid.
 */
export function validatePayload(
  spec: TopicSpec,
  deviceId: string,
  payload: Record<string, unknown>,
): string[] {
  if (isCollarTopic(spec)) {
    const topic = `pettracker/${deviceId}/${spec.direction}/${spec.path}`;
    const r = parseInbound(topic, JSON.stringify(payload));
    return r.ok ? [] : [r.reason, ...r.issues];
  }
  const [kind, a = "", b = ""] = spec.path.split("/");
  const schema =
    kind === "command" && isCommandName(a)
      ? COMMANDS[a]
      : isSettingName(b)
        ? a === "set"
          ? schemas.settingsSet(b)
          : schemas.settingsGet(b)
        : null;
  if (!schema) return [`unknown topic "${spec.path}"`];
  const r = schema.safeParse(payload);
  return r.success ? [] : formatIssues(r.error);
}
